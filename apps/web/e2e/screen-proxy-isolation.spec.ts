import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingHttpHeaders, Server } from "node:http";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import type { AddressInfo, Server as NetServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { openScreenCapability } from "@tangow/core/node/screen-capability";
import { createServer, preview } from "vite";
import { addScreenProxyCapability } from "../../api/src/screen-proxy";
import { captureScreenshot } from "./helpers";
import { expect, test } from "./test";

const scope = {
  botId: "bot",
  computerId: "computer",
  botGeneration: 0,
  computerGeneration: 0,
  controlLeaseId: null,
};
const secret = "fake-screen-proxy-browser-test-secret";
const webRoot = path.resolve(import.meta.dirname, "..");
// Preview serves a build; this stand-in for `dist/screen.html` only proves the routing.
const builtViewer = `<!doctype html><title>Viewer</title><script type="module">
  const url = new URL('websockify', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url);
  socket.onmessage = () => { document.body.textContent = 'socket ok'; socket.close(); };
</script><body></body>`;
const WIDTH = 64;
const HEIGHT = 48;

async function listen(server: NetServer) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function wsFrame(payload: Buffer) {
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x82, length])
      : Buffer.from([0x82, 126, length >> 8, length & 0xff]);
  return Buffer.concat([header, payload]);
}

/** The smallest VNC server noVNC accepts, behind a WebSocket: no auth, one white frame. */
function serveFakeVnc(socket: Socket, keysyms: number[]) {
  let pending = Buffer.alloc(0);
  let stage = 0;
  socket.write(wsFrame(Buffer.from("RFB 003.008\n")));
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    // Client frames are masked; noVNC's are small enough for the 7- and 16-bit length forms.
    while (pending.length >= 6) {
      const short = pending[1]! & 0x7f;
      const offset = short === 126 ? 4 : 2;
      const length = short === 126 ? pending.readUInt16BE(2) : short;
      if (pending.length < offset + 4 + length) return;
      const mask = pending.subarray(offset, offset + 4);
      const data = Buffer.from(pending.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < data.length; i++) data[i]! ^= mask[i % 4]!;
      const opcode = pending[0]! & 0x0f;
      pending = pending.subarray(offset + 4 + length);
      if (opcode === 8) {
        socket.end();
        return;
      }
      if (stage === 0)
        socket.write(wsFrame(Buffer.from([1, 1]))); // one security type: None
      else if (stage === 1)
        socket.write(wsFrame(Buffer.alloc(4))); // SecurityResult: OK
      else if (stage === 2) {
        const init = Buffer.alloc(24);
        init.writeUInt16BE(WIDTH, 0);
        init.writeUInt16BE(HEIGHT, 2);
        init.set([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0], 4);
        socket.write(wsFrame(init));
        const update = Buffer.alloc(16 + WIDTH * HEIGHT * 4, 0xff);
        update.writeUInt32BE(1, 0); // FramebufferUpdate with one Raw rectangle
        update.writeUInt32BE(0, 4);
        update.writeUInt16BE(WIDTH, 8);
        update.writeUInt16BE(HEIGHT, 10);
        update.writeInt32BE(0, 12);
        socket.write(wsFrame(update));
      } else if (data[0] === 4 && data[1] === 1 && data.length >= 8) {
        keysyms.push(data.readUInt32BE(4)); // KeyEvent, key down
      }
      stage += 1;
    }
  });
}

for (const mode of ["development", "preview"] as const) {
  test.describe(`screen viewer and socket proxy in ${mode}`, () => {
    let origin: string;
    let screenUrl: string;
    let stop: () => Promise<void>;

    let authorized = true;
    let computerHttpRequests = 0;
    const upgrades: IncomingHttpHeaders[] = [];
    const keysyms: number[] = [];
    test.beforeAll(async () => {
      const previewRoot = await mkdtemp(path.join(tmpdir(), "tangow-screen-test-"));
      await mkdir(path.join(previewRoot, "dist"));
      await writeFile(path.join(previewRoot, "dist", "screen.html"), builtViewer);
      const computer = createHttpServer((_req, res) => {
        computerHttpRequests += 1;
        res.setHeader("Content-Type", "text/html");
        res.end("<script>parent.document.title = 'computer'</script>");
      });
      const sockets = new Set<Socket>();
      computer.on("upgrade", (req, socket: Socket) => {
        upgrades.push(req.headers);
        sockets.add(socket);
        const accept = createHash("sha1")
          .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: app-session=attacker; Path=/\r\n\r\n`,
        );
        socket.on("error", () => socket.destroy());
        serveFakeVnc(socket, keysyms);
      });
      const computerOrigin = await listen(computer);

      const authority = createHttpServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const capability = openScreenCapability(body.path, secret);
        if (!authorized || !capability || req.headers.authorization !== `Bearer ${secret}`) {
          res.writeHead(403).end();
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(capability.target));
      });
      const previousApi = process.env.API_PROXY_TARGET;
      process.env.API_PROXY_TARGET = await listen(authority);
      const previousSecret = process.env.SCREEN_PROXY_SECRET;
      process.env.SCREEN_PROXY_SECRET = secret;
      try {
        // Load the real configuration: both production and development hooks must install the policy.
        const config = {
          // Development serves the real viewer and noVNC; preview serves the stand-in build.
          root: mode === "development" ? webRoot : previewRoot,
          configFile: path.resolve(import.meta.dirname, "../vite.config.ts"),
          mode: "test",
          logLevel: "silent" as const,
          server: { host: "127.0.0.1", port: 0, hmr: false as const },
          preview: { host: "127.0.0.1", port: 0 },
        };
        const server = mode === "development" ? await createServer(config) : await preview(config);
        // listen() replaces zero with Vite's default port; bind the HTTP server directly instead.
        if ("listen" in server) await listen(server.httpServer!);
        origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
        // Exercise the same capability issuer used by the production API, with a configured web origin.
        screenUrl = addScreenProxyCapability(
          `${computerOrigin}/embed.html?view_only=false&path=${encodeURIComponent("websockify?token=fake-token")}`,
          secret,
          origin,
          scope,
        );
        stop = async () => {
          for (const socket of sockets) socket.destroy();
          await server.close();
          await close(computer);
          await close(authority);
          await rm(previewRoot, { recursive: true, force: true });
        };
      } finally {
        if (previousApi === undefined) delete process.env.API_PROXY_TARGET;
        else process.env.API_PROXY_TARGET = previousApi;
        if (previousSecret === undefined) delete process.env.SCREEN_PROXY_SECRET;
        else process.env.SCREEN_PROXY_SECRET = previousSecret;
      }
    });

    test.afterAll(async () => {
      await stop?.();
    });

    test("Tangow serves the viewer and only its socket reaches the computer", async ({
      page,
    }, testInfo) => {
      const response = await page.goto(screenUrl);
      expect(response?.status()).toBe(200);
      expect(response?.headers()["content-security-policy"]).toBeUndefined();
      if (mode === "development") {
        // The bundled noVNC connects, paints the computer's frame and sends input to it.
        const canvas = page.locator("#live canvas");
        await expect(canvas).toBeVisible();
        await expect
          .poll(() =>
            canvas.evaluate(
              (element: HTMLCanvasElement) =>
                element.getContext("2d")?.getImageData(1, 1, 1, 1).data[0],
            ),
          )
          .toBe(255);
        await canvas.click();
        await page.keyboard.press("a");
        await expect.poll(() => keysyms).toContain(0x61);
        await captureScreenshot(page, testInfo, "screen-viewer");
        await page.setViewportSize({ width: 390, height: 844 });
        await captureScreenshot(page, testInfo, "screen-viewer-phone");
      } else {
        await expect(page.locator("body")).toHaveText("socket ok");
      }
      expect(computerHttpRequests).toBe(0);
      expect(upgrades.at(-1)).toMatchObject({ upgrade: "websocket" });
      expect(
        (await page.context().cookies(origin)).find((cookie) => cookie.name === "app-session"),
      ).toBeUndefined();
    });

    test("nothing else under a capability reaches the computer", async ({ request }) => {
      const upgradesBefore = upgrades.length;
      const base = screenUrl.replace(/embed\.html\?.*$/, "");
      for (const file of ["core/rfb.js", "vnc.html", "websockify"]) {
        expect((await request.get(`${base}${file}`)).status()).toBe(404);
      }
      expect((await request.post(screenUrl)).status()).toBe(404);
      const refused = await new Promise<boolean>((resolve) => {
        httpRequest(`${base}other`, {
          headers: {
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-version": "13",
          },
        })
          .on("upgrade", (_response, socket) => {
            socket.destroy();
            resolve(false);
          })
          .on("response", () => resolve(false))
          .on("error", () => resolve(true))
          .end();
      });
      expect(refused).toBe(true);
      expect(computerHttpRequests).toBe(0);
      expect(upgrades).toHaveLength(upgradesBefore);
    });

    test("revocation blocks replay and closes an already connected socket", async ({
      page,
      request,
    }) => {
      await page.goto(`${origin}/favicon.svg`);
      await page.evaluate(async (url) => {
        const target = new URL("websockify", url);
        target.protocol = "ws:";
        target.search = "";
        const socket = new WebSocket(target);
        const state = window as unknown as { screenClosed: boolean };
        state.screenClosed = false;
        socket.onclose = () => {
          state.screenClosed = true;
        };
        await new Promise<void>((resolve, reject) => {
          socket.onmessage = () => resolve();
          socket.onerror = () => reject(new Error("socket failed"));
        });
      }, screenUrl);
      authorized = false;
      try {
        expect((await request.get(screenUrl)).status()).toBe(403);
        await expect
          .poll(() =>
            page.evaluate(() => (window as unknown as { screenClosed: boolean }).screenClosed),
          )
          .toBe(true);
      } finally {
        authorized = true;
      }
    });

    test("credentials attached to the socket request never reach the computer", async () => {
      const credentials = {
        cookie: "app-session=fake-session",
        authorization: "Bearer fake",
        "cf-access-client-id": "fake-id",
        "cf-access-client-secret": "fake-secret",
        "cf-access-jwt-assertion": "fake-jwt",
        "x-forwarded-access-token": "fake-token",
        "x-auth-request-access-token": "fake-token",
        "x-forwarded-user": "fake-user",
        "x-forwarded-email": "user@example.com",
      };
      const socketUrl = new URL("websockify", screenUrl);
      socketUrl.search = "";
      await new Promise<void>((resolve, reject) => {
        httpRequest(socketUrl, {
          headers: {
            ...credentials,
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-version": "13",
          },
        })
          .on("upgrade", (_response, socket) => {
            socket.destroy();
            resolve();
          })
          .on("response", () => reject(new Error("upgrade refused")))
          .on("error", reject)
          .end();
      });
      const received = upgrades.at(-1)!;
      expect(Object.keys(credentials).filter((name) => name in received)).toEqual([]);
      expect(received).toMatchObject({ upgrade: "websocket", "sec-websocket-version": "13" });
    });
  });
}

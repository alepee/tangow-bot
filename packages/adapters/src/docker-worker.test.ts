import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorkerSpec } from "@tangow/adapter-kit";
import { WorkerEnsureSettledError } from "@tangow/adapter-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOCKER_CREATE_MARGIN_MS, DockerWorkerProvider } from "./docker-worker.js";
import { encodeFrameLine } from "./runtime-worker/framing.js";

type Request = { method: string; url: string; authorization?: string; body: unknown };
type GuestSocket = { socket: Socket; capability?: string; received: () => string };

const TOKEN = "supervisor-test-token";

/** The supervisor's worker routes as the provider sees them: containers found by attempt label. */
async function fakeSupervisor() {
  const workers = new Map<string, string>();
  const requests: Request[] = [];
  const guests: GuestSocket[] = [];
  const faults = {
    resetNext: 0,
    stallCreate: false,
    refuseUpgrade: false,
    failDelete: false,
    refuseCreate: undefined as { status: number; body: string } | undefined,
  };
  let created = 0;
  const server = http.createServer(async (req, res) => {
    if (faults.resetNext > 0) {
      faults.resetNext--;
      req.socket.destroy();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url!, "http://supervisor");
    requests.push({
      method: req.method!,
      url: req.url!,
      authorization: req.headers.authorization,
      body: raw ? JSON.parse(raw) : undefined,
    });
    const json = (status: number, body: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.headers.authorization !== `Bearer ${TOKEN}`)
      return json(401, { error: "unauthorized" });
    if (req.method === "POST" && url.pathname === "/workers") {
      if (faults.stallCreate) return;
      if (faults.refuseCreate) {
        return res.writeHead(faults.refuseCreate.status).end(faults.refuseCreate.body);
      }
      const { attemptId } = JSON.parse(raw) as { attemptId: string };
      const id = workers.get(attemptId) ?? `ctr${++created}`;
      workers.set(attemptId, id);
      return json(200, { id });
    }
    if (req.method === "DELETE" && url.pathname === "/workers") {
      if (faults.failDelete) return json(500, { error: "removal failed" });
      return json(200, { destroyed: workers.delete(url.searchParams.get("attempt")!) });
    }
    json(404, { error: "not found" });
  });
  server.on("upgrade", (req, socket: Socket) => {
    if (faults.refuseUpgrade || req.headers.authorization !== `Bearer ${TOKEN}`) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tangow-guest\r\n\r\n",
    );
    let received = "";
    socket.on("data", (chunk) => (received += chunk));
    socket.on("error", () => undefined);
    const capability = req.headers["x-tangow-worker-capability"];
    guests.push({
      socket,
      capability: typeof capability === "string" ? capability : undefined,
      received: () => received,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    workers,
    requests,
    guests,
    faults,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function spec(mounts: WorkerSpec["mounts"], overrides: Partial<WorkerSpec> = {}): WorkerSpec {
  return {
    attemptId: "attempt_1",
    runId: "run_1",
    botId: "bot_1",
    mounts,
    ttlSeconds: 3_600,
    ensureDeadline: new Date(Date.now() + 900_000),
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settled = (promise: Promise<void>) =>
  Promise.race([promise.then(() => "settled"), sleep(50).then(() => "pending")]);
const until = async (check: () => boolean) => {
  while (!check()) await sleep(5);
};

describe("DockerWorkerProvider", () => {
  let supervisor: Awaited<ReturnType<typeof fakeSupervisor>>;
  let dataDir: string;
  let worker: DockerWorkerProvider;
  beforeEach(async () => {
    supervisor = await fakeSupervisor();
    dataDir = await mkdtemp(path.join(tmpdir(), "tangow-docker-worker-"));
    worker = new DockerWorkerProvider({
      supervisorUrl: supervisor.url,
      supervisorToken: TOKEN,
      dataDir,
    });
  });
  afterEach(async () => {
    await supervisor.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function connected() {
    const { providerRef } = await worker.ensure(spec([]));
    const guest = worker.connect({ attemptId: "attempt_1", providerRef }, "rkw1.claims.mac");
    const channels = guest.connections[Symbol.asyncIterator]();
    const channel = (await channels.next()).value!;
    await until(() => supervisor.guests.length === 1);
    return { ...guest, channels, channel, fake: supervisor.guests[0]! };
  }

  it("asks the supervisor for the attempt's worker with its volumes, read-only where granted", async () => {
    const attempt = spec([
      { volumeRef: "tangow-vol_bot", path: "/workspace/bots/bot_1", access: "rw" },
      { volumeRef: "tangow-vol_shared", path: "/workspace/shared", access: "ro" },
    ]);

    expect(await worker.ensure(attempt)).toEqual({ providerRef: "ctr1" });
    expect(supervisor.requests).toEqual([
      {
        method: "POST",
        url: "/workers",
        authorization: `Bearer ${TOKEN}`,
        body: {
          attemptId: "attempt_1",
          ttlSeconds: 3_600,
          mounts: [
            { volume: "tangow-vol_bot", path: "/workspace/bots/bot_1", readOnly: false },
            { volume: "tangow-vol_shared", path: "/workspace/shared", readOnly: true },
          ],
        },
      },
    ]);
  });

  it("asks for nothing once the deadline, less its margin, has passed", async () => {
    await expect(
      worker.ensure(
        spec([], { ensureDeadline: new Date(Date.now() + DOCKER_CREATE_MARGIN_MS - 1) }),
      ),
    ).rejects.toThrow("The worker of attempt_1 missed its deadline");
    expect(supervisor.requests).toEqual([]);
  });

  it("aborts a create still pending at the deadline", async () => {
    supervisor.faults.stallCreate = true;

    await expect(
      worker.ensure(
        spec([], { ensureDeadline: new Date(Date.now() + DOCKER_CREATE_MARGIN_MS + 50) }),
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("retries a destroy once when the supervisor resets the connection under it", async () => {
    await worker.ensure(spec([]));
    supervisor.faults.resetNext = 1;

    expect(await worker.destroy({ attemptId: "attempt_1" })).toBe("destroyed");
  });

  it("never resends a create, which could start a second container on the same volumes", async () => {
    supervisor.faults.resetNext = 1;

    const failed = await worker.ensure(spec([])).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(WorkerEnsureSettledError);
    expect(supervisor.faults.resetNext).toBe(0);
    expect(supervisor.workers.size).toBe(0);
  });

  it("settles a create the supervisor refused with its own error, so nothing is left in flight", async () => {
    supervisor.faults.refuseCreate = {
      status: 500,
      body: JSON.stringify({ error: "invalid worker volume name" }),
    };

    const refused = await worker.ensure(spec([])).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(WorkerEnsureSettledError);
    expect((refused as Error).message).toBe(
      "Supervisor POST /workers failed with 500: invalid worker volume name",
    );
  });

  it("leaves a create failed by a gateway answer that is not the supervisor's JSON unsettled", async () => {
    supervisor.faults.refuseCreate = { status: 502, body: "<html>" };

    const failed = await worker.ensure(spec([])).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(WorkerEnsureSettledError);
  });

  it("reports a removal the supervisor could not confirm as an error, never as absent", async () => {
    supervisor.faults.failDelete = true;

    await expect(worker.destroy({ attemptId: "attempt_1" })).rejects.toThrow(
      "Supervisor DELETE /workers failed with 500: removal failed",
    );
  });

  it("destroys the attempt's worker without a ref, then reports none left", async () => {
    await worker.ensure(spec([]));

    const destroyed = await worker.destroy({ attemptId: "attempt_1" });
    const again = await worker.destroy({ attemptId: "attempt_1" });

    expect([destroyed, again]).toEqual(["destroyed", "absent"]);
    expect(supervisor.requests.at(-1)?.url).toBe("/workers?attempt=attempt_1");
  });

  it("creates a volume as a directory of DATA_DIR and returns its name every time", async () => {
    const input = { name: "tangow-vol_1", ensureDeadline: spec([]).ensureDeadline };

    const refs = [await worker.ensureVolume(input), await worker.ensureVolume(input)];

    expect(refs).toEqual([{ providerRef: "tangow-vol_1" }, { providerRef: "tangow-vol_1" }]);
    expect(await readdir(path.join(dataDir, "volumes"))).toEqual(["tangow-vol_1"]);
  });

  it("never follows a link left where a volume goes, to create or to delete", async () => {
    const outside = path.join(dataDir, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "keep.txt"), "keep");
    await mkdir(path.join(dataDir, "volumes"));
    await symlink(outside, path.join(dataDir, "volumes", "tangow-linked"));

    await expect(
      worker.ensureVolume({ name: "tangow-linked", ensureDeadline: spec([]).ensureDeadline }),
    ).rejects.toThrow("tangow-linked is not a directory");
    await worker.deleteVolume({ providerRef: "tangow-linked" });
    await worker.deleteVolume({ providerRef: "tangow-never-created" });

    expect(await readdir(path.join(dataDir, "volumes"))).toEqual([]);
    expect(await readdir(outside)).toEqual(["keep.txt"]);
  });

  it("carries frames both ways over the upgraded socket and settles exited when it ends", async () => {
    const { channel, channels, exited, fake } = await connected();
    const frames = channel.frames[Symbol.asyncIterator]();

    const line = encodeFrameLine(Buffer.from('{"kind":"worker.hello"}'));
    fake.socket.write(line.slice(0, 5));
    fake.socket.write(line.slice(5));
    const hello = await frames.next();
    await channel.send(Buffer.from('{"kind":"worker.start"}'));
    await until(() => fake.received().includes("\n"));
    fake.socket.end();
    await exited;

    expect(fake.capability).toBe("rkw1.claims.mac");
    expect(Buffer.from(hello.value!).toString()).toBe('{"kind":"worker.hello"}');
    expect(Buffer.from(fake.received().trim(), "base64").toString()).toBe(
      '{"kind":"worker.start"}',
    );
    expect(await frames.next()).toEqual({ done: true, value: undefined });
    expect(await channels.next()).toEqual({ done: true, value: undefined });
  });

  it("ends the connection when the socket resets, and settles exited only once destroyed", async () => {
    const { channel, channels, exited, fake } = await connected();

    fake.socket.resetAndDestroy();

    expect(await channel.frames[Symbol.asyncIterator]().next()).toEqual({
      done: true,
      value: undefined,
    });
    expect(await channels.next()).toEqual({ done: true, value: undefined });
    expect(await settled(exited)).toBe("pending");
    await worker.destroy({ attemptId: "attempt_1" });
    expect(await settled(exited)).toBe("settled");
  });

  it("opens no connection when the supervisor refuses the guest, and settles exited once destroyed", async () => {
    supervisor.faults.refuseUpgrade = true;

    const { connections, exited } = worker.connect(
      { attemptId: "attempt_1", providerRef: "ctr_gone" },
      "rkw1.claims.mac",
    );

    expect(await connections[Symbol.asyncIterator]().next()).toEqual({
      done: true,
      value: undefined,
    });
    expect(await settled(exited)).toBe("pending");
    expect(await worker.destroy({ attemptId: "attempt_1" })).toBe("absent");
    expect(await settled(exited)).toBe("settled");
  });
});

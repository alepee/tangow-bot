import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deletePushToken,
  ExpoPushProvider,
  expoPushErrorMessage,
  loadPushToken,
  MAX_EXPO_PUSH_RESPONSE_BYTES,
  savePushToken,
} from "./expo-push.js";

const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const notifyContext = {
  operationId: "n",
  traceId: "n",
  spaceId: "w",
  userId: "user-1",
  signal: new AbortController().signal,
};

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

describe("expo push tickets", () => {
  it("reads a single Expo ticket and a ticket array", () => {
    expect(expoPushErrorMessage({ data: { status: "ok", id: "1" } }, 200)).toBeUndefined();
    expect(expoPushErrorMessage({ data: { status: "error", message: "bad token" } }, 200)).toBe(
      "bad token",
    );
    expect(expoPushErrorMessage({ errors: [{ message: "rate limited" }] }, 429)).toBe(
      "rate limited",
    );
    expect(expoPushErrorMessage(undefined, 502)).toBe("expo push failed (502)");
    expect(
      expoPushErrorMessage(
        { data: { status: "error", details: { error: "DeviceNotRegistered" } } },
        200,
      ),
    ).toBe("DeviceNotRegistered");
  });
});

describe("expo push", () => {
  it("keeps refreshed push tokens owner-only", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "tangow-push-"));
    dirs.push(dataDir);
    const tokenFile = path.join(dataDir, "push-tokens", "user-1.txt");
    await savePushToken(dataDir, "user-1", "ExponentPushToken[old]");
    await chmod(tokenFile, 0o644);

    await savePushToken(dataDir, "user-1", "ExponentPushToken[new]");

    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
  });

  it("does not follow a token-file symlink for reads or writes", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "tangow-push-"));
    dirs.push(dataDir);
    const tokenDir = path.join(dataDir, "push-tokens");
    const tokenFile = path.join(tokenDir, "user-1.txt");
    const target = path.join(dataDir, "outside.txt");
    await savePushToken(dataDir, "user-1", "ExponentPushToken[old]");
    await writeFile(target, "not-a-push-token");
    await rm(tokenFile);
    await symlink(target, tokenFile);

    await expect(loadPushToken(dataDir, "user-1")).resolves.toBeUndefined();
    await expect(savePushToken(dataDir, "user-1", "ExponentPushToken[new]")).rejects.toThrow();
    await expect(readFile(target, "utf8")).resolves.toBe("not-a-push-token");
  });

  it("removes a registered token", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "tangow-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    await deletePushToken(dataDir, "user-1");
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBeUndefined();
  });

  it("does not call Expo when the user has no token", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "tangow-push-"));
    dirs.push(dataDir);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(dataDir);
    await push.send(
      { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
      {
        operationId: "n",
        traceId: "n",
        spaceId: "w",
        userId: "missing",
        signal: new AbortController().signal,
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to Expo when a token is registered", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "tangow-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { status: "ok", id: "ticket" } }));
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(dataDir);
    await push.send(
      {
        kind: "takeover",
        title: "Need you",
        subtitle: "Morning inbox",
        body: "on screen",
        botId: "bot-1",
        groupId: "group-1",
        threadId: "th-1",
        badge: 2,
      },
      notifyContext,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://exp.host/--/api/v2/push/send");
    const body = JSON.parse(String(init.body)) as {
      to: string;
      title: string;
      subtitle: string;
      collapseId: string;
      tag: string;
      badge: number;
      data: Record<string, string>;
    };
    expect(body.to).toBe("ExponentPushToken[test]");
    expect(body.title).toBe("Need you");
    expect(body.subtitle).toBe("Morning inbox");
    expect(body.collapseId).toBe("th-1");
    expect(body.tag).toBe("th-1");
    expect(body.badge).toBe(2);
    expect(body.data).toMatchObject({
      kind: "takeover",
      spaceId: "w",
      botId: "bot-1",
      groupId: "group-1",
      threadId: "th-1",
    });
  });

  it("marks an avatar push mutable so the iOS extension can show the bot", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "tangow-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => jsonResponse({ data: { status: "ok", id: "ticket" } }));
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(dataDir);
    await push.send(
      {
        kind: "completion",
        title: "Maya finished",
        body: "ok",
        botId: "b",
        threadId: "t",
        avatar: { character: "atlas", color: "#8287AD", shape: 3 },
      },
      notifyContext,
    );
    await push.send(
      { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
      notifyContext,
    );
    const [withAvatar, plain] = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse(String((init as RequestInit).body)),
    );
    expect(withAvatar.mutableContent).toBe(true);
    // The old color and shape stay for apps that predate characters.
    expect(withAvatar.data).toMatchObject({
      avatarCharacter: "atlas",
      avatarColor: "#8287AD",
      avatarShape: 3,
    });
    expect(plain).not.toHaveProperty("mutableContent");
    expect(plain.data).not.toHaveProperty("avatarColor");
  });

  it("leaves the badge out of the Expo body when no count is known", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "tangow-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { status: "ok", id: "ticket" } }));
    vi.stubGlobal("fetch", fetchMock);
    await new ExpoPushProvider(dataDir).send(
      { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
      notifyContext,
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty("badge");
  });

  it("throws when Expo rejects the request", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "tangow-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ errors: [{ message: "boom" }] }, 500)),
    );
    const push = new ExpoPushProvider(dataDir);
    await expect(
      push.send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("boom");
  });

  it("rejects and cancels a declared oversized response", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "tangow-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    const response = new Response("oversized", {
      headers: { "content-length": String(MAX_EXPO_PUSH_RESPONSE_BYTES + 1) },
    });
    const cancel = vi.spyOn(response.body!, "cancel");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(
      new ExpoPushProvider(dataDir).send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("Expo push response is too large.");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not wait past cancellation when an oversized body cancel hangs", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "tangow-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    let cancelStarted = false;
    const hangingBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancelStarted = true;
        return new Promise(() => undefined);
      },
    });
    const abort = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        setTimeout(() => abort.abort(), 20);
        return new Response(hangingBody, {
          headers: { "content-length": String(MAX_EXPO_PUSH_RESPONSE_BYTES + 1) },
        });
      }),
    );

    const started = Date.now();
    await expect(
      new ExpoPushProvider(dataDir).send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        { ...notifyContext, signal: abort.signal },
      ),
    ).rejects.toThrow("Expo push response is too large.");
    expect(cancelStarted).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("caps a streamed response without a content length", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "tangow-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new Uint8Array(MAX_EXPO_PUSH_RESPONSE_BYTES + 1))),
    );

    await expect(
      new ExpoPushProvider(dataDir).send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("Expo push response is too large.");
  });

  it("drops a token the device no longer owns, and keeps one a bad push key rejected", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "tangow-push-"));
    dirs.push(dataDir);
    const message = {
      kind: "completion" as const,
      title: "done",
      body: "ok",
      botId: "b",
      threadId: "t",
    };

    await savePushToken(dataDir, "user-1", "ExponentPushToken[dead]");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ data: { status: "error", details: { error: "DeviceNotRegistered" } } }),
        ),
    );
    await expect(new ExpoPushProvider(dataDir).send(message, notifyContext)).rejects.toThrow(
      "DeviceNotRegistered",
    );
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBeUndefined();

    await savePushToken(dataDir, "user-1", "ExponentPushToken[live]");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ data: { status: "error", details: { error: "InvalidCredentials" } } }),
        ),
    );
    await expect(new ExpoPushProvider(dataDir).send(message, notifyContext)).rejects.toThrow(
      "InvalidCredentials",
    );
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBe("ExponentPushToken[live]");
  });

  it("rejects malformed successful responses", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "tangow-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json")));

    await expect(
      new ExpoPushProvider(dataDir).send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("Expo push returned an invalid response.");
  });

  it("passes caller cancellation to the Expo request", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "tangow-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    const controller = new AbortController();
    controller.abort(new Error("notification cancelled"));
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(true);
      throw init?.signal?.reason;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new ExpoPushProvider(dataDir).send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        { ...notifyContext, signal: controller.signal },
      ),
    ).rejects.toThrow("notification cancelled");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws when the Expo request never reaches the network", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "tangow-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const push = new ExpoPushProvider(dataDir);
    await expect(
      push.send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("offline");
  });

  it("keeps a replacement token minted while Expo was condemning the old one", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "tangow-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[old]");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await savePushToken(dataDir, "user-1", "ExponentPushToken[new]");
        return jsonResponse({
          data: { status: "error", details: { error: "DeviceNotRegistered" } },
        });
      }),
    );
    const push = new ExpoPushProvider(dataDir);
    await expect(
      push.send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("DeviceNotRegistered");
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBe("ExponentPushToken[new]");
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@tangow/adapters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { sessionCookieHeader } from "./index.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
type AppHandles = Awaited<ReturnType<typeof createApp>>;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;

describeWithDatabase("structured @ mention targets", () => {
  let handles: AppHandles;
  let app: App;
  let prisma: AppHandles["prisma"];
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "tangow-mention-targets-"));

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      composio: new ComposioEmulator(),
      signupsEnabled: "true",
    });
    app = handles.app;
    prisma = handles.prisma;
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("starts a routine test run on the owning bot", async () => {
    const cookie = await signup(app, `mention-routine-${stamp}@tangow.test`, "Routine Owner");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const routine = await rpc<{ id: string }>(app, cookie, "routines/create", {
      botId: bot.id,
      name: "Daily digest",
      prompt: "Summarize inbox",
      crons: ["0 9 * * 1"],
      timezone: "UTC",
      notify: false,
      active: false,
    });
    const tested = await rpc<{ runId: string }>(app, cookie, "routines/testRun", {
      routineId: routine.id,
    });
    const run = await prisma.run.findUniqueOrThrow({ where: { id: tested.runId } });
    expect(run.botId).toBe(bot.id);
    expect(run.trigger).toBe("routine");
  });

  it("replays routine testRun with the same clientNonce", async () => {
    const cookie = await signup(app, `mention-routine-replay-${stamp}@tangow.test`, "Replay Owner");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "ReplayBot",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const routine = await rpc<{ id: string }>(app, cookie, "routines/create", {
      botId: bot.id,
      name: "Replay digest",
      prompt: "Replay inbox",
      crons: ["0 9 * * 1"],
      timezone: "UTC",
      notify: false,
      active: false,
    });
    const nonce = `routine-mention:${stamp}:replay`;
    const first = await rpc<{ runId: string }>(app, cookie, "routines/testRun", {
      routineId: routine.id,
      clientNonce: nonce,
    });
    const second = await rpc<{ runId: string }>(app, cookie, "routines/testRun", {
      routineId: routine.id,
      clientNonce: nonce,
    });
    expect(second.runId).toBe(first.runId);
    expect(
      await prisma.run.count({
        where: { clientNonce: `routine-test:${nonce}` },
      }),
    ).toBe(1);
  });

  it("includes connector intent on a 1:1 send prompt", async () => {
    const cookie = await signup(app, `mention-connector-${stamp}@tangow.test`, "Connector Owner");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const started = await rpc<{ connectionId: string }>(app, cookie, "connections/begin", {
      provider: "gmail",
      displayName: "Gmail",
    });
    await rpc(app, cookie, "connections/complete", { connectionId: started.connectionId });

    const sent = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "check my email",
      mentions: [{ kind: "connector", id: started.connectionId }],
    });
    const run = await prisma.run.findUniqueOrThrow({
      where: { id: sent.runId },
      include: { task: true },
    });
    expect(run.task.prompt).toContain("Use these connectors if relevant: Gmail");
  });

  it("names a mentioned group to the bot", async () => {
    const cookie = await signup(app, `mention-group-${stamp}@tangow.test`, "Group Owner");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "BotA",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const group = await rpc<{ id: string }>(app, cookie, "groups/create", {
      name: "Planning",
      botIds: [bot.id],
    });
    const sent = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "what is new in @Planning",
      mentions: [{ kind: "group", id: group.id }],
    });
    const run = await prisma.run.findUniqueOrThrow({
      where: { id: sent.runId },
      include: { task: true },
    });
    expect(run.task.prompt).toContain("Mentioned groups: Planning.");
  });

  it("wakes exactly one bot on an unmentioned group send", async () => {
    const cookie = await signup(app, `mention-group-default-${stamp}@tangow.test`, "Group Default");
    const botA = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "BotA",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const botB = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "BotB",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const group = await rpc<{ id: string; threadId: string }>(app, cookie, "groups/create", {
      name: "Squad",
      botIds: [botA.id, botB.id],
    });
    const before = await prisma.run.count({
      where: { threadId: group.threadId, trigger: "user" },
    });
    await rpc(app, cookie, "threads/send", { groupId: group.id, text: "hello team" });
    const after = await prisma.run.count({
      where: { threadId: group.threadId, trigger: "user" },
    });
    expect(after - before).toBe(1);
  });

  it("wakes a mentioned group member from typed bot chips and ignores non-members", async () => {
    const cookie = await signup(app, `mention-out-${stamp}@tangow.test`, "Out Of Chat");
    const botA = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "MemberA",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const botB = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "MemberB",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const outsider = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Outsider",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const group = await rpc<{ id: string; threadId: string }>(app, cookie, "groups/create", {
      name: "Core",
      botIds: [botA.id, botB.id],
    });
    const sent = await rpc<{ runId: string; runIds?: string[] }>(app, cookie, "threads/send", {
      groupId: group.id,
      text: "@MemberB @Outsider please review",
      mentions: [
        { kind: "bot", id: botB.id },
        { kind: "bot", id: outsider.id },
      ],
    });
    const runIds = sent.runIds ?? [sent.runId];
    const runs = await prisma.run.findMany({
      where: { id: { in: runIds } },
      select: { botId: true },
    });
    expect(runs.map((run) => run.botId).sort()).toEqual([botB.id].sort());
  });

  it("answers a group send and its replay with the runs in the order it addressed the bots", async () => {
    const cookie = await signup(app, `mention-order-${stamp}@tangow.test`, "Order Owner");
    const bots = [];
    for (const name of ["OrderA", "OrderB", "OrderC"]) {
      bots.push(
        await rpc<{ id: string }>(app, cookie, "bots/create", {
          name,
          title: "",
          description: "",
          instructions: "",
          notifyOnFinish: true,
        }),
      );
    }
    const [botA, botB, botC] = bots as [(typeof bots)[0], (typeof bots)[0], (typeof bots)[0]];
    const group = await rpc<{ id: string; threadId: string }>(app, cookie, "groups/create", {
      name: "Order",
      botIds: bots.map((bot) => bot.id),
    });
    // The first and last targets are already working: the send steers those older runs and
    // starts one for the middle target, so neither creation time nor id gives the order.
    const thread = await prisma.thread.findUniqueOrThrow({ where: { id: group.threadId } });
    const owner = { spaceId: thread.spaceId, userId: thread.userId, threadId: thread.id };
    const working = new Map<string, string>();
    for (const bot of [botA, botC]) {
      const task = await prisma.task.create({
        data: { ...owner, botId: bot.id, prompt: "earlier work", status: "running" },
      });
      const run = await prisma.run.create({
        data: { ...owner, botId: bot.id, taskId: task.id, status: "running", trigger: "user" },
      });
      working.set(bot.id, run.id);
    }
    const input = {
      groupId: group.id,
      text: "@OrderA @OrderB @OrderC split this",
      mentions: bots.map((bot) => ({ kind: "bot", id: bot.id })),
      clientNonce: `mention-order-${stamp}`,
    };

    const sent = await rpc<{ runId: string; runIds: string[] }>(app, cookie, "threads/send", input);
    const botOf = new Map(
      (await prisma.run.findMany({ where: { id: { in: sent.runIds } } })).map((run) => [
        run.id,
        run.botId,
      ]),
    );
    expect(sent.runIds.map((id) => botOf.get(id))).toEqual([botA.id, botB.id, botC.id]);
    expect([sent.runIds[0], sent.runIds[2]]).toEqual([working.get(botA.id), working.get(botC.id)]);
    expect(sent.runId).toBe(sent.runIds[0]);
    const replayed = await rpc<{ runId: string; runIds: string[] }>(
      app,
      cookie,
      "threads/send",
      input,
    );
    expect(replayed).toMatchObject({ runId: sent.runId, runIds: sent.runIds });
  });

  it("rejects another user's routine, connection, and group mentions", async () => {
    const ada = await signup(app, `mention-auth-ada-${stamp}@tangow.test`, "Ada Auth");
    const bob = await signup(app, `mention-auth-bob-${stamp}@tangow.test`, "Bob Auth");
    const adaBot = await rpc<{ id: string }>(app, ada, "bots/create", {
      name: "AdaBot",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const bobBot = await rpc<{ id: string }>(app, bob, "bots/create", {
      name: "BobBot",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const adaBotB = await rpc<{ id: string }>(app, ada, "bots/create", {
      name: "AdaBotB",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const routine = await rpc<{ id: string }>(app, ada, "routines/create", {
      botId: adaBot.id,
      name: "Private routine",
      prompt: "do work",
      crons: ["0 9 * * 1"],
      timezone: "UTC",
      notify: false,
      active: false,
    });
    const started = await rpc<{ connectionId: string }>(app, ada, "connections/begin", {
      provider: "gmail",
      displayName: "Gmail",
    });
    await rpc(app, ada, "connections/complete", { connectionId: started.connectionId });
    const group = await rpc<{ id: string }>(app, ada, "groups/create", {
      name: "Ada group",
      botIds: [adaBot.id, adaBotB.id],
    });

    const routineAttempt = await raw(app, bob, "routines/testRun", { routineId: routine.id });
    expect(routineAttempt.status).toBeGreaterThanOrEqual(400);

    const connectionAttempt = await raw(app, bob, "threads/send", {
      botId: bobBot.id,
      text: "use connector",
      mentions: [{ kind: "connector", id: started.connectionId }],
    });
    expect(connectionAttempt.status).toBeGreaterThanOrEqual(400);

    const groupMentionAttempt = await raw(app, bob, "threads/send", {
      botId: bobBot.id,
      text: "about @Ada group",
      mentions: [{ kind: "group", id: group.id }],
    });
    expect(groupMentionAttempt.status).toBeGreaterThanOrEqual(400);

    const groupAttempt = await raw(app, bob, "threads/send", {
      groupId: group.id,
      text: "intrude",
    });
    expect(groupAttempt.status).toBeGreaterThanOrEqual(400);

    const routineRuns = await prisma.run.count({ where: { botId: adaBot.id, trigger: "routine" } });
    expect(routineRuns).toBe(0);
  });
});

async function signup(app: App, email: string, name: string) {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (res.status >= 400) {
    throw new Error(`signup failed ${res.status}: ${await res.text()}`);
  }
  return sessionCookieHeader(res);
}

async function raw(app: App, cookie: string, proc: string, body: unknown = {}) {
  return app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body }),
  });
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await raw(app, cookie, proc, body);
  const text = await res.text();
  let parsed: { json?: T; error?: { message?: string } };
  try {
    parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  } catch {
    throw new Error(`${proc} ${res.status}: ${text}`);
  }
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}

import type { SandboxProvider } from "@tangow/adapter-kit";
import type { Actor, SessionEntry } from "@tangow/contracts";
import { SessionEntrySchema, SessionId } from "@tangow/contracts";
import type { PrismaClient, ThreadEvents } from "@tangow/db";
import {
  appendCardStateInTransaction,
  appendSessionEntryInTransaction,
  conversationRunFilter,
  IsolationError,
  threadOfSession,
} from "@tangow/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelSupersededQueuedRuns,
  reactToThreadMessage,
  readSessionEntries,
  sendThreadMessage,
  stopThreadRuns,
  type ThreadTarget,
  threadHead,
  threadSnapshot,
} from "./thread-target.js";

vi.mock("../../../packages/db/src/sessions.js", async () =>
  (await import("@tangow/db/sessions.test-support")).stubbedDbSessions(),
);

beforeEach(() => {
  vi.resetAllMocks();
});

/** Every bot asked about is one the sender can use. */
function everyBotUsable() {
  return {
    findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map((id) => ({ id })),
    ),
  };
}

/** The thread row: its main session, its bot and the cursor of its feed. */
const THREAD = { sessionId: "session-1", botId: "bot-1", nextEventSeq: 2 };

/** The card a waiting run is parked on, as the entry `latestRunAsk` reads. */
function askEntry(id: string, block: Record<string, unknown>) {
  const approval = typeof block.approvalEffectId === "string";
  return {
    id,
    sessionId: "session-1",
    seq: 3,
    parentId: "entry-2",
    type: approval ? "effect.requested" : "assistant.ask",
    payload: approval
      ? { effectId: block.approvalEffectId, effectKind: "approval", proposal: {}, card: block }
      : { block },
    botId: "bot-1",
    runId: "run-1",
    createdAt: new Date("2026-10-01T09:00:00.000Z"),
  };
}

/** A message of the thread's session a reply quotes, written outside any run. */
function parentEntry(id: string, ...blocks: Array<Record<string, unknown>>) {
  return { id, sessionId: "session-1", runId: null, payload: { blocks } };
}

/** The person's messages the send wrote, as their entries. */
function sentMessages() {
  return vi
    .mocked(appendSessionEntryInTransaction)
    .mock.calls.map(([, draft]) => draft)
    .filter(
      (draft): draft is Extract<typeof draft, { type: "user.message" }> =>
        draft.type === "user.message",
    );
}

describe("threadHead", () => {
  it("returns the durable cursor without loading a snapshot", async () => {
    const findFirst = vi.fn().mockResolvedValue({ seq: 12 });
    const prisma = { event: { findFirst } } as unknown as PrismaClient;
    const target = { threadId: "thread-1" } as ThreadTarget;

    await expect(threadHead(prisma, target)).resolves.toEqual({
      threadId: "thread-1",
      cursor: 12,
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { threadId: "thread-1" },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
  });
});

describe("queued run supersession", () => {
  it("only cancels queued runs started by user messages or reactions", async () => {
    const tx = {
      run: {
        findMany: vi.fn().mockResolvedValue([{ id: "run-old", taskId: "task-old" }]),
        updateMany: vi.fn(),
      },
      task: { updateMany: vi.fn() },
    };
    await cancelSupersededQueuedRuns(tx as never, {
      threadId: "thread-1",
      botIds: ["bot-1"],
      userId: "user-1",
      keepRunIds: ["run-new"],
    });
    expect(tx.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { trigger: "user", sourceMessage: { type: "user.message" } },
            { trigger: "reaction" },
          ],
        }),
      }),
    );
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["run-old"] } } }),
    );
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["task-old"] } },
      data: { status: "cancelled" },
    });
  });
});

describe("reaction messages", () => {
  it("appends repeated reactions as quiet replies and deduplicates retries", async () => {
    // The thread's session as the reactions fill it, by clientNonce.
    const byNonce = new Map<string, Record<string, unknown>>();
    vi.mocked(appendSessionEntryInTransaction).mockImplementation(async (_tx, draft) => {
      const entry = { ...draft, seq: byNonce.size + 1 };
      byNonce.set((draft.payload as { clientNonce: string }).clientNonce, entry);
      return entry as never;
    });
    const tx = {
      $queryRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
        const entry = sql.join("?").includes("clientNonce") && byNonce.get(String(values.at(-1)));
        return entry ? [{ ...entry, parentId: "parent", createdAt: new Date() }] : [];
      }),
      sessionEntry: { findFirst: vi.fn().mockResolvedValue({ id: "parent" }) },
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue(THREAD) },
      task: { create: vi.fn() },
      run: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;
    const actor = { spaceId: "space-1", userId: "user-1" } as Actor;
    for (const [clientNonce, reaction] of [
      ["first", "❤️"],
      ["second", "👍"],
      ["third", "❤️"],
      ["third", "❤️"],
    ] as const) {
      await reactToThreadMessage({ prisma }, actor, target, {
        messageId: "parent",
        reaction,
        clientNonce,
      });
    }
    expect(sentMessages()).toHaveLength(3);
    expect(sentMessages().at(-1)).toMatchObject({
      sessionId: "session-1",
      payload: {
        blocks: [{ kind: "text", text: "❤️" }],
        replyTo: { entryId: "parent" },
        clientNonce: "third",
        source: "app",
      },
    });
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.sessionEntry.findFirst).toHaveBeenCalledWith({
      where: { id: "parent", session: { threadId: "thread-1", kind: "thread" } },
      select: { id: true },
    });
    tx.sessionEntry.findFirst.mockResolvedValueOnce(null);
    await expect(
      reactToThreadMessage({ prisma }, actor, target, {
        messageId: "elsewhere",
        reaction: "❤️",
        clientNonce: "fourth",
      }),
    ).rejects.toThrow();
    expect(sentMessages()).toHaveLength(3);
  });
});

describe("threadSnapshot", () => {
  it("serves the chain's tail and the open run's progress since its last entry from one commit", async () => {
    const run = {
      id: "run-1",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const at = new Date("2026-08-23T00:00:02.000Z");
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: "event-5",
            spaceId: "space-1",
            threadId: "thread-1",
            botId: "bot-1",
            seq: 5,
            type: "thread.progress",
            payload: { text: "Looking it up" },
            runId: "run-1",
            createdAt: at,
          },
        ]),
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue({ sessionId: "session-1" }) },
      event: { findFirst: vi.fn().mockResolvedValue({ seq: 5 }) },
      run: { findFirst: botRunFindFirst([run]) },
    };
    let committed = false;
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => {
        const result = await callback(tx);
        committed = true;
        return result;
      }),
      run: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const question = SessionEntrySchema.parse({
      id: "entry-7",
      sessionId: "session-1",
      seq: 7,
      parentId: "entry-6",
      ts: "2026-08-23T00:00:00.000Z",
      type: "user.message",
      payload: { blocks: [{ kind: "text", text: "Find the invoice" }], source: "app" },
    });
    const landedAfterCommit = SessionEntrySchema.parse({
      id: "entry-8",
      sessionId: "session-1",
      seq: 8,
      parentId: "entry-7",
      ts: "2026-08-23T00:00:03.000Z",
      botId: "bot-1",
      runId: "run-1",
      type: "assistant.text",
      payload: { blocks: [{ kind: "text", text: "Looking it up" }] },
    });
    const sessionLog = {
      readPage: vi.fn(async () => (committed ? [question, landedAfterCommit] : [question])),
      readAround: vi.fn(async () => []),
    };

    const snapshot = await threadSnapshot({ prisma, sessionLog }, target);

    expect({
      cursor: snapshot.cursor,
      entries: snapshot.entries,
      olderCursor: snapshot.olderCursor,
      progress: snapshot.progress,
    }).toEqual({
      cursor: 5,
      entries: [
        {
          id: "entry-7",
          seq: 7,
          parentId: "entry-6",
          ts: "2026-08-23T00:00:00.000Z",
          type: "user.message",
          payload: { blocks: [{ kind: "text", text: "Find the invoice" }], source: "app" },
        },
      ],
      olderCursor: "entry-7",
      progress: [
        {
          id: "event-5",
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          seq: 5,
          type: "thread.progress",
          runId: "run-1",
          createdAt: "2026-08-23T00:00:02.000Z",
          payload: { text: "Looking it up" },
        },
      ],
    });
  });

  it("returns the latest failed run so the client can show its error", async () => {
    const run = {
      id: "run-failed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: "Provider is not configured: openrouter",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const findFirstRun = botRunFindFirst([run]);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue({ sessionId: "session-1" }) },
      event: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      run: { findFirst: findFirstRun },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma, sessionLog: tailOf([]) }, target);

    expect(findFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: "bot-1",
          threadId: "thread-1",
          OR: [
            {
              status: {
                in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"],
              },
            },
            { trigger: { not: "bot_message" }, status: "failed" },
          ],
        }),
      }),
    );
    expect(findFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          botId: "bot-1",
          threadId: "thread-1",
          status: { in: ["waiting_input", "waiting_takeover"] },
          parentRunId: null,
        },
      }),
    );
    expect(snapshot.run).toEqual(
      expect.objectContaining({
        id: "run-failed",
        status: "failed",
        error: "Provider is not configured: openrouter",
      }),
    );
  });

  it("prefers a waiting peer ask over a concurrent user run", async () => {
    const waitingPeer = {
      id: "run-peer-waiting",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "waiting_input",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:02.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:02.000Z"),
    };
    const olderUser = {
      id: "run-user",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-user",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
    };
    const snapshot = await threadSnapshot(
      {
        sessionLog: tailOf([]),
        prisma: {
          $transaction: vi.fn(async (callback: (client: unknown) => unknown) =>
            callback({
              $queryRaw: vi.fn().mockResolvedValue([]),
              thread: { findUniqueOrThrow: vi.fn().mockResolvedValue({ sessionId: "session-1" }) },
              event: {
                findFirst: vi.fn().mockResolvedValue(null),
                findMany: vi.fn().mockResolvedValue([]),
              },
              run: { findFirst: botRunFindFirst([waitingPeer, olderUser]) },
            }),
          ),
        } as unknown as PrismaClient,
      },
      {
        kind: "bot",
        botId: "bot-1",
        threadId: "thread-1",
        bot: { computer: null },
      } as ThreadTarget,
    );

    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-peer-waiting", status: "waiting_input" }),
    );
  });

  it("drops a failed run once a newer run has finished", async () => {
    const failed = {
      id: "run-failed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: "This operation was aborted",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const completed = {
      id: "run-completed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-2",
      status: "completed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:03.000Z"),
      createdAt: new Date("2026-08-23T00:00:02.000Z"),
    };
    const findFirstRun = botRunFindFirst([failed, completed]);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue({ sessionId: "session-1" }) },
      event: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
      },
      run: { findFirst: findFirstRun },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma, sessionLog: tailOf([]) }, target);

    expect(findFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          trigger: { not: "bot_message" },
          status: { in: ["failed", "completed", "cancelled"] },
        }),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    );
    expect(snapshot.run).toBeNull();
  });

  it("shows a busy peer run as the bot thread's run without leaking its live events", async () => {
    const peerRunning = {
      id: "run-peer-running",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "running",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:05.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:05.000Z"),
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([peerProgress("run-peer-running")]),
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue({ sessionId: "session-1" }) },
      event: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      run: { findFirst: botRunFindFirst([peerRunning]) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma, sessionLog: tailOf([]) }, target);

    // The bot really is working, so the chat must say so...
    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-peer-running", status: "running" }),
    );
    // ...without replaying what it is doing for the other bot.
    expect(snapshot.progress).toEqual([]);
  });

  it("hides a failed peer run from the bot thread", async () => {
    const peerFailed = {
      id: "run-peer-failed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "failed",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: "peer exploded",
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: new Date("2026-08-23T00:00:02.000Z"),
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue({ sessionId: "session-1" }) },
      event: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
      },
      run: { findFirst: botRunFindFirst([peerFailed]) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma, sessionLog: tailOf([]) }, target);

    expect(snapshot.run).toBeNull();
  });

  it("does not return a cancelled or completed run", async () => {
    const findFirstRun = botRunFindFirst([]);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue({ sessionId: "session-1" }) },
      event: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      run: { findFirst: findFirstRun },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    const snapshot = await threadSnapshot({ prisma, sessionLog: tailOf([]) }, target);

    expect(findFirstRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            {
              status: {
                in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"],
              },
            },
            { trigger: { not: "bot_message" }, status: "failed" },
          ],
        }),
      }),
    );
    expect(snapshot.run).toBeNull();
  });
  it("returns a group's latest failed run so a refresh keeps its error", async () => {
    const run = {
      id: "run-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: "member exploded",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const findManyRuns = groupRunFindMany({ terminals: [run] });
    const snapshot = await threadSnapshot(
      { sessionLog: tailOf([]), prisma: groupPrisma(findManyRuns) },
      groupTarget(),
    );

    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          threadId: "thread-1",
          parentRunId: null,
          trigger: { not: "bot_message" },
          status: { in: ["failed", "completed", "cancelled"] },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 50,
      }),
    );
    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          threadId: "thread-1",
          parentRunId: null,
          status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
        },
      }),
    );
    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-failed", status: "failed", error: "member exploded" }),
    );
    expect(snapshot.activeRuns).toEqual([]);
  });

  it("shows a busy peer run in group activeRuns but hides its failure", async () => {
    const peerActive = {
      id: "run-peer-active",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "running",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:05.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:05.000Z"),
    };
    const peerFailed = {
      id: "run-peer-failed",
      botId: "bot-b",
      threadId: "thread-1",
      taskId: "task-peer-fail",
      status: "failed",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: "peer exploded",
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: new Date("2026-08-23T00:00:02.000Z"),
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
    };
    const findManyRuns = groupRunFindMany({
      active: [peerActive],
      terminals: [peerFailed],
    });
    const snapshot = await threadSnapshot(
      { sessionLog: tailOf([]), prisma: groupPrisma(findManyRuns) },
      groupTarget(),
    );

    // The chat must look busy while a peer waits on this bot...
    expect(snapshot.activeRuns).toEqual([
      expect.objectContaining({ id: "run-peer-active", status: "running" }),
    ]);
    expect(snapshot.run).toEqual(expect.objectContaining({ id: "run-peer-active" }));
    // ...but the peer's failure belongs to the bot that ordered the work, not to this user.
    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
        }),
      }),
    );
    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          trigger: { not: "bot_message" },
          status: { in: ["failed", "completed", "cancelled"] },
        }),
      }),
    );
  });

  it("keeps a peer run parked on ask_user answerable without leaking its live events", async () => {
    const peerAsking = {
      id: "run-peer-asking",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "waiting_input",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:05.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:05.000Z"),
    };
    const peerRunning = { ...peerAsking, id: "run-peer-running", status: "running" };
    const queryRaw = vi.fn().mockResolvedValue([peerProgress("run-peer-running")]);
    const snapshot = await threadSnapshot(
      {
        sessionLog: tailOf([]),
        prisma: groupPrisma(groupRunFindMany({ active: [peerAsking, peerRunning] }), queryRaw),
      },
      groupTarget(),
    );

    // The ask must be answerable (the client gates AskCard on activeRuns), and the merely-busy
    // peer run keeps the working indicator alive...
    expect(snapshot.activeRuns?.map((run) => run.id)).toEqual([
      "run-peer-asking",
      "run-peer-running",
    ]);
    // ...but no peer narration may be streamed into the transcript.
    expect(snapshot.progress).toEqual([]);
  });

  it("leaves a hidden peer run's steps out of the snapshot's page", async () => {
    const step = (seq: number, type: string, payload: object, envelope: object = {}) =>
      SessionEntrySchema.parse({
        id: `entry-${seq}`,
        sessionId: "session-1",
        seq,
        parentId: seq === 0 ? null : `entry-${seq - 1}`,
        ts: new Date(Date.UTC(2026, 9, 11, 9, 0, seq)).toISOString(),
        type,
        payload,
        ...envelope,
      });
    const peer = { botId: "bot-scout", runId: "run-peer" };
    const page = [
      step(0, "user.message", { blocks: [{ kind: "text", text: "Ask Scout" }], source: "app" }),
      step(1, "tool.call", { callId: "call-1", name: "search", input: "{}" }, peer),
      step(2, "assistant.ask", { block: { kind: "ask", text: "Which market?" } }, peer),
    ];
    const prisma = {
      ...groupPrisma(groupRunFindMany({})),
      run: {
        findMany: vi.fn(async () => [
          { id: "run-peer", bot: { parentBotId: "bot-chief" }, sourceMessage: null },
        ]),
      },
    } as unknown as PrismaClient;

    const snapshot = await threadSnapshot({ sessionLog: tailOf(page), prisma }, groupTarget());

    expect(snapshot.entries.map((entry) => entry.id)).toEqual(["entry-0", "entry-2"]);
  });

  it("includes waiting peer bot_message runs in group activeRuns", async () => {
    const peerWaiting = {
      id: "run-peer-waiting",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "waiting_input",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:05.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:05.000Z"),
    };
    const findManyRuns = groupRunFindMany({ active: [peerWaiting] });
    const snapshot = await threadSnapshot(
      { sessionLog: tailOf([]), prisma: groupPrisma(findManyRuns) },
      groupTarget(),
    );

    expect(snapshot.activeRuns).toEqual([
      expect.objectContaining({ id: "run-peer-waiting", status: "waiting_input" }),
    ]);
  });

  it("keeps a waiting peer ask as the primary run even when a newer busy run exists", async () => {
    // Real DB order is createdAt desc, so the newer busy run for bot-b comes
    // first here, ahead of the older waiting peer run for bot-a.
    const newerBusy = {
      id: "run-newer-busy",
      botId: "bot-b",
      threadId: "thread-1",
      taskId: "task-busy",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:10.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:10.000Z"),
    };
    const olderWaiting = {
      id: "run-older-waiting",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-peer",
      status: "waiting_input",
      trigger: "bot_message",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:05.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:05.000Z"),
    };
    const findManyRuns = groupRunFindMany({ active: [newerBusy, olderWaiting] });
    const snapshot = await threadSnapshot(
      { sessionLog: tailOf([]), prisma: groupPrisma(findManyRuns) },
      groupTarget(),
    );

    expect(snapshot.run).toEqual(expect.objectContaining({ id: "run-older-waiting" }));
    // activeRuns is unaffected by which one is chosen as primary.
    expect(snapshot.activeRuns.map((run) => run.id)).toEqual([
      "run-newer-busy",
      "run-older-waiting",
    ]);
  });

  it("does not revive an older group failure after a newer run completed", async () => {
    const failed = {
      id: "run-old-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "old failure",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const completed = {
      id: "run-newer-completed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-2",
      status: "completed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:02.000Z"),
      completedAt: new Date("2026-08-23T00:00:04.000Z"),
      createdAt: new Date("2026-08-23T00:00:02.000Z"),
    };
    const snapshot = await threadSnapshot(
      {
        sessionLog: tailOf([]),
        prisma: groupPrisma(groupRunFindMany({ terminals: [completed, failed] })),
      },
      groupTarget(),
    );

    expect(snapshot.run).toBeNull();
    expect(snapshot.activeRuns).toEqual([]);
  });

  it("does not revive a failure when a newer cancelled run has null completedAt", async () => {
    const failed = {
      id: "run-old-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "old failure",
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const cancelled = {
      id: "run-newer-cancelled",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-2",
      status: "cancelled",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:02.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:03.000Z"),
    };
    const snapshot = await threadSnapshot(
      {
        sessionLog: tailOf([]),
        prisma: groupPrisma(groupRunFindMany({ terminals: [cancelled, failed] })),
      },
      groupTarget(),
    );

    expect(snapshot.run).toBeNull();
  });

  it("prefers a timestamped terminal over an older failure with null completedAt", async () => {
    const failed = {
      id: "run-old-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "old failure",
      startedAt: null,
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const completed = {
      id: "run-completed",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-2",
      status: "completed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:02.000Z"),
      completedAt: new Date("2026-08-23T00:00:04.000Z"),
      createdAt: new Date("2026-08-23T00:00:02.000Z"),
    };
    const snapshot = await threadSnapshot(
      {
        sessionLog: tailOf([]),
        prisma: groupPrisma(groupRunFindMany({ terminals: [failed, completed] })),
      },
      groupTarget(),
    );

    expect(snapshot.run).toBeNull();
  });

  it("clamps a long persisted group failure error on refresh", async () => {
    const longError = "x".repeat(400);
    const run = {
      id: "run-failed",
      botId: "bot-2",
      threadId: "thread-1",
      taskId: "task-1",
      status: "failed",
      trigger: "user",
      modelProvider: "openrouter",
      modelId: "openrouter/unknown",
      error: longError,
      startedAt: null,
      completedAt: new Date("2026-08-23T00:00:01.000Z"),
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const snapshot = await threadSnapshot(
      { sessionLog: tailOf([]), prisma: groupPrisma(groupRunFindMany({ terminals: [run] })) },
      groupTarget(),
    );

    expect(snapshot.run).toEqual(
      expect.objectContaining({
        id: "run-failed",
        status: "failed",
        error: `${"x".repeat(300)}…`,
      }),
    );
  });

  it("keeps a concurrent member failure in run while another member is still active", async () => {
    const active = {
      id: "run-active",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-a",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:00.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:00.000Z"),
    };
    const failed = {
      id: "run-failed",
      botId: "bot-b",
      threadId: "thread-1",
      taskId: "task-b",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "member exploded",
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: new Date("2026-08-23T00:00:02.000Z"),
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
    };
    const snapshot = await threadSnapshot(
      {
        sessionLog: tailOf([]),
        prisma: groupPrisma(groupRunFindMany({ active: [active], terminals: [failed] })),
      },
      groupTarget(),
    );

    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-failed", status: "failed", error: "member exploded" }),
    );
    expect(snapshot.activeRuns).toEqual([
      expect.objectContaining({ id: "run-active", status: "running" }),
    ]);
  });

  it("keeps a failure on refresh when another member starts after it", async () => {
    const lateActive = {
      id: "run-late",
      botId: "bot-a",
      threadId: "thread-1",
      taskId: "task-a",
      status: "running",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: new Date("2026-08-23T00:00:03.000Z"),
      completedAt: null,
      createdAt: new Date("2026-08-23T00:00:03.000Z"),
    };
    const failed = {
      id: "run-failed",
      botId: "bot-b",
      threadId: "thread-1",
      taskId: "task-b",
      status: "failed",
      trigger: "user",
      modelProvider: null,
      modelId: null,
      error: "member exploded",
      startedAt: new Date("2026-08-23T00:00:01.000Z"),
      completedAt: new Date("2026-08-23T00:00:02.000Z"),
      createdAt: new Date("2026-08-23T00:00:01.000Z"),
    };
    const snapshot = await threadSnapshot(
      {
        sessionLog: tailOf([]),
        prisma: groupPrisma(groupRunFindMany({ active: [lateActive], terminals: [failed] })),
      },
      groupTarget(),
    );

    expect(snapshot.run).toEqual(
      expect.objectContaining({ id: "run-failed", status: "failed", error: "member exploded" }),
    );
    expect(snapshot.activeRuns).toEqual([
      expect.objectContaining({ id: "run-late", status: "running" }),
    ]);
  });
});

function isTerminalRunQuery(where: RunWhereClause | undefined) {
  const statuses = typeof where?.status === "object" ? where.status?.in : undefined;
  return Array.isArray(statuses) && statuses.includes("failed") && statuses.includes("completed");
}

type RunWhereClause = {
  status?: { in?: string[] } | string;
  trigger?: { not?: string };
  OR?: RunWhereClause[];
};

/** The subset of Prisma's run filter the snapshot actually builds: status, trigger, and one OR. */
function matchesRunWhere(
  row: { trigger?: string; status?: string },
  where: RunWhereClause | undefined,
): boolean {
  if (!where) return true;
  if (typeof where.status === "string" && row.status !== where.status) return false;
  const statuses = typeof where.status === "object" ? where.status?.in : undefined;
  if (statuses && !statuses.includes(row.status ?? "")) return false;
  if (where.trigger?.not !== undefined && row.trigger === where.trigger.not) return false;
  if (where.OR && !where.OR.some((clause) => matchesRunWhere(row, clause))) return false;
  return true;
}

function botRunFindFirst(
  rows: Array<{
    id: string;
    status: string;
    trigger?: string;
    createdAt?: Date;
  }>,
) {
  return vi
    .fn()
    .mockImplementation(async (args: { where?: RunWhereClause; select?: { id?: boolean } }) => {
      const matched = rows
        .filter((row) => matchesRunWhere(row, args.where))
        .sort((a, b) => {
          const byCreated = (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
          return byCreated !== 0 ? byCreated : b.id.localeCompare(a.id);
        });
      const row = matched[0] ?? null;
      if (!row) return null;
      return args.select?.id ? { id: row.id } : row;
    });
}

function groupRunFindMany(input: { active?: unknown[]; terminals?: unknown[] }) {
  return vi.fn().mockImplementation(async (args: { where?: RunWhereClause }) => {
    const rows = isTerminalRunQuery(args.where) ? (input.terminals ?? []) : (input.active ?? []);
    return rows.filter((row) =>
      matchesRunWhere(row as { trigger?: string; status?: string }, args.where),
    );
  });
}

function groupPrisma(
  findManyRuns: ReturnType<typeof groupRunFindMany>,
  queryRaw = vi.fn().mockResolvedValue([]),
) {
  const tx = {
    $queryRaw: queryRaw,
    thread: { findUniqueOrThrow: vi.fn().mockResolvedValue({ sessionId: "session-1" }) },
    event: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    run: { findMany: findManyRuns },
  };
  return {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    $queryRaw: vi.fn().mockResolvedValue([]),
    chatGroupPerson: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaClient;
}

/** A progress row the replay query would return if it were asked about this run. */
function peerProgress(runId: string) {
  return {
    id: `event-${runId}`,
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    seq: 6,
    type: "thread.progress",
    payload: { text: "Working for the other bot" },
    runId,
    createdAt: new Date("2026-08-23T00:00:06.000Z"),
  };
}

function tailOf(entries: SessionEntry[]) {
  return {
    readPage: vi.fn(async (_sessionId: string, _page: { limit: number }) => entries),
    readAround: vi.fn(async () => []),
  };
}

function groupTarget() {
  return {
    kind: "group",
    groupId: "group-1",
    groupName: "Group",
    members: [],
    threadId: "thread-1",
  } as unknown as ThreadTarget;
}

describe("readSessionEntries", () => {
  const actor = {
    userId: "user-1",
    spaceId: "space-1",
    email: "user@tangow.test",
    isDeploymentOwner: false,
  } satisfies Actor;
  const at = (second: number) => new Date(Date.UTC(2026, 9, 11, 9, 0, second)).toISOString();
  const helperStep = (seq: number) =>
    SessionEntrySchema.parse({
      id: `entry-helper-${seq}`,
      sessionId: "session-helper",
      seq,
      parentId: seq === 0 ? null : `entry-helper-${seq - 1}`,
      ts: at(seq % 60),
      botId: "bot-1",
      runId: "run-helper",
      type: "tool.call",
      payload: { callId: `call-${seq}`, name: "search", input: "{}" },
    });
  const raisedAsk = SessionEntrySchema.parse({
    id: "entry-ask",
    sessionId: "session-main",
    seq: 40,
    parentId: "entry-39",
    ts: at(1),
    botId: "bot-1",
    runId: "run-helper",
    type: "assistant.ask",
    payload: { block: { kind: "ask", text: "Which market?" }, originSessionId: "session-helper" },
  });

  function reader(threadId: string | null, ownBot: boolean, run: SessionEntry[]) {
    vi.mocked(threadOfSession).mockResolvedValueOnce(threadId);
    const prisma = {
      thread: { findUnique: vi.fn(async () => ({ botId: "bot-1", groupId: null })) },
      bot: {
        findFirst: vi.fn(async () =>
          ownBot ? { id: "bot-1", thread: { id: "thread-1" }, computer: null } : null,
        ),
      },
      run: { findFirst: vi.fn(async () => ({ id: "run-helper" })) },
    } as unknown as PrismaClient;
    const sessionLog = {
      readRun: vi.fn(async (runId: string, { limit }: { limit?: number } = {}) =>
        runId !== "run-helper" ? [] : limit === undefined ? run : run.slice(-limit),
      ),
    };
    return { deps: { prisma, sessionLog }, sessionLog };
  }

  it("reads a child session as its run, joined with what rose to the thread, and refuses any other", async () => {
    const helper = SessionId.parse("session-helper");
    const joined = [helperStep(0), raisedAsk, helperStep(2)];
    const opened = reader("thread-1", true, joined);
    const foreignThread = reader("thread-1", false, joined);
    const outsideSpace = reader(null, true, joined);

    const read = await readSessionEntries(opened.deps, actor, helper);

    expect(read).toEqual({ entries: joined });
    await expect(readSessionEntries(foreignThread.deps, actor, helper)).rejects.toThrow(
      IsolationError,
    );
    await expect(readSessionEntries(outsideSpace.deps, actor, helper)).rejects.toThrow(
      IsolationError,
    );
    expect(foreignThread.sessionLog.readRun).not.toHaveBeenCalled();
    expect(outsideSpace.sessionLog.readRun).not.toHaveBeenCalled();
  });

  it("keeps the newest thousand entries of a longer session and says it cut the oldest", async () => {
    const long = Array.from({ length: 1001 }, (_, seq) => helperStep(seq));
    const { deps } = reader("thread-1", true, long);

    const read = await readSessionEntries(deps, actor, SessionId.parse("session-helper"));

    expect([read.entries.length, read.entries[0]?.id, read.entries.at(-1)?.id]).toEqual([
      1000,
      "entry-helper-1",
      "entry-helper-1000",
    ]);
    expect(read.truncated).toBe(true);
  });
});

describe("sendThreadMessage", () => {
  it("rejects a new bot message while a run is waiting on an approval ask", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue(THREAD) },
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          askEntry("ask-msg-1", {
            kind: "ask",
            approvalEffectId: "effect-1",
            text: "Allow this?",
            status: "pending",
            actions: [
              { id: "allow", label: "Allow" },
              { id: "deny", label: "Deny" },
            ],
          }),
        ),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "run-waiting", taskId: "task-1", status: "waiting_input" }]),
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1" }),
      },
      steeringMessage: { create: vi.fn() },
      task: { create: vi.fn(), updateMany: vi.fn() },
    };
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn() } as never,
          jobs: { enqueue: vi.fn() } as never,
        },
        actor,
        target,
        {
          text: "hi",
          clientNonce: "nonce-1",
        },
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Answer the pending ask first.",
    });
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
  });

  it("never steers a message into a run that only reports through a routine card", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue(THREAD) },
      run: {
        findMany: vi
          .fn()
          // Every active run, as the ask and conflict checks see them: a routine card run.
          .mockResolvedValueOnce([{ id: "run-card", taskId: "task-card", status: "running" }])
          // The conversation runs among them: none.
          .mockResolvedValueOnce([])
          // No superseded queued user run to cancel.
          .mockResolvedValueOnce([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      steeringMessage: { create: vi.fn() },
      task: {
        create: vi.fn().mockResolvedValue({ id: "task-1" }),
        updateMany: vi.fn(),
      },
    };
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn(async () => undefined) } as never,
        jobs: { enqueue: vi.fn(async () => undefined) } as never,
      },
      { spaceId: "workspace-1", userId: "user-1" } as Actor,
      target,
      { text: "hi", clientNonce: "nonce-1" },
    );

    // The ask/conflict lookup still sees the card run, so it can answer its own ask.
    expect(tx.run.findMany.mock.calls[0]?.[0]?.where).not.toHaveProperty("NOT");
    expect(tx.run.findMany).toHaveBeenNthCalledWith(2, {
      where: { id: { in: ["run-card"] }, ...conversationRunFilter },
      select: { id: true },
    });
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(tx.run.create).toHaveBeenCalled();
  });

  describe("link previews", () => {
    function sendHarness(enqueue = vi.fn(async () => undefined)) {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        thread: { findUniqueOrThrow: vi.fn().mockResolvedValue(THREAD) },
        run: {
          findMany: vi.fn().mockResolvedValue([]),
          findUnique: vi.fn().mockResolvedValue({ status: "queued" }),
          create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
        },
        steeringMessage: { create: vi.fn() },
        task: { create: vi.fn().mockResolvedValue({ id: "task-1" }), updateMany: vi.fn() },
      };
      const prisma = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as unknown as PrismaClient;
      const target = {
        kind: "bot",
        botId: "bot-1",
        threadId: "thread-1",
        bot: { computer: null },
      } as ThreadTarget;
      const send = (input: { linkPreview?: false }) =>
        sendThreadMessage(
          {
            prisma,
            events: { notify: vi.fn(async () => undefined) } as never,
            jobs: { enqueue } as never,
          },
          { spaceId: "workspace-1", userId: "user-1" } as Actor,
          target,
          { text: "see https://example.test/a", clientNonce: "nonce-1", ...input },
        );
      return { enqueue, send };
    }

    it("queues the preview after the commit, with the message id only", async () => {
      const { enqueue, send } = sendHarness();

      await send({});

      const jobs = enqueue.mock.calls.map(([job]) => job as { name: string; payload: unknown });
      expect(jobs.at(-1)).toMatchObject({
        name: "link.preview",
        payload: { messageId: sentMessages()[0]!.id },
        maxAttempts: 1,
      });
      expect(JSON.stringify(jobs.at(-1))).not.toContain("example.test");
      expect(sentMessages()[0]!.payload.blocks).toEqual([
        { kind: "text", text: "see https://example.test/a" },
      ]);
    });

    it("writes the removal marker at creation and queues nothing for linkPreview: false", async () => {
      const { enqueue, send } = sendHarness();

      await send({ linkPreview: false });

      expect(sentMessages()[0]!.payload.blocks).toEqual([
        { kind: "text", text: "see https://example.test/a" },
        { kind: "link_preview", removed: true },
      ]);
      expect(enqueue.mock.calls.map(([job]) => (job as { name: string }).name)).not.toContain(
        "link.preview",
      );
    });

    it("sends the message even when the preview job cannot be queued", async () => {
      const enqueue = vi.fn(async (job: { name: string }) => {
        if (job.name === "link.preview") throw new Error("queue closed");
      });
      const { send } = sendHarness(enqueue as never);

      await expect(send({})).resolves.toBeDefined();
    });
  });

  it("rejects a new bot message while a run is waiting on a secret ask", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue(THREAD) },
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          askEntry("ask-msg-1", {
            kind: "ask",
            text: "Enter your one-time code",
            input: "secret",
            purpose: "otp",
            status: "pending",
          }),
        ),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "run-waiting", taskId: "task-1", status: "waiting_input" }]),
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1" }),
      },
      steeringMessage: { create: vi.fn() },
      task: { create: vi.fn(), updateMany: vi.fn() },
    };
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn() } as never,
          jobs: { enqueue: vi.fn() } as never,
        },
        actor,
        target,
        { text: "my password is hunter2", clientNonce: "nonce-secret-bot" },
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Answer the pending ask first.",
    });
    // The composer text must never be routed into a secret write or steered onto the run.
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
  });

  it("resolves a pending ask_user with the composer text instead of refusing the message", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue(THREAD) },
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          askEntry("ask-msg-1", {
            kind: "ask",
            text: "Which city?",
            status: "pending",
            input: "text",
          }),
        ),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "run-waiting", taskId: "task-1", status: "waiting_input" }]),
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1" }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: new Date() }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), create: vi.fn() },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        {
          text: "Lisbon, flexible dates",
          clientNonce: "nonce-ask",
        },
      ),
    ).resolves.toMatchObject({
      runId: "run-waiting",
      taskId: "task-1",
      runIds: ["run-waiting"],
    });

    // The card resolves in place — never a new run, never a steering message (threat model T6).
    expect(tx.run.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-waiting",
        spaceId: "workspace-1",
        threadId: "thread-1",
        status: "waiting_input",
      },
      data: { status: "queued", checkpoint: null },
    });
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(tx.run.findMany).toHaveBeenCalled();
    expect(appendCardStateInTransaction).toHaveBeenCalledWith(tx, {
      type: "card.answered",
      feedBotId: "bot-1",
      payload: { target: "ask-msg-1" },
    });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
  });

  it("rejects the send when the bot has another active run beside the pending ask_user", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue(THREAD) },
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          askEntry("ask-msg-1", {
            kind: "ask",
            text: "Which city?",
            status: "pending",
            input: "text",
          }),
        ),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-waiting", taskId: "task-1", status: "waiting_input" },
          { id: "run-takeover", taskId: "task-2", status: "waiting_takeover" },
        ]),
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1" }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: new Date() }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      steeringMessage: { create: vi.fn() },
      task: { create: vi.fn(), updateMany: vi.fn() },
    };
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn() } as never,
          jobs: { enqueue: vi.fn() } as never,
        },
        actor,
        target,
        { text: "Lisbon, flexible dates", clientNonce: "nonce-two-runs" },
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Answer the pending ask first.",
    });
    // The second run would be left neither steered nor rejected, so nothing may resolve.
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
  });

  it("carries the reply quote on the message that resolves a pending ask_user", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue(THREAD) },
      sessionEntry: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(parentEntry("ask-msg-1", { kind: "text", text: "Which city?" }))
          .mockResolvedValue(
            askEntry("ask-msg-1", {
              kind: "ask",
              text: "Which city?",
              status: "pending",
              input: "text",
            }),
          ),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "run-waiting", taskId: "task-1", status: "waiting_input" }]),
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-1" }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: new Date() }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), create: vi.fn() },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
        },
        actor,
        target,
        {
          text: "Lisbon",
          replyToMessageId: "ask-msg-1",
          replyQuote: "Which city?",
          clientNonce: "nonce-ask-quote",
        },
      ),
    ).resolves.toMatchObject({ runId: "run-waiting" });

    expect(sentMessages()[0]!.payload.replyTo).toEqual({
      entryId: "ask-msg-1",
      quote: "Which city?",
    });
  });

  it("resolves one bot's pending ask_user and steers another without a global throw", async () => {
    const tx = {
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue(THREAD) },
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          askEntry("ask-msg-a", {
            kind: "ask",
            text: "Which city?",
            status: "pending",
            input: "text",
          }),
        ),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-a-waiting", taskId: "task-a", botId: "bot-a", status: "waiting_input" },
          { id: "run-b-queued", taskId: "task-b", botId: "bot-b", status: "queued" },
        ]),
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-a" }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: new Date() }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn(),
      },
      task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), create: vi.fn() },
      steeringMessage: { create: vi.fn() },
      bot: everyBotUsable(),
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
    };
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      { text: "@everyone Kyoto works, keep going", clientNonce: "nonce-group-ask" },
    );

    // bot-a's ask resolves in place; bot-b, already queued, is steered — no CONFLICT anywhere.
    expect(result).toMatchObject({ runIds: ["run-a-waiting", "run-b-queued"] });
    expect(tx.run.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-a-waiting",
        spaceId: "workspace-1",
        threadId: "thread-1",
        status: "waiting_input",
      },
      data: { status: "queued", checkpoint: null },
    });
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: {
        messageId: sentMessages()[0]!.id,
        botId: "bot-b",
        userId: "user-1",
        runId: "run-b-queued",
      },
    });
    // Never a steering row for the resolved ask (threat model T6).
    expect(tx.steeringMessage.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ botId: "bot-a" }) }),
    );
    expect(tx.run.create).not.toHaveBeenCalled();
  });

  it("throws CONFLICT for the whole group send when a targeted bot has a secret ask pending", async () => {
    const tx = {
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue(THREAD) },
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          askEntry("ask-msg-a", {
            kind: "ask",
            text: "Enter your code",
            input: "secret",
            status: "pending",
          }),
        ),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-a-waiting", taskId: "task-a", botId: "bot-a", status: "waiting_input" },
          { id: "run-b-queued", taskId: "task-b", botId: "bot-b", status: "queued" },
        ]),
        findFirst: vi.fn().mockResolvedValue({ botId: "bot-a" }),
        updateMany: vi.fn(),
        create: vi.fn(),
      },
      task: { create: vi.fn(), updateMany: vi.fn() },
      steeringMessage: { create: vi.fn() },
      bot: everyBotUsable(),
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn(),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
    };
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn() } as never,
          jobs: { enqueue: vi.fn() } as never,
        },
        actor,
        target,
        { text: "@everyone here's the code", clientNonce: "nonce-group-secret" },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "Answer the pending ask first." });

    // The whole send aborts: bot-b never gets steered, bot-a's run is never touched.
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
  });

  it("steers a waiting-takeover run instead of refusing the message", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue(THREAD) },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "run-waiting", taskId: "task-1", status: "waiting_takeover" }]),
        findUnique: vi.fn().mockResolvedValue({
          status: "waiting_takeover",
          startedAt: new Date(),
        }),
      },
      steeringMessage: { create: vi.fn() },
      task: { create: vi.fn() },
    };
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
      bot: { computer: null },
    } as ThreadTarget;
    const enqueue = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        {
          text: "skip that",
          clientNonce: "nonce-takeover",
        },
      ),
    ).resolves.toMatchObject({
      runId: "run-waiting",
      taskId: "task-1",
      runIds: ["run-waiting"],
    });
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: {
        messageId: sentMessages()[0]!.id,
        botId: "bot-1",
        userId: "user-1",
        runId: "run-waiting",
      },
    });
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
  });
  it("rejects a quote excerpt without a reply target", async () => {
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    await expect(
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn() } as never,
          jobs: { enqueue: vi.fn() } as never,
        },
        actor,
        target,
        { text: "hi", replyQuote: "just this span", clientNonce: "nonce-1" },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("persists the quote excerpt alongside the reply target", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue(THREAD) },
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          parentEntry("parent", {
            kind: "text",
            text: "the parent says just this span inside it",
          }),
        ),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "parent",
        replyQuote: "just this span",
        clientNonce: "nonce-1",
      },
    );

    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(tx.sessionEntry.findFirst).toHaveBeenCalledWith({
      where: { id: "parent", session: { threadId: "thread-1", kind: "thread" } },
      select: { sessionId: true, runId: true, payload: true },
    });
    expect(sentMessages()[0]!.payload.replyTo).toEqual({
      entryId: "parent",
      quote: "just this span",
    });
  });

  it("drops a quote excerpt that doesn't match the parent's text", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue(THREAD) },
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          parentEntry("parent", {
            kind: "text",
            text: "the parent says something else entirely",
          }),
        ),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "parent",
        replyQuote: "words the parent never said",
        clientNonce: "nonce-1",
      },
    );

    // The send still lands as a plain reply — the fabricated excerpt is dropped.
    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(sentMessages()[0]!.payload.replyTo).toEqual({ entryId: "parent" });
  });

  it("accepts a quote excerpt that matches a routine's result", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue(THREAD) },
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue({
          id: "routine-start",
          sessionId: "session-1",
          runId: "run-routine",
          payload: {},
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "routine-end",
            sessionId: "session-1",
            seq: 2,
            parentId: "routine-start",
            type: "routine.finished",
            payload: {
              status: "completed",
              usage: { inputTokens: 10, outputTokens: 2 },
              result: "Two meetings today, then a long review.",
            },
            botId: "bot-1",
            runId: "run-routine",
            createdAt: new Date("2026-10-01T09:00:00.000Z"),
          },
        ]),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "which ones?",
        replyToMessageId: "routine-start",
        replyQuote: "a long review",
        clientNonce: "nonce-1",
      },
    );

    expect(sentMessages()[0]!.payload.replyTo).toEqual({
      entryId: "routine-start",
      quote: "a long review",
    });
  });

  it("accepts a quote excerpt that matches formatted parent text", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue(THREAD) },
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          // Rendered as "42% growth", stored with markdown source.
          parentEntry("parent", { kind: "text", text: "we saw **42%** growth last week" }),
        ),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "parent",
        replyQuote: "42% growth",
        clientNonce: "nonce-1",
      },
    );

    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(sentMessages()[0]!.payload.replyTo).toEqual({ entryId: "parent", quote: "42% growth" });
  });

  it.each([
    ["table cells", "| Name | Value |\n|:-----|------:|\n| Alice | 5 |", "Alice 5"],
    ["indented code", "    2. restart()", "2. restart()"],
    ["fenced code", "```text\n2. restart()\n```", "2. restart()"],
    ["lists after code fences", "```text\n1. code\n```\n1. First\n2. Second", "First\nSecond"],
    ["tab-indented code", "\t2. restart()", "2. restart()"],
    ["three-space lists", "   1. First\n   2. Second", "First\nSecond"],
    [
      "ordered list items",
      "1. Review the diff\n2. Run the tests",
      "Review the diff\nRun the tests",
    ],
    [
      "parenthesized list items",
      "1) Review the diff\n2) Run the tests",
      "Review the diff\nRun the tests",
    ],
    [
      "quoted list items",
      "> 1. Review the diff\n> 2. Run the tests",
      "Review the diff\nRun the tests",
    ],
  ])("accepts a quote excerpt spanning rendered %s", async (_name, parentText, replyQuote) => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue(THREAD) },
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          parentEntry("parent", {
            kind: "text",
            text: parentText,
          }),
        ),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "parent",
        replyQuote,
        clientNonce: "nonce-1",
      },
    );

    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(sentMessages()[0]!.payload.replyTo).toEqual({ entryId: "parent", quote: replyQuote });
  });

  it("drops a quote excerpt that only matches after stripping punctuation", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue(THREAD) },
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          parentEntry("parent", {
            kind: "text",
            text: "C++ is fast and key:value pairs; version 1.2 and 2. items\n    2. restart()\n```text\n1. alpha\n2. beta\n```\n~~~text\n1. gamma\n2. delta\n~~~\n```text\n> ```\n1. epsilon\n2. zeta\n```\n> ```text\n> > ```\n> 1. eta\n> 2. theta\n> ```\n# 1. heading\n# 2. another heading\n\n    > 1. literal\n    > 2. another literal",
          }),
        ),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      steeringMessage: { create: vi.fn() },
    };
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget;

    for (const replyQuote of [
      "C is fast",
      "key value pairs",
      "version 12",
      "and items",
      "3. restart()",
      "    3. restart()",
      "99. C++ is fast",
      "alpha\nbeta",
      "gamma\ndelta",
      "epsilon\nzeta",
      "eta\ntheta",
      "heading\nanother heading",
      "literal\nanother literal",
    ]) {
      await sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
        },
        actor,
        target,
        { text: "why this?", replyToMessageId: "parent", replyQuote },
      );
    }

    expect(sentMessages()).toHaveLength(13);
    for (const message of sentMessages()) {
      expect(message.payload.replyTo).toEqual({ entryId: "parent" });
    }
  });

  it("persists the quote excerpt on a group send", async () => {
    const tx = {
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue(THREAD) },
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(
          parentEntry("parent", {
            kind: "text",
            text: "the parent says just this span inside it",
          }),
        ),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi
          .fn()
          .mockResolvedValue({ id: "run-1", taskId: "task-1", botId: "bot-a", status: "queued" }),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
      steeringMessage: { create: vi.fn() },
      bot: everyBotUsable(),
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
    };
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "workspace-1", userId: "user-1" } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    const result = await sendThreadMessage(
      {
        prisma,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      actor,
      target,
      {
        text: "why this?",
        replyToMessageId: "parent",
        replyQuote: "just this span",
        clientNonce: "nonce-1",
      },
    );

    expect(result).toMatchObject({ runId: "run-1", taskId: "task-1" });
    expect(sentMessages()[0]!.payload.replyTo).toEqual({
      entryId: "parent",
      quote: "just this span",
    });
  });
});

describe("a group send runs as its sender", () => {
  const actor = { spaceId: "workspace-1", userId: "ana" } as Actor;
  const target = {
    kind: "group",
    groupId: "group-1",
    groupName: "Group",
    threadId: "thread-1",
    members: [],
    memberBotIds: ["bot-a", "bot-b"],
  } satisfies ThreadTarget;

  type ActiveRun = { id: string; taskId: string; botId: string; userId: string; status: string };
  type RunWhere = {
    id?: { in?: string[]; notIn?: string[] };
    botId?: { in: string[] };
    userId?: string;
    status?: string | { in: string[] };
  };

  /** A group whose lead is Beta, where the sender can use only `usable`, and `runs` are active. */
  function harness(usable: string[], runs: ActiveRun[] = []) {
    const matches = (run: ActiveRun, where: RunWhere) =>
      (!where.id?.in || where.id.in.includes(run.id)) &&
      !where.id?.notIn?.includes(run.id) &&
      (!where.botId || where.botId.in.includes(run.botId)) &&
      (!where.userId || where.userId === run.userId) &&
      (!where.status ||
        (typeof where.status === "string"
          ? where.status === run.status
          : where.status.in.includes(run.status)));
    const tx = {
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue(THREAD) },
      sessionEntry: { findFirst: vi.fn().mockResolvedValue(null) },
      run: {
        findMany: vi.fn(async ({ where }: { where: RunWhere }) =>
          runs.filter((run) => matches(run, where)),
        ),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
        create: vi.fn(async ({ data }: { data: { botId: string } }) => ({
          id: `run-${data.botId}`,
          taskId: "task-1",
          botId: data.botId,
          status: "queued",
        })),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      task: {
        create: vi.fn().mockResolvedValue({ id: "task-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      steeringMessage: { create: vi.fn() },
      bot: {
        findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.filter((id) => usable.includes(id)).map((id) => ({ id })),
        ),
      },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          leadBotId: "bot-b",
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
    };
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const send = (text: string) =>
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
        },
        actor,
        target,
        { text, clientNonce: "nonce-1" },
      );
    return { tx, send };
  }

  it("wakes the lead as the sender when the message names no bot", async () => {
    const { tx, send } = harness(["bot-a", "bot-b"]);

    await expect(send("hello all")).resolves.toMatchObject({ runIds: ["run-bot-b"] });
    expect(tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ botId: "bot-b", userId: "ana" }),
    });
  });

  it("leaves another person's runs, asks and queue alone, giving the sender runs of their own", async () => {
    const { tx, send } = harness(
      ["bot-a", "bot-b"],
      [
        {
          id: "alice-ask",
          taskId: "t-1",
          botId: "bot-b",
          userId: "alice",
          status: "waiting_input",
        },
        { id: "alice-queued", taskId: "t-2", botId: "bot-a", userId: "alice", status: "queued" },
      ],
    );

    await expect(send("@everyone what do you think?")).resolves.toMatchObject({
      runIds: ["run-bot-a", "run-bot-b"],
    });
    expect(tx.run.create).toHaveBeenCalledTimes(2);
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.sessionEntry.findFirst).not.toHaveBeenCalled();
  });

  it("stores a message naming no bot the sender can use, and wakes none", async () => {
    const { tx, send } = harness([]);

    await expect(send("@Alpha hello all")).resolves.toMatchObject({
      runId: undefined,
      runIds: [],
    });
    expect(sentMessages()).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ authorId: "ana", targets: [] }),
      }),
    ]);
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
  });
});

describe("stopThreadRuns", () => {
  it("snapshots every lease when group members share a team computer", async () => {
    const releaseScreen = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn(async function* () {
      yield { type: "exit", code: 0 };
    });
    const transaction = {
      $queryRaw: vi.fn(),
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-a", botId: "bot-a" },
          { id: "run-b", botId: "bot-b" },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      steeringMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computer: {
        // Production team ownership is lease-only: Computer.executionRunId stays null.
        findMany: vi.fn().mockImplementation(async ({ where }: { where: { OR?: unknown[] } }) => {
          expect(where.OR).toEqual(
            expect.arrayContaining([
              { id: { in: ["computer-db-team"] } },
              { executionRunId: { in: ["run-a", "run-b"] } },
            ]),
          );
          return [
            {
              id: "computer-db-team",
              homeKey: "home-team",
              kind: "fake",
              providerRef: "computer-team",
              executionBotId: null,
              executionRunId: null,
            },
          ];
        }),
      },
      computerExecutionLease: {
        findMany: vi.fn().mockResolvedValue([
          { computerId: "computer-db-team", botId: "bot-a", runId: "run-a", fence: 2 },
          { computerId: "computer-db-team", botId: "bot-b", runId: "run-b", fence: 4 },
        ]),
      },
    };
    const prisma = {
      run: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      bot: {
        update: vi.fn(async ({ where }: { where: { id: string } }) => ({
          spaceId: "workspace-1",
          thread: { id: `thread-of-${where.id}` },
          computer: { state: "running" },
        })),
      },
      // Simulate workers clearing leases / execution columns as soon as the
      // transaction commits. A post-commit lookup would now miss both sandboxes.
      computer: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      computerExecutionLease: {
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      event: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaClient;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
    } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Test group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    const append = vi.fn().mockResolvedValue({});
    await stopThreadRuns(
      {
        prisma,
        sandbox: { releaseScreen, execute } as unknown as SandboxProvider,
        events: { append } as unknown as ThreadEvents,
      },
      actor,
      target,
    );

    expect(transaction.computerExecutionLease.findMany).toHaveBeenCalledWith({
      where: { runId: { in: ["run-a", "run-b"] } },
      select: { computerId: true, botId: true, runId: true, fence: true },
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-team" }),
      expect.objectContaining({
        argv: expect.arrayContaining(["tangow-cancel-run-work", "computer-db-team", "run-a"]),
      }),
      expect.objectContaining({ cancelRunWork: true, runId: "run-a", botId: "bot-a" }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-team" }),
      expect.objectContaining({
        argv: expect.arrayContaining(["tangow-cancel-run-work", "computer-db-team", "run-b"]),
      }),
      expect.objectContaining({ cancelRunWork: true, runId: "run-b", botId: "bot-b" }),
    );
    expect(releaseScreen).toHaveBeenCalledTimes(2);
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-team" }),
      expect.objectContaining({
        spaceId: "workspace-1",
        userId: "user-1",
        botId: "bot-a",
        cancelRunWork: true,
        runId: "run-a",
        screenLeaseId: "run-a:2",
      }),
    );
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-team" }),
      expect.objectContaining({
        spaceId: "workspace-1",
        userId: "user-1",
        botId: "bot-b",
        cancelRunWork: true,
        runId: "run-b",
        screenLeaseId: "run-b:4",
      }),
    );
    expect(append.mock.calls).toEqual([
      [
        {
          spaceId: "workspace-1",
          threadId: "thread-of-bot-a",
          botId: "bot-a",
          type: "computer.status",
          payload: { status: "running" },
        },
      ],
      [
        {
          spaceId: "workspace-1",
          threadId: "thread-of-bot-b",
          botId: "bot-b",
          type: "computer.status",
          payload: { status: "running" },
        },
      ],
    ]);
    expect(prisma.computer.findMany).not.toHaveBeenCalled();
    expect(prisma.computerExecutionLease.updateMany).toHaveBeenCalledWith({
      where: { runId: { in: ["run-a", "run-b"] } },
      data: { expiresAt: new Date(0) },
    });
    expect(prisma.computer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { executionRunId: { in: ["run-a", "run-b"] } } }),
    );
  });

  it("does not tear down a stale legacy execution run when the lease owns a cancelled run", async () => {
    const releaseScreen = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn(async function* () {
      yield { type: "exit", code: 0 };
    });
    const transaction = {
      $queryRaw: vi.fn(),
      run: {
        findMany: vi.fn().mockResolvedValue([{ id: "run-a", botId: "bot-a" }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      steeringMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computer: {
        // Selected via lease for cancelled run A, but legacy columns still name
        // unrelated live run B. Legacy teardown must not cancel/release B.
        findMany: vi.fn().mockResolvedValue([
          {
            id: "computer-db-a",
            homeKey: "home-a",
            kind: "fake",
            providerRef: "computer-a",
            executionBotId: "bot-b",
            executionRunId: "run-b",
          },
        ]),
      },
      computerExecutionLease: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { computerId: "computer-db-a", botId: "bot-a", runId: "run-a", fence: 2 },
          ]),
      },
    };
    const prisma = {
      run: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      bot: {
        update: vi.fn(async ({ where }: { where: { id: string } }) => ({
          spaceId: "workspace-1",
          thread: { id: `thread-of-${where.id}` },
          computer: { state: "running" },
        })),
      },
      computer: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      computerExecutionLease: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      event: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaClient;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
    } as Actor;
    const target = {
      kind: "group",
      groupId: "group-1",
      groupName: "Test group",
      threadId: "thread-1",
      members: [],
      memberBotIds: ["bot-a", "bot-b"],
    } satisfies ThreadTarget;

    const append = vi.fn().mockResolvedValue({});
    await stopThreadRuns(
      {
        prisma,
        sandbox: { releaseScreen, execute } as unknown as SandboxProvider,
        events: { append } as unknown as ThreadEvents,
      },
      actor,
      target,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-a" }),
      expect.objectContaining({
        argv: expect.arrayContaining(["tangow-cancel-run-work", "computer-db-a", "run-a"]),
      }),
      expect.objectContaining({ cancelRunWork: true, runId: "run-a", botId: "bot-a" }),
    );
    expect(execute).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        argv: expect.arrayContaining(["tangow-cancel-run-work", "computer-db-a", "run-b"]),
      }),
      expect.anything(),
    );
    expect(releaseScreen).toHaveBeenCalledTimes(1);
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "computer-a" }),
      expect.objectContaining({
        botId: "bot-a",
        runId: "run-a",
        screenLeaseId: "run-a:2",
      }),
    );
    expect(releaseScreen).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId: "run-b" }),
    );
  });
});

describe("sendThreadMessage while a proposal card waits", () => {
  const card = {
    kind: "ask",
    approvalEffectId: "effect-1",
    proposal: "routine",
    text: "Je m'en occupe chaque lundi ?",
    detail: "name: Weekly offers",
    status: "pending",
    actions: [
      { id: "allow", label: "Create routine", outcome: "created" },
      { id: "deny", label: "Not now", outcome: "cancelled" },
    ],
  };
  const mailDraft = {
    id: "effect-1",
    kind: "GMAIL_SEND_EMAIL",
    status: "intended",
    request: { recipient_email: "a@example.com", body: "Hello from Chief." },
    draft: { state: "pending", path: ["body"], proposed: "Hello from Chief." },
  };
  function proposalTx(
    options: { kind?: string; runStatus?: string; effect?: Record<string, unknown> } = {},
  ) {
    return {
      $queryRaw: vi.fn().mockResolvedValue([]),
      thread: { findUniqueOrThrow: vi.fn().mockResolvedValue(THREAD) },
      sessionEntry: {
        findFirst: vi.fn().mockResolvedValue(askEntry("card-msg", card)),
      },
      run: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "run-waiting", taskId: "task-1", status: "waiting_input" }]),
        findFirst: vi.fn().mockResolvedValue({
          botId: "bot-1",
          userId: "user-1",
          status: options.runStatus ?? "waiting_input",
        }),
        findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: new Date() }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      externalEffect: {
        findFirst: vi.fn().mockResolvedValue(
          options.effect ?? {
            id: "effect-1",
            kind: options.kind ?? "routine_proposal",
            status: "intended",
          },
        ),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      steeringMessage: { create: vi.fn() },
      task: { create: vi.fn(), updateMany: vi.fn() },
    };
  }
  const send = (tx: ReturnType<typeof proposalTx>, draft?: { messageId: string; text: string }) =>
    sendThreadMessage(
      {
        prisma: {
          $queryRaw: vi.fn().mockResolvedValue([]),
          $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
        } as unknown as PrismaClient,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      { spaceId: "workspace-1", userId: "user-1" } as Actor,
      {
        kind: "bot",
        botId: "bot-1",
        threadId: "thread-1",
        bot: { computer: null },
      } as ThreadTarget,
      { text: "Plutôt le mardi", clientNonce: "nonce-dismiss", draft },
    );

  it("puts the card away and steers the reply into the run it resumes", async () => {
    const tx = proposalTx();
    await expect(send(tx)).resolves.toMatchObject({
      runId: "run-waiting",
      runIds: ["run-waiting"],
    });
    expect(tx.externalEffect.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "denied" }) }),
    );
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: {
        messageId: sentMessages()[0]!.id,
        botId: "bot-1",
        userId: "user-1",
        runId: "run-waiting",
      },
    });
    expect(appendSessionEntryInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        type: "effect.resolved",
        runId: "run-waiting",
        payload: { effectId: "effect-1", decision: "denied", dismissed: true },
      }),
    );
    expect(tx.task.updateMany).not.toHaveBeenCalled();
  });

  it("steers the reply when a Create tap resumed the run first", async () => {
    const tx = proposalTx({ runStatus: "queued" });
    await expect(send(tx)).resolves.toMatchObject({ runIds: ["run-waiting"] });
    expect(tx.externalEffect.updateMany).not.toHaveBeenCalled();
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: {
        messageId: sentMessages()[0]!.id,
        botId: "bot-1",
        userId: "user-1",
        runId: "run-waiting",
      },
    });
  });

  it("replaces a waiting draft, steering the reply with the text the user left on it", async () => {
    const tx = proposalTx({ effect: mailDraft });
    await expect(
      send(tx, { messageId: "card-msg", text: "Hello, edited." }),
    ).resolves.toMatchObject({ runIds: ["run-waiting"] });
    expect(tx.externalEffect.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "denied",
          request: { recipient_email: "a@example.com", body: "Hello, edited." },
        }),
      }),
    );
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        runId: "run-waiting",
      }),
    });
  });

  it("steers the reply and drops the draft's text when a Send resumed the run first", async () => {
    const tx = proposalTx({
      runStatus: "queued",
      effect: {
        ...mailDraft,
        status: "approved",
        draft: { ...mailDraft.draft, state: "approved" },
      },
    });
    await expect(
      send(tx, { messageId: "card-msg", text: "Hello, edited." }),
    ).resolves.toMatchObject({ runIds: ["run-waiting"] });
    expect(tx.externalEffect.updateMany).not.toHaveBeenCalled();
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: {
        messageId: sentMessages()[0]!.id,
        botId: "bot-1",
        userId: "user-1",
        runId: "run-waiting",
      },
    });
  });

  it("refuses a draft's text sent over a card that is not a draft, sending nothing", async () => {
    const tx = proposalTx();
    await expect(send(tx, { messageId: "card-msg", text: "Hello" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This draft is no longer waiting.",
    });
    expect(tx.externalEffect.updateMany).not.toHaveBeenCalled();
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
  });

  /** The same waiting run, its bot the one member of a group the reply is sent to. */
  function groupSend(
    tx: ReturnType<typeof proposalTx>,
    draft?: { messageId: string; text: string },
  ) {
    tx.run.findMany.mockResolvedValue([
      { id: "run-waiting", taskId: "task-1", botId: "bot-1", status: "waiting_input" },
    ]);
    tx.$queryRaw.mockResolvedValue([{ id: "group-1" }]);
    const group = Object.assign(tx, {
      bot: everyBotUsable(),
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          members: [{ bot: { id: "bot-1", name: "Alpha", color: null } }],
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
      },
    });
    return sendThreadMessage(
      {
        prisma: {
          $queryRaw: vi.fn().mockResolvedValue([]),
          $transaction: vi.fn(async (callback: (client: typeof group) => unknown) =>
            callback(group),
          ),
        } as unknown as PrismaClient,
        events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
        jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
      },
      { spaceId: "workspace-1", userId: "user-1" } as Actor,
      {
        kind: "group",
        groupId: "group-1",
        groupName: "Group",
        threadId: "thread-1",
        members: [],
        memberBotIds: ["bot-1"],
      } satisfies ThreadTarget,
      { text: "Make it shorter.", clientNonce: "nonce-group-draft", draft },
    );
  }

  it("replaces a waiting draft in a group as in the bot's own thread", async () => {
    const tx = proposalTx({ effect: mailDraft });
    await expect(
      groupSend(tx, { messageId: "card-msg", text: "Hello, edited." }),
    ).resolves.toMatchObject({ runIds: ["run-waiting"] });
    expect(tx.externalEffect.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "denied",
          request: { recipient_email: "a@example.com", body: "Hello, edited." },
        }),
      }),
    );
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        botId: "bot-1",
        runId: "run-waiting",
      }),
    });
  });

  it("refuses a group reply a draft's text came with for a card that is gone", async () => {
    const tx = proposalTx({ effect: mailDraft });
    await expect(
      groupSend(tx, { messageId: "entry-stale", text: "Hello, edited." }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(tx.externalEffect.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a group reply whose draft's text names a card of a bot it does not reach", async () => {
    const tx = proposalTx({ effect: mailDraft });
    tx.$queryRaw.mockResolvedValue([{ id: "group-1" }]);
    tx.run.findMany.mockResolvedValue([]);
    const run = { id: "run-beta", taskId: "task-beta", botId: "bot-2", status: "queued" };
    const group = Object.assign(tx, {
      bot: everyBotUsable(),
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          members: [
            { bot: { id: "bot-1", name: "Alpha", color: null } },
            { bot: { id: "bot-2", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn().mockResolvedValue({ id: "group-1" }),
      },
    });
    group.task.create.mockResolvedValue({ id: "task-beta" });
    Object.assign(group.run, { create: vi.fn().mockResolvedValue(run) });
    await expect(
      sendThreadMessage(
        {
          prisma: {
            $queryRaw: vi.fn().mockResolvedValue([]),
            $transaction: vi.fn(async (callback: (client: typeof group) => unknown) =>
              callback(group),
            ),
          } as unknown as PrismaClient,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
        },
        { spaceId: "workspace-1", userId: "user-1" } as Actor,
        {
          kind: "group",
          groupId: "group-1",
          groupName: "Group",
          threadId: "thread-1",
          members: [],
          memberBotIds: ["bot-1", "bot-2"],
        } satisfies ThreadTarget,
        {
          text: "Beta, take a look.",
          mentions: ["bot-2"],
          clientNonce: "nonce-group-other",
          draft: { messageId: "card-msg", text: "Hello, edited." },
        },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "This draft is no longer waiting." });
    expect(tx.externalEffect.updateMany).not.toHaveBeenCalled();
  });

  it("still asks to answer a routine proposal first in a group", async () => {
    const tx = proposalTx();
    await expect(groupSend(tx)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Answer the pending ask first.",
    });
    expect(tx.externalEffect.updateMany).not.toHaveBeenCalled();
  });

  it("still asks to answer a Create bot card first", async () => {
    const tx = proposalTx({ kind: "spawn_bot" });
    await expect(send(tx)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Answer the pending ask first.",
    });
    expect(tx.externalEffect.updateMany).not.toHaveBeenCalled();
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
  });
});

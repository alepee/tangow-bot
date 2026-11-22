import { ORPCError } from "@orpc/server";
import type { JobPublisher, SandboxProvider, SessionLog } from "@tangow/adapter-kit";
import { linkPreviewJob, runContinueJob } from "@tangow/adapter-kit";
import {
  cancelComputerRunWork,
  recoverBrowserApprovalScreens,
  releaseBotScreen,
  screenLeaseIdForRun,
  toComputerRef,
} from "@tangow/adapters";
import type { SessionEntries } from "@tangow/contracts";
import {
  type Actor,
  botDisplayColor,
  GROUP_MEMBER_MIN,
  type GroupMember,
  type MessageBlock,
  type MessageReaction,
  REPLY_QUOTE_MAX_LENGTH,
  type RunStatus,
  type SessionId,
  type ThreadSnapshot,
} from "@tangow/contracts";
import {
  ACTIVE_RUN_STATUSES,
  blocksToAgentHistoryText,
  groupLeadBotId,
  isActive,
  resolveGroupTargetBotIds,
  routineResultBlocks,
  runFailureError,
} from "@tangow/core";
import type { DraftLeft } from "@tangow/db";
import {
  blocksOf,
  browserApprovalCheckpointOf,
  conversationRunFilter,
  createGroupRepos,
  createRepos,
  createThreadMessageInTransaction,
  dismissProposalWithTextInTransaction,
  expireComputerExecutionLeases,
  groupMembershipFilter,
  groupThreadPeople,
  IsolationError,
  lockGroupForPerson,
  logCancelledRunsInTransaction,
  type Prisma,
  type PrismaClient,
  progressSinceLastEntry,
  resumeAskWithComposerTextInTransaction,
  runsOfMessage,
  sessionEntryFromRow,
  sharedBotThread,
  type ThreadEvents,
  threadEntryByNonce,
  threadEventSeq,
  threadOfSession,
  touchGroupUpdatedAt,
  usableBotIds,
} from "@tangow/db";
import { getLogger } from "@tangow/logging";
import {
  buildSendPrompt,
  buildUserMessageBlocks,
  resolveGroupSendAttachments,
  resolveSendAttachments,
} from "./artifacts.js";
import { readCappedRun } from "./bot-activity.js";
import {
  computerSeenBy,
  currentComputerRelease,
  resolveBusyBotName,
  toComputerStatus,
} from "./computer-status.js";
import { withSerializableRetry } from "./serializable-retry.js";
import { loadEntryPage, threadSessionId, withoutHiddenPeerRuns } from "./thread-message-pages.js";

export type ThreadTarget =
  | {
      kind: "bot";
      botId: string;
      threadId: string;
      bot: Awaited<ReturnType<ReturnType<typeof createRepos>["getBot"]>>;
    }
  | {
      kind: "group";
      groupId: string;
      threadId: string;
      groupName: string;
      members: GroupMember[];
      memberBotIds: string[];
    };

/**
 * Flatten text for excerpt comparison. The parent blocks hold markdown
 * source while the selection captures rendered text, so structural syntax
 * is normalized away: table delimiters and alignment rows, list markers,
 * heading and blockquote markers, link targets, emphasis characters.
 * Semantic punctuation (: + - . ! #) stays on both sides — otherwise
 * "C++ is fast" would accept a fabricated "C is fast".
 */
function flattenForQuoteMatch(text: string, markdownSource = false): string {
  let fence: { marker: string; quoteDepth: number } | undefined;
  return text
    .split("\n")
    .filter((line) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(line))
    .map((line) => {
      const normalized = line
        .replace(/^\s*(?:>\s*)+/, "")
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/^\s*[-*+•]\s+/, "");
      if (!markdownSource) return normalized;
      if (fence) {
        let boundary = line;
        const quoteDepth = fence.quoteDepth;
        for (let depth = 0; depth < quoteDepth; depth++) {
          const prefix = /^ {0,3}>[ \t]?/.exec(boundary)?.[0];
          if (!prefix) {
            fence = undefined;
            break;
          }
          boundary = boundary.slice(prefix.length);
        }
        if (fence) {
          const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(boundary)?.[1];
          if (closing && closing[0] === fence.marker[0] && closing.length >= fence.marker.length) {
            fence = undefined;
          }
          return normalized;
        }
      }
      let source = line;
      let quoteDepth = 0;
      for (
        let prefix = /^ {0,3}>[ \t]?/.exec(source)?.[0];
        prefix;
        prefix = /^ {0,3}>[ \t]?/.exec(source)?.[0]
      ) {
        source = source.slice(prefix.length);
        quoteDepth++;
      }
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(source);
      const marker = match?.[1];
      const suffix = match?.[2] ?? "";
      if (marker && (marker[0] !== "`" || !suffix.includes("`"))) {
        fence = { marker, quoteDepth };
        return normalized;
      }
      // Test source syntax before stripping headings or other visible containers.
      return /^ {0,3}\d{1,9}[.)][ \t]+/.test(source)
        ? normalized.replace(/^ {0,3}\d{1,9}[.)][ \t]+/, "")
        : normalized;
    })
    .join(" ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .toLowerCase()
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[\\`*_~|[\]()•]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A peer (`bot_message`) run is hidden work, not absent work: its messages and live events stay
 * out of the recipient's own chat, but the bot really is busy, and a chat that shows nothing at
 * all looks dead while a peer waits on it. So active peer runs count for the busy indicator and
 * `isPeerRunRow` only silences their event stream.
 */
function isPeerRunRow(run: { trigger: string }): boolean {
  return run.trigger === "bot_message";
}

/** The blocks of the message a reply targets in the thread: a person's, a bot's whole run, or a routine's result. */
async function repliedBlocks(
  tx: Prisma.TransactionClient,
  threadId: string,
  entryId: string,
): Promise<MessageBlock[] | null> {
  const target = await tx.sessionEntry.findFirst({
    where: { id: entryId, session: { threadId, kind: "thread" } },
    select: { sessionId: true, runId: true, payload: true },
  });
  if (!target) return null;
  if (!target.runId) return blocksOf(target);
  const run = await tx.sessionEntry.findMany({
    where: {
      sessionId: target.sessionId,
      runId: target.runId,
      type: { in: ["assistant.text", "routine.finished"] },
    },
    orderBy: { seq: "asc" },
  });
  return run.flatMap((row) => {
    if (row.type !== "routine.finished") return blocksOf(row);
    const entry = sessionEntryFromRow(row);
    return entry.type === "routine.finished" ? routineResultBlocks(entry.payload) : [];
  });
}

function quoteAppearsInBlocks(quote: string, blocks: MessageBlock[]): boolean {
  const excerpt = flattenForQuoteMatch(quote);
  if (!excerpt) return false;
  const parent = blocksToAgentHistoryText(blocks);
  // Keep existing matches (including visible numbering in code) before removing list syntax.
  return (
    flattenForQuoteMatch(parent).includes(excerpt) ||
    flattenForQuoteMatch(parent, true).includes(excerpt)
  );
}

const RUNS_NEEDING_CONTINUE = new Set(["queued", "waiting_takeover"]);

const STEERABLE_RUN_STATUSES = new Set(["queued", "leased", "running", "waiting_takeover"]);

type MentionTargetInput = string | { kind: "bot" | "group" | "routine" | "connector"; id: string };

function splitMentionTargets(mentions: MentionTargetInput[] | undefined) {
  const botMentionIds = new Set<string>();
  const groupMentionIds = new Set<string>();
  const routineMentionIds = new Set<string>();
  const connectorMentionIds = new Set<string>();
  for (const mention of mentions ?? []) {
    if (typeof mention === "string") {
      botMentionIds.add(mention);
      continue;
    }
    if (mention.kind === "bot") botMentionIds.add(mention.id);
    if (mention.kind === "group") groupMentionIds.add(mention.id);
    if (mention.kind === "routine") routineMentionIds.add(mention.id);
    if (mention.kind === "connector") connectorMentionIds.add(mention.id);
  }
  return {
    botMentionIds: [...botMentionIds],
    groupMentionIds: [...groupMentionIds],
    routineMentionIds: [...routineMentionIds],
    connectorMentionIds: [...connectorMentionIds],
  };
}

async function resolveOwnedConnectorDisplayNames(
  tx: Prisma.TransactionClient,
  actor: Actor,
  connectionIds: string[],
) {
  if (!connectionIds.length) return [];
  const rows = await tx.connection.findMany({
    where: {
      id: { in: connectionIds },
      spaceId: actor.spaceId,
      userId: actor.userId,
      status: "connected",
    },
    select: { id: true, displayName: true },
  });
  if (rows.length !== connectionIds.length) throw new IsolationError();
  const byId = new Map(rows.map((row) => [row.id, row.displayName]));
  return connectionIds.map((id) => byId.get(id) ?? "connector");
}

/** Names of the groups a message mentions, each one the sender is a person in. */
async function resolveMentionedGroupNames(
  tx: Prisma.TransactionClient,
  actor: Actor,
  groupIds: string[],
) {
  if (!groupIds.length) return [];
  const rows = await tx.chatGroup.findMany({
    where: { id: { in: groupIds }, ...groupMembershipFilter(actor.userId, actor.spaceId) },
    select: { id: true, name: true },
  });
  if (rows.length !== groupIds.length) throw new IsolationError();
  const byId = new Map(rows.map((row) => [row.id, row.name]));
  return groupIds.map((id) => byId.get(id) ?? "group");
}

function sendRunClientNonce(
  clientNonce: string | undefined,
  messageId: string,
  botId?: string,
): string | undefined {
  if (!clientNonce) return undefined;
  return botId ? `send:${messageId}:${botId}` : `send:${messageId}`;
}

async function enqueueRunsNeedingContinue(
  jobs: JobPublisher,
  runs: Array<{ id: string; status: string }>,
) {
  await Promise.all(
    runs
      .filter((run) => RUNS_NEEDING_CONTINUE.has(run.status))
      .map((run) =>
        jobs.enqueue(runContinueJob(run.id)).catch((error) => {
          // The queued run is durable; the reconciler repairs a missed immediate wake.
          getLogger().error("thread send enqueue", error);
        }),
      ),
  );
}

async function replayExistingSend(
  deps: { prisma: PrismaClient; events: ThreadEvents; jobs: JobPublisher },
  threadId: string,
  clientNonce: string | undefined,
) {
  if (!clientNonce) return null;
  const message = await threadEntryByNonce(deps.prisma, threadId, clientNonce);
  if (!message) return null;
  const { created, steered, answered } = await runsOfMessage(deps.prisma, message);
  // In the order the send dispatched its targets, which the message records, as the send answered.
  const targets = message.type === "user.message" ? (message.payload.targets ?? []) : [];
  const order = (botId: string) => {
    const index = targets.indexOf(botId);
    return index === -1 ? targets.length : index;
  };
  const runs = [...created, ...steered, ...answered].toSorted(
    (a, b) => order(a.botId) - order(b.botId),
  );
  // A group message that woke no bot records no target, and answers with no run.
  const wokeNoBot = message.type === "user.message" && message.payload.targets?.length === 0;
  if (runs.length === 0 && !wokeNoBot) return null;
  await enqueueRunsNeedingContinue(deps.jobs, runs);
  await deps.events.notify(threadId, await threadEventSeq(deps.prisma, threadId)).catch((error) => {
    // Subscribers catch up from the durable event cursor after a missed realtime wake.
    getLogger().error("thread send realtime notification", error);
  });
  return sendResult(message, runs);
}

function sendResult(message: { seq: number }, runs: ReadonlyArray<{ id: string; taskId: string }>) {
  const first = runs[0];
  return {
    taskId: first?.taskId,
    runId: first?.id,
    seq: message.seq,
    runIds: runs.map((run) => run.id),
  };
}

/**
 * The active runs a new message may be steered into. A run that reports only through its
 * routine card stays out: it still answers its own ask from the composer, but a message that
 * would otherwise steer it starts a run of its own, whose reply reaches the conversation.
 */
async function findConversationRunIds(
  tx: Prisma.TransactionClient,
  activeRuns: ReadonlyArray<{ id: string }>,
): Promise<Set<string>> {
  if (activeRuns.length === 0) return new Set();
  const rows = await tx.run.findMany({
    where: { id: { in: activeRuns.map((run) => run.id) }, ...conversationRunFilter },
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}

/** A new message supersedes its sender's own queued runs, never another person's in a group. */
export async function cancelSupersededQueuedRuns(
  tx: Prisma.TransactionClient,
  input: { threadId: string; botIds: string[]; userId: string; keepRunIds: string[] },
) {
  const superseded = await tx.run.findMany({
    where: {
      threadId: input.threadId,
      botId: { in: input.botIds },
      userId: input.userId,
      status: "queued",
      OR: [{ trigger: "user", sourceMessage: { type: "user.message" } }, { trigger: "reaction" }],
      id: { notIn: input.keepRunIds },
    },
    select: { id: true, taskId: true },
  });
  if (superseded.length === 0) return;
  const now = new Date();
  await tx.run.updateMany({
    where: { id: { in: superseded.map((run) => run.id) } },
    data: { status: "cancelled", completedAt: now },
  });
  await tx.task.updateMany({
    where: { id: { in: superseded.map((run) => run.taskId) } },
    data: { status: "cancelled" },
  });
}

async function lockAndLoadGroupMembers(
  tx: Prisma.TransactionClient,
  actor: Actor,
  target: Extract<ThreadTarget, { kind: "group" }>,
) {
  await lockGroupForPerson(tx, actor, target.groupId);
  const group = await tx.chatGroup.findFirst({
    where: { id: target.groupId, archivedAt: null, thread: { id: target.threadId } },
    include: {
      members: {
        where: { bot: { archivedAt: null } },
        include: { bot: { select: { id: true, name: true, color: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!group || group.members.length < GROUP_MEMBER_MIN) throw new IsolationError();
  const members = group.members.map((member) => ({
    botId: member.bot.id,
    name: member.bot.name,
    color: member.bot.color,
  }));
  return {
    members,
    leadBotId: group.leadBotId,
    usableBotIds: await usableBotIds(
      tx,
      actor.userId,
      actor.spaceId,
      members.map((member) => member.botId),
    ),
  };
}

export async function resolveThreadTarget(
  prisma: PrismaClient,
  actor: Actor,
  input: { botId?: string; groupId?: string },
): Promise<ThreadTarget> {
  const repos = createRepos(prisma);
  const groupRepos = createGroupRepos(prisma);
  if (input.botId) {
    const owned = await repos.getBot(actor, input.botId).catch((error: unknown) => {
      if (error instanceof IsolationError) return null;
      throw error;
    });
    if (owned) {
      if (!owned.thread) throw new IsolationError();
      return { kind: "bot", botId: owned.id, threadId: owned.thread.id, bot: owned };
    }
    // A bot shared with the actor: their own thread with it, never the owner's.
    const shared = await sharedBotThread(prisma, actor, input.botId);
    if (!shared) throw new IsolationError();
    return {
      kind: "bot",
      botId: shared.bot.id,
      threadId: shared.thread.id,
      bot: { ...shared.bot, thread: shared.thread },
    };
  }
  if (input.groupId) {
    const group = await groupRepos.getGroupTarget(actor, input.groupId);
    if (!group.thread) throw new IsolationError();
    const usable = await usableBotIds(
      prisma,
      actor.userId,
      actor.spaceId,
      group.members.map((member) => member.bot.id),
    );
    const members = group.members.map((member) => ({
      botId: member.bot.id,
      name: member.bot.name,
      color: botDisplayColor(member.bot),
      shapeSeed: member.bot.shapeSeed,
      avatarCharacter: member.bot.avatarCharacter,
      status: member.bot.runs[0]?.status ?? "idle",
      canUse: usable.has(member.bot.id),
    }));
    return {
      kind: "group",
      groupId: group.id,
      threadId: group.thread.id,
      groupName: group.name,
      members,
      memberBotIds: members.map((member) => member.botId),
    };
  }
  throw new IsolationError();
}

/** A child session reads as its run: its trace joined with what rose to the thread. */
export async function readSessionEntries(
  deps: { prisma: PrismaClient; sessionLog: Pick<SessionLog<unknown>, "readRun"> },
  actor: Actor,
  sessionId: SessionId,
): Promise<SessionEntries> {
  const [threadId, run] = await Promise.all([
    threadOfSession(deps.prisma, sessionId, actor.spaceId),
    deps.prisma.run.findFirst({
      where: { sessionId, session: { kind: { not: "thread" } } },
      select: { id: true, userId: true },
    }),
  ]);
  const thread = threadId
    ? await deps.prisma.thread.findUnique({
        where: { id: threadId },
        select: { botId: true, memberBotId: true, groupId: true },
      })
    : null;
  if (!thread) throw new IsolationError();
  const target = await resolveThreadTarget(deps.prisma, actor, {
    botId: thread.botId ?? thread.memberBotId ?? undefined,
    groupId: thread.groupId ?? undefined,
  });
  // A shared bot has a thread per person: reaching the bot is not reaching this one.
  if (target.threadId !== threadId) throw new IsolationError();
  // In a group, a run's trace is its person's alone, as with runs.entries: it ran with their
  // accounts.
  if (!run || (target.kind === "group" && run.userId !== actor.userId)) {
    throw new IsolationError();
  }
  return readCappedRun(deps.sessionLog, run.id);
}

export async function threadHead(prisma: PrismaClient, target: ThreadTarget) {
  const latest = await prisma.event.findFirst({
    where: { threadId: target.threadId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  return { threadId: target.threadId, cursor: latest?.seq ?? -1 };
}

/**
 * The cursor, the tail page and the progress to replay are read under the thread's share lock,
 * which every append takes for update, so no entry lands between them and the replayed progress
 * never repeats text the page already holds. Hidden peer runs are filtered out after commit.
 */
export async function threadSnapshot(
  deps: {
    prisma: PrismaClient;
    sessionLog: Pick<SessionLog<Prisma.TransactionClient>, "readPage" | "readAround">;
    sandbox?: SandboxProvider;
  },
  target: ThreadTarget,
): Promise<ThreadSnapshot> {
  if (target.kind === "bot") {
    // Whose thread this is: the owner's, or a member's own thread with a shared bot.
    const viewerId = target.bot.thread?.userId ?? target.bot.userId;
    const [busyBotName, seen, core] = await Promise.all([
      resolveBusyBotName(deps.prisma, {
        computerId: target.bot.computer?.id,
        botId: target.botId,
        botName: target.bot.name,
        userId: viewerId,
      }),
      computerSeenBy(deps.prisma, target.bot, viewerId),
      deps.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR SHARE`;
        const [sessionId, last, waitingRun, busyOrFailed] = await Promise.all([
          threadSessionId(tx, target.threadId),
          tx.event.findFirst({
            where: { threadId: target.threadId },
            orderBy: { seq: "desc" },
            select: { seq: true },
          }),
          // Waiting asks win over a concurrent busy run (including peer bot_message).
          tx.run.findFirst({
            where: {
              botId: target.botId,
              threadId: target.threadId,
              status: { in: ["waiting_input", "waiting_takeover"] },
              // A helper waiting on its parent waits on no one the person sees.
              parentRunId: null,
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          }),
          tx.run.findFirst({
            where: {
              botId: target.botId,
              threadId: target.threadId,
              parentRunId: null,
              // A busy peer run drives the working indicator; a failed one stays hidden, since
              // that failure belongs to the bot that ordered the work and would otherwise bury a
              // user-visible failure in the composer error strip.
              OR: [
                { status: { in: [...ACTIVE_RUN_STATUSES] } },
                { trigger: { not: "bot_message" }, status: "failed" },
              ],
            },
            // The id tiebreak keeps ordering deterministic under equal
            // timestamps, matching the supersession probe below.
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          }),
        ]);
        const run = waitingRun ?? busyOrFailed;
        // A failed run is only the thread's word while it is still the newest
        // terminal run; otherwise a stale failure would resurface in the
        // composer error strip on every load, forever. Instead of comparing
        // timestamps (equal createdAt values reverse under gt/gte), ask for
        // the newest terminal run under the same deterministic ordering and
        // check whether it is this failure.
        const newestTerminal =
          run?.status === "failed"
            ? await tx.run.findFirst({
                where: {
                  botId: target.botId,
                  threadId: target.threadId,
                  parentRunId: null,
                  // Peer bot_message failures must not bury a user-visible failure.
                  trigger: { not: "bot_message" },
                  status: { in: ["failed", "completed", "cancelled"] },
                },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                select: { id: true },
              })
            : null;
        const currentRun = run?.status === "failed" && newestTerminal?.id !== run.id ? null : run;
        const progress = await progressSinceLastEntry(
          tx,
          target.threadId,
          currentRun && isActive(currentRun.status as RunStatus) && !isPeerRunRow(currentRun)
            ? [currentRun.id]
            : [],
        );
        const page = await loadEntryPage(
          { prisma: tx, sessionLog: deps.sessionLog },
          { threadId: target.threadId, sessionId },
          { includePeerRuns: true },
        );
        return { last, run: currentRun, progress, page };
      }),
    ]);
    const { page } = core;
    return {
      botId: target.botId,
      threadId: target.threadId,
      cursor: core.last?.seq ?? -1,
      entries: await withoutHiddenPeerRuns(deps.prisma, page.entries),
      olderCursor: page.olderCursor,
      progress: core.progress,
      run: core.run ? mapRun(core.run) : null,
      computer: toComputerStatus(
        target.botId,
        target.bot.screenGeneration,
        seen.computer,
        busyBotName ?? (seen.heldByOther ? target.bot.name : null),
        // A computer's updates are its owner's to apply.
        viewerId === target.bot.userId
          ? await currentComputerRelease(deps.sandbox, target.bot)
          : null,
      ),
    };
  }

  const core = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR SHARE`;
    const [sessionId, last, activeRuns, recentTerminals] = await Promise.all([
      threadSessionId(tx, target.threadId),
      tx.event.findFirst({
        where: { threadId: target.threadId },
        orderBy: { seq: "desc" },
        select: { seq: true },
      }),
      tx.run.findMany({
        where: {
          threadId: target.threadId,
          parentRunId: null,
          status: { in: [...ACTIVE_RUN_STATUSES] },
        },
        orderBy: { createdAt: "desc" },
      }),
      // Recently updated terminals (completion bumps updatedAt). pickLatestTerminalRun then
      // ranks by completedAt ?? createdAt so null timestamps cannot revive a stale failure.
      tx.run.findMany({
        where: {
          threadId: target.threadId,
          parentRunId: null,
          trigger: { not: "bot_message" },
          status: { in: ["failed", "completed", "cancelled"] },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 50,
      }),
    ]);
    const progress = await progressSinceLastEntry(
      tx,
      target.threadId,
      activeRuns.filter((run) => !isPeerRunRow(run)).map((run) => run.id),
    );
    const page = await loadEntryPage(
      { prisma: tx, sessionLog: deps.sessionLog },
      { threadId: target.threadId, sessionId },
      { includePeerRuns: true },
    );
    return {
      last,
      activeRuns,
      terminalRun: pickLatestTerminalRun(recentTerminals),
      progress,
      page,
      sessionId,
    };
  });
  const { page } = core;
  const primaryActiveRun = pickPrimaryActiveRun(core.activeRuns);
  return {
    groupId: target.groupId,
    groupName: target.groupName,
    members: target.members,
    people: await groupThreadPeople(deps.prisma, {
      groupId: target.groupId,
      sessionId: core.sessionId,
    }),
    threadId: target.threadId,
    cursor: core.last?.seq ?? -1,
    entries: await withoutHiddenPeerRuns(deps.prisma, page.entries),
    olderCursor: page.olderCursor,
    progress: core.progress,
    // Match the live reducer: a failed latest terminal stays in run even while siblings are
    // still active or start late. A newer completed/cancelled terminal clears it.
    run:
      core.terminalRun?.status === "failed"
        ? mapRun(core.terminalRun)
        : primaryActiveRun
          ? mapRun(primaryActiveRun)
          : null,
    activeRuns: core.activeRuns.map(mapRun),
  };
}

/**
 * Prefer a waiting ask/takeover over a merely-busy run for the group's headline
 * `run` field, even when the busy run started more recently — createdAt-desc
 * ordering alone would let a fresh busy run for one bot bury an older waiting
 * card for another. `activeRuns` still carries every active run regardless of
 * which one is picked here, so nothing is hidden from the client, only the
 * single-run summary field.
 */
function pickPrimaryActiveRun<T extends { status: string }>(runs: readonly T[]): T | undefined {
  return (
    runs.find((run) => run.status === "waiting_input" || run.status === "waiting_takeover") ??
    runs[0]
  );
}

/** Latest terminal by end time (completedAt, else createdAt), then createdAt, then id. */
function pickLatestTerminalRun<T extends { id: string; createdAt: Date; completedAt: Date | null }>(
  runs: T[],
): T | null {
  if (runs.length === 0) return null;
  return runs.reduce((best, run) => {
    const bestEnd = (best.completedAt ?? best.createdAt).getTime();
    const runEnd = (run.completedAt ?? run.createdAt).getTime();
    if (runEnd !== bestEnd) return runEnd > bestEnd ? run : best;
    if (run.createdAt.getTime() !== best.createdAt.getTime()) {
      return run.createdAt > best.createdAt ? run : best;
    }
    return run.id > best.id ? run : best;
  });
}

function mapRun(run: {
  id: string;
  botId: string;
  userId: string;
  threadId: string;
  taskId: string;
  status: string;
  trigger: string;
  routineId: string | null;
  modelProvider: string | null;
  modelId: string | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: run.id,
    botId: run.botId,
    userId: run.userId,
    threadId: run.threadId,
    taskId: run.taskId,
    status: run.status as never,
    trigger: run.trigger as never,
    routineId: run.routineId ?? null,
    modelProvider: run.modelProvider,
    modelId: run.modelId,
    // Same display clamp as live run.failed events so a huge stored error cannot bypass it.
    error:
      run.status === "failed"
        ? runFailureError({ type: "run.failed", payload: { error: run.error } })
        : run.error,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
  };
}

export async function sendThreadMessage(
  deps: {
    prisma: PrismaClient;
    events: ThreadEvents;
    jobs: JobPublisher;
  },
  actor: Actor,
  target: ThreadTarget,
  input: {
    text?: string;
    artifactIds?: string[];
    mentions?: MentionTargetInput[];
    replyToMessageId?: string;
    replyQuote?: string;
    clientNonce?: string;
    linkPreview?: false;
    draft?: DraftLeft;
  },
) {
  const existing = await replayExistingSend(deps, target.threadId, input.clientNonce);
  if (existing) return existing;
  // The excerpt is rendered text while blocks hold markdown source, so it
  // can't be substring-verified verbatim — enforce the cap here, then check
  // the flattened form against the parent inside the transaction.
  let replyQuote = input.replyQuote?.trim().slice(0, REPLY_QUOTE_MAX_LENGTH) || undefined;
  if (replyQuote && !input.replyToMessageId) {
    throw new ORPCError("BAD_REQUEST", { message: "replyQuote requires replyToMessageId." });
  }

  const commit = () =>
    deps.prisma.$transaction(async (tx) => {
      if (input.replyToMessageId) {
        const reply = await repliedBlocks(tx, target.threadId, input.replyToMessageId);
        if (!reply) throw new IsolationError();
        // Client-supplied excerpts are untrusted: drop a mismatch instead of
        // failing the send — the reply still lands, just without the quote.
        if (replyQuote && !quoteAppearsInBlocks(replyQuote, reply)) {
          replyQuote = undefined;
        }
      }

      if (target.kind === "bot") {
        const mentionTargets = splitMentionTargets(input.mentions);
        const { blocks: attachmentBlocks, artifacts } = await resolveSendAttachments(
          { prisma: tx },
          actor,
          target.botId,
          input.artifactIds,
        );
        const connectorNames = await resolveOwnedConnectorDisplayNames(
          tx,
          actor,
          mentionTargets.connectorMentionIds,
        );
        const groupNames = await resolveMentionedGroupNames(
          tx,
          actor,
          mentionTargets.groupMentionIds,
        );
        const blocks = buildUserMessageBlocks(input.text, attachmentBlocks, {
          linkPreview: input.linkPreview,
        });
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
        const activeRuns = await tx.run.findMany({
          where: {
            threadId: target.threadId,
            botId: target.botId,
            parentRunId: null,
            status: { in: [...ACTIVE_RUN_STATUSES] },
          },
          select: { id: true, taskId: true, status: true },
        });
        // A run parked on an ask_user card resolves with this text instead of blocking (spec
        // ask-answer-via-composer, PR 1). Approval/secret asks and any other unresolvable state
        // fall through to the CONFLICT guard below, unchanged. The ask only resolves when it is
        // the bot's only active run: with a second run alive the send must still hit that guard,
        // otherwise the other run is neither steered nor rejected.
        const soleActiveRun = activeRuns.length === 1 ? activeRuns[0] : undefined;
        const waitingRun = soleActiveRun?.status === "waiting_input" ? soleActiveRun : undefined;
        // A card the bot proposed on its own is put away by the reply, which then steers the run;
        // when a tap answered it first, the reply steers the run that tap resumed.
        const putAway =
          waitingRun &&
          (await dismissProposalWithTextInTransaction(tx, {
            spaceId: actor.spaceId,
            threadId: target.threadId,
            runId: waitingRun.id,
            userId: actor.userId,
            draft: input.draft,
          }));
        const message = await createThreadMessageInTransaction(tx, {
          threadId: target.threadId,
          role: "user",
          blocks,
          replyToMessageId: input.replyToMessageId,
          replyQuote,
          clientNonce: input.clientNonce,
        });

        // Refused only while a card still waits that the text cannot replace.
        if (input.draft && waitingRun && (!putAway || putAway.outcome === "keep")) {
          throw new ORPCError("CONFLICT", { message: "This draft is no longer waiting." });
        }
        if (waitingRun && putAway && putAway.outcome !== "keep") {
          await tx.steeringMessage.create({
            data: {
              messageId: message.id,
              botId: target.botId,
              userId: actor.userId,
              runId: waitingRun.id,
            },
          });
          return {
            message,
            runs: [{ id: waitingRun.id, taskId: waitingRun.taskId, status: putAway.status }],
            eventSeq: await threadEventSeq(tx, target.threadId),
          };
        }
        if (waitingRun) {
          const resolution = await resumeAskWithComposerTextInTransaction(tx, {
            spaceId: actor.spaceId,
            threadId: target.threadId,
            runId: waitingRun.id,
            text: input.text ?? "",
          });
          if (!resolution.resolvable) {
            throw new ORPCError("CONFLICT", {
              message: "Answer the pending ask first.",
            });
          }
          return {
            message,
            runs: [{ id: resolution.runId, taskId: waitingRun.taskId, status: "queued" }],
            eventSeq: await threadEventSeq(tx, target.threadId),
          };
        }
        if (activeRuns.some((run) => !STEERABLE_RUN_STATUSES.has(run.status))) {
          throw new ORPCError("CONFLICT", {
            message: "Answer the pending ask first.",
          });
        }
        const conversationRunIds = await findConversationRunIds(tx, activeRuns);
        const active = activeRuns.find((run) => conversationRunIds.has(run.id));
        if (active) {
          await tx.steeringMessage.create({
            data: {
              messageId: message.id,
              botId: target.botId,
              userId: actor.userId,
              runId: active.id,
            },
          });
          return {
            message,
            runs: [active],
            eventSeq: await threadEventSeq(tx, target.threadId),
          };
        }
        const task = await tx.task.create({
          data: {
            spaceId: actor.spaceId,
            botId: target.botId,
            threadId: target.threadId,
            userId: actor.userId,
            prompt: buildSendPrompt(input.text, artifacts, connectorNames, groupNames),
            status: "queued",
          },
        });
        const run = await tx.run.create({
          data: {
            spaceId: actor.spaceId,
            botId: target.botId,
            threadId: target.threadId,
            taskId: task.id,
            userId: actor.userId,
            status: "queued",
            trigger: "user",
            clientNonce: sendRunClientNonce(input.clientNonce, message.id),
            sourceMessageId: message.id,
          },
        });
        await cancelSupersededQueuedRuns(tx, {
          threadId: target.threadId,
          botIds: [target.botId],
          userId: actor.userId,
          keepRunIds: [run.id],
        });
        return {
          message,
          runs: [run],
          eventSeq: await threadEventSeq(tx, target.threadId),
        };
      }

      const group = await lockAndLoadGroupMembers(tx, actor, target);
      const { members } = group;
      const memberBotIds = members.map((member) => member.botId);
      const mentionTargets = splitMentionTargets(input.mentions);
      // Each woken bot runs as the sender, so only a bot they can use wakes.
      const targetBotIds = resolveGroupTargetBotIds({
        text: input.text ?? "",
        members: members.map((member) => ({ id: member.botId, name: member.name })),
        explicitMentions: mentionTargets.botMentionIds,
        leadBotId: group.leadBotId,
        usableBotIds: group.usableBotIds,
      });
      const { blocks: attachmentBlocks, artifacts } = await resolveGroupSendAttachments(
        { prisma: tx },
        actor,
        target.groupId,
        memberBotIds,
        input.artifactIds,
      );
      const connectorNames = await resolveOwnedConnectorDisplayNames(
        tx,
        actor,
        mentionTargets.connectorMentionIds,
      );
      const groupNames = await resolveMentionedGroupNames(
        tx,
        actor,
        mentionTargets.groupMentionIds,
      );
      const blocks = buildUserMessageBlocks(input.text, attachmentBlocks, {
        linkPreview: input.linkPreview,
      });
      // Each targeted bot gets a run in turn, so the first run is always the first target's. A
      // message waking no bot still reaches the group's people, fed as its lead's.
      const eventBotId =
        targetBotIds[0] ??
        groupLeadBotId(
          members.map((member) => ({ id: member.botId })),
          group.leadBotId,
        );
      if (!eventBotId) throw new IsolationError("Group send did not resolve a target");
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
      // Only the sender's own runs take this message: another person's run on the same bot keeps
      // its course, its asks and cards stay theirs, and the sender gets a run of their own.
      const activeRuns = await tx.run.findMany({
        where: {
          threadId: target.threadId,
          botId: { in: targetBotIds },
          userId: actor.userId,
          parentRunId: null,
          status: { in: [...ACTIVE_RUN_STATUSES] },
        },
        select: { id: true, taskId: true, botId: true, status: true },
      });
      const activeRunsByBotId = new Map<string, typeof activeRuns>();
      for (const run of activeRuns) {
        const botRuns = activeRunsByBotId.get(run.botId);
        if (botRuns) botRuns.push(run);
        else activeRunsByBotId.set(run.botId, [run]);
      }
      const putAwayStatuses = new Map<string, string>();
      for (const botId of targetBotIds) {
        const botRuns = activeRunsByBotId.get(botId) ?? [];
        const soleActiveRun = botRuns.length === 1 ? botRuns[0] : undefined;
        if (soleActiveRun?.status !== "waiting_input") continue;
        const dismissal = await dismissProposalWithTextInTransaction(tx, {
          spaceId: actor.spaceId,
          threadId: target.threadId,
          runId: soleActiveRun.id,
          userId: actor.userId,
          draft: input.draft,
          draftsOnly: true,
        });
        if (dismissal.outcome !== "keep") putAwayStatuses.set(botId, dismissal.status);
      }
      const message = await createThreadMessageInTransaction(tx, {
        threadId: target.threadId,
        role: "user",
        blocks,
        replyToMessageId: input.replyToMessageId,
        replyQuote,
        clientNonce: input.clientNonce,
        feedBotId: eventBotId,
        targets: targetBotIds,
        authorId: actor.userId,
      });
      // Dispatch per bot in this one transaction (spec ask-answer-via-composer, PR 1): each
      // targeted bot is resolved on its own state — an ask_user run resolves, a steerable run
      // gets steered, an idle bot gets a new run — so one bot's pending ask never blocks the
      // rest of the group. Any bot that can't resolve (approval/secret ask, waiting_takeover,
      // or anything else non-steerable) still aborts the whole send via CONFLICT, same net
      // effect as the old blanket throw since a transaction throw rolls back every bot's work.
      const conversationRunIds = await findConversationRunIds(tx, activeRuns);
      const runs: Array<{ id: string; taskId: string; botId: string; status: string }> = [];
      const createdRuns: typeof runs = [];
      let draftPutAway = false;
      for (const botId of targetBotIds) {
        const botRuns = activeRunsByBotId.get(botId) ?? [];
        const active = botRuns.find((run) => conversationRunIds.has(run.id));
        const soleActiveRun = botRuns.length === 1 ? botRuns[0] : undefined;
        if (soleActiveRun?.status === "waiting_input") {
          const putAwayStatus = putAwayStatuses.get(botId);
          if (putAwayStatus) {
            await tx.steeringMessage.create({
              data: { messageId: message.id, botId, userId: actor.userId, runId: soleActiveRun.id },
            });
            draftPutAway = true;
            runs.push({ ...soleActiveRun, status: putAwayStatus });
            continue;
          }
          const resolution = await resumeAskWithComposerTextInTransaction(tx, {
            spaceId: actor.spaceId,
            threadId: target.threadId,
            runId: soleActiveRun.id,
            text: input.text ?? "",
          });
          if (!resolution.resolvable) {
            throw new ORPCError("CONFLICT", {
              message: "Answer the pending ask first.",
            });
          }
          runs.push({
            id: resolution.runId,
            taskId: soleActiveRun.taskId,
            botId,
            status: "queued",
          });
          continue;
        }
        if (botRuns.some((run) => !STEERABLE_RUN_STATUSES.has(run.status))) {
          throw new ORPCError("CONFLICT", {
            message: "Answer the pending ask first.",
          });
        }
        if (active) {
          await tx.steeringMessage.create({
            data: { messageId: message.id, botId, userId: actor.userId, runId: active.id },
          });
          runs.push(active);
          continue;
        }
        const task = await tx.task.create({
          data: {
            spaceId: actor.spaceId,
            botId,
            threadId: target.threadId,
            userId: actor.userId,
            prompt: buildSendPrompt(input.text, artifacts, connectorNames, groupNames),
            status: "queued",
          },
        });
        const run = await tx.run.create({
          data: {
            spaceId: actor.spaceId,
            botId,
            threadId: target.threadId,
            taskId: task.id,
            userId: actor.userId,
            status: "queued",
            trigger: "user",
            clientNonce: sendRunClientNonce(input.clientNonce, message.id, botId),
            sourceMessageId: message.id,
          },
        });
        runs.push(run);
        createdRuns.push(run);
      }
      // A draft's text the reply did not put away names a card that waits, or no longer does.
      if (input.draft && !draftPutAway) {
        throw new ORPCError("CONFLICT", { message: "This draft is no longer waiting." });
      }
      if (createdRuns.length) {
        await cancelSupersededQueuedRuns(tx, {
          threadId: target.threadId,
          botIds: createdRuns.map((run) => run.botId),
          userId: actor.userId,
          keepRunIds: createdRuns.map((run) => run.id),
        });
      }
      await touchGroupUpdatedAt(tx, target.groupId);
      return { message, runs, eventSeq: await threadEventSeq(tx, target.threadId) };
    });

  const committed = await withSerializableRetry(commit).catch(async (error) => {
    const winner = await replayExistingSend(deps, target.threadId, input.clientNonce);
    if (winner) return { replay: winner } as const;
    throw error;
  });
  if ("replay" in committed) return committed.replay;
  await deps.events.notify(target.threadId, committed.eventSeq).catch((error) => {
    // Subscribers catch up from the durable event cursor after a missed realtime wake.
    getLogger().error("thread send realtime notification", error);
  });
  await enqueueRunsNeedingContinue(deps.jobs, committed.runs);
  await enqueueLinkPreview(deps.jobs, committed.message.id, input.linkPreview);
  return sendResult(committed.message, committed.runs);
}

/**
 * Asks for a link preview of a message that is now committed. A message sent with the preview
 * turned off already carries the removal marker, so nothing is queued for it. Best effort: a
 * message without its preview is a normal outcome, never a failed send.
 */
export async function enqueueLinkPreview(
  jobs: JobPublisher,
  messageId: string,
  linkPreview: false | undefined,
): Promise<void> {
  if (linkPreview === false) return;
  await jobs.enqueue(linkPreviewJob({ messageId })).catch((error) => {
    getLogger().error("link.preview enqueue", error);
  });
}

/**
 * Append an emoji reply to the conversation so the next AI turn sees its target.
 * Clients render it beneath that message; the reaction itself does not start an AI turn.
 */
export async function reactToThreadMessage(
  deps: { prisma: PrismaClient },
  actor: Actor,
  target: ThreadTarget,
  input: {
    messageId: string;
    reaction: MessageReaction;
    clientNonce: string;
  },
) {
  return deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
    const parent = await tx.sessionEntry.findFirst({
      where: { id: input.messageId, session: { threadId: target.threadId, kind: "thread" } },
      select: { id: true },
    });
    if (!parent) throw new IsolationError();
    if (await threadEntryByNonce(tx, target.threadId, input.clientNonce)) return { eventSeq: null };
    const botId = target.kind === "bot" ? target.botId : target.memberBotIds[0];
    if (!botId) throw new IsolationError();
    const blocks: MessageBlock[] = [{ kind: "text", text: input.reaction }];
    const message = await createThreadMessageInTransaction(tx, {
      threadId: target.threadId,
      role: "user",
      blocks,
      replyToMessageId: parent.id,
      clientNonce: input.clientNonce,
      feedBotId: botId,
      ...(target.kind === "group" ? { authorId: actor.userId } : {}),
    });
    if (target.kind === "group") await touchGroupUpdatedAt(tx, target.groupId);
    return { eventSeq: await threadEventSeq(tx, target.threadId), messageId: message.id };
  });
}

export async function stopThreadRuns(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    events: ThreadEvents;
  },
  actor: Actor,
  target: ThreadTarget,
) {
  const { runIds, computers, leases, heldRuns } = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
    const active = await tx.run.findMany({
      where: { threadId: target.threadId, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true, botId: true, checkpoint: true },
    });
    const ids = active.map((run) => run.id);
    await logCancelledRunsInTransaction(tx, ids, actor.userId);
    await tx.run.updateMany({
      where: { id: { in: ids } },
      data: { status: "cancelled", completedAt: new Date() },
    });
    await tx.steeringMessage.deleteMany({
      where: {
        botId: { in: target.kind === "bot" ? [target.botId] : target.memberBotIds },
        message: { session: { threadId: target.threadId, kind: "thread" } },
      },
    });
    // Snapshot teardown coordinates before commit. Once cancellation becomes
    // visible, a worker can release its lease / execution columns immediately; a
    // later lookup would then miss the sandbox work this request must stop.
    // Team ownership lives on ComputerExecutionLease; Computer.executionRunId is
    // only a legacy secondary path and is not written by current acquisition.
    const leases = ids.length
      ? await tx.computerExecutionLease.findMany({
          where: { runId: { in: ids } },
          select: { computerId: true, botId: true, runId: true, fence: true },
        })
      : [];
    const leaseComputerIds = [...new Set(leases.map((lease) => lease.computerId))];
    const computers = ids.length
      ? await tx.computer.findMany({
          where:
            leaseComputerIds.length > 0
              ? {
                  OR: [{ id: { in: leaseComputerIds } }, { executionRunId: { in: ids } }],
                }
              : { executionRunId: { in: ids } },
          select: {
            id: true,
            homeKey: true,
            kind: true,
            providerRef: true,
            executionBotId: true,
            executionRunId: true,
          },
        })
      : [];
    return {
      runIds: ids,
      computers,
      leases,
      heldRuns: active.flatMap((run) => {
        const hold = browserApprovalCheckpointOf(run.checkpoint);
        return hold ? [{ id: run.id, botId: run.botId, hold }] : [];
      }),
    };
  });
  // Keep the DB lease until after teardown so a replacement run cannot claim the
  // screen while we still need the cancelled run's screenLeaseId to release it.
  const computerById = new Map(computers.map((computer) => [computer.id, computer]));
  const teardownTargets: Array<{
    computer: (typeof computers)[number];
    botId: string;
    runId: string;
    lease: (typeof leases)[number] | null;
  }> = [];
  const seenTargets = new Set<string>();
  for (const lease of leases) {
    const computer = computerById.get(lease.computerId);
    if (!computer) continue;
    const key = `${computer.id}:${lease.runId}`;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    teardownTargets.push({
      computer,
      botId: lease.botId,
      runId: lease.runId,
      lease,
    });
  }
  const cancelledRunIds = new Set(runIds);
  for (const computer of computers) {
    if (!computer.executionBotId || !computer.executionRunId) continue;
    // Computers may enter the snapshot via a cancelled lease while
    // Computer.executionRunId still points at an unrelated live run. Only treat
    // the legacy columns as a teardown target when they belong to a run we
    // cancelled in this transaction.
    if (!cancelledRunIds.has(computer.executionRunId)) continue;
    const key = `${computer.id}:${computer.executionRunId}`;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    teardownTargets.push({
      computer,
      botId: computer.executionBotId,
      runId: computer.executionRunId,
      lease: null,
    });
  }
  const heldRunIds = new Set(heldRuns.map((run) => run.id));
  await Promise.all(
    heldRuns.map(({ id: runId, botId, hold }) =>
      cancelComputerRunWork(deps.sandbox, hold.computer, hold.computerId, runId, {
        operationId: "stop",
        traceId: "stop",
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        ...(hold.memberId ? { memberId: hold.memberId } : {}),
        runId,
        screenLeaseId: hold.screenLeaseId,
        cancelRunWork: true,
        signal: new AbortController().signal,
      }),
    ),
  );
  await Promise.all(
    teardownTargets.map(async ({ computer, botId, runId, lease }) => {
      if (heldRunIds.has(runId) || !computer.providerRef) return;
      const context = {
        operationId: "stop",
        traceId: "stop",
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        runId,
        screenLeaseId: screenLeaseIdForRun(lease, runId),
        cancelRunWork: true,
        signal: new AbortController().signal,
      };
      const ref = toComputerRef(computer);
      await cancelComputerRunWork(deps.sandbox, ref, computer.id, runId, context);
      await releaseBotScreen(deps, ref, context);
    }),
  );
  await recoverBrowserApprovalScreens(deps, { runIds });
  await expireComputerExecutionLeases(deps.prisma, { runId: { in: runIds } });
  await deps.prisma.computer.updateMany({
    where: { executionRunId: { in: runIds } },
    data: {
      executionRunId: null,
      executionBotId: null,
      executionLeaseExpiresAt: null,
    },
  });
  await deps.prisma.event.deleteMany({
    where: {
      type: "thread.progress",
      runId: { in: runIds },
    },
  });
}

export async function setThreadUnreadState(
  prisma: PrismaClient,
  actor: Actor,
  target: ThreadTarget,
  unread: boolean,
) {
  if (target.kind === "group") {
    await prisma.chatGroupPerson.updateMany({
      where: { groupId: target.groupId, userId: actor.userId, unread: { not: unread } },
      data: { unread },
    });
    return;
  }
  const result = await prisma.thread.updateMany({
    where: {
      id: target.threadId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      unread: { not: unread },
    },
    data: { unread },
  });
  if (result.count > 1) throw new IsolationError();
}

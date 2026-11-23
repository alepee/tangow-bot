import type { SessionLog } from "@tangow/adapter-kit";
import type {
  EntryId,
  ProductEvent,
  SessionEntry,
  ThreadEntry,
  ThreadMessagePage,
} from "@tangow/contracts";
import { SessionId, toThreadEntry } from "@tangow/contracts";
import { appendedEntries, visibleEntries } from "@tangow/core";
import { hiddenPeerRunIds, loadPeerMessagePage, type Prisma, type PrismaClient } from "@tangow/db";

type ThreadDb = PrismaClient | Prisma.TransactionClient;
type PageLog = Pick<SessionLog<Prisma.TransactionClient>, "readPage" | "readAround">;

const THREAD_PAGE_SIZE = 200;

export async function threadSessionId(prisma: ThreadDb, threadId: string): Promise<SessionId> {
  const { sessionId } = await prisma.thread.findUniqueOrThrow({
    where: { id: threadId },
    select: { sessionId: true },
  });
  return SessionId.parse(sessionId);
}

function olderCursor(page: readonly SessionEntry[]): EntryId | null {
  const oldest = page[0];
  return oldest?.parentId ? oldest.id : null;
}

export async function withoutHiddenPeerRuns(
  prisma: ThreadDb,
  entries: readonly ThreadEntry[],
): Promise<ThreadEntry[]> {
  const runIds = [...new Set(entries.flatMap((entry) => (entry.runId ? [entry.runId] : [])))];
  return visibleEntries(entries, { hiddenPeerRunIds: await hiddenPeerRunIds(prisma, runIds) });
}

export async function loadEntryPage(
  deps: { prisma: ThreadDb; sessionLog: PageLog },
  { threadId, sessionId }: { threadId: string; sessionId: SessionId },
  query: { before?: EntryId; around?: { entryId: EntryId }; includePeerRuns?: boolean },
): Promise<ThreadMessagePage> {
  const around = query.around
    ? await deps.sessionLog.readAround(
        sessionId,
        query.around.entryId,
        THREAD_PAGE_SIZE,
        deps.prisma,
      )
    : [];
  const page =
    around.length > 0
      ? around
      : await deps.sessionLog.readPage(
          sessionId,
          { before: query.around ? undefined : query.before, limit: THREAD_PAGE_SIZE },
          deps.prisma,
        );
  const entries = page.map(toThreadEntry);
  return {
    threadId,
    entries: query.includePeerRuns ? entries : await withoutHiddenPeerRuns(deps.prisma, entries),
    olderCursor: olderCursor(page),
  };
}

export async function loadPeerPage(
  prisma: ThreadDb,
  { threadId, sessionId }: { threadId: string; sessionId: SessionId },
  { peerBotId, before }: { peerBotId: string; before?: EntryId },
): Promise<ThreadMessagePage> {
  const page = await loadPeerMessagePage(prisma, {
    sessionId,
    peerId: peerBotId,
    before,
    limit: THREAD_PAGE_SIZE,
  });
  return { threadId, entries: page.entries.map(toThreadEntry), olderCursor: page.olderCursor };
}

/** The session's chain oldest first, what every rewind and clear left, read a page at a time. */
export async function loadChain(
  log: Pick<PageLog, "readPage">,
  sessionId: SessionId,
  pageSize: number,
): Promise<ThreadEntry[]> {
  const pages: SessionEntry[][] = [];
  let before: EntryId | null = null;
  do {
    const page = await log.readPage(sessionId, { before: before ?? undefined, limit: pageSize });
    pages.unshift(page);
    before = olderCursor(page);
  } while (before);
  return pages.flat().map(toThreadEntry);
}

export async function isPeerRun(
  prisma: ThreadDb,
  runId: string | undefined,
  cache: Map<string, Promise<boolean>>,
): Promise<boolean> {
  if (!runId) return false;
  let peerRun = cache.get(runId);
  if (!peerRun) {
    peerRun = hiddenPeerRunIds(prisma, [runId]).then((ids) => ids.has(runId));
    cache.set(runId, peerRun);
  }
  return peerRun;
}

export async function forwardedThreadEvent(
  prisma: ThreadDb,
  event: ProductEvent,
  peerRuns: Map<string, Promise<boolean>>,
): Promise<ProductEvent | null> {
  if (event.type !== "session.entry.appended") {
    const hidden = await isPeerRun(prisma, event.runId, peerRuns);
    return hidden && !shouldForwardPeerThreadEvent(event) ? null : event;
  }
  const entries = appendedEntries(event);
  const hiddenPeerRunIds = new Set<string>();
  for (const runId of new Set(entries.flatMap((entry) => (entry.runId ? [entry.runId] : [])))) {
    if (await isPeerRun(prisma, runId, peerRuns)) hiddenPeerRunIds.add(runId);
  }
  if (hiddenPeerRunIds.size === 0) return event;
  const visible = visibleEntries(entries, { hiddenPeerRunIds });
  return visible.length > 0 ? { ...event, payload: { ...event.payload, entries: visible } } : null;
}

const FORWARDED_PEER_RUN_EVENTS: ReadonlySet<string> = new Set([
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "computer.takeover.requested",
]);

export function shouldForwardPeerThreadEvent(event: { type: string }): boolean {
  return FORWARDED_PEER_RUN_EVENTS.has(event.type);
}

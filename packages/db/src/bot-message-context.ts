import type { BotMessageIntent, EntryId, Peer, SessionEntry } from "@tangow/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import type { SessionEntryRow } from "./sessions.js";
import { ENTRY_ON_CHAIN, sessionEntryFromRow } from "./sessions.js";

function peerIdOf(alias: string, side: "to" | "from"): Prisma.Sql {
  const peer = Prisma.raw(`${alias}.payload -> '${side}'`);
  return Prisma.sql`COALESCE(${peer} ->> 'botId', ${peer} ->> 'address')`;
}

/** What a run woken by another bot or agent knows of the delivery that woke it. */
export type BotMessageContext = {
  entryId: EntryId;
  from: Peer;
  /** The sending bot, absent for a connected agent from another owner. */
  fromBotId?: string;
  fromBotName: string;
  text: string;
  intent: BotMessageIntent;
  hop: number;
  exchangeId: EntryId;
  /** It answers a request or a question this bot sent that peer earlier in the exchange. */
  repliesToRequest: boolean;
  /** The run of this bot that sent the request it answers. */
  requestRunId?: string;
};

/** The `bot.message.received` entries among `entryIds`, each as the context of the run it woke. */
export async function loadBotMessageContexts(
  prisma: PrismaClient | Prisma.TransactionClient,
  entryIds: readonly string[],
): Promise<Map<string, BotMessageContext>> {
  if (entryIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<
    Array<SessionEntryRow & { requestId: string | null; requestRunId: string | null }>
  >`
    SELECT r.*, request.id AS "requestId", request."runId" AS "requestRunId"
    FROM session_entries r
    LEFT JOIN LATERAL (
      SELECT s.id, s."runId" FROM session_entries s
      WHERE s."sessionId" = r."sessionId" AND s.type = 'bot.message.sent' AND s.seq < r.seq
        AND s.payload ->> 'exchangeId' = r.payload ->> 'exchangeId'
        AND ${peerIdOf("s", "to")} = ${peerIdOf("r", "from")}
        AND s.payload ->> 'intent' IN ('request', 'question')
      ORDER BY s.seq DESC LIMIT 1) request ON r.payload ->> 'intent' <> 'fyi'
    WHERE r.id = ANY(${[...entryIds]}::text[]) AND r.type = 'bot.message.received'`;
  const contexts = new Map<string, BotMessageContext>();
  for (const { requestId, requestRunId, ...row } of rows) {
    const entry = sessionEntryFromRow(row);
    if (entry.type !== "bot.message.received") continue;
    const { from, text, intent, hop, exchangeId } = entry.payload;
    contexts.set(entry.id, {
      entryId: entry.id,
      from,
      ...(from.kind === "bot" ? { fromBotId: from.botId } : {}),
      fromBotName: from.name,
      text,
      intent,
      hop,
      exchangeId,
      repliesToRequest: requestId !== null,
      ...(requestRunId ? { requestRunId } : {}),
    });
  }
  return contexts;
}

export async function loadBotMessageContext(
  prisma: PrismaClient | Prisma.TransactionClient,
  entryId: string | null | undefined,
): Promise<BotMessageContext | undefined> {
  if (!entryId) return undefined;
  return (await loadBotMessageContexts(prisma, [entryId])).get(entryId);
}

/**
 * One page of what a session's bot and one peer said to each other, oldest first: the `limit`
 * newest still on the chain before `before`, and the oldest one's id when older ones remain.
 */
export async function loadPeerMessagePage(
  prisma: PrismaClient | Prisma.TransactionClient,
  {
    sessionId,
    peerId,
    before,
    limit,
  }: {
    sessionId: string;
    peerId: string;
    before?: EntryId;
    limit: number;
  },
): Promise<{ entries: SessionEntry[]; olderCursor: EntryId | null }> {
  const older = before
    ? Prisma.sql`AND e.seq < (
        SELECT seq FROM session_entries WHERE id = ${before} AND "sessionId" = ${sessionId}
      )`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<SessionEntryRow[]>`
    SELECT e.* FROM session_entries e
    WHERE e."sessionId" = ${sessionId}
      AND e.type IN ('bot.message.sent', 'bot.message.received')
      AND CASE WHEN e.type = 'bot.message.sent' THEN ${peerIdOf("e", "to")}
        ELSE ${peerIdOf("e", "from")} END = ${peerId}
      ${older} AND ${ENTRY_ON_CHAIN}
    ORDER BY e.seq DESC LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit).reverse().map(sessionEntryFromRow);
  return {
    entries: page,
    olderCursor: rows.length > limit ? (page[0]?.id ?? null) : null,
  };
}

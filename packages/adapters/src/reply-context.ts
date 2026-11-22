import { replyContextOf } from "@tangow/core";
import type { PrismaClient } from "@tangow/db";
import { sessionEntryFromRow } from "@tangow/db";

/** Fetch the explicit target even when it has fallen outside the history window. */
export async function loadReplyContext(
  prisma: PrismaClient,
  threadId: string,
  sourceMessageId: string | null | undefined,
): Promise<string | undefined> {
  if (!sourceMessageId) return undefined;
  const row = await prisma.sessionEntry.findFirst({
    where: { id: sourceMessageId, type: "user.message", session: { threadId } },
  });
  const source = row && sessionEntryFromRow(row);
  if (source?.type !== "user.message" || !source.payload.replyTo) return undefined;
  const target = await prisma.sessionEntry.findFirst({
    where: { id: source.payload.replyTo.entryId, sessionId: source.sessionId },
  });
  if (!target) return undefined;
  const run = target.runId
    ? await prisma.sessionEntry.findMany({
        where: {
          sessionId: source.sessionId,
          runId: target.runId,
          id: { not: target.id },
          type: { in: ["assistant.text", "assistant.ask", "assistant.choice", "routine.finished"] },
        },
      })
    : [];
  const replied = [...run, target].sort((a, b) => a.seq - b.seq).map(sessionEntryFromRow);
  return replyContextOf(source, replied);
}

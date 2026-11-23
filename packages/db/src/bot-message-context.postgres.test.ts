import type { SessionEntry } from "@tangow/contracts";
import { EntryId, SessionId } from "@tangow/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPeerMessagePage } from "./bot-message-context.js";
import { createDb, type PrismaClient } from "./client.js";
import { clearThread } from "./events.js";
import { appendSessionEntryInTransaction } from "./sessions.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("loadPeerMessagePage (PostgreSQL)", () => {
  const id = `peer-page-${process.pid}-${Date.now()}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({ data: { id, name: "Peers", email: `${id}@tangow.test` } });
    await prisma.organization.create({
      data: { id, name: "Peers", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id, organizationId: id, name: "General" } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id } });
    await prisma.user.deleteMany({ where: { id } });
    await close();
  });

  it("pages one peer's exchange back from the newest, leaving out other peers and what a clear cut", async () => {
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Ada", color: "#00C46A" },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const sessionId = SessionId.parse(thread.sessionId);
    const scout = { kind: "bot" as const, botId: "bot-scout", name: "Scout" };
    const other = { kind: "bot" as const, botId: "bot-other", name: "Other" };
    const exchangeId = EntryId.parse("exchange-1");
    const send = (to: typeof scout, text: string) =>
      prisma.$transaction((tx) =>
        appendSessionEntryInTransaction(tx, {
          sessionId,
          botId: bot.id,
          type: "bot.message.sent",
          payload: { to, text, intent: "fyi", hop: 1, exchangeId },
        }),
      );
    const receive = (from: typeof scout, text: string) =>
      prisma.$transaction((tx) =>
        appendSessionEntryInTransaction(tx, {
          sessionId,
          feedBotId: bot.id,
          type: "bot.message.received",
          payload: { from, text, intent: "fyi", hop: 1, exchangeId },
        }),
      );
    const texts = (entries: readonly SessionEntry[]) =>
      entries.map((entry) =>
        entry.type === "bot.message.sent" || entry.type === "bot.message.received"
          ? entry.payload.text
          : entry.type,
      );

    await send(scout, "before the clear");
    await clearThread(prisma, { spaceId: id, threadId: thread.id, botId: bot.id, userId: id });
    await send(scout, "one");
    await receive(other, "elsewhere");
    await receive(scout, "two");
    await send(scout, "three");

    const newest = await loadPeerMessagePage(prisma, {
      sessionId,
      peerId: scout.botId,
      limit: 2,
    });
    expect(texts(newest.entries)).toEqual(["two", "three"]);
    expect(newest.olderCursor).toBe(newest.entries[0]!.id);

    const older = await loadPeerMessagePage(prisma, {
      sessionId,
      peerId: scout.botId,
      before: newest.olderCursor!,
      limit: 2,
    });
    expect(texts(older.entries)).toEqual(["one"]);
    expect(older.olderCursor).toBeNull();
  });
});

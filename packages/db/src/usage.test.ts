import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import type { PgliteDatabase } from "./pglite.test-support.js";
import { openPgliteDatabase } from "./pglite.test-support.js";
import { usageBreakdown } from "./usage.js";

const SPACE = "space_usage";
const USER = "user_usage";
const NOW = new Date(Date.UTC(2026, 9, 31, 12));
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

let database: PgliteDatabase;
let prisma: PrismaClient;

beforeAll(async () => {
  database = await openPgliteDatabase();
  prisma = database.prisma;
  for (const id of [USER, "user_other"]) {
    await prisma.user.create({ data: { id, name: id, email: `${id}@tangow.test` } });
  }
  await prisma.organization.create({
    data: { id: "org_usage", name: "O", slug: "org-usage", createdAt: new Date() },
  });
  await prisma.space.create({ data: { id: SPACE, organizationId: "org_usage", name: "S" } });
});
afterAll(() => database.close());

async function seedRun(botId: string, id: string) {
  const thread = await prisma.thread.findFirstOrThrow({ where: { botId } });
  const task = await prisma.task.create({
    data: {
      spaceId: SPACE,
      botId,
      threadId: thread.id,
      userId: USER,
      prompt: "",
      status: "completed",
    },
  });
  await prisma.run.create({
    data: {
      id,
      spaceId: SPACE,
      botId,
      threadId: thread.id,
      taskId: task.id,
      userId: USER,
      status: "completed",
      trigger: "message",
    },
  });
}

function usage(fields: {
  botId: string;
  runId?: string;
  compactionId?: string;
  category?: string;
  model?: string;
  userId?: string;
  createdAt?: Date;
  inputTokens: number;
  outputTokens: number;
}) {
  return prisma.usageRecord.create({
    data: {
      spaceId: SPACE,
      userId: USER,
      provider: "anthropic",
      model: "sonnet",
      createdAt: daysAgo(1),
      ...fields,
    },
  });
}

describe("usageBreakdown", () => {
  it("counts runs and compaction passes once per cell, keeping input and output apart", async () => {
    const bot = await prisma.bot.create({
      data: { spaceId: SPACE, userId: USER, name: "Atlas", color: "#5B5BD6", shapeSeed: 3 },
    });
    await prisma.thread.create({ data: { spaceId: SPACE, userId: USER, botId: bot.id } });
    await seedRun(bot.id, "run_a");
    await seedRun(bot.id, "run_b");
    // Two model calls in one run, one in another.
    await usage({
      botId: bot.id,
      runId: "run_a",
      category: "complex",
      inputTokens: 100,
      outputTokens: 10,
    });
    await usage({
      botId: bot.id,
      runId: "run_a",
      category: "complex",
      inputTokens: 50,
      outputTokens: 5,
    });
    await usage({
      botId: bot.id,
      runId: "run_b",
      category: "complex",
      inputTokens: 30,
      outputTokens: 3,
    });
    // One compaction pass: a summary chunk and a fact extraction.
    await usage({
      botId: bot.id,
      compactionId: "pass_1",
      category: "compaction",
      inputTokens: 400,
      outputTokens: 40,
    });
    await usage({
      botId: bot.id,
      compactionId: "pass_1",
      category: "compaction",
      inputTokens: 60,
      outputTokens: 6,
    });
    // Outside the 7-day window, and another person's spend.
    await usage({
      botId: bot.id,
      runId: "run_b",
      category: "complex",
      createdAt: daysAgo(20),
      inputTokens: 7,
      outputTokens: 7,
    });
    await usage({
      botId: bot.id,
      userId: "user_other",
      category: "fixed",
      inputTokens: 9,
      outputTokens: 9,
    });

    const cells = await usageBreakdown(prisma, { spaceId: SPACE, userId: USER }, "7d", NOW);
    const bot_ = {
      id: bot.id,
      name: "Atlas",
      color: "#5B5BD6",
      shapeSeed: 3,
      avatarCharacter: null,
      deleted: false,
    };
    expect(cells).toEqual(
      expect.arrayContaining([
        {
          bot: bot_,
          provider: "anthropic",
          model: "sonnet",
          category: "complex",
          hasRun: true,
          runs: 2,
          compactions: 0,
          inputTokens: 180,
          outputTokens: 18,
        },
        {
          bot: bot_,
          provider: "anthropic",
          model: "sonnet",
          category: "compaction",
          hasRun: false,
          runs: 0,
          compactions: 1,
          inputTokens: 460,
          outputTokens: 46,
        },
      ]),
    );
    expect(cells).toHaveLength(2);

    const all = await usageBreakdown(prisma, { spaceId: SPACE, userId: USER }, "all", NOW);
    expect(all.find((cell) => cell.category === "complex")?.inputTokens).toBe(187);
  });

  it("keeps a deleted bot's spend under its name, without its colour", async () => {
    await prisma.botDeletion.create({
      data: {
        id: "bot_gone",
        spaceId: SPACE,
        name: "Juno",
        deletedByUserId: USER,
        memoriesPreserved: false,
      },
    });
    await usage({ botId: "bot_gone", model: "gemma", inputTokens: 5, outputTokens: 1 });

    const cells = await usageBreakdown(prisma, { spaceId: SPACE, userId: USER }, "30d", NOW);
    expect(cells.find((cell) => cell.model === "gemma")).toEqual({
      bot: {
        id: "bot_gone",
        name: "Juno",
        color: null,
        shapeSeed: null,
        avatarCharacter: null,
        deleted: true,
      },
      provider: "anthropic",
      model: "gemma",
      category: null,
      hasRun: false,
      runs: 0,
      compactions: 0,
      inputTokens: 5,
      outputTokens: 1,
    });
  });
});

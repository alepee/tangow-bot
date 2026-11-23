import type { UsageCell, UsagePeriod } from "@tangow/contracts";
import { botDisplayColor, UsageCategorySchema } from "@tangow/contracts";
import type { PrismaClient } from "./client.js";

const PERIOD_DAYS: Record<UsagePeriod, number | null> = { "7d": 7, "30d": 30, all: null };

type UsageCellRow = {
  botId: string | null;
  botName: string | null;
  color: string | null;
  shapeSeed: number | null;
  avatarCharacter: string | null;
  deletedName: string | null;
  provider: string;
  model: string;
  category: string | null;
  hasRun: boolean;
  runs: number;
  compactions: number;
  inputTokens: number;
  outputTokens: number;
};

/**
 * A person's spend in a space over a period, one cell per bot, model and category, with the calls
 * of a run apart from those outside one. A run has one bot, one model and one category, and a
 * compaction pass one model, so the distinct counts of cells add up.
 */
export async function usageBreakdown(
  prisma: PrismaClient,
  actor: { spaceId: string; userId: string },
  period: UsagePeriod,
  now = new Date(),
): Promise<UsageCell[]> {
  const days = PERIOD_DAYS[period];
  const since = days === null ? null : new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const rows = await prisma.$queryRaw<UsageCellRow[]>`
    SELECT
      u."botId", b.name AS "botName", b.color, b."shapeSeed", b."avatarCharacter", d.name AS "deletedName",
      u.provider, u.model, u.category, (u."runId" IS NOT NULL) AS "hasRun",
      COUNT(DISTINCT u."runId")::int AS runs,
      COUNT(DISTINCT u."compactionId")::int AS compactions,
      SUM(u."inputTokens")::float8 AS "inputTokens",
      SUM(u."outputTokens")::float8 AS "outputTokens"
    FROM usage_records u
    LEFT JOIN bots b ON b.id = u."botId"
    LEFT JOIN bot_deletions d ON d.id = u."botId"
    WHERE u."spaceId" = ${actor.spaceId} AND u."userId" = ${actor.userId}
      AND (${since}::timestamp IS NULL OR u."createdAt" >= ${since}::timestamp)
    GROUP BY u."botId", b.name, b.color, b."shapeSeed", b."avatarCharacter", d.name, u.provider, u.model, u.category,
      (u."runId" IS NOT NULL)`;
  return rows.map((row) => {
    const name = row.botName ?? row.deletedName;
    const category = UsageCategorySchema.safeParse(row.category);
    return {
      bot:
        row.botId && name !== null
          ? {
              id: row.botId,
              name,
              color:
                row.botName === null || row.color === null
                  ? null
                  : botDisplayColor({ color: row.color, avatarCharacter: row.avatarCharacter }),
              shapeSeed: row.botName === null ? null : row.shapeSeed,
              avatarCharacter: row.botName === null ? null : row.avatarCharacter,
              deleted: row.botName === null,
            }
          : null,
      provider: row.provider,
      model: row.model,
      category: category.success ? category.data : null,
      hasRun: row.hasRun,
      runs: row.runs,
      compactions: row.compactions,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
    };
  });
}

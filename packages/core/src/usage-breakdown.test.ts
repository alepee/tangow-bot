import type { UsageCell } from "@tangow/contracts";
import { describe, expect, it } from "vitest";
import { pivotUsage, usageAverage, usageDimensions } from "./usage-breakdown.js";

const atlas = {
  id: "atlas",
  name: "Atlas",
  color: "#5B5BD6",
  shapeSeed: 1,
  avatarCharacter: null,
  deleted: false,
};
const juno = {
  id: "juno",
  name: "Juno",
  color: null,
  shapeSeed: null,
  avatarCharacter: null,
  deleted: true,
};

function cell(fields: Partial<UsageCell> & Pick<UsageCell, "inputTokens" | "outputTokens">) {
  return {
    bot: atlas,
    provider: "anthropic",
    model: "sonnet",
    category: "complex",
    hasRun: true,
    runs: 1,
    compactions: 0,
    ...fields,
  } satisfies UsageCell;
}

const cells: UsageCell[] = [
  cell({ runs: 4, inputTokens: 400, outputTokens: 40 }),
  cell({ model: "haiku", category: "fast", runs: 2, inputTokens: 100, outputTokens: 20 }),
  cell({
    model: "haiku",
    category: "compaction",
    hasRun: false,
    runs: 0,
    compactions: 3,
    inputTokens: 300,
    outputTokens: 30,
  }),
  cell({
    bot: juno,
    model: "gemma",
    category: null,
    hasRun: false,
    runs: 0,
    inputTokens: 50,
    outputTokens: 5,
  }),
];

describe("pivotUsage", () => {
  it("averages a bot over its runs only, its compaction counting in its totals", () => {
    const { totals, rows } = pivotUsage(cells, "bots");
    expect(totals).toMatchObject({ inputTokens: 850, outputTokens: 95 });
    expect(rows.map((row) => row.key)).toEqual(["atlas", "juno"]);
    expect(rows[0]).toMatchObject({ inputTokens: 800, outputTokens: 90 });
    expect(usageAverage(rows[0]!)).toEqual({
      per: "run",
      count: 6,
      inputTokens: 500 / 6,
      outputTokens: 60 / 6,
    });
    expect(usageAverage(rows[1]!)).toBeNull();
  });

  it("averages the compaction row per pass, and keeps it when focused on it", () => {
    const { rows } = pivotUsage(cells, "categories");
    expect(rows.map((row) => row.key)).toEqual(["complex", "compaction", "fast", "unrecorded"]);
    const focused = pivotUsage(cells, "bots", { dimension: "categories", key: "compaction" });
    expect(focused.rows).toHaveLength(1);
    expect(usageAverage(focused.rows[0]!)).toEqual({
      per: "compaction",
      count: 3,
      inputTokens: 100,
      outputTokens: 10,
    });
  });

  it("filters to the focus and drops its own tab", () => {
    const focus = { dimension: "bots" as const, key: "atlas" };
    expect(usageDimensions(focus)).toEqual(["models", "categories"]);
    const { totals, rows } = pivotUsage(cells, "models", focus);
    expect(totals.inputTokens).toBe(800);
    expect(rows.map((row) => row.key)).toEqual(["anthropic/haiku", "anthropic/sonnet"]);
  });
});

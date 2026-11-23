import type { MessageBlock, ThreadItem } from "@tangow/contracts";

export type RoutineItem = Extract<ThreadItem, { kind: "routine" }>;

export type RoutineRole =
  | { kind: "message"; text: string }
  | {
      kind: "failures";
      count: number;
      since: string;
      folded: readonly string[];
    };

/** What a routine run shows in the thread: its final text, once the run completed with some. */
export function routineShownText(
  finished: { status?: string; result?: string } | null | undefined,
): string | null {
  return (finished?.status === "completed" && finished.result?.trim()) || null;
}

/** The shown text as the message block a reply or a reaction to the routine's message targets. */
export function routineResultBlocks(
  finished: Parameters<typeof routineShownText>[0],
): MessageBlock[] {
  const text = routineShownText(finished);
  return text ? [{ kind: "text", text }] : [];
}

/** A routine's shown result as the bot message it reads as, keyed by the routine's own entry. */
export function routineResultMessage(
  item: RoutineItem,
  text: string,
): Extract<ThreadItem, { kind: "message" }> {
  return {
    kind: "message",
    role: "bot",
    id: item.id,
    ts: item.ts,
    botId: item.botId,
    ...(item.runId ? { runId: item.runId } : {}),
    blocks: [{ kind: "text", text }],
  };
}

export function routineRoles(items: readonly ThreadItem[]): {
  roles: ReadonlyMap<string, RoutineRole>;
  hidden: ReadonlySet<string>;
} {
  const roles = new Map<string, RoutineRole>();
  const hidden = new Set<string>();
  let streak: RoutineItem[] = [];
  const endStreak = () => {
    const newest = streak.pop();
    if (newest) {
      const folded = streak.map((failure) => failure.id);
      for (const id of folded) hidden.add(id);
      roles.set(newest.id, {
        kind: "failures",
        count: folded.length + 1,
        since: streak[0]?.ts ?? newest.ts,
        folded,
      });
    }
    streak = [];
  };
  for (const item of items) {
    if (item.kind !== "routine") {
      endStreak();
      continue;
    }
    const { finished } = item;
    const text = routineShownText(finished);
    if (text) {
      endStreak();
      roles.set(item.id, { kind: "message", text });
    } else if (finished?.status !== "failed") {
      hidden.add(item.id);
    } else {
      const newest = streak.at(-1);
      if (newest && (newest.botId !== item.botId || newest.routineId !== item.routineId)) {
        endStreak();
      }
      streak.push(item);
    }
  }
  endStreak();
  return { roles, hidden };
}

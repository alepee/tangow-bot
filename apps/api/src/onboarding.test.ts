import type * as db from "@tangow/db";
import { describe, expect, it, vi } from "vitest";
import { chooseFocus, dismissFocus, markAppConnected } from "./onboarding.js";

const posted = vi.hoisted(() => [] as Array<{ blocks: unknown[] }>);
const logged = vi.hoisted(() => [] as unknown[]);
vi.mock("@tangow/db", async (original) => ({
  ...(await original<typeof db>()),
  appendCardStateInTransaction: vi.fn(async (_tx, draft) => {
    logged.push(draft);
  }),
  createBotMessageInTransaction: vi.fn(async (_tx, input) => {
    posted.push(input);
    return "posted";
  }),
  threadEventSeq: vi.fn(async () => 1),
}));

/** The bot's cards in its thread's session, and the answers logged against them. */
function fixture(catalog: unknown[]) {
  posted.length = 0;
  logged.length = 0;
  const log = {
    cards: [
      { id: "choice", payload: { blocks: [{ kind: "choice", question: "Focus?", options: [] }] } },
    ],
    answers: [] as Array<{ payload: unknown }>,
  };
  const sessionEntry = {
    findMany: vi.fn(async ({ where }: { where: { type: string } }) =>
      where.type === "card.answered" ? log.answers : log.cards,
    ),
  };
  const tx = { $executeRaw: vi.fn(), sessionEntry };
  const deps = {
    prisma: {
      bot: {
        findFirst: vi.fn(async () => ({
          id: "bot",
          thread: { id: "thread", sessionId: "session" },
        })),
      },
      sessionEntry,
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    },
    events: { notify: vi.fn() },
    connectors: { managedProviders: () => [{ catalog: async () => catalog }] },
  } as unknown as Parameters<typeof chooseFocus>[0];
  const actor = {
    userId: "user",
    spaceId: "space",
    email: "user@tangow.test",
    isDeploymentOwner: true,
  };
  return { deps, actor, tx, log };
}

describe("onboarding connection suggestions", () => {
  it("does not invent authorization cards when no connector has an app catalog", async () => {
    const { deps, actor } = fixture([]);
    await chooseFocus(deps, actor, "bot", "day");
    expect(posted.flatMap((message) => message.blocks)).not.toContainEqual(
      expect.objectContaining({ kind: "app_connect" }),
    );
    expect(posted.length).toBeGreaterThan(0);
  });
  it("uses the available connector and omits unavailable apps", async () => {
    const { deps, actor } = fixture([
      { connectorId: "mcp", slug: "slack", name: "Slack", connected: false, logo: null },
    ]);
    await chooseFocus(deps, actor, "bot", "day");
    expect(
      posted
        .flatMap((message) => message.blocks)
        .filter((block) => (block as { kind: string }).kind === "app_connect"),
    ).toEqual([expect.objectContaining({ connectorId: "mcp", provider: "slack", name: "Slack" })]);
    expect(logged).toEqual([
      { type: "card.answered", botId: "bot", payload: { target: "choice", answerId: "day" } },
    ]);
  });
});

it("logs a focus card put away without a choice as dismissed", async () => {
  const { deps, actor } = fixture([]);
  await dismissFocus(deps, actor, "bot");
  expect(logged).toEqual([
    { type: "card.answered", botId: "bot", payload: { target: "choice", dismissed: true } },
  ]);
});

const slackCards = ["composio", "mcp"].map((connectorId) => ({
  kind: "app_connect",
  connectorId,
  provider: "slack",
  name: "Slack",
  description: "Search, read, and send messages.",
  logo: null,
  status: "pending",
}));

it("marks only the authorized connector when provider slugs collide", async () => {
  const { deps, actor, log } = fixture([]);
  log.cards = [{ id: "cards", payload: { blocks: slackCards } }] as never;
  await markAppConnected(deps, actor, "bot", "slack", "mcp");
  expect(logged).toEqual([
    {
      type: "card.answered",
      botId: "bot",
      payload: { target: "cards", answerId: "mcp:slack" },
    },
  ]);
  expect(deps.events.notify).toHaveBeenCalledWith("thread", 1);
});

it("connects an app once, as the answers logged under the thread lock say", async () => {
  const { deps, actor, tx, log } = fixture([]);
  log.cards = [{ id: "cards", payload: { blocks: slackCards } }] as never;
  // The scan saw the card unanswered; by the time the write holds the lock, a tap answered it.
  tx.$executeRaw.mockImplementation(async () => {
    log.answers = [{ payload: { target: "cards", answerId: "composio:slack" } }];
  });

  await markAppConnected(deps, actor, "bot", "slack");

  expect(tx.$executeRaw).toHaveBeenCalled();
  expect(logged).toEqual([]);
  expect(deps.events.notify).not.toHaveBeenCalled();
});

import { readFileSync } from "node:fs";
import type { ProductEvent, ThreadEntry } from "@tangow/contracts";
import { SessionEntrySchema, toThreadEntry } from "@tangow/contracts";
import { describe, expect, it } from "vitest";
import { isToolActivityBlock } from "../tool-activity.js";
import { linkEntries } from "./fixtures/read-fixture.js";
import type { ProgressLayer, ThreadEntries } from "./project-thread-view.js";
import {
  appendedEntries,
  applyEntryEvent,
  drawsNothing,
  mergeEntries,
  projectThreadView,
  reduceProgressLayer,
  threadEntriesOf,
  unshownRunReport,
  visibleEntries,
  withOlderEntries,
  withRefreshedEntries,
} from "./project-thread-view.js";

const streamed = readFileSync(new URL("./fixtures/streamed-reply.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((line) => SessionEntrySchema.parse(JSON.parse(line)));
const upTo = (last: number) => streamed.slice(0, last + 1);

const model = { provider: "emulator", id: "emulator-1" };
const at = (second: number) => `2026-10-10T09:00:${String(second).padStart(2, "0")}.000Z`;
const text = (value: string) => [{ kind: "text", text: value }];
const ada = { botId: "bot_ada", runId: "run_str_1" };
const alone = { firstOfGroup: true, lastOfGroup: true, reactions: [] };

function event(type: string, payload: Record<string, unknown>, runId?: string): ProductEvent {
  return {
    id: `evt-${type}`,
    spaceId: "space_1",
    threadId: "thread_1",
    botId: "bot_ada",
    seq: 1,
    type,
    ...(runId ? { runId } : {}),
    createdAt: at(5),
    payload,
  } as ProductEvent;
}

function streamedProgress(runId: string, ...deltas: string[]): ProgressLayer {
  return deltas.reduce<ProgressLayer>(
    (layer, delta) => reduceProgressLayer(layer, event("thread.progress", { delta }, runId)),
    new Map(),
  );
}

const firstMessage = {
  item: {
    kind: "message",
    role: "user",
    id: "str-00",
    ts: at(0),
    blocks: text("Find three competitors and summarize Acme's site"),
    clientNonce: "nonce-find",
    source: "app",
  },
  ...alone,
  marker: { at: at(0), withTime: true },
  messageId: "str-00",
};
const search = {
  label: "Web search",
  count: 1,
  calls: [
    {
      name: "web_search",
      input: '{"query":"Acme competitors"}',
      output: "Globex, Initech",
      id: "call_search",
    },
  ],
};
const scoutCall = (answer: { output: string; sessionId?: string }) => ({
  label: "Run subagent",
  count: 1,
  calls: [
    {
      name: "run_subagent",
      input: '{"name":"scout","task":"List competitors"}',
      ...answer,
      id: "call_scout",
    },
  ],
});
const finishedRun = {
  item: {
    kind: "run",
    id: "str-01",
    ts: at(1),
    ...ada,
    trigger: { kind: "message", entryId: "str-00" },
    model,
    effort: null,
    finished: {
      outcome: { status: "completed", usage: { inputTokens: 1500, outputTokens: 40 } },
      durationMs: 9000,
    },
  },
  ...alone,
};
const answered = {
  item: {
    kind: "message",
    role: "bot",
    id: "str-02",
    ts: at(2),
    ...ada,
    blocks: [
      {
        kind: "steps",
        steps: [search, scoutCall({ output: "Globex, Initech", sessionId: "ses_scout" })],
        durationMs: 9000,
      },
      { kind: "text", text: "Acme, Globex, Initech" },
      { kind: "ask", text: "Compare prices too?", status: "answered" },
    ],
  },
  ...alone,
  messageId: "str-06",
};
const yes = {
  item: {
    kind: "message",
    role: "user",
    id: "str-08",
    ts: at(8),
    blocks: text("Yes"),
    replyTo: { entryId: "str-07" },
    clientNonce: "nonce-yes",
    source: "app",
  },
  ...alone,
  messageId: "str-08",
};
const summary = (...blocks: object[]) => ({
  item: {
    kind: "message",
    role: "bot",
    id: "str-09",
    ts: at(9),
    ...ada,
    blocks: [{ kind: "text", text: "Summary of https://acme.example" }, ...blocks],
  },
  ...alone,
  messageId: "str-09",
});

describe("projectThreadView on a streamed reply", () => {
  it("keeps each message to the person in its own row as the run adds its final answer", () => {
    const chain = linkEntries("posted", [
      {
        ...ada,
        type: "assistant.text",
        payload: { blocks: text("Checking the report."), toPerson: true, midTurn: true },
      },
      {
        ...ada,
        type: "assistant.text",
        payload: { blocks: text("The report is ready."), toPerson: true, midTurn: true },
      },
    ]);
    const messages = (entries: readonly ThreadEntry[]) =>
      projectThreadView(entries).rows.flatMap(({ item }) =>
        item.kind === "message" ? [{ id: item.id, blocks: item.blocks }] : [],
      );

    expect(messages(chain.slice(0, 1))).toEqual([
      { id: "posted-0", blocks: text("Checking the report.") },
    ]);
    expect(messages(chain)).toEqual([
      { id: "posted-0", blocks: text("Checking the report.") },
      { id: "posted-1", blocks: text("The report is ready.") },
    ]);
  });

  it("shows the open run's steps and the streamed text mid-run, while its helper works", () => {
    const view = projectThreadView(upTo(4), {
      progress: streamedProgress("run_str_1", "Looking at ", "the results"),
    });
    expect(view.rows).toEqual([
      firstMessage,
      { ...finishedRun, item: { ...finishedRun.item, finished: null } },
      {
        item: {
          kind: "message",
          role: "bot",
          id: "str-02",
          ts: at(2),
          ...ada,
          blocks: [{ kind: "steps", steps: [search, scoutCall({ output: "" })] }],
        },
        ...alone,
        lastOfGroup: false,
      },
      {
        item: {
          kind: "message",
          role: "bot",
          id: "progress:run_str_1",
          ts: at(5),
          ...ada,
          blocks: [{ kind: "progress", text: "Looking at the results" }],
          live: true,
        },
        ...alone,
        firstOfGroup: false,
      },
    ]);
    expect(view.waiting).toBeNull();
    expect(view.rowOf.get("str-04")).toBe("str-02");
  });

  it("shows the answered ask and the preview once the reply is in", () => {
    const view = projectThreadView(upTo(11));
    expect(view.rows).toEqual([
      firstMessage,
      finishedRun,
      answered,
      yes,
      {
        ...summary({
          kind: "link_preview",
          url: "https://acme.example",
          format: "compact",
          title: "Acme",
        }),
        previewMessageId: "str-09",
      },
    ]);
    expect(view.waiting).toBeNull();
    expect(["str-07", "str-10", "str-11"].map((id) => [id, view.rowOf.get(id)])).toEqual([
      ["str-07", "str-02"],
      ["str-10", "str-01"],
      ["str-11", "str-09"],
    ]);
  });

  it("cuts the edited turn at the rewind, marks it and drops the removed preview", () => {
    const view = projectThreadView([...streamed].reverse());
    expect(view.rows).toEqual([
      firstMessage,
      finishedRun,
      answered,
      yes,
      summary(),
      { item: { kind: "divider", id: "str-17", ts: at(17), reason: "rewind" }, ...alone },
      {
        item: {
          kind: "message",
          role: "user",
          id: "str-18",
          ts: at(18),
          blocks: text("And for Globex?"),
          clientNonce: "nonce-globex",
          source: "app",
        },
        ...alone,
        messageId: "str-18",
      },
    ]);
    expect(view.rowOf.get("str-12")).toBe("str-09");
    expect(view.rowOf.has("str-15")).toBe(false);
  });
});

describe("projectThreadView rewind", () => {
  const peer = { botId: "bot_bob", runId: "run_peer" };
  const peerFinished = {
    ...peer,
    type: "run.finished",
    payload: { status: "completed", usage: { inputTokens: 1, outputTokens: 1 } },
  };

  it("cuts the held turn after a parent the server held back, keeping what came before", () => {
    const [one, , two, , reply, rewind, edited] = linkEntries("hid", [
      { type: "user.message", payload: { blocks: text("One"), source: "app" } },
      peerFinished,
      { type: "user.message", payload: { blocks: text("Two"), source: "app" } },
      { ...peer, type: "assistant.text", payload: { blocks: text("Peer aside") } },
      { ...ada, type: "assistant.text", payload: { blocks: text("About two") } },
      { type: "rewind", parentId: "hid-1", payload: {} },
      { type: "user.message", payload: { blocks: text("Two edited"), source: "app" } },
    ]);
    const rows = projectThreadView([one!, two!, reply!, rewind!, edited!]).rows;
    expect(rows.map((row) => row.item.id)).toEqual(["hid-0", "hid-5", "hid-6"]);
  });

  it("keeps the turn before a rewind on a page read along the chain, its parent held back", () => {
    const [one, , rewind, edited] = linkEntries("chn", [
      { type: "user.message", payload: { blocks: text("One"), source: "app" } },
      peerFinished,
      { type: "rewind", payload: {} },
      { type: "user.message", payload: { blocks: text("Two edited"), source: "app" } },
    ]);
    const rows = projectThreadView([one!, rewind!, edited!]).rows;
    expect(rows.map((row) => row.item.id)).toEqual(["chn-0", "chn-2", "chn-3"]);
  });
});

describe("projectThreadView clear", () => {
  it("marks a clear written for an edited first message as an edit, a plain clear as a clear", () => {
    const [first, edit, edited, clear] = linkEntries("edt", [
      { type: "user.message", payload: { blocks: text("Hi"), source: "app" } },
      { type: "clear", parentId: null, payload: { edit: true } },
      { type: "user.message", payload: { blocks: text("Hello"), source: "app" } },
      { type: "clear", parentId: null, payload: {} },
    ]);
    expect(projectThreadView([first!, edit!, edited!]).rows.map((row) => row.item)).toEqual([
      { kind: "divider", id: "edt-1", ts: at(1), reason: "rewind" },
      expect.objectContaining({ id: "edt-2" }),
    ]);
    expect(projectThreadView([first!, edit!, edited!, clear!]).rows.map((row) => row.item)).toEqual(
      [{ kind: "divider", id: "edt-3", ts: at(3), reason: "clear" }],
    );
  });
});

describe("projectThreadView cards", () => {
  const run = { botId: "bot_ada", runId: "run_1" };
  const started = {
    ...run,
    type: "run.started",
    payload: { trigger: { kind: "direct" }, model, effort: null },
  };

  it("waits on an open ask, then shows the answer given in the card, absorbing its record", () => {
    const chain = linkEntries("ans", [
      started,
      { ...run, type: "assistant.ask", payload: { block: { kind: "ask", text: "Which day?" } } },
      { type: "card.answered", payload: { target: "ans-1", answer: "Tuesday" } },
      {
        type: "user.message",
        payload: { blocks: text("Tuesday"), replyTo: { entryId: "ans-1" }, source: "card" },
      },
    ]);
    expect(projectThreadView(chain.slice(0, 2)).waiting).toEqual({
      itemId: "ans-1",
      entryId: "ans-1",
      runId: "run_1",
    });
    const view = projectThreadView(chain);
    expect(view.rows.map((row) => row.item)).toEqual([
      expect.objectContaining({ kind: "run", id: "ans-0" }),
      {
        kind: "message",
        role: "bot",
        id: "ans-1",
        ts: at(1),
        ...run,
        blocks: [{ kind: "ask", text: "Which day?", status: "answered", answer: "Tuesday" }],
      },
    ]);
    expect(view.waiting).toBeNull();
    expect(["ans-2", "ans-3"].map((id) => view.rowOf.get(id))).toEqual(["ans-1", "ans-1"]);
    expect(projectThreadView(chain.slice(3)).rows).toEqual([]);
  });

  it("in a group, waits on the viewer's own card while another person's newer card stays open", () => {
    const ask = (runId: string, question: string) => ({
      botId: "bot_ada",
      runId,
      type: "assistant.ask",
      payload: { block: { kind: "ask", text: question } },
    });
    const chain = linkEntries("two", [
      { ...started, runId: "run_mine" },
      ask("run_mine", "Which day?"),
      { ...started, runId: "run_theirs" },
      ask("run_theirs", "Which city?"),
    ]);
    const view = projectThreadView(chain, { othersRun: (runId) => runId === "run_theirs" });
    expect(view.waiting).toEqual({ itemId: "two-1", entryId: "two-1", runId: "run_mine" });
    expect(view.open.map((card) => card.runId)).toEqual(["run_mine", "run_theirs"]);
  });

  it("shows a multi-question card's answers given in the card", () => {
    const ask = {
      kind: "ask",
      text: "A few questions",
      questions: [
        {
          id: "city",
          question: "Which city should I start with?",
          options: [
            { id: "paris", label: "Paris" },
            { id: "lyon", label: "Lyon" },
          ],
        },
      ],
    };
    const answers = { city: { selected: ["paris"] } };
    const chain = linkEntries("multi", [
      started,
      { ...run, type: "assistant.ask", payload: { block: ask } },
      { type: "card.answered", payload: { target: "multi-1", answers } },
      {
        type: "user.message",
        payload: {
          blocks: text("1. Which city should I start with? — Paris"),
          replyTo: { entryId: "multi-1" },
          source: "card",
        },
      },
    ]);
    expect(projectThreadView(chain).rows.map((row) => row.item)).toEqual([
      expect.objectContaining({ kind: "run", id: "multi-0" }),
      {
        kind: "message",
        role: "bot",
        id: "multi-1",
        ts: at(1),
        ...run,
        blocks: [{ ...ask, status: "answered", answers }],
      },
    ]);
  });

  it("answers a secret ask with nothing and an onboarding choice with the option picked", () => {
    const chain = linkEntries("set", [
      started,
      {
        ...run,
        type: "assistant.ask",
        payload: { block: { kind: "ask", text: "Code", input: "secret" } },
      },
      { type: "card.answered", payload: { target: "set-1" } },
      {
        botId: "bot_ada",
        type: "bot.text",
        payload: {
          blocks: [
            {
              kind: "choice",
              question: "What first?",
              options: [
                { id: "inbox", letter: "A", label: "Clear my inbox" },
                { id: "week", letter: "B", label: "Plan my week" },
              ],
            },
          ],
        },
      },
      { type: "card.answered", payload: { target: "set-3", answerId: "week" } },
    ]);
    const blocks = projectThreadView(chain).rows.flatMap((row) =>
      row.item.kind === "message" ? row.item.blocks : [],
    );
    expect(blocks).toEqual([
      { kind: "ask", text: "Code", input: "secret", status: "answered", answer: "" },
      {
        kind: "choice",
        question: "What first?",
        options: [
          { id: "inbox", letter: "A", label: "Clear my inbox" },
          { id: "week", letter: "B", label: "Plan my week" },
        ],
        answerId: "week",
      },
    ]);
  });

  it("connects only the onboarding card whose connector and app the answer names", () => {
    const card = (provider: string) => ({
      kind: "app_connect",
      connectorId: "composio",
      provider,
      name: provider,
      description: "",
      logo: null,
      status: "pending",
    });
    const chain = linkEntries("con", [
      { botId: "bot_ada", type: "bot.text", payload: { blocks: [card("gmail"), card("slack")] } },
      { type: "card.answered", payload: { target: "con-0", answerId: "composio:slack" } },
    ]);
    const statuses = projectThreadView(chain).rows.flatMap((row) =>
      row.item.kind === "message"
        ? row.item.blocks.map((block) => block.kind === "app_connect" && block.status)
        : [],
    );
    expect(statuses).toEqual(["pending", "connected"]);
  });

  it("keeps a taught skill's newest draft revision", () => {
    const playbook = {
      whenToUse: "Mornings",
      inputs: [],
      steps: ["Read the news"],
      howToCheck: "Three items",
      whatToReturn: "A digest",
      approvalBoundaries: "None",
      failureHandling: "Say so",
    };
    const draft = { skillId: "skill_digest", goal: "Summarize the news", playbook };
    const chain = linkEntries("drf", [
      {
        botId: "bot_ada",
        type: "bot.text",
        payload: {
          blocks: [{ kind: "skill_draft", ...draft, name: "Digest", status: "draft" }],
        },
      },
      {
        type: "skill.draft",
        payload: { target: "drf-0", ...draft, name: "Morning digest", status: "draft" },
      },
      {
        type: "skill.draft",
        payload: { target: "drf-0", ...draft, name: "Morning digest", status: "saved" },
      },
    ]);
    const view = projectThreadView(chain);
    expect(view.rows.map((row) => row.item)).toEqual([
      {
        kind: "message",
        role: "bot",
        id: "drf-0",
        ts: at(0),
        botId: "bot_ada",
        blocks: [{ kind: "skill_draft", ...draft, name: "Morning digest", status: "saved" }],
      },
    ]);
    expect(view.rowOf.get("drf-2")).toBe("drf-0");
  });

  it("shows an approval's edit, the action tapped and the routine it created", () => {
    const card = {
      kind: "ask",
      text: "Create this routine?",
      approvalEffectId: "eff_1",
      actions: [
        { id: "allow", label: "Allow" },
        { id: "always", label: "Always allow" },
        { id: "deny", label: "Deny" },
      ],
      proposal: "routine",
      routine: { name: "Digest", schedule: "0 7 * * *", prompt: "News", notify: true },
    };
    const edited = { ...card, routine: { ...card.routine, name: "Morning digest" } };
    const chain = linkEntries("eff", [
      started,
      {
        ...run,
        type: "effect.requested",
        payload: {
          effectId: "eff_1",
          effectKind: "create_routine",
          proposal: { name: "Digest" },
          card,
        },
      },
      {
        ...run,
        type: "effect.edited",
        payload: { effectId: "eff_1", proposal: { name: "Morning digest" }, card: edited },
      },
      {
        ...run,
        type: "effect.resolved",
        payload: { effectId: "eff_1", decision: "approved", answerId: "always" },
      },
      {
        ...run,
        type: "effect.applied",
        payload: { target: "eff-1", routineId: "rtn_1", change: "created" },
      },
    ]);
    expect(projectThreadView(chain.slice(0, 3)).waiting).toEqual({
      itemId: "eff-1",
      entryId: "eff-1",
      runId: "run_1",
    });
    const view = projectThreadView(chain);
    expect(view.rows[1]).toEqual({
      item: {
        kind: "effect",
        id: "eff-1",
        ts: at(1),
        effectId: "eff_1",
        effectKind: "create_routine",
        proposal: { name: "Morning digest" },
        decision: "approved",
        ...run,
        card: {
          ...edited,
          status: "answered",
          answer: "always",
          created: { kind: "routine", id: "rtn_1", label: "Morning digest" },
          confirms: "created",
        },
      },
      ...alone,
      messageId: "eff-1",
    });
    expect(view.waiting).toBeNull();
  });
});

describe("projectThreadView rows", () => {
  it("folds a helper into the run's message, its call carrying the helper's session", () => {
    const helper = '{"name":"scout","task":"Look"}';
    const chain = linkEntries("par", [
      {
        ...ada,
        type: "tool.call",
        payload: { callId: "call_web", name: "web_search", input: "{}" },
      },
      {
        ...ada,
        type: "tool.call",
        payload: { callId: "call_scout", name: "run_subagent", input: helper },
      },
      {
        ...ada,
        type: "tool.result",
        payload: { callId: "call_web", output: "Found", isError: false, artifactIds: [] },
      },
      {
        ...ada,
        type: "subagent",
        payload: {
          callId: "call_scout",
          sessionId: "ses_scout",
          name: "scout",
          model,
          task: "Look",
          status: "completed",
          result: "Seen",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      },
      { ...ada, type: "assistant.text", payload: { blocks: text("Done") } },
    ]);
    const view = projectThreadView(chain);
    expect(view.rows).toEqual([
      {
        item: {
          kind: "message",
          role: "bot",
          id: "par-0",
          ts: at(0),
          ...ada,
          blocks: [
            {
              kind: "steps",
              steps: [
                {
                  label: "Web search",
                  count: 1,
                  calls: [{ name: "web_search", input: "{}", output: "Found", id: "call_web" }],
                },
                {
                  label: "Run subagent",
                  count: 1,
                  calls: [
                    {
                      name: "run_subagent",
                      input: helper,
                      output: "Seen",
                      id: "call_scout",
                      sessionId: "ses_scout",
                    },
                  ],
                },
              ],
            },
            { kind: "text", text: "Done" },
          ],
        },
        ...alone,
        marker: { at: at(0), withTime: true },
        messageId: "par-4",
      },
    ]);
    expect(["par-1", "par-2", "par-3", "par-4"].map((id) => view.rowOf.get(id))).toEqual([
      "par-0",
      "par-0",
      "par-0",
      "par-0",
    ]);
  });

  it("folds emoji-only replies under their message, keeping one whose message is not held", () => {
    const reply = (target: string, value: string) => ({
      type: "user.message",
      payload: { blocks: text(value), replyTo: { entryId: target }, source: "app" },
    });
    const chain = linkEntries("rx", [
      { botId: "bot_ada", type: "bot.text", payload: { blocks: text("Shipped.") } },
      reply("rx-0", "👍"),
      reply("rx-0", "❤️"),
      reply("rx-0", "👍"),
      reply("gone", "🎉"),
    ]);
    const view = projectThreadView(chain);
    expect(view.rows.map((row) => [row.item.id, row.reactions])).toEqual([
      [
        "rx-0",
        [
          ["👍", 2],
          ["❤️", 1],
        ],
      ],
      ["rx-4", []],
    ]);
    expect(view.rowOf.get("rx-3")).toBe("rx-0");
  });

  it("groups narration of one bot and opens a group at a reply", () => {
    const chain = linkEntries("grp", [
      { botId: "bot_ada", type: "bot.text", payload: { blocks: text("One.") } },
      { botId: "bot_ada", type: "bot.text", payload: { blocks: text("Two.") } },
      { type: "user.message", payload: { blocks: text("Hi"), source: "app" } },
      {
        type: "user.message",
        payload: { blocks: text("About two"), replyTo: { entryId: "grp-1" }, source: "app" },
      },
    ]);
    expect(projectThreadView(chain).rows.map((row) => [row.firstOfGroup, row.lastOfGroup])).toEqual(
      [
        [true, false],
        [false, true],
        [true, true],
        [true, true],
      ],
    );
  });

  it("gives a row the message its preview entry targets, the row's own for an inline card", () => {
    const preview = {
      kind: "link_preview",
      url: "https://example.com/",
      format: "compact",
      title: "Example",
    };
    const bodies = [
      { ...ada, type: "assistant.text", payload: { blocks: text("Let me look.") } },
      { ...ada, type: "tool.call", payload: { callId: "c1", name: "web_fetch", input: "{}" } },
      {
        ...ada,
        type: "tool.result",
        payload: { callId: "c1", output: "ok", isError: false, artifactIds: [] },
      },
      { ...ada, type: "assistant.text", payload: { blocks: text("See https://example.com/") } },
      { type: "link.preview", payload: { target: "pv-3", block: preview } },
    ];
    const reply = (entries: ThreadEntry[]) =>
      projectThreadView(entries).rows.find((row) => row.item.id === "pv-0");
    expect(reply(linkEntries("pv", bodies))).toMatchObject({
      messageId: "pv-0",
      previewMessageId: "pv-3",
    });
    const removal = { type: "link.preview.removed", payload: { target: "pv-4" } };
    expect(reply(linkEntries("pv", [...bodies, removal]))?.previewMessageId).toBeUndefined();

    const inline = linkEntries("in", [
      { botId: "bot_ada", type: "bot.text", payload: { blocks: [...text("Look"), preview] } },
    ]);
    expect(projectThreadView(inline).rows[0]?.previewMessageId).toBe("in-0");
  });

  it("adds a mention next to the card, and removing the card keeps the mention", () => {
    const card = {
      kind: "link_preview",
      url: "https://a.test/post",
      format: "compact",
      title: "Post",
    };
    const mention = { kind: "link_mention", url: "https://b.test/doc", title: "Doc" };
    const bodies = [
      {
        type: "user.message",
        payload: { blocks: text("https://a.test/post https://b.test/doc"), source: "app" },
      },
      { type: "link.preview", payload: { target: "lm-0", block: card } },
      { type: "link.preview", payload: { target: "lm-0", block: mention } },
    ];
    const blocks = (entries: ThreadEntry[]) =>
      projectThreadView(entries).rows.find((row) => row.item.id === "lm-0")?.item;
    expect(blocks(linkEntries("lm", bodies))).toMatchObject({
      blocks: [...text("https://a.test/post https://b.test/doc"), card, mention],
    });
    const removal = { type: "link.preview.removed", payload: { target: "lm-1" } };
    expect(blocks(linkEntries("lm", [...bodies, removal]))).toMatchObject({
      blocks: [...text("https://a.test/post https://b.test/doc"), mention],
    });
  });

  it("adds a routine result's card and mentions to its routine, and removing the card keeps the mention", () => {
    const card = {
      kind: "link_preview",
      url: "https://a.test/post",
      format: "compact",
      title: "Post",
    };
    const mention = { kind: "link_mention", url: "https://b.test/doc", title: "Doc" };
    const routine = { botId: "bot_ada", runId: "run_digest" };
    const bodies = [
      {
        ...routine,
        type: "routine.started",
        payload: {
          sessionId: "ses_digest",
          routineId: "rtn_digest",
          name: "Digest",
          trigger: "routine",
          scheduledAt: at(0),
          model,
        },
      },
      {
        ...routine,
        type: "routine.finished",
        payload: {
          status: "completed",
          usage: { inputTokens: 1, outputTokens: 1 },
          result: "https://a.test/post and https://b.test/doc",
        },
      },
      { type: "link.preview", payload: { target: "rl-1", block: card } },
      { type: "link.preview", payload: { target: "rl-1", block: mention } },
    ];
    const row = (entries: ThreadEntry[]) =>
      projectThreadView(entries).rows.find((candidate) => candidate.item.id === "rl-0");
    expect(row(linkEntries("rl", bodies))).toMatchObject({
      item: { kind: "routine", links: [card, mention] },
      routine: { kind: "message", text: "https://a.test/post and https://b.test/doc" },
      previewMessageId: "rl-1",
      messageId: "rl-0",
    });
    const removal = { type: "link.preview.removed", payload: { target: "rl-2" } };
    const removed = row(linkEntries("rl", [...bodies, removal]));
    expect(removed?.item).toMatchObject({ kind: "routine", links: [mention] });
    expect(removed?.previewMessageId).toBeUndefined();
  });

  it("replays a routine history as its words, its folded failures and nothing for silent runs", () => {
    const usage = { inputTokens: 1, outputTokens: 1 };
    const routine = (n: number, outcome: Record<string, unknown>) => [
      {
        botId: "bot_ada",
        runId: `run_r${n}`,
        type: "routine.started",
        payload: {
          sessionId: `ses_r${n}`,
          routineId: "rtn_digest",
          name: "Digest",
          trigger: "routine",
          scheduledAt: at(0),
          model,
        },
      },
      {
        botId: "bot_ada",
        runId: `run_r${n}`,
        type: "routine.finished",
        payload: { usage, result: "", ...outcome },
      },
    ];
    const chain = linkEntries("rtn", [
      ...routine(1, { status: "completed", result: " \n" }),
      ...routine(2, { status: "completed", result: "Invoice due Thursday.\n" }),
      {
        botId: "bot_ada",
        type: "bot.message.sent",
        payload: {
          originSessionId: "ses_r2",
          to: { kind: "bot", botId: "bot_bea", name: "Bea" },
          text: "Invoice due",
          intent: "result",
          hop: 1,
          exchangeId: "rtn-4",
        },
      },
      ...routine(3, { status: "failed", error: "429 Too Many Requests" }),
      ...routine(4, { status: "cancelled" }),
      ...routine(5, { status: "failed", error: "boom" }),
    ]);
    const item = (entry: number, n: number, finished: Record<string, unknown>) => ({
      kind: "routine",
      id: `rtn-${entry}`,
      ts: at(entry),
      runId: `run_r${n}`,
      botId: "bot_ada",
      sessionId: `ses_r${n}`,
      routineId: "rtn_digest",
      name: "Digest",
      finished,
    });
    const spoke = {
      ...item(2, 2, { status: "completed", result: "Invoice due Thursday.\n" }),
      ts: at(3),
    };
    const view = projectThreadView(chain);
    expect(view.rows).toEqual([
      {
        item: spoke,
        ...alone,
        routine: { kind: "message", text: "Invoice due Thursday." },
        marker: { at: at(3), withTime: true },
        messageId: "rtn-2",
      },
      {
        item: {
          kind: "botMessage",
          direction: "sent",
          id: "rtn-4",
          ts: at(4),
          botId: "bot_ada",
          peer: { kind: "bot", botId: "bot_bea", name: "Bea" },
          text: "Invoice due",
          intent: "result",
          exchangeId: "rtn-4",
          answeredBy: null,
          origin: { sessionId: "ses_r2", kind: "routine", name: "Digest" },
        },
        ...alone,
      },
      {
        item: item(9, 5, { status: "failed", result: "", failure: "other" }),
        ...alone,
        routine: { kind: "failures", count: 2, since: at(5), folded: ["rtn-5"] },
      },
    ]);
    expect(["rtn-0", "rtn-6", "rtn-7", "rtn-10"].map((id) => view.rowOf.get(id))).toEqual([
      undefined,
      "rtn-9",
      undefined,
      "rtn-9",
    ]);
  });

  it("keeps a routine's words above the message its run sent to another bot", () => {
    const usage = { inputTokens: 1, outputTokens: 1 };
    const entries = linkEntries("ord", [
      {
        botId: "bot_ada",
        runId: "run_o",
        type: "routine.started",
        payload: {
          sessionId: "ses_o",
          routineId: "rtn_digest",
          name: "Digest",
          trigger: "routine",
          scheduledAt: at(0),
          model,
        },
      },
      { type: "user.message", payload: { blocks: text("Anything new?"), source: "app" } },
      {
        botId: "bot_ada",
        type: "bot.message.sent",
        payload: {
          originSessionId: "ses_o",
          to: { kind: "bot", botId: "bot_bea", name: "Bea" },
          text: "Invoice due",
          intent: "result",
          hop: 1,
          exchangeId: "ord-2",
        },
      },
      {
        botId: "bot_ada",
        runId: "run_o",
        type: "routine.finished",
        payload: { usage, status: "completed", result: "Invoice due Thursday." },
      },
    ]);
    expect(
      projectThreadView(entries).rows.map((row) => [row.item.kind, row.routine?.kind ?? null]),
    ).toEqual([
      ["message", null],
      ["routine", "message"],
      ["botMessage", null],
    ]);
  });

  it("stacks failure lines of different routines, and marks only a new day between them", () => {
    const failure = (n: number, routineId: string, ts: string) =>
      [
        {
          type: "routine.started",
          payload: {
            sessionId: `ses_f${n}`,
            routineId,
            name: routineId,
            trigger: "routine",
            scheduledAt: ts,
            model,
          },
        },
        {
          type: "routine.finished",
          payload: {
            status: "failed",
            error: "boom",
            result: "",
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        },
      ].map((body) => ({ ...body, botId: "bot_ada", runId: `run_f${n}`, ts }));
    const chain = linkEntries("fl", [
      ...failure(1, "rtn_a", "2026-10-10T09:00:00.000Z"),
      ...failure(2, "rtn_b", "2026-10-10T09:30:00.000Z"),
      ...failure(3, "rtn_a", "2026-10-11T09:00:00.000Z"),
    ]);
    expect(
      projectThreadView(chain).rows.map(({ item, marker, chained }) => [item.id, marker, chained]),
    ).toEqual([
      ["fl-0", { at: "2026-10-10T09:00:00.000Z", withTime: false }, undefined],
      ["fl-2", undefined, true],
      ["fl-4", { at: "2026-10-11T09:00:00.000Z", withTime: false }, undefined],
    ]);
  });

  it("places a routine's words where its run finished, after what was said while it worked", () => {
    const chain = linkEntries("rw", [
      {
        botId: "bot_ada",
        runId: "run_r1",
        type: "routine.started",
        payload: {
          sessionId: "ses_r1",
          routineId: "rtn_digest",
          name: "Digest",
          trigger: "routine",
          scheduledAt: at(0),
          model,
        },
      },
      { type: "user.message", payload: { blocks: text("Any news?"), source: "app" } },
      { botId: "bot_ada", type: "bot.text", payload: { blocks: text("Checking.") } },
      {
        botId: "bot_ada",
        runId: "run_r1",
        type: "routine.finished",
        payload: {
          status: "completed",
          usage: { inputTokens: 1, outputTokens: 1 },
          result: "Invoice due Thursday.",
        },
      },
    ]);
    expect(projectThreadView(chain).rows.map(({ item }) => [item.id, item.kind, item.ts])).toEqual([
      ["rw-1", "message", at(1)],
      ["rw-2", "message", at(2)],
      ["rw-0", "routine", at(3)],
    ]);
  });

  it("starts a group at a routine's words, and again at the bot's next reply", () => {
    const reply = (words: string) => ({
      botId: "bot_ada",
      type: "bot.text",
      payload: { blocks: text(words) },
    });
    const chain = linkEntries("grp", [
      reply("Morning."),
      {
        botId: "bot_ada",
        runId: "run_r1",
        type: "routine.started",
        payload: {
          sessionId: "ses_r1",
          routineId: "rtn_digest",
          name: "Digest",
          trigger: "routine",
          scheduledAt: at(0),
          model,
        },
      },
      reply("Still here."),
      {
        botId: "bot_ada",
        runId: "run_r1",
        type: "routine.finished",
        payload: {
          status: "completed",
          usage: { inputTokens: 1, outputTokens: 1 },
          result: "Invoice due Thursday.",
        },
      },
      reply("Anything else?"),
    ]);
    expect(
      projectThreadView(chain).rows.map((row) => [row.item.id, row.firstOfGroup, row.lastOfGroup]),
    ).toEqual([
      ["grp-0", true, false],
      ["grp-2", false, true],
      ["grp-1", true, true],
      ["grp-4", true, true],
    ]);
  });
});

describe("projectThreadView image stacks", () => {
  const shot = (name: string) => ({
    kind: "image",
    artifactId: `art_${name}`,
    mimeType: "image/png",
    name: `${name}.png`,
  });
  const botShot = (name: string, extra: object = {}) => ({
    botId: "bot_ada",
    type: "bot.text",
    payload: { blocks: [shot(name)] },
    ...extra,
  });
  const userPhotos = (names: string[], caption?: string) => ({
    type: "user.message",
    payload: {
      blocks: [...(caption ? text(caption) : []), ...names.map(shot)],
      source: "app",
    },
  });
  const react = (target: string) => ({
    type: "user.message",
    payload: { blocks: text("👍"), replyTo: { entryId: target }, source: "app" },
  });
  const stackSizes = (chain: ThreadEntry[]) =>
    projectThreadView(chain, { imageStacks: true }).rows.map(
      (row) => row.imageStack?.images.length ?? null,
    );

  it("stacks three screenshots sent as three messages into one row", () => {
    const chain = linkEntries("stk", [botShot("a"), botShot("b"), botShot("c")]);
    const view = projectThreadView(chain, { imageStacks: true });
    expect(view.rows.map((row) => row.item.id)).toEqual(["stk-0"]);
    expect(view.rows[0]?.imageStack).toMatchObject({
      images: [
        { messageId: "stk-0", artifactId: "art_a", name: "a.png", mimeType: "image/png" },
        { messageId: "stk-1", artifactId: "art_b" },
        { messageId: "stk-2", artifactId: "art_c" },
      ],
      front: { item: { id: "stk-2" }, messageId: "stk-2" },
    });
    expect([...(view.rows[0]?.imageStack?.messageIds ?? [])]).toEqual([
      ["stk-0", "stk-0"],
      ["stk-1", "stk-1"],
      ["stk-2", "stk-2"],
    ]);
    expect(["stk-0", "stk-1", "stk-2"].map((id) => view.rowOf.get(id))).toEqual([
      "stk-0",
      "stk-0",
      "stk-0",
    ]);
  });

  it("keeps a lone image, a different bot, text, a reply and a late image apart", () => {
    const late = { ts: "2026-10-10T09:06:00.000Z" };
    expect(stackSizes(linkEntries("one", [botShot("a")]))).toEqual([1]);
    expect(
      stackSizes(linkEntries("bot", [botShot("a"), botShot("b", { botId: "bot_bob" })])),
    ).toEqual([1, 1]);
    expect(
      stackSizes(
        linkEntries("txt", [
          botShot("a"),
          { botId: "bot_ada", type: "bot.text", payload: { blocks: text("Look") } },
          botShot("b"),
        ]),
      ),
    ).toEqual([1, null, 1]);
    expect(
      stackSizes(
        linkEntries("rep", [
          userPhotos(["a"]),
          {
            type: "user.message",
            payload: { blocks: [shot("b")], replyTo: { entryId: "rep-0" }, source: "app" },
          },
        ]),
      ),
    ).toEqual([1, 1]);
    expect(stackSizes(linkEntries("late", [botShot("a"), botShot("b", late)]))).toEqual([1, 1]);
  });

  it("ends a stack at an image that has a reaction, and shows the reaction under the front image", () => {
    const chain = linkEntries("rct", [botShot("a"), botShot("b"), react("rct-1"), botShot("c")]);
    const view = projectThreadView(chain, { imageStacks: true });
    expect(view.rows.map((row) => [row.item.id, row.imageStack?.images.length])).toEqual([
      ["rct-0", 2],
      ["rct-3", 1],
    ]);
    expect(view.rows[0]?.reactions).toEqual([["👍", 1]]);
    expect(view.rowOf.get("rct-2")).toBe("rct-0");
  });

  it("hosts a person's photos in the message that carries the caption", () => {
    const chain = linkEntries("usr", [
      userPhotos(["p1", "p2", "p3", "p4"], "Trip"),
      userPhotos(["p5", "p6", "p7", "p8"]),
    ]);
    const view = projectThreadView(chain, { imageStacks: true });
    expect(view.rows.map((row) => row.item.id)).toEqual(["usr-0"]);
    expect(view.rows[0]?.imageStack?.images.map((image) => image.name)).toEqual(
      ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"].map((name) => `${name}.png`),
    );
    expect(view.rows[0]?.imageStack?.front.messageId).toBe("usr-1");
  });

  it("draws a row per message and no stack without the option", () => {
    const chain = linkEntries("off", [botShot("a"), botShot("b")]);
    const rows = projectThreadView(chain).rows;
    expect(rows.map((row) => [row.item.id, row.imageStack])).toEqual([
      ["off-0", undefined],
      ["off-1", undefined],
    ]);
  });
});

describe("visibleEntries", () => {
  const peer = { botId: "bot_sub", runId: "run_peer" };
  const chain = linkEntries("vis", [
    { type: "user.message", payload: { blocks: text("Ask the team"), source: "app" } },
    { ...peer, type: "run.started", payload: { trigger: { kind: "direct" }, model, effort: null } },
    { ...peer, type: "tool.call", payload: { callId: "c1", name: "search", input: "{}" } },
    { ...peer, type: "assistant.text", payload: { blocks: text("Working on it") } },
    { ...peer, type: "assistant.text", payload: { blocks: text("Found it"), toPerson: true } },
    { ...peer, type: "assistant.ask", payload: { block: { kind: "ask", text: "Which?" } } },
    { type: "card.answered", ...peer, payload: { target: "vis-5", answerId: "first" } },
  ]);

  it("keeps a hidden peer run's words to the person, its cards and their answers", () => {
    const ids = (entries: ThreadEntry[]) => entries.map((entry) => entry.id);
    const hiddenPeerRunIds = new Set(["run_peer"]);
    expect(ids(visibleEntries(chain, { hiddenPeerRunIds }))).toEqual([
      "vis-0",
      "vis-4",
      "vis-5",
      "vis-6",
    ]);
  });
});

describe("unshownRunReport", () => {
  const digest = { botId: "bot_ada", runId: "run_digest" };
  const usage = { inputTokens: 1, outputTokens: 1 };
  const run = (...middle: object[]) =>
    linkEntries("rep", [
      {
        ...digest,
        type: "routine.started",
        payload: {
          sessionId: "ses_digest",
          routineId: "rtn_digest",
          name: "Digest",
          trigger: "routine",
          scheduledAt: at(0),
          model,
        },
      },
      ...middle,
      {
        ...digest,
        type: "routine.finished",
        payload: { status: "completed", usage, result: " Three new invoices\n" },
      },
    ]);

  it("gives the report of a run that ended without a closing message", () => {
    const progress = { blocks: text("Checking the inbox"), midTurn: true };
    const file = {
      blocks: [{ kind: "file", artifactId: "art_1", mimeType: "text/csv", name: "a.csv", size: 1 }],
    };
    expect(unshownRunReport(run(), "run_digest")).toBe("Three new invoices");
    for (const payload of [progress, file]) {
      expect(
        unshownRunReport(run({ ...digest, type: "assistant.text", payload }), "run_digest"),
      ).toBe("Three new invoices");
    }
  });

  it("leaves the report to the run's closing message, and to another run's view", () => {
    const closing = { ...digest, type: "assistant.text", payload: { blocks: text("Three") } };
    expect(unshownRunReport(run(closing), "run_digest")).toBeUndefined();
    expect(unshownRunReport(run(), "run_other")).toBeUndefined();
  });
});

describe("the entry feed", () => {
  const sessionChain = linkEntries("feed", [
    { type: "user.message", payload: { blocks: text("Hello"), source: "app" } },
    {
      botId: "bot_ada",
      runId: "run_1",
      type: "assistant.text",
      payload: { blocks: text("Hello there.") },
    },
  ]);
  const chain = sessionChain.map(toThreadEntry);

  it("clears a run's streamed text when its entry lands, so the text shows once", () => {
    const streaming = streamedProgress("run_1", "Hello there.");
    const appended = event("session.entry.appended", { entries: [chain[1]] }, "run_1");
    const layer = reduceProgressLayer(streaming, appended);
    expect([...layer.keys()]).toEqual([]);
    const held = mergeEntries(chain.slice(0, 1), appendedEntries(appended));
    expect(
      projectThreadView(held, { progress: layer }).rows.flatMap((row) =>
        row.item.kind === "message" ? row.item.blocks : [],
      ),
    ).toEqual([
      { kind: "text", text: "Hello" },
      { kind: "text", text: "Hello there." },
    ]);
    expect(reduceProgressLayer(streaming, event("run.completed", {}, "run_1")).size).toBe(0);
    expect(reduceProgressLayer(streaming, event("thread.meta", {}))).toBe(streaming);
  });

  it("keeps a run's tool line on while it logs its calls, their results and a helper's", () => {
    const work = linkEntries("work", [
      {
        botId: "bot_ada",
        runId: "run_1",
        type: "tool.call",
        payload: { callId: "call_1", name: "read", input: '{"path":"src/app.ts"}' },
      },
      {
        botId: "bot_ada",
        runId: "run_1",
        type: "tool.result",
        payload: { callId: "call_1", output: "…", isError: false, artifactIds: [] },
      },
      {
        botId: "bot_ada",
        runId: "run_1",
        type: "subagent",
        payload: {
          callId: "call_2",
          name: "scout",
          model,
          task: "Read the tests",
          status: "completed",
          result: "Read them.",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      },
    ]).map(toThreadEntry);
    const working = reduceProgressLayer(
      new Map(),
      event("thread.progress", { text: "Reading src/app.ts", activity: true }, "run_1"),
    );
    const layer = work
      .map((entry) => [entry])
      .reduce(
        (held, entries) =>
          reduceProgressLayer(held, event("session.entry.appended", { entries }, "run_1")),
        working,
      );
    // As web and iPhone draw it: the live row holding only the tool line draws nothing.
    const view = projectThreadView(mergeEntries(chain.slice(0, 1), work), {
      progress: layer,
      rendersNothing: (item) =>
        drawsNothing(item, (blocks) => blocks.some((block) => !isToolActivityBlock(block))),
    });
    expect(view.rows.map((row) => row.item.id)).not.toContain("progress:run_1");
    expect(view.activityLabel).toBe("Reading src/app.ts");
  });

  it("merges a replayed event and an overlapping page without adding an entry twice", () => {
    const ids = (entries: ThreadEntry[]) => entries.map((entry) => entry.id);
    const merged = mergeEntries([chain[1]!], chain);
    expect(ids(merged)).toEqual(["feed-0", "feed-1"]);
    expect(ids(mergeEntries(merged, [chain[1]!]))).toEqual(["feed-0", "feed-1"]);
    expect(appendedEntries(event("session.entry.appended", { entries: [{ id: "x" }] }))).toEqual(
      [],
    );
  });
});

describe("the entries a client holds", () => {
  const said = linkEntries(
    "held",
    ["Zero", "One", "Two", "Three"].map((words) => ({
      type: "user.message",
      payload: { blocks: text(words), source: "app" },
    })),
  );
  const held = (entries: ThreadEntry[], olderCursor: string | null): ThreadEntries => ({
    entries,
    olderCursor: olderCursor as ThreadEntries["olderCursor"],
    cursor: 3,
    layer: new Map(),
  });
  const ids = (state: ThreadEntries) => state.entries.map((entry) => entry.id);
  const at = (seq: number, type: string, payload: Record<string, unknown>, runId?: string) => ({
    ...event(type, payload, runId),
    seq,
  });

  it("merges an appended entry by seq and ignores the same event replayed", () => {
    const appended = at(5, "session.entry.appended", { entries: [said[1]] });
    const next = applyEntryEvent(held([said[0]!, said[2]!], null), appended);
    expect(ids(next)).toEqual(["held-0", "held-1", "held-2"]);
    expect(next.cursor).toBe(5);
    expect(applyEntryEvent(next, appended)).toBe(next);
  });

  it("streams a run's text, ignores a delta replayed and clears it when the entry lands", () => {
    const delta = at(4, "thread.progress", { delta: "Hel" }, "run_1");
    const streaming = applyEntryEvent(applyEntryEvent(held([], null), delta), delta);
    expect(streaming.layer.get("run_1")?.blocks).toEqual([{ kind: "progress", text: "Hel" }]);
    const reply = { ...said[0]!, botId: "bot_ada", runId: "run_1" };
    const settled = applyEntryEvent(
      streaming,
      at(5, "session.entry.appended", { entries: [reply] }, "run_1"),
    );
    expect([...settled.layer.keys()]).toEqual([]);
  });

  it("seeds the layer from the progress a snapshot replays", () => {
    const seeded = threadEntriesOf({
      threadId: "thread_1",
      progress: [at(2, "thread.progress", { delta: "Hel" }, "run_1")],
    });
    expect(seeded.threadId).toBe("thread_1");
    expect([...seeded.layer.keys()]).toEqual(["run_1"]);
  });

  it("merges an older page before the held entries and moves the history cursor", () => {
    const page = { entries: [said[0]!, said[1]!, said[2]!], olderCursor: null };
    const next = withOlderEntries(held([said[2]!, said[3]!], "held-2"), page);
    expect(ids(next)).toEqual(["held-0", "held-1", "held-2", "held-3"]);
    expect(next.olderCursor).toBeNull();
    const cleared = held([], null);
    expect(withOlderEntries(cleared, page)).toBe(cleared);
  });

  it("keeps loaded history older than a refreshed page and the older cursor", () => {
    const stale = { ...said[2]!, payload: { blocks: text("Stale two"), source: "app" } };
    const previous = held([said[0]!, said[1]!, stale as ThreadEntry], null);
    const recent = held([said[2]!, said[3]!], "held-2");

    const kept = withRefreshedEntries(previous, recent, true);
    expect(kept.entries).toEqual([said[0], said[1], said[2], said[3]]);
    expect(kept.olderCursor).toBeNull();
    expect(withRefreshedEntries(previous, recent, false)).toBe(recent);
  });

  it("drops a jump window the refreshed page does not connect to", () => {
    const jumped = held([said[0]!, said[1]!].map(detached(10)), "held-10");
    const recent = held([said[2]!, said[3]!].map(detached(20)), "held-20");
    expect(withRefreshedEntries(jumped, recent, true)).toBe(recent);
  });
});

function detached(by: number) {
  return (entry: ThreadEntry): ThreadEntry =>
    SessionEntrySchema.parse({
      ...entry,
      id: `held-${entry.seq + by}`,
      seq: entry.seq + by,
      parentId: `held-${entry.seq + by - 1}`,
    });
}

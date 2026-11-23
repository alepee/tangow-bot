import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { ORPCError } from "@orpc/client";
import type {
  Bot,
  BotActivityInput,
  BotActivityItem,
  Routine,
  RunActivityRow,
  SessionEntry,
} from "@tangow/contracts";
import { SaveStoreProvider } from "@tangow/ui-web";
import { useCallback, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { setDebugMode } from "../../src/lib/debug-mode";
import { saveStore as store } from "../../src/lib/save-store";
import { applyResolvedAppearance } from "../../src/lib/ui-appearance";
import { BotPage } from "../../src/pages/bot-page/BotPage";
import type { BotCommands, RunView, UpdateBotPatch } from "../../src/pages/shell/bot-commands";
import type { BotDetail, BotPageView, BotTab } from "../../src/pages/shell/layout";
import { panelSizeFor } from "../../src/pages/shell/layout";
import { usePanelEscape } from "../../src/pages/shell/panel-escape";
import { SessionView } from "../../src/pages/shell/session-view";
import "../../src/styles.css";

/*
 * The bot page without a server. Query parameters pick what it shows:
 *   tab=activity|routines|knowledge|settings
 *   detail=instructions|description|model|voice|routine|routine-new   routine=<id>
 *   new=1 (a bot just created by hand: no instructions, only its birth)   busy=1 (the bot is working)
 *   activity=empty|error (what reading the activity answers; by default 39 routine runs
 *   and 3 creations, 30 a page; a routine's page reads only its runs)
 *   fail=1 (every save fails)   refuse=1 (the server refuses a computer change)   theme=dark
 *   debug=1 (debug mode: Activity also lists the runs started from chat, and a run opens its log)
 *   read=loading|error (the page's read of the bot and its routines never answers, or fails
 *   until "Fail reads" is unchecked; the routines stay unknown until a read answers)
 * Writes go through in-memory commands that answer after 400 ms; reads are
 * answered by a stubbed fetch with fixed data. A refusal carries the server's
 * reason like a real RPC error; fail=1 fails like a dropped connection.
 */
const params = new URLSearchParams(window.location.search);
const NEW = params.get("new") === "1";
const BUSY = params.get("busy") === "1";
const ACTIVITY = params.get("activity");
const REFUSE = params.get("refuse") === "1";
const READ = params.get("read");
const SAVE_DELAY = 400;

applyResolvedAppearance(params.get("theme") === "dark" ? "dark" : "light");
setDebugMode(params.get("debug") === "1");

// The app activates the global catalog; module-level `t` calls read it too.
i18n.loadAndActivate({ locale: "en", messages: {} });

const BOT: Bot = {
  id: "bot-scout",
  spaceId: "space-1",
  name: "Scout",
  title: "Watches the inbox and flags what needs you",
  description: "Keeps the shared inbox down to what needs a person.",
  instructions: NEW
    ? ""
    : "You watch the shared inbox for the team and surface only what needs a person. You never reply to a sender yourself.\n\nEvery weekday morning, group what arrived overnight into three buckets: needs a decision, needs a reply, can wait.",
  color: "#3BC9A0",
  shapeSeed: null,
  avatarCharacter: "scout",
  notifyOnFinish: true,
  pinned: false,
  sectionId: null,
  archivedAt: null,
  unread: false,
  parentBotId: null,
  memoryScope: null,
  threadId: "thread-1",
  preview: "",
  status: BUSY ? "running" : "idle",
  computerMode: "dedicated",
  updatedAt: "2026-10-06T08:00:00.000Z",
  createdAt: "2026-09-01T08:00:00.000Z",
  voiceId: null,
  autoSpeak: false,
  chattyReplies: true,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  teamChatAmbientEnabled: false,
  teamChatRules: "",
  webhookConfigured: false,
  spawnKey: null,
  isOwner: true,
};

const HOUR = 60 * 60 * 1000;
const at = (offset: number) => new Date(Date.now() + offset).toISOString();

function routine(id: string, name: string, extra: Partial<Routine> = {}): Routine {
  return {
    id,
    botId: BOT.id,
    name,
    prompt: `${name}.`,
    crons: ["0 9 * * 1-5"],
    timezone: "Europe/Paris",
    active: true,
    notify: true,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    requireToolApproval: false,
    lastRunAt: at(-10 * HOUR),
    lastRunStatus: "succeeded",
    lastRunFailureKind: null,
    nextRunAt: at(14 * HOUR),
    createdAt: "2026-09-01T08:00:00.000Z",
    ...extra,
  };
}

const ROUTINES: Routine[] = [
  routine("routine-1", "Morning digest"),
  routine("routine-2", "Weekly digest", {
    crons: ["0 9 * * 1"],
    prompt:
      "Every Monday morning, sum up last week's inbox for the team: what was decided, what is still waiting, and what arrives next week. Five lines at most.",
    lastRunAt: at(-26 * HOUR),
    lastRunStatus: "failed",
    lastRunFailureKind: "provider",
    messageProvider: "slack",
  }),
  routine("routine-3", "Invoice watch", {
    crons: [],
    webhookEnabled: true,
    active: false,
    nextRunAt: null,
  }),
];

function run(index: number, hoursAgo: number, extra: Partial<RunActivityRow>): RunActivityRow {
  return {
    runId: `run-${String(index).padStart(2, "0")}`,
    botId: BOT.id,
    botName: BOT.name,
    groupId: null,
    groupName: null,
    threadId: BOT.threadId,
    status: "completed",
    trigger: "routine",
    notificationsEnabled: true,
    promptSnippet: "",
    createdAt: at(-hoursAgo * HOUR),
    updatedAt: at(-hoursAgo * HOUR),
    routineId: null,
    routineName: null,
    sourceMessageId: `message-${index}`,
    startedAt: at(-hoursAgo * HOUR - 60_000),
    completedAt: at(-hoursAgo * HOUR),
    failureKind: null,
    ...extra,
  };
}

const sweep = { routineId: "routine-1", routineName: "Morning digest" } as const;
const digest = { routineId: "routine-2", routineName: "Weekly digest" } as const;
const invoices = { routineId: "routine-3", routineName: "Invoice watch" } as const;

/** Newest first: one running, a day of routine runs, then a long tail to page through. */
const RUNS: RunActivityRow[] = NEW
  ? []
  : [
      run(0, 0.05, { ...sweep, status: "running", completedAt: null }),
      run(1, 1, invoices),
      run(2, 2, { ...digest, status: "failed", failureKind: "provider" }),
      run(4, 24, sweep),
      run(5, 25, sweep),
      run(6, 26, sweep),
      run(7, 28, invoices),
      ...Array.from({ length: 32 }, (_, offset) =>
        run(8 + offset, 48 + offset * 8, offset % 5 === 4 ? invoices : sweep),
      ),
    ];

/** Runs started from chat, which only debug mode lists. */
const chat = { trigger: "user" } as const;
const CHAT_RUNS: RunActivityRow[] = NEW
  ? []
  : [
      run(50, 0.5, {
        ...chat,
        promptSnippet: "Compare flights from Paris to Copenhagen on Nov 14",
      }),
      run(51, 1.5, {
        ...chat,
        promptSnippet: "Draft a reply to the supplier about the late invoice",
      }),
      run(52, 3, {
        ...chat,
        promptSnippet: "Prepare the agenda for Thursday's committee",
        status: "failed",
        failureKind: "missing_model",
      }),
      run(53, 25.5, { ...chat, promptSnippet: "Find a slot with Lea next week" }),
    ];

/** What each run left in its thread; run-07 said nothing. */
const RECAPS: Record<string, string | null> = {
  "run-01":
    "**2 invoices** arrived from Northwind.\n\n- INV-2041 · 1,280 € · due Oct 20\n- INV-2042 · 640 € · due Oct 27\n\nBoth match the purchase orders. Nothing to approve today.",
  "run-04": [
    "**Overnight inbox** · 14 messages",
    "",
    "**Needs a decision**",
    "- Lease renewal for the Lyon office: the landlord wants an answer by Friday.",
    "- Two candidates for the support role asked to move their interviews.",
    "",
    "**Needs a reply**",
    "- Acme asked whether the October invoice can be split in two.",
    "- The accountant needs the signed engagement letter.",
    "- A customer reports the export button does nothing on Safari.",
    "",
    "**Can wait**",
    "- Three newsletters, two webinar invitations and a survey.",
    "- The quarterly team lunch poll closes next week.",
  ].join("\n"),
  "run-07": null,
};

/** A chat run's log, for the run dialog: its start, its words, one tool call and its end. */
function runLog(row: RunActivityRow): SessionEntry[] {
  const finishedAt = row.completedAt ?? row.updatedAt;
  const base = (seq: number, ts: string) => ({
    id: `${row.runId}-entry-${seq}`,
    sessionId: "session-1",
    seq,
    parentId: seq === 0 ? null : `${row.runId}-entry-${seq - 1}`,
    ts,
    botId: BOT.id,
    runId: row.runId,
  });
  const started = row.startedAt ?? row.createdAt;
  const step = (seq: number) => new Date(Date.parse(started) + seq * 4_000).toISOString();
  return [
    {
      ...base(0, started),
      type: "run.started",
      payload: {
        trigger: { kind: "message", entryId: `message-${row.runId}` },
        model: { provider: "anthropic", id: "claude-sonnet" },
        effort: "medium",
      },
    },
    {
      ...base(1, step(1)),
      type: "tool.call",
      payload: { callId: "call-1", name: "web_search", input: '{"query":"flights"}' },
    },
    {
      ...base(2, step(2)),
      type: "tool.result",
      payload: { callId: "call-1", output: "3 results", isError: false, artifactIds: [] },
    },
    {
      ...base(3, step(3)),
      type: "assistant.text",
      payload: { blocks: [{ kind: "text", text: `Done: ${row.promptSnippet}.` }] },
    },
    {
      ...base(4, finishedAt),
      type: "run.finished",
      payload:
        row.status === "failed"
          ? {
              status: "failed",
              usage: { inputTokens: 1_840, outputTokens: 96 },
              error: "Connect a model in Settings before running bots.",
            }
          : { status: "completed", usage: { inputTokens: 12_480, outputTokens: 612 } },
    },
  ] as SessionEntry[];
}

type Entry = { at: string; id: string; item: BotActivityItem };

const CREATIONS: Entry[] = [
  ...(NEW
    ? []
    : [
        {
          at: at(-40 * HOUR),
          id: "routine-3",
          item: {
            kind: "routine_created" as const,
            routineId: "routine-3",
            routineName: "Invoice watch",
            createdAt: at(-40 * HOUR),
            byBotName: BOT.name,
          },
        },
        {
          at: "2026-09-02T08:00:00.000Z",
          id: "routine-2",
          item: {
            kind: "routine_created" as const,
            routineId: "routine-2",
            routineName: "Weekly digest",
            createdAt: "2026-09-02T08:00:00.000Z",
            byBotName: null,
          },
        },
      ]),
  {
    at: BOT.createdAt,
    id: BOT.id,
    item: { kind: "bot_created", botId: BOT.id, botName: BOT.name, createdAt: BOT.createdAt },
  },
];

const ACTIVE = new Set(["queued", "leased", "running", "waiting_input", "waiting_takeover"]);

function listActivity(input: BotActivityInput) {
  const runs = (input.allRuns && !input.routineId ? [...RUNS, ...CHAT_RUNS] : RUNS).filter(
    (row) => !input.routineId || row.routineId === input.routineId,
  );
  const entries: Entry[] = [
    ...runs
      .filter((row) => !ACTIVE.has(row.status))
      .map((row) => ({
        at: row.createdAt,
        id: row.runId,
        item: { kind: "routine_run" as const, run: row },
      })),
    ...(input.routineId ? [] : CREATIONS),
  ].sort((left, right) => right.at.localeCompare(left.at));
  const start = input.cursor ? entries.findIndex((entry) => entry.id === input.cursor?.id) + 1 : 0;
  const limit = input.limit ?? 30;
  const page = entries.slice(start, start + limit);
  const last = page.at(-1);
  return {
    items: [
      ...(input.cursor
        ? []
        : runs
            .filter((row) => ACTIVE.has(row.status))
            .map((row) => ({ kind: "routine_run" as const, run: row }))),
      ...page.map((entry) => entry.item),
    ],
    nextCursor: last && start + limit < entries.length ? { createdAt: last.at, id: last.id } : null,
  };
}

const READS: Record<string, unknown> = {
  "bots/sharing": { visibility: "private", userIds: [], connectors: [] },
  "models/credentials": [
    {
      id: "credential-1",
      provider: "anthropic",
      label: "Anthropic",
      hasKey: true,
      isDefault: true,
      thinkingLevel: "medium",
    },
  ],
  "models/list": [
    {
      provider: "anthropic",
      providerName: "Anthropic",
      id: "claude-sonnet",
      label: "Claude Sonnet",
      billing: "api",
      thinkingLevels: ["low", "medium", "high"],
    },
    {
      provider: "anthropic",
      providerName: "Anthropic",
      id: "claude-haiku",
      label: "Claude Haiku",
      billing: "api",
    },
  ],
  me: {
    userId: "user-1",
    email: "person@example.test",
    name: "Person",
    spaceId: "space-1",
    isDeploymentOwner: true,
    needsModel: false,
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet",
    sandboxProvider: "docker",
    avatarStyle: "organic",
  },
  "voice/voices": [
    { id: "warm", label: "Warm" },
    { id: "bright", label: "Bright" },
  ],
  "memory/list": [
    {
      id: "memory-1",
      scope: "bot",
      botId: BOT.id,
      path: "MEMORY.md",
      content: "# Scout\n\nCounsel prefers a reply before 10:00.",
      revision: 4,
      updatedAt: "2026-10-05T08:00:00.000Z",
    },
  ],
  "agentSkills/list": [
    {
      id: "skill-1",
      name: "inbox-triage",
      description: "Sorts a mailbox into decide, reply, wait.",
      source: "user",
      readOnly: false,
      availability: "all",
      visibleBotIds: [BOT.id],
    },
  ],
  "agentSkills/get": {
    id: "skill-1",
    name: "inbox-triage",
    description: "Sorts a mailbox into decide, reply, wait.",
    source: "user",
    readOnly: false,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-05T08:00:00.000Z",
    content:
      "---\nname: inbox-triage\ndescription: Sorts a mailbox into decide, reply, wait.\n---\n\nRead every unread email. Put each one under Decide, Reply or Wait, newest first.\n",
  },
  "scratchpad/list": [],
  "computer/files": [
    { path: "notes", kind: "dir", size: 0 },
    { path: "inbox-report.md", kind: "file", size: 3_200 },
    { path: "q3-forecast.csv", kind: "file", size: 12_400 },
    { path: "renewals.md", kind: "file", size: 2_050 },
    { path: "team-notes.md", kind: "file", size: 4_800 },
    { path: "vendors.csv", kind: "file", size: 9_300 },
  ],
  "bots/list": [],
};

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  if (!url.pathname.startsWith("/rpc/")) return realFetch(input, init);
  const procedure = url.pathname.slice("/rpc/".length);
  await delay(150);
  const body = input instanceof Request ? await input.text() : String(init?.body ?? "{}");
  const query = (JSON.parse(body) as { json?: Record<string, unknown> }).json ?? {};
  if (procedure === "bots/activity") {
    if (ACTIVITY === "error") {
      return Response.json({ json: { message: "The server did not answer." } }, { status: 500 });
    }
    return Response.json({
      json:
        ACTIVITY === "empty"
          ? { items: [], nextCursor: null }
          : listActivity(query as BotActivityInput),
    });
  }
  if (procedure === "runs/entries") {
    const row = [...RUNS, ...CHAT_RUNS].find((candidate) => candidate.runId === query.runId);
    return Response.json({ json: { entries: row ? runLog(row) : [] } });
  }
  if (procedure === "runs/recap") {
    const runId = String(query.runId);
    const text = runId in RECAPS ? RECAPS[runId] : `Done: ${runId}.`;
    return Response.json({
      json: { text: text ?? null, messageId: text === null ? null : `message-${runId}` },
    });
  }
  const json = READS[procedure];
  if (json === undefined) {
    return Response.json(
      { json: { message: `${procedure} is not in this fixture` } },
      { status: 404 },
    );
  }
  return Response.json({ json });
};

function isTab(value: string | null): value is BotTab {
  return (
    value === "activity" || value === "routines" || value === "knowledge" || value === "settings"
  );
}

function initialDetail(value: string | null): BotDetail | null {
  if (value === "routine") {
    return { kind: "routine", routineId: params.get("routine") ?? "routine-2" };
  }
  if (value === "routine-new") return { kind: "routine-new" };
  if (value === "memory") return { kind: "memory", documentId: "memory-1" };
  if (value === "skill") return { kind: "skill", skillId: "skill-1" };
  if (
    value === "instructions" ||
    value === "description" ||
    value === "model" ||
    value === "voice"
  ) {
    return { kind: value };
  }
  return null;
}

function Fixture() {
  const [bot, setBot] = useState(BOT);
  const botRef = useRef(bot);
  botRef.current = bot;
  const [routines, setRoutines] = useState(ROUTINES);
  const routinesRef = useRef(routines);
  routinesRef.current = routines;
  const [fail, setFail] = useState(params.get("fail") === "1");
  const failRef = useRef(fail);
  failRef.current = fail;
  const [routinesRead, setRoutinesRead] = useState(READ === null);
  const [failReads, setFailReads] = useState(READ === "error");
  const failReadsRef = useRef(failReads);
  failReadsRef.current = failReads;
  const webhookKeyRef = useRef("whsec_fixture_0000");
  const [runView, setRunView] = useState<RunView | null>(null);
  const tab = params.get("tab");
  const [view, setView] = useState<BotPageView>({
    tab: isTab(tab) ? tab : "settings",
    detail: initialDetail(params.get("detail")),
  });

  const commands = useMemo<BotCommands>(() => {
    async function write(patch: Partial<Bot>, refusal: string | null): Promise<Bot> {
      await delay(SAVE_DELAY);
      if (refusal) throw new ORPCError("CONFLICT", { message: refusal });
      if (failRef.current) throw new Error("The server did not answer.");
      const next = { ...botRef.current, ...patch };
      setBot(next);
      return next;
    }
    return {
      updateBot: (_botId, patch: UpdateBotPatch) => write(patch as Partial<Bot>, null),
      setComputer: (_botId, mode) =>
        write(
          { computerMode: mode },
          botRef.current.status === "idle" && !REFUSE
            ? null
            : "Wait for this bot to finish before changing its computer.",
        ),
      async createRoutine(_botId, payload) {
        await delay(SAVE_DELAY);
        if (failRef.current) throw new Error("The server did not answer.");
        const created = routine(`routine-${Date.now()}`, payload.name, {
          ...payload,
          lastRunAt: null,
          lastRunStatus: null,
          nextRunAt: payload.crons.length > 0 ? at(20 * HOUR) : null,
        });
        setRoutines((list) => [...list, created]);
        return created;
      },
      async updateRoutine(_botId, routineId, patch) {
        await delay(SAVE_DELAY);
        if (failRef.current) throw new Error("The server did not answer.");
        const current = routinesRef.current.find((item) => item.id === routineId);
        if (!current) throw new ORPCError("NOT_FOUND", { message: "That routine is gone." });
        const { runAt: _runAt, ...fields } = patch;
        const updated = { ...current, ...fields };
        setRoutines((list) => list.map((item) => (item.id === routineId ? updated : item)));
        return updated;
      },
      async removeRoutine(_botId, routineId) {
        await delay(SAVE_DELAY);
        setRoutines((list) => list.filter((item) => item.id !== routineId));
      },
      testRun: async () => {
        await delay(SAVE_DELAY);
      },
      webhookSecret: async () => {
        await delay(SAVE_DELAY);
        return webhookKeyRef.current;
      },
      rotateWebhookSecret: async () => {
        await delay(SAVE_DELAY);
        webhookKeyRef.current = "whsec_fixture_0001";
        return webhookKeyRef.current;
      },
      botAction: (_botId, action) => console.info(`bot action: ${action}`),
      async refresh() {
        await delay(150);
        if (READ === "loading") await new Promise(() => undefined);
        if (failReadsRef.current) throw new Error("The server did not answer.");
        setRoutinesRead(true);
      },
      refreshRoutines: async () => undefined,
      activityEpoch: 0,
      openRun: (row) => console.info(`open run from ${row.sourceMessageId ?? "the end"}`),
      viewRun: setRunView,
      skillsChanged: () => undefined,
    };
  }, []);

  const closeEditor = useCallback(() => setView((current) => ({ ...current, detail: null })), []);
  const closePanel = useCallback(() => console.info("close panel"), []);
  usePanelEscape({ enabled: true, editorOpen: view.detail !== null, closeEditor, closePanel });

  const size = panelSizeFor("bot", view);
  return (
    <div className="flex h-dvh bg-background text-foreground">
      <main className="flex flex-1 items-start p-4">
        <label className="flex items-center gap-2 text-meta text-muted-foreground">
          <input
            type="checkbox"
            data-testid="fixture-fail-saves"
            checked={fail}
            onChange={(event) => setFail(event.target.checked)}
          />
          Fail saves
        </label>
        <label className="ms-4 flex items-center gap-2 text-meta text-muted-foreground">
          <input
            type="checkbox"
            data-testid="fixture-fail-reads"
            checked={failReads}
            onChange={(event) => setFailReads(event.target.checked)}
          />
          Fail reads
        </label>
      </main>
      <aside
        data-testid="side-panel"
        data-panel="bot"
        data-detail={view.detail?.kind}
        data-size={size}
        className={`flex min-h-0 shrink-0 flex-col overflow-hidden border-s border-border bg-surface shadow-card ${
          size === "wide" ? "w-panel-wide" : "w-panel"
        }`}
      >
        <BotPage
          bot={bot}
          userId="user-1"
          routines={routinesRead ? routines : null}
          memoryProviderConfigured={false}
          view={view}
          onView={setView}
          onClose={closePanel}
          commands={commands}
          messagingProviders={["slack"]}
        />
      </aside>
      {runView ? (
        <SessionView
          target={{ kind: "run", runId: runView.runId, title: runView.title }}
          context={{
            artifactTarget: { botId: runView.botId },
            inGroup: false,
            peerBot: () => ({ color: BOT.color, name: BOT.name }),
            onOpenBot: () => undefined,
            onOpenPeerMessages: () => undefined,
            onRefresh: async () => undefined,
            onBotChanged: async () => undefined,
            onAddRoutine: () => undefined,
          }}
          onClose={() => setRunView(null)}
        />
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <SaveStoreProvider store={store}>
      <Fixture />
    </SaveStoreProvider>
  </I18nProvider>,
);

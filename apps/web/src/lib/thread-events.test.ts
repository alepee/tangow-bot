import { readFileSync } from "node:fs";
import type { ComputerStatus, ProductEvent, ThreadEntry, ThreadSnapshot } from "@tangow/contracts";
import { ThreadEntrySchema } from "@tangow/contracts";
import { projectThreadView, threadEntriesOf } from "@tangow/core";
import { describe, expect, it } from "vitest";
import type { ThreadState } from "./thread-events.js";
import {
  activeThreadRuns,
  applyThreadSendReceipt,
  canTakeComputerControl,
  clearActiveThreadRuns,
  clearBusyWhileWaitingTakeover,
  computerPanelAutoBoot,
  computerPanelAutoUsesBoot,
  computerTakeoverBlocked,
  reconcileRefreshedThread,
  reduceComputerStatus,
  reduceThreadState,
  threadRunError,
  userHoldsComputerControl,
} from "./thread-events.js";

describe("thread event reduction", () => {
  it("shows a committed direct send as queued before its snapshot refresh returns", () => {
    const initial = state([said(4, "Continue")]);

    const next = applyThreadSendReceipt(initial, {
      botId: "bot-1",
      runId: "run-receipt",
      taskId: "task-receipt",
      createdAt: "2026-09-03T21:29:52.000Z",
    });

    expect(next?.run).toMatchObject({
      id: "run-receipt",
      taskId: "task-receipt",
      status: "queued",
    });
    expect(next?.activeRuns).toEqual([next?.run]);
    expect(next?.entries).toBe(initial.entries);
  });

  it("does not replace authoritative active or group run state with a send receipt", () => {
    const active = threadRun("run-active");
    const direct: ThreadState = { ...state(), run: active, activeRuns: [active] };
    const group: ThreadState = { ...state(), groupId: "group-1" };
    const receipt = { botId: "bot-1", runId: "run-new", taskId: "task-new" };
    const completed = { ...threadRun(receipt.runId), status: "completed" as const };

    expect(applyThreadSendReceipt(direct, receipt)).toBe(direct);
    expect(applyThreadSendReceipt(group, receipt)).toBe(group);
    expect(applyThreadSendReceipt({ ...state(), run: completed }, receipt)?.run).toBe(completed);
    expect(applyThreadSendReceipt(state(), receipt, new Set([receipt.runId]))?.run).toBeNull();
  });

  it("ignores a stale thread refresh that is behind the live cursor", () => {
    const live: ThreadState = { ...state([said(11, "Which city?")]), cursor: 12 };
    const stale = { ...wire([said(1, "older")]), cursor: 8 };

    expect(reconcileRefreshedThread(live, stale, null).snapshot).toBe(live);
    expect(reconcileRefreshedThread(live, stale, null, true).snapshot).toBe(live);
  });

  it("event-sources the active run on run.started so Stop does not wait on threads.get", () => {
    const started = reduceThreadState(
      state(),
      event({ type: "run.started", seq: 3, runId: "run-1", payload: { trigger: "user" } }),
    );

    expect(started?.run).toMatchObject({
      id: "run-1",
      botId: "bot-1",
      status: "running",
      trigger: "user",
    });
    expect(started?.activeRuns).toEqual([started?.run]);
  });

  it("keeps the trigger of a peer run and of an inbound wake", () => {
    const peer = reduceThreadState(
      state(),
      event({ type: "run.started", runId: "peer-run-1", payload: { trigger: "bot_message" } }),
    );
    const webhook = reduceThreadState(
      state(),
      event({ type: "run.started", runId: "webhook-run-1", payload: { trigger: "webhook" } }),
    );

    expect(peer?.run?.trigger).toBe("bot_message");
    expect(webhook?.run?.trigger).toBe("webhook");
  });

  it("marks the run as waiting when computer takeover is requested", () => {
    const run = threadRun("run-1");
    const waiting = reduceThreadState(
      { ...state(), run, activeRuns: [run] },
      event({ type: "computer.takeover.requested", seq: 5, runId: run.id }),
    );

    expect(waiting?.run?.status).toBe("waiting_takeover");
    expect(waiting?.activeRuns?.[0]?.status).toBe("waiting_takeover");
  });

  it("inserts a peer takeover run that was absent from the open snapshot", () => {
    const userRun = threadRun("run-user");
    const waiting = reduceThreadState(
      { ...state(), run: userRun, activeRuns: [userRun] },
      event({
        type: "computer.takeover.requested",
        seq: 12,
        runId: "run-peer",
        botId: "bot-peer",
      }),
    );

    expect(waiting?.run).toMatchObject({
      id: "run-peer",
      botId: "bot-peer",
      status: "waiting_takeover",
      trigger: "bot_message",
    });
    expect(waiting?.activeRuns?.map((run) => ({ id: run.id, status: run.status }))).toEqual([
      { id: "run-user", status: "running" },
      { id: "run-peer", status: "waiting_takeover" },
    ]);
  });

  it("keeps event-sourced waiting_takeover when a stale refresh still shows the bot busy", () => {
    const run = threadRun("run-1");
    const waitingLocal: ThreadState = {
      ...state(),
      cursor: 10,
      run: { ...run, status: "waiting_takeover" },
      activeRuns: [{ ...run, status: "waiting_takeover" }],
    };
    const staleRefresh: ThreadSnapshot = {
      ...wire(),
      cursor: 10,
      run,
      activeRuns: [run],
      computer: computer({ state: "running", busyBotName: "Chief" }),
    };

    const reconciled = reconcileRefreshedThread(
      waitingLocal,
      staleRefresh,
      computer({ state: "running", busyBotName: null }),
    );

    expect(reconciled.snapshot.run?.status).toBe("waiting_takeover");
    expect(reconciled.computer?.busyBotName).toBeNull();
    expect(computerTakeoverBlocked(reconciled.computer, reconciled.snapshot.run?.status)).toBe(
      false,
    );
  });

  it("clears the busy banner of a lagging status read while the run waits for takeover", () => {
    const lagging = computer({ busyBotName: "Chief" });

    expect(clearBusyWhileWaitingTakeover(lagging, "waiting_takeover")).toEqual({
      ...lagging,
      busyBotName: null,
    });
    expect(clearBusyWhileWaitingTakeover(lagging, "running")).toBe(lagging);
    expect(clearBusyWhileWaitingTakeover(lagging, undefined)).toBe(lagging);
    expect(clearBusyWhileWaitingTakeover(null, "waiting_takeover")).toBeNull();
  });

  it("ignores a refresh whose cursor is behind the event-sourced snapshot", () => {
    const run = threadRun("run-1");
    const newer: ThreadState = {
      ...state(),
      cursor: 12,
      run: { ...run, status: "waiting_takeover" },
    };
    const older: ThreadSnapshot = {
      ...wire(),
      cursor: 9,
      run,
      computer: computer({ busyBotName: "Chief" }),
    };
    const prevComputer = computer({ busyBotName: null });

    const reconciled = reconcileRefreshedThread(newer, older, prevComputer);

    expect(reconciled.snapshot).toBe(newer);
    expect(reconciled.computer).toBe(prevComputer);
  });

  it("refreshes busy status when only transient thread events are ahead", () => {
    const run = threadRun("run-1");
    const newer: ThreadState = { ...state(), cursor: 12, run };
    const older: ThreadSnapshot = {
      ...wire(),
      cursor: 9,
      run,
      computer: computer({ state: "running", controlHolder: "bot", busyBotName: "Chief" }),
    };

    const reconciled = reconcileRefreshedThread(
      newer,
      older,
      computer({ state: "running", controlHolder: "bot", busyBotName: null }),
    );

    expect(reconciled.snapshot).toBe(newer);
    expect(reconciled.computer?.busyBotName).toBe("Chief");
  });

  it("hydrates a live run from a refresh without rolling back newer progress", () => {
    const run = threadRun("run-1");
    const live = reduceThreadState(
      { ...state(), cursor: 11 },
      progress(12, "run-1", "Still working"),
    );
    const older: ThreadSnapshot = {
      ...wire(),
      cursor: 11,
      run,
      computer: computer({ state: "running", controlHolder: "bot", busyBotName: "Chief" }),
    };

    const reconciled = reconcileRefreshedThread(live, older, computer());

    expect(reconciled.snapshot.cursor).toBe(12);
    expect(reconciled.snapshot.layer).toBe(live?.layer);
    expect(reconciled.snapshot.run).toBe(run);
    expect(reconciled.computer?.busyBotName).toBe("Chief");
  });

  it("clears active runs and their streamed text after stop", () => {
    const run = threadRun("run-1");
    const streaming = reduceThreadState(
      {
        ...state([said(1, "Keep me")]),
        run,
        activeRuns: [run],
        computer: computer({ state: "running", busyBotName: "Chief" }),
      },
      progress(4, "run-1", "Still working"),
    );

    const stopped = clearActiveThreadRuns(streaming!);

    expect(stopped.run).toBeNull();
    expect(stopped.activeRuns).toEqual([]);
    expect([...stopped.layer.keys()]).toEqual([]);
    expect(stopped.entries.map(textOf)).toEqual(["Keep me"]);
    expect(stopped.computer?.busyBotName).toBeNull();
  });

  it("keeps an optimistic stop clear when an older cursor refresh still looks busy", () => {
    const run = threadRun("run-1");
    const stoppedLocal: ThreadState = {
      ...state(),
      cursor: 15,
      run: null,
      activeRuns: [],
      computer: computer({ state: "running", busyBotName: null }),
    };
    const staleBusyRefresh: ThreadSnapshot = {
      ...wire(),
      cursor: 10,
      run,
      activeRuns: [run],
      computer: computer({ state: "running", busyBotName: "Chief" }),
    };

    const reconciled = reconcileRefreshedThread(
      stoppedLocal,
      staleBusyRefresh,
      computer({ state: "running", busyBotName: null }),
    );

    expect(reconciled.snapshot.run).toBeNull();
    expect(reconciled.snapshot.activeRuns).toEqual([]);
    expect(reconciled.computer?.busyBotName).toBeNull();
  });

  it("always replaces the snapshot when switching to a different thread", () => {
    const previous: ThreadState = {
      ...state([said(1, "Writer")]),
      threadId: "thread-writer",
      cursor: 40,
      computer: computer({ mode: "team", busyBotName: null }),
    };
    const next: ThreadSnapshot = {
      ...wire([said(1, "Private")]),
      botId: "bot-private",
      threadId: "thread-private",
      cursor: 0,
      computer: computer({ mode: "dedicated", state: "running" }),
    };

    const reconciled = reconcileRefreshedThread(previous, next, previous.computer ?? null, true);

    expect(reconciled.snapshot.threadId).toBe("thread-private");
    expect(reconciled.snapshot.entries.map(textOf)).toEqual(["Private"]);
    expect(reconciled.computer?.mode).toBe("dedicated");
  });

  it("keeps group member status in sync with run lifecycle events", () => {
    const initial: ThreadState = {
      ...state(),
      botId: undefined,
      groupId: "group-1",
      members: [
        {
          botId: "bot-member",
          name: "Member",
          color: "#8B5CF6",
          shapeSeed: null,
          avatarCharacter: null,
          status: "idle",
          canUse: true,
        },
      ],
    };

    const started = reduceThreadState(
      initial,
      event({ type: "run.started", botId: "bot-member", runId: "run-1" }),
    );
    const completed = reduceThreadState(
      started,
      event({ type: "run.completed", seq: 6, botId: "bot-member", runId: "run-1" }),
    );

    expect(started?.members?.[0]?.status).toBe("running");
    expect(started?.activeRuns?.map((item) => item.id)).toEqual(["run-1"]);
    expect(completed?.members?.[0]?.status).toBe("idle");
    expect(completed?.activeRuns).toEqual([]);
  });

  it("clears only the terminal run's streamed text", () => {
    const runA = threadRun("run-a", "bot-a");
    const runB = threadRun("run-b", "bot-b");
    const streaming = [
      progress(5, "run-a", "A"),
      progress(6, "run-b", "B"),
    ].reduce<ThreadState | null>(reduceThreadState, {
      ...state(),
      run: runA,
      activeRuns: [runA, runB],
    });

    const next = reduceThreadState(
      streaming,
      event({ type: "run.failed", seq: 10, runId: "run-a" }),
    );

    expect([...(next?.layer.keys() ?? [])]).toEqual(["run-b"]);
    expect(next?.run).toEqual(runB);
    expect(next?.activeRuns).toEqual([runB]);
    expect(next?.cursor).toBe(10);
  });

  it("keeps a failed run and its error so the thread can surface the failure", () => {
    const failing = threadRun("run-a");
    const next = reduceThreadState(
      { ...state(), run: failing },
      event({
        type: "run.failed",
        seq: 11,
        runId: failing.id,
        payload: { error: "Provider is not configured: openrouter" },
      }),
    );

    expect(next?.run).toMatchObject({
      id: failing.id,
      status: "failed",
      error: "Provider is not configured: openrouter",
    });
    expect(threadRunError(next)).toBe("Provider is not configured: openrouter");
    expect(threadRunError(next, new Set([failing.id]))).toBeNull();
    expect(threadRunError(next, new Set(["other-run"]))).toBe(
      "Provider is not configured: openrouter",
    );
  });

  it("keeps the error when a member run fails while another member is still running", () => {
    const runA = threadRun("run-a", "bot-a");
    const runB = threadRun("run-b", "bot-b");

    const next = reduceThreadState(
      { ...state(), run: runA, activeRuns: [runA, runB] },
      event({
        type: "run.failed",
        seq: 13,
        botId: "bot-b",
        runId: runB.id,
        payload: { error: "member exploded" },
      }),
    );

    expect(next?.activeRuns).toEqual([runA]);
    expect(next?.run).toMatchObject({ id: runB.id, status: "failed", error: "member exploded" });
    expect(threadRunError(next)).toBe("member exploded");
  });

  it("keeps a group failure visible when another member starts before dismiss", () => {
    const failed = {
      ...threadRun("run-b", "bot-b"),
      status: "failed" as const,
      error: "member exploded",
    };
    const runA = threadRun("run-a", "bot-a");

    const next = reduceThreadState(
      { ...state(), groupId: "group-1", run: failed, activeRuns: [runA] },
      event({ type: "run.started", seq: 14, botId: "bot-c", runId: "run-c" }),
    );

    expect(next?.run).toMatchObject({ id: failed.id, status: "failed", error: "member exploded" });
    expect(next?.activeRuns).toEqual([
      runA,
      expect.objectContaining({ id: "run-c", botId: "bot-c", status: "running" }),
    ]);
    expect(activeThreadRuns({ run: runA, activeRuns: undefined })).toEqual([runA]);
  });

  it("clears the run and reports no error when it completes or fails without a message", () => {
    const finishing = threadRun("run-a");
    const initial: ThreadState = { ...state(), run: finishing };

    const completed = reduceThreadState(
      initial,
      event({ type: "run.completed", seq: 12, runId: finishing.id }),
    );
    const blank = reduceThreadState(
      initial,
      event({ type: "run.failed", seq: 12, runId: finishing.id, payload: { error: "  " } }),
    );

    expect(completed?.run).toBeNull();
    expect(threadRunError(completed)).toBeNull();
    expect(blank?.run).toBeNull();
    expect(threadRunError(blank)).toBeNull();
  });
});

describe("a streamed reply fed through the reducer", () => {
  const fixture = readFileSync(
    new URL(
      "../../../../packages/core/src/session-log/fixtures/streamed-reply.jsonl",
      import.meta.url,
    ),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => ThreadEntrySchema.parse(JSON.parse(line)));
  const entry = (id: string) => fixture.find((candidate) => candidate.id === id)!;
  const appendedAt = (seq: number, ...ids: string[]) =>
    event({
      id: `appended-${seq}`,
      seq,
      type: "session.entry.appended",
      runId: undefined,
      payload: { entries: ids.map(entry) },
    });
  const delta = (seq: number, runId: string, text: string) =>
    event({ id: `progress-${seq}`, seq, type: "thread.progress", runId, payload: { delta: text } });
  const runEvent = (seq: number, type: ProductEvent["type"], runId: string) =>
    event({ id: `${type}-${seq}`, seq, type, runId, payload: { trigger: "user" } });

  const asked = "user: Find three competitors and summarize Acme's site";
  const steps = "steps Web search, Run subagent";
  const answered = `bot: ${steps} | Acme, Globex, Initech | ask Compare prices too? (answered)`;
  const summary = "bot: Summary of https://acme.example";
  const firstRun = [asked, "run completed", answered, "user: Yes", summary];
  const idle = { run: null, streaming: [], waiting: null };
  const working = (runId: string, streaming: string[] = []) => ({
    run: `${runId} running`,
    streaming,
    waiting: null,
  });

  const script: [ProductEvent, ReturnType<typeof state>][] = [
    [appendedAt(1, "str-00"), { cursor: 1, ...idle, rows: [asked] }],
    [
      runEvent(2, "run.started", "run_str_1"),
      { cursor: 2, ...working("run_str_1"), rows: [asked] },
    ],
    [appendedAt(3, "str-01"), { cursor: 3, ...working("run_str_1"), rows: [asked, "run running"] }],
    [
      appendedAt(4, "str-02"),
      {
        cursor: 4,
        ...working("run_str_1"),
        rows: [asked, "run running", "bot: steps Web search"],
      },
    ],
    [
      appendedAt(5, "str-03"),
      {
        cursor: 5,
        ...working("run_str_1"),
        rows: [asked, "run running", "bot: steps Web search"],
      },
    ],
    [
      appendedAt(6, "str-04"),
      {
        cursor: 6,
        ...working("run_str_1"),
        rows: [asked, "run running", `bot: ${steps}`],
      },
    ],
    [
      appendedAt(7, "str-05"),
      { cursor: 7, ...working("run_str_1"), rows: [asked, "run running", `bot: ${steps}`] },
    ],
    [
      delta(8, "run_str_1", "Acme, "),
      {
        cursor: 8,
        ...working("run_str_1", ["run_str_1"]),
        rows: [asked, "run running", `bot: ${steps}`, "bot live: Acme, "],
      },
    ],
    [
      delta(9, "run_str_1", "Globex, Initech"),
      {
        cursor: 9,
        ...working("run_str_1", ["run_str_1"]),
        rows: [asked, "run running", `bot: ${steps}`, "bot live: Acme, Globex, Initech"],
      },
    ],
    [
      appendedAt(10, "str-06"),
      {
        cursor: 10,
        ...working("run_str_1"),
        rows: [asked, "run running", `bot: ${steps} | Acme, Globex, Initech`],
      },
    ],
    [
      appendedAt(11, "str-07"),
      {
        cursor: 11,
        ...working("run_str_1"),
        waiting: "str-07",
        rows: [
          asked,
          "run running",
          `bot: ${steps} | Acme, Globex, Initech | ask Compare prices too?`,
        ],
      },
    ],
    [
      appendedAt(12, "str-08"),
      {
        cursor: 12,
        ...working("run_str_1"),
        rows: [asked, "run running", answered, "user: Yes"],
      },
    ],
    [
      delta(13, "run_str_1", "Summary of "),
      {
        cursor: 13,
        ...working("run_str_1", ["run_str_1"]),
        rows: [asked, "run running", answered, "user: Yes", "bot live: Summary of "],
      },
    ],
    [
      appendedAt(14, "str-09"),
      {
        cursor: 14,
        ...working("run_str_1"),
        rows: [asked, "run running", answered, "user: Yes", summary],
      },
    ],
    [appendedAt(15, "str-10"), { cursor: 15, ...working("run_str_1"), rows: firstRun }],
    [runEvent(16, "run.completed", "run_str_1"), { cursor: 16, ...idle, rows: firstRun }],
    [
      appendedAt(17, "str-11"),
      {
        cursor: 17,
        ...idle,
        rows: [...firstRun.slice(0, -1), `${summary} | link_preview`],
      },
    ],
    [appendedAt(18, "str-12"), { cursor: 18, ...idle, rows: firstRun }],
    [
      appendedAt(19, "str-13"),
      { cursor: 19, ...idle, rows: [...firstRun, "user: And for Initech?"] },
    ],
    [
      runEvent(20, "run.started", "run_str_2"),
      { cursor: 20, ...working("run_str_2"), rows: [...firstRun, "user: And for Initech?"] },
    ],
    [
      appendedAt(21, "str-14"),
      {
        cursor: 21,
        ...working("run_str_2"),
        rows: [...firstRun, "user: And for Initech?", "run running"],
      },
    ],
    [
      delta(22, "run_str_2", "Initech sells"),
      {
        cursor: 22,
        ...working("run_str_2", ["run_str_2"]),
        rows: [...firstRun, "user: And for Initech?", "run running", "bot live: Initech sells"],
      },
    ],
    [
      delta(23, "run_str_2", " printers."),
      {
        cursor: 23,
        ...working("run_str_2", ["run_str_2"]),
        rows: [
          ...firstRun,
          "user: And for Initech?",
          "run running",
          "bot live: Initech sells printers.",
        ],
      },
    ],
    [
      appendedAt(24, "str-15", "str-16"),
      {
        cursor: 24,
        ...working("run_str_2"),
        rows: [
          ...firstRun,
          "user: And for Initech?",
          "run completed",
          "bot: Initech sells printers.",
        ],
      },
    ],
    [
      runEvent(25, "run.completed", "run_str_2"),
      {
        cursor: 25,
        ...idle,
        rows: [
          ...firstRun,
          "user: And for Initech?",
          "run completed",
          "bot: Initech sells printers.",
        ],
      },
    ],
    [appendedAt(26, "str-17"), { cursor: 26, ...idle, rows: [...firstRun, "divider rewind"] }],
    [
      appendedAt(27, "str-18"),
      { cursor: 27, ...idle, rows: [...firstRun, "divider rewind", "user: And for Globex?"] },
    ],
  ];

  function shown(thread: ThreadState | null): string[] {
    const view = projectThreadView(thread?.entries ?? [], { progress: thread?.layer });
    return view.rows.map(({ item }) => {
      switch (item.kind) {
        case "message":
          return `${item.role}${item.role === "bot" && item.live ? " live" : ""}: ${item.blocks
            .map((block) =>
              block.kind === "text" || block.kind === "progress"
                ? block.text
                : block.kind === "ask"
                  ? `ask ${block.text}${block.status === "answered" ? " (answered)" : ""}`
                  : block.kind === "steps"
                    ? `steps ${block.steps.map((step) => step.label).join(", ")}`
                    : block.kind,
            )
            .join(" | ")}`;
        case "run":
          return `run ${item.finished?.outcome.status ?? "running"}`;
        case "divider":
          return `divider ${item.reason}`;
        default:
          return item.kind;
      }
    });
  }

  function state(thread: ThreadState | null) {
    const view = projectThreadView(thread?.entries ?? [], { progress: thread?.layer });
    return {
      cursor: thread?.cursor,
      run: thread?.run ? `${thread.run.id} ${thread.run.status}` : null,
      streaming: [...(thread?.layer.keys() ?? [])],
      waiting: view.waiting ? String(view.waiting.entryId) : null,
      rows: shown(thread),
    };
  }

  it("shows each step's words once, the same from a snapshot taken mid-run", () => {
    let live: ThreadState | null = { ...threadEntriesOf(wire()), cursor: 0 };
    let reloaded: ThreadState | null = null;
    for (const [next, expected] of script) {
      live = reduceThreadState(live, next);
      reloaded =
        next.seq === 9
          ? threadEntriesOf({
              ...wire(fixture.slice(0, 6)),
              cursor: 9,
              progress: [script[7]![0], script[8]![0]],
              run: live?.run ?? null,
              activeRuns: live?.activeRuns,
            })
          : reloaded && reduceThreadState(reloaded, next);

      expect(state(live)).toEqual(expected);
      if (reloaded) expect(state(reloaded)).toEqual(expected);
      const words = shown(live).join("\n");
      for (const reply of ["Acme, Globex, Initech", "Summary of", "Initech sells printers."]) {
        expect(words.split(reply).length).toBeLessThanOrEqual(2);
      }
    }
  });
});

describe("computer event reduction", () => {
  it("applies valid lifecycle states without accepting unknown states", () => {
    const initial = computer();
    const running = reduceComputerStatus(
      initial,
      event({ type: "computer.status", payload: { status: "running" } }),
    );
    const unknown = reduceComputerStatus(
      running,
      event({ type: "computer.status", payload: { status: "destroyed" } }),
    );

    expect(running).toMatchObject({ state: "running", screenAvailable: true });
    expect(unknown).toMatchObject({ state: "running", screenAvailable: true });
    expect(unknown).toBe(running);
  });

  it("grants user control without overwriting the lifecycle state", () => {
    const granted = reduceComputerStatus(
      computer({ state: "suspended", controlHolder: "bot" }),
      event({ type: "computer.takeover.granted", payload: { takeoverRequested: true } }),
    );
    expect(granted).toMatchObject({
      state: "suspended",
      controlHolder: "user",
      controlBotId: "bot-1",
      takeoverRequested: true,
    });
    expect(
      reduceComputerStatus(
        granted,
        event({ type: "computer.takeover.granted", payload: { takeoverRequested: true } }),
      ),
    ).toBe(granted);
  });

  it("applies the authoritative holder when a takeover is released or expires", () => {
    const initial = computer({
      state: "running",
      controlHolder: "user",
      controlBotId: "bot-1",
      takeoverRequested: true,
    });
    const expired = reduceComputerStatus(
      initial,
      event({
        type: "computer.takeover.released",
        payload: { holder: "none", reason: "expired" },
      }),
    );
    const released = reduceComputerStatus(
      initial,
      event({
        type: "computer.takeover.released",
        payload: { holder: "bot", reason: "released" },
      }),
    );
    expect(expired).toMatchObject({
      state: "running",
      controlHolder: "none",
      controlBotId: null,
      takeoverRequested: false,
    });
    expect(released).toMatchObject({
      state: "running",
      controlHolder: "bot",
      controlBotId: null,
      takeoverRequested: false,
    });
  });

  it("fills in controlBotId when a grant arrives after controlHolder is already user", () => {
    const granted = reduceComputerStatus(
      computer({ state: "running", controlHolder: "user", controlBotId: null }),
      event({ type: "computer.takeover.granted", payload: {} }),
    );
    expect(granted).toMatchObject({
      state: "running",
      controlHolder: "user",
      controlBotId: "bot-1",
    });
    expect(userHoldsComputerControl(granted, "bot-1")).toBe(true);
    expect(userHoldsComputerControl(granted, "bot-2")).toBe(false);
  });

  it("treats a busy bot name as a blocked takeover", () => {
    expect(computerTakeoverBlocked(computer({ busyBotName: "Writer" }), "running")).toBe(true);
    expect(computerTakeoverBlocked(computer({ busyBotName: "Writer" }))).toBe(false);
    expect(computerTakeoverBlocked(computer({ busyBotName: null }), "running")).toBe(false);
    expect(computerTakeoverBlocked(null, "running")).toBe(false);
    expect(computerTakeoverBlocked(computer({ busyBotName: "Writer" }), "waiting_takeover")).toBe(
      false,
    );
    expect(computerTakeoverBlocked(computer({ busyBotName: "Writer" }), "completed")).toBe(false);
  });

  it("offers a member Take control only when their own run waits and the screen is free", () => {
    const idle = { runStatus: null, composerRunning: false, busyBotName: null };
    const waiting = { ...idle, runStatus: "waiting_takeover" };
    expect(canTakeComputerControl({ ...idle, shared: true })).toBe(false);
    expect(canTakeComputerControl({ ...waiting, shared: true })).toBe(true);
    expect(canTakeComputerControl({ ...waiting, shared: true, busyBotName: "Notes" })).toBe(false);
    expect(canTakeComputerControl({ ...idle, shared: false })).toBe(true);
    expect(canTakeComputerControl({ ...idle, shared: false, busyBotName: "Writer" })).toBe(false);
  });

  it("marks takeover requested and clears control unless the lease was retained", () => {
    const busy = computer({ state: "running", busyBotName: "Writer", controlHolder: "bot" });
    expect(
      reduceComputerStatus(busy, event({ type: "computer.takeover.requested", payload: {} })),
    ).toMatchObject({
      busyBotName: null,
      takeoverRequested: true,
      controlHolder: "none",
      controlBotId: null,
    });
    expect(
      reduceComputerStatus(
        computer({
          state: "running",
          controlHolder: "user",
          controlBotId: "bot-1",
          takeoverRequested: false,
        }),
        event({
          type: "computer.takeover.requested",
          payload: { retainedControl: true },
        }),
      ),
    ).toMatchObject({
      controlHolder: "user",
      controlBotId: "bot-1",
      takeoverRequested: true,
      busyBotName: null,
    });
    expect(
      reduceComputerStatus(
        busy,
        event({ type: "computer.takeover.granted", payload: { takeoverRequested: true } }),
      ),
    ).toMatchObject({
      controlHolder: "user",
      busyBotName: null,
      takeoverRequested: true,
    });
  });

  it("auto-boots stopped computers and recovers a running screen that has no URL", () => {
    expect(computerPanelAutoBoot("stopped")).toBe("boot");
    expect(computerPanelAutoBoot("error")).toBe("boot");
    expect(computerPanelAutoBoot(undefined)).toBe("boot");
    expect(computerPanelAutoBoot("running", "https://screen.example")).toBe("wait");
    expect(computerPanelAutoBoot("running", null)).toBe("recover-screen");
    expect(computerPanelAutoBoot("booting")).toBe("wait");
    expect(computerPanelAutoBoot("suspended")).toBe("wait");
  });

  it("maps recover-screen to computer.boot, not computer.recover", () => {
    expect(computerPanelAutoUsesBoot("recover-screen")).toBe(true);
    expect(computerPanelAutoUsesBoot("boot")).toBe(true);
    expect(computerPanelAutoUsesBoot("wait")).toBe(false);
  });
});

function said(seq: number, text: string): ThreadEntry {
  return ThreadEntrySchema.parse({
    id: `e-${seq}`,
    seq,
    parentId: seq === 0 ? null : `e-${seq - 1}`,
    ts: "2026-08-16T00:00:00.000Z",
    type: "user.message",
    payload: { blocks: [{ kind: "text", text }], source: "app" },
  });
}

function textOf(entry: ThreadEntry): string {
  return entry.type === "user.message" && entry.payload.blocks[0]?.kind === "text"
    ? entry.payload.blocks[0].text
    : entry.type;
}

function wire(entries: ThreadEntry[] = [], olderCursor: string | null = null): ThreadSnapshot {
  return {
    botId: "bot-1",
    threadId: "thread-1",
    cursor: 3,
    entries,
    olderCursor: olderCursor as ThreadSnapshot["olderCursor"],
    progress: [],
    run: null,
    computer: computer(),
  };
}

function state(entries: ThreadEntry[] = [], olderCursor: string | null = null): ThreadState {
  return threadEntriesOf(wire(entries, olderCursor));
}

function threadRun(id: string, botId = "bot-1"): NonNullable<ThreadSnapshot["run"]> {
  return {
    id,
    botId,
    threadId: "thread-1",
    taskId: `task-${id}`,
    status: "running",
    trigger: "user",
    routineId: null,
    modelProvider: null,
    modelId: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2026-08-16T00:00:00.000Z",
  };
}

function computer(overrides: Partial<ComputerStatus> = {}): ComputerStatus {
  return {
    botId: "bot-1",
    mode: "team",
    kind: "fake",
    state: "booting",
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: false,
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: null,
    screenStamp: "",
    busyBotName: null,
    canUpdate: true,
    ...overrides,
  };
}

function progress(seq: number, runId: string, delta: string): ProductEvent {
  return event({ type: "thread.progress", id: `progress-${seq}`, seq, runId, payload: { delta } });
}

function event(overrides: Partial<ProductEvent>): ProductEvent {
  return {
    id: "event-1",
    spaceId: "workspace-1",
    threadId: "thread-1",
    botId: "bot-1",
    seq: 4,
    type: "thread.progress",
    runId: "run-1",
    createdAt: "2026-08-16T00:00:01.000Z",
    payload: {},
    ...overrides,
  };
}

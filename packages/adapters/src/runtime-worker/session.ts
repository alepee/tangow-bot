import type {
  AgentRunModel,
  AgentRunRequest,
  GuestBody,
  GuestRunInput,
  ModelDialect,
  RefusalReason,
  ReplyFinal,
  ReplyPart,
  SubagentLog,
  WorkerIdentity,
  WorkerSkill,
  WorkerStartV1,
} from "@tangow/adapter-kit";
import {
  AgentRuntimeUnavailableError,
  FRAME_CAPABILITY,
  WORKER_PROTOCOL_VERSION,
} from "@tangow/adapter-kit";
import { redactSecrets, secretRedactor } from "@tangow/core";
import { getLogger } from "@tangow/logging";
import { isFailedToolResult, isToolPauseResult } from "../approval-effect.js";
import {
  HELPER_STOPPED_FOR_PAUSE,
  helperCallOf,
  helperInstructions,
  helperModel,
  helperProfileOf,
  isHelperTool,
} from "../builtin-tools.js";
import { redactTranscript } from "../connector-safety.js";
import { loadCatalogEntry } from "../lazy-tool-catalog.js";
import type { RunTraceRecorder } from "../pi-run-trace.js";
import type { CapabilityKey } from "./capability.js";
import { mintCapability, verifyCapability } from "./capability.js";
import { relayPiAiCall } from "./dialects/pi-ai.js";
import { eventPipe } from "./event-pipe.js";
import type { FrameChannel } from "./framing.js";
import { encodeMessage, readGuestFrame } from "./framing.js";
import type { ToolRule } from "./guest-input.js";
import {
  base64Images,
  helperRunInput,
  keepsEntry,
  mainBotRule,
  nativeToolsForHarness,
  workerStart,
} from "./guest-input.js";
import type { SessionInbox } from "./inbox.js";
import { createSessionInbox } from "./inbox.js";
import type { LaunchedGuest, WorkerLauncher } from "./launcher.js";
import { modelTokensPerRequest, WORKER_LIMITS } from "./limits.js";
import type { ModelRelay, RelayUsage } from "./model-relay.js";
import { guestModelOf } from "./model-relay.js";
import { clearRelayPrefixes, measureRelayPrefix } from "./relay-measurements.js";
import type { StopJournal } from "./stop-journal.js";
import { transcriptIngest } from "./transcript.js";

/** The model-access dialects the controller relays. A new dialect is one entry here. */
const RELAYS: { [D in ModelDialect]: ModelRelay<never, unknown> } = {
  "pi-ai": relayPiAiCall as ModelRelay<never, unknown>,
};

const PAUSED_TOOL_RESULT = {
  kind: "agent_tool_result",
  content: [
    {
      type: "text",
      text: "Not run: this run is paused until the user answers. Do not retry it; end your turn.",
    },
  ],
  details: { paused: true },
};

const PAUSED_MESSAGE = "This run is paused until the user answers.";

const PAUSED_MODEL_REFUSALS = 2;

export interface WorkerClock {
  sleep(ms: number): Promise<void>;
}

/** The guest broke the protocol: the run fails rather than retrying a hostile peer. */
export class WorkerViolationError extends Error {
  constructor(readonly reason: RefusalReason) {
    super(`The worker broke the run protocol: ${reason}`);
    this.name = "WorkerViolationError";
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function cutText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const marker = `\n\n[cut by the controller at ${maxBytes} bytes]`;
  return `${Buffer.from(text)
    .subarray(0, maxBytes - Buffer.byteLength(marker))
    .toString()}${marker}`;
}

type HelperOutcome = { status: "completed" | "failed"; result: string };

type Helper = {
  log: SubagentLog;
  model: AgentRunModel;
  tools: ReadonlySet<string>;
  /** Selects its tools, and the catalog entries its catalog tools reach by id. */
  rule: ToolRule;
  usage: { inputTokens: number; outputTokens: number };
  modelRequests: number;
  /** The outcome its log persisted. A helper closes once; later closes keep that outcome. */
  closed?: Promise<HelperOutcome>;
  /** A pause settles the parent before the helper finishes its audit. */
  pausedOutcome?: HelperOutcome;
  /** A helper the controller started settles its parent's `run_subagent` call. */
  settle?: (outcome: HelperOutcome) => void;
};

/**
 * One attempt's guest, from launch to confirmed stop. Lives as long as the executor's run: a
 * controller restart ends the attempt, so everything here may stay in memory.
 */
export function createSession(
  request: AgentRunRequest,
  deps: {
    key: CapabilityKey;
    launcher: WorkerLauncher;
    stops: StopJournal;
    clock: WorkerClock;
    recorder?: RunTraceRecorder;
  },
) {
  const { recorder } = deps;
  if (!request.attempt) throw new Error("A worker run needs its attempt");
  /** A background helper's profile, looked up when it starts so a deploy in between applies. */
  const helperProfile =
    request.helper &&
    helperProfileOf(request.helperProfiles, { helper: request.helper.profile ?? "" });
  const worker: WorkerIdentity = {
    runId: request.runId,
    attemptId: request.attempt.id,
    fence: request.attempt.fence,
  };
  const events = eventPipe();
  const helloSettled = deferred<void>();
  const stopped = deferred<void>();
  const tools = new Map(request.tools.map((tool) => [tool.name, tool]));
  /** What the parent was offered: `tools` minus what its run blocks. */
  let rootTools: ReadonlySet<string> = new Set();
  const announced = new Map<string, string>();
  const open = new Map<string, Promise<unknown>>();
  const helpers = new Map<string, Helper>();
  const relays = new Map<number, AbortController>();
  const reportedSkills: WorkerSkill[] = [];
  let reportedSkillBytes = 0;
  let skillIndexEnded = false;
  let skillUses = 0;
  let skillCollisions = 0;
  const mountedSkillSources = () =>
    new Set<WorkerSkill["source"]>([
      "managed",
      ...(launched?.start.workspace.mounts.map((mount) =>
        mount.scope === "private" ? ("bot" as const) : ("shared" as const),
      ) ?? []),
    ]);
  let modelRequests = 0;
  let modelTokens = 0;
  let reservedModelTokens = 0;
  let modelTokenLimit =
    modelTokensPerRequest(request.model) * WORKER_LIMITS.modelRequestsPerAttempt;
  let toolCalls = 0;
  /**
   * Set once a tool paused the run or the harness asked the user: from then on the attempt may
   * only conclude, whatever its harness does.
   */
  let paused: { toolCalls: number; modelRequests: number } | undefined;
  let helloReceived = false;
  let rootTranscriptAccepted = false;
  let launched: LaunchedGuest | undefined;
  let bound: FrameChannel | undefined;
  let stopping: Promise<void> | undefined;
  let finished = false;

  const clean = (text: string) => redactSecrets(text, [...(request.secrets ?? [])]);
  const transcript = transcriptIngest((text) =>
    cutText(clean(text), WORKER_LIMITS.controllerResultBytes),
  );

  const fail = (error: Error) => {
    events.end(error);
  };

  const violation = (reason: RefusalReason, channel?: FrameChannel) => {
    channel?.close();
    bound?.close();
    fail(new WorkerViolationError(reason));
  };

  /** The attempt lost its run: nothing more is decided for this guest. */
  const revoke = (): ReplyFinal => {
    inbox.revoke();
    setImmediate(() => {
      bound?.close();
      fail(new AgentRuntimeUnavailableError("This attempt no longer holds the run"));
    });
    return { type: "refused", reason: "revoked" };
  };

  /** Refuses a request frame: the guest gets the refusal, then the channel ends. */
  const refuse = (reason: RefusalReason): ReplyFinal => {
    setImmediate(() => violation(reason));
    return { type: "refused", reason };
  };

  const declared = (body: GuestBody) => {
    const needed = FRAME_CAPABILITY[body.type];
    return !needed || launched!.expectedHarness.capabilities.includes(needed);
  };

  const allowed = (name: string) => tools.has(name);

  let pauseSaved = false;
  const endPaused = (): ReplyFinal => {
    if (
      request.persistence &&
      launched?.expectedHarness.capabilities.includes("resume") &&
      !pauseSaved
    ) {
      finished = true;
      fail(new Error("The pause ended without a saved agent snapshot"));
      return { type: "stop", reason: "cancelled" };
    }
    if (!finished) {
      finished = true;
      events.end();
    }
    return { type: "stop", reason: "paused" };
  };

  const pause = () => {
    if (paused) return;
    paused = { toolCalls: 0, modelRequests: 0 };
    for (const helper of helpers.values()) {
      if (helper.closed || !helper.settle) continue;
      helper.pausedOutcome = { status: "completed", result: HELPER_STOPPED_FOR_PAUSE };
      helper.settle?.(helper.pausedOutcome);
    }
    void Promise.race([deps.clock.sleep(WORKER_LIMITS.pausedGraceMs), stopped.promise]).then(() => {
      if (!stopping) endPaused();
    });
  };

  /** No call runs after the pause, but each still gets a result so the harness's turn stays whole. */
  const pausedToolCall = (state: NonNullable<typeof paused>): ReplyFinal =>
    ++state.toolCalls > WORKER_LIMITS.pausedToolCalls
      ? endPaused()
      : { type: "tool.result", output: PAUSED_TOOL_RESULT };

  /** A few model requests let the harness close its turn; one that keeps asking is stopped. */
  const pausedModelRequest = (state: NonNullable<typeof paused>): ReplyFinal | undefined => {
    state.modelRequests += 1;
    if (state.modelRequests <= WORKER_LIMITS.pausedModelRequests) return undefined;
    if (state.modelRequests <= WORKER_LIMITS.pausedModelRequests + PAUSED_MODEL_REFUSALS) {
      return { type: "error", message: PAUSED_MESSAGE };
    }
    return endPaused();
  };

  /** Check in the caller after awaiting a fence lookup: shutdown can run before it resumes. */
  const live = () => !finished && !stopping;

  /** Once paused, the attempt concludes on a run waiting for the user; never once superseded. */
  const fenceHeld = async () => {
    if (paused) return (await launched!.ownsFence()) && live();
    if (await launched!.holdsFence()) return live();
    // The pause can latch during the lookup and move the run to wait on the user.
    return paused ? (await launched!.ownsFence()) && live() : false;
  };

  const fenceOwned = async () => (await launched!.ownsFence()) && live();

  const helperOf = (agent: string) => (agent === "root" ? undefined : helpers.get(agent));

  const runsOwnLoop = () => launched!.expectedHarness.capabilities.includes("native-loop");

  let helpersStarted = 0;
  let helpersRunning = 0;

  /** Finalizes the audit once. Paused parents already have their stop result. */
  const closeHelper = (helper: Helper, outcome: HelperOutcome, abandoned = false) => {
    helper.closed ??= (async () => {
      outcome = helper.pausedOutcome ?? outcome;
      try {
        await helper.log.finish({ ...outcome, usage: helper.usage });
        if (abandoned) await helper.log.abandon(outcome.result);
        return outcome;
      } catch (error) {
        const failed = { status: "failed" as const, result: clean(messageOf(error)) };
        await helper.log.abandon(failed.result).catch(() => undefined);
        return failed;
      }
    })().then((persisted) => {
      helper.settle?.(persisted);
      return persisted;
    });
    return helper.closed;
  };

  /**
   * A harness with its own loop never launches helpers itself: the controller opens the helper,
   * projects its session and holds the parent's call until the helper closes or the run pauses.
   * A pause settles the parent at once while the helper can still report its transcript.
   */
  async function runHelper(
    body: Extract<GuestBody, { type: "tool.call" }>,
    part: (body: ReplyPart) => void,
  ): Promise<ReplyFinal> {
    if (helpersRunning >= WORKER_LIMITS.helpersInParallel) {
      return { type: "error", message: "Wait for a running helper to finish first" };
    }
    if (helpersStarted >= WORKER_LIMITS.helpersPerAttempt) {
      return {
        type: "error",
        message: `This run already started its ${WORKER_LIMITS.helpersPerAttempt} helpers`,
      };
    }
    helpersStarted += 1;
    helpersRunning += 1;
    try {
      const call = helperCallOf(body.args);
      let helper: Helper;
      let run: GuestRunInput;
      try {
        if (!request.startSubagent) throw new Error("Helpers are unavailable in this run");
        const profile = helperProfileOf(request.helperProfiles, call);
        const background =
          profile?.executionMode === "async" ||
          (profile?.executionMode !== "sync" && call.background);
        const args = { ...body.args, background };
        const { model, modelDecision } = await helperModel(request, call);
        if (!live()) return { type: "error", message: "The worker stopped" };
        if (paused) return pausedToolCall(paused);
        if (background) {
          if (!request.startHelper) throw new Error("Background helpers are unavailable here");
          const started = await request.startHelper({
            callId: body.callId,
            name: call.name,
            task: call.task,
            args,
            model: { provider: model.provider, id: model.id, thinkingLevel: model.thinkingLevel },
            profile,
            modelDecision,
          });
          return { type: "tool.result", output: started };
        }
        run = helperRunInput(launched!.start, request, launched!.expectedHarness, {
          task: call.task,
          instructions: helperInstructions(call.name, profile?.instructions, call.instructions),
          model,
          profile,
        });
        const log = await request.startSubagent({
          callId: body.callId,
          name: call.name,
          task: call.task,
          args,
          model: { provider: model.provider, id: model.id, thinkingLevel: model.thinkingLevel },
          profile,
          modelDecision,
        });
        helper = {
          log,
          model,
          tools: new Set(run.tools.map((tool) => tool.name)),
          rule: profile ?? mainBotRule(request, launched!.expectedHarness),
          usage: { inputTokens: 0, outputTokens: 0 },
          modelRequests: 0,
        };
      } catch (error) {
        // A refused start, such as a held resource, leaves the budget for a retry.
        helpersStarted -= 1;
        return { type: "error", message: clean(messageOf(error)) };
      }
      if (!live()) {
        await closeHelper(helper, { status: "failed", result: "The worker stopped" });
        return { type: "error", message: "The worker stopped" };
      }
      const settled = new Promise<HelperOutcome>((settle) => {
        helper.settle = settle;
      });
      if (paused) {
        await closeHelper(helper, { status: "completed", result: HELPER_STOPPED_FOR_PAUSE });
      } else {
        const agent = `helper:${helpers.size + 1}`;
        helpers.set(agent, helper);
        part({ type: "subagent.start", agent, run });
      }
      const { status, result } = await settled;
      const text = cutText(clean(result), WORKER_LIMITS.controllerResultBytes);
      return {
        type: "tool.result",
        output: status === "completed" ? text : `Subagent failed: ${text}`,
      };
    } finally {
      helpersRunning -= 1;
    }
  }

  const helperOverBudget = (agent: string): ReplyFinal | undefined => {
    const helper = helperOf(agent);
    if (!helper || ++helper.modelRequests <= WORKER_LIMITS.modelRequestsPerHelper) return undefined;
    return {
      type: "error",
      message: `This helper used its ${WORKER_LIMITS.modelRequestsPerHelper} model requests`,
    };
  };

  /** A call naming an entry of `name`'s catalog that `rule` drops. An unknown id gets the connector's error. */
  function blockedEntry(name: string, args: Record<string, unknown>, rule: ToolRule) {
    const entries = tools.get(name)?.catalog;
    if (!entries) return false;
    try {
      return !keepsEntry(rule)(loadCatalogEntry(entries, args));
    } catch {
      return false;
    }
  }

  function callTool(
    body: Extract<GuestBody, { type: "tool.call" }>,
    part: (body: ReplyPart) => void,
  ): Promise<ReplyFinal> {
    const call = executeToolCall(body, part);
    open.set(body.callId, call);
    return call.finally(() => open.delete(body.callId));
  }

  async function executeToolCall(
    body: Extract<GuestBody, { type: "tool.call" }>,
    part: (body: ReplyPart) => void,
  ): Promise<ReplyFinal> {
    const { agent, callId, name, args } = body;
    if (!allowed(name) || announced.get(callId) !== name) return refuse("unknown_tool");
    if (Buffer.byteLength(JSON.stringify(args)) > WORKER_LIMITS.toolArgsBytes) {
      return refuse("too_large");
    }
    announced.delete(callId);
    const helper = helperOf(agent);
    if (agent !== "root" && !helper) return refuse("invalid");
    if (paused) return pausedToolCall(paused);
    if (!(helper?.tools ?? rootTools).has(name)) return refuse("unknown_tool");
    if (
      blockedEntry(
        name,
        args,
        helper?.rule ?? helperProfile ?? mainBotRule(request, launched!.expectedHarness),
      )
    ) {
      return refuse("unknown_tool");
    }
    const durable =
      agent === "root" && launched!.expectedHarness.capabilities.includes("resume")
        ? request.persistence
        : undefined;
    const receiptArgs = JSON.parse(JSON.stringify(args));
    if (name === "run_subagent" && runsOwnLoop()) {
      recorder?.toolStart(callId, name, args);
      const reply = await runHelper(body, part);
      const answered = reply.type === "tool.result";
      await durable?.receipt({
        callId,
        name,
        args: receiptArgs,
        outcome: {
          kind: "result",
          output: answered ? reply.output : reply,
          isError: !answered,
        },
      });
      recorder?.toolEnd(callId, answered ? reply.output : reply, !answered);
      return reply;
    }
    const execute = helper ? helper.log.executeTool : request.executeTool;
    if (!execute) return { type: "error", message: `${name} is unavailable here` };
    recorder?.toolStart(callId, name, args);
    const call = execute(name, args, callId, tools.get(name)?.route, recorder?.toolTrace(callId));
    try {
      const output = await call;
      const details = isToolPauseResult(output) ? output.details : undefined;
      const effectId =
        details &&
        typeof details === "object" &&
        "effectId" in details &&
        typeof details.effectId === "string"
          ? details.effectId
          : undefined;
      await durable?.receipt({
        callId,
        name,
        args: receiptArgs,
        ...(effectId ? { effectId } : {}),
        outcome: isToolPauseResult(output)
          ? { kind: "paused", output: output }
          : {
              kind: "result",
              output: output,
              isError:
                isFailedToolResult(output) ||
                (typeof output === "object" &&
                  output !== null &&
                  "isError" in output &&
                  output.isError === true),
            },
      });
      if (isToolPauseResult(output)) pause();
      recorder?.toolEnd(callId, output, isFailedToolResult(output));
      return { type: "tool.result", output };
    } catch (error) {
      const message = clean(messageOf(error));
      await durable?.receipt({
        callId,
        name,
        args: receiptArgs,
        outcome: { kind: "result", output: { error: message }, isError: true },
      });
      recorder?.toolEnd(callId, message, true);
      return { type: "error", message };
    }
  }

  async function relayModel(
    seq: number,
    body: Extract<GuestBody, { type: "model.request" }>,
    part: (body: ReplyPart) => void,
  ): Promise<ReplyFinal> {
    if (!(await fenceHeld()) || !live()) return revoke();
    const helper = helperOf(body.agent);
    if (body.agent !== "root" && !helper) return refuse("invalid");
    const turnedAway = paused && pausedModelRequest(paused);
    if (turnedAway) return turnedAway;
    const model = helper?.model ?? request.model;
    const reservation = modelTokensPerRequest(model);
    modelTokenLimit = Math.max(
      modelTokenLimit,
      reservation * WORKER_LIMITS.modelRequestsPerAttempt,
    );
    modelRequests += 1;
    if (!paused) {
      if (modelRequests > WORKER_LIMITS.modelRequestsPerAttempt) return refuse("budget");
      if (modelTokens + reservedModelTokens + reservation > modelTokenLimit)
        return refuse("budget");
    }
    // Reserve a full prompt and completion before starting upstream. Concurrent helpers cannot
    // all spend the same remainder. Only provider usage exceeding its model's bounds can overshoot.
    reservedModelTokens += reservation;
    const abort = new AbortController();
    relays.set(seq, abort);
    let usage: RelayUsage | undefined;
    let failure: unknown;
    let prefix: ReturnType<typeof measureRelayPrefix> = null;
    const generation = recorder?.modelRequest(body.agent);
    try {
      // The guest's own tool output reaches its transcript unredacted: mask it before the provider.
      const call = redactTranscript(body.call, secretRedactor([...(request.secrets ?? [])]));
      // A background helper is the root of its own attempt, keyed apart from its parent's turns.
      const agentId = helper ? body.agent : request.helper ? request.runId : undefined;
      // Measurements describe the same redacted transcript the provider receives.
      prefix = measureRelayPrefix(
        {
          threadId: request.threadId,
          botId: request.botId,
          helper: agentId,
          attemptId: worker.attemptId,
        },
        call as typeof body.call,
      );
      usage = await RELAYS[body.dialect](
        model,
        call as never,
        (event) => part({ type: "model.event", event } as ReplyPart),
        {
          signal: abort.signal,
          trace: generation,
          conversation: {
            threadId: request.threadId,
            botId: request.botId,
            ...(agentId ? { helper: agentId } : {}),
          },
        },
      );
      if (usage) {
        modelTokens += usage.inputTokens + usage.outputTokens;
        if (!paused && modelTokens > modelTokenLimit) {
          for (const [pending, relay] of relays) {
            if (pending !== seq) relay.abort();
          }
        }
        if (helper) {
          helper.usage.inputTokens += usage.inputTokens;
          helper.usage.outputTokens += usage.outputTokens;
        }
      }
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      generation?.end(usage, failure);
      reservedModelTokens -= reservation;
      relays.delete(seq);
      getLogger().info("agent.worker.model_request", {
        runId: request.runId,
        attemptId: worker.attemptId,
        threadId: request.threadId,
        botId: request.botId,
        requestSeq: seq,
        agent: helper ? body.agent : "root",
        provider: usage?.provider ?? (helper?.model ?? request.model).provider,
        model: usage?.model ?? (helper?.model ?? request.model).id,
        modelRequests,
        toolCalls,
        modelTokens,
        modelTokenLimit,
        usageReported: usage !== undefined,
        inputTokens: usage?.inputTokens,
        cacheReadTokens: usage?.cacheReadTokens,
        cacheWriteTokens: usage?.cacheWriteTokens,
        outputTokens: usage?.outputTokens,
        ...prefix,
      });
    }
    if (usage) await events.push(usage);
    return !paused && modelTokens > modelTokenLimit ? refuse("budget") : { type: "model.end" };
  }

  async function finish(
    body: Extract<GuestBody, { type: "done" }>,
    part: (body: ReplyPart) => void,
  ) {
    // The harness's end does not close a run still waiting on a tool: hold it until all settle.
    if (open.size > 0) {
      part({ type: "end.refused", pending: [...open.keys()] });
      while (open.size > 0) await Promise.allSettled([...open.values()]);
    }
    if (paused) return endPaused();
    // Native completion must never reach the executor's legacy guest-text fallback.
    if (runsOwnLoop() && !rootTranscriptAccepted) {
      finished = true;
      violation("invalid");
      return { type: "refused", reason: "invalid" } as const;
    }
    finished = true;
    const done = events.push({
      type: "done",
      ...(body.text === undefined ? {} : { text: clean(body.text) }),
      ...(body.privateFinalText === undefined
        ? {}
        : { privateFinalText: clean(body.privateFinalText) }),
      ...(body.runtimeNotice === undefined ? {} : { runtimeNotice: clean(body.runtimeNotice) }),
    });
    events.end();
    await done;
    return { type: "stop", reason: "done" } as const;
  }

  async function handle(
    seq: number,
    body: GuestBody,
    part: (body: ReplyPart) => void,
  ): Promise<ReplyFinal> {
    if (!declared(body)) return refuse("undeclared");
    switch (body.type) {
      case "snapshot.save":
        if (!(await fenceOwned()) || !live()) return revoke();
        if (
          !request.persistence ||
          !paused ||
          pauseSaved ||
          body.snapshot.harness.name !== launched!.expectedHarness.name
        )
          return refuse("invalid");
        {
          const permitted = new Set([
            ...(request.resumeEvents?.map((event) => event.id) ?? []),
            ...(request.persistence.start.mode === "resume"
              ? request.persistence.start.snapshot.deliveredEvents
              : []),
          ]);
          if (body.snapshot.deliveredEvents.some((id) => !permitted.has(id)))
            return refuse("invalid");
        }
        while (open.size > 0) await Promise.allSettled([...open.values()]);
        await request.persistence.save(body.snapshot);
        pauseSaved = true;
        return { type: "recorded" };
      case "snapshot.resolve":
        if (!(await fenceHeld()) || !live()) return revoke();
        if (!request.persistence) return refuse("invalid");
        return { type: "snapshot.receipts", receipts: await request.persistence.resolve() };
      case "text":
        if (paused) return { type: "ack" };
        await events.push({ type: "text", text: clean(body.text) });
        return { type: "ack" };
      case "progress":
        if (paused) return { type: "ack" };
        await events.push({
          type: "progress",
          text: clean(body.text),
          ...(body.activity ? { activity: true } : {}),
        });
        return { type: "ack" };
      case "tool":
        if (!allowed(body.name)) return refuse("unknown_tool");
        if (Buffer.byteLength(JSON.stringify(body.args)) > WORKER_LIMITS.toolArgsBytes) {
          return refuse("too_large");
        }
        if (!transcript.claim(body.executionId)) return refuse("invalid");
        announced.set(body.executionId, body.name);
        if (paused) return { type: "ack" };
        await events.push({
          type: "tool",
          name: body.name,
          args: body.args,
          executionId: body.executionId,
        });
        return { type: "ack" };
      case "subagent":
        return { type: "ack" };
      case "model.request":
        transcript.requested(body.agent);
        return helperOverBudget(body.agent) ?? relayModel(seq, body, part);
      case "model.latency":
        // Guest diagnostics never authorize work or affect the run's outcome.
        return { type: "ack" };
      case "model.abort":
        relays.get(body.re)?.abort();
        return { type: "ack" };
      case "tool.call":
        // The executor checks its lease only between events: a guest must not outrun it.
        if (!(await fenceHeld()) || !live()) return revoke();
        if (!paused && ++toolCalls > WORKER_LIMITS.toolCallsPerAttempt) return refuse("budget");
        return transcript.answered(body, await callTool(body, part));
      case "steering.claim": {
        if (paused) return { type: "steering", messages: [] };
        const messages = (await request.claimSteering?.(body.seenIds)) ?? [];
        return {
          type: "steering",
          messages: messages.map((message) => ({
            id: message.id,
            messageId: message.messageId,
            text: message.text,
            ...(message.historyText === undefined ? {} : { historyText: message.historyText }),
            images: base64Images(message.images),
          })),
        };
      }
      case "subagent.open": {
        if (runsOwnLoop()) return refuse("invalid");
        if (paused) return { type: "error", message: PAUSED_MESSAGE };
        if (!request.startSubagent || !request.resolveCategory) {
          return { type: "error", message: "Helpers are unavailable in this run" };
        }
        const { model, modelDecision } = await request.resolveCategory(body.category);
        const log = await request.startSubagent({
          callId: body.callId,
          name: body.name,
          task: body.task,
          args: body.args,
          model: { provider: model.provider, id: model.id, thinkingLevel: model.thinkingLevel },
          modelDecision,
        });
        const agent = `helper:${helpers.size + 1}`;
        helpers.set(agent, {
          log,
          model,
          tools: new Set([...rootTools].filter(isHelperTool)),
          rule: mainBotRule(request, launched!.expectedHarness),
          usage: { inputTokens: 0, outputTokens: 0 },
          modelRequests: 0,
        });
        return { type: "subagent.opened", agent, model: guestModelOf(model) };
      }
      case "subagent.text":
      case "subagent.finish":
      case "subagent.abandon": {
        const helper = helperOf(body.agent);
        if (!helper) return refuse("invalid");
        if (body.type === "subagent.text") {
          if (!paused) await helper.log.text(body.text);
        } else if (body.type === "subagent.abandon") {
          await closeHelper(helper, { status: "failed", result: body.result }, true);
        } else {
          await closeHelper(helper, { status: body.status, result: body.result });
        }
        return { type: "recorded" };
      }
      case "ask":
        if (paused) return { type: "recorded" };
        pause();
        await events.push({
          ...body,
          text: clean(body.text),
          ...(body.detail === undefined ? {} : { detail: clean(body.detail) }),
        });
        return { type: "recorded" };
      case "takeover":
        if (paused) return { type: "recorded" };
        pause();
        await events.push({ type: "takeover", reason: clean(body.reason) });
        return { type: "recorded" };
      case "done":
        return finish(body, part);
      case "skills.index": {
        if (!(await fenceHeld()) || !live()) return revoke();
        if (skillIndexEnded || !mountedSkillSources().has(body.skill.source))
          return refuse("invalid");
        const bytes = Buffer.byteLength(JSON.stringify(body.skill));
        if (
          reportedSkills.length >= 512 ||
          reportedSkillBytes + bytes > WORKER_LIMITS.modelRequestBytes
        )
          return refuse("budget");
        reportedSkills.push(body.skill);
        reportedSkillBytes += bytes;
        return { type: "recorded" };
      }
      case "skills.index.end": {
        const receivedAt = new Date();
        if (!(await fenceHeld()) || !live()) return revoke();
        if (
          skillIndexEnded ||
          body.sources.some((source) => !mountedSkillSources().has(source)) ||
          reportedSkills.some((skill) => !body.sources.includes(skill.source))
        )
          return refuse("invalid");
        skillIndexEnded = true;
        await request.onSkillIndex?.(reportedSkills, body.sources, receivedAt);
        reportedSkills.length = 0;
        reportedSkillBytes = 0;
        return { type: "recorded" };
      }
      case "skills.collision":
        if (!(await fenceHeld()) || !live()) return revoke();
        if (++skillCollisions > 512) return refuse("budget");
        if (
          ![body.collision.kept, body.collision.ignored].every((source) =>
            mountedSkillSources().has(source),
          )
        )
          return refuse("invalid");
        await request.onSkillCollision?.({ ...body.collision, name: clean(body.collision.name) });
        return { type: "recorded" };
      case "skills.used":
        if (!(await fenceHeld()) || !live()) return revoke();
        if (++skillUses > 512) return refuse("budget");
        await request.onSkillUsed?.(clean(body.name));
        return { type: "recorded" };
      case "failed":
        if (paused && !request.persistence) return endPaused();
        fail(new Error(clean(body.message)));
        return { type: "stop", reason: "cancelled" };
      case "transcript": {
        if (!(await fenceOwned()) || !live()) return revoke();
        const agent = body.agent ?? "root";
        const helper = helperOf(agent);
        if ((agent !== "root" && !helper) || helper?.closed) return refuse("invalid");
        const ingested = transcript.ingest(agent, body, launched!.expectedHarness.name);
        if (typeof ingested === "string") return refuse(ingested);
        // The harness's own calls are timed by when it reports them.
        for (const step of ingested.entries) {
          if (step.kind === "call") recorder?.toolStart(step.callId, step.name, step.args);
          if (step.kind === "result") recorder?.toolEnd(step.callId, step.output, step.isError);
        }
        if (!helper) {
          rootTranscriptAccepted = true;
          await events.push(ingested);
        } else if (helper.log.transcript) await helper.log.transcript(ingested);
        else return { type: "error", message: "This helper keeps no transcript" };
        return { type: "recorded" };
      }
    }
  }

  const inbox: SessionInbox = createSessionInbox(worker, handle);

  /** One connection: a hello first, checked before anything else is read or written. */
  async function serve(channel: FrameChannel) {
    let accepted = false;
    try {
      for await (const frame of channel.frames) {
        const read = readGuestFrame(frame);
        if (!read.ok) return violation(read.reason, channel);
        const message = read.message;
        if (!accepted) {
          if (message.kind !== "worker.hello") return violation("invalid", channel);
          const verdict = verifyCapability(deps.key, message.capability, worker, Date.now());
          if (!verdict.ok) {
            return violation(verdict.reason === "identity" ? "identity" : "capability", channel);
          }
          const expected = launched!.expectedHarness;
          if (
            message.harness.name !== expected.name ||
            message.harness.capabilities.length !== expected.capabilities.length ||
            !expected.capabilities.every((capability) =>
              message.harness.capabilities.includes(capability),
            )
          )
            return violation("undeclared", channel);
          // Single use: one bound connection at a time, and none once the stop began.
          if (bound || stopping) return channel.close();
          accepted = true;
          bound = channel;
          helloReceived = true;
          helloSettled.resolve();
          let start: WorkerStartV1;
          try {
            start = request.helper
              ? {
                  ...launched!.start,
                  run: helperRunInput(launched!.start, request, expected, {
                    task: request.helper.task,
                    instructions: helperInstructions(
                      request.helper.name,
                      helperProfile?.instructions,
                      request.helper.instructions,
                    ),
                    model: request.model,
                    profile: helperProfile,
                  }),
                }
              : workerStart(launched!.start, request, expected);
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          rootTools = new Set(start.run.tools.map((tool) => tool.name));
          try {
            if (expected.capabilities.includes("resume")) await request.persistence?.begin();
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          await channel.send(encodeMessage(start));
          inbox.attach((reply) => void channel.send(encodeMessage(reply)));
          continue;
        }
        if (message.kind !== "worker.event") return violation("invalid", channel);
        const outcome = inbox.accept(message);
        if (!outcome.ok) return violation(outcome.reason, channel);
      }
    } catch {
      // A frame over the length limit, or a broken stream.
      if (!stopping) violation("too_large", channel);
    } finally {
      if (bound === channel) {
        inbox.detach();
        bound = undefined;
      }
    }
  }

  async function connect(guest: LaunchedGuest) {
    const serving: Promise<void>[] = [];
    void Promise.race([deps.clock.sleep(WORKER_LIMITS.helloDeadlineMs), helloSettled.promise]).then(
      () => {
        if (!helloReceived && !stopping)
          fail(new AgentRuntimeUnavailableError("The worker did not say hello in time"));
      },
    );
    for await (const channel of guest.connections) serving.push(serve(channel));
    await Promise.all(serving);
    if (!finished && !stopping) {
      if (paused) endPaused();
      else fail(new AgentRuntimeUnavailableError("The worker disconnected before the run ended"));
    }
  }

  async function stop() {
    stopped.resolve();
    helloSettled.resolve();
    inbox.revoke();
    clearRelayPrefixes(worker.attemptId);
    for (const relay of relays.values()) relay.abort();
    events.drain();
    const helpersClosed = Promise.all(
      [...helpers.values()].map((helper) =>
        closeHelper(helper, { status: "failed", result: "The worker stopped" }),
      ),
    );
    if (!launched) {
      await helpersClosed;
      return;
    }
    const guest = launched;
    await deps.stops.mark(worker.attemptId, "requested");
    const ended = guest.exited.then(() => deps.stops.mark(worker.attemptId, "process_ended"));
    // An unconfirmed stop never awaits `ended`, so its late failure must not crash the process.
    ended.catch(() => undefined);
    if (bound) {
      await bound.send(
        encodeMessage({ version: WORKER_PROTOCOL_VERSION, kind: "worker.cancel", worker }),
      );
    }
    await Promise.race([guest.exited, deps.clock.sleep(WORKER_LIMITS.cancelGraceMs)]);
    const released = guest.release().then(
      (outcome) => outcome === "released",
      () => false,
    );
    const confirmed = await Promise.race([
      released,
      deps.clock.sleep(WORKER_LIMITS.stopConfirmMs - WORKER_LIMITS.cancelGraceMs),
    ]);
    if (confirmed) await ended;
    else await deps.stops.mark(worker.attemptId, "unconfirmed");
    bound?.close();
    await helpersClosed;
  }

  return {
    worker,
    events,
    async open() {
      const capability = mintCapability(deps.key, worker, Date.now());
      launched = await deps.launcher.launch(worker, capability);
      // The harness runs its own tools in the VM: the controller never runs them for it.
      for (const tool of nativeToolsForHarness(launched.expectedHarness.name))
        tools.delete(tool.name);
      void connect(launched).catch((error: unknown) =>
        fail(error instanceof Error ? error : new Error(String(error))),
      );
    },
    /** Idempotent. Resolves once the VM is confirmed gone or recorded as unconfirmed. */
    stop() {
      stopping ??= stop();
      return stopping;
    },
    cancel(error: Error) {
      events.end(error);
    },
  };
}

import type { AdapterContext, AgentRuntime } from "@tangow/adapter-kit";
import type { LaunchPlan, RunNeeds, WorkerLaunch } from "@tangow/core";
import { redactSecrets } from "@tangow/core";
import type { PrismaClient } from "@tangow/db";
import { redactSensitiveText } from "@tangow/logging";
import { RunTraceRecorder } from "../pi-run-trace.js";
import type { TraceExporter } from "../trace-export.js";
import type { WorkerLifecycle } from "../worker-lifecycle.js";
import { createCapabilityKey } from "./capability.js";
import { WORKER_NATIVE_TOOLS } from "./guest-input.js";
import { createLifecycleLauncher, type GuestConnector, type WorkerLauncher } from "./launcher.js";
import { createSession, type WorkerClock } from "./session.js";
import { createStopJournal, type StopJournal } from "./stop-journal.js";

/** Where worker runs are exported as traces; without an exporter nothing is recorded. */
export type WorkerTrace = { exporter?: TraceExporter; serviceName?: string };

const realClock: WorkerClock = {
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms).unref?.();
    }),
};

/**
 * The run's agent harness lives in a guest VM, one per attempt. The executor keeps every
 * authority: this runtime turns guest frames into its events and callbacks, refuses what the
 * guest may not choose, measures usage on the model relay, and confirms the guest's stop. A trace
 * is recorded here, from what the controller saw, never from the guest.
 */
export function createWorkerAgentRuntime(options: {
  launcher: WorkerLauncher;
  stops: StopJournal;
  clock?: WorkerClock;
  /** The guest harness reads screens from the bot's home with its own file tool. */
  screensByPath?: boolean;
  trace?: WorkerTrace;
}): AgentRuntime {
  const key = createCapabilityKey();
  const sessions = new Map<string, ReturnType<typeof createSession>>();
  const deps = {
    key,
    launcher: options.launcher,
    stops: options.stops,
    clock: options.clock ?? realClock,
  };
  return {
    describe() {
      return {
        id: "worker",
        contractVersion: "1",
        adapterVersion: "0.1.0",
        capabilities: {
          streaming: true,
          compaction: true,
          tools: true,
          scripted: false,
          localTools: WORKER_NATIVE_TOOLS,
          screensByPath: options.screensByPath ?? false,
        },
      };
    },
    async abort(runId) {
      const session = sessions.get(runId);
      if (!session) return;
      session.cancel(new Error("The run was cancelled"));
      await session.stop();
    },
    async *run(request, context) {
      if (request.script) throw new Error("A worker run cannot follow a script");
      const exporter = options.trace?.exporter;
      const recorder =
        exporter &&
        new RunTraceRecorder({
          runId: request.runId,
          threadId: request.threadId,
          botId: request.botId,
          userId: context?.userId,
          correlationTraceId: context?.traceId,
          provider: request.model.provider,
          model: request.model.id,
          thinkingLevel: request.model.thinkingLevel ?? undefined,
          systemPrompt: request.instructions,
          history: [],
          prompt: request.prompt,
        });
      const session = createSession(request, { ...deps, recorder });
      sessions.set(request.runId, session);
      const onAbort = () => session.cancel(new Error("The run was cancelled"));
      context?.signal?.addEventListener("abort", onAbort, { once: true });
      let text = "";
      let failure: unknown;
      try {
        // An abort that landed before the listener must not launch a guest.
        if (context?.signal?.aborted) throw new Error("The run was cancelled");
        await session.open();
        while (true) {
          const event = await session.events.next();
          if (!event) return;
          if (event.type === "done") text = event.text ?? "";
          yield event;
        }
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        context?.signal?.removeEventListener("abort", onAbort);
        await session.stop();
        if (sessions.get(request.runId) === session) sessions.delete(request.runId);
        if (recorder && exporter) {
          recorder.finish(text, failure);
          const secrets = request.secrets ?? [];
          exporter.export(recorder.trace, {
            userId: context?.userId,
            spaceId: context?.spaceId,
            serviceName: options.trace?.serviceName,
            redact: (value) => redactSensitiveText(redactSecrets(value, [...secrets])),
          });
        }
      }
    },
  };
}

/** What the executor needs to run a product run in a worker: a plan, then a runtime bound to it. */
export interface RunWorkers {
  plan(input: { attemptId: string; needs: RunNeeds }): Promise<LaunchPlan>;
  runtime(launch: WorkerLaunch): AgentRuntime;
  /** Creates the volumes a computer whose home is on volumes lacks, before it mounts them. */
  provisionHomeVolumes(computerId: string, context: AdapterContext): Promise<void>;
}

export function createRunWorkers(deps: {
  prisma: PrismaClient;
  lifecycle: WorkerLifecycle;
  connector: GuestConnector;
  clock?: WorkerClock;
  screensByPath?: boolean;
  trace?: WorkerTrace;
}): RunWorkers {
  const stops = createStopJournal(deps.prisma);
  return {
    plan: (input) => deps.lifecycle.plan(input),
    provisionHomeVolumes: (computerId, context) =>
      deps.lifecycle.provisionHomeVolumes(computerId, context),
    runtime: (launch) =>
      createWorkerAgentRuntime({
        launcher: createLifecycleLauncher({ ...deps, launch }),
        stops,
        clock: deps.clock,
        screensByPath: deps.screensByPath,
        trace: deps.trace,
      }),
  };
}

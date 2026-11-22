import type { HarnessDeclaration } from "@tangow/adapter-kit";
import { createWorkerAgentRuntime } from "@tangow/adapters/runtime-worker";
import { HELPER_STOPPED_FOR_PAUSE } from "@tangow/contracts";
import { DRAFT_CARDS } from "@tangow/core";
import { describe, expect, it, vi } from "vitest";
import {
  manualLauncher,
  rawGuest,
} from "../../adapters/src/runtime-worker/raw-guest.test-support.js";
import { acmeApp } from "./draft-app.test-support.js";
import { latestCard } from "./index.js";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import { prepares } from "./model-emulator.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

const TOOL = "mcp__acme__acme_deliver_message";

const mailProposal = (address: string, body: string) => ({
  card: "mail",
  recipients: [{ role: "to", path: ["recipient"], shape: "one", addresses: [address] }],
  subject: { path: ["topic"], value: "Hello" },
  body: { path: ["content"], value: body },
  unshown: [],
});

const mailTo = (address: string, body: string, id: string): ModelEmulatorStep[] => [
  {
    expect() {},
    response: {
      type: "tool",
      id,
      name: TOOL,
      arguments: { recipient: address, topic: "Hello", content: body },
    },
  },
  prepares(mailProposal(address, body)),
];

/** The send calls to `address` the resumed model reads back among its earlier steps. */
const sendsTo = (request: ModelEmulatorRequest | undefined, address: string) =>
  (request?.messages ?? []).flatMap((message) =>
    (message.tool_calls ?? [])
      .filter(
        (call) => call.function.name.endsWith(TOOL) && call.function.arguments.includes(address),
      )
      .map((call) =>
        String(request?.messages.findLast((result) => result.tool_call_id === call.id)?.content),
      ),
  );

const PI_NATIVE: HarnessDeclaration = {
  name: "pi-native",
  capabilities: ["native-loop", "subagents"],
};

describe.skipIf(!databaseAvailable)("mail drafts in a worker run", () => {
  it("tells the bot how each draft was sent, once, however many drafts follow it", async () => {
    const acme = acmeApp();
    let third: ModelEmulatorRequest | undefined;
    const run = await startWorkerRun({
      databaseUrl: process.env.DATABASE_URL!,
      computerScope: "none",
      tools: acme.connector,
      steps: [
        ...mailTo("anna@example.test", "First draft.", "mail-a"),
        ...mailTo("ben@example.test", "Second draft.", "mail-b"),
        {
          expect(request) {
            third = request;
          },
          response: {
            type: "tool",
            id: "say",
            name: "message_user",
            arguments: { message: "Both sent." },
          },
        },
        {
          expect() {},
          response: {
            type: "text",
            text: JSON.stringify({ version: 1, results: ["Sent both"], references: [] }),
          },
        },
      ],
    });
    try {
      await acme.install(run.prisma, run);
      const sendAllowed = async (runId: string) => {
        const card = await latestCard(run.prisma, runId);
        expect(card.block.draft).toBeDefined();
        expect(
          await run.events.answerRunInput({
            spaceId: run.spaceId,
            threadId: run.thread.id,
            runId,
            messageId: card.id,
            answeredByUserId: run.userId,
            answer: "allow",
          }),
        ).toBe(true);
        await run.continueRun(runId);
      };

      const runId = await run.send("Mail Anna, then Ben.");
      await run.continueRun(runId);
      await sendAllowed(runId);
      await sendAllowed(runId);

      run.model.assertComplete();
      expect(acme.delivered.map(({ args }) => [args.recipient, args.content])).toEqual([
        ["anna@example.test", "First draft."],
        ["ben@example.test", "Second draft."],
      ]);
      for (const address of ["anna@example.test", "ben@example.test"]) {
        const [call, ...rest] = sendsTo(third, address);
        expect(rest).toEqual([]);
        expect(call).toContain("The user sent this message from the draft card,");
      }
      expect(JSON.stringify(third?.messages)).not.toContain("paused: awaiting approval");
      expect(JSON.stringify(third?.messages)).not.toContain(
        "Tangow already ran what they approved",
      );
      expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
        "completed",
      );
    } finally {
      await run.close();
    }
  }, 60_000);

  /**
   * The user sends a helper's draft before the helper's stop, the parent's pause, is logged. A
   * real launcher refuses a second worker while the first is live, so the stop lands late only
   * while that worker is released; this launcher runs both guests at once to force each order.
   */
  it.each([
    ["after the resumed attempt looked for its pause", "late"],
    ["while the resumed attempt sends the mail", "mid-send"],
  ] as const)(
    "logs a helper's draft outcome once when its stop lands %s",
    async (_, order) => {
      const acme = acmeApp();
      const sending = Promise.withResolvers<void>();
      const sent = Promise.withResolvers<void>();
      acme.beforeDeliver = async () => {
        sending.resolve();
        await sent.promise;
      };
      const launcher = manualLauncher(PI_NATIVE);
      const runtime = createWorkerAgentRuntime({
        launcher: launcher.launcher,
        stops: { mark: async () => undefined },
      });
      const run = await startWorkerRun({
        databaseUrl: process.env.DATABASE_URL!,
        computerScope: "none",
        tools: acme.connector,
        steps: [],
        runtime: () => ({
          describe: () => runtime.describe(),
          abort: (id) => runtime.abort(id),
          run(request, context) {
            if (!request.answer) return runtime.run(request, context);
            const { card: _, ...value } = mailProposal("anna@example.test", "Hi Anna.");
            return (async function* () {
              yield { type: "done" as const, answer: { name: DRAFT_CARDS.mail.name, value } };
            })();
          },
        }),
      });
      try {
        await acme.install(run.prisma, run);
        const runId = await run.send("Have the helper mail Anna.");
        const paused = run.continueRun(runId);
        const first = await launcher.launchedFor(runId);
        const guest = rawGuest(first.connect(), first.capability, PI_NATIVE);
        await guest.hello();
        guest.send(1, { type: "tool", name: "run_subagent", args: {}, executionId: "helper" });
        guest.send(2, {
          type: "tool.call",
          agent: "root",
          callId: "helper",
          name: "run_subagent",
          args: { name: "Mailer", task: "Mail Anna." },
        });
        expect((await guest.replies(2, 1))[0]).toMatchObject({ agent: "helper:1" });
        guest.send(3, { type: "tool", name: TOOL, args: {}, executionId: "mail" });
        guest.send(4, {
          type: "tool.call",
          agent: "helper:1",
          callId: "mail",
          name: TOOL,
          args: { recipient: "anna@example.test", topic: "Hello", content: "Hi Anna." },
        });
        await guest.replies(4);
        expect((await guest.replies(2)).at(-1)).toEqual({
          type: "tool.result",
          output: HELPER_STOPPED_FOR_PAUSE,
        });

        const card = await latestCard(run.prisma, runId);
        expect(
          await run.events.answerRunInput({
            spaceId: run.spaceId,
            threadId: run.thread.id,
            runId,
            messageId: card.id,
            answeredByUserId: run.userId,
            answer: "allow",
          }),
        ).toBe(true);
        const resumed = run.continueRun(runId);
        const helperStops = async () => {
          guest.send(5, {
            type: "subagent.finish",
            agent: "helper:1",
            status: "completed",
            result: "",
          });
          expect(await guest.replies(5)).toEqual([{ type: "recorded" }]);
        };
        await sending.promise;
        if (order === "mid-send") await helperStops();
        sent.resolve();
        const second = await vi.waitFor(
          async () => {
            const launched = await launcher.launchedFor(runId);
            if (launched === first) throw new Error("The run has not resumed yet");
            return launched;
          },
          { timeout: 15_000 },
        );
        const start = await rawGuest(second.connect(), second.capability, PI_NATIVE).hello();
        // Its history has no pause for an outcome to replace, so it is not told of one.
        expect(JSON.stringify(start)).not.toContain(
          "resuming this run after the user answered your draft card",
        );
        if (order === "late") await helperStops();
        guest.send(6, { type: "done" });
        await paused;

        // The stop has the outcome, logged once, so a later run reads the mail as sent.
        const entries = await run.runEntries(runId);
        const stop = entries.find((entry) => entry.type === "subagent");
        expect(stop).toMatchObject({
          payload: { callId: "helper", result: HELPER_STOPPED_FOR_PAUSE },
        });
        expect(
          entries.filter((entry) => entry.type === "tool.result" && entry.payload.replaces),
        ).toMatchObject([
          {
            payload: {
              callId: "helper",
              replaces: stop!.id,
              output: expect.stringContaining("The user sent this message from the draft card,"),
            },
          },
        ]);
        expect(acme.delivered.map(({ args }) => args.content)).toEqual(["Hi Anna."]);
        await runtime.abort(runId);
        await resumed;
      } finally {
        await run.close();
      }
    },
    60_000,
  );
});

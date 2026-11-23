import { logDraftOutcomes, settleCancelledRunCards } from "@tangow/adapters";
import { humanizeToolName } from "@tangow/core";
import { describe, expect, it } from "vitest";
import { acmeApp } from "./draft-app.test-support.js";
import { latestCard } from "./index.js";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import { prepares } from "./model-emulator.js";
import type { JourneyFixture } from "./pi-journey.test-support.js";
import { DONE, journey, reply, rpc } from "./pi-journey.test-support.js";

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

const SENT_NOTE = "The user sent this message from the draft card,";
const DISCARDED_NOTE = "The user discarded this draft,";
const PAUSED = "paused: awaiting approval";

const TOOL = "mcp__acme__acme_deliver_message";

const mailTo = (address: string, id: string, extra: Record<string, unknown> = {}) =>
  ({
    expect() {},
    response: {
      type: "tool",
      id,
      name: TOOL,
      arguments: { recipient: address, topic: "Hello", content: `Hi ${address}.`, ...extra },
    },
  }) satisfies ModelEmulatorStep;

const prepareMail = (address: string, extra: Record<string, unknown> = {}) =>
  prepares({
    card: "mail",
    recipients: [{ role: "to", path: ["recipient"], shape: "one", addresses: [address] }],
    subject: { path: ["topic"], value: "Hello" },
    body: { path: ["content"], value: `Hi ${address}.` },
    unshown: Object.keys(extra).map((key) => [key]),
  });

/** The send calls the model reads back among its earlier steps, each with its recipient and result. */
const sends = (request: ModelEmulatorRequest) => {
  const native = request.messages.flatMap((message) =>
    (message.tool_calls ?? [])
      .filter((call) => call.function.name.endsWith(TOOL))
      .map((call) =>
        JSON.stringify({
          input: call.function.arguments,
          output: request.messages.findLast((result) => result.tool_call_id === call.id)?.content,
        }),
      ),
  );
  return native.length > 0
    ? native
    : JSON.stringify(request.messages)
        .split(`(already ran ${humanizeToolName(TOOL)}`)
        .slice(1)
        .map((step) => step.split(")\\n")[0]!);
};

const count = (text: string, part: string) => text.split(part).length - 1;

/** What left the app, each as its recipient and text. */
const delivered = (acme: ReturnType<typeof acmeApp>) =>
  acme.delivered.map(({ args }) => [args.recipient, args.content]);

async function answerDraft(
  { prisma, app, cookie, bot }: JourneyFixture,
  runId: string,
  answer: "allow" | "deny",
) {
  const card = await latestCard(prisma, runId);
  await rpc(app, cookie, "threads/answer", { botId: bot.id, runId, messageId: card.id, answer });
}

describe.skipIf(!databaseAvailable)("a draft's outcome in the bot's history", () => {
  it("tells the bot how each of two drafts ended, once, whatever it does next", async () => {
    const acme = acmeApp();
    await journey(
      [
        mailTo("anna@example.test", "mail-a"),
        prepareMail("anna@example.test"),
        {
          expect(request) {
            const [first, ...rest] = sends(request);
            expect(rest).toEqual([]);
            expect(first).toContain("anna@example.test");
            expect(count(first!, SENT_NOTE)).toBe(1);
            expect(JSON.stringify(request.messages)).not.toContain(PAUSED);
          },
          response: mailTo("ben@example.test", "mail-b").response,
        },
        prepareMail("ben@example.test"),
        {
          expect(request) {
            const [first, second, ...rest] = sends(request);
            expect(rest).toEqual([]);
            expect([first, second].map((step) => count(step!, SENT_NOTE))).toEqual([1, 1]);
            expect(first).toContain("anna@example.test");
            expect(second).toContain("ben@example.test");
            expect(JSON.stringify(request.messages)).not.toContain(PAUSED);
          },
          response: reply("Both sent."),
        },
        DONE,
      ],
      async (fixture) => {
        await acme.install(fixture.prisma, fixture);
        const sent = await fixture.send("Mail Anna, then Ben.");
        await sent.settled("waiting_input");
        await answerDraft(fixture, sent.runId, "allow");
        await expect
          .poll(async () => (await latestCard(fixture.prisma, sent.runId)).block.draft?.body, {
            timeout: 15_000,
          })
          .toBe("Hi ben@example.test.");
        await sent.settled("waiting_input");
        await answerDraft(fixture, sent.runId, "allow");
        await sent.settled("completed");
        expect(delivered(acme)).toEqual([
          ["anna@example.test", "Hi anna@example.test."],
          ["ben@example.test", "Hi ben@example.test."],
        ]);
      },
      { remoteConnectors: acme.remote },
    );
  }, 60_000);

  it("tells the bot a draft was discarded, and the same mail issued again opens no new card", async () => {
    const acme = acmeApp();
    let answered: unknown;
    await journey(
      [
        mailTo("anna@example.test", "mail-1", { thought: "Mail Anna." }),
        prepareMail("anna@example.test", { thought: "Mail Anna." }),
        {
          expect(request) {
            const [only, ...rest] = sends(request);
            expect(rest).toEqual([]);
            expect(count(only!, DISCARDED_NOTE)).toBe(1);
            expect(JSON.stringify(request.messages)).not.toContain(PAUSED);
            expect(JSON.stringify(request.messages)).toContain(
              "resuming this run after the user answered your draft card",
            );
          },
          response: mailTo("anna@example.test", "mail-2", { thought: "Mail Anna." }).response,
        },
        {
          expect(request) {
            answered = JSON.parse(
              String(request.messages.findLast((message) => message.role === "tool")?.content),
            );
          },
          response: reply("Understood, nothing was sent."),
        },
        DONE,
      ],
      async (fixture) => {
        await acme.install(fixture.prisma, fixture);
        const sent = await fixture.send("Mail Anna.");
        await sent.settled("waiting_input");
        await answerDraft(fixture, sent.runId, "deny");
        await sent.settled("completed");
        expect(answered).toMatchObject({ ok: false, discarded: true });
        expect(
          await fixture.prisma.externalEffect.findMany({
            where: { runId: sent.runId, kind: TOOL },
            select: { status: true, draft: true },
          }),
        ).toMatchObject([{ status: "denied", draft: { state: "discarded" } }]);
        expect(acme.delivered).toEqual([]);
      },
      { remoteConnectors: acme.remote },
    );
  }, 60_000);

  it("tells the bot how a draft its helper raised ended, on the call that started the helper", async () => {
    const acme = acmeApp();
    await journey(
      [
        {
          expect() {},
          response: {
            type: "tool",
            id: "helper",
            name: "run_subagent",
            arguments: { category: "everyday", name: "mailer", task: "Mail Anna." },
          },
        },
        mailTo("anna@example.test", "mail-h"),
        prepareMail("anna@example.test"),
        {
          expect(request) {
            const history = JSON.stringify(request.messages);
            expect(count(history, SENT_NOTE)).toBe(1);
            expect(history).not.toContain("the run is waiting for the user");
          },
          response: reply("Sent."),
        },
        DONE,
      ],
      async (fixture) => {
        await acme.install(fixture.prisma, fixture);
        const sent = await fixture.send("Have the helper mail Anna.");
        await sent.settled("waiting_input");
        await answerDraft(fixture, sent.runId, "allow");
        await sent.settled("completed");
        expect(delivered(acme)).toEqual([["anna@example.test", "Hi anna@example.test."]]);
      },
      { remoteConnectors: acme.remote },
    );
  }, 60_000);

  it("gives a replaced draft's text to the bot whole, however long the user's edit", async () => {
    const acme = acmeApp();
    const edit = `${"A much longer text than the bot wrote. ".repeat(20)}Goodbye.`;
    await journey(
      [
        mailTo("anna@example.test", "mail-1"),
        prepareMail("anna@example.test"),
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain(edit);
          },
          response: reply("Here is a shorter one."),
        },
        DONE,
      ],
      async (fixture) => {
        await acme.install(fixture.prisma, fixture);
        const sent = await fixture.send("Mail Anna.");
        await sent.settled("waiting_input");
        const card = await latestCard(fixture.prisma, sent.runId);
        await fixture.send("Make it shorter.", { draft: { messageId: card.id, text: edit } });
        await sent.settled("completed");
      },
      { remoteConnectors: acme.remote },
    );
  }, 60_000);

  describe("a send the run ended on", () => {
    const stranded = async (fixture: JourneyFixture, acme: ReturnType<typeof acmeApp>) => {
      await acme.install(fixture.prisma, fixture);
      const sent = await fixture.send("Mail Anna.");
      await sent.settled("waiting_input");
      const effect = await fixture.prisma.externalEffect.findFirstOrThrow({
        where: { runId: sent.runId, kind: TOOL },
      });
      return { runId: sent.runId, effect };
    };

    it("is told to the bot as a result that says it may or may not have left", async () => {
      const acme = acmeApp();
      await journey(
        [mailTo("anna@example.test", "mail-1"), prepareMail("anna@example.test")],
        async (fixture) => {
          const { runId, effect } = await stranded(fixture, acme);
          const { threadId } = await fixture.prisma.run.findUniqueOrThrow({ where: { id: runId } });
          await fixture.prisma.externalEffect.update({
            where: { id: effect.id },
            data: {
              status: "denied",
              answeredAt: new Date(),
              draft: { ...(effect.draft as object), state: "unsent" },
            },
          });
          await logDraftOutcomes(
            { prisma: fixture.prisma, sessionLog: fixture.log } as never,
            { runId, threadId },
            [],
          );
          const entries = await fixture.log.readRun(runId);
          const pause = entries.find(
            (entry) => entry.type === "tool.result" && entry.payload.output === PAUSED,
          );
          expect(
            entries.filter((entry) => entry.type === "tool.result" && entry.payload.replaces),
          ).toMatchObject([
            {
              payload: {
                // A worker logs the call under the id its guest gave it, not the model's.
                callId: pause?.payload.callId,
                replaces: pause?.id,
                output: expect.stringContaining("outcome is unknown"),
              },
            },
          ]);
          await logDraftOutcomes(
            { prisma: fixture.prisma, sessionLog: fixture.log } as never,
            { runId, threadId },
            [],
          );
          expect(
            (await fixture.log.readRun(runId)).filter(
              (entry) => entry.type === "tool.result" && entry.payload.replaces,
            ),
          ).toHaveLength(1);
          expect(acme.delivered).toEqual([]);
        },
        { remoteConnectors: acme.remote },
      );
    }, 60_000);

    it("leaves a cancelled run's log as it is, without failing the stop", async () => {
      const acme = acmeApp();
      await journey(
        [mailTo("anna@example.test", "mail-1"), prepareMail("anna@example.test")],
        async (fixture) => {
          const { runId, effect } = await stranded(fixture, acme);
          await fixture.prisma.externalEffect.update({
            where: { id: effect.id },
            data: { status: "approved", draft: { ...(effect.draft as object), state: "approved" } },
          });
          await fixture.prisma.run.update({ where: { id: runId }, data: { status: "cancelled" } });
          await settleCancelledRunCards(
            {
              prisma: fixture.prisma,
              events: { notify: async () => undefined },
              sessionLog: fixture.log,
            } as never,
            [runId],
          );
          expect(
            await fixture.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } }),
          ).toMatchObject({ status: "denied", draft: { state: "unsent" } });
          expect(
            (await fixture.log.readRun(runId)).filter(
              (entry) => entry.type === "tool.result" && entry.payload.replaces,
            ),
          ).toEqual([]);
        },
        { remoteConnectors: acme.remote },
      );
    }, 60_000);
  });
});

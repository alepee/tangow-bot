import type { AskDraftEdits, ThreadEntry } from "@tangow/contracts";
import { askDraftState } from "@tangow/contracts";
import { projectThreadItems, projectThreadView } from "@tangow/core";
import { describe, expect, it } from "vitest";
import { acmeApp } from "./draft-app.test-support.js";
import { latestCard } from "./index.js";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import { prepares } from "./model-emulator.js";
import type { JourneyFixture } from "./pi-journey.test-support.js";
import { DONE, journey, reply, rpc } from "./pi-journey.test-support.js";

/** The tools a worker offers the model, by their own names: the controller's carry an MCP prefix. */
const offeredTools = (request: ModelEmulatorRequest) =>
  request.tools?.map((tool) => tool.function.name.replace(/^mcp__tangow__/, ""));

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

const RESUME_NOTE = "resuming this run after the user answered your draft card";

describe.skipIf(!databaseAvailable)("offline product journey", () => {
  describe("a draft of a tool the user's rule asks for", () => {
    const message = {
      recipient: "someone@example.test",
      topic: "Hello",
      content: "Draft from the bot.",
      urgent: false,
    };
    const prepareMessage = prepares({
      card: "mail",
      recipients: [
        { role: "to", path: ["recipient"], shape: "one", addresses: [message.recipient] },
        { role: "cc", path: ["copies"], shape: "array", addresses: [] },
      ],
      subject: { path: ["topic"], value: message.topic },
      body: { path: ["content"], value: message.content },
      unshown: [["urgent"]],
    });
    const proposeMessage: ModelEmulatorStep = {
      expect(request) {
        expect(offeredTools(request)).toContain("mcp__acme__acme_deliver_message");
        expect(JSON.stringify(request.messages)).not.toContain(RESUME_NOTE);
      },
      response: {
        type: "tool",
        id: "journey-message",
        name: "mcp__acme__acme_deliver_message",
        arguments: message,
      },
    };
    async function answerDraft(fixture: JourneyFixture, runId: string, edits?: AskDraftEdits) {
      const card = await latestCard(fixture.prisma, runId);
      await rpc(fixture.app, fixture.cookie, "threads/answer", {
        botId: fixture.bot.id,
        runId,
        messageId: card.id,
        answer: "allow",
        ...(edits ? { edits } : {}),
      });
    }

    it("leaves once, as the user edited it in the tool's own fields, before the bot's next turn", async () => {
      const acme = acmeApp();
      await journey(
        [
          proposeMessage,
          prepareMessage,
          {
            expect(request) {
              const seen = JSON.stringify(request.messages);
              expect(seen).toContain("The user sent this message from the draft card,");
              expect(seen).toContain("Edited by me.");
              expect(seen).toContain("bo@example.test");
              expect(seen).not.toContain("paused: awaiting approval");
              // The resume says so, and that another message may still be sent.
              expect(seen).toContain(RESUME_NOTE);
              expect(seen).toContain("to send another message call the send tool again");
            },
            response: reply("Sent."),
          },
          DONE,
        ],
        async (fixture) => {
          await acme.install(fixture.prisma, fixture);
          const sent = await fixture.send("Message them hello.");
          await sent.settled("waiting_input");
          expect(acme.delivered).toEqual([]);
          // The schema's one recipient and its copies, as the analysis located them.
          expect((await latestCard(fixture.prisma, sent.runId)).block.draft).toMatchObject({
            recipients: [{ role: "to", address: message.recipient }],
            subject: message.topic,
            fields: { to: 1, cc: null, subject: true },
            body: message.content,
          });
          await answerDraft(fixture, sent.runId, {
            text: "Edited by me.",
            recipients: [
              { role: "to", address: "ana@example.test" },
              { role: "cc", address: "bo@example.test" },
              { role: "cc", address: "cy@example.test" },
            ],
            subject: "Thursday instead",
          });
          await sent.settled("completed");
          expect(acme.delivered).toEqual([
            {
              tool: "mcp__acme__acme_deliver_message",
              args: {
                recipient: "ana@example.test",
                copies: ["bo@example.test", "cy@example.test"],
                topic: "Thursday instead",
                content: "Edited by me.",
                urgent: false,
              },
            },
          ]);
          // The run also records its message_user call, so the message's row is read by its tool.
          const effects = await fixture.prisma.externalEffect.findMany({
            where: { runId: sent.runId, kind: "mcp__acme__acme_deliver_message" },
          });
          expect(effects).toMatchObject([
            { status: "completed", draft: { state: "sent", proposed: "Draft from the bot." } },
          ]);
        },
        { remoteConnectors: acme.remote },
      );
    }, 30_000);

    it("shows the room's researched name and posts once to its id, with only the edited text", async () => {
      const acme = acmeApp();
      const update = { room: "R0TEAM", text: "Draft from the bot." };
      await journey(
        [
          {
            expect(request) {
              expect(offeredTools(request)).toContain("mcp__acme__acme_find_room");
            },
            response: {
              type: "tool",
              id: "journey-room-search",
              name: "mcp__acme__acme_find_room",
              arguments: { query: "launch" },
            },
          },
          {
            expect(request) {
              expect(offeredTools(request)).toContain("mcp__acme__acme_post_update");
            },
            response: {
              type: "tool",
              id: "journey-update",
              name: "mcp__acme__acme_post_update",
              arguments: update,
            },
          },
          {
            ...prepares({
              card: "chat",
              conversation: { path: ["room"], value: update.room },
              conversationName: "#launch",
              body: { path: ["text"], value: update.text },
              unshown: [],
            }),
            expect(request) {
              const prompt = request.messages
                .filter((message) => message.role === "user")
                .map((message) => String(message.content))
                .join("\n");
              const recent = JSON.parse(
                prompt.split("<recent_tool_context>\n")[1]!.split("\n</recent_tool_context>")[0]!,
              );
              expect(recent.join("\n")).toContain("R0TEAM");
              expect(recent.join("\n")).toContain("#launch");
            },
          },
          {
            expect(request) {
              expect(JSON.stringify(request.messages)).toContain("Edited by me.");
            },
            response: reply("Sent."),
          },
          DONE,
        ],
        async (fixture) => {
          await acme.install(fixture.prisma, fixture);
          const sent = await fixture.send("Tell the team.");
          await sent.settled("waiting_input");
          const { draft } = (await latestCard(fixture.prisma, sent.runId)).block;
          expect(draft).toMatchObject({
            recipients: [{ role: "to", address: "#launch" }],
            chat: true,
            body: "Draft from the bot.",
          });
          expect(draft?.fields).toBeUndefined();
          await answerDraft(fixture, sent.runId, { text: "Edited by me." });
          await sent.settled("completed");
          expect((await latestCard(fixture.prisma, sent.runId)).block.draft?.recipients).toEqual([
            { role: "to", address: "#launch" },
          ]);
          expect(acme.delivered).toEqual([
            { tool: "mcp__acme__acme_post_update", args: { ...update, text: "Edited by me." } },
          ]);
        },
        { remoteConnectors: acme.remote },
      );
    }, 30_000);

    it("asks the user to check the app when the answer was lost after it left, sending nothing more", async () => {
      const acme = acmeApp();
      await journey(
        [proposeMessage, prepareMessage],
        async (fixture) => {
          await acme.install(fixture.prisma, fixture);
          acme.failNext({ kind: "delivered_unanswered" });
          const sent = await fixture.send("Message them hello.");
          await sent.settled("waiting_input");
          await answerDraft(fixture, sent.runId);
          await expect
            .poll(async () => (await latestCard(fixture.prisma, sent.runId)).block, {
              timeout: 15_000,
            })
            .toMatchObject({
              status: "pending",
              draft: {
                failure: { reason: expect.stringMatching(/^Check .+ before trying again\.$/) },
              },
            });
          await sent.settled("waiting_input");
          expect(acme.delivered.map((call) => call.args.content)).toEqual(["Draft from the bot."]);
        },
        { remoteConnectors: acme.remote },
      );
    }, 30_000);

    it("shows Not sent when the app refuses it, and Try again sends it once", async () => {
      const acme = acmeApp();
      await journey(
        [
          proposeMessage,
          prepareMessage,
          {
            expect(request) {
              const seen = JSON.stringify(request.messages);
              expect(seen).toContain("The user sent this message from the draft card,");
            },
            response: reply("Sent."),
          },
          DONE,
        ],
        async (fixture) => {
          await acme.install(fixture.prisma, fixture);
          acme.failNext({ kind: "refuse", error: "Invalid recipient" });
          const sent = await fixture.send("Message them hello.");
          await sent.settled("waiting_input");
          await answerDraft(fixture, sent.runId);
          await expect
            .poll(async () => (await latestCard(fixture.prisma, sent.runId)).block, {
              timeout: 15_000,
            })
            .toMatchObject({
              status: "pending",
              draft: { failure: { reason: "Invalid recipient" } },
            });
          await sent.settled("waiting_input");
          expect(acme.delivered).toEqual([]);
          await answerDraft(fixture, sent.runId);
          await sent.settled("completed");
          expect(acme.delivered.map((call) => call.args.content)).toEqual(["Draft from the bot."]);
        },
        { remoteConnectors: acme.remote },
      );
    }, 30_000);

    it("is replaced by what the user writes, the bot reading their edit and nothing leaving", async () => {
      const acme = acmeApp();
      await journey(
        [
          proposeMessage,
          prepareMessage,
          {
            expect(request) {
              const seen = JSON.stringify(request.messages);
              expect(seen).toContain(
                "The user wrote to you instead of sending this draft, so nothing was sent.",
              );
              expect(seen).toContain("Edited by me.");
              expect(seen).toContain("Make it shorter.");
              expect(seen).not.toContain("paused: awaiting approval");
            },
            response: reply("Here is a shorter one."),
          },
          DONE,
        ],
        async (fixture) => {
          await acme.install(fixture.prisma, fixture);
          const sent = await fixture.send("Message them hello.");
          await sent.settled("waiting_input");
          const card = await latestCard(fixture.prisma, sent.runId);
          await expect(
            fixture.send("Make it shorter.", {
              draft: { messageId: "entry_stale", text: "Edited by me." },
            }),
          ).rejects.toThrow("threads/send: 409");
          await fixture.send("Make it shorter.", {
            draft: { messageId: card.id, text: "Edited by me." },
          });
          await sent.settled("completed");

          expect(acme.delivered).toEqual([]);
          const effect = await fixture.prisma.externalEffect.findFirstOrThrow({
            where: { runId: sent.runId, kind: "mcp__acme__acme_deliver_message" },
          });
          expect(effect).toMatchObject({
            status: "denied",
            draft: { state: "replaced", proposed: "Draft from the bot." },
          });
          const thread = await rpc<{ entries: ThreadEntry[] }>(
            fixture.app,
            fixture.cookie,
            "threads/get",
            { botId: fixture.bot.id },
          );
          const cards = projectThreadItems(thread.entries).flatMap((item) =>
            item.kind === "effect" && item.card ? [askDraftState(item.card)] : [],
          );
          expect(cards).toEqual(["replaced"]);
          const replacement = thread.entries.findLast((entry) => entry.type === "user.message")!;
          await rpc(fixture.app, fixture.cookie, "threads/rewind", {
            botId: fixture.bot.id,
            messageId: replacement.id,
          });
          const rewound = await rpc<{ entries: ThreadEntry[] }>(
            fixture.app,
            fixture.cookie,
            "threads/get",
            { botId: fixture.bot.id },
          );
          const view = projectThreadView(rewound.entries);
          expect(view.waiting).toBeNull();
          expect(
            view.rows.flatMap(({ item }) =>
              item.kind === "effect" && item.card ? [askDraftState(item.card)] : [],
            ),
          ).toEqual(["replaced"]);
        },
        { remoteConnectors: acme.remote },
      );
    }, 30_000);

    it("tells the bot about the replaced draft once, as its call's result, whatever it does next", async () => {
      const acme = acmeApp();
      // An answer to the bot's next card quotes the run's steps as they were, so only the history counts.
      const told = (request: ModelEmulatorRequest) =>
        JSON.stringify(request.messages)
          .replace(/<reply_target>[\s\S]*?<\/reply_target>/g, "")
          .split("editedByUser").length - 1;
      await journey(
        [
          proposeMessage,
          prepareMessage,
          {
            expect(request) {
              expect(told(request)).toBe(1);
            },
            response: {
              type: "tool",
              id: "journey-which",
              name: "ask_user",
              arguments: { question: "Formal or casual?", options: ["Formal", "Casual"] },
            },
          },
          {
            expect(request) {
              expect(told(request)).toBe(1);
            },
            response: reply("Here is a casual one."),
          },
          DONE,
        ],
        async (fixture) => {
          await acme.install(fixture.prisma, fixture);
          const sent = await fixture.send("Message them hello.");
          await sent.settled("waiting_input");
          const card = await latestCard(fixture.prisma, sent.runId);
          await fixture.send("Make it shorter.", {
            draft: { messageId: card.id, text: "Edited by me." },
          });
          await expect
            .poll(async () => (await latestCard(fixture.prisma, sent.runId)).id, {
              timeout: 15_000,
            })
            .not.toBe(card.id);
          await sent.settled("waiting_input");
          const question = await latestCard(fixture.prisma, sent.runId);
          await rpc(fixture.app, fixture.cookie, "threads/answer", {
            botId: fixture.bot.id,
            runId: sent.runId,
            messageId: question.id,
            answer: "choice-2",
          });
          await sent.settled("completed");
          expect(acme.delivered).toEqual([]);
        },
        { remoteConnectors: acme.remote },
      );
    }, 30_000);
  });

  it("does not tell a run resumed after a plain question that it answered a draft card", async () => {
    await journey(
      [
        {
          expect() {},
          response: {
            type: "tool",
            id: "journey-which",
            name: "ask_user",
            arguments: { question: "Formal or casual?", options: ["Formal", "Casual"] },
          },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("Casual");
            expect(JSON.stringify(request.messages)).not.toContain(RESUME_NOTE);
          },
          response: reply("Casual it is."),
        },
        DONE,
      ],
      async (fixture) => {
        const sent = await fixture.send("Write to them.");
        await sent.settled("waiting_input");
        const question = await latestCard(fixture.prisma, sent.runId);
        await rpc(fixture.app, fixture.cookie, "threads/answer", {
          botId: fixture.bot.id,
          runId: sent.runId,
          messageId: question.id,
          answer: "choice-2",
        });
        await sent.settled("completed");
      },
    );
  }, 30_000);
});

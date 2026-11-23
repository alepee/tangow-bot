import type { Bot } from "@tangow/contracts";
import { describe, expect, it } from "vitest";
import { createBotRecords } from "./bot-records";

function bot(partial: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    spaceId: "space-1",
    name: "Scout",
    title: "",
    description: "",
    instructions: "",
    color: "#3CC9A0",
    shapeSeed: null,
    avatarCharacter: null,
    notifyOnFinish: true,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    memoryScope: null,
    threadId: "thread-1",
    preview: "",
    status: "idle",
    computerMode: "team",
    updatedAt: "2026-10-06T09:00:00.000Z",
    createdAt: "2026-10-01T09:00:00.000Z",
    voiceId: null,
    autoSpeak: false,
    chattyReplies: false,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    webhookConfigured: false,
    spawnKey: null,
    isOwner: true,
    ...partial,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("bot records", () => {
  it("keeps a newer write when an older one answers last", async () => {
    const records = createBotRecords();
    const first = deferred<Bot>();
    const second = deferred<Bot>();
    const a = records.write("bot-1", () => first.promise);
    const b = records.write("bot-1", () => second.promise);
    second.resolve(bot({ name: "Second" }));
    await b;
    first.resolve(bot({ name: "First" }));
    await a;
    expect(records.bot("bot-1")?.name).toBe("Second");
  });

  it("keeps both of two quick writes when the server answered them in reverse", async () => {
    const records = createBotRecords();
    await records.read("bot-1", async () => bot());
    const nameWrite = deferred<Bot>();
    const titleWrite = deferred<Bot>();
    const a = records.write("bot-1", () => nameWrite.promise, ["name"]);
    const b = records.write("bot-1", () => titleWrite.promise, ["title"]);
    // The server applied the title first, so the name's answer is the newest row.
    titleWrite.resolve(bot({ title: "Reads the news" }));
    await b;
    nameWrite.resolve(bot({ name: "Scout 2", title: "Reads the news" }));
    await a;
    expect(records.bot("bot-1")).toMatchObject({ name: "Scout 2", title: "Reads the news" });
  });

  it("drops a read that a write overlapped, and lands one that ran alone", async () => {
    const records = createBotRecords();
    const read = deferred<Bot>();
    const reading = records.read("bot-1", () => read.promise);
    await records.write("bot-1", async () => bot({ instructions: "Be brief" }));
    read.resolve(bot({ instructions: "" }));
    await reading;
    expect(records.bot("bot-1")?.instructions).toBe("Be brief");

    await records.read("bot-1", async () => bot({ instructions: "Changed by the bot" }));
    expect(records.bot("bot-1")?.instructions).toBe("Changed by the bot");
  });

  it("lands a read started during a save, and keeps the field that save sent", async () => {
    const records = createBotRecords();
    await records.read("bot-1", async () => bot());
    const save = deferred<Bot>();
    const saving = records.write("bot-1", () => save.promise, ["name"]);
    await records.read("bot-1", async () => bot({ title: "Set by the bot" }));
    save.resolve(bot({ name: "Scout 2" }));
    await saving;
    expect(records.bot("bot-1")).toMatchObject({ name: "Scout 2", title: "Set by the bot" });
  });

  it("does not let an older read replace a newer one", async () => {
    const records = createBotRecords();
    const older = deferred<Bot>();
    const newer = deferred<Bot>();
    const a = records.read("bot-1", () => older.promise);
    const b = records.read("bot-1", () => newer.promise);
    newer.resolve(bot({ title: "Newer" }));
    await b;
    older.resolve(bot({ title: "Older" }));
    await a;
    expect(records.bot("bot-1")?.title).toBe("Newer");
  });

  it("forgets everything on reset and ignores answers still in flight", async () => {
    const records = createBotRecords();
    await records.read("bot-1", async () => bot());
    const late = deferred<Bot>();
    const writing = records.write("bot-1", () => late.promise);
    records.reset();
    late.resolve(bot({ name: "Late" }));
    await writing;
    expect(records.bot("bot-1")).toBeUndefined();
  });
});

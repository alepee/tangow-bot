import { AVATAR_CHARACTER_IDS } from "@tangow/contracts";
import { describe, expect, it } from "vitest";
import { bootstrapUserSpace } from "./bootstrap-user.js";
import { applyMigration, migrationNames, openPgliteDatabase } from "./pglite.test-support.js";
import { createRepos, pickFreeCharacter } from "./repos.js";

const MIGRATION = "20261115120000_bot_avatar_character";

describe("pickFreeCharacter", () => {
  it("starts with the first character and walks the catalogue while all are free", () => {
    expect(pickFreeCharacter([])).toBe("scout");
    expect(pickFreeCharacter(["scout"])).toBe("atlas");
    expect(pickFreeCharacter(["scout", "atlas", null])).toBe("ivy");
  });

  it("reuses the least used character, the earliest on a tie, once all are taken", () => {
    const all = [...AVATAR_CHARACTER_IDS];
    expect(pickFreeCharacter([...all, ...all])).toBe("scout");
    expect(pickFreeCharacter([...all, ...all.filter((id) => id !== "ivy")])).toBe("ivy");
  });
});

describe("a bot's avatar character", () => {
  it("is different for each bot an owner creates", async () => {
    const database = await openPgliteDatabase();
    try {
      const { prisma } = database;
      await prisma.user.create({
        data: { id: "owner", name: "Owner", email: "owner@tangow.test" },
      });
      await bootstrapUserSpace(
        prisma,
        { id: "owner" },
        { signupsEnabled: "true", signupAllowlist: undefined },
      );
      const { spaceId } = await prisma.spaceMember.findFirstOrThrow({ where: { userId: "owner" } });
      const actor = {
        userId: "owner",
        spaceId,
        email: "owner@tangow.test",
        isDeploymentOwner: false,
      };
      const create = (name: string) =>
        createRepos(prisma).createBot(actor, {
          name,
          title: "",
          description: "",
          instructions: "",
          notifyOnFinish: false,
        });

      const first = await create("First");
      const second = await create("Second");

      expect([first.avatarCharacter, second.avatarCharacter]).toEqual(["scout", "atlas"]);
      expect(second.color).toBe("#8287AD");
    } finally {
      await database.close();
    }
  }, 60_000);

  it("is given to existing bots by creation order within their owner and space", async () => {
    const database = await openPgliteDatabase(async (pglite) => {
      const names = await migrationNames();
      for (const name of names.filter((name) => name < MIGRATION)) {
        await applyMigration(pglite, name);
      }
      await pglite.exec(`
        INSERT INTO "user" (id, name, email, "updatedAt")
          VALUES ('ana', 'Ana', 'ana@example.test', '2026-11-15'),
            ('ben', 'Ben', 'ben@example.test', '2026-11-15');
        INSERT INTO organization (id, name, slug, "createdAt")
          VALUES ('org', 'Org', 'org', '2026-11-15');
        INSERT INTO spaces (id, "organizationId", name) VALUES ('space', 'org', 'Space');
        INSERT INTO bots (id, "spaceId", "userId", name, color, "createdAt", "updatedAt")
          VALUES ('ana_1', 'space', 'ana', 'A1', '#111111', '2026-11-01', '2026-11-15'),
            ('ana_2', 'space', 'ana', 'A2', '#222222', '2026-11-02', '2026-11-15'),
            ('ben_1', 'space', 'ben', 'B1', '#333333', '2026-11-03', '2026-11-15'),
            ('ana_3', 'space', 'ana', 'A3', '#444444', '2026-11-04', '2026-11-15');
      `);
      for (const name of names.filter((name) => name >= MIGRATION)) {
        await applyMigration(pglite, name);
      }
    });
    try {
      const rows = await database.prisma.bot.findMany({
        select: { id: true, color: true, avatarCharacter: true },
        orderBy: { createdAt: "asc" },
      });
      expect(rows).toEqual([
        { id: "ana_1", color: "#111111", avatarCharacter: "scout" },
        { id: "ana_2", color: "#222222", avatarCharacter: "atlas" },
        { id: "ben_1", color: "#333333", avatarCharacter: "scout" },
        { id: "ana_3", color: "#444444", avatarCharacter: "ivy" },
      ]);
    } finally {
      await database.close();
    }
  }, 60_000);
});

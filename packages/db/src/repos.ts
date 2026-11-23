import type { AvatarCharacterId } from "@tangow/contracts";
import {
  type Actor,
  AVATAR_CHARACTER_IDS,
  BOT_COLORS,
  type Bot,
  type BotSection,
  botDisplayColor,
  type MessageBlock,
  type SpaceBot,
} from "@tangow/contracts";
import { ensureMemberThreads, sharedWithFilter } from "./bot-sharing.js";
import type { PrismaClient } from "./client.js";
import { type ComputerMode, ensureComputerRecord, parseComputerMode } from "./computers.js";
import { groupMembershipFilter } from "./groups.js";
import { createThreadMessageInTransaction } from "./messages.js";
import { BotSectionNameConflictError, IsolationError } from "./scope.js";
import { lockSpaceForContentCreation } from "./spaces.js";
import { activeRunSelection, ownerRunSelection, sessionPreviews } from "./thread-listing.js";

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

function isSpawnKeyConflict(error: unknown): boolean {
  if (!isUniqueViolation(error)) return false;
  const target = (error as { meta?: { target?: string[] | string } }).meta?.target;
  if (target == null) return true;
  const fields = Array.isArray(target) ? target : [target];
  return fields.some((field) => field === "spawnKey" || field.includes("spawnKey"));
}

/** The catalogue character the owner has the fewest of, the earliest in the catalogue on a tie. */
export function pickFreeCharacter(usedIds: readonly (string | null)[]): AvatarCharacterId {
  const uses = (id: string) => usedIds.filter((used) => used === id).length;
  return AVATAR_CHARACTER_IDS.reduce((best, id) => (uses(id) < uses(best) ? id : best));
}

function mapBot(
  bot: {
    id: string;
    spaceId: string;
    name: string;
    title: string;
    description: string;
    instructions: string;
    color: string;
    shapeSeed: number | null;
    avatarCharacter: string | null;
    notifyOnFinish: boolean;
    pinned: boolean;
    sectionId: string | null;
    archivedAt: Date | null;
    parentBotId: string | null;
    memoryScope: string | null;
    createdAt: Date;
    updatedAt: Date;
    thread: { id: string; unread: boolean } | null;
    computer: { scope: string } | null;
    voiceId?: string | null;
    autoSpeak?: boolean;
    chattyReplies?: boolean;
    modelProvider?: string | null;
    modelId?: string | null;
    thinkingLevel?: string | null;
    teamChatAmbientEnabled?: boolean;
    teamChatRules?: string;
    webhookSecretId?: string | null;
    spawnKey?: string | null;
  },
  preview = "",
  status = "idle",
): Bot {
  if (!bot.thread) {
    throw new IsolationError("Bot is missing its thread");
  }
  return {
    id: bot.id,
    spaceId: bot.spaceId,
    name: bot.name,
    title: bot.title,
    description: bot.description,
    instructions: bot.instructions,
    color: botDisplayColor(bot),
    shapeSeed: bot.shapeSeed,
    avatarCharacter: bot.avatarCharacter,
    notifyOnFinish: bot.notifyOnFinish,
    pinned: bot.pinned,
    sectionId: bot.sectionId,
    archivedAt: bot.archivedAt?.toISOString() ?? null,
    unread: bot.thread.unread,
    parentBotId: bot.parentBotId,
    memoryScope: bot.memoryScope as "isolated" | "shared" | null,
    threadId: bot.thread.id,
    preview,
    status,
    computerMode: bot.computer ? parseComputerMode(bot.computer.scope) : "team",
    createdAt: bot.createdAt.toISOString(),
    updatedAt: bot.updatedAt.toISOString(),
    voiceId: bot.voiceId ?? null,
    autoSpeak: bot.autoSpeak ?? false,
    chattyReplies: bot.chattyReplies ?? false,
    modelProvider: bot.modelProvider ?? null,
    modelId: bot.modelId ?? null,
    thinkingLevel: (bot.thinkingLevel as Bot["thinkingLevel"]) ?? null,
    teamChatAmbientEnabled: bot.teamChatAmbientEnabled ?? false,
    teamChatRules: bot.teamChatRules ?? "",
    webhookConfigured: Boolean(bot.webhookSecretId),
    spawnKey: bot.spawnKey ?? null,
    isOwner: true,
  };
}

/**
 * What a member sees of a bot shared with them: who it is and their own thread with it, never how
 * its owner set it up. The owner's pin and section are the owner's too.
 */
const SHARED_BOT_SETTINGS = {
  title: "",
  description: "",
  instructions: "",
  notifyOnFinish: false,
  pinned: false,
  sectionId: null,
  archivedAt: null,
  parentBotId: null,
  memoryScope: null,
  computerMode: "team",
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
  isOwner: false,
} as const satisfies Partial<Bot>;

export function createRepos(prisma: PrismaClient) {
  /** Bots shared with `userId`, each with that person's own thread in place of the owner's. */
  async function findSharedBots(userId: string, spaceId: string | { in: string[] }) {
    const query = () =>
      prisma.bot.findMany({
        where: sharedWithFilter(userId, spaceId),
        select: {
          id: true,
          spaceId: true,
          name: true,
          color: true,
          shapeSeed: true,
          avatarCharacter: true,
          createdAt: true,
          updatedAt: true,
          memberThreads: {
            where: { userId },
            select: { id: true, unread: true, sessionId: true, runs: activeRunSelection },
          },
        },
        orderBy: { createdAt: "asc" },
      });
    let bots = await query();
    if (await ensureMemberThreads(prisma, userId, bots)) bots = await query();
    return bots.flatMap(({ memberThreads: [thread], ...bot }) =>
      thread ? [{ ...SHARED_BOT_SETTINGS, ...bot, thread }] : [],
    );
  }

  async function listBotSectionsForSpaces(
    actor: Actor,
    spaceIds: string[],
  ): Promise<Array<BotSection & { spaceId: string }>> {
    if (spaceIds.length === 0) return [];
    const sections = await prisma.botSection.findMany({
      where: { spaceId: { in: spaceIds }, userId: actor.userId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    });
    return sections.map((section) => ({
      id: section.id,
      spaceId: section.spaceId,
      name: section.name,
      position: section.position,
      createdAt: section.createdAt.toISOString(),
      updatedAt: section.updatedAt.toISOString(),
    }));
  }

  async function listSpaceBotsForSpaces(actor: Actor, spaceIds: string[]): Promise<SpaceBot[]> {
    if (spaceIds.length === 0) return [];
    const bots = await prisma.bot.findMany({
      where: {
        spaceId: { in: spaceIds },
        userId: actor.userId,
        archivedAt: null,
      },
      select: {
        id: true,
        spaceId: true,
        name: true,
        title: true,
        color: true,
        shapeSeed: true,
        avatarCharacter: true,
        notifyOnFinish: true,
        pinned: true,
        sectionId: true,
        updatedAt: true,
        thread: { select: { unread: true, sessionId: true } },
        runs: ownerRunSelection,
      },
      orderBy: [{ pinned: "desc" }, { position: "asc" }, { createdAt: "asc" }],
    });
    const shared = await findSharedBots(actor.userId, { in: spaceIds });
    const rows = [
      ...bots.map(({ runs, ...bot }) => {
        if (!bot.thread) throw new IsolationError("Bot is missing its thread");
        return { ...bot, thread: { ...bot.thread, runs } };
      }),
      ...shared,
    ];
    const previews = await sessionPreviews(
      prisma,
      rows.map((bot) => bot.thread.sessionId),
    );
    return rows.map((bot) => ({
      id: bot.id,
      spaceId: bot.spaceId,
      name: bot.name,
      title: bot.title,
      color: botDisplayColor(bot),
      shapeSeed: bot.shapeSeed,
      avatarCharacter: bot.avatarCharacter,
      notifyOnFinish: bot.notifyOnFinish,
      pinned: bot.pinned,
      sectionId: bot.sectionId,
      unread: bot.thread.unread,
      preview: previews.get(bot.thread.sessionId) ?? "",
      status: bot.thread.runs[0]?.status ?? "idle",
      updatedAt: bot.updatedAt.toISOString(),
    }));
  }

  return {
    async listBotSections(actor: Actor): Promise<BotSection[]> {
      return listBotSectionsForSpaces(actor, [actor.spaceId]);
    },

    listBotSectionsForSpaces,

    async createBotSection(
      actor: Actor,
      input: { botId?: string; groupId?: string; name: string },
    ) {
      const { name } = input;
      return prisma.$transaction(async (tx) => {
        const target = input.botId
          ? await tx.bot.findFirst({
              where: {
                id: input.botId,
                spaceId: actor.spaceId,
                userId: actor.userId,
                archivedAt: null,
              },
              select: { id: true },
            })
          : await tx.chatGroup.findFirst({
              where: {
                id: input.groupId,
                ...groupMembershipFilter(actor.userId, actor.spaceId),
                archivedAt: null,
              },
              select: { id: true },
            });
        if (!target) throw new IsolationError();

        const aggregate = await tx.botSection.aggregate({
          where: { spaceId: actor.spaceId, userId: actor.userId },
          _max: { position: true },
        });
        await tx.botSection.createMany({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            name,
            position: (aggregate._max.position ?? -1) + 1,
          },
          skipDuplicates: true,
        });
        const section = await tx.botSection.findUniqueOrThrow({
          where: {
            spaceId_userId_name: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              name,
            },
          },
        });
        if (input.botId) {
          await tx.bot.update({ where: { id: target.id }, data: { sectionId: section.id } });
        } else {
          await tx.chatGroupPerson.update({
            where: { groupId_userId: { groupId: target.id, userId: actor.userId } },
            data: { sectionId: section.id },
          });
        }
        return {
          id: section.id,
          name: section.name,
          position: section.position,
          createdAt: section.createdAt.toISOString(),
          updatedAt: section.updatedAt.toISOString(),
        } satisfies BotSection;
      });
    },

    async updateBotSection(actor: Actor, input: { sectionId: string; name: string }) {
      const existing = await prisma.botSection.findFirst({
        where: {
          id: input.sectionId,
          spaceId: actor.spaceId,
          userId: actor.userId,
        },
      });
      if (!existing) throw new IsolationError();
      if (existing.name === input.name) {
        return {
          id: existing.id,
          name: existing.name,
          position: existing.position,
          createdAt: existing.createdAt.toISOString(),
          updatedAt: existing.updatedAt.toISOString(),
        } satisfies BotSection;
      }
      try {
        const section = await prisma.botSection.update({
          where: { id: existing.id },
          data: { name: input.name },
        });
        return {
          id: section.id,
          name: section.name,
          position: section.position,
          createdAt: section.createdAt.toISOString(),
          updatedAt: section.updatedAt.toISOString(),
        } satisfies BotSection;
      } catch (error) {
        if (isUniqueViolation(error)) throw new BotSectionNameConflictError();
        throw error;
      }
    },

    async listBots(actor: Actor, options: { archived?: boolean } = {}): Promise<Bot[]> {
      const bots = await prisma.bot.findMany({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          archivedAt: options.archived ? { not: null } : null,
        },
        include: {
          thread: true,
          runs: ownerRunSelection,
          computer: { select: { scope: true } },
        },
        orderBy: [{ pinned: "desc" }, { position: "asc" }, { createdAt: "asc" }],
      });
      const shared = options.archived ? [] : await findSharedBots(actor.userId, actor.spaceId);
      const previews = await sessionPreviews(prisma, [
        ...bots.flatMap((bot) => bot.thread?.sessionId ?? []),
        ...shared.map((bot) => bot.thread.sessionId),
      ]);
      return [
        ...bots.map((bot) =>
          mapBot(
            bot,
            (bot.thread && previews.get(bot.thread.sessionId)) ?? "",
            bot.runs[0]?.status ?? "idle",
          ),
        ),
        ...shared.map(
          ({ thread, createdAt, updatedAt, ...bot }): Bot => ({
            ...bot,
            color: botDisplayColor(bot),
            threadId: thread.id,
            unread: thread.unread,
            preview: previews.get(thread.sessionId) ?? "",
            status: thread.runs[0]?.status ?? "idle",
            createdAt: createdAt.toISOString(),
            updatedAt: updatedAt.toISOString(),
          }),
        ),
      ];
    },

    listSpaceBotsForSpaces,

    /** The actor's own bot; a bot shared with them is reached through `sharedBotThread`. */
    async getBot(actor: Actor, botId: string, options: { includeArchived?: boolean } = {}) {
      const bot = await prisma.bot.findFirst({
        where: {
          id: botId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          ...(options.includeArchived ? {} : { archivedAt: null }),
        },
        include: { thread: true, computer: true },
      });
      if (!bot) throw new IsolationError();
      return bot;
    },

    async createBot(
      actor: Actor,
      input: {
        name: string;
        title: string;
        description: string;
        instructions: string;
        notifyOnFinish: boolean;
        color?: string;
        parentBotId?: string | null;
        computerMode?: ComputerMode;
        spawnKey?: string;
        modelProvider?: string | null;
        modelId?: string | null;
        thinkingLevel?: string | null;
        initialMessage?: { role: "user" | "system"; blocks: MessageBlock[] };
      },
    ): Promise<Bot> {
      let color = input.color;
      if (color === undefined) {
        const count = await prisma.bot.count({
          where: { spaceId: actor.spaceId, userId: actor.userId },
        });
        color = BOT_COLORS[count % BOT_COLORS.length] ?? BOT_COLORS[0];
      }
      let modelProvider = input.modelProvider ?? null;
      let modelId = input.modelId ?? null;
      let thinkingLevel = input.thinkingLevel ?? null;
      if (input.parentBotId) {
        const parent = await prisma.bot.findFirst({
          where: {
            id: input.parentBotId,
            spaceId: actor.spaceId,
            userId: actor.userId,
          },
        });
        if (!parent) throw new IsolationError();
        if (!modelId) {
          modelProvider = parent.modelProvider ?? null;
          modelId = parent.modelId ?? null;
        }
        if (thinkingLevel == null) thinkingLevel = parent.thinkingLevel ?? null;
      }
      const kind = process.env.SANDBOX_PROVIDER ?? "docker";
      const insertBot = () =>
        prisma.$transaction(async (tx) => {
          await lockSpaceForContentCreation(tx, {
            spaceId: actor.spaceId,
            userId: actor.userId,
          });
          const positions = await tx.bot.aggregate({
            where: { spaceId: actor.spaceId, userId: actor.userId },
            _max: { position: true },
          });
          const teamComputer = await ensureComputerRecord(tx, {
            mode: "team",
            spaceId: actor.spaceId,
            userId: actor.userId,
            kind,
            // A new home starts on volumes, so its runs go to workers with no move.
            homeStorage: kind === "e2b" || kind === "docker" ? "volumes" : "snapshot",
          });
          const avatarCharacter = pickFreeCharacter(
            (
              await tx.bot.findMany({
                where: { spaceId: actor.spaceId, userId: actor.userId },
                select: { avatarCharacter: true },
              })
            ).map((row) => row.avatarCharacter),
          );
          const created = await tx.bot.create({
            data: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              name: input.name,
              title: input.title,
              description: input.description,
              instructions: input.instructions,
              notifyOnFinish: input.notifyOnFinish,
              color,
              avatarCharacter,
              position: (positions._max.position ?? -1) + 1,
              parentBotId: input.parentBotId ?? null,
              computerId: teamComputer.id,
              spawnKey: input.spawnKey,
              modelProvider,
              modelId,
              thinkingLevel,
            },
          });
          const thread = await tx.thread.create({
            data: {
              spaceId: actor.spaceId,
              botId: created.id,
              userId: actor.userId,
            },
          });
          if (input.initialMessage) {
            await createThreadMessageInTransaction(tx, {
              threadId: thread.id,
              ...input.initialMessage,
            });
          }
          if (input.computerMode === "dedicated") {
            const dedicated = await ensureComputerRecord(tx, {
              mode: "dedicated",
              spaceId: actor.spaceId,
              userId: actor.userId,
              botId: created.id,
              kind,
              // A space whose team home is still a snapshot keeps one shared folder until it moves.
              homeStorage: teamComputer.homeStorage,
            });
            await tx.bot.update({ where: { id: created.id }, data: { computerId: dedicated.id } });
          }
          await tx.browserProfile.create({
            data: {
              spaceId: actor.spaceId,
              botId: created.id,
              userId: actor.userId,
            },
          });
          await tx.memoryDocument.create({
            data: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              botId: created.id,
              scope: "bot",
              path: "MEMORY.md",
              content: `# ${input.name}\n\n`,
            },
          });
          return tx.bot.findFirstOrThrow({
            where: { id: created.id },
            include: { thread: true, computer: true },
          });
        });

      const findBySpawnKey = async () => {
        if (!input.spawnKey) return null;
        return prisma.bot.findUnique({
          where: {
            spaceId_userId_spawnKey: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              spawnKey: input.spawnKey,
            },
          },
          include: { thread: true, computer: true },
        });
      };

      let bot: Awaited<ReturnType<typeof insertBot>>;
      try {
        bot = await insertBot();
      } catch (error) {
        if (!input.spawnKey || !isSpawnKeyConflict(error)) throw error;
        const existing = await findBySpawnKey();
        if (!existing || existing.userId !== actor.userId) throw error;
        if (!existing.archivedAt) {
          bot = existing;
        } else {
          // Free the key from the archived bot so empty-space onboarding
          // creates a fresh first bot (stale thread/runtime must not return).
          await prisma.bot.update({
            where: { id: existing.id },
            data: { spawnKey: null },
          });
          try {
            bot = await insertBot();
          } catch (retryError) {
            if (!isSpawnKeyConflict(retryError)) throw retryError;
            const winner = await findBySpawnKey();
            if (!winner || winner.userId !== actor.userId || winner.archivedAt) throw retryError;
            bot = winner;
          }
        }
      }
      return mapBot(bot);
    },

    async reorderBots(actor: Actor, botIds: string[]): Promise<void> {
      await prisma.$transaction(async (tx) => {
        const bots = await tx.bot.findMany({
          where: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            archivedAt: null,
          },
          select: { id: true },
        });
        const existing = new Set(bots.map((bot) => bot.id));
        if (existing.size !== botIds.length || botIds.some((id) => !existing.has(id))) {
          throw new IsolationError();
        }
        // ponytail: rosters are small; switch to one SQL CASE update only if this becomes hot.
        await Promise.all(
          botIds.map((id, position) => tx.bot.update({ where: { id }, data: { position } })),
        );
      });
    },

    async setBotComputer(actor: Actor, botId: string, mode: ComputerMode): Promise<Bot> {
      const bot = await prisma.bot.findFirst({
        where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
        include: { computer: true },
      });
      if (!bot?.computer) throw new IsolationError();
      const computer = await ensureComputerRecord(prisma, {
        mode,
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        kind: bot.computer.kind,
        homeStorage: bot.computer.homeStorage,
      });
      const updated = await prisma.bot.update({
        where: { id: botId },
        data: { computerId: computer.id },
        include: { thread: true, computer: true },
      });
      return mapBot(updated);
    },
  };
}

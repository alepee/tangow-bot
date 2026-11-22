import {
  type Actor,
  botDisplayColor,
  GROUP_MEMBER_MAX,
  GROUP_MEMBER_MIN,
  type Group,
  type GroupMember,
  type GroupPerson,
  type SpaceGroup,
} from "@tangow/contracts";
import { usableBotIds } from "./bot-sharing.js";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import { Prisma, type PrismaClient } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import { IsolationError } from "./scope.js";
import { lockSpaceForContentCreation } from "./spaces.js";
import { activeRunStatuses, ownerRunSelection, sessionPreviews } from "./thread-listing.js";

type GroupRecord = {
  id: string;
  spaceId: string;
  userId: string;
  name: string;
  description: string;
  leadBotId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  thread: { id: string; sessionId: string } | null;
  people: PersonRecord[];
  members: Array<{
    bot: {
      id: string;
      name: string;
      color: string;
      shapeSeed: number | null;
      avatarCharacter: string | null;
      runs: Array<{ status: string }>;
    };
  }>;
};

type PersonRecord = {
  userId: string;
  unread: boolean;
  pinned: boolean;
  sectionId: string | null;
  user: { name: string; image: string | null };
};

type SpaceGroupRecord = Pick<
  GroupRecord,
  "id" | "spaceId" | "name" | "userId" | "updatedAt" | "members" | "people"
> & {
  thread: { sessionId: string } | null;
};

/** The actor's own read, pin and section state in a group they are a person in. */
function personState(people: PersonRecord[], userId: string) {
  const person = people.find((row) => row.userId === userId);
  if (!person) throw new IsolationError();
  return { pinned: person.pinned, sectionId: person.sectionId, unread: person.unread };
}

/** Pinned first, then the most recently active. */
function byPinThenActivity(
  a: { pinned: boolean; updatedAt: string },
  b: { pinned: boolean; updatedAt: string },
) {
  return Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt);
}

function mapGroupMembers(members: GroupRecord["members"], usable: Set<string>): GroupMember[] {
  return members.map((member) => ({
    botId: member.bot.id,
    name: member.bot.name,
    color: botDisplayColor(member.bot),
    shapeSeed: member.bot.shapeSeed,
    avatarCharacter: member.bot.avatarCharacter,
    status: member.bot.runs[0]?.status ?? "idle",
    canUse: usable.has(member.bot.id),
  }));
}

/** The bots of `groups` the actor may wake, for each member's `canUse`. */
function usableGroupBotIds(
  prisma: Pick<PrismaClient, "bot">,
  userId: string,
  spaceId: string | { in: string[] },
  groups: ReadonlyArray<{ members: ReadonlyArray<{ bot: { id: string } }> }>,
) {
  return usableBotIds(
    prisma,
    userId,
    spaceId,
    groups.flatMap((group) => group.members.map((member) => member.bot.id)),
  );
}

/** The creator first, then everyone else as they joined. */
function mapGroupPeople(group: Pick<GroupRecord, "userId" | "people">) {
  return [...group.people]
    .sort((a, b) => Number(b.userId === group.userId) - Number(a.userId === group.userId))
    .map((person) => ({
      userId: person.userId,
      name: person.user.name,
      image: person.user.image,
    }));
}

function mapGroup(group: GroupRecord, preview: string, userId: string, usable: Set<string>): Group {
  if (!group.thread) throw new IsolationError("Group is missing its thread");
  const { unread, ...organization } = personState(group.people, userId);
  return {
    id: group.id,
    spaceId: group.spaceId,
    name: group.name,
    description: group.description,
    ...organization,
    archivedAt: group.archivedAt?.toISOString() ?? null,
    members: mapGroupMembers(group.members, usable),
    people: mapGroupPeople(group),
    creatorId: group.userId,
    canManage: group.userId === userId,
    leadBotId: group.leadBotId,
    threadId: group.thread.id,
    preview,
    unread,
    updatedAt: group.updatedAt.toISOString(),
    createdAt: group.createdAt.toISOString(),
  };
}

function mapSpaceGroup(
  group: SpaceGroupRecord,
  preview: string,
  userId: string,
  usable: Set<string>,
): SpaceGroup {
  if (!group.thread) throw new IsolationError("Group is missing its thread");
  return {
    id: group.id,
    spaceId: group.spaceId,
    name: group.name,
    ...personState(group.people, userId),
    members: mapGroupMembers(group.members, usable),
    people: mapGroupPeople(group),
    preview,
    updatedAt: group.updatedAt.toISOString(),
  };
}

function hasMinimumActiveMembers(members: readonly unknown[]) {
  return members.length >= GROUP_MEMBER_MIN;
}

/**
 * The bots a group's creator puts in it: their own, or ones shared with them. A bot already in
 * the group may stay though they can no longer use it, so they can still change the others.
 */
async function assertUsableBots(
  db: Pick<Prisma.TransactionClient, "bot">,
  actor: Actor,
  botIds: string[],
  kept: readonly string[] = [],
) {
  const unique = [...new Set(botIds)];
  if (unique.length < GROUP_MEMBER_MIN || unique.length > GROUP_MEMBER_MAX) {
    throw new IsolationError(
      `Groups require ${GROUP_MEMBER_MIN} to ${GROUP_MEMBER_MAX} distinct bots`,
    );
  }
  const added = unique.filter((botId) => !kept.includes(botId));
  const usable = await usableBotIds(db, actor.userId, actor.spaceId, added);
  if (usable.size !== added.length) throw new IsolationError();
  return unique.map((botId) => ({ botId }));
}

/** The Space's other people a creator puts in a group: each must still be in the Space. */
async function assertSpacePeople(prisma: PrismaClient, actor: Actor, userIds: string[]) {
  const others = [...new Set(userIds)].filter((userId) => userId !== actor.userId);
  const members = others.length
    ? await prisma.spaceMember.count({ where: { spaceId: actor.spaceId, userId: { in: others } } })
    : 0;
  if (members !== others.length) throw new IsolationError();
  return others;
}

/**
 * Takes people out of a group, stopping the runs they started in its thread and turning off their
 * routines that post in it.
 */
async function removeGroupPeople(
  tx: Prisma.TransactionClient,
  group: { groupId: string; threadId: string },
  userIds: string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];
  await tx.chatGroupPerson.deleteMany({
    where: { groupId: group.groupId, userId: { in: userIds } },
  });
  await tx.routine.updateMany({
    where: { threadId: group.threadId, userId: { in: userIds } },
    data: { active: false, nextRunAt: null },
  });
  const runs = await tx.run.findMany({
    where: {
      threadId: group.threadId,
      userId: { in: userIds },
      status: { in: activeRunStatuses },
    },
    select: { id: true, taskId: true },
  });
  await cancelRunsInTransaction(tx, runs, new Date());
  // A cancelled run waiting on the screen gives the computer back at once.
  await expireComputerExecutionLeases(tx, { runId: { in: runs.map((run) => run.id) } });
  return runs.map((run) => run.id);
}

/** The creator stays in their group: they archive or delete it instead of leaving. */
export class GroupCreatorCannotLeaveError extends Error {
  constructor() {
    super("The group's creator cannot leave it");
    this.name = "GroupCreatorCannotLeaveError";
  }
}

const peopleSelection = {
  select: {
    userId: true,
    unread: true,
    pinned: true,
    sectionId: true,
    user: { select: { name: true, image: true } },
  },
  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
} satisfies Prisma.ChatGroup$peopleArgs;

const groupInclude = {
  thread: { select: { id: true, sessionId: true } },
  people: peopleSelection,
  members: {
    where: { bot: { archivedAt: null } },
    include: {
      bot: {
        select: {
          id: true,
          name: true,
          color: true,
          shapeSeed: true,
          avatarCharacter: true,
          runs: ownerRunSelection,
        },
      },
    },
    orderBy: { createdAt: "asc" as const },
  },
} as const;

const groupTargetInclude = {
  thread: { select: { id: true } },
  members: {
    where: { bot: { archivedAt: null } },
    include: {
      bot: {
        select: {
          id: true,
          name: true,
          color: true,
          shapeSeed: true,
          avatarCharacter: true,
          runs: ownerRunSelection,
        },
      },
    },
    orderBy: { createdAt: "asc" as const },
  },
} as const;

/** The previews of the groups' threads, by thread session. */
async function groupPreviews(
  prisma: PrismaClient,
  groups: ReadonlyArray<{ thread: { sessionId: string } | null }>,
): Promise<Map<string, string>> {
  return sessionPreviews(
    prisma,
    groups.flatMap((group) => group.thread?.sessionId ?? []),
  );
}

export function createGroupRepos(prisma: PrismaClient) {
  async function presentGroup(group: GroupRecord, userId: string): Promise<Group> {
    const [previews, usable] = await Promise.all([
      groupPreviews(prisma, [group]),
      usableGroupBotIds(prisma, userId, group.spaceId, [group]),
    ]);
    return mapGroup(
      group,
      (group.thread && previews.get(group.thread.sessionId)) ?? "",
      userId,
      usable,
    );
  }

  async function listSpaceGroupsForSpaces(actor: Actor, spaceIds: string[]): Promise<SpaceGroup[]> {
    if (spaceIds.length === 0) return [];
    const groups = await prisma.chatGroup.findMany({
      where: {
        spaceId: { in: spaceIds },
        ...groupMembershipFilter(actor.userId),
        archivedAt: null,
      },
      select: {
        id: true,
        spaceId: true,
        name: true,
        userId: true,
        updatedAt: true,
        thread: { select: { sessionId: true } },
        members: groupInclude.members,
        people: peopleSelection,
      },
    });
    const listed = groups.filter((group) => hasMinimumActiveMembers(group.members));
    const [previews, usable] = await Promise.all([
      groupPreviews(prisma, listed),
      usableGroupBotIds(prisma, actor.userId, { in: spaceIds }, listed),
    ]);
    return listed
      .map((group) =>
        mapSpaceGroup(
          group,
          (group.thread && previews.get(group.thread.sessionId)) ?? "",
          actor.userId,
          usable,
        ),
      )
      .sort(byPinThenActivity);
  }

  return {
    async listGroups(actor: Actor, options: { archived?: boolean } = {}): Promise<Group[]> {
      const groups = await prisma.chatGroup.findMany({
        where: {
          ...groupMembershipFilter(actor.userId, actor.spaceId),
          archivedAt: options.archived ? { not: null } : null,
        },
        include: groupInclude,
      });
      // An archived group whose last bot was deleted still lists, for its creator to delete.
      const listed = options.archived
        ? groups
        : groups.filter((group) => hasMinimumActiveMembers(group.members));
      const [previews, usable] = await Promise.all([
        groupPreviews(prisma, listed),
        usableGroupBotIds(prisma, actor.userId, actor.spaceId, listed),
      ]);
      return listed
        .map((group) =>
          mapGroup(
            group,
            (group.thread && previews.get(group.thread.sessionId)) ?? "",
            actor.userId,
            usable,
          ),
        )
        .sort(byPinThenActivity);
    },

    listSpaceGroupsForSpaces,

    async getGroup(actor: Actor, groupId: string, options: { includeArchived?: boolean } = {}) {
      const group = await prisma.chatGroup.findFirst({
        where: {
          id: groupId,
          ...groupMembershipFilter(actor.userId, actor.spaceId),
          ...(options.includeArchived ? {} : { archivedAt: null }),
        },
        include: groupInclude,
      });
      if (!group || !hasMinimumActiveMembers(group.members)) throw new IsolationError();
      return group as GroupRecord;
    },

    async getGroupTarget(actor: Actor, groupId: string) {
      const group = await prisma.chatGroup.findFirst({
        where: {
          id: groupId,
          ...groupMembershipFilter(actor.userId, actor.spaceId),
          archivedAt: null,
        },
        include: groupTargetInclude,
      });
      if (!group || !hasMinimumActiveMembers(group.members)) throw new IsolationError();
      return group;
    },

    async createGroup(
      actor: Actor,
      input: { name: string; description?: string; botIds: string[]; userIds?: string[] },
    ): Promise<Group> {
      const members = await assertUsableBots(prisma, actor, input.botIds);
      const people = await assertSpacePeople(prisma, actor, input.userIds ?? []);
      const created = await prisma.$transaction(async (tx) => {
        await lockSpaceForContentCreation(tx, {
          spaceId: actor.spaceId,
          userId: actor.userId,
        });
        const group = await tx.chatGroup.create({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            name: input.name.trim(),
            description: input.description?.trim() ?? "",
          },
        });
        await tx.chatGroupMember.createMany({
          data: members.map((member) => ({ groupId: group.id, botId: member.botId })),
        });
        await tx.chatGroupPerson.createMany({
          data: [actor.userId, ...people].map((userId) => ({ groupId: group.id, userId })),
        });
        await tx.thread.create({
          data: {
            spaceId: actor.spaceId,
            groupId: group.id,
            userId: actor.userId,
          },
        });
        return tx.chatGroup.findFirstOrThrow({
          where: { id: group.id },
          include: groupInclude,
        });
      });
      // The creator can use every bot they put in it.
      return mapGroup(created, "", actor.userId, new Set(members.map((member) => member.botId)));
    },

    async updateGroup(
      actor: Actor,
      input: {
        groupId: string;
        name?: string;
        description?: string;
        botIds?: string[];
        userIds?: string[];
        leadBotId?: string | null;
        pinned?: boolean;
        sectionId?: string | null;
      },
    ): Promise<{ group: Group; cancelledRunIds: string[] }> {
      const people = input.userIds
        ? await assertSpacePeople(prisma, actor, input.userIds)
        : undefined;
      // Anyone in the group pins and files it for themselves; only its creator changes it.
      const manages = [input.name, input.description, input.botIds, people, input.leadBotId].some(
        (value) => value !== undefined,
      );
      const updated = await prisma.$transaction(async (tx) => {
        await (manages ? lockGroupForCreator : lockGroupForPerson)(tx, actor, input.groupId);
        const current = await tx.chatGroup.findFirst({
          where: { id: input.groupId, archivedAt: null },
          include: {
            members: { select: { botId: true, bot: { select: { archivedAt: true } } } },
            people: { select: { userId: true } },
            thread: { select: { id: true } },
          },
        });
        if (!current?.thread) throw new IsolationError();
        const members = input.botIds
          ? await assertUsableBots(
              tx,
              actor,
              input.botIds,
              current.members.map((member) => member.botId),
            )
          : undefined;
        const archived = new Set(
          current.members.filter((member) => member.bot.archivedAt).map((member) => member.botId),
        );
        if (
          !hasMinimumActiveMembers(
            (members ?? current.members).filter((member) => !archived.has(member.botId)),
          )
        ) {
          throw new IsolationError();
        }
        const nextBotIds = new Set(
          members?.map((member) => member.botId) ?? current.members.map((member) => member.botId),
        );
        const removedBotIds = current.members
          .map((member) => member.botId)
          .filter((botId) => !nextBotIds.has(botId));
        const activeRuns = removedBotIds.length
          ? await tx.run.findMany({
              where: {
                threadId: current.thread.id,
                botId: { in: removedBotIds },
                status: {
                  in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"],
                },
              },
              select: { id: true, taskId: true },
            })
          : [];
        if (activeRuns.length) {
          const now = new Date();
          await cancelRunsInTransaction(tx, activeRuns, now);
        }
        if (input.leadBotId && !nextBotIds.has(input.leadBotId)) throw new IsolationError();
        const leadBotId =
          input.leadBotId !== undefined
            ? input.leadBotId
            : current.leadBotId && !nextBotIds.has(current.leadBotId)
              ? null
              : undefined;
        const removedPeopleRunIds = people
          ? await removeGroupPeople(
              tx,
              { groupId: input.groupId, threadId: current.thread.id },
              current.people
                .map((person) => person.userId)
                .filter((userId) => userId !== current.userId && !people.includes(userId)),
            )
          : [];
        if (people?.length) {
          await tx.chatGroupPerson.createMany({
            data: people.map((userId) => ({ groupId: input.groupId, userId })),
            skipDuplicates: true,
          });
        }
        if (input.name !== undefined) {
          await tx.chatGroup.update({
            where: { id: input.groupId },
            data: { name: input.name.trim() },
          });
        }
        if (members) {
          await tx.chatGroupMember.deleteMany({ where: { groupId: input.groupId } });
          await tx.chatGroupMember.createMany({
            data: members.map((member) => ({ groupId: input.groupId, botId: member.botId })),
          });
        }
        if (manages) {
          await tx.chatGroup.update({
            where: { id: input.groupId },
            data: { updatedAt: new Date(), description: input.description?.trim(), leadBotId },
          });
        }
        if (input.pinned !== undefined || input.sectionId !== undefined) {
          await tx.chatGroupPerson.update({
            where: { groupId_userId: { groupId: input.groupId, userId: actor.userId } },
            data: { pinned: input.pinned, sectionId: input.sectionId },
          });
        }
        return tx.chatGroup
          .findFirstOrThrow({
            where: { id: input.groupId },
            include: groupInclude,
          })
          .then((group) => ({
            group,
            cancelledRunIds: [...activeRuns.map((run) => run.id), ...removedPeopleRunIds],
          }));
      });
      if (!updated.group.thread) throw new IsolationError();
      return {
        group: await presentGroup(updated.group, actor.userId),
        cancelledRunIds: updated.cancelledRunIds,
      };
    },

    async archiveGroup(actor: Actor, groupId: string) {
      return prisma.$transaction(async (tx) => {
        await lockGroupForCreator(tx, actor, groupId);
        const current = await tx.chatGroup.findFirst({
          where: { id: groupId, archivedAt: null },
          select: { thread: { select: { id: true } } },
        });
        if (!current?.thread) throw new IsolationError();

        const activeRuns = await tx.run.findMany({
          where: {
            threadId: current.thread.id,
            status: { in: activeRunStatuses },
          },
          select: { id: true, taskId: true },
        });
        const runIds = activeRuns.map((run) => run.id);
        const now = new Date();
        const computers = runIds.length
          ? await tx.computer.findMany({
              where: { executionRunId: { in: runIds } },
              select: {
                id: true,
                homeKey: true,
                kind: true,
                providerRef: true,
                executionBotId: true,
                executionRunId: true,
              },
            })
          : [];
        const leases = runIds.length
          ? await tx.computerExecutionLease.findMany({
              where: { runId: { in: runIds } },
              select: { computerId: true, runId: true, fence: true },
            })
          : [];
        const leaseByComputerId = new Map(leases.map((lease) => [lease.computerId, lease]));
        const computersWithLease = computers.map((computer) => ({
          ...computer,
          executionFence: leaseByComputerId.get(computer.id)?.fence ?? 0,
        }));

        if (runIds.length) {
          await cancelRunsInTransaction(tx, activeRuns, now);
          await expireComputerExecutionLeases(tx, { runId: { in: runIds } });
          await tx.computer.updateMany({
            where: { executionRunId: { in: runIds } },
            data: {
              executionRunId: null,
              executionBotId: null,
              executionLeaseExpiresAt: null,
            },
          });
          await tx.event.deleteMany({
            where: { type: "thread.progress", runId: { in: runIds } },
          });
        }

        await tx.chatGroup.update({ where: { id: groupId }, data: { archivedAt: now } });
        await tx.chatGroupPerson.updateMany({ where: { groupId }, data: { pinned: false } });

        return { cancelledRunIds: runIds, computers: computersWithLease };
      });
    },

    async restoreGroup(actor: Actor, groupId: string) {
      const restored = await prisma.chatGroup.updateMany({
        where: {
          id: groupId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          members: { some: { bot: { archivedAt: null } } },
        },
        data: { archivedAt: null },
      });
      if (restored.count !== 1) throw new IsolationError();
    },

    /** Someone other than the creator leaves; their runs in the group stop. */
    async leaveGroup(actor: Actor, groupId: string): Promise<{ cancelledRunIds: string[] }> {
      return prisma.$transaction(async (tx) => {
        await lockGroupForPerson(tx, actor, groupId);
        const group = await tx.chatGroup.findUniqueOrThrow({
          where: { id: groupId },
          select: { userId: true, thread: { select: { id: true } } },
        });
        if (group.userId === actor.userId) throw new GroupCreatorCannotLeaveError();
        if (!group.thread) throw new IsolationError();
        const cancelledRunIds = await removeGroupPeople(
          tx,
          { groupId, threadId: group.thread.id },
          [actor.userId],
        );
        return { cancelledRunIds };
      });
    },

    async removeGroup(actor: Actor, groupId: string) {
      return prisma.$transaction(async (tx) => {
        await lockGroupForCreator(tx, actor, groupId);
        const group = await tx.chatGroup.findUnique({
          where: { id: groupId },
          select: {
            artifacts: { select: { storageKey: true } },
            members: { orderBy: { createdAt: "asc" }, take: 1, select: { botId: true } },
          },
        });
        if (!group) throw new IsolationError();
        await tx.chatGroup.delete({ where: { id: groupId } });
        return {
          // None when its last bot was deleted.
          contextBotId: group.members[0]?.botId,
          artifactStorageKeys: group.artifacts.map((artifact) => artifact.storageKey),
        };
      });
    },

    mapGroup: presentGroup,
  };
}

/** The groups `userId` is a person in, the creator among them. */
export function groupMembershipFilter(
  userId: string,
  spaceId?: string,
): Prisma.ChatGroupWhereInput {
  return { ...(spaceId ? { spaceId } : {}), people: { some: { userId } } };
}

/** SQL for "`userId` is a person in the group `groupId`", for raw queries; see the filter above. */
export function groupPersonSql(userId: string, groupId: Prisma.Sql) {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM chat_group_people p WHERE p."groupId" = ${groupId} AND p."userId" = ${userId}
  )`;
}

/** Locks a group the actor is a person in, for reading it or writing in its thread. */
export async function lockGroupForPerson(
  prisma: Pick<Prisma.TransactionClient, "$queryRaw">,
  actor: Pick<Actor, "spaceId" | "userId">,
  groupId: string,
) {
  const locked = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT g.id
    FROM chat_groups g
    WHERE g.id = ${groupId}
      AND g."spaceId" = ${actor.spaceId}
      AND ${groupPersonSql(actor.userId, Prisma.sql`g.id`)}
    FOR UPDATE OF g
  `;
  if (locked.length !== 1) throw new IsolationError();
}

/** Locks a group the actor created: only they change it, archive it or delete it. */
export async function lockGroupForCreator(
  prisma: Pick<Prisma.TransactionClient, "$queryRaw">,
  actor: Pick<Actor, "spaceId" | "userId">,
  groupId: string,
) {
  const locked = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM chat_groups
    WHERE id = ${groupId}
      AND "spaceId" = ${actor.spaceId}
      AND "userId" = ${actor.userId}
    FOR UPDATE
  `;
  if (locked.length !== 1) throw new IsolationError();
}

/**
 * Locks the groups of bots their owner is archiving or deleting, and returns those the bots leave
 * with no active bot. Of these, a group someone else made, with bots shared with them, is
 * archived for everyone with its history: its creator restores it once a bot is back. The owner's
 * own are left to the caller.
 */
export async function archiveGroupsLeftWithoutBots(
  tx: Prisma.TransactionClient,
  bots: { botIds: string[]; ownerId: string | undefined },
) {
  if (bots.botIds.length === 0) return [];
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT groups.id
    FROM chat_groups AS groups
    INNER JOIN chat_group_members AS members ON members."groupId" = groups.id
    WHERE members."botId" IN (${Prisma.join(bots.botIds)})
    ORDER BY groups.id
    FOR UPDATE OF groups
  `;
  const groups = await tx.chatGroup.findMany({
    where: { members: { some: { botId: { in: bots.botIds } } } },
    select: {
      id: true,
      userId: true,
      members: { select: { botId: true, bot: { select: { archivedAt: true } } } },
      thread: { select: { id: true } },
    },
  });
  const closed = groups.filter(
    (group) =>
      !hasMinimumActiveMembers(
        group.members.filter(
          (member) => !bots.botIds.includes(member.botId) && member.bot.archivedAt === null,
        ),
      ),
  );
  const archivedIds = closed
    .filter((group) => group.userId !== bots.ownerId)
    .map((group) => group.id);
  if (archivedIds.length) {
    await tx.chatGroup.updateMany({
      where: { id: { in: archivedIds }, archivedAt: null },
      data: { archivedAt: new Date() },
    });
    await tx.chatGroupPerson.updateMany({
      where: { groupId: { in: archivedIds } },
      data: { pinned: false },
    });
  }
  return closed;
}

export async function touchGroupUpdatedAt(
  prisma: Pick<Prisma.TransactionClient, "chatGroup">,
  groupId: string,
) {
  await prisma.chatGroup.update({
    where: { id: groupId },
    data: { updatedAt: new Date() },
  });
}

/**
 * A new entry turns a thread unread for whoever did not write it: in a group, every other
 * person's own mark; elsewhere, the thread's one person's, unless they wrote it. No author is a
 * bot or the system, so everyone's.
 */
export async function markThreadUnread(
  tx: Pick<Prisma.TransactionClient, "thread" | "chatGroupPerson">,
  thread: { id: string; groupId: string | null; userId: string },
  authorId?: string,
) {
  if (thread.groupId) {
    await tx.chatGroupPerson.updateMany({
      where: {
        groupId: thread.groupId,
        unread: false,
        ...(authorId ? { userId: { not: authorId } } : {}),
      },
      data: { unread: true },
    });
  } else if (authorId === undefined || thread.userId !== authorId) {
    await tx.thread.update({ where: { id: thread.id }, data: { unread: true } });
  }
}

/** Marks threads unread for everyone in them: no person wrote what was added. */
export async function markThreadsUnread(
  tx: Pick<Prisma.TransactionClient, "thread" | "chatGroupPerson" | "$queryRaw">,
  threadIds: string[],
) {
  // Thread rows before person rows, in id order: the order every send and append takes.
  for (const threadId of [...threadIds].sort()) {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
  }
  await tx.thread.updateMany({
    where: { id: { in: threadIds }, groupId: null },
    data: { unread: true },
  });
  await tx.chatGroupPerson.updateMany({
    where: { unread: false, group: { thread: { id: { in: threadIds } } } },
    data: { unread: true },
  });
}

/**
 * Whom a group thread's messages name: its people, in the order they joined, then anyone who
 * wrote in it and has left since, its creator among them.
 */
export async function groupThreadPeople(
  prisma: Pick<PrismaClient, "chatGroupPerson" | "user" | "$queryRaw">,
  group: { groupId: string; sessionId: string },
): Promise<GroupPerson[]> {
  const [people, authors] = await Promise.all([
    prisma.chatGroupPerson.findMany({
      where: { groupId: group.groupId },
      select: { user: { select: { id: true, name: true, image: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.$queryRaw<Array<{ userId: string }>>`
      SELECT DISTINCT e.payload->>'authorId' AS "userId"
      FROM session_entries e
      WHERE e."sessionId" = ${group.sessionId}
        AND e.type = 'user.message'
        AND e.payload->>'authorId' IS NOT NULL
      UNION
      SELECT g."userId" FROM chat_groups g WHERE g.id = ${group.groupId}
    `,
  ]);
  const current = new Set(people.map((person) => person.user.id));
  const former = authors.map((row) => row.userId).filter((userId) => !current.has(userId));
  const formerUsers = former.length
    ? await prisma.user.findMany({
        where: { id: { in: former } },
        select: { id: true, name: true, image: true },
        orderBy: { name: "asc" },
      })
    : [];
  return [...people.map((person) => person.user), ...formerUsers].map((user) => ({
    userId: user.id,
    name: user.name,
    image: user.image,
  }));
}

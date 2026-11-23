import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  WorkerProvider,
  WorkerSpec,
  WorkerStartV1,
  WorkerStatusV1,
} from "@tangow/adapter-kit";
import {
  AgentRuntimeBusyError,
  AgentRuntimeUnavailableError,
  WORKER_PROTOCOL_VERSION,
  WorkerEnsureSettledError,
} from "@tangow/adapter-kit";
import type { HomeStorage } from "@tangow/contracts";
import { WorkerState } from "@tangow/contracts";
import type { LaunchPlan, MountRefusal, RunNeeds, VolumeRow, WorkerLaunch } from "@tangow/core";
import {
  attemptHoldsFence,
  attemptOwnsFence,
  authorizeMounts,
  ensureMayBeInFlight,
  LIVE_WORKER_STATES,
  lostSetupMove,
  PAUSED_ATTEMPT_RUN_STATUSES,
  planLaunch,
  WORKER_TTL_SECONDS,
  WORKSPACE_ROOT,
  workerEnsureDeadline,
  workerStatesInto,
} from "@tangow/core";
import type { PrismaClient, VolumeOwnerRef } from "@tangow/db";
import { Prisma } from "@tangow/db";
import { WORKER_LIMITS } from "./runtime-worker/limits.js";

/** The attempt no longer holds its run's fence, its worker was started already, or torn down. */
export class StaleAttemptError extends Error {
  constructor(readonly attemptId: string) {
    super("Attempt no longer holds its run fence");
    this.name = "StaleAttemptError";
  }
}

/** A volume grant failed authorization. Nothing was written and no provider was called. */
export class VolumeRefusedError extends Error {
  constructor(readonly refusal: MountRefusal) {
    super(`Volume refused: ${refusal.code}`);
    this.name = "VolumeRefusedError";
  }
}

/** The run input is added by the runtime that launches the guest. */
export type StartedWorker = { providerRef: string; start: Omit<WorkerStartV1, "run"> };

/** Why a home cannot move onto volumes now. */
export type HomeMoveBlocker = "computer_active" | "space_worker_live";

/**
 * What a home move saw when it started. Adoption refuses once the home has a new revision, or once
 * a worker in its scope has appeared, since that worker may have written the volumes.
 */
export type HomeMoveStart = { homeRevision: string; workerCount: number };

export type HomeAdoption =
  | "adopted"
  | "volume_missing"
  | "home_revised"
  | "space_worker_ran"
  | HomeMoveBlocker;

export type VolumeOwner =
  | { kind: "bot_private"; spaceId: string; botId: string }
  | { kind: "space_shared"; spaceId: string; userId: string };

export type EnsuredVolume = { volumeId: string; providerRef: string };

/** `awaiting_ensure`: moved to releasing, but its VM may still appear, so its replacement must wait. */
export type ReleaseOutcome = "released" | "awaiting_ensure" | "not_live";

type PlanRow = {
  runId: string;
  botId: string;
  spaceId: string;
  userId: string;
  fence: number;
  leaseFence: number;
  status: string;
  computerId: string | null;
  homeStorage: HomeStorage | null;
  privateVolumeId: string | null;
  sharedVolumeId: string | null;
  botShared: boolean;
  homeMoving: boolean;
};

const RELEASABLE = Prisma.join([...LIVE_WORKER_STATES, "releasing"]);
const VOLUME_SWEEP_BATCH = 10;
const VOLUME_CREATE_GRACE_MS = 60 * 60_000;
export const HOME_MOVE_TTL_MS = 60_000;
// Prisma timestamps store UTC without a timezone, regardless of the database session timezone.
const HOME_MOVE_NOW = Prisma.sql`(now() AT TIME ZONE 'UTC')`;
const INTO_RELEASED = Prisma.join(workerStatesInto("released"));

type HomeComputer = {
  kind: string;
  scope: string;
  spaceId: string;
  userId: string;
  homeStorage: HomeStorage;
  homeRevision: string;
  state: string;
  controlHolder: string;
  updatedAt: Date;
  maintenanceId: string | null;
};
type Db = Pick<PrismaClient, "$queryRaw" | "computerExecutionLease" | "bot">;

/**
 * How long a Docker computer may sit in a transition before its move counts it idle. A lease-less
 * first boot that pulls the image can legitimately stay in `booting` for many minutes.
 */
const STUCK_TRANSITION_MS: Record<string, number> = {
  booting: 30 * 60_000,
  suspending: 5 * 60_000,
};

/**
 * Whether the computer is at rest for a home move. A Docker home still to move also counts a
 * computer an upgrade caught mid-operation, so it is not refused forever: one left in `error`, or
 * stuck in `booting` or `suspending`. Its own move reservation, which blocks boots, refreshes
 * `updatedAt`, so a held reservation counts too.
 */
function atRest(computer: HomeComputer): boolean {
  if (["stopped", "suspended"].includes(computer.state)) return true;
  if (computer.kind !== "docker" || computer.homeStorage === "volumes") return false;
  if (computer.state === "error") return true;
  const stuckAfter = STUCK_TRANSITION_MS[computer.state];
  if (stuckAfter === undefined) return false;
  return (
    Boolean(computer.maintenanceId?.startsWith("home-move:")) ||
    Date.now() - computer.updatedAt.getTime() >= stuckAfter
  );
}

/** A run writing to the computer's disk after the copy would lose those writes. */
async function computerBlocker(
  db: Db,
  computerId: string,
  computer: HomeComputer,
): Promise<"computer_active" | null> {
  const executing = await db.computerExecutionLease.count({
    where: { computerId, expiresAt: { gt: new Date() } },
  });
  const idle = atRest(computer) && computer.controlHolder === "none" && executing === 0;
  return idle ? null : "computer_active";
}

/**
 * All workers in the home's scope, including finished runs and superseded attempts. A team home
 * spans every bot of its person, since they share one volume.
 */
async function homeWorkers(
  db: Db,
  computerId: string,
  computer: HomeComputer,
): Promise<{ live: number; total: number }> {
  const [counts] = await db.$queryRaw<{ live: number; total: number }[]>`
    SELECT count(*) FILTER (WHERE a."workerState" IN (${RELEASABLE}))::int AS live,
      count(a."workerState")::int AS total
    FROM attempts a JOIN runs r ON r.id = a."runId" JOIN bots b ON b.id = r."botId"
    WHERE r."spaceId" = ${computer.spaceId} AND b."userId" = ${computer.userId}
      AND (${computer.scope === "team"} OR b."computerId" = ${computerId})`;
  return counts ?? { live: 0, total: 0 };
}

/** Every bot on the computer, archived included, and its owner's shared volume for a team computer. */
async function homeVolumes(db: Db, computerId: string, computer: HomeComputer, lock: boolean) {
  const botIds = (await db.bot.findMany({ where: { computerId }, select: { id: true } })).map(
    (bot) => bot.id,
  );
  const team = computer.scope === "team";
  const volumes = await db.$queryRaw<VolumeRow[]>`
    SELECT id, kind, "spaceId", "botId", "userId", "providerKind", "providerRef"
    FROM volumes
    WHERE (kind = 'bot_private' AND "botId" = ANY(${botIds}))
      OR (${team} AND kind = 'space_shared' AND "spaceId" = ${computer.spaceId}
        AND "userId" = ${computer.userId})
    ORDER BY id ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}`;
  return { botIds, team, volumes };
}

async function readHomeComputer(db: Db, computerId: string, lock: boolean) {
  const [computer] = await db.$queryRaw<HomeComputer[]>`
    SELECT kind, scope, "spaceId", "userId", "homeStorage", "homeRevision", state, "controlHolder",
      "maintenanceId", "updatedAt"
    FROM computers
    WHERE id = ${computerId} ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}`;
  if (!computer) throw new Error("Computer not found");
  return computer;
}

/** Shared by inspection and reservation so a dry run checks the same admission rules. */
async function inspectHomeMove(db: Db, computerId: string, lock: boolean) {
  const source = await readHomeComputer(db, computerId, false);
  const computers = await db.$queryRaw<Array<HomeComputer & { id: string }>>`
    SELECT id, kind, scope, "spaceId", "userId", "homeStorage", "homeRevision", state,
      "controlHolder", "maintenanceId", "updatedAt" FROM computers
    WHERE "spaceId" = ${source.spaceId} AND "userId" = ${source.userId} ORDER BY id ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}`;
  const computer = computers.find((row) => row.id === computerId);
  if (!computer) throw new Error("Computer not found");
  const workers = await homeWorkers(db, computerId, computer);
  const start = { homeRevision: computer.homeRevision, workerCount: workers.total };
  let blocker: HomeMoveBlocker | null = computers.some(
    (row) =>
      Boolean(row.maintenanceId) &&
      (computer.scope === "team" ||
        row.id === computerId ||
        (row.scope === "team" && row.maintenanceId?.startsWith("home-move:"))),
  )
    ? "computer_active"
    : await computerBlocker(db, computerId, computer);
  if (!blocker) {
    await homeVolumes(db, computerId, computer, lock);
    if (workers.live > 0) blocker = "space_worker_live";
  }
  return { blocker, start, computer };
}

/** The only writer of attempts.worker*. A null provider keeps every run in process. */
export function createWorkerLifecycle(deps: {
  prisma: PrismaClient;
  provider: WorkerProvider | null;
}) {
  const { prisma } = deps;

  function requireProvider(): WorkerProvider {
    if (!deps.provider) throw new Error("No worker provider is configured");
    return deps.provider;
  }

  /**
   * Records a setup step of `start`. A move that matches no row means teardown took the worker:
   * the VM this call holds is recorded where release and reconcile will destroy it.
   */
  async function advance(
    attemptId: string,
    to: "created" | "ready",
    providerRef: string,
    context: AdapterContext,
  ): Promise<void> {
    const moved = await prisma.attempt.updateMany({
      where: { id: attemptId, workerState: { in: workerStatesInto(to) } },
      data: { workerState: to, workerStateAt: new Date(), workerProviderRef: providerRef },
    });
    if (moved.count === 1) return;
    const [observed] = await prisma.$queryRaw<
      { workerState: WorkerState | null; workerProviderRef: string | null }[]
    >`SELECT "workerState", "workerProviderRef" FROM attempts WHERE id = ${attemptId}`;
    const outcome = lostSetupMove(observed ?? null);
    const recordRef = () => prisma.$executeRaw`
      UPDATE attempts SET "workerProviderRef" = ${providerRef}
      WHERE id = ${attemptId} AND "workerState" = 'releasing' AND "workerProviderRef" IS NULL`;
    // Teardown may already be recorded, so record the late VM before a destroy can fail.
    const reopenOrphan = () => prisma.$executeRaw`
      UPDATE attempts SET "workerState" = 'releasing', "workerProviderRef" = ${providerRef},
        "workerStateAt" = ${new Date()}
      WHERE id = ${attemptId} AND "workerState" = 'released' AND "workerProviderRef" IS NULL`;
    // A record_ref that lost its row found the worker released meanwhile: an orphan too.
    const recorded =
      (outcome === "record_ref" && (await recordRef()) === 1) ||
      (outcome !== "stale" && (await reopenOrphan()) === 1);
    if (recorded) await release(attemptId, context).catch(() => undefined);
    throw new StaleAttemptError(attemptId);
  }

  /** `ensureSettled`: the provider answered its ensure, so no creation can still land. */
  async function release(
    attemptId: string,
    context: AdapterContext,
    { ensureSettled = false } = {},
  ): Promise<ReleaseOutcome> {
    const provider = requireProvider();
    const now = new Date();
    const [target] = await prisma.$queryRaw<
      { workerProviderRef: string | null; workerEnsureAt: Date }[]
    >`
      UPDATE attempts SET "workerState" = 'releasing', "workerStateAt" = ${now}
      WHERE id = ${attemptId} AND "workerState" IN (${RELEASABLE})
      RETURNING "workerProviderRef", "workerEnsureAt"`;
    if (!target) return "not_live";
    if (!ensureSettled && ensureMayBeInFlight(target, now)) return "awaiting_ensure";
    await provider.destroy({ attemptId, providerRef: target.workerProviderRef }, context);
    await prisma.$executeRaw`
      UPDATE attempts SET "workerState" = 'released', "workerStateAt" = ${new Date()}
      WHERE id = ${attemptId} AND "workerState" IN (${INTO_RELEASED})`;
    return "released";
  }

  /**
   * Creates the volume at the provider under a name derived from its row, once. A row deleted
   * while the provider created it leaves a deletion record, as the owner's deletion would have.
   */
  async function provisionVolume(volumeId: string, context: AdapterContext): Promise<string> {
    const provider = requireProvider();
    const volume = await prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<
        { providerKind: string; providerRef: string | null; ensureUntil: Date | null }[]
      >`SELECT "providerKind", "providerRef", "ensureUntil" FROM volumes
        WHERE id = ${volumeId} FOR UPDATE`;
      if (!row) throw new VolumeRefusedError({ code: "volume_not_found", volumeId });
      if (row.providerKind !== provider.describe().id) {
        throw new VolumeRefusedError({ code: "provider_mismatch", volumeId });
      }
      if (row.providerRef) return { mode: "ready", providerRef: row.providerRef } as const;
      const ensureUntil = workerEnsureDeadline(new Date());
      const deadline =
        row.ensureUntil && row.ensureUntil > ensureUntil ? row.ensureUntil : ensureUntil;
      await tx.volume.update({ where: { id: volumeId }, data: { ensureUntil: deadline } });
      return { mode: "ensure", providerKind: row.providerKind, ensureUntil: deadline } as const;
    });
    if (volume.mode === "ready") return volume.providerRef;
    const { providerRef } = await provider.ensureVolume(
      { name: `tangow-${volumeId}`, ensureDeadline: volume.ensureUntil },
      context,
    );
    // Locked like `deleteOwnerVolumes`, so the ref lands either on the row or in a deletion record.
    const recorded = await prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ providerRef: string | null }[]>`
        SELECT "providerRef" FROM volumes WHERE id = ${volumeId} FOR UPDATE`;
      if (!row) {
        // A late response refreshes the deletion record, even if an earlier sweep cleared it.
        await tx.$executeRaw`
          INSERT INTO volume_deletions ("providerKind", "providerRef", "volumeId", "notBefore")
          VALUES (${volume.providerKind}, ${providerRef}, ${volumeId}, ${volume.ensureUntil})
          ON CONFLICT ("providerKind", "providerRef") DO UPDATE SET generation = DEFAULT,
            "notBefore" = GREATEST(volume_deletions."notBefore", EXCLUDED."notBefore")`;
        return null;
      }
      if (row.providerRef) return row.providerRef;
      await tx.volume.update({ where: { id: volumeId }, data: { providerRef } });
      return providerRef;
    });
    if (!recorded) throw new VolumeRefusedError({ code: "volume_not_found", volumeId });
    return recorded;
  }

  async function ensureVolume(owner: VolumeOwner, context: AdapterContext): Promise<EnsuredVolume> {
    const providerKind = requireProvider().describe().id;
    const key =
      owner.kind === "bot_private"
        ? { kind: owner.kind, botId: owner.botId }
        : { kind: owner.kind, spaceId: owner.spaceId, userId: owner.userId };
    // The partial unique indexes on the owner make a concurrent duplicate a no-op.
    await prisma.volume.createMany({
      data: [{ ...key, spaceId: owner.spaceId, providerKind }],
      skipDuplicates: true,
    });
    const { id } = await prisma.volume.findFirstOrThrow({ where: key, select: { id: true } });
    return { volumeId: id, providerRef: await provisionVolume(id, context) };
  }

  return {
    /** One indexed read. */
    async plan(input: { attemptId: string; needs: RunNeeds }): Promise<LaunchPlan> {
      const [row] = await prisma.$queryRaw<PlanRow[]>`
        SELECT r.id AS "runId", r."botId", r."spaceId", b."userId", a.fence, r."leaseFence", r.status,
          c.id AS "computerId", c."homeStorage", b.visibility <> 'private' AS "botShared",
          EXISTS (SELECT 1 FROM computers moving WHERE moving."spaceId" = r."spaceId"
            AND moving."userId" = b."userId" AND moving."maintenanceId" LIKE 'home-move:%'
            AND (moving.scope = 'team' OR moving.id = b."computerId")) AS "homeMoving",
          (SELECT v.id FROM volumes v WHERE v.kind = 'bot_private' AND v."botId" = r."botId")
            AS "privateVolumeId",
          (SELECT v.id FROM volumes v WHERE v.kind = 'space_shared' AND v."spaceId" = r."spaceId"
            AND v."userId" = b."userId") AS "sharedVolumeId"
        FROM attempts a
        JOIN runs r ON r.id = a."runId"
        JOIN bots b ON b.id = r."botId"
        LEFT JOIN computers c ON c.id = b."computerId"
        WHERE a.id = ${input.attemptId}`;
      if (!row || !attemptHoldsFence(row, row)) throw new StaleAttemptError(input.attemptId);
      return planLaunch(
        {
          ...row,
          attemptId: input.attemptId,
          computer:
            row.computerId && row.homeStorage
              ? { id: row.computerId, homeStorage: row.homeStorage }
              : null,
        },
        input.needs,
      );
    },

    /**
     * Authorizes mounts and records intent in one transaction before the provider is called,
     * then records the VM's ref before any fallible setup. Runs once per attempt: a
     * controller that crashed mid-start loses its run lease, and the next claim is a new attempt.
     * A failure of its ensure or prepare releases the worker.
     */
    async start(launch: WorkerLaunch, context: AdapterContext): Promise<StartedWorker> {
      const provider = requireProvider();
      const { id: providerKind, capabilities } = provider.describe();
      const { mounts, ensureAt } = await prisma.$transaction(async (tx) => {
        const computers = await tx.$queryRaw<{ maintenanceId: string | null }[]>`
          SELECT c."maintenanceId" FROM computers c JOIN bots b ON b.id = ${launch.botId}
          WHERE c."spaceId" = ${launch.spaceId} AND c."userId" = b."userId"
            AND (c.scope = 'team' OR c.id = b."computerId")
          ORDER BY c.id FOR UPDATE OF c`;
        if (computers.some((computer) => computer.maintenanceId?.startsWith("home-move:"))) {
          throw new AgentRuntimeBusyError("Computer home is moving");
        }
        const [run] = await tx.$queryRaw<{ leaseFence: number; status: string }[]>`
          SELECT "leaseFence", status FROM runs WHERE id = ${launch.runId} FOR UPDATE`;
        const [attempt] = await tx.$queryRaw<
          { runId: string; fence: number; workerState: WorkerState | null }[]
        >`SELECT "runId", fence, "workerState" FROM attempts WHERE id = ${launch.attemptId}
          FOR UPDATE`;
        if (
          !run ||
          attempt?.runId !== launch.runId ||
          !attemptHoldsFence(attempt, run) ||
          attempt.workerState !== null
        ) {
          throw new StaleAttemptError(launch.attemptId);
        }
        const volumeIds = launch.volumes.map((grant) => grant.volumeId);
        const rows = volumeIds.length
          ? await tx.$queryRaw<VolumeRow[]>`
              SELECT id, kind, "spaceId", "botId", "userId", "providerKind", "providerRef"
              FROM volumes WHERE id = ANY(${volumeIds}) ORDER BY id FOR UPDATE`
          : [];
        const authorized = authorizeMounts(launch, launch.volumes, rows, {
          kind: providerKind,
          readOnlyMounts: capabilities.readOnlyMounts,
        });
        if (!authorized.ok) throw new VolumeRefusedError(authorized.refusal);
        const now = new Date();
        await tx.attempt.update({
          where: { id: launch.attemptId },
          data: {
            workerState: "requested",
            workerProviderKind: providerKind,
            workerStateAt: now,
            workerEnsureAt: now,
          },
        });
        return { mounts: authorized.mounts, ensureAt: now };
      });

      const spec: WorkerSpec = {
        attemptId: launch.attemptId,
        runId: launch.runId,
        botId: launch.botId,
        mounts: mounts.map(({ volumeRef, path, access }) => ({ volumeRef, path, access })),
        ttlSeconds: WORKER_TTL_SECONDS,
        ensureDeadline: workerEnsureDeadline(ensureAt),
      };
      // A provider failure passes or exhausts the run's retries; a refusal is thrown before this.
      const ownStep = async <T>(step: () => Promise<T>): Promise<T> => {
        try {
          return await step();
        } catch (error) {
          // A destroy the provider could not confirm stays releasing for the reconciler.
          await release(launch.attemptId, context, {
            ensureSettled: error instanceof WorkerEnsureSettledError,
          }).catch(() => undefined);
          throw new AgentRuntimeUnavailableError(
            `The worker provider failed: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      };
      const { providerRef } = await ownStep(() => provider.ensure(spec, context));
      await advance(launch.attemptId, "created", providerRef, context);
      await ownStep(() => provider.prepare(providerRef, spec, context));
      await advance(launch.attemptId, "ready", providerRef, context);
      return {
        providerRef,
        start: {
          version: WORKER_PROTOCOL_VERSION,
          kind: "worker.start",
          worker: { runId: launch.runId, attemptId: launch.attemptId, fence: launch.fence },
          workspace: {
            cwd: mounts.find((mount) => mount.scope === "private")?.path ?? WORKSPACE_ROOT,
            mounts: mounts.map(({ path, scope, access }) => ({ path, scope, access })),
          },
          computer: launch.computer.mode,
        },
      };
    },

    /**
     * Idempotent, and a no-op for an attempt without a worker. Records release only after the
     * provider confirms destruction and ensure can no longer create the VM. Volumes are untouched.
     */
    release: (attemptId: string, context: AdapterContext) => release(attemptId, context),

    async status(attemptId: string): Promise<WorkerStatusV1 | null> {
      const attempt = await prisma.attempt.findUnique({
        where: { id: attemptId },
        select: {
          runId: true,
          fence: true,
          workerState: true,
          workerProviderRef: true,
          run: { select: { leaseFence: true, status: true } },
        },
      });
      if (!attempt?.workerState) return null;
      return {
        version: WORKER_PROTOCOL_VERSION,
        kind: "worker.status",
        worker: { runId: attempt.runId, attemptId, fence: attempt.fence },
        state: WorkerState.parse(attempt.workerState),
        providerRef: attempt.workerProviderRef,
        active: attemptHoldsFence(attempt, attempt.run),
      };
    },

    async ownsFence(attemptId: string): Promise<boolean> {
      const attempt = await prisma.attempt.findUnique({
        where: { id: attemptId },
        select: { fence: true, run: { select: { leaseFence: true, status: true } } },
      });
      return Boolean(attempt && attemptOwnsFence(attempt, attempt.run));
    },

    /** Releases up to `limit` unreleased workers whose attempt no longer holds its run, oldest first. */
    async reconcile(
      options: { limit: number },
      context: AdapterContext,
    ): Promise<{ released: number; awaitingEnsure: number; failed: number }> {
      await prisma.$executeRaw`
        UPDATE computers SET "maintenanceId" = NULL, "homeMoveExpiresAt" = NULL, "updatedAt" = ${HOME_MOVE_NOW}
        WHERE "maintenanceId" LIKE 'home-move:%' AND "homeMoveExpiresAt" <= ${HOME_MOVE_NOW}`;
      const pauseDeadline = new Date(
        Date.now() - WORKER_LIMITS.pausedGraceMs - WORKER_LIMITS.stopConfirmMs,
      );
      const orphans = await prisma.$queryRaw<{ id: string }[]>`
        SELECT a.id FROM attempts a JOIN runs r ON r.id = a."runId"
        WHERE a."workerState" IN (${RELEASABLE})
          AND (a."workerState" = 'releasing' OR a.fence <> r."leaseFence"
            OR r.status NOT IN ('leased', 'running') OR r."leaseExpiresAt" < ${new Date()})
          AND NOT (a."workerState" <> 'releasing' AND a.fence = r."leaseFence"
            AND r.status IN (${Prisma.join(PAUSED_ATTEMPT_RUN_STATUSES)})
            AND a.status IN ('waiting_input', 'waiting_takeover')
            AND a."finishedAt" IS NOT NULL AND a."finishedAt" > ${pauseDeadline})
        ORDER BY a."workerStateAt", a.id
        LIMIT ${options.limit}`;
      const counts = { released: 0, awaitingEnsure: 0, failed: 0 };
      for (const { id } of orphans) {
        if (context.signal.aborted) break;
        try {
          const outcome = await release(id, context);
          if (outcome === "released") counts.released += 1;
          if (outcome === "awaiting_ensure") counts.awaitingEnsure += 1;
        } catch {
          // A provider that cannot confirm destruction leaves the worker releasing for the next pass.
          counts.failed += 1;
        }
      }
      return counts;
    },

    /**
     * Before a bot or a space is deleted, once it can get no new work: destroys every worker of
     * its runs and returns how many there were. A worker whose ensure may still be in flight stays
     * releasing, and the owner's deletion transaction refuses it (`deleteOwnerVolumes`). Without a
     * provider there is nothing to destroy.
     */
    async releaseOwnerWorkers(owner: VolumeOwnerRef, context: AdapterContext): Promise<number> {
      if (!deps.provider) return 0;
      const ownedBy =
        "botId" in owner
          ? Prisma.sql`r."botId" = ${owner.botId}`
          : Prisma.sql`r."spaceId" = ${owner.spaceId}`;
      const live = await prisma.$queryRaw<{ id: string }[]>`
        SELECT a.id FROM attempts a JOIN runs r ON r.id = a."runId"
        WHERE a."workerState" IN (${RELEASABLE}) AND ${ownedBy}`;
      for (const { id } of live) await release(id, context);
      return live.length;
    },

    /**
     * Deletes at the provider a few volumes this database recorded as deleted, oldest first, and
     * then their records after the server-create grace period. Repeated deletes during that
     * period catch accepted creates whose client timed out. Only a recorded volume is ever
     * deleted, so a provider account shared
     * with another deployment is safe. Idempotent; records of another provider kind wait for it.
     */
    async sweepVolumes(context: AdapterContext): Promise<{ deleted: number; failed: number }> {
      const counts = { deleted: 0, failed: 0 };
      if (!deps.provider) return counts;
      const providerKind = deps.provider.describe().id;
      const now = new Date();
      const deletions = await prisma.volumeDeletion.findMany({
        where: { providerKind, notBefore: { lte: now } },
        orderBy: { createdAt: "asc" },
        take: VOLUME_SWEEP_BATCH,
        select: { providerRef: true, generation: true, notBefore: true },
      });
      for (const { providerRef, generation, notBefore } of deletions) {
        if (context.signal.aborted) break;
        try {
          await deps.provider.deleteVolume({ providerRef }, context);
          if (now.getTime() >= notBefore.getTime() + VOLUME_CREATE_GRACE_MS) {
            await prisma.volumeDeletion.deleteMany({
              where: { providerKind, providerRef, generation },
            });
          }
          counts.deleted += 1;
        } catch {
          counts.failed += 1;
        }
      }
      return counts;
    },

    provisionVolume,

    /** Creates the owner's volume row unless it exists, then provisions it. */
    ensureVolume,

    /**
     * Creates and provisions the private volume of every bot on a computer whose home is on
     * volumes, archived ones included, as a bot attached after the move needs before the computer
     * mounts it. Nothing while the home is still a snapshot.
     */
    async provisionHomeVolumes(computerId: string, context: AdapterContext): Promise<void> {
      const computer = await prisma.computer.findUniqueOrThrow({
        where: { id: computerId },
        select: {
          spaceId: true,
          userId: true,
          homeStorage: true,
          bots: { select: { id: true } },
        },
      });
      if (computer.homeStorage !== "volumes") return;
      await ensureVolume(
        { kind: "space_shared", spaceId: computer.spaceId, userId: computer.userId },
        context,
      );
      const provisioned = new Set(
        (
          await prisma.volume.findMany({
            where: {
              kind: "bot_private",
              botId: { in: computer.bots.map((bot) => bot.id) },
              providerRef: { not: null },
            },
            select: { botId: true },
          })
        ).map((volume) => volume.botId),
      );
      for (const bot of computer.bots) {
        if (provisioned.has(bot.id)) continue;
        await ensureVolume(
          { kind: "bot_private", spaceId: computer.spaceId, botId: bot.id },
          context,
        );
      }
    },

    /** Reserves the source, or its person's computers for a team home that also copies their shared volume. */
    async reserveHomeMove(
      computerId: string,
    ): Promise<{ marker: string } | { blocker: HomeMoveBlocker }> {
      return prisma.$transaction(async (tx) => {
        const { blocker, computer } = await inspectHomeMove(tx, computerId, true);
        if (blocker) return { blocker };
        const marker = `home-move:${computerId}:${randomUUID()}`;
        await tx.$executeRaw`
          UPDATE computers SET "maintenanceId" = ${marker}, "updatedAt" = ${HOME_MOVE_NOW},
            "homeMoveExpiresAt" = ${HOME_MOVE_NOW} + ${HOME_MOVE_TTL_MS} * interval '1 millisecond'
          WHERE "spaceId" = ${computer.spaceId} AND "userId" = ${computer.userId}
            AND (${computer.scope === "team"} OR id = ${computerId})`;
        return { marker };
      });
    },

    async releaseHomeMove(marker: string): Promise<void> {
      await prisma.computer.updateMany({
        where: { maintenanceId: marker },
        data: { maintenanceId: null, homeMoveExpiresAt: null },
      });
    },

    /** An expired owner cannot renew or adopt, even if reconciliation has not run yet. */
    async renewHomeMove(marker: string): Promise<boolean> {
      const renewed = await prisma.$executeRaw`
        UPDATE computers SET "updatedAt" = ${HOME_MOVE_NOW},
          "homeMoveExpiresAt" = ${HOME_MOVE_NOW} + ${HOME_MOVE_TTL_MS} * interval '1 millisecond'
        WHERE "maintenanceId" = ${marker} AND "homeMoveExpiresAt" > ${HOME_MOVE_NOW}`;
      return renewed > 0;
    },

    /** Clears only an expired reservation owned by this source computer. */
    async clearStaleHomeMove(computerId: string): Promise<boolean> {
      const computer = await prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
      const marker = computer.maintenanceId;
      if (!marker?.startsWith(`home-move:${computerId}:`)) return false;
      const cleared = await prisma.$executeRaw`
        UPDATE computers SET "maintenanceId" = NULL, "homeMoveExpiresAt" = NULL, "updatedAt" = ${HOME_MOVE_NOW}
        WHERE "maintenanceId" = ${marker} AND "homeMoveExpiresAt" <= ${HOME_MOVE_NOW}`;
      return cleared > 0;
    },

    /**
     * What would stop the home moving onto volumes now, and the start that adoption checks
     * against, without locking or writing anything.
     */
    async inspectHomeMove(
      computerId: string,
    ): Promise<{ blocker: HomeMoveBlocker | null; start: HomeMoveStart }> {
      const { blocker, start } = await inspectHomeMove(prisma, computerId, false);
      return { blocker, start };
    },

    /**
     * The only change of computers.homeStorage: moves an existing home from snapshots to volumes
     * once every bot on the computer, and the space for a team computer, has a provisioned volume
     * nobody writes, nothing runs on the computer, and no worker in its scope may still write
     * the volumes. Called after the files were copied, with the start taken
     * before the copy; stops automatic import and export for good.
     */
    async adoptVolumeHome(
      computerId: string,
      start: HomeMoveStart,
      marker?: string,
    ): Promise<HomeAdoption> {
      return prisma.$transaction(async (tx) => {
        const computer = await readHomeComputer(tx, computerId, true);
        if (marker) {
          const [owner] = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM computers WHERE id = ${computerId}
              AND "maintenanceId" = ${marker} AND "homeMoveExpiresAt" > ${HOME_MOVE_NOW}`;
          if (!owner) return "computer_active";
        }
        if (computer.homeStorage === "volumes") return "adopted";
        // A checkpoint during the copy wrote files the copy may not hold.
        if (computer.homeRevision !== start.homeRevision) return "home_revised";
        const blocker = await computerBlocker(tx, computerId, computer);
        if (blocker) return blocker;
        const { botIds, team, volumes } = await homeVolumes(tx, computerId, computer, true);
        const provisioned = volumes.filter((volume) => volume.providerRef);
        const missing =
          botIds.some((botId) => !provisioned.some((volume) => volume.botId === botId)) ||
          (team && !provisioned.some((volume) => volume.kind === "space_shared"));
        if (missing) return "volume_missing";
        // Read after the volume locks, so a start that locked a volume first is seen.
        const workers = await homeWorkers(tx, computerId, computer);
        if (workers.live > 0) return "space_worker_live";
        if (workers.total !== start.workerCount) return "space_worker_ran";
        await tx.computer.update({ where: { id: computerId }, data: { homeStorage: "volumes" } });
        return "adopted";
      });
    },
  };
}

export type WorkerLifecycle = ReturnType<typeof createWorkerLifecycle>;

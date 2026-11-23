---
name: tangow
description: Use when operating a Tangow source server with the `./tangow` CLI, including updates, Docker or E2B computer builds, provider migration, restarts, cleanup, or recovery after an interrupted deployment.
---

# Tangow

Operate the source deployment through Tangow **on the server**. Locate the authorized host and
checkout from session context or private deployment configuration; do not bake real hosts, paths
or credentials into this skill. SSH can reach the server, but Tangow has no `--host` option.

Read [the operator guide](../../../docs/tangow.md) for prerequisites and provider migration details.
A deployment installed under the Rakazo name (`RAKAZO_*` keys in `.env`, `rakazo-*` volumes) needs
[the Rakazo to Tangow migration](../../../docs/migrate-from-rakazo.md) before or with its first update.
Run `./tangow --help` in the target checkout to check the installed commands. This skill is for
source Compose deployments; it does not install E2B infrastructure.

## Establish the state

Start with `./tangow status`; check Git state before updates or source builds. Check host Node/pnpm against `package.json`
before E2B builds. Tangow reads provider configuration from `.env.e2b.compose.json`; optional
`.env.tangow.json` supplies `sudo` and `computerImage`. Let the CLI read private configuration;
use configured sudo or `--sudo` for root-owned overrides rather than printing their contents.
Never switch provider just by editing `SANDBOX_PROVIDER` in `.env`: source Compose forces Docker
without the E2B override.

If Tangow is absent, first check that its commit is on `origin/main`. Bootstrap only the clean,
fast-forwardable server checkout to that revision using Git as its owner, then run Tangow.
Stop on local changes or divergent commits; do not reset history to make deployment succeed.

Every real run uses a worker: one Docker `tangow/worker` container per attempt through the
supervisor, or an E2B worker VM. `PiAgentRuntime` and `AGENT_RUNTIME=pi` are gone. Tangow removes
the legacy Pi environment entry on update; `scripted` is test-only. Empty/`none` providers, E2B
without its key, and production Docker without its supervisor token are configuration errors.
Fix configuration rather than disabling workers or using the scripted runtime.

## Choose the operation

| Request | Command on the server | Result to verify |
| --- | --- | --- |
| Update Tangow | `./tangow update` | Target main revision, provider, application images and readiness; Docker app/worker guest revisions must match; both E2B templates rebuild automatically. |
| Restart existing services | `./tangow restart` | Same running revision and images return; this does not deploy newer checkout code. |
| Inspect a failure | `./tangow status`, `./tangow logs worker` or `./tangow logs api` | Failed stage and checkout/runtime mismatch. |
| Rebuild only computers/templates | `./tangow computers build` | Source must match the running API and worker; use `update` for a new revision. |
| Move Docker homes to E2B | `./tangow provider e2b` | Existing setup completes backups, home migration and provider readiness. |
| Move E2B volumes to Docker | `./tangow provider docker --migrate-existing` | Verified bot/private and shared copies, preserved IDs, Docker readiness; source E2B volumes retained. |
| Remove unused Docker builds | `./tangow cleanup --yes` | Cache and unused images pruned; containers and volumes retained. |

`--dry-run` describes an operation; it does not prove prerequisites or connectivity. Keep mutations
within the user's request. An update request already covers its builds and restart; do not ask
again for each step. Run cleanup when requested. Use `--migrate-existing` only when the user has
authorized the one-way home move, including any consent already given in this session. Keep
credentials in private configuration or the secret-entry mechanism available in the environment.

## Startup migrations

`update` waits for Compose `migrate` and verifies its exit code and target app image before
starting API/worker. It runs backfill plus `scripts/migrate-docker-homes.ts`. Docker homes move
by rename into `DATA_DIR/volumes/tangow-<volumeId>` only while idle; `.tangow-move-pending` guards
partial moves. Tangow reports computers still deferred with bot/state context. Busy homes retry
on suspend; conflicts need inspection. Keep markers intact. User skills copy once to the shared
space volume. A deferred computer does not mean the migration service failed, nor does a zero
migration exit code mean every computer moved.

E2B `update` and `restart` inspect homes with `scripts/setup-e2b-homes.ts --inspect` before service
restart. Snapshot homes or Docker volumes must first migrate through `provider e2b` and the
linked E2B guide. After an update preflight refusal, keep the prepared target image/revision; setup
can use it while the older API remains deployed, stopping that API after consent. Do not try to
start the new API first to satisfy a revision check; do not start an API that will reject those homes. Docker-to-E2B setup carries
existing volumes with `scripts/carry-docker-volumes-to-e2b.ts`, verifying copies and resuming
interruptions, team computer before private computers. Chrome profiles stay behind: report that
bots must sign in again. Reuse the setup flow instead of writing a custom copy procedure.

## Recover by the failed stage

- If `.env.e2b.upgrade.json` exists, keep API/worker stopped and rerun the same
  `./tangow provider e2b` operation with the same registry/configuration to resume. Read the setup
  guide's recovery section if it refuses. Do not bypass the journal with Compose up/restart,
  delete it, or revert the override to Docker.
- After an application/template build or readiness failure without a migration journal, inspect
  the reported stage, fix the cause and rerun `./tangow update`. Git may already have advanced and
  templates may already be published. `restart` alone keeps existing containers; it cannot finish
  deployment of newer code. No rollback is allowed. Retain the current configuration and recover forward; do not restore old configuration, code, templates or database.
- For `.env.tangow.lock` or `.env.e2b.setup.lock`, inspect its PID on that server. Remove a stale
  lock only after confirming the owner process has ended; retain an active lock.
- If `.env.tangow.docker.json` exists, keep API/worker stopped and rerun `./tangow provider docker`
  from the same checkout revision. Keep the saved source override and `data/docker-provider-migration/`
  journal. Never delete the active override manually to switch providers. The command copies and
  verifies every E2B private/shared volume before adoption and retains sources and backups.
  It destroys source computer VMs to release mounts, so browser state outside volumes is lost.
  Snapshot homes, differing old Docker copies, links, special files and files over 256 MiB block
  migration rather than being silently skipped. After service readiness, verify a real bot run
  and computer mounts separately. See the operator guide before performing the migration.

## Verify computers separately

A successful `update` publishes builds and updates server services; it does not replace existing
computers. For replacement, use **Settings > Computer > Update all computers** within the user's
authorized scope. Busy computers are skipped. Identify affected bots when available and retry
after their work/control lease ends; do not acquire viewer control just to perform maintenance.

If asked whether computers are current, compare each computer's actual provider build/image with
the expected published build using available provider inspection. A completed database operation,
a new template, or server `Ready` alone does not prove the active computer's image. If inspection
is unavailable, report that verification is incomplete instead of claiming every computer updated.

Finish with the verified application revision/provider, image/template result, remaining computers
or affected bots, and any failed stage or retry needed. Distinguish a dry run, a queued operation
and verified completion. Keep secrets and real deployment identifiers out of public PRs and logs.

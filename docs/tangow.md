# Tangow

The `./tangow` operator CLI runs **directly on the server**, from a Tangow source checkout. It updates the application
and the computer builds for the configured provider. Run `./tangow` or `pnpm tangow`; it operates the source Compose stack. Coding agents can use the project [Tangow skill](../.agents/skills/tangow/SKILL.md)
for lifecycle operations and recovery. A deployment installed under the Rakazo name first follows
[Migrate a Rakazo deployment to Tangow](migrate-from-rakazo.md).

```bash
./tangow status
./tangow update --dry-run
./tangow update
```

`update` fetches `origin/main`, fast-forwards a clean checkout onto `main`, and builds the application.
It reads the ignored `.env.e2b.compose.json` used by the deployment:

- With that override, it preserves E2B settings, installs frozen build dependencies, builds and
  pushes the desktop image, then rebuilds the worker and desktop templates on every update. The desktop template
  uses the pushed image's immutable digest.
- Without it, it builds the Docker computer, supervisor and `tangow/worker` images alongside the application.
  The worker comes from `apps/agent-run-worker/Dockerfile` through Compose `worker-image`; its
  revision label must match the application revision before services can start.
  Empty/`none` providers, E2B without a key, and production Docker without a supervisor token
  fail startup. Source Compose forces Docker; a `SANDBOX_PROVIDER` value in `.env` alone does not enable E2B.

It then starts the services and checks the actual API revision and provider, application images,
web readiness and, on Docker, the supervisor image. It never resets local commits or deletes data.

Every real run uses the same worker agent loop: Docker starts one `tangow/worker` container per
attempt through the supervisor, and E2B starts a worker VM. There is no in-process Pi runtime.
`AGENT_RUNTIME=pi` is obsolete; Tangow removes that legacy entry from `.env` during update.
`AGENT_RUNTIME=scripted` is reserved for tests and Tangow refuses it for a real deployment.

Before starting API/worker, Tangow recreates and waits for the Compose `migrate` service, then
checks its exit code and app image. It runs the session-log backfill and Docker-home migration.
The final startup checks `migrate` again. A database/configuration or storage error blocks startup;
individual busy/conflicting homes are deferred instead of failing the deployment.

Docker moves idle homes by rename under `DATA_DIR/volumes/tangow-<volumeId>`. A temporary
`.tangow-move-pending` in a home guards partial moves. Tangow reports remaining computer ids,
bots, states and reasons after startup, including homes with that marker. Busy computers move
on their next suspend; conflicts need inspection. Do not delete the marker. Legacy user skills
are copied once into each space's shared volume by the existing migration.

E2B updates and restarts run `scripts/setup-e2b-homes.ts --inspect` before restarting services.
Any remaining snapshot homes or Docker volumes block restart. Use the existing
[home upgrade procedure](self-host-e2b-workers.md#move-existing-homes-onto-volumes), through
`./tangow provider e2b`, before retrying. Setup verifies the prepared application image/revision, stops the older API and
worker after migration consent, and can migrate before the new API is first started. Tangow never
starts an API with an incomplete E2B upgrade.

## First deployment

From a source checkout on the deployment machine, run:

```bash
./tangow setup
```

Install Git, Docker with Compose, and a supported Node version first: Node 22.22.2+ in the 22.x
line, 24.x, or 26+. Use `--sudo` if Docker needs passwordless `sudo -n`. Setup checks Docker
access before writing configuration; it does not install host tools.

The wizard asks for the web origin and computer provider, generates independent database and
application secrets, then builds and starts **the current checkout**. It never fetches or switches
branches. It verifies startup migrations, the running revision/provider and service images,
and API and web readiness. The final URL is where you create the first owner account and
connect a model. Send a bot a message to check a real model-backed run after onboarding.

Loopback defaults to `http://127.0.0.1:5173`. For a public origin, use HTTPS and configure a reverse
proxy to `127.0.0.1:5173` first. Setup asks for SMTP, an email sender and a signup allowlist before
the first startup, applies that policy to the database on public setup and retries, and checks web
access from the deployment machine afterwards. The allowlist also applies to existing accounts;
those users must verify their email when the deployment becomes public. It does not
configure DNS, TLS, email-provider credentials or external-client connectivity. Use an email
address or an `@example.com` domain in the allowlist. Delivery must work to verify the first
account's email. See [self-hosting](self-host.md#verification-and-password-recovery-email).

Docker needs no host pnpm installation. If you select E2B, enable Corepack and pnpm 9, prepare
an existing E2B service and log in to a pushable registry first. The wizard starts and verifies
Docker before continuing through the existing E2B setup, which requests the domain and hidden
API key, builds templates and checks provider readiness. It does not provision E2B infrastructure.

`.env` and `.env.tangow.json` stay private with owner-only permissions. Secret input is hidden.
Retries preserve saved secrets, unrelated settings and comments. If containers, volumes or local data
already exist but required credentials are missing, restore the original `.env`; setup refuses
to regenerate credentials that could disconnect the database or make stored credentials unreadable.

After a build or readiness failure, fix the reported stage and rerun `./tangow setup` from the
same checkout. Select E2B again if its continuation has not yet saved the provider override.
If a provider migration journal exists, follow its [recovery instructions](#recover-an-interrupted-operation)
instead. Setup never deletes data or rolls back. For later upgrades use `./tangow update`.
`./tangow setup --dry-run` describes the flow without prompting or changing anything.

## Configure once

The deployment needs Git, Docker Compose, a configured `.env` and Node.js. E2B builds need a Node
version supported by `package.json` and pnpm 9. Enable Corepack after installing supported Node:

```bash
corepack enable
```

Tangow installs frozen dependencies before template builds. For Docker-to-E2B setup, install them
first with `CI=true ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm install --frozen-lockfile`.

Optional defaults belong in **`.env.tangow.json`**, which is ignored by Git:

```json
{
  "sudo": true,
  "computerImage": "registry.example.com/tangow-computer:local"
}
```

`sudo` uses passwordless `sudo -n` for Docker and for reading a root-owned E2B override. Git always
runs as the checkout owner. That owner must be able to replace `.env` and write to the checkout.
Keep this config readable by that owner. Credentials stay in the existing private E2B override.

`computerImage` selects a pushable registry image that the E2B builder can pull. When omitted,
Tangow infers the repository from `tangow/computer:local`'s existing registry digest and uses its
`:local` tag. If no digest exists, it asks you to configure an image before changing Git or services.
`--sudo` and `--computer-image` can also supply these settings for one invocation.

To select a different source deployment on the same server:

```bash
./tangow --path /srv/tangow status
```

## Other commands

```bash
./tangow restart
./tangow logs worker
./tangow logs api --follow
./tangow computers build
./tangow cleanup --dry-run
./tangow cleanup --yes
```

`restart` restarts the existing application containers without rebuilding and verifies the same
revision and container images. `status` shows checkout and runtime revisions separately. Logs
show the last 100 lines unless followed; they are operator output and may contain private data.

`computers build` rebuilds only the configured provider's images/templates. A standalone worker build requires
a clean checkout matching the running API and worker revision; use `update` for a new revision.

New workers and computers use the new builds. To replace existing computers, open
**Settings > Computer > Update all computers**. The batch action appears when updates are available;
current computers are skipped, and busy computers are reported for retry.

Computer releases follow the environment, independently of the application commit. Docker compares
immutable image IDs; its managed skills update through their live mount without replacement. E2B
publishes a content tag derived from the canonical image digest, effective template instructions,
VM profile and embedded skills. Rebuilding an unchanged template retains its release reference even
when E2B assigns another build ID. Cold Docker rebuilds can produce another image ID, especially when
upstream packages change; this is artifact identity, not a guarantee of reproducible builds.

Existing computers retain their original release reference when resumed. After the first release-aware
deployment, an existing computer with no recorded reference is offered one manual update. Computers
never started receive the current release at first boot and show no update notice. If a provider cannot
report its published release, version notices are unavailable; opening the computer and manual
maintenance remain available. Release checks are cached for up to one minute.
Tangow does not interrupt them.

Cleanup removes unused build cache and images. It never prunes containers or volumes. Run it after checking the deployment. `--dry-run` on any
command describes the operation without running external commands or changing files.

## Switch Docker to E2B

Tangow reuses the [existing setup and migration command](self-host-e2b-workers.md), including its
backups, readiness checks and resumable home migration. Existing Docker volumes are carried by
`scripts/carry-docker-volumes-to-e2b.ts`, team computer first, then private computers. Every copy
is verified and interrupted copies resume; Tangow reuses this flow rather than copying files itself. Prepare the current revision and application image with `update`; if it
blocks on E2B homes, keep the prepared artifacts for setup. Configure a registry image as above,
finish active work and release computer control first.

```bash
./tangow provider e2b --dry-run
./tangow provider e2b
```

Setup asks for an E2B domain and a hidden key, or keeps saved values. For unattended operation,
use existing private configuration or `E2B_DOMAIN` and `E2B_API_KEY` on the server and add
`--migrate-existing` to consent to the one-way home move. Sudo must permit preserving the named
`E2B_*` and `WORKER_TEMPLATE` variables; their values never enter command arguments. Successful
setup saves the selected registry image and sudo preference in `.env.tangow.json` for later updates.

Chrome profiles are not copied; bots must sign in again to their sites. Originals and backups are retained. Unsupported home entries stay in originals and backups,
outside the new volumes; the setup guide documents the scope.

## Switch E2B to Docker

Run this on the source deployment server, with a clean checkout containing this command,
Docker access and enough local disk for backups and the E2B volumes. Keep the current private
E2B override and credentials. Docker also needs `SANDBOX_SUPERVISOR_TOKEN` in `.env`.

```bash
./tangow provider docker --dry-run
./tangow provider docker --migrate-existing
```

The consent flag authorizes a maintenance window. Finish or cancel queued and active runs,
release computer control and let execution leases end first. Homes must already use volumes;
finish the existing E2B home upgrade before migrating snapshot homes.

Tangow builds matching Docker application, worker, supervisor and computer images, stops API
and worker, backs up the database and local data, then confirms E2B worker and computer teardown.
Computer VMs are destroyed to release their mounts; persistent E2B volumes are retained.
Running processes, browser profiles and other files outside bot/shared volumes do not migrate.
Bots may need to sign in again.

Every E2B bot-private volume, including archived bots and bots without an active computer, and
every space-shared volume is copied once into `data/volumes/tangow-<volumeId>`. Copies preserve
files, executable and permission bits, and empty directories, and are verified by file hashes
and a complete inventory before database references switch. Bot, space and volume IDs stay the
same. An existing Docker directory is reused only when it matches exactly; differing copies
are retained and block migration. Symbolic links, special files, unsupported paths and files
larger than 256 MiB block migration rather than being skipped. Resolve these entries before
retrying; this version does not stream large files.

The preflight checks database blockers before downtime. Source file inventories and import
space checks run after E2B computers have stopped. An unsupported entry or insufficient import
space therefore leaves the deployment in maintenance until resolved; this version does not
provide a complete source-file inventory or total storage estimate before the maintenance window.

Tangow retains `.env.tangow.docker.json`, a private source override and an import journal in
`data/docker-provider-migration/` until cutover succeeds. On failure, leave services stopped and
rerun `./tangow provider docker` from the same revision. Verified volumes are reused; an
incomplete staging directory is recopied. After configuration cutover, retrying startup does
not copy E2B files over Docker data. Ordinary Tangow mutations and E2B setup refuse an incomplete
Docker migration. Do not delete journals, manually restart Compose or restore an older database
or configuration. Recovery proceeds toward Docker.

Completion verifies Docker revision, images and service readiness. Then check a real bot run
and its computer, including private-file writes and shared-file access, before removing any
E2B resources. Original E2B volumes and private backups under `backups/docker-<operationId>`
are never deleted by this command. A local `data` backup alone does not back up remote E2B files.

## Recover an interrupted operation

A failed application build leaves running services alone, although Git may have advanced. A later
failure may leave published E2B templates or restarted services in place. Tangow identifies the
failed step. Recovery is forward only; do not roll back configuration, code, templates or databases. Fix the problem and rerun `update`.
Keep template and application upgrades within a maintenance window.

If home migration fails, rerun the same `provider e2b` command. Do not manually start services while
`.env.e2b.upgrade.json` exists; other Tangow mutations refuse an incomplete migration.

Only one Tangow mutation runs per checkout. After interruption, inspect the PID in
`.env.tangow.lock` and confirm the process has stopped before removing a stale lock. E2B setup has
its own `.env.e2b.setup.lock`; follow its recovery instructions. Keep environment files, overrides,
journals and backups private.

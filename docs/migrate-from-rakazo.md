# Migrate a Rakazo deployment to Tangow

Rakazo was renamed Tangow. The rename changed environment variable names, Docker image, container,
network and volume names, Postgres defaults, the computer user and home, deploy and backup paths,
and E2B template names. A deployment installed before the rename does not migrate by itself: an
update without the steps below can leave runs failing or, in production Compose, start on an
empty database.

This guide is written so an operator, or a coding agent working for one, can run it step by step on
the server. Every step says how to check it before moving on. Use placeholders for paths and keep
secrets out of logs and chat.

## What changed

| Area | Before | After |
| --- | --- | --- |
| Settings in `.env` | `RAKAZO_*` | `TANGOW_*` (same suffixes) |
| Postgres role and database defaults | `rakazo` / `rakazo` | `tangow` / `tangow` |
| Production Compose project | `rakazo-prod` | `tangow-prod` |
| Default deploy and backup dirs | `/srv/rakazo`, `/var/backups/rakazo` | `/srv/tangow`, `/var/backups/tangow` |
| Docker images | `rakazo/app`, `rakazo/worker`, `rakazo/computer`, `rakazo/supervisor` | `tangow/…` |
| Docker computers and networks | `rakazo-bot-<bot>`, `rakazo-computer-…`, `rakazo-workers`, `rakazo.*` labels | `tangow-…`, `tangow.*` labels |
| Docker worker volumes | `DATA_DIR/volumes/rakazo-<volumeId>` | `DATA_DIR/volumes/tangow-<volumeId>` (the supervisor rejects other names) |
| Files inside a home | `.rakazo/browser-profiles.tgz`, `.rakazo-move-pending`, `source /etc/rakazo/zshrc` | `.tangow/…`, `.tangow-move-pending`, `/etc/tangow/zshrc` |
| Computer user and home | `rakazo`, `/home/rakazo` | `tangow`, `/home/tangow` (same uid 1000) |
| E2B templates | `rakazo-worker-<harness>` | `tangow-worker-<harness>` |
| Backup unit | `rakazo-backup.service` | `tangow-backup.service` |
| Web language choice (browser storage) | `rakazo.uiLocale` | `tangow.uiLocale` |

## Before you start

1. Identify the layout:
   - **Source Compose**: a source checkout operated with `./tangow` (`infra/compose/docker-compose.yml`,
     data in the checkout's `data/` directory, Compose project `compose`).
   - **Production Compose**: `infra/compose/docker-compose.prod.yml` with the updater, data in the
     `appdata` named volume.
   - **Provider**: Docker computers, or E2B when `.env.e2b.compose.json` exists.
2. Back up `.env` and the database. On source Compose:

   ```bash
   cp -p .env ".env.before-tangow.$(date -u +%Y%m%dT%H%M%SZ)"
   docker compose --env-file .env -f infra/compose/docker-compose.yml exec -T postgres \
     pg_dump -U "<postgres user>" -Fc "<postgres db>" > "<backup dir>/before-tangow.dump"
   ```

3. Commit or set aside local changes to tracked files: `./tangow update` refuses a dirty checkout.

## 1. Rename the settings in `.env`

Every `RAKAZO_` key becomes `TANGOW_`; values do not change. Nothing reads the old names any more.

```bash
grep -c '^RAKAZO_' .env              # how many to rename
grep '^TANGOW_' .env                 # must be empty, or merge by hand
sed -i 's/^RAKAZO_/TANGOW_/' .env    # macOS: sed -i ''
grep -c '^RAKAZO_' .env              # expect 0
```

## 2. Keep the existing database and data

The Postgres role and database are created only when the data directory is first initialised, so an
existing deployment keeps `rakazo`. Pin it in `.env` if the keys are missing (they used to default):

```bash
grep -E '^(POSTGRES_USER|POSTGRES_DB|DATABASE_URL)=' .env
# Add when absent:
# POSTGRES_USER=rakazo
# POSTGRES_DB=rakazo
```

Production Compose only, both mandatory before updating:

- `COMPOSE_PROJECT_NAME=rakazo-prod` in `.env`. Without it Compose starts the `tangow-prod` project
  with new, empty `pgdata` and `appdata` volumes: the instance comes up with no data. Check with
  `docker volume ls | grep rakazo-prod_` that these are the volumes you keep.
- `TANGOW_DEPLOY_DIR=/srv/rakazo` if the deployment still lives there, so the updater bind mount
  resolves. Moving the directory instead is fine; then update the backup unit paths too.

Renaming the role, database or Compose project is possible later with `ALTER ROLE`, `ALTER DATABASE`
and a volume copy, but it is not needed to run Tangow.

## 3. Update

Source Compose:

```bash
./tangow status
./tangow update
```

The first run after the rename may stop with `Worker guest image does not match the application
revision`: the CLI that started still came from the old checkout and inspected the old image name.
The checkout has already advanced, so run `./tangow update` again. It must end with
`Ready: <revision> (<provider>)`.

Production Compose updates through its updater as before, once step 2 is done.

## 4. Rename Docker worker volumes (Docker provider)

Skip on E2B. The Docker supervisor now only accepts volumes named `tangow-<volumeId>`, while each
existing volume keeps its old name in `volumes.providerRef`. Until both are renamed, every run of an
affected bot fails with `invalid worker volume name`.

Do this right after the update, with `api` and `worker` stopped so no run starts in between. The
commands use source Compose; on production Compose use its file and env file and the same services.

```bash
compose="docker compose --env-file .env -f infra/compose/docker-compose.yml"
psql="$compose exec -T postgres psql -U <postgres user> -d <postgres db> -Atq"

# References and directories must match one to one.
$psql -c "select \"providerRef\" from volumes where \"providerRef\" like 'rakazo-%' order by 1" > /tmp/refs.txt
$compose run --rm --no-deps --entrypoint sh worker -c 'ls /data/volumes | grep "^rakazo-" | sort' > /tmp/dirs.txt
wc -l < /tmp/refs.txt; wc -l < /tmp/dirs.txt; diff /tmp/refs.txt /tmp/dirs.txt && echo match

$compose stop api worker

# Rename each directory and the files the new code looks for inside a home.
$compose run --rm --no-deps --entrypoint sh worker -c '
  cd /data/volumes || exit 1
  for d in rakazo-*; do
    [ -d "$d" ] || continue
    n="tangow-${d#rakazo-}"
    [ -e "$n" ] && { echo "exists: $n"; exit 1; }
    mv "$d" "$n"
    [ -d "$n/.rakazo" ] && [ ! -e "$n/.tangow" ] && mv "$n/.rakazo" "$n/.tangow"
    [ -e "$n/.rakazo-move-pending" ] && mv "$n/.rakazo-move-pending" "$n/.tangow-move-pending"
    [ -f "$n/.zshrc" ] && sed -i "s#/etc/rakazo/zshrc#/etc/tangow/zshrc#" "$n/.zshrc"
  done
  echo "rakazo left: $(ls | grep -c "^rakazo-")"'

$psql -c "update volumes set \"providerRef\" = 'tangow-' || substr(\"providerRef\", 8)
          where \"providerRef\" like 'rakazo-%'"
$psql -c "select count(*) from volumes where \"providerRef\" like 'rakazo-%'"   # expect 0

$compose start api worker
```

Stop and investigate instead of forcing it when the lists differ or a `tangow-` directory already
exists: a home could be overwritten. Legacy homes still under `DATA_DIR/homes/` are moved into
volumes by the update's Docker home migration; fix their `.zshrc` the same way if they keep one.

## 5. E2B provider

- `./tangow update` rebuilds both templates under their new `tangow-…` names; old `rakazo-…`
  templates stay in the E2B account and can be deleted once runs succeed.
- Existing E2B volumes keep their stored names; nothing checks their prefix, so no rename is needed.
- Browser sign-ins are archived in each home at `.rakazo/browser-profiles.tgz`, now read from
  `.tangow/browser-profiles.tgz`. Unless that file is moved inside the volume, bots must sign in
  again on their computer.

## 6. Unblock runs that failed during the migration

A run whose worker was refused (for example by `invalid worker volume name`) leaves its attempt in
`workerState = 'releasing'` with no `workerProviderRef`. The run then stays queued, re-checked every
few seconds, until the 15-minute worker creation timeout has passed; it then starts on its own. To
see them:

```bash
$psql -c "select \"runId\", status, \"workerState\", \"workerEnsureAt\" from attempts
          where \"workerState\" = 'releasing' and \"workerProviderRef\" is null"
```

Waiting is always safe. To release them sooner, first confirm that no worker container or VM exists
for them (for Docker, `docker ps -a` lists no worker started at that time), then:

```bash
$psql -c "update attempts set \"workerState\" = 'released', \"workerStateAt\" = now()
          where \"workerState\" = 'releasing' and \"workerProviderRef\" is null
          and status = 'setup_failed'"
```

## 7. Remove leftovers

The new supervisor ignores old computers; they are recreated as `tangow-bot-*` on next use, with
their homes from the renamed volumes.

```bash
docker ps -a --format '{{.Names}} {{.Status}}' | grep '^rakazo-'   # old computers, stopped
docker rm <each rakazo-bot-… container>
docker network ls --format '{{.Name}}' | grep '^rakazo-' | xargs -r docker network rm
docker images --format '{{.Repository}}:{{.Tag}}' | grep '^rakazo/' | xargs -r docker rmi
./tangow cleanup --yes                                           # build cache and unused images
```

On hosts set up with the hardening and backup scripts: disable `rakazo-backup.service` and enable
`tangow-backup.service`, and remove `99-rakazo-hardening.conf` (sshd and sysctl),
`52rakazo-unattended-upgrades` and `50-rakazo.rules` once the `tangow` versions exist. New backups
are written to `/var/backups/tangow` as `tangow.dump`; older ones stay where they are.

People who chose a language in the web app pick it again once: the choice lives in browser storage
under the new key.

## 8. Verify

- `./tangow status` shows the new revision running and every service up.
- `volumes.providerRef` has no `rakazo-` left (Docker), and `data/volumes` no `rakazo-*` directory.
- Send a message to a bot: the supervisor logs `POST /workers` with status 200 and the run completes.
- Open a bot's computer: its files are there and its terminal starts without a missing `zshrc` error.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Worker guest image does not match the application revision` on the first update | CLI started from the old checkout | Run `./tangow update` again |
| Runs fail with `Supervisor POST /workers failed with 500: invalid worker volume name` | Volumes still named `rakazo-<id>` | Step 4 |
| A run stays queued and the worker logs `run.continue` every few seconds without a worker | Attempt left `releasing` without a worker | Step 6 |
| Empty instance after a production update | Compose started `tangow-prod` volumes | Stop it, set `COMPOSE_PROJECT_NAME=rakazo-prod`, start again; the old volumes were not touched |
| `password authentication failed for user "tangow"` | `POSTGRES_USER`/`POSTGRES_DB` relied on defaults | Step 2 |

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { buildComputers } from "./tangow-builds.mjs";
import {
  composeArgs,
  runMigrations,
  validateConfiguration,
  workerImage,
} from "./tangow-deployment.mjs";

export const dockerMigrationJournal = ".env.tangow.docker.json";

function readJournal(filename) {
  const state = JSON.parse(readFileSync(filename, "utf8"));
  if (
    state?.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(state.operationId) ||
    !/^[a-f0-9]{40}$/.test(state.revision) ||
    !["copying", "migrated", "configured"].includes(state.phase) ||
    typeof state.databaseSaved !== "boolean" ||
    typeof state.dataSaved !== "boolean"
  ) {
    throw new Error("Invalid Docker migration journal; retain it and inspect before retrying");
  }
  return state;
}

export async function migrateProviderToDocker({
  root,
  values,
  override,
  dock,
  run,
  git,
  sha,
  writePrivate,
  activateDocker,
  verify,
}) {
  const journal = path.join(root, dockerMigrationJournal);
  const sourceOverride = ".env.tangow.docker.source.json";
  const overridePath = path.join(root, ".env.e2b.compose.json");
  let state = existsSync(journal) ? readJournal(journal) : null;
  if (!state && !override) {
    console.log("Docker is already configured.");
    return;
  }
  if (!state && !values["migrate-existing"]) {
    throw new Error(
      "E2B migration stops computers and copies volumes. Run provider docker --migrate-existing to consent",
    );
  }
  if (git(["status", "--porcelain"]))
    throw new Error("Checkout has local changes; migrate from a clean revision");
  if (state && state.revision !== sha())
    throw new Error("Resume Docker migration from its original checkout revision");
  const target = composeArgs(root);
  const source = composeArgs(root, sourceOverride);
  const targetComp = (label, args, options) => dock(label, [...target, ...args], options);
  const sourceComp = (label, args, options) => dock(label, [...source, ...args], options);
  validateConfiguration(targetComp, "docker");
  console.log("Building Docker application, supervisor and worker images...");
  targetComp("Docker migration images", [
    "build",
    "--build-arg",
    `GIT_SHA=${sha()}`,
    "api",
    "supervisor",
    "worker-image",
  ]);
  workerImage(dock, sha());
  buildComputers({ provider: "docker", values, override: null, run, dock });
  const appImage = dock("Application image", [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    "tangow/app:local",
  ]).stdout.trim();
  const supervisorImage = dock("Supervisor image", [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    "tangow/supervisor:local",
  ]).stdout.trim();
  if (!state) {
    writePrivate(path.join(root, sourceOverride), `${JSON.stringify(override)}\n`);
    const preview = sourceComp("E2B migration preflight", [
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "api",
      "pnpm",
      "exec",
      "tsx",
      "scripts/migrate-e2b-to-docker.ts",
      "--inspect",
    ]);
    let inventory;
    try {
      inventory = JSON.parse(preview.stdout);
    } catch {
      throw new Error("Invalid E2B migration inventory; services were not stopped");
    }
    if (
      !inventory?.blockers ||
      Object.values(inventory.blockers).some((count) => typeof count !== "number" || count !== 0)
    ) {
      throw new Error(
        "Active work, control, leases, snapshot homes or maintenance prevent migration; services were not stopped",
      );
    }
    // Every journal has a usable source override, even if configuration cutover is interrupted.
    state = {
      version: 1,
      operationId: randomUUID(),
      revision: sha(),
      phase: "copying",
      databaseSaved: false,
      dataSaved: false,
    };
    writePrivate(journal, `${JSON.stringify(state)}\n`);
  }
  const backup = path.join(root, "backups", `docker-${state.operationId}`);
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  const persist = () => writePrivate(journal, `${JSON.stringify(state)}\n`);
  const docker = values.sudo ? ["sudo", "-n", "docker"] : ["docker"];
  const backupCommand = (args, stdio) => {
    const result = spawnSync(docker[0], [...docker.slice(1), ...source, ...args], {
      cwd: root,
      stdio,
    });
    if (result.error || result.status !== 0)
      throw new Error("Database backup or verification failed; services remain stopped");
  };
  try {
    // Always stop both configurations on resume, including after a failed readiness check.
    targetComp("Stop application for migration", ["stop", "api", "worker"]);
    if (!state.databaseSaved) {
      copyFileSync(path.join(root, ".env"), path.join(backup, "environment"));
      chmodSync(path.join(backup, "environment"), 0o600);
      copyFileSync(path.join(root, sourceOverride), path.join(backup, "e2b-compose.json"));
      chmodSync(path.join(backup, "e2b-compose.json"), 0o600);
      const filename = path.join(backup, "database.dump");
      const output = openSync(filename, "w", 0o600);
      try {
        backupCommand(
          [
            "exec",
            "-T",
            "postgres",
            "sh",
            "-c",
            'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc',
          ],
          ["ignore", output, "pipe"],
        );
      } finally {
        closeSync(output);
      }
      const input = openSync(filename, "r");
      try {
        backupCommand(
          ["exec", "-T", "postgres", "pg_restore", "--list"],
          [input, "ignore", "pipe"],
        );
      } finally {
        closeSync(input);
      }
      state.databaseSaved = true;
      persist();
    }
    if (!state.dataSaved) {
      const data = path.join(root, "data");
      const space = statfsSync(backup);
      const usage = run("Data size", "du", ["-sk", data]).stdout.trim().split(/\s+/)[0];
      const bytes = Number(usage) * 1024;
      if (!Number.isFinite(bytes) || space.bavail * space.bsize < bytes)
        throw new Error("Insufficient disk space for data backup");
      const archive = path.join(backup, "data.tar.gz");
      run("Persistent data backup", "tar", ["-czf", `${archive}.tmp`, "data"]);
      chmodSync(`${archive}.tmp`, 0o600);
      renameSync(`${archive}.tmp`, archive);
      state.dataSaved = true;
      persist();
    }
    if (state.phase === "copying") {
      // Applies the Docker volume constraint before adoption without starting API/worker.
      runMigrations(targetComp, dock, appImage);
      console.log("Stopping E2B computers, copying and verifying volumes...");
      const result = sourceComp(
        "E2B to Docker data migration",
        [
          "run",
          "--rm",
          "--no-deps",
          "-T",
          "api",
          "pnpm",
          "exec",
          "tsx",
          "scripts/migrate-e2b-to-docker.ts",
          "--operation",
          state.operationId,
        ],
        { allowFailure: true },
      );
      writeFileSync(
        path.join(backup, "migration.log"),
        `${result.stdout ?? ""}${result.stderr ?? ""}`,
        { mode: 0o600 },
      );
      let report;
      try {
        report = JSON.parse(result.stdout);
      } catch {
        /* A failure's details stay in the private log. */
      }
      if (result.status !== 0 || report?.outcome !== "migrated") {
        throw new Error(
          "Volume migration failed; inspect the private backup migration.log and rerun provider docker",
        );
      }
      state.phase = "migrated";
      persist();
    }
    if (state.phase === "migrated") {
      if (existsSync(overridePath))
        renameSync(overridePath, path.join(backup, "original-e2b-compose.json"));
      state.phase = "configured";
      persist();
    }
    activateDocker();
    const environment = path.join(root, ".env");
    const current = readFileSync(environment, "utf8").replace(
      /^(?:export )?AGENT_RUNTIME=(?:pi|"pi"|'pi')\s*\n?/gm,
      "",
    );
    writePrivate(
      environment,
      /^(?:export )?GIT_SHA=/m.test(current)
        ? current.replace(/^(?:export )?GIT_SHA=.*$/gm, `GIT_SHA=${state.revision}`)
        : `${current.trimEnd()}\nGIT_SHA=${state.revision}\n`,
    );
    runMigrations(targetComp, dock, appImage);
    targetComp("Start Docker services", [
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "180",
      "--pull",
      "never",
      "supervisor",
      "api",
      "worker",
      "web",
    ]);
    await verify(state.revision, {
      api: appImage,
      worker: appImage,
      web: appImage,
      supervisor: supervisorImage,
    });
    rmSync(journal);
    rmSync(path.join(root, sourceOverride));
    console.log(
      "Docker migration complete. E2B source volumes and private backups retained. Browser profiles outside bot/shared volumes are not migrated.",
    );
  } catch (error) {
    targetComp("Stop application after incomplete migration", ["stop", "api", "worker"], {
      allowFailure: true,
    });
    throw new Error(
      `${error.message} Keep the migration journal and services stopped; rerun provider docker to recover forward.`,
    );
  }
}

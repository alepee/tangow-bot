import { existsSync } from "node:fs";
import path from "node:path";

const localComposeOverride = ".env.tangow.compose.yml";

// Compose arguments for a deployed checkout. The operator's untracked local
// override, when present, is always the last file so it wins over every other.
export function composeArgs(root, ...overrides) {
  const local = existsSync(path.join(root, localComposeOverride)) ? [localComposeOverride] : [];
  return [
    "compose",
    "--env-file",
    ".env",
    ...["infra/compose/docker-compose.yml", ...overrides, ...local].flatMap((file) => ["-f", file]),
  ];
}

function report(comp, script) {
  const result = comp("Home migration inspection", [
    "run",
    "--rm",
    "--no-deps",
    "-T",
    "api",
    "pnpm",
    "exec",
    "tsx",
    script,
    "--inspect",
  ]);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(
      "Invalid home migration inventory. Services were not restarted; inspect configuration and retry.",
    );
  }
}

export function validateRuntime(comp) {
  let config;
  try {
    config = JSON.parse(comp("Compose configuration", ["config", "--format", "json"]).stdout);
  } catch {
    throw new Error(
      "Cannot resolve deployment configuration. Check private configuration before updating.",
    );
  }
  for (const service of ["api", "worker"]) {
    if (config?.services?.[service]?.environment?.AGENT_RUNTIME === "scripted")
      throw new Error(
        "AGENT_RUNTIME=scripted is reserved for tests. Real deployments require workers.",
      );
  }
  return config;
}

export function validateConfiguration(comp, provider) {
  const config = validateRuntime(comp);
  for (const service of ["api", "worker"]) {
    const env = config?.services?.[service]?.environment;
    if (!env || env.SANDBOX_PROVIDER !== provider)
      throw new Error(
        "Configure SANDBOX_PROVIDER as docker or e2b consistently for API and worker.",
      );
    if (provider === "e2b" && !env.E2B_API_KEY?.trim())
      throw new Error("E2B requires E2B_API_KEY in private deployment configuration.");
    if (provider === "docker" && !env.SANDBOX_SUPERVISOR_TOKEN?.trim())
      throw new Error(
        "Docker production requires SANDBOX_SUPERVISOR_TOKEN in private configuration.",
      );
  }
}

export function verifyExited(comp, dock, service, image) {
  const id = comp("Migration/build container lookup", ["ps", "-a", "-q", service]).stdout.trim();
  if (!id || id.includes("\n"))
    throw new Error(`${service} did not produce a completed container.`);
  const state = dock("Migration/build exit state", [
    "inspect",
    "--format",
    "{{.State.Status}} {{.State.ExitCode}} {{.Image}}",
    id,
  ]).stdout.trim();
  if (state !== `exited 0 ${image}`)
    throw new Error(
      `${service} did not complete successfully with the expected image. Inspect tangow logs ${service}; fix the failure and rerun update.`,
    );
}

export function runMigrations(comp, dock, image) {
  console.log("Running startup migrations...");
  comp("Startup migration", [
    "up",
    "-d",
    "--force-recreate",
    "--no-build",
    "--pull",
    "never",
    "migrate",
  ]);
  comp("Waiting for startup migration", ["wait", "migrate"]);
  verifyExited(comp, dock, "migrate", image);
}

export function inspectHomes(comp, provider) {
  if (provider === "e2b") {
    const inventory = report(comp, "scripts/setup-e2b-homes.ts");
    if (!Array.isArray(inventory.computers))
      throw new Error("Invalid E2B home inventory; refusing service restart.");
    if (inventory.computers.length)
      throw new Error(
        `${inventory.computers.length} home(s) still need migration from snapshots or Docker volumes. Run tangow provider e2b first; see docs/self-host-e2b-workers.md. Services were not restarted.`,
      );
    return;
  }
  const inventory = report(comp, "scripts/migrate-docker-homes.ts");
  if (!Array.isArray(inventory.deferred))
    throw new Error("Invalid Docker deferred-home inventory.");
  for (const computer of inventory.deferred)
    console.log(
      `Docker home deferred: ${JSON.stringify(computer)}. Retried when the computer suspends; retain .tangow-move-pending.`,
    );
}

export function workerImage(dock, revision) {
  const label = dock("Worker image revision", [
    "image",
    "inspect",
    "--format",
    '{{index .Config.Labels "org.opencontainers.image.revision"}}',
    "tangow/worker:local",
  ]).stdout.trim();
  if (label !== revision)
    throw new Error(
      "Worker guest image does not match the application revision. Rebuild both from the same checkout before restarting.",
    );
  return dock("Worker image", [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    "tangow/worker:local",
  ]).stdout.trim();
}

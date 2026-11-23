#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildComputers } from "./tangow-builds.mjs";
import {
  composeArgs,
  inspectHomes,
  runMigrations,
  validateConfiguration,
  verifyExited,
  workerImage,
} from "./tangow-deployment.mjs";
import { dockerMigrationJournal, migrateProviderToDocker } from "./tangow-docker.mjs";
import { help, mainOptions, services } from "./tangow-options.mjs";
import { configureSetup } from "./tangow-setup.mjs";

function writePrivate(filename, contents) {
  const temporary = `${filename}.tangow-${randomUUID()}`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
    renameSync(temporary, filename);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function main() {
  const options = mainOptions();
  if (options.help) {
    console.log(help);
    return;
  }
  const {
    values,
    positionals: [command, subcommand],
  } = options;
  const root = path.resolve(values.path ?? fileURLToPath(new URL("../", import.meta.url)));
  if (values["dry-run"]) {
    const descriptions = {
      setup:
        "collect private deployment settings; generate missing secrets; build the current checkout without fetching or switching branches; start and verify services; optionally continue through existing E2B setup",
      update:
        "fetch origin/main; fast-forward a clean checkout to main; detect the private provider configuration; build the application and Docker worker/computer/supervisor or E2B worker/desktop templates; restart services; verify readiness",
      restart: "restart api/worker/web with the existing E2B override and verify readiness",
      status: "read application health, checkout revision and Compose service states",
      logs: `read ${subcommand ?? "api"} logs`,
      cleanup: "prune unused Docker build cache and images; retain containers and volumes",
      computers:
        "build the computer image and, on E2B, push it and rebuild worker/desktop templates",
      provider:
        subcommand === "e2b"
          ? "run existing E2B setup, backups and resumable home migration"
          : "back up deployment; stop E2B computers; copy and verify bot/shared volumes; switch to Docker with resumable recovery",
    };
    console.log(`Dry run: ${descriptions[command]}. No files, commands or services changed.`);
    return;
  }
  if (
    (command !== "setup" && !existsSync(path.join(root, ".env"))) ||
    !existsSync(path.join(root, "infra/compose/docker-compose.yml"))
  )
    throw new Error(
      "Use --path with a deployed source checkout containing .env and infra/compose/docker-compose.yml.",
    );
  const configPath = path.join(root, ".env.tangow.json");
  let config = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      throw new Error(
        "Cannot read .env.tangow.json. Keep valid JSON readable by the deployment owner.",
      );
    }
    if (
      !config ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      Object.keys(config).some((key) => !["sudo", "computerImage"].includes(key)) ||
      (config.sudo !== undefined && typeof config.sudo !== "boolean") ||
      (config.computerImage !== undefined && typeof config.computerImage !== "string")
    )
      throw new Error(
        "Private Tangow config accepts only sudo (boolean) and computerImage (registry/repository:tag).",
      );
  }
  values.sudo ??= config.sudo ?? false;
  values["computer-image"] ??= config.computerImage;
  if (
    values["computer-image"] &&
    (!values["computer-image"].includes("/") ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*:[a-zA-Z0-9_.-]+$/.test(values["computer-image"]))
  )
    throw new Error("Configure computerImage as registry/repository:tag in .env.tangow.json.");
  const overridePath = path.join(root, ".env.e2b.compose.json");
  let override = null;
  if (existsSync(overridePath)) {
    try {
      let contents;
      try {
        contents = readFileSync(overridePath, "utf8");
      } catch (error) {
        if (error.code !== "EACCES" || !values.sudo) throw error;
        const result = spawnSync("sudo", ["-n", "cat", overridePath], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (result.error || result.status !== 0)
          throw new Error("Cannot read private override with sudo.");
        contents = result.stdout;
      }
      override = JSON.parse(contents);
    } catch {
      throw new Error(
        "Cannot read a valid private E2B override. Use --sudo for a root-owned override; otherwise check its JSON.",
      );
    }
    if (
      override?.services?.api?.environment?.SANDBOX_PROVIDER !== "e2b" ||
      override?.services?.worker?.environment?.SANDBOX_PROVIDER !== "e2b"
    )
      throw new Error("Private E2B override must configure both api and worker for E2B.");
  }
  let provider = override ? "e2b" : "docker";
  const docker = values.sudo ? ["sudo", "-n", "docker"] : ["docker"];
  const compose = override ? composeArgs(root, ".env.e2b.compose.json") : composeArgs(root);
  const run = (
    label,
    executable,
    args,
    { env = process.env, inherit = false, allowFailure = false } = {},
  ) => {
    const result = spawnSync(executable, args, {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (!allowFailure && (result.error || result.status !== 0))
      throw new Error(
        `${label} failed. Check tool access and configuration; use tangow logs for application errors. Template publication is not rolled back; rerun the operation after fixing the error.`,
      );
    return result;
  };
  const dock = (label, args, options) =>
    run(label, docker[0], [...docker.slice(1), ...args], options);
  const comp = (label, args, options) => dock(label, [...compose, ...args], options);
  const git = (args, options) => run("Git", "git", args, options).stdout?.trim();
  const sha = () => git(["rev-parse", "HEAD"]);
  const readHealth = () => {
    const script = `const r=await fetch('http://127.0.0.1:3100/health',{signal:AbortSignal.timeout(5000)});if(!r.ok)process.exit(1);const b=await r.json();console.log(JSON.stringify({ok:b.ok,revision:b.revision,sandbox:b.sandbox}));`;
    const result = comp(
      "API health",
      ["exec", "-T", "api", "node", "--input-type=module", "-e", script],
      { allowFailure: true },
    );
    if (result.status !== 0) return null;
    try {
      return JSON.parse(result.stdout);
    } catch {
      return null;
    }
  };
  const verify = async (expectedSha, expectedImages) => {
    console.log("Checking running revision, provider, images and web readiness...");
    for (let attempt = 0; attempt < 30; attempt++) {
      const health = readHealth();
      if (health?.ok && health.revision === expectedSha && health.sandbox === provider) {
        const web = comp(
          "Web readiness",
          [
            "exec",
            "-T",
            "web",
            "node",
            "-e",
            "fetch('http://127.0.0.1:5173',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
          ],
          { allowFailure: true },
        );

        let ready = web.status === 0;
        for (const [service, image] of Object.entries(expectedImages)) {
          const id = comp("Service lookup", ["ps", "-q", service]).stdout.trim();
          if (!id || id.includes("\n")) {
            ready = false;
            continue;
          }
          const state = dock("Service state", [
            "inspect",
            "--format",
            "{{.Image}} {{.State.Running}} {{.RestartCount}}",
            id,
          ]).stdout.trim();
          if (state !== `${image} true 0`) ready = false;
        }
        if (ready) {
          console.log(
            `Ready: ${expectedSha} (${provider}). API, worker and web use the built image.`,
          );
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(
      "Readiness failed: revision, provider, service image or web did not match. Inspect tangow status and tangow logs; no rollback was attempted.",
    );
  };
  if (command === "status") {
    const health = readHealth();
    console.log(`Checkout: ${sha()}`);
    console.log(`Configured provider: ${provider}`);
    console.log(
      health?.ok
        ? `Running: ${health.revision ?? "unknown"} (${health.sandbox})`
        : "API unavailable",
    );
    const format = "table {{.Service}}\t{{.State}}";
    console.log(comp("Service status", ["ps", "-a", "--format", format]).stdout.trim());
    if (!health?.ok) process.exitCode = 1;
    return;
  }
  if (command === "logs") {
    comp(
      "Logs",
      ["logs", "--tail", "100", ...(values.follow ? ["--follow"] : []), subcommand ?? "api"],
      { inherit: true },
    );
    return;
  }
  const toDocker = command === "provider" && subcommand === "docker";
  if (!toDocker && existsSync(path.join(root, dockerMigrationJournal)))
    throw new Error(
      "A Docker provider migration is incomplete. Keep services stopped and rerun provider docker to resume.",
    );
  if (command === "cleanup" && !values.yes)
    throw new Error(
      "Run cleanup --dry-run to inspect, then cleanup --yes to remove unused cache and images.",
    );
  const setup = command === "provider" && subcommand === "e2b";
  if (existsSync(path.join(root, ".env.e2b.setup.lock")))
    throw new Error(
      "An E2B setup lock exists. Finish setup or inspect its stale lock before continuing.",
    );
  if (!setup && existsSync(path.join(root, ".env.e2b.upgrade.json")))
    throw new Error(
      "An E2B home migration is incomplete. Rerun provider e2b to resume; services must remain stopped.",
    );
  const lock = path.join(root, ".env.tangow.lock");
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch {
    throw new Error(
      "Tangow is locked. Finish the other operation, or inspect .env.tangow.lock before removing a stale lock.",
    );
  }
  const release = () => rmSync(lock, { force: true });
  process.once("exit", release);
  try {
    const initial =
      command === "setup"
        ? await configureSetup({ root, values, provider, run, dock, git, writePrivate })
        : null;
    if (initial) {
      writePrivate(
        configPath,
        `${JSON.stringify({ ...config, sudo: values.sudo, ...(values["computer-image"] ? { computerImage: values["computer-image"] } : {}) }, null, 2)}\n`,
      );
    }
    if (toDocker) {
      await migrateProviderToDocker({
        root,
        values,
        override,
        dock,
        run,
        git,
        sha,
        writePrivate,
        verify,
        activateDocker() {
          provider = "docker";
          compose.splice(0, compose.length, ...composeArgs(root));
        },
      });
      return;
    }
    const needsComputers = command === "computers" || command === "update" || command === "setup";
    if ((setup || (needsComputers && provider === "e2b")) && !values["computer-image"]) {
      const image = dock(
        "Existing computer image lookup",
        ["image", "inspect", "--format", "{{json .RepoDigests}}", "tangow/computer:local"],
        { allowFailure: true },
      );
      let digests = [];
      try {
        digests = JSON.parse(image.stdout);
      } catch {
        /* An explicit image can configure a new registry. */
      }
      const digest = Array.isArray(digests)
        ? digests.find(
            (value) =>
              typeof value === "string" &&
              /^[a-zA-Z0-9][a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}$/.test(value),
          )
        : null;
      if (!digest)
        throw new Error(
          "Set computerImage in .env.tangow.json or pass --computer-image registry/repository:tag; no pushable existing computer image was found.",
        );
      values["computer-image"] = `${digest.split("@")[0]}:local`;
    }
    if (setup) {
      run(
        "E2B setup",
        process.execPath,
        [
          "infra/compose/setup-e2b.mjs",
          "--computer-image",
          values["computer-image"],
          ...(values.sudo ? ["--sudo"] : []),
          ...(values["migrate-existing"] ? ["--migrate-existing"] : []),
        ],
        { inherit: true },
      );
      writePrivate(
        configPath,
        `${JSON.stringify({ ...config, sudo: values.sudo, computerImage: values["computer-image"] }, null, 2)}\n`,
      );
      return;
    }
    if (command === "cleanup") {
      console.log("Pruning unused build cache...");
      dock("Build cache cleanup", ["builder", "prune", "--all", "--force"]);
      console.log("Pruning unused images...");
      dock("Image cleanup", ["image", "prune", "--all", "--force"]);
      console.log("Cleanup complete. Containers and volumes retained.");
      return;
    }
    if (command === "computers") {
      if (git(["status", "--porcelain"]))
        throw new Error(
          "Checkout has local changes. Build templates from a clean deployed revision.",
        );
      {
        const health = readHealth();
        const id = comp("Worker lookup", ["ps", "-q", "worker"]).stdout.trim();
        const workerRevision = id
          ? dock("Worker revision", [
              "inspect",
              "--format",
              '{{range .Config.Env}}{{if eq (index (split . "=") 0) "GIT_SHA"}}{{index (split . "=") 1}}{{end}}{{end}}',
              id,
            ]).stdout.trim()
          : null;
        if (
          !health?.ok ||
          health.sandbox !== provider ||
          health.revision !== sha() ||
          workerRevision !== sha()
        )
          throw new Error(
            "Template source must match the running API and worker revision. Use update to deploy a new revision.",
          );
      }
      validateConfiguration(comp, provider);
      if (provider === "docker") {
        comp("Worker image build", ["build", "--build-arg", `GIT_SHA=${sha()}`, "worker-image"]);
        workerImage(dock, sha());
      }
      buildComputers({ provider, values, override, run, dock });
      return;
    }
    if (command === "update" || command === "setup") {
      validateConfiguration(comp, provider);
      let target = sha();
      if (command === "update") {
        console.log("Checking checkout and fetching origin/main...");
        if (git(["status", "--porcelain"]))
          throw new Error("Checkout has local changes. Commit or move them before updating.");
        git(["fetch", "origin", "main"]);
        target = git(["rev-parse", "origin/main"]);
        const ancestor = run(
          "Fast-forward check",
          "git",
          ["merge-base", "--is-ancestor", "HEAD", target],
          { allowFailure: true },
        );
        const mainExists = run(
          "Main branch lookup",
          "git",
          ["rev-parse", "--verify", "refs/heads/main"],
          { allowFailure: true },
        );
        const mainAncestor =
          mainExists.status === 0
            ? run(
                "Main fast-forward check",
                "git",
                ["merge-base", "--is-ancestor", "main", target],
                {
                  allowFailure: true,
                },
              )
            : { status: 0 };
        if (ancestor.status !== 0 || mainAncestor.status !== 0)
          throw new Error(
            "Checkout or main has commits outside origin/main. Resolve them manually; Tangow never resets history.",
          );
        git(["switch", "main"]);
        git(["merge", "--ff-only", "origin/main"]);
      }
      console.log(`Building application ${target}...`);
      comp("Application build (running services have not been restarted)", [
        "build",
        "--build-arg",
        `GIT_SHA=${target}`,
        "api",
        ...(provider === "docker" ? ["supervisor", "worker-image"] : []),
      ]);
      const appImage = dock("Application image", [
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        "tangow/app:local",
      ]).stdout.trim();
      const expectedImages = Object.fromEntries(services.map((service) => [service, appImage]));
      if (provider === "docker")
        expectedImages.supervisor = dock("Supervisor image", [
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          "tangow/supervisor:local",
        ]).stdout.trim();
      const filename = path.join(root, ".env");
      const original = readFileSync(filename, "utf8");
      const cleaned = original.replace(/^(?:export )?AGENT_RUNTIME=(?:pi|"pi"|'pi')\s*\n?/gm, "");
      const replacement = cleaned.replace(/^(?:export )?GIT_SHA=.*$/gm, `GIT_SHA=${target}`);
      const next =
        replacement === cleaned && !/^(?:export )?GIT_SHA=/m.test(cleaned)
          ? `${cleaned.trimEnd()}\nGIT_SHA=${target}\n`
          : replacement;
      writePrivate(filename, next);
      const guestImage = provider === "docker" ? workerImage(dock, target) : null;
      if (initial) comp("Database and data-init image download", ["pull", "postgres", "data-init"]);
      runMigrations(comp, dock, appImage);
      if (provider === "e2b") inspectHomes(comp, provider);
      buildComputers({ provider, values, override, run, dock });
      if (initial && !initial.loopback) {
        comp("Public signup policy", [
          "run",
          "--rm",
          "--no-deps",
          "-T",
          "api",
          "pnpm",
          "exec",
          "tsx",
          "scripts/tangow-signup-policy.mjs",
        ]);
      }
      console.log("Starting application services...");
      comp("Application start", [
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "180",
        "--pull",
        "never",
        ...services,
        ...(provider === "docker" ? ["supervisor"] : []),
      ]);
      verifyExited(comp, dock, "migrate", appImage);
      if (guestImage) verifyExited(comp, dock, "worker-image", guestImage);
      await verify(target, expectedImages);
      if (provider === "docker") inspectHomes(comp, provider);
      if (initial) {
        if (initial.selectedProvider === "e2b" && provider === "docker") {
          run("E2B build dependencies", "pnpm", ["install", "--frozen-lockfile"], {
            env: {
              ...process.env,
              CI: "true",
              ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
              PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
            },
          });
          run(
            "E2B setup",
            process.execPath,
            [
              "infra/compose/setup-e2b.mjs",
              "--computer-image",
              values["computer-image"],
              ...(values.sudo ? ["--sudo"] : []),
            ],
            { inherit: true },
          );
          provider = "e2b";
          compose.splice(0, compose.length, ...composeArgs(root, ".env.e2b.compose.json"));
          delete expectedImages.supervisor;
          await verify(target, expectedImages);
        }
        if (!initial.loopback) {
          run(
            "Public web reachability (check DNS and your HTTPS reverse proxy)",
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `const r=await fetch(${JSON.stringify(initial.origin)}, {signal:AbortSignal.timeout(10000)}); if(!r.ok)process.exit(1);`,
            ],
          );
        }
        console.log(
          `Open ${initial.origin}. ${initial.deployed ? "Sign in to your account" : "Create your first owner account"} and connect a model.`,
        );
        console.log(
          "Service readiness is verified. After connecting a model, send a bot a message to verify a real run.",
        );
      } else {
        console.log(
          `Updated application and ${provider === "e2b" ? "E2B templates" : "Docker worker/computer/supervisor images"}. Existing computers can be updated from Settings > Computer.`,
        );
      }
    } else {
      validateConfiguration(comp, provider);
      if (provider === "e2b") inspectHomes(comp, provider);
      const running = readHealth();
      if (!running?.revision)
        throw new Error(
          "Cannot determine the running revision. Use update to build and start the checkout revision.",
        );
      const expectedImages = {};
      for (const service of services) {
        const id = comp("Service lookup", ["ps", "-q", service]).stdout.trim();
        if (!id || id.includes("\n"))
          throw new Error("Application service is missing. Use update to deploy the stack.");
        expectedImages[service] = dock("Running application image", [
          "inspect",
          "--format",
          "{{.Image}}",
          id,
        ]).stdout.trim();
      }
      console.log("Restarting application services...");
      comp("Application restart", ["restart", ...services]);
      await verify(running.revision, expectedImages);
    }
  } finally {
    process.removeListener("exit", release);
    release();
  }
}

main().catch((error) => {
  // Parse errors may contain arguments. Never echo arbitrary values or child stderr.
  console.error(
    `Tangow: ${error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || error.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" ? "Invalid option. Run tangow --help." : error.message}`,
  );
  process.exitCode = 1;
});

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Docker from "dockerode";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertVolumeSubpathSupport,
  COMPUTER_IMAGE,
  computerHomeStorage,
  computerNetworkNameFor,
  computerNetworkNamesForCleanup,
  computerVolumeHome,
  computerWorkspace,
  containerCreateOptions,
  containerNameFor,
  controlPortPublicationMatches,
  homeVolumeMatches,
  hostComputerUser,
  legacyNetworkOwnedSolelyBy,
  parseMemoryBytes,
  publishedLoopbackControlHostPort,
  resolveComputerControlEndpoint,
  resolveScreenNetworkMode,
  resolveScreenPublishTarget,
  resolveSpaceComputerLimit,
  resolveTeamScreenLimit,
  screenPorts,
  screenUrlFor,
  screenUrlWithToken,
  volumeHomeMatches,
  WORKER_NETWORK,
  workerCreateOptions,
  workerMounts,
  xdotoolCommand,
} from "./computer-spec.js";

describe("graphical computer spec", () => {
  it("binds the embed WebSocket path to the current screen capability", () => {
    const url = new URL(screenUrlWithToken("http://screen.test:6080/embed.html", "current-token"));
    expect(url.pathname).toBe("/embed.html");
    expect(url.searchParams.get("path")).toBe("websockify?token=current-token");
  });

  it("has no small default cap and accepts optional operator limits", () => {
    expect(resolveTeamScreenLimit(undefined)).toBeGreaterThan(1000);
    expect(resolveTeamScreenLimit("0")).toBe(resolveTeamScreenLimit(undefined));
    expect(resolveTeamScreenLimit("1000")).toBe(1000);
    expect(resolveTeamScreenLimit("4")).toBe(4);
    for (const value of ["-1", "1.5", "not-a-number"])
      expect(() => resolveTeamScreenLimit(value)).toThrow(/positive integer/);
  });

  it("validates space computer limit", () => {
    expect(resolveSpaceComputerLimit(undefined)).toBe(0);
    expect(resolveSpaceComputerLimit("")).toBe(0);
    expect(resolveSpaceComputerLimit("0")).toBe(0);
    expect(resolveSpaceComputerLimit("unlimited")).toBe(0);
    expect(resolveSpaceComputerLimit("none")).toBe(0);
    expect(resolveSpaceComputerLimit("10")).toBe(10);
    expect(resolveSpaceComputerLimit("1")).toBe(1);
    for (const value of ["-1", "1.5", "not-a-number"])
      expect(() => resolveSpaceComputerLimit(value)).toThrow(/positive integer/);
  });

  it("creates a VNC desktop, not an alpine sleep fallback", () => {
    const options = containerCreateOptions({
      name: "tangow-bot-abc",
      image: COMPUTER_IMAGE,
      botId: "abc",
      spaceId: "ws",
      homePath: "/var/tangow/homes/abc",
      networkMode: "tangow_default",
    });
    expect(options.Image).toBe("tangow/computer:local");
    expect(options.Image).not.toMatch(/alpine/);
    expect(options).not.toHaveProperty("Entrypoint");
    expect(JSON.stringify(options)).not.toMatch(/sleep/);
    expect(options.HostConfig.Binds).toEqual(["/var/tangow/homes/abc:/home/tangow"]);
    expect(options.Env).toContain(
      "PATH=/home/tangow/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
    expect(options.Env).toContain("NPM_CONFIG_PREFIX=/home/tangow/.local");
    expect(options.Env?.join("\n")).not.toMatch(/AXIOM_|LOG_LEVEL|LOG_FORMAT/);
    expect(options.ExposedPorts).toEqual({ "6080/tcp": {} });
    // Browser debugging stays inside the computer trust boundary.
    for (let index = 0; index < 1000; index += 1) {
      const cdpPort = `${screenPorts(index).debugPort}/tcp`;
      expect(options.ExposedPorts).not.toHaveProperty(cdpPort);
      expect(options.HostConfig.PortBindings).not.toHaveProperty(cdpPort);
    }
    expect(options.ExposedPorts).not.toHaveProperty("7070/tcp");
    expect(options.HostConfig.PortBindings).not.toHaveProperty("7070/tcp");
    expect(options.HostConfig.PortBindings["6080/tcp"]?.[0]?.HostIp).toBe("127.0.0.1");
    expect(options.HostConfig.PortBindings).not.toHaveProperty("6081/tcp");
    expect(options.HostConfig.PortBindings).not.toHaveProperty("6082/tcp");
    expect(screenPorts(0)).toMatchObject({ display: ":1", viewPort: "6080", controlPort: "6080" });
    expect(screenPorts(1)).toMatchObject({ display: ":2", viewPort: "6080", controlPort: "6080" });
    expect(options.HostConfig.ShmSize).toBeGreaterThanOrEqual(256 * 1024 * 1024);
    expect(options.User).toBe("1000:1000");
    expect(options.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(options.HostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(options.HostConfig.PidsLimit).toBe(2048);
    expect(options.HostConfig.ReadonlyPaths).toContain("/usr/share/novnc");
    expect(options.HostConfig.NetworkMode).toBe("tangow_default");
  });

  it("appends read-only skills binds after the home bind", () => {
    const options = containerCreateOptions({
      name: "tangow-bot-abc",
      image: COMPUTER_IMAGE,
      botId: "abc",
      spaceId: "ws",
      homePath: "/var/tangow/homes/abc",
      skillsBinds: ["/var/tangow/skills/user/s/u:/skills/user:ro"],
    });
    expect(options.HostConfig.Binds).toEqual([
      "/var/tangow/homes/abc:/home/tangow",
      "/var/tangow/skills/user/s/u:/skills/user:ro",
    ]);
  });

  it("still publishes host ports when NetworkMode is a per-bot isolated network", () => {
    const networkMode = computerNetworkNameFor("bot_isolation");
    const options = containerCreateOptions({
      name: containerNameFor("bot_isolation"),
      image: COMPUTER_IMAGE,
      botId: "bot_isolation",
      spaceId: "ws",
      homePath: "/var/tangow/homes/bot_isolation",
      networkMode,
    });
    expect(networkMode).toMatch(/^tangow-computer-bot_isolation-[0-9a-f]{32}$/);
    expect(options.HostConfig.NetworkMode).toBe(networkMode);
    expect(options.HostConfig.PortBindings["6080/tcp"]).toEqual([
      { HostIp: "127.0.0.1", HostPort: "0" },
    ]);
    expect(options.ExposedPorts["6080/tcp"]).toEqual({});
  });

  it("keeps sanitized network names unique when botIds only differ by stripped characters", () => {
    expect(computerNetworkNameFor("a/b")).not.toBe(computerNetworkNameFor("ab"));
    expect(computerNetworkNameFor("a/b")).toBe(computerNetworkNameFor("a/b"));
  });

  it("lists prior network name variants for cleanup", () => {
    const names = computerNetworkNamesForCleanup("bot_1");
    expect(names[0]).toBe(computerNetworkNameFor("bot_1"));
    expect(names).toContain("tangow-computer-bot_1");
    expect(names.some((name) => /-[0-9a-f]{8}$/.test(name))).toBe(true);
    expect(names.some((name) => /-[0-9a-f]{32}$/.test(name))).toBe(true);
  });

  it("skips legacy network removal when another bot is still attached", () => {
    expect(legacyNetworkOwnedSolelyBy("a/b", ["a/b", "a/b"])).toBe(true);
    expect(legacyNetworkOwnedSolelyBy("a/b", ["a/b", undefined])).toBe(false);
    expect(legacyNetworkOwnedSolelyBy("a/b", ["a/b", "ab"])).toBe(false);
    expect(legacyNetworkOwnedSolelyBy("ab", [undefined, undefined])).toBe(false);
  });

  it("ships a browser desktop, not a fullscreen terminal", () => {
    const root = path.resolve(import.meta.dirname, "../../computer");
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
    const start = readFileSync(path.join(root, "start.sh"), "utf8");
    const browser = readFileSync(path.join(root, "tangow-browser"), "utf8");
    const desktop = readFileSync(path.join(root, "tangow-browser.desktop"), "utf8");
    expect(dockerfile).toMatch(/google-chrome-stable/);
    expect(dockerfile).toMatch(/tangow-browser\.desktop/);
    expect(dockerfile).toMatch(/control.py/);
    expect(dockerfile).toMatch(/USER 1000:1000/);
    expect(start).toMatch(/tangow-computer-control/);
    expect(start).toMatch(/tangow-browser/);
    expect(start).not.toMatch(/browser\.log/);
    expect(start).toMatch(/xdg-mime default tangow-browser\.desktop/);
    expect(start).toMatch(/register_browser_handler x-scheme-handler\/http/);
    expect(start).toMatch(/register_browser_handler x-scheme-handler\/https/);
    expect(start).toMatch(/register_browser_handler text\/html/);
    expect(start).toMatch(/xdg-mime query default/);
    expect(start).toMatch(/failed to register tangow-browser/);
    expect(start).toMatch(/failed to set default web browser/);
    expect(start).toMatch(/xdg-settings set default-web-browser tangow-browser\.desktop/);
    expect(start).toMatch(/register_handler pcmanfm\.desktop inode\/directory/);
    expect(start).toMatch(/register_handler libreoffice-writer\.desktop/);
    expect(start).toMatch(/register_handler libreoffice-calc\.desktop/);
    expect(start).toMatch(/register_handler libreoffice-impress\.desktop/);
    expect(start).toMatch(/-f "\/usr\/share\/applications\/\$desktop"/);
    expect(start).toMatch(/failed to register \$desktop/);
    expect(dockerfile).toMatch(/UserInstallation=file:\/\/\/tmp\//);
    expect(start).not.toMatch(/xdg-mime default tangow-browser\.desktop .*\|\| true/);
    expect(start).toMatch(/x11vnc .* -viewonly /);
    expect(browser).toMatch(/\.browser-profiles\/chrome"/);
    expect(browser).toMatch(/chrome-screen-\$DISPLAY_NUM/);
    expect(browser).toMatch(/USER_DATA_DIR_SET/);
    expect(browser).toMatch(/TANGOW_BROWSER_PROFILE/);
    expect(desktop).toMatch(/Exec=\/usr\/local\/bin\/tangow-browser %U/);
    const terminal = readFileSync(path.join(root, "tangow-terminal"), "utf8");
    const menu = readFileSync(path.join(root, "fluxbox.menu"), "utf8");
    expect(dockerfile).toMatch(/xfce4-terminal/);
    expect(dockerfile).not.toMatch(/^\s+xterm \\$/m);
    expect(dockerfile).toMatch(/--shell \/bin\/zsh tangow/);
    expect(terminal).toMatch(/exec xfce4-terminal --disable-server$/m);
    expect(menu).toMatch(/\(Terminal\) \{tangow-terminal\}/);
    expect(start).toMatch(/source \/etc\/tangow\/zshrc/);
    expect(dockerfile).toMatch(/tangow-page-browser/);
    expect(browser).toMatch(/remote-debugging-port/);
    expect(desktop).toMatch(/x-scheme-handler\/http/);
    expect(desktop).toMatch(/x-scheme-handler\/https/);
    expect(start).not.toMatch(/windowsize 1280 800/);
  });

  it("ships developer tooling with a verified Node and gh as git's GitHub credential helper", () => {
    const root = path.resolve(import.meta.dirname, "../../computer");
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
    for (const pkg of ["git", "gh", "build-essential", "python3-venv", "ripgrep"]) {
      expect(dockerfile).toMatch(new RegExp(`^\\s+${pkg} \\\\$`, "m"));
    }
    expect(dockerfile).toMatch(/signed-by=\/usr\/share\/keyrings\/githubcli-archive-keyring\.gpg/);
    expect(dockerfile).toMatch(/sha256sum -c -/);
    expect(dockerfile).toMatch(/NODE_SHA256_AMD64=[0-9a-f]{64}/);
    expect(dockerfile).toMatch(/NODE_SHA256_ARM64=[0-9a-f]{64}/);
    expect(dockerfile).toMatch(
      /credential\.https:\/\/github\.com\.helper '!\/usr\/bin\/gh auth git-credential'/,
    );
    // Tooling installs as root before the image drops to the unprivileged user.
    expect(dockerfile.indexOf("gh auth git-credential")).toBeLessThan(
      dockerfile.indexOf("USER 1000:1000"),
    );
  });

  it.skipIf(process.platform === "win32")(
    "selects a display-specific browser profile and preserves explicit profiles",
    () => {
      const root = path.resolve(import.meta.dirname, "../../computer");
      const temp = mkdtempSync(path.join(tmpdir(), "tangow-browser-wrapper-"));
      const bin = path.join(temp, "bin");
      const capture = path.join(temp, "args");
      const home = path.join(temp, "home");
      const chrome = path.join(bin, "google-chrome-stable");
      mkdirSync(bin);
      writeFileSync(chrome, '#!/bin/sh\nprintf "%s\\n" "$@" > "$TANGOW_TEST_ARGS"\n');
      chmodSync(chrome, 0o755);

      const run = (display: string, args: string[] = []) => {
        const result = spawnSync("sh", [path.join(root, "tangow-browser"), ...args], {
          env: {
            ...process.env,
            DISPLAY: display,
            HOME: home,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            TANGOW_TEST_ARGS: capture,
          },
          encoding: "utf8",
        });
        expect(result.status, result.error?.message ?? result.stderr).toBe(0);
        return readFileSync(capture, "utf8").trim().split(/\r?\n/);
      };

      try {
        expect(run(":1")).toContain(`--user-data-dir=${home}/.browser-profiles/chrome`);
        expect(run(":1")).toContain("--restore-last-session");
        expect(run(":1").some((arg) => arg.startsWith("--remote-debugging-port="))).toBe(true);
        expect(run(":2")).toContain(`--user-data-dir=${home}/.browser-profiles/chrome-screen-2`);
        expect(run(":2")).toContain("--remote-debugging-port=9223");
        for (const display of [8, 9]) {
          const args = run(`:0${display}.0`);
          expect(args).toContain(`--remote-debugging-port=${9221 + display}`);
          expect(args).toContain(
            `--user-data-dir=${home}/.browser-profiles/chrome-screen-${display}`,
          );
        }
        const explicit = run(":3", [`--user-data-dir=${home}/custom-profile`]);
        expect(explicit).toContain(`--user-data-dir=${home}/custom-profile`);
        expect(explicit).toContain("--restore-last-session");
        expect(explicit).not.toContain(`--user-data-dir=${home}/.browser-profiles/chrome-screen-3`);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "clears crashed state from Chromium preferences and Local State",
    () => {
      const root = path.resolve(import.meta.dirname, "../../computer");
      const temp = mkdtempSync(path.join(tmpdir(), "tangow-browser-crash-"));
      const bin = path.join(temp, "bin");
      const home = path.join(temp, "home");
      const chrome = path.join(bin, "google-chrome-stable");
      const capture = path.join(temp, "args");
      mkdirSync(bin);
      writeFileSync(chrome, '#!/bin/sh\nprintf "%s\\n" "$@" > "$TANGOW_TEST_ARGS"\n');
      chmodSync(chrome, 0o755);

      const profile = path.join(home, ".browser-profiles/chrome");
      const prefsDir = path.join(profile, "Default");
      mkdirSync(prefsDir, { recursive: true });
      const prefsPath = path.join(prefsDir, "Preferences");
      const localStatePath = path.join(profile, "Local State");
      writeFileSync(
        prefsPath,
        '{\n  "profile": {\n    "exit_type": "Crashed",\n    "exited_cleanly": false\n  }\n}\n',
      );
      writeFileSync(localStatePath, '{\n  "profile": {\n    "exited_cleanly": false\n  }\n}\n');

      try {
        const result = spawnSync("bash", [path.join(root, "tangow-browser")], {
          env: {
            ...process.env,
            DISPLAY: ":1",
            HOME: home,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            TANGOW_TEST_ARGS: capture,
          },
          encoding: "utf8",
        });
        expect(result.status, result.error?.message ?? result.stderr).toBe(0);

        const flags = readFileSync(capture, "utf8");
        expect(flags).toMatch(/--hide-crash-restore-bubble/);
        expect(flags).toMatch(/--disable-session-crashed-bubble/);

        const updatedPrefs = readFileSync(prefsPath, "utf8");
        expect(updatedPrefs).toContain('"exit_type":"Normal"');
        expect(updatedPrefs).toContain('"exited_cleanly":true');
        expect(updatedPrefs).not.toContain("Crashed");
        expect(updatedPrefs).not.toMatch(/"exited_cleanly"\s*:\s*false/);

        const updatedLocalState = readFileSync(localStatePath, "utf8");
        expect(updatedLocalState).toContain('"exited_cleanly":true');
        expect(updatedLocalState).not.toMatch(/"exited_cleanly"\s*:\s*false/);

        writeFileSync(prefsPath, '{\n  "profile": {\n    "exit_type": "Crashed"\n  }\n}\n');
        symlinkSync("testhost-12345", path.join(profile, "SingletonLock"));
        const skipped = spawnSync("bash", [path.join(root, "tangow-browser")], {
          env: {
            ...process.env,
            DISPLAY: ":1",
            HOME: home,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            TANGOW_TEST_ARGS: capture,
          },
          encoding: "utf8",
        });
        expect(skipped.status, skipped.error?.message ?? skipped.stderr).toBe(0);
        expect(readFileSync(prefsPath, "utf8")).toContain("Crashed");
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it("keeps container names stable so a bot can resume", () => {
    expect(containerNameFor("bot_1")).toBe("tangow-bot-bot_1");
    expect(containerNameFor("bot_1")).toBe(containerNameFor("bot_1"));
  });

  it("points the screen at the chrome-less noVNC embed", () => {
    expect(screenUrlFor("16080")).toBe("http://127.0.0.1:16080/embed.html");
  });

  it("uses the published host mapping in the default topology even when a container IP exists", () => {
    // Regression: per-bot NetworkMode always yields a 172.x address. Returning
    // that to clients makes local/dev screens look dead — browsers cannot load
    // docker-internal IPs. Probe and return the host mapping instead.
    const networkMode = computerNetworkNameFor("bot_1");
    expect(
      resolveScreenPublishTarget({
        screenNetwork: "published",
        networkMode,
        networks: { [networkMode]: { IPAddress: "172.18.0.4" } },
        hostPort: "49152",
        containerPort: "6080",
      }),
    ).toEqual({ host: "127.0.0.1", port: "49152" });
    expect(
      resolveScreenPublishTarget({
        screenNetwork: "published",
        networkMode,
        networks: { [networkMode]: { IPAddress: "172.18.0.4" } },
        hostPort: undefined,
        containerPort: "6080",
      }),
    ).toBeUndefined();
  });

  it("validates the configured screen network mode", () => {
    expect(resolveScreenNetworkMode(undefined)).toBe("published");
    expect(resolveScreenNetworkMode("published")).toBe("published");
    expect(resolveScreenNetworkMode("isolated")).toBe("isolated");
    expect(() => resolveScreenNetworkMode("typo")).toThrow(/Unsupported/);
  });

  it("uses the host identity for host-run bind mounts without ever using root", () => {
    expect(hostComputerUser(501, 20)).toBe("501:20");
    expect(hostComputerUser(0, 0)).toBe("1000:1000");
  });

  it("uses the container IP only for the internal screen network topology", () => {
    const networkMode = "tangow_default";
    expect(
      resolveScreenPublishTarget({
        screenNetwork: "internal",
        networkMode,
        networks: { [networkMode]: { IPAddress: "172.18.0.4" } },
        hostPort: "49152",
        containerPort: "6080",
      }),
    ).toEqual({ host: "172.18.0.4", port: "6080" });
    expect(
      resolveScreenPublishTarget({
        screenNetwork: "isolated",
        networkMode: "tangow-computer-bot-1",
        networks: { "tangow-computer-bot-1": { IPAddress: "172.20.0.4" } },
        hostPort: "49152",
        containerPort: "6080",
      }),
    ).toEqual({ host: "172.20.0.4", port: "6080" });
  });

  it("does not publish computer control port 7070 on the host", () => {
    const options = containerCreateOptions({
      name: "tangow-bot-ctrl",
      image: COMPUTER_IMAGE,
      botId: "ctrl",
      spaceId: "ws",
      homePath: "/var/tangow/homes/ctrl",
    });
    expect(options.HostConfig.PortBindings["7070/tcp"]).toBeUndefined();
    expect(options.ExposedPorts["7070/tcp"]).toBeUndefined();
    expect(JSON.stringify(options.HostConfig.PortBindings)).not.toMatch(/7070/);
  });

  it("publishes the control port to loopback only when explicitly opted in", () => {
    const options = containerCreateOptions({
      name: "tangow-bot-ctrl",
      image: COMPUTER_IMAGE,
      botId: "ctrl",
      spaceId: "ws",
      homePath: "/var/tangow/homes/ctrl",
      publishControlPort: true,
    });
    expect(options.ExposedPorts["7070/tcp"]).toEqual({});
    expect(options.HostConfig.PortBindings["7070/tcp"]).toEqual([
      { HostIp: "127.0.0.1", HostPort: "0" },
    ]);
  });

  it("resolves computer control through the container network IP, never a host mapping", () => {
    const networkMode = "tangow_default";
    expect(
      resolveComputerControlEndpoint({
        token: "secret",
        networkMode,
        networks: { [networkMode]: { IPAddress: "172.18.0.4" } },
      }),
    ).toEqual({ url: "http://172.18.0.4:7070/v1/desktop", token: "secret" });
    expect(
      resolveComputerControlEndpoint({
        token: "secret",
        networkMode: computerNetworkNameFor("bot_1"),
        networks: { [computerNetworkNameFor("bot_1")]: { IPAddress: "172.19.0.2" } },
      }),
    ).toEqual({ url: "http://172.19.0.2:7070/v1/desktop", token: "secret" });
    expect(
      resolveComputerControlEndpoint({
        token: undefined,
        networkMode,
        networks: { [networkMode]: { IPAddress: "172.18.0.4" } },
      }),
    ).toBeUndefined();
    expect(
      resolveComputerControlEndpoint({
        token: "secret",
        networkMode,
        networks: {},
      }),
    ).toBeUndefined();
  });

  it("resolves computer control through a published loopback port when provided", () => {
    const networkMode = "tangow_default";
    expect(
      resolveComputerControlEndpoint({
        token: "secret",
        networkMode,
        networks: { [networkMode]: { IPAddress: "172.18.0.4" } },
        publishedHostPort: "55101",
      }),
    ).toEqual({ url: "http://127.0.0.1:55101/v1/desktop", token: "secret" });
    expect(
      resolveComputerControlEndpoint({
        token: undefined,
        networkMode,
        networks: { [networkMode]: { IPAddress: "172.18.0.4" } },
        publishedHostPort: "55101",
      }),
    ).toBeUndefined();
  });

  it.each([undefined, null, {}, { "7070/tcp": null }, { "7070/tcp": [] }])(
    "recreates unpublished computers only when loopback control is enabled (%j)",
    (bindings) => {
      expect(controlPortPublicationMatches(bindings, true)).toBe(false);
      expect(controlPortPublicationMatches(bindings, false)).toBe(true);
      expect(publishedLoopbackControlHostPort(bindings)).toBeUndefined();
    },
  );

  it.each(["", "0", "55101"])(
    "accepts configured loopback ports on resume, including unassigned ports (%j)",
    (HostPort) => {
      const bindings = { "7070/tcp": [{ HostIp: "127.0.0.1", HostPort }] };
      expect(controlPortPublicationMatches(bindings, true)).toBe(true);
      // Opting out must remove existing publication on the next provision.
      expect(controlPortPublicationMatches(bindings, false)).toBe(false);
      expect(publishedLoopbackControlHostPort(bindings)).toBe(
        HostPort === "55101" ? HostPort : undefined,
      );
    },
  );

  it.each(["0.0.0.0", "", "::", "192.0.2.1", undefined])(
    "rejects external control bindings even alongside loopback (%j)",
    (HostIp) => {
      const external = { HostIp, HostPort: "55100" };
      const loopback = { HostIp: "127.0.0.1", HostPort: "55101" };
      for (const entries of [[external], [external, loopback], [loopback, external]]) {
        const bindings = { "7070/tcp": entries };
        expect(controlPortPublicationMatches(bindings, true)).toBe(false);
        expect(controlPortPublicationMatches(bindings, false)).toBe(false);
        expect(publishedLoopbackControlHostPort(bindings)).toBeUndefined();
      }
    },
  );

  it.each([undefined, "-1", "65536", "abc", "55101/other", "80@192.0.2.1"])(
    "rejects invalid configured and runtime control ports (%j)",
    (HostPort) => {
      const bindings = { "7070/tcp": [{ HostIp: "127.0.0.1", HostPort }] };
      expect(controlPortPublicationMatches(bindings, true)).toBe(false);
      expect(publishedLoopbackControlHostPort(bindings)).toBeUndefined();
      expect(
        resolveComputerControlEndpoint({
          token: "test-token",
          networkMode: "bridge",
          networks: { bridge: { IPAddress: "192.0.2.1" } },
          publishedHostPort: HostPort,
          requirePublishedHostPort: true,
        }),
      ).toBeUndefined();
    },
  );

  it("does not fall back to the container IP when a published control port is required", () => {
    const networkMode = "tangow_default";
    expect(
      resolveComputerControlEndpoint({
        token: "secret",
        networkMode,
        networks: { [networkMode]: { IPAddress: "172.18.0.4" } },
        requirePublishedHostPort: true,
      }),
    ).toBeUndefined();
    expect(
      resolveComputerControlEndpoint({
        token: "secret",
        networkMode,
        networks: { [networkMode]: { IPAddress: "172.18.0.4" } },
        publishedHostPort: "55101",
        requirePublishedHostPort: true,
      }),
    ).toEqual({ url: "http://127.0.0.1:55101/v1/desktop", token: "secret" });
  });

  it("restricts computer control argv to supervisor shapes", () => {
    const controlPath = path.resolve(import.meta.dirname, "../../computer/control.py");
    const result = spawnSync(
      "python3",
      [
        "-c",
        [
          "import importlib.util",
          "import os",
          "import signal",
          "import time",
          `spec = importlib.util.spec_from_file_location('control', ${JSON.stringify(controlPath)})`,
          "module = importlib.util.module_from_spec(spec)",
          "spec.loader.exec_module(module)",
          "allow = module.allowed_control_argv",
          "long_lived = module.is_long_lived_control",
          "assert allow(['env', 'DISPLAY=:1', 'xdotool', 'key', '--clearmodifiers', 'a'], ':1')",
          "assert allow(['env', 'DISPLAY=:1', 'xdotool', 'mousemove', '--', '10', '20', 'click', '1'], ':1')",
          "assert allow(['env', 'DISPLAY=:1', 'xdotool', 'click', '--repeat', '3', '4'], ':1')",
          "assert allow(['env', 'DISPLAY=:1', 'xdotool', 'type', '--clearmodifiers', '--', 'hi'], ':1')",
          "assert allow(['env', 'DISPLAY=:2', 'xdg-open', 'https://example.com'], ':2')",
          "assert allow(['env', 'DISPLAY=:1', 'tangow-browser'], ':1')",
          "assert allow(['env', 'DISPLAY=:2', 'tangow-browser', 'https://example.com'], ':2')",
          "assert allow(['env', 'DISPLAY=:1', 'tangow-terminal'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', 'tangow-terminal', 'id'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', 'tangow-terminal', '-x'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', 'xterm'], ':1')",
          "assert allow(['env', 'DISPLAY=:1', 'pcmanfm', '/home/tangow'], ':1')",
          "assert allow(['env', 'DISPLAY=:1', 'libreoffice', '/home/tangow/report.docx'], ':1')",
          "assert long_lived(['env', 'DISPLAY=:1', 'libreoffice'])",
          "assert not allow(['env', 'DISPLAY=:1', 'libreoffice', '--accept=socket,port=2002;urp;'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', 'libreoffice', 'macro:///Standard.Module1.Main'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', 'libreoffice', 'vnd.sun.star.script:Lib.Mod.Main?language=Basic&location=application'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', 'libreoffice', 'https://example.com/x.docx'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', 'libreoffice', 'file:///etc/passwd'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', 'libreoffice', '/etc/passwd'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', 'libreoffice', '/home/tangow/../../etc/passwd'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', 'libreoffice', '/home/tangowevil/x.docx'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', 'pcmanfm', '/etc'], ':1')",
          "assert long_lived(['env', 'DISPLAY=:1', 'tangow-browser'])",
          "assert long_lived(['env', 'DISPLAY=:1', 'tangow-browser', 'https://example.com'])",
          "assert long_lived(['env', 'DISPLAY=:1', 'tangow-terminal'])",
          "assert long_lived(['env', 'DISPLAY=:1', 'xdg-open', 'https://example.com'])",
          "assert not long_lived(['env', 'DISPLAY=:1', 'xdotool', 'key', '--clearmodifiers', 'a'])",
          "assert not allow(['env', 'DISPLAY=:1', 'chromium', 'https://example.com'], ':1')",
          "assert not allow(['bash', '-c', 'id'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', 'bash', '-c', 'id'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', '/bin/sh', '-c', 'id'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', 'xdotool', 'exec', '/bin/sh', '-c', 'id'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', 'xdotool', 'key', 'a'], ':1')",
          "assert not allow(['env', 'DISPLAY=:2', 'xdotool', 'key', '--clearmodifiers', 'a'], ':1')",
          "assert not allow(['env', 'DISPLAY=wayland-0', 'xdotool', 'key', '--clearmodifiers', 'a'], ':1')",
          "assert not allow(['env', 'DISPLAY=:1', 'xdg-open', 'a', 'b'], ':1')",
          "known = set(module.KNOWN_LAUNCH)",
          "module.KNOWN_LAUNCH = frozenset({'sleep'})",
          "spawned = []",
          "real_popen = module.subprocess.Popen",
          "def tracking_popen(*args, **kwargs):",
          "  child = real_popen(*args, **kwargs)",
          "  spawned.append(child.pid)",
          "  return child",
          "module.subprocess.Popen = tracking_popen",
          "try:",
          "  started = time.monotonic()",
          "  module.run_control_argv(['env', 'DISPLAY=:1', 'sleep', '30'], ':1')",
          "  assert time.monotonic() - started < 2",
          "  assert len(spawned) == 1, 'expected one detached child'",
          "  os.kill(spawned[0], 0)",
          "  os.kill(spawned[0], signal.SIGTERM)",
          "finally:",
          "  module.subprocess.Popen = real_popen",
          "  module.KNOWN_LAUNCH = frozenset(known)",
          "try:",
          "  module.run_control_argv(['env', 'DISPLAY=:1', 'false'], ':1')",
          "  raise SystemExit('expected nonzero failure')",
          "except RuntimeError as error:",
          "  assert str(error) == 'computer action failed'",
          "timeout = module.CONTROL_TIMEOUT_SEC",
          "module.CONTROL_TIMEOUT_SEC = 0.2",
          "try:",
          "  module.run_control_argv(['env', 'DISPLAY=:1', 'sleep', '5'], ':1')",
          "  raise SystemExit('expected timeout')",
          "except RuntimeError as error:",
          "  assert str(error) == 'computer action timed out'",
          "finally:",
          "  module.CONTROL_TIMEOUT_SEC = timeout",
          "print('ok')",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });

  it("turns takeover input into xdotool", () => {
    expect(xdotoolCommand({ kind: "key", key: "Enter" })).toEqual([
      "xdotool",
      "key",
      "--clearmodifiers",
      "Return",
    ]);
    expect(xdotoolCommand({ kind: "pointer", x: 10, y: 20, type: "click" })).toEqual([
      "xdotool",
      "mousemove",
      "--",
      "10",
      "20",
      "click",
      "1",
    ]);
  });
});

describe("computer resource limits", () => {
  const KEYS = [
    "TANGOW_COMPUTER_MEMORY",
    "TANGOW_COMPUTER_CPUS",
    "TANGOW_COMPUTER_PIDS_LIMIT",
  ] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of KEYS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const createInput = {
    name: "tangow-bot-x",
    image: "tangow/computer:local",
    botId: "bot-x",
    spaceId: "ws",
    homePath: "/var/tangow/homes/bot-x",
  };

  it("caps memory and cpu by default and keeps #343's pids ceiling", () => {
    const { HostConfig } = containerCreateOptions(createInput);
    expect(HostConfig.Memory).toBe(8 * 1024 ** 3);
    expect(HostConfig.MemorySwap).toBe(HostConfig.Memory);
    expect(HostConfig.NanoCpus).toBe(4 * 1e9);
    expect(HostConfig.PidsLimit).toBe(2048);
  });

  it("pins MemorySwap to Memory so the ceiling cannot be swapped past", () => {
    process.env.TANGOW_COMPUTER_MEMORY = "1536m";
    const { HostConfig } = containerCreateOptions(createInput);
    expect(HostConfig.Memory).toBe(1536 * 1024 ** 2);
    expect(HostConfig.MemorySwap).toBe(1536 * 1024 ** 2);
  });

  it("accepts fractional CPUs", () => {
    process.env.TANGOW_COMPUTER_CPUS = "1.5";
    expect(containerCreateOptions(createInput).HostConfig.NanoCpus).toBe(1_500_000_000);
  });

  it("lets an operator opt out explicitly", () => {
    process.env.TANGOW_COMPUTER_MEMORY = "unlimited";
    process.env.TANGOW_COMPUTER_CPUS = "0";
    process.env.TANGOW_COMPUTER_PIDS_LIMIT = "none";
    const { HostConfig } = containerCreateOptions(createInput);
    expect(HostConfig.Memory).toBe(0);
    expect(HostConfig.NanoCpus).toBe(0);
    expect(HostConfig.PidsLimit).toBe(0);
  });

  it("rejects a malformed size instead of silently falling back", () => {
    process.env.TANGOW_COMPUTER_MEMORY = "2 gigs";
    expect(() => containerCreateOptions(createInput)).toThrow(/TANGOW_COMPUTER_MEMORY/);
  });

  it("rejects a negative cpu count", () => {
    process.env.TANGOW_COMPUTER_CPUS = "-1";
    expect(() => containerCreateOptions(createInput)).toThrow(/TANGOW_COMPUTER_CPUS/);
  });

  it("rejects a pids limit that is not a positive integer", () => {
    process.env.TANGOW_COMPUTER_PIDS_LIMIT = "12.5";
    expect(() => containerCreateOptions(createInput)).toThrow(/TANGOW_COMPUTER_PIDS_LIMIT/);
  });

  it("rejects a memory limit below Docker's 6 MiB minimum", () => {
    // The daemon refuses these at container creation, so accepting them here would turn a typo
    // into a 500 on the first bot rather than a startup failure naming the variable.
    for (const value of ["1", "1m", "5m", "5242880"]) {
      process.env.TANGOW_COMPUTER_MEMORY = value;
      expect(() => containerCreateOptions(createInput)).toThrow(/TANGOW_COMPUTER_MEMORY/);
    }
    process.env.TANGOW_COMPUTER_MEMORY = "6m";
    expect(containerCreateOptions(createInput).HostConfig.Memory).toBe(6 * 1024 ** 2);
  });

  it("rejects a CPU count that would floor to Docker's unlimited", () => {
    // Math.floor(1e-10 * 1e9) is 0, and 0 NanoCpus means uncapped. An accepted value must never
    // turn a ceiling into no ceiling.
    process.env.TANGOW_COMPUTER_CPUS = "0.0000000001";
    expect(() => containerCreateOptions(createInput)).toThrow(/TANGOW_COMPUTER_CPUS/);
  });

  it("rejects a CPU count that leaves the safe-integer NanoCpus range", () => {
    // 1e300 is finite, but Math.floor(1e300 * 1e9) is Infinity. 1e7 CPUs yields a non-safe
    // integer. Both must fail closed rather than reach HostConfig.NanoCpus.
    for (const value of ["1e300", "10000000"]) {
      process.env.TANGOW_COMPUTER_CPUS = value;
      expect(() => containerCreateOptions(createInput)).toThrow(/TANGOW_COMPUTER_CPUS/);
    }
  });

  it("parses byte counts without a unit suffix", () => {
    expect(parseMemoryBytes("X", "1073741824")).toBe(1024 ** 3);
  });
});

describe("computer home storage", () => {
  const runtime = (mount: object) => ({ Mounts: [mount] }) as Docker.ContainerInspectInfo;
  it("keeps named volumes native and exposes only the bot subdirectory", () => {
    const storage = computerHomeStorage(
      "/data/homes/bot",
      "/data",
      runtime({
        Type: "volume",
        Name: "example_appdata",
        Source: "/var/lib/docker/volumes/example_appdata/_data",
        Destination: "/data",
      }),
    );
    const options = containerCreateOptions({
      name: "bot",
      image: "computer",
      botId: "bot",
      spaceId: "space",
      ...storage,
    });
    expect(options.HostConfig.Binds).toBeUndefined();
    expect(options.HostConfig.Mounts).toEqual([
      {
        Type: "volume",
        Source: "example_appdata",
        Target: "/home/tangow",
        VolumeOptions: { NoCopy: true, Subpath: "homes/bot" },
      },
    ]);
    expect(homeVolumeMatches(options.HostConfig.Mounts, storage.homeVolume!)).toBe(true);
    expect(homeVolumeMatches(undefined, storage.homeVolume!)).toBe(false);
    expect(
      homeVolumeMatches(options.HostConfig.Mounts, {
        name: "example_appdata",
        subpath: "homes/other",
      }),
    ).toBe(false);
  });
  it("preserves native host paths and translates supervisor bind mounts", () => {
    expect(computerHomeStorage("/data/homes/bot", "/data", undefined)).toEqual({
      homePath: "/data/homes/bot",
    });
    expect(
      computerHomeStorage(
        "/data/homes/bot",
        "/data",
        runtime({ Type: "bind", Source: "/srv/data", Destination: "/data" }),
      ),
    ).toEqual({ homePath: "/srv/data/homes/bot" });
  });
  it("rejects paths outside the volume and missing volume names", () => {
    for (const home of ["/data", "/other", "/data/../other"])
      expect(() => computerHomeStorage(home, "/data", undefined)).toThrow();
    expect(() =>
      computerHomeStorage(
        "/data/homes/bot",
        "/data",
        runtime({ Type: "volume", Destination: "/data" }),
      ),
    ).toThrow(/no name/);
  });
  it("fails closed on daemons that could ignore volume subpaths", () => {
    for (const version of ["1.44", "", "invalid", "0.99"])
      expect(() => assertVolumeSubpathSupport(version)).toThrow(/Docker Engine 26/);
    for (const version of ["1.45", "1.46", "2.0"])
      expect(() => assertVolumeSubpathSupport(version)).not.toThrow();
  });
});

describe("docker worker spec", () => {
  const appdata = {
    Mounts: [{ Type: "volume", Name: "example_appdata", Destination: "/data" }],
  } as Docker.ContainerInspectInfo;

  it("runs a hardened, self-removing container labelled with its attempt, as its computer's user", () => {
    const options = workerCreateOptions({
      attemptId: "attempt-1",
      ttlSeconds: 600,
      mounts: [],
      user: "1001:1001",
    });
    expect(options).toMatchObject({
      Image: "tangow/worker:local",
      User: "1001:1001",
      Cmd: ["sleep", "600"],
      Labels: { "tangow.worker": "true", "tangow.attempt": "attempt-1" },
      HostConfig: {
        Init: true,
        AutoRemove: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        NetworkMode: WORKER_NETWORK,
        Memory: 1024 ** 3,
        NanoCpus: 1e9,
        PidsLimit: 2048,
      },
    });
    expect(options.HostConfig?.ReadonlyRootfs).toBeUndefined();
    expect(options.HostConfig?.Binds).toBeUndefined();
    // The capability travels with the guest's exec, never in the container's environment.
    expect(options.Env).toEqual(["HOME=/home/user"]);
  });

  it("derives mounts from volume names, as binds or as subpaths of the data volume", () => {
    const requested = [
      { volume: "tangow-private", path: "/workspace/bot", readOnly: false },
      { volume: "tangow-shared", path: "/workspace/space", readOnly: true },
    ];
    const bound = workerMounts(requested, "/data", undefined);
    expect(bound.map((mount) => mount.source)).toEqual([
      { bind: "/data/volumes/tangow-private" },
      { bind: "/data/volumes/tangow-shared" },
    ]);
    const options = workerCreateOptions({
      attemptId: "attempt-1",
      ttlSeconds: 60,
      mounts: workerMounts(requested, "/data", appdata),
      user: "1000:1000",
    });
    expect(options.HostConfig?.Mounts).toEqual([
      {
        Type: "volume",
        Source: "example_appdata",
        Target: "/workspace/bot",
        ReadOnly: false,
        VolumeOptions: { NoCopy: true, Subpath: "volumes/tangow-private" },
      },
      {
        Type: "volume",
        Source: "example_appdata",
        Target: "/workspace/space",
        ReadOnly: true,
        VolumeOptions: { NoCopy: true, Subpath: "volumes/tangow-shared" },
      },
    ]);
  });

  it("rejects volume names and targets that could escape their roots", () => {
    for (const volume of ["../homes/bot", "tangow-a/../../b", "tangow-", "homes", "tangow-a b"])
      expect(() =>
        workerMounts([{ volume, path: "/workspace/a", readOnly: false }], "/data", undefined),
      ).toThrow(/volume name/);
    for (const target of [
      "/workspace",
      "/workspace/../etc",
      "/home/user",
      "workspace/a",
      "/workspace/a/./b",
    ])
      expect(() =>
        workerMounts([{ volume: "tangow-a", path: target, readOnly: false }], "/data", undefined),
      ).toThrow(/under \/workspace/);
  });
});

describe("computer on volumes", () => {
  const team = {
    root: "/workspace",
    mounts: [
      { volume: "tangow-ada", path: "/workspace/bots/ada" },
      { volume: "tangow-space", path: "/workspace/shared" },
    ],
  };

  it("keeps its home on the home bind and mounts its volumes at the workers' paths", () => {
    const volumeHome = computerVolumeHome(team, "/data", undefined);
    const options = containerCreateOptions({
      name: "bot",
      image: "computer",
      botId: "ada",
      spaceId: "space",
      homePath: "/data/homes/team",
      volumeHome,
    });
    expect(options.HostConfig.Binds).toEqual(["/data/homes/team:/home/tangow"]);
    expect(options.HostConfig.Mounts).toEqual([
      {
        Type: "bind",
        Source: "/data/volumes/tangow-ada",
        Target: "/workspace/bots/ada",
        ReadOnly: false,
      },
      {
        Type: "bind",
        Source: "/data/volumes/tangow-space",
        Target: "/workspace/shared",
        ReadOnly: false,
      },
    ]);
    expect(options.WorkingDir).toBe("/workspace");
    expect(options.Labels).toMatchObject({
      "tangow.home": "volumes",
      "tangow.mounts": volumeHome.digest,
      "tangow.workspace": "/workspace",
    });
    expect(computerWorkspace(options.Labels)).toBe("/workspace");
    expect(volumeHomeMatches(options.Labels, volumeHome)).toBe(true);
  });

  it("is replaced once its mounts change, or when it was created before its home moved", () => {
    const volumeHome = computerVolumeHome(team, "/data", undefined);
    const added = computerVolumeHome(
      { ...team, mounts: [...team.mounts, { volume: "tangow-bob", path: "/workspace/bots/bob" }] },
      "/data",
      undefined,
    );
    const labels = { "tangow.mounts": volumeHome.digest };
    expect(volumeHomeMatches(labels, added)).toBe(false);
    expect(volumeHomeMatches({}, volumeHome)).toBe(false);
    expect(volumeHomeMatches(labels, undefined)).toBe(false);
    expect(volumeHomeMatches({}, undefined)).toBe(true);
    expect(computerWorkspace({})).toBe("/home/tangow");
  });

  it("refuses a workspace outside its volumes and volume names that could escape", () => {
    expect(() =>
      computerVolumeHome({ ...team, root: "/workspace/bots/bob" }, "/data", undefined),
    ).toThrow(/workspace/);
    expect(() =>
      computerVolumeHome(
        { root: "/workspace", mounts: [{ volume: "../homes/x", path: "/workspace/shared" }] },
        "/data",
        undefined,
      ),
    ).toThrow(/volume name/);
  });
});

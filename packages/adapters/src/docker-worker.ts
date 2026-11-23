import { lstat, mkdir, rm } from "node:fs/promises";
import http from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import type {
  AdapterDescriptor,
  HarnessDeclaration,
  WorkerCapabilities,
  WorkerProvider,
  WorkerSpec,
} from "@tangow/adapter-kit";
import { WorkerEnsureSettledError, workerHarness } from "@tangow/adapter-kit";
import { getLogger } from "@tangow/logging";
import type { FrameChannel } from "./runtime-worker/framing.js";
import { streamChannel } from "./runtime-worker/framing.js";
import type { GuestConnector } from "./runtime-worker/launcher.js";
import { WORKER_LIMITS } from "./runtime-worker/limits.js";

/**
 * `ensure` stops asking the supervisor for a worker this long before the shared ensure deadline,
 * so a create the supervisor accepted lands and is labelled before a release trusts `absent`.
 */
export const DOCKER_CREATE_MARGIN_MS = 60_000;

const VOLUME_NAME = /^tangow-[A-Za-z0-9_-]{1,64}$/;
/** What undici reports when the supervisor closed a pooled keep-alive connection under a request. */
const RESET_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);

export interface DockerWorkerConfig {
  /** The supervisor's base URL. */
  supervisorUrl: string;
  supervisorToken: string;
  /** The `DATA_DIR` this service shares with the supervisor; volumes live under `volumes/`. */
  dataDir: string;
  /** The harness the guest runs, by the name it registers. */
  harness?: string;
}

function isConnectionReset(error: unknown): boolean {
  const cause = error instanceof Error ? (error.cause as { code?: string } | undefined) : undefined;
  return RESET_CODES.has(cause?.code ?? "");
}

/**
 * Run workers as containers the supervisor creates, one per attempt and labelled with its id. The
 * guest starts by `docker exec` when the controller connects, over an HTTP upgrade whose socket
 * carries its stdio. Volumes are directories of the shared `DATA_DIR`, created here as this
 * service's user, so the root supervisor never writes a tree the guest can write.
 */
export class DockerWorkerProvider implements WorkerProvider, GuestConnector {
  private readonly expectedHarness: HarnessDeclaration;
  /** What settles each connected guest's `exited`, by attempt, until it is seen gone. */
  private readonly guests = new Map<string, Set<() => void>>();

  constructor(private readonly config: DockerWorkerConfig) {
    this.expectedHarness = workerHarness(config.harness ?? "pi-native");
  }

  describe(): AdapterDescriptor<WorkerCapabilities> {
    return {
      id: "docker-worker",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { readOnlyMounts: true },
    };
  }

  /**
   * A `DELETE` retries once on a connection reset, which is how a keep-alive connection the
   * supervisor already closed shows up. A `POST` never does: the supervisor may already be creating
   * the worker, and a second create could start another container on the same volumes.
   */
  private async call<T>(
    method: "POST" | "DELETE",
    route: string,
    options: { body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    const send = () =>
      fetch(new URL(route, this.config.supervisorUrl), {
        method,
        headers: {
          authorization: `Bearer ${this.config.supervisorToken}`,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
      });
    const response = await send().catch((error: unknown) => {
      if (method === "DELETE" && isConnectionReset(error)) return send();
      throw error;
    });
    const text = await response.text();
    let parsed: (T & { error?: string }) | undefined;
    try {
      parsed = JSON.parse(text) as T & { error?: string };
    } catch {}
    if (!response.ok || !parsed) {
      const message = `Supervisor ${method} ${route.split("?")[0]} failed with ${response.status}: ${parsed?.error ?? "no JSON body"}`;
      // The supervisor's handler is sequential, so its own refusal means no create is still running.
      // A proxy's answer says nothing about it.
      if (method === "POST" && !response.ok && typeof parsed?.error === "string") {
        throw new WorkerEnsureSettledError(message);
      }
      throw new Error(message);
    }
    return parsed;
  }

  async ensure(spec: WorkerSpec): Promise<{ providerRef: string }> {
    const deadline = spec.ensureDeadline.getTime() - DOCKER_CREATE_MARGIN_MS;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(`The worker of ${spec.attemptId} missed its deadline`);
    const { id } = await this.call<{ id: string }>("POST", "/workers", {
      body: {
        attemptId: spec.attemptId,
        ttlSeconds: spec.ttlSeconds,
        mounts: spec.mounts.map((mount) => ({
          volume: mount.volumeRef,
          path: mount.path,
          readOnly: mount.access === "ro",
        })),
      },
      signal: AbortSignal.timeout(remainingMs),
    });
    return { providerRef: id };
  }

  /** The container runs with its mounts once created; the guest's hello is the readiness check. */
  async prepare(): Promise<void> {}

  async destroy(target: { attemptId: string }): Promise<"destroyed" | "absent"> {
    const { destroyed } = await this.call<{ destroyed: boolean }>(
      "DELETE",
      `/workers?attempt=${encodeURIComponent(target.attemptId)}`,
    );
    for (const gone of this.guests.get(target.attemptId) ?? []) gone();
    return destroyed ? "destroyed" : "absent";
  }

  async ensureVolume(input: {
    name: string;
    ensureDeadline: Date;
  }): Promise<{ providerRef: string }> {
    const volume = this.volumePath(input.name);
    if (await this.isVolumeDirectory(volume)) return { providerRef: input.name };
    if (Date.now() >= input.ensureDeadline.getTime()) {
      throw new Error("Volume creation missed its deadline");
    }
    await mkdir(path.dirname(volume), { recursive: true });
    await mkdir(volume).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (!(await this.isVolumeDirectory(volume))) {
      throw new Error(`${input.name} is not a directory`);
    }
    return { providerRef: input.name };
  }

  /** Removes the directory, or a link in its place, never what a link points to. */
  async deleteVolume(input: { providerRef: string }): Promise<void> {
    await rm(this.volumePath(input.providerRef), { recursive: true, force: true });
  }

  /** Where a volume's files are in the shared `DATA_DIR`. */
  volumePath(volumeRef: string): string {
    if (!VOLUME_NAME.test(volumeRef)) throw new Error("Invalid volume name");
    return path.join(this.config.dataDir, "volumes", volumeRef);
  }

  private async isVolumeDirectory(volume: string): Promise<boolean> {
    const stats = await lstat(volume).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    return stats?.isDirectory() ?? false;
  }

  /** The guest's stdio: the upgraded socket, or nothing when the supervisor refused. */
  private openGuest(providerRef: string, capability: string): Promise<Socket | undefined> {
    return new Promise((resolve) => {
      const request = http.request(
        new URL(`/workers/${encodeURIComponent(providerRef)}/guest`, this.config.supervisorUrl),
        {
          // A fresh connection: an upgrade takes its socket out of any pool.
          agent: false,
          headers: {
            authorization: `Bearer ${this.config.supervisorToken}`,
            "x-tangow-worker-capability": capability,
            connection: "Upgrade",
            upgrade: "tangow-guest",
          },
        },
      );
      request.on("upgrade", (_response, socket, head) => {
        if (head.length > 0) socket.unshift(head);
        resolve(socket as Socket);
      });
      request.on("response", (response) => {
        response.resume();
        resolve(undefined);
      });
      request.on("error", () => resolve(undefined));
      request.end();
    });
  }

  /**
   * One connection per attempt, as on E2B: a broken socket ends it, and the run's next attempt
   * starts a new guest. The supervisor ends the socket once the exec's output ended, which is the
   * guest's exit. A reset proves nothing, so `exited` then waits for a destroy to confirm the
   * container gone.
   */
  connect(
    target: { attemptId: string; providerRef: string },
    capability: string,
  ): ReturnType<GuestConnector["connect"]> {
    let resolveExited = () => {};
    const exited = new Promise<void>((resolve) => (resolveExited = resolve));
    const guests = this.guests.get(target.attemptId) ?? new Set();
    this.guests.set(target.attemptId, guests);
    const gone = () => {
      guests.delete(gone);
      if (guests.size === 0 && this.guests.get(target.attemptId) === guests) {
        this.guests.delete(target.attemptId);
      }
      resolveExited();
    };
    guests.add(gone);

    const opened = this.openGuest(target.providerRef, capability);
    void opened.then((socket) => {
      socket?.once("end", gone);
      socket?.once("error", (error) =>
        getLogger().info("docker worker guest connection lost", {
          attemptId: target.attemptId,
          errorName: error.name,
        }),
      );
    });

    async function* bytes(socket: Socket): AsyncGenerator<Uint8Array> {
      try {
        for await (const chunk of socket) yield chunk as Uint8Array;
      } catch {
        // A reset ends the frames; `exited` waits for the destroy.
      }
    }
    async function* connections(): AsyncGenerator<FrameChannel> {
      const socket = await opened;
      if (!socket) return;
      yield streamChannel(bytes(socket), socket, WORKER_LIMITS.modelRequestBytes);
    }
    return { expectedHarness: this.expectedHarness, connections: connections(), exited };
  }
}

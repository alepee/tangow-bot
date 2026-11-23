import type { VolumeAccess } from "@tangow/contracts";
import type { AdapterContext, AdapterDescriptor } from "./types.js";

export interface WorkerCapabilities {
  /** Whether the provider enforces a read-only mount. A right it cannot enforce is refused. */
  readOnlyMounts: boolean;
}

/** One run attempt's VM, already authorized by the controller. */
export interface WorkerSpec {
  /** Tags the VM at the provider, so a VM whose ref was never recorded can still be found. */
  attemptId: string;
  runId: string;
  botId: string;
  mounts: Array<{ volumeRef: string; path: string; access: VolumeAccess }>;
  /** The provider removes the VM after this long, whatever the controller does. */
  ttlSeconds: number;
  /**
   * `ensure` must not create the VM after this instant. Past it, a VM absent for this attempt's tag
   * is taken as never created, so its attempt can be released.
   */
  ensureDeadline: Date;
}

/**
 * `ensure` failed after the provider answered, so no creation for this attempt is still in flight:
 * a `destroy` now is authoritative, with no need to wait out `ensureDeadline`. A failure that may
 * leave a creation running (a network error, a timeout, an answer that is not the provider's own)
 * must stay a plain error.
 */
export class WorkerEnsureSettledError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkerEnsureSettledError";
  }
}

/**
 * Temporary run workers, separate from computers: a worker has no screen and an MCP-only run needs
 * one without a computer. Volumes outlive every run: only deleting their bot or space deletes them.
 */
export interface WorkerProvider {
  describe(): AdapterDescriptor<WorkerCapabilities>;
  /**
   * Creates the VM tagged with `spec.attemptId`, called once per attempt. Must not create it after
   * `spec.ensureDeadline`. Throws {@link WorkerEnsureSettledError} only when the provider refused
   * the create and nothing for this attempt is still being created.
   */
  ensure(spec: WorkerSpec, context: AdapterContext): Promise<{ providerRef: string }>;
  /** Fallible setup once the ref is recorded: mounts visible, runner reachable. Idempotent. */
  prepare(providerRef: string, spec: WorkerSpec, context: AdapterContext): Promise<void>;
  /**
   * Destroys every VM tagged with `attemptId`, with or without a ref. None left to destroy is
   * `absent`, not an error.
   */
  destroy(
    target: { attemptId: string; providerRef: string | null },
    context: AdapterContext,
  ): Promise<"destroyed" | "absent">;
  /**
   * Creates the volume named `name`, or returns it. Its reference must be `name`, even if the
   * create response is lost. Stop submitting creates before `ensureDeadline`. The deletion sweep
   * retains intent for one hour afterwards to catch server completion after a timeout or crash.
   * Server-side creation must finish within that grace period.
   */
  ensureVolume(
    input: { name: string; ensureDeadline: Date },
    context: AdapterContext,
  ): Promise<{ providerRef: string }>;
  /**
   * Deletes the named volume once its row is deleted, even if ensureVolume never returned.
   * A volume already gone is not an error.
   */
  deleteVolume(input: { providerRef: string }, context: AdapterContext): Promise<void>;
}

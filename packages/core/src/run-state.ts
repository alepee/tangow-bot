import type { FaceState, RunStatus } from "@tangow/contracts";

export const ACTIVE_RUN_STATUSES = [
  "queued",
  "leased",
  "running",
  "waiting_input",
  "waiting_takeover",
] as const satisfies readonly RunStatus[];
const TERMINAL: RunStatus[] = ["completed", "failed", "cancelled"];

const allowed: Record<RunStatus, RunStatus[]> = {
  queued: ["leased", "cancelled"],
  leased: ["running", "queued", "cancelled"],
  running: ["waiting_input", "waiting_takeover", "completed", "failed", "cancelled", "leased"],
  waiting_input: ["queued", "leased", "cancelled"],
  waiting_takeover: ["queued", "leased", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancelled: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return allowed[from]?.includes(to) ?? false;
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal run transition ${from} -> ${to}`);
  }
}

export function isActive(status: RunStatus): boolean {
  return (ACTIVE_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

/** A bot busy on its own: not one waiting on the person. Stop and locks still read `isActive`. */
export function isWorkingStatus(status: string | undefined): boolean {
  return (
    status !== "waiting_input" &&
    status !== "waiting_takeover" &&
    ACTIVE_RUN_STATUSES.some((active) => active === status)
  );
}

const WORKING_FACE: FaceState = { expression: "concentre", gaze: "fixed", motion: "read" };
const FINISHED_FACE: FaceState = { expression: "content", gaze: "fixed", motion: "expression" };
const FAILED_FACE: FaceState = { expression: "decu", gaze: "fixed", motion: "expression" };

/** The face a bot shows for its latest run status; anything unknown is the face at rest. */
export function faceStateFor(status: string | undefined, defaultExpression: string): FaceState {
  if (isWorkingStatus(status)) return WORKING_FACE;
  if (status === "waiting_input" || status === "waiting_takeover") {
    return { expression: defaultExpression, gaze: "user", motion: "still" };
  }
  return { expression: defaultExpression, gaze: "free", motion: "expression" };
}

/** The brief face an avatar shows when it sees a run end: pleased when done, let down on failure. */
export function faceReactionFor(
  previous: string | undefined,
  status: string | undefined,
): FaceState | null {
  if (!ACTIVE_RUN_STATUSES.some((active) => active === previous)) return null;
  if (status === "completed") return FINISHED_FACE;
  if (status === "failed") return FAILED_FACE;
  return null;
}

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.includes(status);
}

export function nextFence(current: number): number {
  return current + 1;
}

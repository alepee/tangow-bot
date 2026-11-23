/**
 * What brings the clay face to life: the face a bot's status asks for, and the timing of blinks,
 * glances and an expression's own motion, from the brand's face animator.
 */
import type { ExpressionSettings } from "./avatar-face.js";

/** How the eyes pick where to look: on their own, held on the expression, or straight at you. */
export type FaceGaze = "free" | "fixed" | "user";
/** The expression's own motion, the working read sweep, or only a rare blink. */
export type FaceMotion = "expression" | "read" | "still";

export interface FaceState {
  expression: string;
  gaze: FaceGaze;
  motion: FaceMotion;
}

/** How long a face shows how a run it watched ended. */
export const FACE_REACTION_MS = 2000;

/** The pointer is followed while it moved this recently. */
export const FACE_POINTER_MS = 2500;

export interface BlinkTiming {
  /** Minimum gap between blinks; up to `FACE_BLINK_JITTER_MS` more. */
  every: number;
  close: number;
  open: number;
}

export const FACE_BLINK_JITTER_MS = 3000;
const BLINKS: Record<string, BlinkTiming> = {
  normal: { every: 2200, close: 70, open: 120 },
  lent: { every: 3200, close: 260, open: 420 },
  rare: { every: 7000, close: 70, open: 120 },
};

/** Null for eyes that never blink: closed, or winking in the brand's animator. */
export function blinkTiming(settings: ExpressionSettings, still: boolean): BlinkTiming | null {
  const kind = still ? "rare" : (settings.cligne ?? "normal");
  return BLINKS[kind] ?? null;
}

/** How closed a blink is, 0 to 1, `elapsed` ms after it started. */
export function blinkClosure(elapsed: number, timing: BlinkTiming): number {
  if (elapsed < timing.close) return elapsed / timing.close;
  if (elapsed < timing.close + timing.open) return 1 - (elapsed - timing.close) / timing.open;
  return 0;
}

export const FACE_GLANCE = { duration: 1300, every: 3500, jitter: 4500 } as const;

export interface FaceMotionOffset {
  gx: number;
  gy: number;
  /** Mouth corner tic, -1 to 0. */
  tic: number;
}

const NO_MOTION: FaceMotionOffset = { gx: 0, gy: 0, tic: 0 };

/**
 * An expression's idle motion at `t` ms; `phase` desynchronises faces. Only the motions a bot
 * state reaches play: the working read sweep, a thought, a tic.
 */
export function motionAt(jeu: string | undefined, t: number, phase: number): FaceMotionOffset {
  const bump = (period: number, part: number) => {
    const c = (t / period + phase) % 1;
    return c < part ? Math.sin((Math.PI * c) / part) : 0;
  };
  switch (jeu) {
    case "lit": {
      const c = (t / 2600 + phase) % 1;
      const back = (c - 0.82) / 0.18;
      const gx =
        c < 0.82 ? -0.35 + 0.7 * (Math.floor((c / 0.82) * 5) / 4) : 0.35 * (1 - back) - 0.35 * back;
      return { ...NO_MOTION, gx, gy: 0.18 };
    }
    case "pense": {
      const b = bump(3400, 0.45);
      return { ...NO_MOTION, gx: 0.3 * b, gy: -0.5 * b };
    }
    case "tic":
      return { ...NO_MOTION, tic: -bump(2600, 0.14) };
    default:
      return NO_MOTION;
  }
}

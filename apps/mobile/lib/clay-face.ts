import expressionsFile from "@tangow/avatars/face/expressions.json";
import faceFile from "@tangow/avatars/face/visages.json";
import type {
  BlinkTiming,
  CharacterFace,
  ExpressionsFile,
  EyePose,
  FaceFile,
  FaceState,
  HeadPose,
  MouthShape,
} from "@tangow/contracts";
import {
  blinkTiming,
  characterById,
  eyeTargets,
  headTarget,
  motionAt,
  mouthShape,
  settingsOf,
} from "@tangow/contracts";

export const FACES: FaceFile = faceFile;
const EXPRESSIONS: ExpressionsFile = expressionsFile;

/** The face of a catalogue character; missing or unknown is the neutral character's. */
export function faceFor(character: string | null | undefined): CharacterFace {
  const { id } = characterById(character);
  return FACES.persos.find((face) => face.id === id) ?? FACES.persos[0]!;
}

/** A face's pose: both eyes, the lean of the head, the mouth. Looking at you sets the gaze ahead. */
export interface FacePose {
  eyes: EyePose[];
  head: HeadPose;
  mouth: MouthShape;
}

export function poseOf(
  face: CharacterFace,
  state: Pick<FaceState, "expression" | "gaze">,
): FacePose {
  const settings = settingsOf(EXPRESSIONS, state.expression);
  const eyes = eyeTargets(face, settings);
  return {
    eyes: state.gaze === "user" ? eyes.map((eye) => ({ ...eye, gx: 0, gy: 0 })) : eyes,
    head: headTarget(settings),
    mouth: mouthShape(face.bouche, face.yeux[0]!.r, settings),
  };
}

function mix<T extends object>(from: T, to: T, k: number): T {
  const out = { ...from };
  for (const key of Object.keys(to) as Array<keyof T>) {
    const a = from[key] as number;
    (out[key] as number) = a + ((to[key] as number) - a) * k;
  }
  return out;
}

/** The pose `k` of the way from one pose to another. */
export function mixPose(from: FacePose, to: FacePose, k: number): FacePose {
  return {
    eyes: from.eyes.map((eye, i) => mix(eye, to.eyes[i]!, k)),
    head: mix(from.head, to.head, k),
    mouth: mix(from.mouth, to.mouth, k),
  };
}

/** Whether two poses are drawn the same, so there is nothing to ease. */
export function samePose(a: FacePose, b: FacePose): boolean {
  const same = (x: object, y: object) =>
    Object.entries(x).every(([key, value]) => (y as Record<string, unknown>)[key] === value);
  return (
    a.eyes.every((eye, i) => same(eye, b.eyes[i]!)) &&
    same(a.head, b.head) &&
    same(a.mouth, b.mouth)
  );
}

/** The idle motions this renderer plays; the brand's others are never reached by a bot state. */
export type FacePlay = "lit" | "pense" | "tic";
const PLAYS: Record<string, FacePlay> = { lit: "lit", pense: "pense", tic: "tic" };

/** What moves on a live face besides the pose: blinks, glances, an idle motion, a tremor. */
export interface FaceMotionPlan {
  blink: BlinkTiming | null;
  glance: boolean;
  play: FacePlay | null;
  /** Tremor amount, 0 for none. */
  tremor: number;
}

const STILL: FaceMotionPlan = { blink: null, glance: false, play: null, tremor: 0 };

/** As the web animator: reduced motion holds the face still; looking at you only blinks, rarely. */
export function motionPlan(state: FaceState, reduced: boolean): FaceMotionPlan {
  if (reduced) return STILL;
  const settings = settingsOf(EXPRESSIONS, state.expression);
  const still = state.motion === "still";
  const play = still ? null : state.motion === "read" ? "lit" : (PLAYS[settings.jeu ?? ""] ?? null);
  return {
    blink: blinkTiming(settings, still),
    glance: state.gaze === "free",
    play,
    tremor: still ? 0 : (settings.tr ?? 0),
  };
}

/** How long one cycle of an idle motion lasts, from the brand's animator. */
const PLAY_PERIOD_MS: Record<FacePlay, number> = { lit: 2600, pense: 3400, tic: 2600 };
const PLAY_SAMPLES = 64;

/**
 * One cycle of an idle motion sampled for a native interpolation over 0 to 1, `phase` setting
 * where in the cycle a face starts. A jump in the motion becomes a ramp one sample long.
 */
export function playCycle(play: FacePlay, phase: number) {
  const period = PLAY_PERIOD_MS[play];
  const input: number[] = [];
  const gx: number[] = [];
  const gy: number[] = [];
  const tic: number[] = [];
  for (let i = 0; i <= PLAY_SAMPLES; i++) {
    const offset = motionAt(play, (i / PLAY_SAMPLES) * period, phase);
    input.push(i / PLAY_SAMPLES);
    gx.push(offset.gx);
    gy.push(offset.gy);
    tic.push(offset.tic);
  }
  return { period, input, gx, gy, tic };
}

/** One stretch of a motion cycle: it moves to `to` (0 to 1 along the cycle) or holds still. */
export interface PlaySpan {
  to: number;
  ms: number;
  moves: boolean;
}

/**
 * A sampled cycle cut into the stretches where something moves and those where it holds, so a
 * face only drives its layers while they move.
 */
export function playSpans(cycle: ReturnType<typeof playCycle>): PlaySpan[] {
  const { input, gx, gy, tic, period } = cycle;
  const last = input.length - 1;
  const moves = (i: number) => gx[i] !== gx[i + 1] || gy[i] !== gy[i + 1] || tic[i] !== tic[i + 1];
  const spans: PlaySpan[] = [];
  for (let i = 0; i < last; ) {
    const moving = moves(i);
    let j = i + 1;
    while (j < last && moves(j) === moving) j++;
    spans.push({ to: input[j]!, ms: (input[j]! - input[i]!) * period, moves: moving });
    i = j;
  }
  return spans;
}

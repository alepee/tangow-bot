import type { CharacterFace, FaceState } from "@tangow/contracts";
import {
  blinkClosure,
  blinkTiming,
  eyesCentre,
  FACE_BLINK_JITTER_MS,
  FACE_GLANCE,
  motionAt,
  settingsOf,
} from "@tangow/contracts";
import { EXPRESSIONS } from "./clay-face-data.js";
import type { FaceScene, LiveFace } from "./face-loop.js";
import type { FacePose } from "./face-pose.js";
import { drawFace, faceParts, poseOf } from "./face-pose.js";

/** Per-frame easing toward the target: lower lid curve, gaze, head, everything else. */
const RATE = { cb: 0.45, gaze: 0.2, head: 0.12, rest: 0.16 } as const;

function easeToward<T extends object>(from: T, to: T, rate: (key: keyof T) => number) {
  for (const key of Object.keys(from) as Array<keyof T>) {
    const value = from[key] as number;
    (from[key] as number) = value + ((to[key] as number) - value) * rate(key);
  }
}

/**
 * The brand's face animator, ported: from the still's pose, the face eases each frame toward the
 * expression it should wear, then blinks, glances, trembles and plays the working read sweep or
 * the expression's own motion on top.
 */
export function faceAnimator(
  svg: SVGSVGElement,
  face: CharacterFace,
  state: () => FaceState,
): LiveFace {
  const parts = faceParts(svg, face);
  const centre = eyesCentre(face);
  const W = 1.3 * face.yeux[0]!.r;
  const pose: FacePose = poseOf(face, face.defaut);
  let expression = face.defaut;
  const now = performance.now();
  const phase = Math.random() * 6;
  let blinkStart = Number.NEGATIVE_INFINITY;
  let nextBlink = now + 800 + Math.random() * 2500;
  let glance: { gx: number; gy: number; end: number } | null = null;
  let nextGlance = now + 2000 + Math.random() * 4000;

  function pointerGaze(pointer: NonNullable<FaceScene["pointer"]>, box: DOMRect) {
    const view = svg.viewBox.baseVal;
    const k = box.width / view.width;
    const dx = pointer.x - (box.left + (centre.x - view.x) * k);
    const dy = pointer.y - (box.top + (centre.y - view.y) * k);
    const d = Math.hypot(dx, dy) || 1;
    const f = Math.min(1, d / 260);
    return { gx: (dx / d) * f, gy: (dy / d) * f };
  }

  function glanceAt(t: number) {
    if (t > nextGlance) {
      glance = {
        gx: (Math.random() - 0.5) * 0.9,
        gy: (Math.random() - 0.6) * 0.5,
        end: t + FACE_GLANCE.duration,
      };
      nextGlance = t + FACE_GLANCE.every + Math.random() * FACE_GLANCE.jitter;
    }
    return glance && t < glance.end ? glance : null;
  }

  function draw(t: number, target: FaceState, moving: boolean) {
    const settings = settingsOf(EXPRESSIONS, expression);
    const still = target.motion === "still";
    const lively = moving && !still;
    const tremor = lively ? (settings.tr ?? 0) : 0;
    const motion = motionAt(
      lively ? (target.motion === "read" ? "lit" : settings.jeu) : undefined,
      t,
      phase,
    );
    const blink = moving ? blinkTiming(settings, still) : null;
    let closure = 0;
    if (blink) {
      if (t > nextBlink) {
        blinkStart = t;
        nextBlink = t + blink.every + Math.random() * FACE_BLINK_JITTER_MS;
      }
      closure = blinkClosure(t - blinkStart, blink);
    }
    const shake = tremor * 0.035;
    drawFace(parts, pose, {
      closure,
      gx: motion.gx + shake * Math.sin(t * 0.09 + phase),
      gy: motion.gy + shake * Math.cos(t * 0.11 + phase),
      jitter: tremor * 0.03 * W * Math.sin(t * 0.07 + phase) + motion.tic * 0.07 * W,
    });
  }

  return {
    svg,
    frame(t, ease, scene, box) {
      const target = state();
      const moving = !scene.reduced;
      const to = poseOf(face, target.expression);
      if (target.gaze === "user") {
        for (const eye of to.eyes) Object.assign(eye, { gx: 0, gy: 0 });
      } else if (target.gaze === "free" && moving) {
        const look = scene.pointer && box ? pointerGaze(scene.pointer, box) : glanceAt(t);
        if (look) for (const eye of to.eyes) Object.assign(eye, { gx: look.gx, gy: look.gy });
      }
      pose.eyes.forEach((from, i) => {
        easeToward(from, to.eyes[i]!, (key) =>
          ease(key === "cb" ? RATE.cb : key === "gx" || key === "gy" ? RATE.gaze : RATE.rest),
        );
      });
      easeToward(pose.head, to.head, () => ease(RATE.head));
      easeToward(pose.mouth, to.mouth, () => ease(RATE.rest));
      expression = target.expression;
      draw(t, target, moving);
    },
  };
}

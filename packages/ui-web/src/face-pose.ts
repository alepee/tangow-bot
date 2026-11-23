import type {
  CharacterFace,
  EyePose,
  FaceEyeAnchor,
  HeadPose,
  MouthShape,
} from "@tangow/contracts";
import {
  eyeGaze,
  eyeTargets,
  eyeVeil,
  gazeOffsets,
  headTarget,
  headTransform,
  lidEdge,
  lidOffset,
  lowerLidOffset,
  mouthPaths,
  mouthShape,
  pupilReach,
  settingsOf,
} from "@tangow/contracts";
import { EXPRESSIONS } from "./clay-face-data.js";

/** A face's pose in one expression: both eyes, the lean of the head, the mouth. */
export interface FacePose {
  eyes: EyePose[];
  head: HeadPose;
  mouth: MouthShape;
}

export function poseOf(face: CharacterFace, expression: string): FacePose {
  const settings = settingsOf(EXPRESSIONS, expression);
  return {
    eyes: eyeTargets(face, settings),
    head: headTarget(settings),
    mouth: mouthShape(face.bouche, face.yeux[0]!.r, settings),
  };
}

/** What moves on top of a pose this frame: a blink, the gaze shift, the mouth corners. */
export interface FaceFrame {
  closure: number;
  gx: number;
  gy: number;
  jitter: number;
}

interface EyeParts {
  anchor: FaceEyeAnchor;
  offset: { gx: number; gy: number };
  pupil: Element;
  lid: Element;
  turn: Element;
  lower: Element;
  upperFollow: Element[];
  lowerFollow: Element[];
  veil: Array<{ element: Element; base: number }>;
  closed: Element;
}

export interface FaceParts {
  face: CharacterFace;
  eyes: EyeParts[];
  head: Element;
  groove: Element;
  lowerLip: Element[];
}

const part = (root: ParentNode, name: string) => root.querySelector(`[data-part="${name}"]`)!;

/** Writes an attribute only when it changes, so a face at rest costs no style work. */
function write(element: Element, name: string, value: string) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

/** The animated parts of a face `ClayFace` drew. */
export function faceParts(svg: SVGSVGElement, face: CharacterFace): FaceParts {
  const offsets = gazeOffsets(face);
  const eyes = [...svg.querySelectorAll('[data-part="eye"]')].map((group, i) => {
    const lid = part(group, "lid");
    const lower = part(group, "lower-lid");
    return {
      anchor: face.yeux[i]!,
      offset: offsets[i]!,
      pupil: part(group, "pupil"),
      lid,
      turn: part(group, "lid-turn"),
      lower,
      upperFollow: [...lid.querySelectorAll("[data-follow]")],
      lowerFollow: [...lower.querySelectorAll("[data-follow]")],
      veil: [...group.querySelectorAll("[data-veil]")].map((element) => ({
        element,
        base: Number(element.getAttribute("data-veil")),
      })),
      closed: part(group, "closed-lid"),
    };
  });
  return {
    face,
    eyes,
    head: part(svg, "head"),
    groove: part(svg, "groove"),
    lowerLip: [...part(svg, "mouth").querySelectorAll("[data-follow]")],
  };
}

function follow(elements: Element[], path: { edge: string; plate: string }) {
  for (const element of elements) {
    write(element, "d", element.getAttribute("data-follow") === "plate" ? path.plate : path.edge);
  }
}

function drawEye(eye: EyeParts, pose: EyePose, frame: FaceFrame) {
  const { anchor } = eye;
  const open = pose.o * (1 - frame.closure);
  const gaze = eyeGaze(pose.gx + frame.gx, pose.gy + frame.gy, eye.offset);
  const reach = pupilReach(anchor, pose.ps);
  const tilt = anchor.cote === "g" ? pose.a : -pose.a;
  write(
    eye.pupil,
    "transform",
    `translate(${(gaze.gx * reach).toFixed(1)} ${(gaze.gy * reach).toFixed(1)}) translate(${anchor.cx} ${anchor.cy}) scale(${pose.ps.toFixed(3)}) translate(${-anchor.cx} ${-anchor.cy})`,
  );
  write(eye.lid, "transform", `translate(0 ${lidOffset(anchor.r, open).toFixed(2)})`);
  write(eye.turn, "transform", `rotate(${tilt.toFixed(2)} ${anchor.cx} ${anchor.cy})`);
  write(eye.lower, "transform", `translate(0 ${lowerLidOffset(anchor.r, pose.ob).toFixed(2)})`);
  follow(eye.lowerFollow, lidEdge(anchor, pose.cb, "lower"));
  follow(eye.upperFollow, lidEdge(anchor, pose.ch, "upper"));
  const seen = eyeVeil(anchor.r, open, pose.ob);
  for (const { element, base } of eye.veil) write(element, "opacity", (base * seen).toFixed(3));
  write(eye.closed, "opacity", (1 - seen).toFixed(3));
}

/** Draws the face in a pose, with this frame's blink, gaze shift and mouth corners on top. */
export function drawFace(parts: FaceParts, pose: FacePose, frame: FaceFrame) {
  parts.eyes.forEach((eye, i) => {
    drawEye(eye, pose.eyes[i]!, frame);
  });
  write(parts.head, "transform", headTransform(pose.head, parts.face));
  const paths = mouthPaths(parts.face.bouche, pose.mouth, frame.jitter);
  write(parts.groove, "d", paths.outline);
  for (const element of parts.lowerLip) write(element, "d", paths.lower);
}

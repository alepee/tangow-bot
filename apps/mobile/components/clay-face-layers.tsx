import type { AvatarCrop, CharacterFace, EyePose, FaceEyeAnchor } from "@tangow/contracts";
import {
  eyeGaze,
  eyeVeil,
  FACE_LIGHT,
  FACE_SHADE,
  lidEdge,
  lidOffset,
  lowerLidOffset,
  mouthPaths,
  pupilReach,
} from "@tangow/contracts";
import type { ReactNode } from "react";
import Svg, {
  Circle,
  Defs,
  Ellipse,
  G,
  LinearGradient,
  Path,
  RadialGradient,
  Stop,
} from "react-native-svg";
import type { FacePose } from "../lib/clay-face";
import { FACES } from "../lib/clay-face";

/**
 * The layers `ClayFace` stacks: each draws part of the face for one pose, in the face's own
 * coordinates, as the web face does. Only an expression change draws them again.
 */

/** The face's own coordinates are a 1024 square; a disc shows the crop of it at `k` points a unit. */
export interface Frame {
  crop: AvatarCrop;
  k: number;
}

/** A box of the face's coordinates, in points from the disc's corner. */
export function place({ crop, k }: Frame, x: number, y: number, w: number, h = w) {
  return { left: (x - crop.x) * k, top: (y - crop.y) * k, width: w * k, height: h * k };
}

/** An SVG showing the box `x, y, w, h` of the face, sized to it. */
function Window({
  x,
  y,
  w,
  h = w,
  k,
  children,
}: {
  x: number;
  y: number;
  w: number;
  h?: number;
  k: number;
  children: ReactNode;
}) {
  return (
    <Svg width={w * k} height={h * k} viewBox={`${x} ${y} ${w} ${h}`}>
      {children}
    </Svg>
  );
}

type Stops = Array<[offset: number, color: string, opacity: number]>;

function stops(list: Stops) {
  return list.map(([offset, color, opacity]) => (
    <Stop key={offset} offset={offset} stopColor={color} stopOpacity={opacity} />
  ));
}

/** The lid closes from wide open (-1.24 r) to shut (+1.12 r). */
export const LID_TRAVEL = 2.36;
/** The upper lid's plate reaches this far above the eye, so a blink never shows its top. */
const LID_REACH = 3.5;
/** The pupil's drawing has this much room around the eye, so a moving gaze never cuts it. */
export const PUPIL_ROOM = 0.6;

/** One eye's layer, drawn in its pose. */
interface EyeLayer {
  eye: FaceEyeAnchor;
  pose: EyePose;
  face: CharacterFace;
  k: number;
}

/** The parts under the pupils: each eye's shadow, white and ball. */
export function Under({
  face,
  pose,
  frame,
}: {
  face: CharacterFace;
  pose: FacePose;
  frame: Frame;
}) {
  const { crop, k } = frame;
  const colors = face.couleurs;
  return (
    <Window x={crop.x} y={crop.y} w={crop.side} k={k}>
      <Defs>
        <RadialGradient id="shadow">
          {stops([
            [0.82, colors.lisere, 0.9],
            [0.9, colors.lisere, 0.45],
            [1, colors.lisere, 0],
          ])}
        </RadialGradient>
        <RadialGradient id="ball" cx={0.38} cy={0.32} r={0.78}>
          {stops([
            [0, FACE_LIGHT, 0.55],
            [0.45, FACE_LIGHT, 0.12],
            [0.64, FACE_LIGHT, 0],
            [0.84, FACE_SHADE, 0.12],
            [1, FACE_SHADE, 0.4],
          ])}
        </RadialGradient>
      </Defs>
      {face.yeux.map((eye, i) => {
        const { cx, cy, r } = eye;
        const seen = eyeVeil(r, pose.eyes[i]!.o, pose.eyes[i]!.ob);
        return (
          <G key={eye.cote}>
            <Circle cx={cx + 0.05 * r} cy={cy + 0.12 * r} r={1.2 * r} fill="url(#shadow)" />
            <Circle cx={cx} cy={cy} r={r - 0.6} fill={colors.blanc} opacity={seen} />
            <Circle cx={cx} cy={cy} r={r} fill="url(#ball)" opacity={seen} />
          </G>
        );
      })}
    </Window>
  );
}

export function Pupil({
  eye,
  pose,
  offset,
  face,
  k,
}: EyeLayer & { offset: { gx: number; gy: number } }) {
  const { cx, cy, r, pr } = eye;
  const room = (1 + PUPIL_ROOM) * r;
  const gaze = eyeGaze(pose.gx, pose.gy, offset);
  const reach = pupilReach(eye, pose.ps);
  const colors = face.couleurs;
  return (
    <Window x={cx - room} y={cy - room} w={2 * room} k={k}>
      <Defs>
        <RadialGradient id="pearl" cx={0.36} cy={0.3} r={0.8}>
          {stops([
            [0, FACE_LIGHT, 0.12],
            [0.5, FACE_LIGHT, 0],
            [1, FACE_SHADE, 0.28],
          ])}
        </RadialGradient>
      </Defs>
      <G
        opacity={eyeVeil(r, pose.o, pose.ob)}
        transform={`translate(${gaze.gx * reach} ${gaze.gy * reach}) translate(${cx} ${cy}) scale(${pose.ps}) translate(${-cx} ${-cy})`}
      >
        <Circle
          cx={cx + 0.08 * pr}
          cy={cy + 0.14 * pr}
          r={1.04 * pr}
          fill={colors.lisere}
          opacity={0.16}
        />
        <Circle cx={cx} cy={cy} r={pr} fill={colors.pupille} />
        <Circle cx={cx} cy={cy} r={pr} fill="url(#pearl)" />
        <Ellipse
          cx={cx - 0.36 * pr}
          cy={cy - 0.4 * pr}
          rx={0.22 * pr}
          ry={0.14 * pr}
          transform={`rotate(-30 ${cx - 0.36 * pr} ${cy - 0.4 * pr})`}
          fill={FACE_LIGHT}
          opacity={0.2}
        />
      </G>
    </Window>
  );
}

export function LowerLid({ eye, pose, face, k }: EyeLayer) {
  const { cx, cy, r } = eye;
  const colors = face.couleurs;
  const lid = lidEdge(eye, pose.cb, "lower");
  return (
    <Window x={cx - r} y={cy - r} w={2 * r} k={k}>
      <G transform={`translate(0 ${lowerLidOffset(r, pose.ob)})`}>
        <Path
          d={lid.edge}
          fill="none"
          stroke={colors.lisere}
          strokeWidth={0.15 * r}
          opacity={0.2 * eyeVeil(r, pose.o, pose.ob)}
          transform={`translate(0 ${-0.05 * r})`}
        />
        <Path d={lid.plate} fill={colors.joue} />
        <Path
          d={lid.edge}
          fill="none"
          stroke={FACE_LIGHT}
          strokeWidth={0.12 * r}
          opacity={0.16}
          transform={`translate(0 ${0.07 * r})`}
        />
        <Path
          d={lid.edge}
          fill="none"
          stroke={colors.lisere}
          strokeWidth={Math.max(2, 0.045 * r)}
          strokeLinecap="round"
          opacity={0.75}
        />
      </G>
    </Window>
  );
}

/** The upper lid in a window tall enough for a blink to slide it shut. */
export function UpperLid({ eye, pose, face, k }: EyeLayer) {
  const { cx, cy, r } = eye;
  const colors = face.couleurs;
  const round = FACES.constantes.debord_paupiere * r;
  const lid = lidEdge(eye, pose.ch, "upper", LID_REACH);
  const seen = eyeVeil(r, pose.o, pose.ob);
  const tilt = eye.cote === "g" ? pose.a : -pose.a;
  const line = Math.max(2, 0.045 * r);
  return (
    <Window
      x={cx - round}
      y={cy + 0.05 * r - round - LID_TRAVEL * r}
      w={2 * round}
      h={2 * round + LID_TRAVEL * r}
      k={k}
    >
      <Defs>
        <LinearGradient
          id="cap"
          gradientUnits="userSpaceOnUse"
          x1={0}
          y1={cy - 1.25 * r}
          x2={0}
          y2={cy}
        >
          {stops([
            [0, FACE_LIGHT, 0.28],
            [0.55, FACE_LIGHT, 0],
            [0.82, FACE_SHADE, 0],
            [1, FACE_SHADE, 0.16],
          ])}
        </LinearGradient>
      </Defs>
      <G transform={`translate(0 ${lidOffset(r, pose.o)})`}>
        <G transform={`rotate(${tilt} ${cx} ${cy})`}>
          {FACES.constantes.ombre_paupiere.map(({ largeur, opacite }) => (
            <Path
              key={largeur}
              d={lid.edge}
              fill="none"
              stroke={colors.lisere}
              strokeWidth={largeur * r}
              opacity={opacite * seen}
              transform={`translate(0 ${0.04 * r})`}
            />
          ))}
          <Path d={lid.plate} fill={colors.paupiere} />
          <Path d={lid.plate} fill="url(#cap)" />
          <Path
            d={lid.edge}
            fill="none"
            stroke={colors.lisere}
            strokeWidth={line}
            strokeLinecap="round"
            opacity={0.75}
          />
        </G>
      </G>
    </Window>
  );
}

/** The shading of a lid shut by its expression, over the whole lid. */
export function ClosedLid({ eye, opacity, k }: { eye: FaceEyeAnchor; opacity: number; k: number }) {
  const { cx, cy, r } = eye;
  const round = FACES.constantes.debord_paupiere * r;
  return (
    <Window x={cx - round} y={cy + 0.05 * r - round} w={2 * round} k={k}>
      <Defs>
        <RadialGradient id="closed" cx={0.42} cy={0.3} r={0.75}>
          {stops([
            [0, FACE_LIGHT, 0.22],
            [0.5, FACE_LIGHT, 0],
            [1, FACE_SHADE, 0.3],
          ])}
        </RadialGradient>
      </Defs>
      <Circle cx={cx} cy={cy} r={round} fill="url(#closed)" opacity={opacity} />
    </Window>
  );
}

export function Mouth({
  face,
  pose,
  frame,
}: {
  face: CharacterFace;
  pose: FacePose;
  frame: Frame;
}) {
  const { crop, k } = frame;
  const { e0 } = face.bouche;
  const colors = face.couleurs;
  const paths = mouthPaths(face.bouche, pose.mouth, 0);
  return (
    <Window x={crop.x} y={crop.y} w={crop.side} k={k}>
      <Path
        d={paths.lower}
        fill="none"
        stroke={colors.reflet}
        strokeWidth={1.1 * e0}
        strokeLinecap="round"
        opacity={0.22}
        transform={`translate(0 ${0.75 * e0})`}
      />
      <Path
        d={paths.lower}
        fill="none"
        stroke={colors.reflet}
        strokeWidth={0.4 * e0}
        strokeLinecap="round"
        opacity={0.4}
        transform={`translate(0 ${0.7 * e0})`}
      />
      <Path
        d={paths.outline}
        fill={colors.creux}
        stroke={colors.creux}
        strokeWidth={e0}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d={paths.lower}
        fill="none"
        stroke={colors.paroi}
        strokeWidth={0.38 * e0}
        strokeLinecap="round"
        opacity={0.55}
        transform={`translate(0 ${0.16 * e0})`}
      />
    </Window>
  );
}

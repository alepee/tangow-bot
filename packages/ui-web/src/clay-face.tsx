import type { AvatarCrop, CharacterFace, FaceEyeAnchor, FaceState } from "@tangow/contracts";
import { FACE_LIGHT, FACE_SHADE } from "@tangow/contracts";
import { useId, useLayoutEffect, useRef } from "react";
import { FACES } from "./clay-face-data.js";
import { faceAnimator } from "./face-animator.js";
import { addLiveFace } from "./face-loop.js";

type Stop = [offset: number, color: string, opacity: number];

function Stops({ stops }: { stops: Stop[] }) {
  return stops.map(([offset, color, opacity]) => (
    <stop key={offset} offset={offset} stopColor={color} stopOpacity={opacity} />
  ));
}

function Eye({ eye, face, id }: { eye: FaceEyeAnchor; face: CharacterFace; id: string }) {
  const { cx, cy, r, pr } = eye;
  const colors = face.couleurs;
  const own = `${id}-${eye.cote}`;
  const lid = FACES.constantes.debord_paupiere * r;
  const line = Math.max(2, 0.045 * r);
  return (
    <g data-part="eye">
      <defs>
        <clipPath id={own}>
          <circle cx={cx} cy={cy} r={r} />
        </clipPath>
        <clipPath id={`${own}-lid`}>
          <circle cx={cx} cy={cy + 0.05 * r} r={lid} />
        </clipPath>
        <linearGradient
          id={`${own}-cap`}
          gradientUnits="userSpaceOnUse"
          x1={0}
          y1={cy - 1.25 * r}
          x2={0}
          y2={cy}
        >
          <Stops
            stops={[
              [0, FACE_LIGHT, 0.28],
              [0.55, FACE_LIGHT, 0],
              [0.82, FACE_SHADE, 0],
              [1, FACE_SHADE, 0.16],
            ]}
          />
        </linearGradient>
      </defs>
      <circle cx={cx + 0.05 * r} cy={cy + 0.12 * r} r={1.2 * r} fill={`url(#${id}-shadow)`} />
      <g clipPath={`url(#${own})`}>
        <circle data-veil="1" cx={cx} cy={cy} r={r - 0.6} fill={colors.blanc} />
        <circle data-veil="1" cx={cx} cy={cy} r={r} fill={`url(#${id}-ball)`} />
        <g data-part="pupil" data-veil="1">
          <circle
            cx={cx + 0.08 * pr}
            cy={cy + 0.14 * pr}
            r={1.04 * pr}
            fill={colors.lisere}
            opacity={0.16}
          />
          <circle cx={cx} cy={cy} r={pr} fill={colors.pupille} />
          <circle cx={cx} cy={cy} r={pr} fill={`url(#${id}-pearl)`} />
          <ellipse
            cx={cx - 0.36 * pr}
            cy={cy - 0.4 * pr}
            rx={0.22 * pr}
            ry={0.14 * pr}
            transform={`rotate(-30 ${cx - 0.36 * pr} ${cy - 0.4 * pr})`}
            fill={FACE_LIGHT}
            opacity={0.2}
          />
        </g>
        <g data-part="lower-lid">
          <path
            data-veil="0.2"
            data-follow="edge"
            fill="none"
            stroke={colors.lisere}
            strokeWidth={0.15 * r}
            transform={`translate(0 ${-0.05 * r})`}
          />
          <path data-follow="plate" fill={colors.joue} />
          <path
            data-follow="edge"
            fill="none"
            stroke={FACE_LIGHT}
            strokeWidth={0.12 * r}
            opacity={0.16}
            transform={`translate(0 ${0.07 * r})`}
          />
          <path
            data-follow="edge"
            fill="none"
            stroke={colors.lisere}
            strokeWidth={line}
            strokeLinecap="round"
            opacity={0.75}
          />
        </g>
      </g>
      <g clipPath={`url(#${own}-lid)`}>
        <g data-part="lid">
          <g data-part="lid-turn">
            {FACES.constantes.ombre_paupiere.map(({ largeur, opacite }) => (
              <path
                key={largeur}
                data-veil={opacite}
                data-follow="edge"
                fill="none"
                stroke={colors.lisere}
                strokeWidth={largeur * r}
                transform={`translate(0 ${0.04 * r})`}
              />
            ))}
            <path data-follow="plate" fill={colors.paupiere} />
            <path data-follow="plate" fill={`url(#${own}-cap)`} />
            <path
              data-follow="edge"
              fill="none"
              stroke={colors.lisere}
              strokeWidth={line}
              strokeLinecap="round"
              opacity={0.75}
            />
          </g>
        </g>
        <circle
          data-part="closed-lid"
          cx={cx}
          cy={cy}
          r={lid}
          fill={`url(#${id}-closed)`}
          opacity={0}
        />
      </g>
    </g>
  );
}

function Mouth({ face }: { face: CharacterFace }) {
  const { e0 } = face.bouche;
  const colors = face.couleurs;
  return (
    <g data-part="mouth">
      <path
        data-follow="lower"
        fill="none"
        stroke={colors.reflet}
        strokeWidth={1.1 * e0}
        strokeLinecap="round"
        opacity={0.22}
        transform={`translate(0 ${0.75 * e0})`}
      />
      <path
        data-follow="lower"
        fill="none"
        stroke={colors.reflet}
        strokeWidth={0.4 * e0}
        strokeLinecap="round"
        opacity={0.4}
        transform={`translate(0 ${0.7 * e0})`}
      />
      <path
        data-part="groove"
        fill={colors.creux}
        stroke={colors.creux}
        strokeWidth={e0}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        data-follow="lower"
        fill="none"
        stroke={colors.paroi}
        strokeWidth={0.38 * e0}
        strokeLinecap="round"
        opacity={0.55}
        transform={`translate(0 ${0.16 * e0})`}
      />
    </g>
  );
}

/**
 * The character's body with its face drawn live on top, cut to the body's outline, framed like
 * the still image. Decorative: the avatar carries the name.
 */
export function ClayFace({
  face,
  body,
  crop,
  state,
}: {
  face: CharacterFace;
  body: string;
  crop: AvatarCrop;
  state: FaceState;
}) {
  const id = `clay-face${useId().replace(/[^\w-]/g, "")}`;
  const svg = useRef<SVGSVGElement>(null);
  const latest = useRef(state);
  latest.current = state;

  useLayoutEffect(
    () => addLiveFace(faceAnimator(svg.current!, face, () => latest.current)),
    [face],
  );

  const shadow = face.couleurs.lisere;
  return (
    <svg
      ref={svg}
      aria-hidden="true"
      className="tangow-clay-face absolute inset-0 size-full"
      viewBox={`${crop.x} ${crop.y} ${crop.side} ${crop.side}`}
    >
      <defs>
        <radialGradient id={`${id}-shadow`}>
          <Stops
            stops={[
              [0.82, shadow, 0.9],
              [0.9, shadow, 0.45],
              [1, shadow, 0],
            ]}
          />
        </radialGradient>
        <radialGradient id={`${id}-ball`} cx={0.38} cy={0.32} r={0.78}>
          <Stops
            stops={[
              [0, FACE_LIGHT, 0.55],
              [0.45, FACE_LIGHT, 0.12],
              [0.64, FACE_LIGHT, 0],
              [0.84, FACE_SHADE, 0.12],
              [1, FACE_SHADE, 0.4],
            ]}
          />
        </radialGradient>
        <radialGradient id={`${id}-pearl`} cx={0.36} cy={0.3} r={0.8}>
          <Stops
            stops={[
              [0, FACE_LIGHT, 0.12],
              [0.5, FACE_LIGHT, 0],
              [1, FACE_SHADE, 0.28],
            ]}
          />
        </radialGradient>
        <radialGradient id={`${id}-closed`} cx={0.42} cy={0.3} r={0.75}>
          <Stops
            stops={[
              [0, FACE_LIGHT, 0.22],
              [0.5, FACE_LIGHT, 0],
              [1, FACE_SHADE, 0.3],
            ]}
          />
        </radialGradient>
        <mask
          id={`${id}-body`}
          maskUnits="userSpaceOnUse"
          x={0}
          y={0}
          width={1024}
          height={1024}
          style={{ maskType: "alpha" }}
        >
          <image href={body} width={1024} height={1024} />
        </mask>
      </defs>
      <image href={body} width={1024} height={1024} />
      <g mask={`url(#${id}-body)`}>
        <g data-part="head">
          {face.yeux.map((eye) => (
            <Eye key={eye.cote} eye={eye} face={face} id={id} />
          ))}
          <Mouth face={face} />
        </g>
      </g>
    </svg>
  );
}

/**
 * The clay face drawn live over a faceless body: a typed view of the brand's face export
 * (`@tangow/avatars/face/*.json`) and the drawing formulas of its eye and mouth generator and
 * animator, so the live face and the still images come from the same values. Coordinates are in
 * the 1024 pixel square the images are exported in; field names are the export's own.
 */

export interface FaceEyeAnchor {
  /** `g` left, `d` right. */
  cote: string;
  cx: number;
  cy: number;
  r: number;
  /** Pupil radius. */
  pr: number;
  /** The eye's own gaze at rest, -1 to 1. */
  gx: number;
  gy: number;
}

export interface FaceMouthAnchor {
  cx: number;
  cy: number;
  w: number;
  t: number;
  qx: number;
  p: number;
  ep: number;
  e0: number;
  qb: number;
}

export interface FaceColors {
  paupiere: string;
  joue: string;
  lisere: string;
  blanc: string;
  pupille: string;
  creux: string;
  reflet: string;
  paroi: string;
}

export interface CharacterFace {
  id: string;
  /** The expression the character wears at rest. */
  defaut: string;
  yeux: FaceEyeAnchor[];
  ouvert: number;
  bouche: FaceMouthAnchor;
  couleurs: FaceColors;
}

export interface FaceFile {
  constantes: {
    /** Radius of the upper lid piece, in eye radii. */
    debord_paupiere: number;
    /** The upper lid's shadow on the white: stacked strokes, width in eye radii. */
    ombre_paupiere: Array<{ largeur: number; opacite: number }>;
  };
  persos: CharacterFace[];
}

/** One eye: openness, gaze, lower lid rise and curve, lid tilt, pupil scale, upper lid curve. */
export interface EyePose {
  o: number;
  gx: number;
  gy: number;
  ob: number;
  cb: number;
  a: number;
  ps: number;
  ch: number;
}

/** In units of 1.3 eye radii. Either `p` and `e` (depth and thickness) or `cu` and `cl` (lips). */
export interface MouthSetting {
  w: number;
  t?: number;
  qx?: number;
  dy?: number;
  z?: number;
  p?: number;
  e?: number;
  cu?: number;
  cl?: number;
}

export interface HeadPose {
  dx: number;
  dy: number;
  rv: number;
  sy: number;
  pe: number;
}

export interface ExpressionSettings {
  yeux?: Partial<EyePose>;
  /** The right eye's differences from `yeux`. */
  d?: Partial<EyePose>;
  bouche?: MouthSetting;
  tete?: Partial<HeadPose>;
  /** Blink kind: absent normal, `lent`, `rare`; `non` (eyes closed) and `clin` never blink. */
  cligne?: string;
  /** Idle motion; this renderer plays `lit`, `pense` and `tic`. */
  jeu?: string;
  /** Tremor amount. */
  tr?: number;
}

export interface ExpressionsFile {
  expressions: Record<string, { reglages: ExpressionSettings }>;
}

// These and the web face's gradient stops mirror the brand generator, not its export.
/** The face's own highlight and shade, drawn over every character's colours. */
export const FACE_LIGHT = "#FFF";
export const FACE_SHADE = "#000";

export function settingsOf(expressions: ExpressionsFile, key: string): ExpressionSettings {
  return expressions.expressions[key]?.reglages ?? {};
}

/** The pose every expression starts from: the character's rest openness and mean gaze. */
function basePose(face: CharacterFace): EyePose {
  const gx = mean(face.yeux.map((eye) => eye.gx));
  const gy = mean(face.yeux.map((eye) => eye.gy));
  return { o: face.ouvert, gx, gy, ob: 0, cb: 1, a: 0, ps: 1, ch: -1 };
}

/** Both eyes' targets in an expression, before each eye adds its own gaze offset. */
export function eyeTargets(face: CharacterFace, settings: ExpressionSettings): EyePose[] {
  const left = { ...basePose(face), ...settings.yeux };
  return [left, { ...left, ...settings.d }];
}

/** Each eye's gaze offset from the mean, kept in every expression (a squint, a painted look). */
export function gazeOffsets(face: CharacterFace): Array<{ gx: number; gy: number }> {
  const base = basePose(face);
  return face.yeux.map((eye) => ({ gx: eye.gx - base.gx, gy: eye.gy - base.gy }));
}

/** The eye's gaze once its own offset is added; sideways reach is held to 1.3. */
export function eyeGaze(gx: number, gy: number, offset: { gx: number; gy: number }) {
  return { gx: Math.max(-1.3, Math.min(1.3, gx + offset.gx)), gy: gy + offset.gy };
}

export function headTarget(settings: ExpressionSettings): HeadPose {
  const head = settings.tete ?? {};
  return {
    dx: head.dx ?? 0,
    dy: head.dy ?? 0,
    rv: head.rv ?? 0,
    sy: head.sy ?? 1,
    pe: head.pe ?? 0,
  };
}

/** Clay does not turn the body: the face takes the lean. */
export function headTransform(head: HeadPose, face: CharacterFace): string {
  const r0 = face.yeux[0]!.r;
  const { x, y } = eyesCentre(face);
  const turn = head.rv + head.pe * 0.7;
  return `translate(${n1(head.dx * r0)} ${n1(head.dy * r0)}) translate(${n1(x)} ${n1(y)}) rotate(${turn.toFixed(2)}) scale(1 ${head.sy.toFixed(3)}) translate(${n1(-x)} ${n1(-y)})`;
}

export function eyesCentre(face: CharacterFace): { x: number; y: number } {
  return { x: mean(face.yeux.map((eye) => eye.cx)), y: mean(face.yeux.map((eye) => eye.cy)) };
}

/** Upper lid shift: its edge is drawn on the eye's centre line. 1 wide open, 0 closed. */
export function lidOffset(r: number, o: number): number {
  const b = 0.12 * r;
  const closed = r + b;
  const wide = -(r + b + 0.12 * r);
  return closed + o * (wide - closed);
}

/** Lower lid shift: 0 below the eye, 1 its edge above the eye. */
export function lowerLidOffset(r: number, ob: number): number {
  return 1.5 * r - ob * 2.62 * r;
}

/** The part of the eye left between the lids, 0 to 1: below, the white and pupil fade out. */
export function eyeVeil(r: number, o: number, ob: number): number {
  const h = Math.min(r, lowerLidOffset(r, ob)) - Math.max(-r, lidOffset(r, o));
  return Math.max(0, Math.min(1, (h / r) * 8));
}

/** How far the pupil travels for a gaze of 1. */
export function pupilReach(eye: FaceEyeAnchor, ps: number): number {
  return (eye.r - eye.pr * ps) * 0.82;
}

/**
 * A lid's edge, a parabola of curve `c` (-1 a cup, 1 a cap) over ±1.6 r, and the plate it
 * bounds, reaching `reach` eye radii above (upper lid) or below (lower lid) the eye.
 */
export function lidEdge(
  eye: FaceEyeAnchor,
  c: number,
  side: "upper" | "lower",
  reach = 2.4,
): { edge: string; plate: string } {
  const X = 1.6 * eye.r;
  const B = (c * 0.12 * eye.r * X * X) / (eye.r + 6) ** 2;
  const x0 = n1(eye.cx - X);
  const x1 = n1(eye.cx + X);
  const y = n1(eye.cy + B);
  const yq = n1(eye.cy - B);
  const edge = `M${x0} ${y} Q${n1(eye.cx)} ${yq} ${x1} ${y}`;
  if (side === "lower") {
    const bottom = n1(eye.cy + reach * eye.r);
    return { edge, plate: `${edge} L${x1} ${bottom} L${x0} ${bottom} Z` };
  }
  const top = n1(eye.cy - reach * eye.r);
  return {
    edge,
    plate: `M${x0} ${top} L${x1} ${top} L${x1} ${y} Q${n1(eye.cx)} ${yq} ${x0} ${y} Z`,
  };
}

export interface MouthShape {
  w: number;
  t: number;
  qx: number;
  qb: number;
  dy: number;
  z: number;
  /** Upper and lower lip depth. */
  cu: number;
  cl: number;
}

/** The mouth of an expression, in px; at most one eye diameter wide and open. */
export function mouthShape(
  mouth: FaceMouthAnchor,
  eyeR: number,
  settings: ExpressionSettings,
): MouthShape {
  const W = 1.3 * eyeR;
  const groove = (e: number) => Math.max(0, e * mouth.ep - mouth.e0) / 2;
  const b = settings.bouche;
  if (!b) {
    const { w, t, qx, qb, p } = mouth;
    return { w, t, qx, qb, dy: 0, z: 0, cu: p - groove(1), cl: p + groove(1) };
  }
  const m: MouthShape = {
    w: b.w * W,
    t: (b.t ?? 0) * W,
    qx: (b.qx ?? 0) * W,
    qb: 0,
    dy: (b.dy ?? 0) * W,
    z: (b.z ?? 0) * W,
    cu: 0,
    cl: 0,
  };
  if (b.e !== undefined) {
    m.cu = (b.p ?? 0) * W - groove(b.e);
    m.cl = (b.p ?? 0) * W + groove(b.e);
  } else {
    m.cu = (b.cu ?? 0) * W;
    m.cl = (b.cl ?? 0) * W;
  }
  const D = (2 * W) / 1.3;
  m.w = Math.min(m.w, D);
  if (m.cl - m.cu > D) {
    const c = (m.cl + m.cu) / 2;
    m.cu = c - D / 2;
    m.cl = c + D / 2;
  }
  return m;
}

/**
 * The mouth's lower lip and closed outline. `jitter` tilts the corners; a zigzag (`z`) draws the
 * lips as a four-tooth wave.
 */
export function mouthPaths(
  mouth: FaceMouthAnchor,
  m: MouthShape,
  jitter: number,
): { lower: string; outline: string } {
  const cy = mouth.cy + m.dy;
  const { cl } = m;
  const xl = mouth.cx - m.w / 2;
  const xr = mouth.cx + m.w / 2;
  const yl = cy - m.t - jitter;
  const yr = cy + m.t + jitter;
  const qx = mouth.cx + m.qx;
  if (m.z < 0.3) {
    const lower = `M${n1(xl)} ${n1(yl)} Q${n1(qx + m.qb)} ${n1(cy + 2 * cl)} ${n1(xr)} ${n1(yr)}`;
    return { lower, outline: `${lower} Q${n1(qx)} ${n1(cy + 2 * m.cu)} ${n1(xl)} ${n1(yl)}Z` };
  }
  const point = (c: number, u: number) => {
    const a = (1 - u) ** 2;
    const k = 2 * u * (1 - u);
    const d = u * u;
    const wave = m.z * (2 / Math.PI) * Math.asin(Math.sin(8 * Math.PI * u)) * Math.sin(Math.PI * u);
    return `${n1(a * xl + k * qx + d * xr)} ${n1(a * yl + k * (cy + 2 * c) + d * yr + wave)}`;
  };
  const N = 32;
  const bottom: string[] = [];
  const top: string[] = [];
  for (let i = 0; i <= N; i++) {
    bottom.push(point(cl, i / N));
    top.push(point(m.cu, 1 - i / N));
  }
  const lower = `M${bottom.join(" L")}`;
  return { lower, outline: `${lower} L${top.join(" L")}Z` };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function n1(value: number): string {
  return value.toFixed(1);
}

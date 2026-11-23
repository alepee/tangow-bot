import { FACE_POINTER_MS } from "@tangow/contracts";

/** What every live face reads on a frame: the motion preference and a recent pointer. */
export interface FaceScene {
  reduced: boolean;
  pointer: { x: number; y: number } | null;
}

export interface LiveFace {
  svg: SVGSVGElement;
  /**
   * `ease(rate)` is how far a value moves toward its target this frame, for a per-frame `rate`.
   * `box` is the face's rectangle, read only while the pointer is followed.
   */
  frame(t: number, ease: (rate: number) => number, scene: FaceScene, box: DOMRect | null): void;
}

const faces = new Set<LiveFace>();
let frameId = 0;
let last = 0;
let pointer: { x: number; y: number; at: number } | null = null;
let media: MediaQueryList | null = null;

const snap = () => 1;
const hold = () => 0;

function scene(t: number): FaceScene {
  const recent = pointer && t - pointer.at <= FACE_POINTER_MS ? pointer : null;
  return { reduced: media?.matches ?? false, pointer: recent };
}

function tick(t: number) {
  // Asked first, so a face that throws cannot stop the loop the others share.
  frameId = requestAnimationFrame(tick);
  const now = scene(t);
  const frames = now.reduced ? 60 : Math.min(30, (t - (last || t)) / 16.7);
  last = t;
  const ease = (rate: number) => 1 - (1 - rate) ** frames;
  // Every rectangle is read before any face writes, so a frame lays out once.
  const live = [...faces];
  const follows = now.pointer && !now.reduced;
  const boxes = follows ? live.map((face) => face.svg.getBoundingClientRect()) : null;
  live.forEach((face, i) => {
    face.frame(t, ease, now, boxes?.[i] ?? null);
  });
}

function onPointer(event: PointerEvent) {
  // A finger scrolling the page is not something to look at.
  if (event.pointerType === "touch") return;
  pointer = { x: event.clientX, y: event.clientY, at: performance.now() };
}

/**
 * Animates a face on the one frame loop all live faces share, drawing it at once in the still's
 * pose (in its target pose under reduced motion); the loop runs only while a face is live.
 * Returns the call that takes the face off.
 */
export function addLiveFace(face: LiveFace): () => void {
  if (faces.size === 0) {
    media = window.matchMedia("(prefers-reduced-motion: reduce)");
    window.addEventListener("pointermove", onPointer, { passive: true });
    last = 0;
    frameId = requestAnimationFrame(tick);
  }
  faces.add(face);
  const t = performance.now();
  const now = scene(t);
  face.frame(t, now.reduced ? snap : hold, now, null);
  return () => {
    if (!faces.delete(face) || faces.size > 0) return;
    cancelAnimationFrame(frameId);
    window.removeEventListener("pointermove", onPointer);
    media = null;
    pointer = null;
  };
}

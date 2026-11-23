import type { FaceState } from "@tangow/contracts";
import { FACE_REACTION_MS } from "@tangow/contracts";
import { faceReactionFor, faceStateFor, isWorkingStatus } from "@tangow/core";
import { useEffect, useState } from "react";

/** Once a face no longer needs to be live, it eases back to rest this long before the still returns. */
const SETTLE_MS = 400;

/**
 * The face an avatar draws live, or null for the still image. Live when asked, while the bot
 * works, and for the reaction this avatar saw at the end of a run; the reaction is lost on unmount.
 * The web twin is `packages/ui-web/src/use-clay-face-state.ts`: change both together.
 */
export function useClayFaceState(
  status: string | undefined,
  defaultExpression: string,
  live: boolean,
): FaceState | null {
  const [seen, setSeen] = useState(status);
  const [reaction, setReaction] = useState<FaceState | null>(null);
  if (status !== seen) {
    setSeen(status);
    setReaction(faceReactionFor(seen, status));
  }
  useEffect(() => {
    if (!reaction) return;
    const timer = setTimeout(() => setReaction(null), FACE_REACTION_MS);
    return () => clearTimeout(timer);
  }, [reaction]);

  const wanted = live || isWorkingStatus(status) || reaction !== null;
  const [wasWanted, setWasWanted] = useState(wanted);
  const [settling, setSettling] = useState(false);
  if (wanted !== wasWanted) {
    setWasWanted(wanted);
    setSettling(!wanted);
  }
  useEffect(() => {
    if (!settling) return;
    const timer = setTimeout(() => setSettling(false), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [settling]);

  if (!wanted && !settling) return null;
  return reaction ?? faceStateFor(status, defaultExpression);
}

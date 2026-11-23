import atlas from "@tangow/avatars/bodies/atlas.webp";
import docteurDisquette from "@tangow/avatars/bodies/docteur-disquette.webp";
import ivy from "@tangow/avatars/bodies/ivy.webp";
import mariachi from "@tangow/avatars/bodies/mariachi.webp";
import monstre from "@tangow/avatars/bodies/monstre.webp";
import roi from "@tangow/avatars/bodies/roi.webp";
import saintDemon from "@tangow/avatars/bodies/saint-demon.webp";
import scout from "@tangow/avatars/bodies/scout.webp";
import sorciere from "@tangow/avatars/bodies/sorciere.webp";
import toutankit from "@tangow/avatars/bodies/toutankit.webp";
import viking from "@tangow/avatars/bodies/viking.webp";
import type { AvatarCharacterId } from "@tangow/contracts";
import { characterById } from "@tangow/contracts";
import { useEffect, useState } from "react";

/** The characters without a face, for the live face to sit on. */
export const BODIES: Record<AvatarCharacterId, string> = {
  scout,
  atlas,
  ivy,
  "saint-demon": saintDemon,
  sorciere,
  roi,
  mariachi,
  viking,
  monstre,
  toutankit,
  "docteur-disquette": docteurDisquette,
};

const decoded = new Set<string>();
const loading = new Map<string, Promise<boolean>>();

function loadBody(src: string): Promise<boolean> {
  let load = loading.get(src);
  if (!load) {
    const image = new Image();
    image.src = src;
    // A browser that cannot decode ahead keeps the still image rather than failing the page.
    load = Promise.resolve()
      .then(() => image.decode())
      .then(
        () => {
          decoded.add(src);
          return true;
        },
        () => {
          loading.delete(src);
          return false;
        },
      );
    loading.set(src, load);
  }
  return load;
}

/** Decodes the bodies of these characters ahead, so a face that comes alive does not wait. */
export function preloadClayBodies(characters: Iterable<string | null | undefined>): void {
  for (const character of characters) void loadBody(BODIES[characterById(character).id]);
}

/** Whether the body is decoded, loading it when wanted; until then the still image stays. */
export function useClayBody(src: string, wanted: boolean): boolean {
  const [, setDecoded] = useState<string | null>(null);
  useEffect(() => {
    if (!wanted || decoded.has(src)) return;
    let mounted = true;
    void loadBody(src).then((ok) => {
      if (mounted && ok) setDecoded(src);
    });
    return () => {
      mounted = false;
    };
  }, [src, wanted]);
  return wanted && decoded.has(src);
}

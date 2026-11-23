import atlas from "@tangow/avatars/characters/atlas.webp";
import atlasMini from "@tangow/avatars/characters/atlas-mini.webp";
import docteurDisquette from "@tangow/avatars/characters/docteur-disquette.webp";
import docteurDisquetteMini from "@tangow/avatars/characters/docteur-disquette-mini.webp";
import ivy from "@tangow/avatars/characters/ivy.webp";
import ivyMini from "@tangow/avatars/characters/ivy-mini.webp";
import mariachi from "@tangow/avatars/characters/mariachi.webp";
import mariachiMini from "@tangow/avatars/characters/mariachi-mini.webp";
import monstre from "@tangow/avatars/characters/monstre.webp";
import monstreMini from "@tangow/avatars/characters/monstre-mini.webp";
import roi from "@tangow/avatars/characters/roi.webp";
import roiMini from "@tangow/avatars/characters/roi-mini.webp";
import saintDemon from "@tangow/avatars/characters/saint-demon.webp";
import saintDemonMini from "@tangow/avatars/characters/saint-demon-mini.webp";
import scout from "@tangow/avatars/characters/scout.webp";
import scoutMini from "@tangow/avatars/characters/scout-mini.webp";
import sorciere from "@tangow/avatars/characters/sorciere.webp";
import sorciereMini from "@tangow/avatars/characters/sorciere-mini.webp";
import toutankit from "@tangow/avatars/characters/toutankit.webp";
import toutankitMini from "@tangow/avatars/characters/toutankit-mini.webp";
import viking from "@tangow/avatars/characters/viking.webp";
import vikingMini from "@tangow/avatars/characters/viking-mini.webp";
import type { AvatarCharacterId, FaceState } from "@tangow/contracts";
import { CLAY_MINI_MAX_SIZE, characterById, cropForSize } from "@tangow/contracts";
import { BODIES, useClayBody } from "./clay-body.js";
import { ClayFace } from "./clay-face.js";
import { faceFor } from "./clay-face-data.js";
import { cn } from "./lib/utils.js";
import "./styles.css";

const IMAGES: Record<AvatarCharacterId, { full: string; mini: string }> = {
  scout: { full: scout, mini: scoutMini },
  atlas: { full: atlas, mini: atlasMini },
  ivy: { full: ivy, mini: ivyMini },
  "saint-demon": { full: saintDemon, mini: saintDemonMini },
  sorciere: { full: sorciere, mini: sorciereMini },
  roi: { full: roi, mini: roiMini },
  mariachi: { full: mariachi, mini: mariachiMini },
  viking: { full: viking, mini: vikingMini },
  monstre: { full: monstre, mini: monstreMini },
  toutankit: { full: toutankit, mini: toutankitMini },
  "docteur-disquette": { full: docteurDisquette, mini: docteurDisquetteMini },
};

/**
 * A clay character in a round disc: the still image, or with a `face` the body with its face
 * drawn live, once the body is decoded. At 20 px and below it is always the simplified still.
 */
export function ClayAvatar({
  character,
  size,
  isWorking,
  face = null,
  className,
}: {
  character: string | null;
  size: number;
  isWorking: boolean;
  face?: FaceState | null;
  className?: string;
}) {
  const { id, crops } = characterById(character);
  const crop = crops[cropForSize(size)];
  const mini = size <= CLAY_MINI_MAX_SIZE;
  const body = BODIES[id];
  const bodyReady = useClayBody(body, face !== null && !mini);
  return (
    <div
      className={cn(
        "tangow-bot-avatar tangow-clay-avatar relative flex-none rounded-full select-none",
        className,
      )}
      data-working={isWorking}
      style={{ width: size, height: size }}
    >
      <div className="relative size-full overflow-hidden rounded-full bg-muted">
        {face && bodyReady ? (
          <ClayFace face={faceFor(id)} body={body} crop={crop} state={face} />
        ) : (
          <img
            src={IMAGES[id][mini ? "mini" : "full"]}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="absolute max-w-none"
            style={{
              width: `${(1024 / crop.side) * 100}%`,
              left: `${(-crop.x / crop.side) * 100}%`,
              top: `${(-crop.y / crop.side) * 100}%`,
            }}
          />
        )}
      </div>
    </div>
  );
}

import type { AvatarCharacterId, FaceState } from "@tangow/contracts";
import { CLAY_MINI_MAX_SIZE, characterById, cropForSize } from "@tangow/contracts";
import { useState } from "react";
import type { ImageSourcePropType } from "react-native";
import { StyleSheet, View } from "react-native";
import Svg, { Image as SvgImage } from "react-native-svg";
import { faceFor } from "../lib/clay-face";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { ClayFace } from "./clay-face";

const IMAGES: Record<AvatarCharacterId, { full: ImageSourcePropType; mini: ImageSourcePropType }> =
  {
    scout: {
      full: require("@tangow/avatars/characters/scout.webp"),
      mini: require("@tangow/avatars/characters/scout-mini.webp"),
    },
    atlas: {
      full: require("@tangow/avatars/characters/atlas.webp"),
      mini: require("@tangow/avatars/characters/atlas-mini.webp"),
    },
    ivy: {
      full: require("@tangow/avatars/characters/ivy.webp"),
      mini: require("@tangow/avatars/characters/ivy-mini.webp"),
    },
    "saint-demon": {
      full: require("@tangow/avatars/characters/saint-demon.webp"),
      mini: require("@tangow/avatars/characters/saint-demon-mini.webp"),
    },
    sorciere: {
      full: require("@tangow/avatars/characters/sorciere.webp"),
      mini: require("@tangow/avatars/characters/sorciere-mini.webp"),
    },
    roi: {
      full: require("@tangow/avatars/characters/roi.webp"),
      mini: require("@tangow/avatars/characters/roi-mini.webp"),
    },
    mariachi: {
      full: require("@tangow/avatars/characters/mariachi.webp"),
      mini: require("@tangow/avatars/characters/mariachi-mini.webp"),
    },
    viking: {
      full: require("@tangow/avatars/characters/viking.webp"),
      mini: require("@tangow/avatars/characters/viking-mini.webp"),
    },
    monstre: {
      full: require("@tangow/avatars/characters/monstre.webp"),
      mini: require("@tangow/avatars/characters/monstre-mini.webp"),
    },
    toutankit: {
      full: require("@tangow/avatars/characters/toutankit.webp"),
      mini: require("@tangow/avatars/characters/toutankit-mini.webp"),
    },
    "docteur-disquette": {
      full: require("@tangow/avatars/characters/docteur-disquette.webp"),
      mini: require("@tangow/avatars/characters/docteur-disquette-mini.webp"),
    },
  };

/** The characters without a face, for the live face to sit on. */
const BODIES: Record<AvatarCharacterId, ImageSourcePropType> = {
  scout: require("@tangow/avatars/bodies/scout.webp"),
  atlas: require("@tangow/avatars/bodies/atlas.webp"),
  ivy: require("@tangow/avatars/bodies/ivy.webp"),
  "saint-demon": require("@tangow/avatars/bodies/saint-demon.webp"),
  sorciere: require("@tangow/avatars/bodies/sorciere.webp"),
  roi: require("@tangow/avatars/bodies/roi.webp"),
  mariachi: require("@tangow/avatars/bodies/mariachi.webp"),
  viking: require("@tangow/avatars/bodies/viking.webp"),
  monstre: require("@tangow/avatars/bodies/monstre.webp"),
  toutankit: require("@tangow/avatars/bodies/toutankit.webp"),
  "docteur-disquette": require("@tangow/avatars/bodies/docteur-disquette.webp"),
};

/** The exported images are cropped from a 1024 px square. */
const SOURCE_SIDE = 1024;

/**
 * A clay character in a round disc, as on web: the still image, or with a `face` the body with
 * its face drawn live, once the body has loaded. At 20 pt and below it is always the simplified
 * still. Images are drawn in SVG, framed by the crop's viewBox: a native `Image` in the thread's
 * transparent header title blurred the whole thread on iOS 26+. The disc is the translucent
 * `avatarDisc` veil, so it holds over every part of the ambient light.
 */
export function ClayAvatar({
  character,
  size,
  isWorking,
  face = null,
}: {
  character: string | null;
  size: number;
  isWorking: boolean;
  face?: FaceState | null;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const { id, crops } = characterById(character);
  const crop = crops[cropForSize(size)];
  const mini = size <= CLAY_MINI_MAX_SIZE;
  const live = face !== null && !mini;
  // The still stays mounted under a live face, so it shows at once when the face goes still.
  const [ready, setReady] = useState<string | null>(null);
  if (!live && ready !== null) setReady(null);
  return (
    <View
      style={{ width: size, height: size }}
      accessible={isWorking || undefined}
      accessibilityLabel={isWorking ? t("Working") : undefined}
    >
      <View
        style={[
          styles.disc,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: tokens.avatarDisc },
        ]}
      >
        <View style={{ opacity: live && ready === id ? 0 : 1 }}>
          <Svg width={size} height={size} viewBox={`${crop.x} ${crop.y} ${crop.side} ${crop.side}`}>
            <SvgImage
              href={IMAGES[id][mini ? "mini" : "full"]}
              width={SOURCE_SIDE}
              height={SOURCE_SIDE}
            />
          </Svg>
        </View>
        {live ? (
          <ClayFace
            key={id}
            face={faceFor(id)}
            body={BODIES[id]}
            crop={crop}
            size={size}
            state={face}
            onReady={() => setReady(id)}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  disc: { overflow: "hidden" },
});

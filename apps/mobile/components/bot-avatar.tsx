import { isWorkingStatus } from "@tangow/core";
import { memo } from "react";
import { View } from "react-native";
import { faceFor } from "../lib/clay-face";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { useClayFaceState } from "../lib/use-clay-face-state";
import { ClayAvatar } from "./clay-avatar";
import { NativeSymbol } from "./native-symbol";

/** A bot's clay character, in a round disc. A missing or unknown character is the neutral one. */
export const BotAvatar = memo(function BotAvatar({
  size = 54,
  status,
  character,
  muted = false,
  live = false,
  still = false,
}: {
  size?: number;
  status?: string;
  character?: string | null;
  muted?: boolean;
  /** Keeps the face alive at rest too; otherwise it only comes alive while the bot works. */
  live?: boolean;
  /** Never alive, as in a group's pile: the still image, still marked working. */
  still?: boolean;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const face = useClayFaceState(status, faceFor(character).defaut, live);
  return (
    <View style={{ width: size, height: size }}>
      <ClayAvatar
        character={character ?? null}
        size={size}
        isWorking={isWorkingStatus(status)}
        face={still ? null : face}
      />
      {muted ? (
        <View
          accessible
          accessibilityLabel={t("Notifications silenced")}
          style={{
            position: "absolute",
            right: -2,
            bottom: -2,
            width: Math.max(14, Math.round(size * 0.34)),
            height: Math.max(14, Math.round(size * 0.34)),
            borderRadius: size,
            borderWidth: 2,
            borderColor: "#000",
            backgroundColor: "#242428",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <NativeSymbol
            ios="bell.slash.fill"
            android="notifications-off"
            size={Math.max(8, Math.round(size * 0.17))}
            color={tokens.foreground}
          />
        </View>
      ) : null}
    </View>
  );
});

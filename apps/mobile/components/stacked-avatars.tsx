import type { ViewProps } from "react-native";
import { StyleSheet, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useThemedStyles } from "../lib/native";
import type { StackedAvatarSize } from "../lib/stacked-avatars-layout";
import { STACKED_AVATAR_OVERLAP, stackedAvatarsLayout } from "../lib/stacked-avatars-layout";
import { nativeTextStyle } from "../lib/typography";
import { BotAvatar } from "./bot-avatar";

export type { StackedAvatarSize };

export interface StackedAvatarItem {
  identity?: string;
  working?: boolean;
  character?: string | null;
}

export interface StackedAvatarsProps extends Omit<ViewProps, "children"> {
  items: StackedAvatarItem[];
  size: StackedAvatarSize;
  /** Avatars shown before the rest collapses into `+N`. */
  max?: number;
  /**
   * Translated name for the group ("Maya, Atlas and 2 more"). Without it the
   * stack is decoration and is hidden from assistive technology, which is
   * right when the sentence beside it already names the bots.
   */
  label?: string;
  /**
   * `28`-size header variant (design contract §C/§D): the overflow beyond
   * `max` renders as a round `+n` pill (`muted` fill, 12/600 `foreground`, 2px
   * `background` ring) instead of the plain `+N` label every other stack size
   * uses.
   */
  pillOverflow?: boolean;
}

/**
 * The bots behind a group, a delegation or a receipt, in one glance. Mirrors
 * `packages/ui-web/src/stacked-avatars.tsx`.
 */
export function StackedAvatars({
  items,
  size,
  max = 3,
  label,
  pillOverflow = false,
  style,
  ...props
}: StackedAvatarsProps) {
  const styles = useThemedStyles(createStackedAvatarsStyles);
  const { shown, overflow } = stackedAvatarsLayout(items, max);
  const overlap = STACKED_AVATAR_OVERLAP[size];
  return (
    <View
      accessible={Boolean(label)}
      accessibilityRole={label ? "image" : undefined}
      accessibilityLabel={label}
      accessibilityElementsHidden={!label}
      importantForAccessibility={label ? "yes" : "no-hide-descendants"}
      style={[styles.row, style]}
      {...props}
    >
      {shown.map((item, index) => (
        <View
          key={item.identity ?? index}
          style={index === 0 ? undefined : { marginStart: -overlap }}
        >
          <BotAvatar
            character={item.character}
            size={size}
            status={item.working ? "running" : undefined}
            still
          />
        </View>
      ))}
      {overflow > 0 ? (
        pillOverflow ? (
          <View
            style={[
              styles.pill,
              { width: size, height: size, borderRadius: size / 2, marginStart: -overlap },
            ]}
          >
            <Text style={styles.pillText}>{`+${overflow}`}</Text>
          </View>
        ) : (
          <Text style={styles.overflow}>{`+${overflow}`}</Text>
        )
      ) : null}
    </View>
  );
}

function createStackedAvatarsStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
    },
    overflow: {
      paddingStart: 4,
      color: tokens.mutedForeground,
      ...nativeTextStyle("label"),
    },
    pill: {
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: tokens.muted,
      borderWidth: 2,
      borderColor: tokens.background,
    },
    pillText: {
      color: tokens.foreground,
      fontSize: 12,
      fontWeight: "600",
    },
  });
}

import { sizes } from "@tangow/ui-tokens";
import type { ReactNode } from "react";
import type { ViewProps } from "react-native";
import { StyleSheet, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";

export interface MessageRowProps extends Omit<ViewProps, "children"> {
  /** A working `BotAvatar` at `sizes.message` (32). Ignored in `mono`. */
  avatar?: ReactNode;
  /** The bot's name, 13/500. Ignored in `mono`. */
  author?: ReactNode;
  /** Group head (design contract § Grouping, `isFirstOfGroup`): show `author`
   * above the row. Ignored in `mono`, which never shows a name. */
  showAuthor?: boolean;
  /** Group foot (`isLastOfGroup`): show `avatar` at the bottom of the row. The
   * avatar column stays reserved even when this is false, so the rest of the
   * group's rows line up under it. Ignored in `mono`, which has no column. */
  showAvatar?: boolean;
  /**
   * Mono-bot grammar (design contract §3b): no avatar column, no author, ever
   * — the bot's identity lives in the header instead. Multi (default: false)
   * reserves the avatar column and shows `author`/`avatar` per the flags
   * above.
   */
  mono?: boolean;
  children: ReactNode;
  /** Anchored beside the row — mobile has no hover, so this is for a caller
   * that wants a persistent trailing element (rare; usually omitted). */
  trailing?: ReactNode;
}

/**
 * The scaffold around a bot row's content: the avatar/name grammar (mono vs
 * multi), never the visual bubble itself — a narration message's bubble lives
 * in `MessageText`, a card (`FramedBlock`, `Surface`, an attachment) brings
 * its own. This lets a card sit in the same grouped row as narration without
 * picking up a bubble fill. Mirrors `packages/ui-web/src/message-row.tsx`.
 */
export function MessageRow({
  avatar,
  author,
  showAuthor = false,
  showAvatar = false,
  mono = false,
  children,
  trailing,
  style,
  ...props
}: MessageRowProps) {
  const styles = useThemedStyles(createMessageRowStyles);

  if (mono) {
    return (
      <View style={[styles.rootMono, style]} {...props}>
        <View style={styles.contentMono}>{children}</View>
        {trailing}
      </View>
    );
  }

  return (
    <View style={[styles.root, style]} {...props}>
      <View style={styles.avatarColumn}>{showAvatar ? avatar : null}</View>
      <View style={styles.content}>
        {showAuthor ? (
          <Text numberOfLines={1} style={styles.author}>
            {author}
          </Text>
        ) : null}
        {children}
      </View>
      {trailing}
    </View>
  );
}

function createMessageRowStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    root: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 8,
    },
    rootMono: {
      flexDirection: "row",
    },
    avatarColumn: {
      width: sizes.message,
      flexShrink: 0,
    },
    content: {
      flex: 1,
      minWidth: 0,
    },
    contentMono: {
      flex: 1,
      minWidth: 0,
    },
    author: {
      paddingStart: 12,
      marginBottom: 1,
      color: tokens.foreground,
      ...nativeTextStyle("author"),
    },
  });
}

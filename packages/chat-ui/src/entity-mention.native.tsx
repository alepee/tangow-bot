import type { ColorTokens } from "@tangow/ui-tokens";
import { radii, sizes } from "@tangow/ui-tokens";
import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import type { TextProps } from "react-native";
import { StyleSheet, Text, View } from "react-native";
import type { EntityMentionCatalog, EntityMentionKind } from "./entity-mention";
import { entityMentionShape, entityTokens } from "./entity-mention";
import { veil } from "./link-underline";

/** The thread's catalog on a phone. The host fills the glyph: a bot's face, or the kind's symbol in `tint`. */
export interface NativeEntityMentions extends EntityMentionCatalog {
  glyph(
    mention: { kind: EntityMentionKind; avatarCharacter?: string | null },
    tint: string,
  ): ReactNode;
}

const NativeEntityMentionsContext = createContext<NativeEntityMentions | undefined>(undefined);

/** Gives every bubble under it the names it draws in place; keep `value` referentially stable. */
export const NativeEntityMentionsProvider = NativeEntityMentionsContext.Provider;

export function useNativeEntityMentions(): NativeEntityMentions | undefined {
  return useContext(NativeEntityMentionsContext);
}

/** The colours a mention's tile takes from its bubble. */
export interface EntityMentionTone {
  round: string;
  square: string;
  hairline?: string;
  glyph: string;
}

/** A bot bubble: the avatar disc for who answers, the link mention tile for what gets used. */
export function botEntityMentionTone(palette: ColorTokens): EntityMentionTone {
  return {
    round: palette.avatarDisc,
    square: palette.linkMentionTile,
    hairline: veil(palette.foreground, 0.1),
    glyph: palette.mutedForeground,
  };
}

/** The person's bubble: a 16% veil of its ink and no hairline; the symbol takes the ink. */
export function personEntityMentionTone(ink: string): EntityMentionTone {
  const tile = veil(ink, 0.16);
  return { round: tile, square: tile, glyph: ink };
}

/** Keeps the glyph and the name's first word on one line. */
const WORD_JOINER = "⁠";

/**
 * A run of a message's text with every name the thread knows drawn in place: the glyph as an
 * inline view glued to the semibold name, like a link mention. Nested text cannot ellipsize, so a
 * long name wraps like the words around it.
 */
export function nativeEntityTokens({
  text,
  entities,
  tone,
  leads,
  style,
}: {
  text: string;
  entities: NativeEntityMentions | undefined;
  tone: EntityMentionTone;
  /** Only the start of the message can open with a skill. */
  leads: boolean;
  style?: TextProps["style"];
}): ReactNode[] {
  return entityTokens(text, entities, leads).map((token, i) => {
    if (token.kind === "text") return token.text;
    const shape = entityMentionShape(token.kind);
    return (
      <Text key={i} style={[style, styles.name]}>
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.frame}
        >
          <View
            style={[
              styles.tile,
              shape === "square" ? styles.square : null,
              shape === "avatar" ? null : { backgroundColor: tone[shape] },
            ]}
          >
            {shape === "square" && tone.hairline ? (
              <View style={[styles.hairline, { borderColor: tone.hairline }]} />
            ) : null}
            {entities?.glyph(token, tone.glyph)}
          </View>
        </View>
        {WORD_JOINER}
        {`⁨${token.name}⁩`}
      </Text>
    );
  });
}

const styles = StyleSheet.create({
  name: {
    fontWeight: "600",
  },
  // The gap is part of the inline view: nested text has no margins to lend it.
  frame: {
    width: sizes.mentionGlyph + sizes.mentionGap,
    height: sizes.mentionGlyph,
  },
  tile: {
    width: sizes.mentionGlyph,
    height: sizes.mentionGlyph,
    borderRadius: sizes.mentionGlyph / 2,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  square: {
    borderRadius: radii.linkMention,
  },
  hairline: {
    ...StyleSheet.absoluteFill,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.linkMention,
  },
});

import type { NativeEntityMentions } from "@tangow/chat-ui/native";
import { sizes } from "@tangow/ui-tokens";
import { BotAvatar } from "./bot-avatar";
import { NativeSymbol } from "./native-symbol";

const ENTITY_SYMBOLS = {
  group: { ios: "person.2.fill", android: "people" },
  everyone: { ios: "at", android: "at" },
  skill: { ios: "cube", android: "cube-outline" },
  routine: { ios: "clock", android: "time-outline" },
  connector: { ios: "puzzlepiece.extension", android: "extension-puzzle-outline" },
} as const;

/** What fills a mention's 16 pt glyph in a bubble: the bot's face, or its kind's symbol. */
export function EntityMentionGlyph({
  mention,
  tint,
}: {
  mention: Parameters<NativeEntityMentions["glyph"]>[0];
  tint: string;
}) {
  if (mention.kind === "bot") {
    return <BotAvatar character={mention.avatarCharacter} size={sizes.mentionGlyph} />;
  }
  const symbol = ENTITY_SYMBOLS[mention.kind];
  return (
    <NativeSymbol
      ios={symbol.ios}
      android={symbol.android}
      size={sizes.mentionGlyph * 0.625}
      color={tint}
    />
  );
}

import type { ComposerMentionKind } from "@tangow/core";
import { messageSegments } from "@tangow/core";

export type EntityMentionKind = ComposerMentionKind | "skill";

export type EntityMentionTarget = {
  kind: ComposerMentionKind;
  name: string;
  avatarCharacter?: string | null;
};

/** What the client can name in a message; anything else it reads stays text. */
export interface EntityMentionCatalog {
  mentions: readonly EntityMentionTarget[];
  skills: readonly { name: string }[];
}

/** A bot shows its face; a circle is who can answer, a square what gets used. */
export function entityMentionShape(kind: EntityMentionKind): "avatar" | "round" | "square" {
  if (kind === "bot") return "avatar";
  return kind === "group" || kind === "everyone" ? "round" : "square";
}

export type EntityToken =
  | { kind: "text"; text: string }
  | { kind: EntityMentionKind; name: string; avatarCharacter?: string | null };

/** A run of a message's text as text and mentions; only text that `leads` the message can open with a skill. */
export function entityTokens(
  text: string,
  catalog: EntityMentionCatalog | undefined,
  leads: boolean,
): EntityToken[] {
  if (!catalog) return [{ kind: "text", text }];
  return messageSegments(text, catalog.mentions, leads ? catalog.skills : []).map((segment) => {
    if (segment.kind === "text") return { kind: "text", text: segment.text };
    if (segment.kind === "skill") return { kind: "skill", name: segment.text.slice(1) };
    return {
      kind: segment.mention.kind,
      name: segment.text.slice(1),
      avatarCharacter: segment.mention.avatarCharacter,
    };
  });
}

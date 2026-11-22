import { EntityMentionField } from "@tangow/chat-ui/web";
import type { AgentSkillCatalogEntry } from "@tangow/contracts";
import type { ComposerMention, MentionSegment } from "@tangow/core";
import { BotAvatar, cn } from "@tangow/ui-web";
import type { RefObject } from "react";

const ZERO_WIDTH_SPACE = "\u200b";

export type DraftSegment = MentionSegment<ComposerMention, AgentSkillCatalogEntry>;

/**
 * A copy of the draft drawn over its textarea, whose own text turns transparent: same type, same
 * box, same wrapping, so the caret and the selection stay the textarea's while the picked skill
 * and mentions show in place. It never takes a pointer; the textarea's scroll moves it.
 */
export function DraftMirror({
  segments,
  selection,
  mirrorRef,
  className,
}: {
  segments: readonly DraftSegment[];
  /** The textarea's selection: a token it covers whole shows selected. */
  selection: readonly [number, number];
  mirrorRef: RefObject<HTMLDivElement | null>;
  /** The textarea's type and box classes, so both lay the text out alike. */
  className: string;
}) {
  const [from, to] = selection;
  const last = segments.at(-1);
  return (
    <div
      aria-hidden="true"
      data-slot="composer-mirror"
      dir="auto"
      className={cn(
        className,
        "pointer-events-none absolute inset-0 overflow-x-visible overflow-y-clip whitespace-pre-wrap wrap-break-word text-foreground",
      )}
    >
      <div ref={mirrorRef}>
        {segments.map((segment) =>
          segment.kind === "text" ? (
            segment.text
          ) : (
            <EntityMentionField
              key={segment.start}
              kind={segment.kind === "skill" ? "skill" : segment.mention.kind}
              text={segment.text}
              avatar={
                segment.kind === "mention" && segment.mention.kind === "bot" ? (
                  <BotAvatar character={segment.mention.avatarCharacter} size={16} />
                ) : undefined
              }
              selected={
                from < to && from <= segment.start && to >= segment.start + segment.text.length
              }
            />
          ),
        )}
        {/* A trailing line break opens a line in the textarea; give it one here too. */}
        {last?.kind === "text" && last.text.endsWith("\n") ? ZERO_WIDTH_SPACE : null}
      </div>
    </div>
  );
}

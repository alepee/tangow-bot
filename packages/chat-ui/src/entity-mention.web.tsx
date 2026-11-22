import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import type { EntityMentionCatalog, EntityMentionKind } from "./entity-mention";
import { entityMentionShape } from "./entity-mention";

/** The thread's catalog, with the face a bot mention shows in its glyph. */
export interface EntityMentions extends EntityMentionCatalog {
  avatar(character: string | null | undefined): ReactNode;
}

const EntityMentionsContext = createContext<EntityMentions | undefined>(undefined);

/** Gives every bubble under it the names it draws in place; keep `value` referentially stable. */
export const EntityMentionsProvider = EntityMentionsContext.Provider;

export function useEntityMentions(): EntityMentions | undefined {
  return useContext(EntityMentionsContext);
}

const KIND_PATHS: Record<Exclude<EntityMentionKind, "bot">, ReactNode> = {
  group: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.6.8 2.6 2.5 3 5.2" />
    </>
  ),
  everyone: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </>
  ),
  skill: (
    <>
      <path d="M21 8 12 3 3 8v8l9 5 9-5z" />
      <path d="M3 8l9 5 9-5M12 13v8" />
    </>
  ),
  routine: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  connector: (
    <path d="M10 3h4v3a2 2 0 1 0 4 0V3h3v7h-3a2 2 0 1 0 0 4h3v7h-7v-3a2 2 0 1 0-4 0v3H3v-7h3a2 2 0 1 0 0-4H3V3z" />
  ),
};

/** The 16 px glyph: the bot's face, or the kind's icon on its circle or square tile. */
export function EntityMentionGlyph({
  kind,
  avatar,
}: {
  kind: EntityMentionKind;
  /** The bot's face filling the frame. */
  avatar?: ReactNode;
}) {
  return (
    <span
      className="rk-entity-mention-glyph"
      data-shape={entityMentionShape(kind)}
      aria-hidden="true"
    >
      {kind === "bot" ? (
        avatar
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {KIND_PATHS[kind]}
        </svg>
      )}
    </span>
  );
}

/**
 * A bot, group, everyone or skill named in a message: its glyph glued to its name, in place in
 * the sentence. One line box tall and never broken, the name ending in an ellipsis rather than
 * widen the bubble.
 */
export function EntityMention({
  kind,
  name,
  avatar,
  ink = false,
}: {
  kind: EntityMentionKind;
  /** The name as written, without its `@` or `/`. */
  name: string;
  avatar?: ReactNode;
  /** In plain text that keeps its bubble's ink (the person's words): the tile is a veil of it. */
  ink?: boolean;
}) {
  return (
    <span
      data-slot="entity-mention"
      data-kind={kind}
      className={ink ? "rk-entity-mention rk-entity-mention-ink" : "rk-entity-mention"}
      title={name}
    >
      <EntityMentionGlyph kind={kind} avatar={avatar} />
      <bdi className="rk-entity-mention-name">{name}</bdi>
    </span>
  );
}

/**
 * The same mention inside the composer's mirror of its textarea: the token's own text (`@Name` or
 * `/skill`), so every character keeps the field's advance width and the caret stays aligned. The
 * glyph is drawn over the `@`, or in the field's first-line indent for a leading skill; the
 * weight is faked with a stroke, since a real one would widen the text.
 */
export function EntityMentionField({
  kind,
  text,
  avatar,
  selected = false,
}: {
  kind: EntityMentionKind;
  text: string;
  avatar?: ReactNode;
  selected?: boolean;
}) {
  return (
    <span
      data-slot="entity-mention-field"
      data-kind={kind}
      data-selected={selected || undefined}
      className="rk-entity-mention-field"
    >
      <span className="rk-entity-mention-prefix">
        {text.slice(0, 1)}
        <EntityMentionGlyph kind={kind} avatar={avatar} />
      </span>
      {text.slice(1)}
    </span>
  );
}

import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { AgentSkillCatalogEntry } from "@tangow/contracts";
import type { ComposerMention, SlashActionId } from "@tangow/core";
import {
  clampMentionHighlightIndex,
  mentionChipKey,
  mentionQueryAt,
  SLASH_ACTIONS,
  slashSkillOptions as slashSkills,
  truncateSlashDescription,
} from "@tangow/core";
import { BotAvatar } from "@tangow/ui-web";
import { Box, Clock, Puzzle, Settings } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";

/** The `@` and `/` pickers: what the draft is asking for and what they offer for it. */
export function useComposerPickers({
  mentionTargets,
  agentSkills,
  onSlashOpen,
  chatSettings = true,
}: {
  mentionTargets?: ComposerMention[];
  agentSkills?: AgentSkillCatalogEntry[];
  onSlashOpen?: () => void;
  /** False in a thread with a bot shared with you, whose settings are its owner's. */
  chatSettings?: boolean;
}) {
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  /** Where the `@` of the query being typed sits in the draft. */
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [mentionHighlightIndex, setMentionHighlightIndex] = useState(0);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const mentionListboxId = useId();

  /** Reads the draft for an `@query` right before the caret, unless it is a picked token. */
  function trackCaret(value: string, caret: number, picked: readonly ComposerMention[]) {
    const mention = mentionQueryAt(value, caret, picked);
    setMentionQuery(mention?.query ?? null);
    setMentionStart(mention?.start ?? null);
  }

  /** Reads the edited draft for an `@query` at the caret or a leading `/query`. */
  function trackDraft(
    value: string,
    caret: number,
    slashAllowed: boolean,
    picked: readonly ComposerMention[],
  ) {
    trackCaret(value, caret, picked);
    // `/` only at the start of the draft so forced skills expand (`Use skill:` / `/Name` prefix).
    const slashMatch = slashAllowed ? /^\/([^\n]*)$/.exec(value) : null;
    const nextSlash = slashMatch ? (slashMatch[1] ?? "") : null;
    if (nextSlash !== null && slashQuery === null) onSlashOpen?.();
    setSlashQuery(nextSlash);
  }

  function closeMentions() {
    setMentionQuery(null);
    setMentionHighlightIndex(0);
  }

  function closeSlash() {
    setSlashQuery(null);
  }

  function closeAll() {
    closeMentions();
    closeSlash();
  }

  const mentionOptions = useMemo(() => {
    if (mentionQuery === null || !mentionTargets?.length) return [];
    const query = mentionQuery.trim().toLowerCase();
    return mentionTargets
      .filter((target) => !query || target.name.toLowerCase().startsWith(query))
      .slice(0, 10);
  }, [mentionQuery, mentionTargets]);

  useEffect(() => {
    setMentionHighlightIndex(0);
  }, [mentionQuery, mentionOptions]);

  const activeMentionIndex = clampMentionHighlightIndex(
    mentionHighlightIndex,
    mentionOptions.length,
  );
  const mentionPickerOpen = mentionOptions.length > 0;
  const activeMentionOptionId = mentionPickerOpen
    ? `${mentionListboxId}-option-${activeMentionIndex}`
    : undefined;

  const slashSkillOptions = useMemo(
    () => (slashQuery === null ? [] : slashSkills(agentSkills ?? [], slashQuery)),
    [agentSkills, slashQuery],
  );

  const slashActionOptions = useMemo(() => {
    if (slashQuery === null) return [];
    const query = slashQuery.trim().toLowerCase();
    // The picker shows each action under its own label, so a search matches that label too.
    return SLASH_ACTIONS.filter(
      (action) =>
        (chatSettings || action.id !== "chat-settings") &&
        (!query ||
          action.label.toLowerCase().includes(query) ||
          slashActionLabel(action.id).toLowerCase().includes(query)),
    );
  }, [slashQuery, chatSettings]);

  const showSlashPicker =
    slashQuery !== null &&
    mentionQuery === null &&
    (slashSkillOptions.length > 0 || slashActionOptions.length > 0);

  return {
    trackDraft,
    trackCaret,
    mentionStart,
    closeMentions,
    closeSlash,
    closeAll,
    setMentionHighlightIndex,
    mentionListboxId,
    mentionOptions,
    activeMentionIndex,
    mentionPickerOpen,
    activeMentionOptionId,
    slashSkillOptions,
    slashActionOptions,
    showSlashPicker,
  };
}

export function MentionPicker({
  id,
  options,
  activeIndex,
  onPick,
  onHighlight,
}: {
  id: string;
  options: ComposerMention[];
  activeIndex: number;
  onPick: (mention: ComposerMention) => void;
  onHighlight: (index: number) => void;
}) {
  const { t } = useLingui();
  return (
    <div
      id={id}
      role="listbox"
      aria-label={t`Mentions`}
      data-testid="mention-picker"
      className="mb-2 overflow-hidden rounded-card border border-border bg-muted"
    >
      {options.map((mention, index) => {
        const optionId = `${id}-option-${index}`;
        const highlighted = index === activeIndex;
        return (
          <button
            id={optionId}
            key={mentionChipKey(mention)}
            type="button"
            role="option"
            aria-selected={highlighted}
            aria-label={t`@${mention.name}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(mention)}
            onMouseEnter={() => onHighlight(index)}
            className={`flex w-full items-start gap-3 px-4 py-2.5 text-start hover:bg-accent ${
              highlighted ? "bg-accent" : ""
            }`}
          >
            <MentionOptionIcon mention={mention} />
            <span className="min-w-0">
              <span dir="auto" className="block text-capsule text-foreground">
                @{mention.name}
              </span>
              {mention.subtitle ? (
                <span dir="auto" className="block truncate text-label text-muted-foreground">
                  {mention.subtitle}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function SlashPicker({
  skills,
  actions,
  onSkill,
  onAction,
}: {
  skills: AgentSkillCatalogEntry[];
  actions: readonly { id: SlashActionId }[];
  onSkill: (skill: AgentSkillCatalogEntry) => void;
  onAction: (action: SlashActionId) => void;
}) {
  const { t } = useLingui();
  return (
    <div
      data-testid="slash-picker"
      className="mb-2 overflow-hidden rounded-card border border-border bg-muted"
    >
      {skills.map((skill) => (
        <button
          key={skill.id}
          type="button"
          aria-label={t`Skill ${skill.name}`}
          onClick={() => onSkill(skill)}
          className="flex w-full items-start gap-3 px-4 py-2.5 text-start hover:bg-accent"
        >
          <Box size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span dir="auto" className="block text-capsule text-foreground">
              {skill.name}
            </span>
            <span dir="auto" className="block truncate text-label text-muted-foreground">
              {truncateSlashDescription(skill.description)}
            </span>
          </span>
        </button>
      ))}
      {actions.map((action) => {
        const label = slashActionLabel(action.id);
        return (
          <button
            key={action.id}
            type="button"
            aria-label={label}
            onClick={() => onAction(action.id)}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-start hover:bg-accent"
          >
            <Settings size={16} strokeWidth={1.7} className="shrink-0 text-muted-foreground" />
            <span className="text-capsule text-foreground">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

function slashActionLabel(id: SlashActionId) {
  switch (id) {
    case "chat-settings":
      return t`Bot settings`;
    case "settings-general":
      return t`Settings: General`;
    case "settings-usage":
      return t`Settings: Usage`;
  }
}

function MentionOptionIcon({ mention }: { mention: ComposerMention }) {
  if (mention.kind === "routine") {
    return <Clock size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-muted-foreground" />;
  }
  if (mention.kind === "connector") {
    return <Puzzle size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-muted-foreground" />;
  }
  if (mention.kind === "group") {
    return (
      <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-accent text-[9px] text-foreground/75">
        G
      </span>
    );
  }
  if (mention.kind === "everyone") {
    return (
      <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-accent text-[9px] text-foreground/75">
        @
      </span>
    );
  }
  return <BotAvatar character={mention.avatarCharacter} size={16} />;
}

import { useLingui } from "@lingui/react/macro";
import type { AvatarCharacterId, Bot } from "@tangow/contracts";
import {
  AVATAR_CHARACTERS,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  characterById,
} from "@tangow/contracts";
import type { FieldSaveState } from "@tangow/core";
import type { FieldSave } from "@tangow/ui-web";
import { BotAvatar, SaveMeta, TextSettingField } from "@tangow/ui-web";
import { Check, Pencil } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useId, useRef, useState } from "react";
import { type BotPageContext, useBotField, useSaveLabels } from "./page-kit";

/** Read-only (an archived bot), the name and title still read as text, not as greyed fields. */
const HERO_INPUT =
  "h-auto border-transparent bg-transparent px-2 py-0.5 text-center dark:bg-transparent disabled:bg-transparent disabled:opacity-100 dark:disabled:bg-transparent";

/** The avatar, name and title at the top of the page, each saving on its own unless read-only. */
export function BotHero({ page }: { page: BotPageContext }) {
  const { t } = useLingui();
  const labels = useSaveLabels();
  const { bot, readOnly } = page;
  const name = useBotField(page, "name", bot.name, (value) => ({ name: value }));
  const title = useBotField(page, "title", bot.title, (value) => ({ title: value }));
  const character = useBotField(
    page,
    "avatarCharacter",
    characterById(bot.avatarCharacter).id,
    (value) => ({ avatarCharacter: value }),
  );
  const meta = heroMeta([name, title, character]);

  return (
    <section className="flex flex-col items-center gap-1 px-5 pt-2.5 text-center">
      <CharacterPicker
        bot={bot}
        character={character.value}
        disabled={readOnly}
        onCharacter={(value) => void character.save(value)}
      />
      <TextSettingField
        label={<span className="sr-only">{t`Name`}</span>}
        field={name}
        labels={labels}
        meta={false}
        required
        maxLength={BOT_NAME_MAX_LENGTH}
        disabled={readOnly}
        dir="auto"
        className="mt-3 w-full gap-0"
        controlClassName={`${HERO_INPUT} text-title text-foreground md:text-title`}
      />
      <TextSettingField
        label={<span className="sr-only">{t`Title`}</span>}
        field={title}
        labels={labels}
        meta={false}
        maxLength={BOT_TITLE_MAX_LENGTH}
        disabled={readOnly}
        dir="auto"
        placeholder={t`What it does, in one line`}
        className="w-full gap-0"
        controlClassName={`${HERO_INPUT} text-meta text-muted-foreground md:text-meta`}
      />
      <SaveMeta
        state={meta?.state ?? IDLE}
        labels={labels}
        onRetry={() => void meta?.retry()}
        className="min-h-4"
      />
    </section>
  );
}

const IDLE: FieldSaveState<unknown> = { kind: "idle" };

/** The hero shares one meta line: a failure first, then a save in flight, then the latest save. */
type HeroField = Pick<FieldSave<unknown>, "state" | "retry">;

function heroMeta(fields: HeroField[]): HeroField | undefined {
  return (
    fields.find((field) => field.state.kind === "failed") ??
    fields.find((field) => field.state.kind === "saving") ??
    fields
      .filter((field) => field.state.kind === "saved")
      .sort((a, b) => savedAt(b.state) - savedAt(a.state))[0]
  );
}

function savedAt(state: FieldSaveState<unknown>): number {
  return state.kind === "saved" ? state.at : 0;
}

/** The catalogue, one row per shape, so the family reads in rhythm: balls, capsules, blocks. */
const PICKER_CHARACTERS = (["ball", "capsule", "block"] as const).flatMap((shape) =>
  AVATAR_CHARACTERS.filter((entry) => entry.shape === shape),
);

/** The avatar unfolds the catalogue of clay characters under it; one tap chooses. */
function CharacterPicker({
  bot,
  character,
  disabled,
  onCharacter,
}: {
  bot: Bot;
  character: AvatarCharacterId;
  disabled: boolean;
  onCharacter: (character: AvatarCharacterId) => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [swaps, setSwaps] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const closeOnEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !open) return;
    setOpen(false);
    triggerRef.current?.focus();
  };
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="bot-appearance-trigger"
        aria-label={t`Appearance`}
        aria-expanded={open}
        aria-controls={panelId}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={closeOnEscape}
        className="group relative rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span key={swaps} className={swaps > 0 ? "block animate-swap" : "block"}>
          <BotAvatar character={character} size={80} status={bot.status} live />
        </span>
        {disabled ? null : (
          <span
            aria-hidden
            className="absolute end-0 bottom-0 grid size-6 place-items-center rounded-full bg-surface text-muted-foreground opacity-0 shadow-row duration-(--duration-hover) ease-quiet group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            <Pencil className="size-3" strokeWidth={2} />
          </span>
        )}
      </button>
      {open && !disabled ? (
        <fieldset
          id={panelId}
          data-testid="bot-appearance-picker"
          aria-label={t`Appearance`}
          onKeyDown={closeOnEscape}
          className="mt-3 grid animate-arrive grid-cols-4 justify-items-center gap-y-3.5 self-stretch -mx-1 rounded-card bg-group p-4 shadow-group"
        >
          {PICKER_CHARACTERS.map(({ id, name, shape }, index) => (
            <button
              key={id}
              type="button"
              aria-pressed={character === id}
              aria-label={name}
              onClick={() => {
                if (id === character) return;
                setSwaps((value) => value + 1);
                onCharacter(id);
              }}
              className={`relative rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${
                PICKER_CHARACTERS[index - 1]?.shape !== shape ? "col-start-1" : ""
              }`}
            >
              <BotAvatar character={id} size={64} />
              {character === id ? (
                <span
                  aria-hidden
                  className="absolute end-0 bottom-0 grid size-5 place-items-center rounded-full bg-foreground text-background shadow-row ring-2 ring-group"
                >
                  <Check className="size-3" strokeWidth={3} />
                </span>
              ) : null}
            </button>
          ))}
        </fieldset>
      ) : null}
    </>
  );
}

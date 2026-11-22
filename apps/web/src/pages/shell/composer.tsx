import { useLingui } from "@lingui/react/macro";
import type { AgentSkillCatalogEntry } from "@tangow/contracts";
import type { ComposerChange, ComposerMention, SlashActionId } from "@tangow/core";
import {
  composerSegments,
  insertMentionToken,
  mentionChipKey,
  mentionsInDraft,
  resolveMentionPickerKey,
  serializeComposerPrompt,
  skillInDraft,
} from "@tangow/core";
import type { ComposerState } from "@tangow/ui-web";
import { Button, ComposerShell, cn, StopContour } from "@tangow/ui-web";
import { ArrowUp } from "lucide-react";
import type { ClipboardEvent, KeyboardEvent, RefObject } from "react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isFilePaste } from "../../lib/pending-attachments";
import type { MessageItem } from "../../lib/thread-items";
import type { PreviewLink } from "./composer-attachments";
import { AttachButton, AttachmentTray, useDraftLinkPreview } from "./composer-attachments";
import {
  DictateButton,
  DictationCancel,
  DictationConfirm,
  DictationPreview,
  useComposerDictation,
} from "./composer-dictation";
import { DraftMirror } from "./composer-mirror";
import { ComposerNotices } from "./composer-notices";
import { MentionPicker, SlashPicker, useComposerPickers } from "./composer-pickers";
import type { PendingAttachment } from "./layout";

export const Composer = memo(function Composer({
  activeName,
  answerName,
  running,
  botColor,
  disabled,
  pendingAttachments,
  attachmentNotice,
  sendError,
  runError,
  runErrorId,
  onRunErrorPresented,
  onDismissError,
  sending,
  fileInputRef,
  onAttachmentPick,
  onRemoveAttachment,
  onSend,
  previewLink,
  onStop,
  dictationTranscribe,
  replyTarget,
  replyTargetName,
  onClearReply,
  rewindTarget,
  rewindDraft,
  rewindRemovedCount,
  rewindArtifacts,
  onCancelRewind,
  onRemoveRewindArtifact,
  mentionTargets,
  agentSkills,
  onSlashOpen,
  onSlashAction,
  chatSettings,
  recentWriting,
  onDictatingChange,
}: {
  activeName?: string;
  /** The bot whose pending question the next send answers, from the roster. */
  answerName?: string;
  running: boolean;
  /** The responding bot's identity colour (data, not a token); omitted in a group. */
  botColor?: string;
  disabled?: boolean;
  pendingAttachments: PendingAttachment[];
  attachmentNotice: string | null;
  sendError: string | null;
  runError: string | null;
  runErrorId: string | null;
  onRunErrorPresented: (runId: string) => void;
  onDismissError: () => void;
  sending: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onAttachmentPick: (files: FileList | null) => void | Promise<void>;
  onRemoveAttachment: (attachment: PendingAttachment) => void;
  onSend: (
    text: string,
    mentions?: ComposerMention[],
    options?: { linkPreview?: false },
  ) => Promise<void>;
  /** Reads what the first complete link of the draft looks like; absent, no preview is shown. */
  previewLink?: PreviewLink;
  onStop: () => Promise<void>;
  /** Whether the configured voice provider can transcribe — the dictation
   * engine used when Web Speech isn't available (Electron, most non-Chrome
   * browsers). */
  dictationTranscribe?: boolean;
  replyTarget?: MessageItem | null;
  replyTargetName?: string;
  onClearReply?: () => void;
  rewindTarget?: MessageItem | null;
  rewindDraft?: { key: string; text: string; linkPreviewRemoved?: boolean } | null;
  rewindRemovedCount?: number;
  rewindArtifacts?: { id: string; name: string }[];
  onCancelRewind?: () => void;
  onRemoveRewindArtifact?: (artifactId: string) => void;
  mentionTargets?: ComposerMention[];
  agentSkills?: AgentSkillCatalogEntry[];
  onSlashOpen?: () => void;
  onSlashAction?: (action: SlashActionId) => void;
  /** False in a thread with a bot shared with you: "/" offers no chat settings. */
  chatSettings?: boolean;
  /** The person's own recent messages here, to dictate in the language they
   * write in (`dictationLangFor`) rather than the browser's own language. */
  recentWriting?: () => readonly string[];
  /** Files dropped on the conversation are ignored while dictating, as they are while `disabled`. */
  onDictatingChange?: (dictating: boolean) => void;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState("");
  const { linkPreview, linkPreviewView, draftChange } = useDraftLinkPreview(draft, previewLink);
  const pickers = useComposerPickers({ mentionTargets, agentSkills, onSlashOpen, chatSettings });
  const [selectedSkill, setSelectedSkill] = useState<AgentSkillCatalogEntry | null>(null);
  const [selectedMentions, setSelectedMentions] = useState<ComposerMention[]>([]);
  const [selection, setSelection] = useState<readonly [number, number]>([0, 0]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const segments = composerSegments(draft, selectedMentions, selectedSkill);
  const tokens = segments.filter((segment) => segment.kind !== "text");
  const skillLeads = segments[0]?.kind === "skill";
  const canSend =
    draft.trim().length > 0 || pendingAttachments.length > 0 || (rewindArtifacts?.length ?? 0) > 0;

  const rewindDraftKey = rewindDraft?.key ?? null;
  const rewindDraftText = rewindDraft?.text ?? "";
  const rewindDraftLinkPreviewRemoved = rewindDraft?.linkPreviewRemoved ?? false;

  useEffect(() => {
    if (!rewindDraftKey) return;
    setDraft(rewindDraftText);
    if (rewindDraftLinkPreviewRemoved) linkPreview.remove();
    textareaRef.current?.focus();
  }, [rewindDraftKey, rewindDraftText, rewindDraftLinkPreviewRemoved, linkPreview]);

  const {
    isDictating,
    dictateSpeech,
    dictatedPrefix,
    dictateFinishing,
    dictationAvailable,
    dictationError,
    setDictationError,
    dictationPreviewRef,
    startDictation,
    cancelDictation,
    insertDictation,
  } = useComposerDictation({
    disabled,
    dictationTranscribe,
    recentWriting,
    draft,
    setDraft,
    selectedMentions,
    setSelectedMentions,
    selectedSkill,
    setSelectedSkill,
    textareaRef,
    onStart: pickers.closeAll,
  });

  // The Stop contour carries the "a run is going" signal now; the shell's own
  // state only distinguishes an empty field from one that can send.
  const composerState: ComposerState = isDictating ? "dictating" : canSend ? "typing" : "idle";

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    function syncHeight() {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.style.height = "0px";
      textarea.style.height = `${textarea.scrollHeight}px`;
      syncMirror();
    }

    syncHeight();
    let lastWidth = el.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const width = textarea.getBoundingClientRect().width;
      if (width === lastWidth) return;
      lastWidth = width;
      syncHeight();
    });
    observer.observe(el);
    return () => observer.disconnect();
    // The textarea unmounts while dictating (swapped for the read-only
    // preview) and remounts with no inline height on exit — re-run once
    // `isDictating` flips back so a multi-line draft re-measures instead of
    // coming back as a single line.
  }, [draft, isDictating]);

  /** The mirror follows the textarea's scroll, and leaves room for a scrollbar that takes width. */
  function syncMirror() {
    const textarea = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!textarea || !mirror) return;
    mirror.style.translate = `0 ${-textarea.scrollTop}px`;
    mirror.style.paddingInlineEnd = `${textarea.offsetWidth - textarea.clientWidth}px`;
  }

  useLayoutEffect(syncMirror);

  /** A picked skill or mention lives as long as its token text: editing it away drops it. */
  function updateDraft(value: string, change: ComposerChange = "type", caret = value.length) {
    draftChange.current = change;
    setDraft(value);
    const mentions = mentionsInDraft(value, selectedMentions);
    if (mentions.length !== selectedMentions.length) setSelectedMentions(mentions);
    const skill = skillInDraft(value, selectedSkill);
    if (skill !== selectedSkill) setSelectedSkill(skill);
    pickers.trackDraft(value, caret, skill === null, mentions);
  }

  /** Where the caret goes once the draft just set has rendered. */
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    const textarea = textareaRef.current;
    if (caret === null || !textarea) return;
    pendingCaret.current = null;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
  });

  function placeCaret(caret: number) {
    pendingCaret.current = caret;
  }

  function insertMention(mention: ComposerMention) {
    const caret = textareaRef.current?.selectionStart ?? draft.length;
    const next = insertMentionToken(draft, pickers.mentionStart ?? caret, caret, mention.name);
    setDraft(next.draft);
    pickers.closeMentions();
    setSelectedMentions((current) =>
      current.some((selected) => mentionChipKey(selected) === mentionChipKey(mention))
        ? current
        : [...current, mention],
    );
    placeCaret(next.caret);
  }

  function insertSkill(skill: AgentSkillCatalogEntry) {
    const next = `/${skill.name} `;
    setSelectedSkill(skill);
    setDraft(next);
    pickers.closeSlash();
    placeCaret(next.length);
  }

  /**
   * A token moves and deletes as one: the caret steps over it, and Backspace or Delete next to it
   * first selects it whole, so the next press removes it.
   */
  function handleTokenKey(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
    const textarea = event.currentTarget;
    const caret = textarea.selectionStart;
    if (caret !== textarea.selectionEnd) return false;
    const rtl = getComputedStyle(textarea).direction === "rtl";
    const back = event.key === "Backspace" || event.key === (rtl ? "ArrowRight" : "ArrowLeft");
    const forward = event.key === "Delete" || event.key === (rtl ? "ArrowLeft" : "ArrowRight");
    if (!back && !forward) return false;
    const token = tokens.find((segment) =>
      back ? segment.start + segment.text.length === caret : segment.start === caret,
    );
    if (!token) return false;
    event.preventDefault();
    const end = token.start + token.text.length;
    if (event.key === "Backspace" || event.key === "Delete") {
      textarea.setSelectionRange(token.start, end);
    } else {
      const to = back ? token.start : end;
      textarea.setSelectionRange(to, to);
    }
    return true;
  }

  function runSlashAction(action: SlashActionId) {
    setDraft("");
    pickers.closeSlash();
    onSlashAction?.(action);
  }

  function send() {
    if (!canSend || sending || disabled) return;
    const text = serializeComposerPrompt(draft, selectedSkill);
    setDraft("");
    pickers.closeAll();
    setSelectedSkill(null);
    const mentions = selectedMentions;
    setSelectedMentions([]);
    const withoutPreview = linkPreview.isRemoved();
    linkPreview.reset();
    void onSend(text, mentions, withoutPreview ? { linkPreview: false } : undefined);
    const shell = shellRef.current;
    if (shell && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      shell.animate([{ transform: "scale(0.99)" }, { transform: "scale(1)" }], {
        duration: 180,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
      });
    }
  }

  // Attachments stay unchanged while dictating: a file dropped or pasted in
  // is ignored the same way it already is while `disabled`.
  const attachDisabled = disabled || isDictating;
  useEffect(() => {
    onDictatingChange?.(isDictating);
  }, [isDictating, onDictatingChange]);

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const clipboardData = event.clipboardData;
    // Only intercept real FileList pastes; leave text-only / empty-files native.
    // (The textarea itself is unmounted while dictating, but this keeps the
    // guard true even if that ever changes.)
    if (attachDisabled || !clipboardData || !isFilePaste(clipboardData)) return;
    event.preventDefault();
    void onAttachmentPick(clipboardData.files);
    const text = clipboardData.getData("text/plain");
    if (!text) return;
    const textarea = event.currentTarget;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const caret = start + text.length;
    updateDraft(`${draft.slice(0, start)}${text}${draft.slice(end)}`, "paste", caret);
    window.requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  }

  const showComposerPlaceholder = draft.length === 0;
  const tokenSelected = tokens.some(
    (token) => selection[0] === token.start && selection[1] === token.start + token.text.length,
  );
  /** Type and box shared by the textarea and its mirror. */
  const fieldText = cn("py-1 text-body", skillLeads && "indent-(--size-mention-glyph)");
  const fieldName = answerName
    ? t`Answer ${answerName}…`
    : activeName
      ? t`Message ${activeName}`
      : t`Message`;

  const stopButton = running ? (
    <Button
      variant="roundIcon"
      size="roundIcon"
      aria-label={t`Stop`}
      disabled={sending}
      onClick={() => void onStop()}
      className="hover:bg-transparent"
    >
      <StopContour color={botColor} />
    </Button>
  ) : null;

  return (
    <fieldset
      data-slot="composer"
      aria-label={t`Message composer`}
      className="relative z-30 m-0 min-w-0 border-0 pt-3 pb-5"
    >
      <ComposerNotices
        sendError={sendError}
        runError={runError}
        dictationError={dictationError}
        runErrorId={runErrorId}
        onRunErrorPresented={onRunErrorPresented}
        onDismissError={() => {
          setDictationError(null);
          onDismissError();
          window.requestAnimationFrame(() => textareaRef.current?.focus());
        }}
        replyTarget={replyTarget}
        replyTargetName={replyTargetName}
        onClearReply={onClearReply}
        rewindTarget={rewindTarget}
        rewindRemovedCount={rewindRemovedCount}
        onCancelRewind={onCancelRewind}
        attachmentNotice={attachmentNotice}
      />
      {pickers.mentionPickerOpen ? (
        <MentionPicker
          id={pickers.mentionListboxId}
          options={pickers.mentionOptions}
          activeIndex={pickers.activeMentionIndex}
          onPick={insertMention}
          onHighlight={pickers.setMentionHighlightIndex}
        />
      ) : null}
      {pickers.showSlashPicker ? (
        <SlashPicker
          skills={pickers.slashSkillOptions}
          actions={pickers.slashActionOptions}
          onSkill={insertSkill}
          onAction={runSlashAction}
        />
      ) : null}
      <ComposerShell
        ref={shellRef}
        data-testid="composer-bar"
        state={composerState}
        attachments={
          (rewindArtifacts?.length ?? 0) > 0 ||
          pendingAttachments.length > 0 ||
          linkPreviewView.status !== "idle" ? (
            <AttachmentTray
              rewindArtifacts={rewindArtifacts}
              onRemoveRewindArtifact={onRemoveRewindArtifact}
              pendingAttachments={pendingAttachments}
              onRemoveAttachment={onRemoveAttachment}
              linkPreview={linkPreviewView}
              onRemoveLinkPreview={() => linkPreview.remove()}
              disabled={isDictating}
            />
          ) : undefined
        }
        attach={
          <AttachButton
            inputRef={fileInputRef}
            onPick={onAttachmentPick}
            disabled={disabled || isDictating}
          />
        }
        trailing={
          isDictating ? undefined : (
            <>
              {dictationAvailable ? (
                <DictateButton disabled={disabled} onStart={startDictation} />
              ) : null}
              {canSend ? (
                <Button
                  variant="roundIcon"
                  size="roundIcon"
                  aria-label={t`Send`}
                  disabled={sending || disabled}
                  onClick={send}
                  className="group/send animate-pivot bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground hover:opacity-85"
                >
                  <ArrowUp
                    size={16}
                    strokeWidth={2}
                    className="transition-transform duration-(--duration-hover) ease-quiet motion-safe:group-hover/send:-translate-y-px"
                  />
                </Button>
              ) : null}
              {!canSend ? stopButton : null}
            </>
          )
        }
        dictationCancel={isDictating ? <DictationCancel onCancel={cancelDictation} /> : undefined}
        dictationConfirm={
          isDictating ? (
            <>
              <DictationConfirm
                finishing={dictateFinishing}
                onConfirm={() => void insertDictation()}
              />
              {stopButton}
            </>
          ) : undefined
        }
      >
        <span role="status" aria-live="polite" className="sr-only">
          {isDictating ? t`Dictating` : ""}
        </span>
        {isDictating ? (
          <DictationPreview
            previewRef={dictationPreviewRef}
            label={fieldName}
            prefix={dictatedPrefix}
            speech={dictateSpeech}
            onConfirm={() => void insertDictation()}
          />
        ) : (
          <div className="relative">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) =>
                updateDraft(
                  event.target.value,
                  (event.nativeEvent as InputEvent).inputType === "insertFromPaste"
                    ? "paste"
                    : "type",
                  event.target.selectionStart,
                )
              }
              onSelect={(event) => {
                const { selectionStart, selectionEnd } = event.currentTarget;
                setSelection([selectionStart, selectionEnd]);
                if (selectionStart === selectionEnd) {
                  pickers.trackCaret(draft, selectionStart, selectedMentions);
                }
              }}
              onScroll={syncMirror}
              onPaste={handlePaste}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !pickers.mentionPickerOpen && rewindTarget) {
                  event.preventDefault();
                  onCancelRewind?.();
                  return;
                }
                const isComposing = event.nativeEvent.isComposing || event.keyCode === 229;
                if (!isComposing && handleTokenKey(event)) return;
                const action = resolveMentionPickerKey({
                  key: event.key,
                  shiftKey: event.shiftKey,
                  isComposing,
                  optionCount: pickers.mentionOptions.length,
                  highlightedIndex: pickers.activeMentionIndex,
                });
                if (action.type === "complete") {
                  const mention = pickers.mentionOptions[action.index];
                  if (!mention) return;
                  event.preventDefault();
                  insertMention(mention);
                  return;
                }
                if (action.type === "move") {
                  event.preventDefault();
                  pickers.setMentionHighlightIndex(action.index);
                  return;
                }
                if (action.type === "dismiss") {
                  event.preventDefault();
                  pickers.closeMentions();
                  return;
                }
                if (action.type === "send") {
                  event.preventDefault();
                  send();
                }
              }}
              disabled={disabled}
              placeholder={
                showComposerPlaceholder
                  ? activeName || answerName
                    ? fieldName
                    : t`Message…`
                  : undefined
              }
              aria-label={fieldName}
              role="combobox"
              aria-autocomplete="list"
              aria-haspopup="listbox"
              aria-expanded={pickers.mentionPickerOpen}
              aria-controls={pickers.mentionPickerOpen ? pickers.mentionListboxId : undefined}
              aria-activedescendant={pickers.activeMentionOptionId}
              name="chat-message"
              autoComplete="off"
              dir="auto"
              rows={1}
              className={cn(
                "rk-scroll block max-h-composer-field min-h-6 w-full resize-none overflow-y-auto bg-transparent text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-40",
                fieldText,
                tokens.length > 0 && "text-transparent caret-foreground",
                tokenSelected && "selection:bg-transparent",
              )}
            />
            {tokens.length > 0 ? (
              <DraftMirror
                segments={segments}
                selection={selection}
                mirrorRef={mirrorRef}
                className={fieldText}
              />
            ) : null}
          </div>
        )}
      </ComposerShell>
    </fieldset>
  );
});

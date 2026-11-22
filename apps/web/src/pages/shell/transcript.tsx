import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import type { MessageReaction, ThreadItem } from "@tangow/contracts";
import type { SkillSourceBlock, ThreadView } from "@tangow/core";
import { isToolActivityBlock, routineResultMessage } from "@tangow/core";
import type { GroupAvatarMember } from "@tangow/ui-web";
import { cn } from "@tangow/ui-web";
import type { RefObject } from "react";
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import type { CardEdits } from "../../components/AskCard";
import { ActiveBotGlyph } from "../../components/ai/CollaborationMarker";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { useDebugMode } from "../../lib/debug-mode";
import { messageTimeLabel } from "../../lib/message-time";
import type { CardAnswerTarget, MessageItem, SessionViewTarget } from "../../lib/thread-items";
import { isLiveItem } from "../../lib/thread-items";
import { arrivedAfterMount } from "../../lib/transcript-scroll";
import { placeHoverPill } from "./hover-pill-placement";
import { JumpToLatest } from "./jump-to-latest";
import { MessageActionsSheet } from "./message-actions-sheet";
import { MessageHoverActions, UserMessageActions } from "./message-hover-actions";
import { SessionView } from "./session-view";
import type { RowContext } from "./thread-row";
import { isBubbleRow, RowMarker, rowChrome, ThreadRowBody } from "./thread-row";
import { useBubbleLongPress } from "./use-bubble-long-press";
import { useTranscriptFollow } from "./use-transcript-follow";

/** An approval card takes the actions of the bot message it was on main, keyed by its own entry. */
function actionTarget(item: ThreadItem): MessageItem | null {
  if (item.kind === "message") return item;
  if (item.kind !== "effect" || !item.card || !item.botId) return null;
  return {
    kind: "message",
    role: "bot",
    id: item.id,
    ts: item.ts,
    botId: item.botId,
    ...(item.runId ? { runId: item.runId } : {}),
    blocks: [item.card],
  };
}

/** A routine's result takes the actions of a bot message. */
function routineTarget(row: ThreadView["rows"][number]): MessageItem | null {
  const { item, routine } = row;
  return item.kind === "routine" && routine?.kind === "message"
    ? routineResultMessage(item, routine.text)
    : null;
}

/**
 * What a row's actions act on. A stack of images acts on its newest message, which draws no row of
 * its own, unless its host draws more than images: then the words keep the host's actions.
 */
function rowTarget(row: ThreadView["rows"][number]): MessageItem | null {
  const { item, imageStack } = row;
  const imagesOnly =
    item.kind === "message" &&
    item.blocks.every((block) => block.kind === "image") &&
    !(item.role === "user" && item.replyTo) &&
    row.previewMessageId === undefined;
  return (
    routineTarget(row) ?? actionTarget(imagesOnly && imageStack ? imageStack.front.item : item)
  );
}

export const Transcript = memo(function Transcript({
  scrollRef,
  followingRef,
  artifactTarget,
  inGroup,
  view,
  olderCursor,
  loadingOlder,
  viewerUserId,
  personOf,
  waitingOn,
  takeoverItemId,
  onOpenComputer,
  running,
  workingBots,
  workingStartedAt,
  onLoadOlder,
  onOpenBot,
  onAnswer,
  onReply,
  onEdit,
  rewindFromItemId,
  onReact,
  onJumpToMessage,
  onOpenPeerMessages,
  memberName,
  peerBot,
  onRefresh,
  onBotChanged,
  onAddRoutine,
  onOpenSkill,
  onOpenIntegrations,
  voiceReady,
  speakingMessageId,
  onSpeak,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Whether the view follows the end; Shell reads it before snapping after a refresh. */
  followingRef: RefObject<boolean>;
  artifactTarget: ArtifactTarget;
  /** True in a multi-bot (group) thread: messages group by author with a
   * shared name/avatar. False in a single-bot (mono) thread: no message ever
   * shows a name or avatar — the bot's identity lives in the header. */
  inGroup: boolean;
  view: ThreadView;
  olderCursor: string | null;
  loadingOlder: boolean;
  viewerUserId?: string;
  personOf?: RowContext["personOf"];
  waitingOn?: RowContext["waitingOn"];
  /** The live "Needs you" computer card, which opens the bot's screen in one click. */
  takeoverItemId?: string | null;
  onOpenComputer?: () => void;
  running: boolean;
  workingBots: GroupAvatarMember[];
  /** Epoch ms the earliest working run started; undefined ticks from mount. */
  workingStartedAt?: number;
  onLoadOlder: () => void | Promise<void>;
  onOpenBot: (botId: string, messageId?: string) => void;
  onAnswer: (target: CardAnswerTarget, text: string, edits?: CardEdits) => Promise<void>;
  onReply: (message: MessageItem) => void;
  /** Absent in a group of several people, whose history no one rewrites alone. */
  onEdit?: (message: MessageItem) => void;
  rewindFromItemId: string | null;
  onReact: (message: MessageItem, reaction: MessageReaction) => Promise<void>;
  onJumpToMessage: (messageId: string) => void;
  onOpenPeerMessages: (peer: { peerBotId: string; peerBotName: string }) => void;
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: RowContext["peerBot"];
  onRefresh: () => Promise<void>;
  onBotChanged: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
  onOpenSkill?: (skill: SkillSourceBlock) => void;
  /** Opens the integrations screen, where a disconnected app is reconnected. */
  onOpenIntegrations?: () => void;
  voiceReady: boolean;
  speakingMessageId: string | null;
  onSpeak: (message: MessageItem) => void;
}) {
  const { t } = useLingui();
  const showSteps = useDebugMode();
  const [sessionTarget, setSessionTarget] = useState<SessionViewTarget | null>(null);
  const { rows, waiting, rowOf } = view;
  const { atEnd, jumpToMessage, jumpToLatest, loadOlder, scrollerHandlers } = useTranscriptFollow({
    scrollRef,
    followingRef,
    rows,
    running,
    rowOf,
    onLoadOlder,
    onJumpToMessage,
  });
  const {
    pressingMessageId,
    sheetMessage,
    sheetOpen,
    setSheetOpen,
    onBubblePointerDown,
    onBubblePointerMove,
    onBubblePointerEnd,
    onRowClickCapture,
  } = useBubbleLongPress(scrollRef);
  const messages = useMemo(
    () => rows.flatMap((row) => (row.item.kind === "message" ? [row.item] : [])),
    [rows],
  );
  const idsAtMount = useRef<ReadonlySet<string> | null>(null);
  if (idsAtMount.current === null) {
    idsAtMount.current = new Set(rows.map((row) => row.item.id));
  }
  const arrived = useMemo(
    () =>
      arrivedAfterMount(
        idsAtMount.current ?? new Set(),
        rows.map((row) => row.item.id),
      ),
    [rows],
  );
  // Your own message sits at the end; a bot's, or someone else's in a group, at the start.
  const isMine = (message: MessageItem) => message.role === "user" && !personOf?.(message);
  const rewindFromIndex =
    rewindFromItemId === null
      ? -1
      : rows.findIndex((row) => rowTarget(row)?.id === rewindFromItemId);
  const context = useMemo<RowContext>(() => {
    const messageById = new Map(messages.map((message) => [message.id as string, message]));
    for (const row of rows) {
      const routine = routineTarget(row);
      if (routine) messageById.set(routine.id as string, routine);
    }
    return {
      artifactTarget,
      inGroup,
      takeoverItemId,
      onOpenComputer,
      viewerUserId,
      personOf,
      waitingOn,
      waiting,
      onAnswer,
      memberName,
      peerBot,
      onOpenBot,
      onOpenPeerMessages,
      onOpenSession: setSessionTarget,
      onJumpToMessage: jumpToMessage,
      onRefresh,
      onBotChanged,
      onAddRoutine,
      onOpenSkill,
      onOpenIntegrations,
      messageOfEntry: (entryId) => {
        const itemId = rowOf.get(entryId);
        return itemId ? messageById.get(itemId) : undefined;
      },
    };
  }, [
    artifactTarget,
    inGroup,
    viewerUserId,
    personOf,
    waitingOn,
    waiting,
    takeoverItemId,
    onOpenComputer,
    onAnswer,
    memberName,
    peerBot,
    onOpenBot,
    onOpenPeerMessages,
    jumpToMessage,
    onRefresh,
    onBotChanged,
    onAddRoutine,
    onOpenSkill,
    onOpenIntegrations,
    messages,
    rows,
    rowOf,
  ]);
  const workingBotName = workingBots.length === 1 ? workingBots[0]?.name : undefined;
  const workingFallback = `${
    workingBotName != null && workingBotName !== ""
      ? t`${workingBotName} is working`
      : t`Bots are working`
  }…`;
  // One bot only: an activity line names one bot's tool, so it would mislabel a group.
  const workingLabel =
    (workingBots.length === 1 ? view.activityLabel : undefined) ?? workingFallback;

  // Keyboard focus reveals a row's pill too, so it is placed on focus as on hover.
  useEffect(() => {
    const scroller = scrollRef.current;
    const place = (event: FocusEvent) => {
      const row = (event.target as Element | null)?.closest<HTMLElement>("[data-message-id]");
      if (row) placeHoverPill(row);
    };
    scroller?.addEventListener("focusin", place);
    return () => scroller?.removeEventListener("focusin", place);
  }, [scrollRef]);

  return (
    // The thread runs under the header above and under the composer below
    // (`rk-thread-overlap`), fading out at both ends (`rk-thread-mask`, which also sets
    // the end padding from the overlap): pt-21 clears the mask's top fade.
    <div className="rk-thread-overlap relative flex min-h-0 flex-1">
      <div
        ref={scrollRef}
        data-testid="transcript"
        {...scrollerHandlers}
        // The scroller spans the column (-mx cancels its padding) and pads back in, so the cards
        // keep their place while a card's shadow has room inside this overflow instead of being cut:
        // 26px sideways, past the 20px shadow-card reaches in light and the 28px its blur radius
        // names in dark, where the visible part ends well short of it.
        className="rk-scroll rk-thread-mask flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto -mx-3.5 px-6.5 pt-21"
      >
        {olderCursor != null ? (
          <button
            type="button"
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
            className="self-center rounded-row px-3 py-1.5 text-meta text-muted-foreground hover:bg-muted hover:text-foreground/75 disabled:opacity-50"
          >
            {loadingOlder ? t`Loading…` : t`Load earlier messages`}
          </button>
        ) : null}
        {rows.map((row, index) => {
          const { item } = row;
          const chrome = rowChrome(item, showSteps);
          const message = rowTarget(row);
          const acts = message !== null && chrome === "row";
          const mine = message !== null && isMine(message);
          const rewound = rewindFromIndex >= 0 && index >= rewindFromIndex;
          const previous = rows[index - 1];
          const prevChrome = previous ? rowChrome(previous.item, showSteps) : undefined;
          const arrives = arrived.has(item.id);
          // 14px between groups (the container's own `gap-3.5`) narrows to 3px
          // between two bubbles of a group and 8px when a card is one of them,
          // and to 0 between two consecutive asides or two chained routine
          // failure lines (they stack like a log).
          const spacingClass = row.chained
            ? " -mt-3.5"
            : !row.firstOfGroup
              ? isBubbleRow(item) && previous && isBubbleRow(previous.item)
                ? " -mt-2.75"
                : " -mt-1.5"
              : chrome === "aside" && prevChrome === "aside"
                ? " -mt-3.5"
                : "";
          return (
            <Fragment key={item.id}>
              {row.marker ? <RowMarker marker={row.marker} /> : null}
              <div
                data-message-id={item.id}
                data-rewound={rewound ? "true" : undefined}
                data-long-pressing={acts && pressingMessageId === message.id ? "true" : undefined}
                onPointerEnter={acts ? (event) => placeHoverPill(event.currentTarget) : undefined}
                onPointerDown={
                  acts && message ? (event) => onBubblePointerDown(event, message) : undefined
                }
                onPointerMove={acts ? onBubblePointerMove : undefined}
                onPointerUp={acts ? onBubblePointerEnd : undefined}
                onPointerCancel={acts ? onBubblePointerEnd : undefined}
                onClickCapture={acts ? (event) => onRowClickCapture(event, message.id) : undefined}
                className={`${
                  acts ? "group group/message relative hover:z-20" : "relative py-0.5"
                }${rewound ? " opacity-40" : ""}${arrives ? " animate-arrive" : ""}${spacingClass}`}
              >
                <div
                  className={
                    acts ? `relative flex ${mine ? "justify-end" : "justify-start"}` : undefined
                  }
                >
                  <div
                    data-testid={acts ? "message-bubble-frame" : undefined}
                    className={
                      acts
                        ? // The pill floats in this frame: beside the bubble when there is
                          // room (`placeHoverPill`), else at its top-end corner, so both
                          // rows run the full column width. A user row right-aligns its
                          // bubble with `items-end` and caps it at 78% (`UserBubble`); the old
                          // `w-fit` collapsed to the left once the bubble reached that 78% cap,
                          // because fit-content resolves a percentage-capped child to full width.
                          `relative min-w-0 w-full ${mine ? "flex flex-col items-end" : ""}`
                        : undefined
                    }
                  >
                    {acts && !mine && !message.blocks.some((block) => block.kind === "widget") ? (
                      <MessageHoverActions
                        message={message}
                        previewMessageId={row.previewMessageId}
                        // No row carries a permanent clock: the time rides in the pill, next
                        // to the bubble or card. Cards have no clock of their own.
                        time={
                          <time dateTime={message.ts} data-testid="message-hover-time">
                            {messageTimeLabel(message.ts, i18n.locale)}
                          </time>
                        }
                        onReply={onReply}
                        onReact={onReact}
                        voiceReady={voiceReady}
                        speaking={speakingMessageId === message.id}
                        onSpeak={() => onSpeak(message)}
                      />
                    ) : null}
                    <ThreadRowBody
                      row={row}
                      context={context}
                      chrome={chrome}
                      showAuthor={row.firstOfGroup}
                      showAvatar={row.lastOfGroup}
                      arrivesLive={arrives}
                    />
                  </div>
                </div>
                {acts && row.reactions.length > 0 ? (
                  <div
                    data-testid="message-reactions"
                    className={cn("mt-1 flex flex-wrap gap-1", mine && "justify-end")}
                  >
                    {row.reactions.map(([emoji, count]) => (
                      <span
                        key={emoji}
                        className="rounded-full border border-border bg-muted px-2 py-0.5 text-time"
                      >
                        {emoji}
                        {count > 1 ? ` ${count}` : ""}
                      </span>
                    ))}
                  </div>
                ) : null}
                {acts && mine ? (
                  <UserMessageActions
                    message={message}
                    previewMessageId={row.previewMessageId}
                    onEdit={onEdit}
                  />
                ) : null}
              </div>
            </Fragment>
          );
        })}
        {running &&
        !messages.some(
          (message) =>
            isLiveItem(message) &&
            message.blocks.some(
              (block) =>
                block.kind === "progress" && !isToolActivityBlock(block) && Boolean(block.text),
            ),
        ) ? (
          <ActiveBotGlyph bots={workingBots} label={workingLabel} startedAt={workingStartedAt} />
        ) : null}
      </div>
      <JumpToLatest atEnd={atEnd} onJump={jumpToLatest} />
      <MessageActionsSheet
        message={sheetMessage}
        previewMessageId={rows.find((row) => row.item.id === sheetMessage?.id)?.previewMessageId}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onReply={onReply}
        onEdit={sheetMessage && isMine(sheetMessage) ? onEdit : undefined}
        onReact={onReact}
        voiceReady={voiceReady}
        speaking={sheetMessage !== null && speakingMessageId === sheetMessage.id}
        onSpeak={onSpeak}
      />
      {sessionTarget ? (
        <SessionView
          key={sessionTarget.kind === "session" ? sessionTarget.sessionId : sessionTarget.runId}
          target={sessionTarget}
          context={context}
          onClose={() => setSessionTarget(null)}
        />
      ) : null}
    </div>
  );
});

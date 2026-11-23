import { i18n } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown, truncateMarkdownForRender } from "@tangow/chat-ui/web";
import type { GroupPerson, MessageBlock, ThreadItem } from "@tangow/contracts";
import { isLinkPreviewCard } from "@tangow/contracts";
import type { RoutineItem, SkillSourceBlock, ThreadRow, WaitingCard } from "@tangow/core";
import {
  isAsideOnlyMessage,
  sessionOriginOf,
  textWithoutPreviewedLinkLine,
  threadTimeMarkerLabel,
} from "@tangow/core";
import type { StackedAvatarItem } from "@tangow/ui-web";
import {
  BotAvatar,
  cn,
  Interstitial,
  MessageBubble,
  MessageMeta,
  MessageRow,
  Separator,
  StackedAvatars,
} from "@tangow/ui-web";
import type { ReactNode } from "react";
import type { CardEdits } from "../../components/AskCard";
import { AskCard } from "../../components/AskCard";
import { CollaborationMarker } from "../../components/ai/CollaborationMarker";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { isHiddenActivityBlock } from "../../lib/message-blocks";
import type {
  CardAnswerTarget,
  ItemOf,
  MessageItem,
  SessionViewTarget,
} from "../../lib/thread-items";
import { LinkPreviewRow } from "./block-views";
import { threadJumpLocation } from "./layout";
import { MessageView, skillLine, useLinkMentions } from "./message-view";
import { RoutineFailureLine } from "./routine-run-line";

type PeerBot = (botId: string) =>
  | {
      name?: string;
      avatarCharacter?: string | null;
      status?: string;
    }
  | undefined;

export type RowContext = {
  artifactTarget: ArtifactTarget;
  inGroup: boolean;
  viewerUserId?: string;
  /** Who wrote a message, when it is someone else's in a group. */
  personOf?: (message: MessageItem) => GroupPerson | undefined;
  waiting: WaitingCard | null;
  /** The cards other people's runs wait on, by item, and their names: shown, answered by them alone. */
  waitingOn?: ReadonlyMap<string, string>;
  /** The item whose computer card is live and opens the bot's screen. */
  takeoverItemId?: string | null;
  onOpenComputer?: () => void;
  onAnswer?: (target: CardAnswerTarget, text: string, edits?: CardEdits) => Promise<void>;
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: PeerBot;
  onOpenBot: (botId: string, messageId?: string) => void;
  onOpenPeerMessages: (peer: { peerBotId: string; peerBotName: string }) => void;
  onOpenSession: (target: SessionViewTarget) => void;
  onJumpToMessage?: (messageId: string) => void;
  onRefresh: () => Promise<void>;
  onBotChanged: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
  onOpenSkill?: (skill: SkillSourceBlock) => void;
  /** Opens the integrations screen, where a disconnected app is reconnected. */
  onOpenIntegrations?: () => void;
  messageOfEntry: (entryId: string) => MessageItem | undefined;
};

/** Kinds drawn inside a bubble, or as a line under it: anything else in a row is a card. */
const BUBBLE_KINDS = new Set<MessageBlock["kind"]>([
  "text",
  "meta",
  "progress",
  "steps",
  "skill_source",
  "link_mention",
  "reasoning",
]);

/** Only bubbles: such rows stack 3 px apart in a group, a card keeps 8 px from its neighbours. */
export function isBubbleRow(item: ThreadItem): boolean {
  return item.kind === "message" && item.blocks.every((block) => BUBBLE_KINDS.has(block.kind));
}

export function rowChrome(item: ThreadItem, showSteps: boolean): "row" | "aside" {
  if (item.kind === "message") {
    const blocks = item.blocks.filter((block) => !isHiddenActivityBlock(block, showSteps));
    return isAsideOnlyMessage(blocks) ? "aside" : "row";
  }
  return item.kind === "handoff" ||
    item.kind === "botMessage" ||
    item.kind === "divider" ||
    item.kind === "note"
    ? "aside"
    : "row";
}

export function RowMarker({ marker }: { marker: NonNullable<ThreadRow["marker"]> }) {
  const { t } = useLingui();
  return (
    <time
      dateTime={marker.at}
      className="self-center text-label tabular-nums text-muted-foreground"
    >
      {threadTimeMarkerLabel(marker.at, {
        locale: i18n.locale || "en",
        today: t`Today`,
        yesterday: t`Yesterday`,
        withTime: marker.withTime,
      })}
    </time>
  );
}

export function ThreadRowBody({
  row,
  context,
  chrome,
  showAuthor,
  showAvatar,
  arrivesLive,
}: {
  row: ThreadRow;
  context: RowContext;
  chrome: "row" | "aside";
  showAuthor: boolean;
  showAvatar: boolean;
  arrivesLive: boolean;
}) {
  const { item } = row;
  const body = itemBody(item, row, context, { chrome, showAuthor, showAvatar, arrivesLive });
  const origin = sessionOriginOf(item);
  if (!origin) return body;
  return (
    <>
      <OriginLabel
        title={origin.name}
        onOpen={() =>
          context.onOpenSession({
            kind: "session",
            sessionId: origin.sessionId,
            title: origin.name,
          })
        }
      />
      {body}
    </>
  );
}

function itemBody(
  item: ThreadItem,
  row: ThreadRow,
  context: RowContext,
  frame: {
    chrome: "row" | "aside";
    showAuthor: boolean;
    showAvatar: boolean;
    arrivesLive: boolean;
  },
): ReactNode {
  switch (item.kind) {
    case "message":
      return (
        <MessageRowView item={item} imageStack={row.imageStack} context={context} {...frame} />
      );
    case "routine":
      if (row.routine?.kind === "message")
        return <RoutineMessage item={item} text={row.routine.text} context={context} />;
      return row.routine ? (
        <BotSide inGroup={context.inGroup}>
          <RoutineFailureLine
            item={item}
            count={row.routine.count}
            since={row.routine.since}
            onOpen={() => openRoutineRun(context, item)}
          />
        </BotSide>
      ) : null;
    case "handoff":
      return <HandoffLine item={item} context={context} />;
    case "botMessage":
      return <BotMessageMarker item={item} context={context} />;
    case "divider":
      return <DividerLine reason={item.reason} />;
    case "effect":
      return (
        <BotSide inGroup={context.inGroup}>
          <EffectCard item={item} context={context} />
        </BotSide>
      );
    case "note":
      return <NoteLine item={item} onOpenSkill={context.onOpenSkill} />;
  }
}

function MessageRowView({
  item,
  imageStack,
  context,
  chrome,
  showAuthor,
  showAvatar,
  arrivesLive,
}: {
  item: MessageItem;
  imageStack?: ThreadRow["imageStack"];
  context: RowContext;
  chrome: "row" | "aside";
  showAuthor: boolean;
  showAvatar: boolean;
  arrivesLive: boolean;
}) {
  const { waiting, onAnswer } = context;
  const replyTo = item.role === "user" ? item.replyTo?.entryId : undefined;
  return (
    <MessageView
      artifactTarget={context.artifactTarget}
      chrome={chrome}
      message={item}
      person={context.personOf?.(item)}
      inGroup={context.inGroup}
      showAuthor={context.inGroup && showAuthor}
      showAvatar={context.inGroup && showAvatar}
      viewerUserId={context.viewerUserId}
      onAnswer={
        waiting && onAnswer && waiting.itemId === item.id
          ? (text, edits) =>
              onAnswer(
                {
                  thread: context.artifactTarget,
                  runId: waiting.runId,
                  messageId: waiting.entryId,
                },
                text,
                edits,
              )
          : undefined
      }
      waitingOn={context.waitingOn?.get(item.id)}
      onOpenComputer={context.takeoverItemId === item.id ? context.onOpenComputer : undefined}
      onOpenBot={context.onOpenBot}
      speakerName={
        chrome !== "row" || item.role !== "bot" ? undefined : context.memberName?.(item.botId)
      }
      memberName={context.memberName}
      peerBot={context.peerBot}
      replyPreview={replyTo ? context.messageOfEntry(replyTo) : undefined}
      replyToMessageId={replyTo}
      onJumpToMessage={context.onJumpToMessage}
      onRefresh={context.onRefresh}
      onBotChanged={context.onBotChanged}
      onAddRoutine={context.onAddRoutine}
      onOpenSkill={context.onOpenSkill}
      onOpenSession={context.onOpenSession}
      arrivesLive={arrivesLive}
      imageStack={imageStack}
    />
  );
}

function BotSide({ inGroup, children }: { inGroup: boolean; children: ReactNode }) {
  return (
    <MessageRow
      avatar={null}
      author={null}
      hasAvatarColumn={inGroup}
      showAuthor={false}
      showAvatar={false}
    >
      {children}
    </MessageRow>
  );
}

function openRoutineRun(context: RowContext, item: RoutineItem) {
  context.onOpenSession({ kind: "run", runId: item.runId, title: item.name });
}

function RoutineMessage({
  item,
  text,
  context,
}: {
  item: RoutineItem;
  text: string;
  context: RowContext;
}) {
  const { t } = useLingui();
  const { inGroup, artifactTarget } = context;
  const links = item.links ?? [];
  const mentions = useLinkMentions({ role: "bot", blocks: links }, artifactTarget);
  const [card] = links.flatMap((block) =>
    block.kind === "link_preview" && isLinkPreviewCard(block) ? [block] : [],
  );
  // Without the line that is only the card's link, as a message's bubble draws it.
  const shown = card ? textWithoutPreviewedLinkLine(text, card.url) : text;
  const bot = context.peerBot(item.botId);
  const origin = (
    <OriginLabel title={item.name} onOpen={() => openRoutineRun(context, item)} inline={inGroup} />
  );
  return (
    <>
      {inGroup ? null : origin}
      <MessageRow
        avatar={<BotAvatar {...avatarLookup(context.peerBot)(item.botId)} size={32} />}
        author={
          <>
            <span dir="auto">{context.memberName?.(item.botId) ?? bot?.name ?? t`Bot`}</span>
            <span className="text-muted-foreground"> · </span>
            {origin}
          </>
        }
        hasAvatarColumn={inGroup}
        showAuthor={inGroup}
        showAvatar={inGroup}
      >
        {shown ? (
          <MessageBubble data-testid="routine-message" inGroup={inGroup} dir="auto">
            <ChatMarkdown allowImages={false} mentions={mentions}>
              {truncateMarkdownForRender(shown)}
            </ChatMarkdown>
          </MessageBubble>
        ) : null}
        {card ? (
          <LinkPreviewRow
            card={card}
            artifactTarget={artifactTarget}
            side="bot"
            inGroup={inGroup}
          />
        ) : null}
      </MessageRow>
    </>
  );
}

function HandoffLine({ item, context }: { item: ItemOf<"handoff">; context: RowContext }) {
  const { t } = useLingui();
  const avatarOf = avatarLookup(context.peerBot);
  const from = context.memberName?.(item.fromBotId) ?? t`bot`;
  const to = context.memberName?.(item.toBotId) ?? t`bot`;
  return (
    <div className="flex flex-col">
      <Interstitial
        avatars={
          <StackedAvatars items={[avatarOf(item.fromBotId), avatarOf(item.toBotId)]} size={17} />
        }
      >
        <Trans>
          {from} handed the thread to {to}
        </Trans>{" "}
        {item.text}
      </Interstitial>
    </div>
  );
}

function BotMessageMarker({ item, context }: { item: ItemOf<"botMessage">; context: RowContext }) {
  const { t } = useLingui();
  const avatarOf = avatarLookup(context.peerBot);
  const peer = item.peer.name;
  const peerBotId = item.peer.kind === "bot" ? item.peer.botId : undefined;
  const sent = item.direction === "sent";
  const self =
    item.direction === "sent"
      ? item.botId
      : "botId" in context.artifactTarget
        ? context.artifactTarget.botId
        : undefined;
  const intent = {
    request: t`Request`,
    result: t`Result`,
    question: t`Question`,
    status: t`Status`,
    fyi: t`FYI`,
  }[item.intent];
  const label = sent ? t`Messaged ${peer}` : t`Message from ${peer}`;
  const messageId = item.direction === "received" ? item.origin?.entryId : undefined;
  const jump = peerBotId ? threadJumpLocation({ botId: peerBotId, messageId }) : null;
  const peerLink =
    jump && peerBotId ? (
      <a
        href={`${jump.pathname}${jump.search ?? ""}`}
        className="relative underline-offset-2 hover:underline"
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          context.onOpenBot(peerBotId, messageId);
        }}
      >
        {peer}
      </a>
    ) : (
      peer
    );
  const pair = sent ? [self, peerBotId] : [peerBotId, self];
  return (
    <CollaborationMarker
      ariaLabel={`${label} · ${intent}`}
      bots={pair.filter((botId): botId is string => Boolean(botId)).map(avatarOf)}
      label={
        <>
          <ExchangeLabel sent={sent} peer={peerLink} />
          {` · ${intent}`}
        </>
      }
      muted={item.direction === "sent" && item.answeredBy === null}
      onClick={
        peerBotId ? () => context.onOpenPeerMessages({ peerBotId, peerBotName: peer }) : undefined
      }
    />
  );
}

function ExchangeLabel({ sent, peer }: { sent: boolean; peer: ReactNode }) {
  return sent ? <Trans>Messaged {peer}</Trans> : <Trans>Message from {peer}</Trans>;
}

function DividerLine({ reason }: { reason: ItemOf<"divider">["reason"] }) {
  const { t } = useLingui();
  const label =
    reason === "compaction"
      ? t`Earlier messages summarized`
      : reason === "rewind"
        ? t`Message edited`
        : t`Conversation cleared`;
  return (
    <div data-testid="thread-divider" className="flex items-center gap-3 py-1">
      <Separator className="flex-1" />
      <span className="shrink-0 text-label text-muted-foreground">{label}</span>
      <Separator className="flex-1" />
    </div>
  );
}

function EffectCard({ item, context }: { item: ItemOf<"effect">; context: RowContext }) {
  const { waiting, onAnswer } = context;
  if (!item.card) return null;
  // A draft that did not leave is asked again under a new entry: the answer names the latest one.
  const answer =
    waiting?.itemId === item.id && onAnswer
      ? (text: string, edits?: CardEdits) =>
          onAnswer(
            { thread: context.artifactTarget, runId: waiting.runId, messageId: waiting.entryId },
            text,
            edits,
          )
      : undefined;
  return (
    <AskCard
      block={item.card}
      canAnswer={Boolean(answer)}
      waitingOn={context.waitingOn?.get(item.id)}
      viewerUserId={context.viewerUserId}
      onAnswer={answer ?? noAnswer}
      onReconnect={context.onOpenIntegrations}
      messageId={item.id}
      botId={item.botId}
    />
  );
}

function NoteLine({
  item,
  onOpenSkill,
}: {
  item: ItemOf<"note">;
  onOpenSkill?: (skill: SkillSourceBlock) => void;
}) {
  const { t } = useLingui();
  if (item.type === "skill.learnt") {
    const { skillId, name, change } = item.payload;
    return (
      <MessageMeta
        lines={[skillLine({ kind: "skill_source", skillId, name, change }, false, onOpenSkill)]}
        className="px-4"
      />
    );
  }
  if (item.type === "memory.revised" && item.payload.team) {
    return <MessageMeta lines={{ label: t`Saved for the team` }} className="px-4" />;
  }
  if (item.type === "system.note") {
    return (
      <p className="py-1 text-center text-meta text-muted-foreground" dir="auto">
        {item.payload.text}
      </p>
    );
  }
  return null;
}

function OriginLabel({
  title,
  onOpen,
  inline = false,
}: {
  title: string;
  onOpen: () => void;
  inline?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid="item-origin"
      aria-haspopup="dialog"
      onClick={onOpen}
      className={cn(
        !inline && "mb-1 ps-3 text-label",
        "text-muted-foreground duration-(--duration-hover) ease-quiet hover:text-foreground",
      )}
      dir="auto"
    >
      {title}
    </button>
  );
}

function avatarLookup(peerBot: PeerBot) {
  return (botId: string): StackedAvatarItem => {
    const bot = peerBot(botId);
    return {
      identity: botId,
      character: bot?.avatarCharacter,
    };
  };
}

async function noAnswer(): Promise<void> {}

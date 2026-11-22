import type { GroupPerson, Run } from "@tangow/contracts";
import type { ThreadView } from "@tangow/core";
import {
  answersPendingQuestion,
  drawsNothing,
  groupLeadBotId,
  isActive,
  latestTakeoverItemId,
  projectThreadView,
  waitingAskBlock,
} from "@tangow/core";
import type { GroupAvatarMember } from "@tangow/ui-web";
import { useCallback, useMemo, useRef } from "react";
import type { AskBlock } from "../../components/AskCard";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { useDebugMode } from "../../lib/debug-mode";
import { hasRenderableBlock } from "../../lib/message-blocks";
import { copyableMessageText } from "../../lib/message-text";
import type { ThreadState } from "../../lib/thread-events";
import { activeThreadRuns } from "../../lib/thread-events";
import type { CardAnswerTarget, MessageItem } from "../../lib/thread-items";
import type { CallThread } from "../CallView";
import { memberName } from "../GroupPanel";
import type { Roster } from "./use-roster";

export function isWorking(
  run: Pick<Run, "id" | "status"> | null | undefined,
  view: ThreadView,
): boolean {
  return Boolean(
    run && ["running", "queued", "leased"].includes(run.status) && run.id !== view.waiting?.runId,
  );
}

/** The entry a message is stored as, whether it draws a row or sits in a stack of images behind its host's. */
export function messageIdOf(view: ThreadView, message: MessageItem): string | undefined {
  const rowId = view.rowOf.get(message.id) ?? message.id;
  const row = view.rows.find((candidate) => candidate.item.id === rowId);
  return row?.item.id === message.id ? row.messageId : row?.imageStack?.messageIds.get(message.id);
}

/** The card the thread waits on, and the run and entry its answer goes to: the one that asked last. */
export function waitingAsk(
  view: ThreadView,
): { block: AskBlock; target: Omit<CardAnswerTarget, "thread"> } | null {
  const waiting = view.waiting;
  const block = waitingAskBlock(view);
  return waiting && block
    ? { block, target: { runId: waiting.runId, messageId: waiting.entryId } }
    : null;
}

/** What the open thread's snapshot shows: its rows, who is working, and who a send answers. */
export function useThreadView(snapshot: ThreadState | null, roster: Roster) {
  const { groupId, inGroup, active, activeGroup, bots, bootstrapMe } = roster;
  const activeSnapshot = inGroup
    ? snapshot?.groupId === groupId
      ? snapshot
      : null
    : snapshot?.botId === active?.id
      ? snapshot
      : null;
  const showSteps = useDebugMode();
  const activeEntries = activeSnapshot?.entries;
  const activeLayer = activeSnapshot?.layer;
  const currentRuns = useMemo(() => activeThreadRuns(activeSnapshot), [activeSnapshot]);
  const viewerId = bootstrapMe?.userId;
  // Another person's run in a group waits on them alone: its cards show here, but answer nothing.
  const othersRuns = useMemo(
    () =>
      new Map(
        currentRuns.flatMap((run) =>
          run.userId && viewerId && run.userId !== viewerId ? [[run.id, run.userId] as const] : [],
        ),
      ),
    [currentRuns, viewerId],
  );
  const view = useMemo(
    () =>
      projectThreadView(activeEntries ?? [], {
        rendersNothing: (item) =>
          drawsNothing(item, (blocks) => hasRenderableBlock(blocks, showSteps)),
        progress: activeLayer,
        imageStacks: true,
        othersRun: (runId) => othersRuns.has(runId),
      }),
    [activeEntries, activeLayer, showSteps, othersRuns],
  );
  const viewRef = useRef(view);
  viewRef.current = view;
  // A message that joins a stack of images draws no row: it stands at its host's.
  const rowIndexOf = useMemo(() => {
    const indexOfRow = new Map(view.rows.map((row, index) => [row.item.id as string, index]));
    const indexes = new Map(indexOfRow);
    for (const [entryId, rowId] of view.rowOf) {
      const index = indexOfRow.get(rowId);
      if (index !== undefined && !indexes.has(entryId)) indexes.set(entryId, index);
    }
    return indexes;
  }, [view.rows, view.rowOf]);
  const takeoverItemId = useMemo(
    () =>
      latestTakeoverItemId(
        view.rows.map((row) => row.item),
        currentRuns.filter((run) => !othersRuns.has(run.id)),
      ),
    [view.rows, currentRuns, othersRuns],
  );
  // The run behind that card: in a group, its bot is the computer the card opens.
  const takeoverItem = view.rows.find((row) => row.item.id === takeoverItemId)?.item;
  const takeoverRun =
    takeoverItem?.kind === "message" && takeoverItem.role === "bot"
      ? currentRuns.find((run) => run.id === takeoverItem.runId)
      : undefined;
  const workingRuns = currentRuns.filter((run) => isWorking(run, view));
  const transcriptRunning = workingRuns.length > 0;
  const composerRunning = currentRuns.some((run) => isActive(run.status));
  const messageItems = useMemo(
    () => view.rows.flatMap((row) => (row.item.kind === "message" ? [row.item] : [])),
    [view.rows],
  );
  // Dictation's language guess (`dictationLangFor`): the person's own recent
  // writing here, read lazily only when dictation actually starts.
  const recentWriting = useCallback(
    () =>
      messageItems
        .filter((message) => message.role === "user")
        .slice(-8)
        .map((message) => copyableMessageText(message)),
    [messageItems],
  );
  const transcriptArtifactTarget = useMemo<ArtifactTarget>(
    () => (inGroup ? { groupId: groupId ?? "" } : { botId: active?.id ?? "" }),
    [active?.id, groupId, inGroup],
  );
  const callThread = useMemo<CallThread>(() => {
    const ask = waitingAsk(view);
    return {
      messages: messageItems,
      running: isWorking(activeSnapshot?.run, view),
      ask: ask && {
        block: ask.block,
        target: { thread: transcriptArtifactTarget, ...ask.target },
      },
    };
  }, [view, messageItems, activeSnapshot?.run, transcriptArtifactTarget]);
  const transcriptMembers = activeSnapshot?.members ?? activeGroup?.members;
  const resolveTranscriptBot = useCallback(
    (botId: string) => {
      const bot = bots.find((candidate) => candidate.id === botId);
      if (bot) return bot;
      return transcriptMembers?.find((member) => member.botId === botId);
    },
    [bots, transcriptMembers],
  );
  // A send without a mention goes to the bot, or to a group's lead.
  const sendsTo = inGroup
    ? groupLeadBotId(
        (transcriptMembers ?? []).map((member) => ({ id: member.botId })),
        activeGroup?.leadBotId,
      )
    : active?.id;
  const answerName =
    sendsTo && answersPendingQuestion(view, sendsTo, currentRuns)
      ? resolveTranscriptBot(sendsTo)?.name
      : undefined;
  const workingBots: GroupAvatarMember[] = workingRuns.map((run) => {
    const bot = resolveTranscriptBot(run.botId);
    return {
      botId: run.botId,
      avatarCharacter: bot?.avatarCharacter,
      name: bot?.name,
      status: run.status,
    };
  });
  // The working line's clock reads from when the run actually started, not
  // from whenever the transcript happened to mount.
  const workingStartedAt =
    workingRuns.length > 0
      ? Math.min(...workingRuns.map((run) => new Date(run.startedAt ?? run.createdAt).getTime()))
      : undefined;
  // The snapshot names everyone who ever wrote, the live group whoever joined since it was taken.
  const snapshotPeople = activeSnapshot?.people;
  const groupPeople = activeGroup?.people;
  // A message naming no author is the creator's.
  const creatorId = activeGroup?.creatorId;
  const personOf = useCallback(
    (message: MessageItem): GroupPerson | undefined => {
      if (!inGroup || message.role !== "user") return undefined;
      const authorId = message.authorId ?? creatorId;
      if (!authorId || !viewerId || authorId === viewerId) return undefined;
      return (
        snapshotPeople?.find((person) => person.userId === authorId) ??
        groupPeople?.find((person) => person.userId === authorId) ?? {
          userId: authorId,
          name: "",
          image: null,
        }
      );
    },
    [inGroup, creatorId, viewerId, snapshotPeople, groupPeople],
  );
  // The cards other people's runs wait on, each with the name of who answers it.
  const waitingOn = useMemo(() => {
    const nameOf = (userId: string) =>
      snapshotPeople?.find((person) => person.userId === userId)?.name ??
      groupPeople?.find((person) => person.userId === userId)?.name ??
      "";
    const items = view.rows.map((row) => row.item);
    return new Map([
      ...view.open.flatMap((card) => {
        const userId = othersRuns.get(card.runId);
        return userId ? [[card.itemId as string, nameOf(userId)] as const] : [];
      }),
      // A computer card waits on them too, while their run waits for its screen.
      ...currentRuns.flatMap((run) => {
        const userId = othersRuns.get(run.id);
        const itemId = userId ? latestTakeoverItemId(items, [run]) : null;
        return userId && itemId ? [[itemId, nameOf(userId)] as const] : [];
      }),
    ]);
  }, [view.open, view.rows, currentRuns, othersRuns, snapshotPeople, groupPeople]);
  const resolveTranscriptMemberName = useCallback(
    (botId: string | undefined) => memberName(transcriptMembers, botId),
    [transcriptMembers],
  );

  return {
    activeSnapshot,
    view,
    viewRef,
    rowIndexOf,
    transcriptRunning,
    composerRunning,
    takeoverItemId,
    takeoverRun,
    recentWriting,
    callThread,
    transcriptArtifactTarget,
    resolveTranscriptBot,
    resolveTranscriptMemberName,
    personOf,
    waitingOn,
    answerName,
    workingBots,
    workingStartedAt,
  };
}

export type ThreadViewState = ReturnType<typeof useThreadView>;

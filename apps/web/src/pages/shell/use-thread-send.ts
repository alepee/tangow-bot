import { useLingui } from "@lingui/react/macro";
import type { MessageReaction } from "@tangow/contracts";
import type { ComposerMention, ComposerPageHead } from "@tangow/core";
import {
  attachmentsForThread,
  editedWaitingDraft,
  inferAttachmentMimeType,
  resolveComposerSendPlan,
} from "@tangow/core";
import { useCallback, useState } from "react";
import type { CardEdits } from "../../components/AskCard";
import { requestBrowserNotificationPermission } from "../../lib/browser-notifications";
import { draftEdits } from "../../lib/draft-edits";
import { revokePendingAttachmentPreviews } from "../../lib/pending-attachments";
import { rpc } from "../../lib/rpc";
import { applyThreadSendReceipt, clearActiveThreadRuns } from "../../lib/thread-events";
import type { CardAnswerTarget, MessageItem } from "../../lib/thread-items";
import type { ComposerDraft } from "./use-composer-draft";
import type { Roster } from "./use-roster";
import type { ThreadStore } from "./use-thread-store";
import type { ThreadSync } from "./use-thread-sync";
import type { ThreadViewState } from "./use-thread-view";
import { messageIdOf } from "./use-thread-view";

function newClientNonce(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const base64 = result.includes(",") ? (result.split(",")[1] ?? "") : result;
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

/** What the person sends into the open thread: messages, answers, reactions, stop. */
export function useThreadSend({
  roster,
  store,
  sync,
  thread,
  draft,
  flushPendingBrowserNotifications,
  cancelFocusPromptFor,
}: {
  roster: Roster;
  store: ThreadStore;
  sync: ThreadSync;
  thread: ThreadViewState;
  draft: ComposerDraft;
  flushPendingBrowserNotifications: () => void;
  cancelFocusPromptFor: (botId: string | undefined) => void;
}) {
  const { t } = useLingui();
  const { activeBotId, activeGroupId, botsRef, refreshBots } = roster;
  const { updateSnapshot, computerRef, commitComputer, terminalRunReceipts } = store;
  const { refreshThreadRef, refreshGroupThreadRef } = sync;
  const { viewRef } = thread;
  const { pendingAttachments, setPendingAttachments, setAttachmentNotice } = draft;
  const { activeReplyTarget, activeRewindTarget, rewindArtifacts, cancelRewind } = draft;
  const { setReplyTarget, setRewindDraft, setSendError } = draft;
  const [sending, setSending] = useState(false);

  const answerCard = useCallback(
    async (target: CardAnswerTarget, text: string, edits?: CardEdits) => {
      const { thread } = target;
      const groupId = "groupId" in thread ? thread.groupId : undefined;
      const botId = "botId" in thread ? thread.botId : undefined;
      await rpc.threads.answer({
        ...thread,
        runId: target.runId,
        messageId: target.messageId,
        answer: text,
        ...(edits ? { edits } : {}),
      });
      if (groupId && activeGroupId.current === groupId) {
        await refreshGroupThreadRef.current(groupId);
      } else if (botId && activeBotId.current === botId) {
        await refreshThreadRef.current(botId);
      }
    },
    [],
  );
  const reactToMessage = useCallback(
    async (message: MessageItem, reaction: MessageReaction) => {
      const botId = activeBotId.current;
      const groupId = activeGroupId.current;
      const messageId = messageIdOf(viewRef.current, message);
      if ((!botId && !groupId) || !messageId) return;
      try {
        await rpc.threads.react({
          ...(groupId ? { groupId } : { botId: botId! }),
          messageId,
          reaction,
          clientNonce: newClientNonce(),
        });
      } catch (error) {
        const stillHere = groupId
          ? activeGroupId.current === groupId
          : activeBotId.current === botId;
        if (!stillHere) return;
        setSendError(error instanceof Error ? error.message : t`Could not update reaction`);
      }
    },
    [t],
  );
  const sendMessage = useCallback(
    async (
      text: string,
      mentions: ComposerMention[] = [],
      options: { linkPreview?: false } = {},
    ) => {
      const botTarget = activeBotId.current;
      const groupTarget = activeGroupId.current;
      if ((!botTarget && !groupTarget) || sending) return;
      const originThreadKey = groupTarget ?? botTarget;
      const attachments = attachmentsForThread(pendingAttachments, originThreadKey);
      const rewindMessageId = activeRewindTarget?.id;
      const replyToMessageId = activeReplyTarget
        ? messageIdOf(viewRef.current, activeReplyTarget)
        : undefined;
      const restoredArtifactIds = rewindMessageId ? rewindArtifacts.map((item) => item.id) : [];
      const plan = resolveComposerSendPlan({
        text,
        mentions,
        hasAttachments: attachments.length > 0 || restoredArtifactIds.length > 0,
      });
      if (plan.isNoOp) return;
      if (
        plan.shouldSend &&
        (groupTarget || botsRef.current.find((bot) => bot.id === botTarget)?.notifyOnFinish)
      ) {
        const permissionRequest = requestBrowserNotificationPermission();
        if (permissionRequest) void permissionRequest.then(flushPendingBrowserNotifications);
      }
      const trimmed = plan.trimmed;
      setSending(true);
      setSendError(null);
      // Only after successful engagement so a failed upload/send keeps the setup card.
      const dropDelayedSetup = () => cancelFocusPromptFor(botTarget);
      let replaced: ReturnType<typeof editedWaitingDraft>;
      try {
        if (plan.shouldRunRoutines) {
          const sendNonce = newClientNonce();
          await Promise.all(
            plan.routineIds.map((routineId) =>
              rpc.routines.testRun({
                routineId,
                clientNonce: `routine-mention:${sendNonce}:${routineId}`,
              }),
            ),
          );
        }
        if (!plan.shouldSend) {
          dropDelayedSetup();
          setReplyTarget(null);
          revokePendingAttachmentPreviews(attachments);
          setPendingAttachments((current) =>
            current.filter((attachment) => attachment.threadKey !== originThreadKey),
          );
          setAttachmentNotice(null);
          if (groupTarget && activeGroupId.current === groupTarget) {
            await refreshGroupThreadRef.current(groupTarget);
          } else if (botTarget && activeBotId.current === botTarget) {
            await refreshThreadRef.current(botTarget);
          }
          return;
        }
        const artifactIds: string[] = [...restoredArtifactIds];
        for (const pending of attachments) {
          const mimeType = inferAttachmentMimeType(pending.file.name, pending.file.type);
          if (!mimeType) {
            throw new Error(t`Unsupported file type: ${pending.file.name}`);
          }
          const contentBase64 = await readFileAsBase64(pending.file);
          const artifact = await rpc.artifacts.create(
            groupTarget
              ? { groupId: groupTarget, name: pending.file.name, mimeType, contentBase64 }
              : { botId: botTarget!, name: pending.file.name, mimeType, contentBase64 },
          );
          artifactIds.push(artifact.id);
        }
        // Truncation happens here rather than on Edit, so backing out costs nothing.
        if (rewindMessageId) {
          await rpc.threads.rewind(
            groupTarget
              ? { groupId: groupTarget, messageId: rewindMessageId }
              : { botId: botTarget!, messageId: rewindMessageId },
          );
        }
        const clientNonce = newClientNonce();
        replaced = editedWaitingDraft(viewRef.current, (itemId) => draftEdits.get(itemId));
        if (groupTarget) {
          await rpc.threads.send({
            groupId: groupTarget,
            clientNonce,
            text: trimmed || undefined,
            mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
            artifactIds: artifactIds.length ? artifactIds : undefined,
            replyToMessageId,
            linkPreview: options.linkPreview,
            draft: replaced?.draft,
          });
        } else if (botTarget) {
          const sent = await rpc.threads.send({
            botId: botTarget,
            clientNonce,
            text: trimmed || undefined,
            mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
            artifactIds: artifactIds.length ? artifactIds : undefined,
            replyToMessageId,
            linkPreview: options.linkPreview,
            draft: replaced?.draft,
          });
          const { runId, taskId } = sent;
          // A bot's own thread always answers with a run; only a group message may have none.
          if (activeBotId.current === botTarget && runId && taskId) {
            updateSnapshot((current) =>
              applyThreadSendReceipt(
                current,
                { botId: botTarget, runId, taskId },
                terminalRunReceipts.current,
              ),
            );
          }
        }
        if (replaced) draftEdits.delete(replaced.itemId);
        // The server took the reply: a later failure, such as the refresh, has nothing to hand back.
        replaced = undefined;
        dropDelayedSetup();
        setReplyTarget(null);
        cancelRewind();
        revokePendingAttachmentPreviews(attachments);
        setPendingAttachments((current) =>
          current.filter((attachment) => attachment.threadKey !== originThreadKey),
        );
        void refreshBots().catch(() => undefined);
        if (groupTarget && activeGroupId.current === groupTarget) setAttachmentNotice(null);
        if (botTarget && activeBotId.current === botTarget) setAttachmentNotice(null);
        // The message is in the log and on the feed: the next one can go while the thread refreshes.
        setSending(false);
        // A send leaves a search jump's window for the latest page, where the message and its reply land.
        store.leaveJumpWindow({ snapToEnd: true });
        if (groupTarget) await refreshGroupThreadRef.current(groupTarget);
        else if (botTarget) await refreshThreadRef.current(botTarget);
      } catch (error) {
        // The composer already dropped the text on send, so hand it back for another try: after an
        // edit, or a reply the server refused because no waiting draft took its text.
        if (rewindMessageId || replaced) {
          // The person had taken the link preview off this message: the retry keeps it off.
          setRewindDraft({
            key: `retry:${newClientNonce()}`,
            text: trimmed,
            linkPreviewRemoved: options.linkPreview === false,
          });
        }
        if (groupTarget && activeGroupId.current === groupTarget) {
          setSendError(error instanceof Error ? error.message : t`Failed to send message`);
        } else if (botTarget && activeBotId.current === botTarget) {
          setSendError(error instanceof Error ? error.message : t`Failed to send message`);
        }
      } finally {
        setSending(false);
      }
    },
    [
      activeReplyTarget,
      activeRewindTarget?.id,
      cancelRewind,
      flushPendingBrowserNotifications,
      pendingAttachments,
      rewindArtifacts,
      sending,
      t,
    ],
  );
  const followUpMessage = useCallback(async (text: string) => {
    const id = activeBotId.current;
    if (!id) return;
    await rpc.threads.followUp({ botId: id, text });
    await refreshThreadRef.current(id);
  }, []);
  const stopRun = useCallback(async () => {
    if (sending) return;
    setSending(true);
    try {
      const botTarget = activeBotId.current;
      const groupTarget = activeGroupId.current;
      if (groupTarget) {
        setSendError(null);
        try {
          await rpc.threads.stop({ groupId: groupTarget });
        } catch (error) {
          if (activeGroupId.current === groupTarget) {
            setSendError(error instanceof Error ? error.message : t`Failed to stop`);
          }
          return;
        }
        // Stop has no terminal event; clear run UI before refresh races with in-flight gets.
        if (activeGroupId.current === groupTarget) {
          updateSnapshot((prev) =>
            prev && prev.groupId === groupTarget ? clearActiveThreadRuns(prev) : prev,
          );
        }
        await refreshGroupThreadRef.current(groupTarget).catch(() => undefined);
        return;
      }
      if (!botTarget) return;
      setSendError(null);
      try {
        await rpc.threads.stop({ botId: botTarget });
      } catch (error) {
        if (activeBotId.current === botTarget) {
          setSendError(error instanceof Error ? error.message : t`Failed to stop`);
        }
        return;
      }
      // Stop does not emit a terminal thread event. Clear local run/busy immediately so a
      // superseded in-flight refresh (older cursor) cannot leave Stop enabled / Take control
      // blocked while the API is already idle.
      if (activeBotId.current === botTarget) {
        updateSnapshot((prev) =>
          !prev || (prev.botId !== botTarget && prev.botId) ? prev : clearActiveThreadRuns(prev),
        );
        const currentComputer = computerRef.current;
        if (currentComputer?.busyBotName) {
          commitComputer({ ...currentComputer, busyBotName: null });
        }
      }
      await refreshThreadRef.current(botTarget).catch(() => undefined);
    } finally {
      setSending(false);
    }
  }, [sending, t]);
  const composerThreadId = roster.inGroup ? roster.activeGroup?.threadId : roster.active?.threadId;
  const previewLink = useCallback(
    (url: string, signal: AbortSignal, page?: ComposerPageHead) =>
      composerThreadId
        ? rpc.links.preview(
            {
              threadId: composerThreadId,
              url,
              ...(page
                ? {
                    pageHead: page.head,
                    ...(page.contentType ? { pageHeadType: page.contentType } : {}),
                  }
                : {}),
            },
            { signal },
          )
        : Promise.resolve(null),
    [composerThreadId],
  );

  return {
    sending,
    sendMessage,
    followUpMessage,
    stopRun,
    answerCard,
    reactToMessage,
    previewLink,
  };
}

export type ThreadSend = ReturnType<typeof useThreadSend>;

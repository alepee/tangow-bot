import { Trans } from "@lingui/react/macro";
import type { EntityMentions } from "@tangow/chat-ui/web";
import { EntityMentionsProvider } from "@tangow/chat-ui/web";
import type { AgentSkillCatalogEntry } from "@tangow/contracts";
import { ATTACHMENT_MAX_BYTES } from "@tangow/contracts";
import type { ComposerMention, SkillSourceBlock } from "@tangow/core";
import { BotAvatar, Button } from "@tangow/ui-web";
import { Paperclip, Plus } from "lucide-react";
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import type { NavigateFunction } from "react-router-dom";
import { dictation } from "../../lib/dictation";
import { rpc } from "../../lib/rpc";
import { Composer } from "./composer";
import { useComposerFileDrop } from "./composer-attachments";
import { botPageFor, threadJumpLocation } from "./layout";
import { SessionView } from "./session-view";
import { skillPageView } from "./skill-link";
import { ThreadHeader } from "./thread-header";
import { Transcript } from "./transcript";
import type { ComposerDraft } from "./use-composer-draft";
import type { Panels } from "./use-panels";
import type { Roster } from "./use-roster";
import type { ShellOverlayState } from "./use-shell-overlays";
import type { ThreadSend } from "./use-thread-send";
import type { ThreadStore } from "./use-thread-store";
import type { ThreadSync } from "./use-thread-sync";
import type { ThreadViewState } from "./use-thread-view";
import type { TranscriptWindow } from "./use-transcript-window";
import type { Voice } from "./use-voice";

const ATTACHMENT_MAX_MB = ATTACHMENT_MAX_BYTES / (1024 * 1024);

const CallView = lazy(() => import("../CallView").then((module) => ({ default: module.CallView })));

/** The conversation column: the call view over it, the thread header, transcript and composer. */
export function ShellMain({
  roster,
  store,
  panels,
  overlays,
  voice,
  thread,
  transcriptWindow,
  draft,
  send,
  sync,
  navigate,
  userId,
  mobileSidebarOpen,
  botsSidebarCollapsed,
  setBotsSidebarCollapsedPref,
  recording,
  mentionTargets,
  agentSkills,
  refreshAgentSkills,
  onOpenComputer,
}: {
  roster: Roster;
  store: ThreadStore;
  panels: Panels;
  overlays: ShellOverlayState;
  voice: Voice;
  thread: ThreadViewState;
  transcriptWindow: TranscriptWindow;
  draft: ComposerDraft;
  send: ThreadSend;
  sync: ThreadSync;
  navigate: NavigateFunction;
  userId: string | undefined;
  mobileSidebarOpen: boolean;
  botsSidebarCollapsed: boolean;
  setBotsSidebarCollapsedPref: (collapsed: boolean) => void;
  recording: boolean;
  mentionTargets: ComposerMention[];
  agentSkills: AgentSkillCatalogEntry[];
  refreshAgentSkills: () => void;
  /** Opens the bot's screen from its live Needs you card. */
  onOpenComputer: () => void;
}) {
  const { active, activeGroup, groupId, inGroup, initialBotsLoaded, refreshBots } = roster;
  // A group of several people keeps its history: no one edits it alone.
  const sharedHistory = inGroup && (activeGroup?.people.length ?? 0) > 1;
  const { panel, setPanel, pickedBotId, showBotPage, panelOpen, panelSize } = panels;
  const { panelCoversColumn } = panels;
  const { callOpen, setCallOpen, voiceStatus } = voice;
  const { activeSnapshot, view } = thread;
  const { openSettings, setPeerConversation, runView, setRunView } = overlays;
  const { setReplyTarget, setRewindArtifacts } = draft;
  const [composerDictating, setComposerDictating] = useState(false);
  const { draggingFiles, dropHandlers } = useComposerFileDrop({
    disabled: recording || composerDictating || !(active || activeGroup),
    onAttachmentPick: draft.onAttachmentPick,
  });
  const openBot = useCallback(
    (id: string, messageId?: string) => navigate(threadJumpLocation({ botId: id, messageId })),
    [navigate],
  );
  const addSkillRoutine = useCallback(
    (name: string, prompt: string) => {
      showBotPage({ tab: "routines", detail: { kind: "routine-new", seed: { name, prompt } } });
    },
    [showBotPage],
  );
  const openSkill = useCallback(
    async (skill: SkillSourceBlock) => {
      showBotPage(await skillPageView(skill, () => rpc.agentSkills.list().catch(() => [])));
    },
    [showBotPage],
  );

  // The bubbles draw in place what the composer can name.
  const entityMentions = useMemo<EntityMentions>(
    () => ({
      mentions: mentionTargets,
      skills: agentSkills,
      avatar: (character) => <BotAvatar character={character} size={16} />,
    }),
    [mentionTargets, agentSkills],
  );

  return (
    <EntityMentionsProvider value={entityMentions}>
      <main
        aria-hidden={mobileSidebarOpen || undefined}
        inert={mobileSidebarOpen}
        // Wide enough for both: the open panel takes the end of the shell and
        // the header and thread column reflow into what is left, so the header
        // button and the composer stay reachable. Narrower than that the panel
        // covers the thread instead, and closes with Escape or its X.
        className={`relative flex min-w-0 flex-1 flex-col ${
          panelOpen ? (panelSize === "wide" ? "lg:pe-panel xl:pe-panel-wide" : "lg:pe-panel") : ""
        }`}
      >
        {callOpen && active ? (
          <Suspense fallback={null}>
            {/* Above the composer (z-30), so it never hides Mute and End call. */}
            <div className="rk-ambient absolute inset-0 z-40 flex flex-col">
              <CallView
                botId={active.id}
                botName={active.name}
                botColor={active.color}
                botAvatarCharacter={active.avatarCharacter}
                transcribe={Boolean(voiceStatus?.transcribe)}
                thread={activeSnapshot ? thread.callThread : null}
                onSend={send.sendMessage}
                onFollowUp={send.followUpMessage}
                onAnswer={send.answerCard}
                onClose={() => setCallOpen(false)}
              />
            </div>
          </Suspense>
        ) : null}
        {/* Stays mounted behind an open call, or behind a panel that covers it
          below `lg`, so the composer's draft and the thread's scroll
          position survive, exactly as they did with the old dialog. */}
        <div
          data-testid="conversation-column"
          aria-hidden={callOpen || panelCoversColumn || undefined}
          inert={callOpen || panelCoversColumn}
          data-dragging={draggingFiles ? "files" : undefined}
          {...dropHandlers}
          className="relative flex min-h-0 flex-1 flex-col"
        >
          {draggingFiles ? (
            // A pane floating 8 from the edges like the sidebar, on the composer's lighter glass; beside an open sidebar
            // the column already starts 8 past it.
            <div
              className={`rk-glass-control pointer-events-none absolute inset-2 z-40 flex animate-in flex-col items-center justify-center gap-1 rounded-pane fade-in px-6 text-center duration-(--duration-arrive) ${
                botsSidebarCollapsed ? "" : "md:start-0"
              }`}
            >
              <Paperclip size={24} aria-hidden="true" className="mb-2" />
              <p className="text-title">
                <Trans>Drop files to attach</Trans>
              </p>
              <p className="text-meta text-muted-foreground">
                <Trans>Images, PDFs, text, CSV or JSON, up to {ATTACHMENT_MAX_MB} MB each</Trans>
              </p>
            </div>
          ) : null}
          <ThreadHeader
            botsSidebarCollapsed={botsSidebarCollapsed}
            setBotsSidebarCollapsedPref={setBotsSidebarCollapsedPref}
            inGroup={inGroup}
            active={active}
            activeGroup={activeGroup}
            activeSnapshot={activeSnapshot}
            // An archived bot's page is not this conversation's bot page: the gear opens the latter.
            panel={panel === "bot" && pickedBotId ? null : panel}
            setPanel={setPanel}
            onOpenBotPage={showBotPage}
            refreshThread={sync.refreshThread}
            disabled={recording}
            onVoice={
              !inGroup && active
                ? () => {
                    // The composer's dictation and the call share the same
                    // `Dictation` instance; starting the call must cancel a
                    // dictation in progress first (the composer restores its
                    // draft once it sees dictation get cut off from under it).
                    dictation.stop("cancel");
                    if (!voiceStatus?.ready) {
                      openSettings(voiceStatus?.configured ? "voice" : "providers");
                      return;
                    }
                    setCallOpen(true);
                  }
                : undefined
            }
            voiceButtonRef={voice.voiceButtonRef}
          />
          <div className="mx-auto flex min-h-0 w-full max-w-thread flex-1 flex-col px-3.5">
            {!active && !activeGroup && initialBotsLoaded ? (
              <div className="grid flex-1 place-items-center">
                <Button onClick={() => setPanel("create")}>
                  <Plus size={16} aria-hidden="true" />
                  <Trans>Create new Bot</Trans>
                </Button>
              </div>
            ) : (
              <Transcript
                key={activeSnapshot?.threadId}
                scrollRef={store.messageScroll}
                followingRef={store.followingEnd}
                artifactTarget={thread.transcriptArtifactTarget}
                inGroup={inGroup}
                view={view}
                olderCursor={activeSnapshot?.olderCursor ?? null}
                loadingOlder={transcriptWindow.loadingOlder}
                viewerUserId={userId}
                personOf={thread.personOf}
                waitingOn={thread.waitingOn}
                takeoverItemId={thread.takeoverItemId}
                onOpenComputer={onOpenComputer}
                running={thread.transcriptRunning}
                workingBots={thread.workingBots}
                workingStartedAt={thread.workingStartedAt}
                onLoadOlder={transcriptWindow.loadOlder}
                onOpenBot={openBot}
                onAnswer={send.answerCard}
                onReply={setReplyTarget}
                onEdit={sharedHistory ? undefined : draft.startRewind}
                rewindFromItemId={draft.activeRewindTarget?.id ?? null}
                onReact={send.reactToMessage}
                onJumpToMessage={transcriptWindow.jumpToReplyMessage}
                onOpenPeerMessages={(peer) => {
                  setPeerConversation(peer);
                }}
                memberName={thread.resolveTranscriptMemberName}
                peerBot={thread.resolveTranscriptBot}
                onRefresh={sync.refreshActiveThread}
                onBotChanged={refreshBots}
                onAddRoutine={addSkillRoutine}
                onOpenSkill={inGroup ? undefined : openSkill}
                onOpenIntegrations={() => overlays.setCustomizeOpen(true)}
                voiceReady={Boolean(voiceStatus?.ready)}
                speakingMessageId={voice.speakingMessageId}
                onSpeak={voice.speakMessage}
              />
            )}
            {runView ? (
              <SessionView
                key={runView.runId}
                target={{ kind: "run", runId: runView.runId, title: runView.title }}
                context={{
                  // The run's own chat, which need not be the one open behind the dialog.
                  artifactTarget: runView.groupId
                    ? { groupId: runView.groupId }
                    : { botId: runView.botId },
                  inGroup: runView.groupId !== null,
                  viewerUserId: userId,
                  peerBot: thread.resolveTranscriptBot,
                  onOpenBot: openBot,
                  onOpenPeerMessages: setPeerConversation,
                  onRefresh: sync.refreshActiveThread,
                  onBotChanged: refreshBots,
                  onAddRoutine: addSkillRoutine,
                }}
                onClose={() => setRunView(null)}
              />
            ) : null}
            {recording ? (
              <div className="pb-2 text-center text-meta text-destructive">
                <Trans>Teaching in progress. Stop teaching before sending a new message.</Trans>
              </div>
            ) : null}
            {active || activeGroup ? (
              <Composer
                key={inGroup ? `group:${groupId}` : `bot:${active?.id}`}
                activeName={
                  inGroup ? (activeGroup?.name ?? activeSnapshot?.groupName) : active?.name
                }
                answerName={thread.answerName}
                running={thread.composerRunning}
                botColor={active?.color}
                disabled={recording}
                pendingAttachments={draft.activePendingAttachments}
                attachmentNotice={draft.attachmentNotice}
                sendError={draft.sendError}
                runError={draft.displayedRunError}
                runErrorId={draft.displayedRunErrorId}
                onRunErrorPresented={draft.handleRunErrorPresented}
                onDismissError={draft.dismissComposerError}
                sending={send.sending}
                fileInputRef={draft.fileInputRef}
                onAttachmentPick={draft.onAttachmentPick}
                onRemoveAttachment={draft.removeAttachment}
                onSend={send.sendMessage}
                previewLink={send.previewLink}
                onStop={send.stopRun}
                dictationTranscribe={Boolean(voiceStatus?.transcribe)}
                replyTarget={draft.activeReplyTarget}
                replyTargetName={draft.replyTargetName}
                onClearReply={() => setReplyTarget(null)}
                rewindTarget={draft.activeRewindTarget}
                rewindDraft={draft.rewindDraft}
                rewindRemovedCount={draft.rewindRemovedCount}
                rewindArtifacts={draft.rewindArtifacts}
                onCancelRewind={draft.cancelRewind}
                onRemoveRewindArtifact={(artifactId) =>
                  setRewindArtifacts((current) => current.filter((item) => item.id !== artifactId))
                }
                mentionTargets={mentionTargets}
                agentSkills={agentSkills}
                recentWriting={thread.recentWriting}
                onDictatingChange={setComposerDictating}
                onSlashOpen={refreshAgentSkills}
                chatSettings={inGroup || active?.isOwner !== false}
                onSlashAction={(action) => {
                  if (action === "chat-settings") {
                    if (inGroup) setPanel("group-settings");
                    else showBotPage(botPageFor("slash", active));
                    return;
                  }
                  if (action === "settings-general") {
                    openSettings();
                    return;
                  }
                  if (action === "settings-usage") openSettings("usage");
                }}
              />
            ) : null}
          </div>
        </div>
      </main>
    </EntityMentionsProvider>
  );
}

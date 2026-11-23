import { i18n } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@tangow/chat-ui/web";
import type { EntryId, ThreadEntry } from "@tangow/contracts";
import {
  computeMessageGroups,
  peerConversations,
  showsTimeMarker,
  stripPeerAddressPrefix,
  threadTimeMarkerLabel,
} from "@tangow/core";
import {
  BotAvatar,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  MessageBubble,
  MessageRow,
} from "@tangow/ui-web";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { desktopBridge } from "../lib/desktop";
import { rpc } from "../lib/rpc";
import { WindowChrome } from "./WindowChrome";

/**
 * Full-screen view-only transcript of a bot-to-bot exchange.
 * Opened from a Messaged / Message from chip in the human thread.
 */
export function PeerMessagesOverlay({
  botId,
  botName,
  botAvatarCharacter,
  peerBotId,
  peerBotName: initialPeerBotName,
  peerBotAvatarCharacter,
  onClose,
}: {
  botId: string;
  botName: string;
  botAvatarCharacter?: string | null;
  peerBotId: string;
  peerBotName: string;
  peerBotAvatarCharacter?: string | null;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [entries, setEntries] = useState<readonly ThreadEntry[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const olderCursor = useRef<EntryId | null>(null);
  const loadingOlder = useRef(false);
  const heightBeforeOlder = useRef<number | null>(null);
  const conversation = useMemo(() => {
    if (!historyReady) return null;
    return peerConversations(entries).find((entry) => entry.peerBotId === peerBotId) ?? null;
  }, [historyReady, entries, peerBotId]);
  const peerBotName = conversation?.peerBotName ?? initialPeerBotName;
  const transcriptRef = useRef<HTMLDivElement>(null);
  // Same grammar as the main thread's multi-bot grouping (rule R): consecutive
  // messages from the same side share one name/avatar. Both sides are "bot"
  // messages here — a peer exchange never shows the dark `chatUser` bubble —
  // and grouping keys on which bot actually sent each message.
  const peerGroups = useMemo(() => {
    const groupable = (conversation?.messages ?? []).map((peerMessage) => ({
      role: "bot" as const,
      botId: peerMessage.direction === "sent" ? botId : peerBotId,
      createdAt: peerMessage.createdAt,
      blocks: [{ kind: "text" as const, text: peerMessage.text }],
    }));
    return computeMessageGroups(groupable);
  }, [conversation, botId, peerBotId]);

  // Oldest-first order stays, but the view opens on the latest exchange.
  useLayoutEffect(() => {
    const element = transcriptRef.current;
    if (element && historyReady) element.scrollTop = element.scrollHeight;
  }, [historyReady]);

  useLayoutEffect(() => {
    const element = transcriptRef.current;
    if (!element || heightBeforeOlder.current === null) return;
    element.scrollTop += element.scrollHeight - heightBeforeOlder.current;
    heightBeforeOlder.current = null;
  }, [entries]);

  useEffect(() => {
    const abort = new AbortController();
    setHistoryReady(false);
    setHistoryFailed(false);
    setEntries([]);
    olderCursor.current = null;
    rpc.threads
      .peerMessages({ botId, peerBotId }, { signal: abort.signal })
      .then((page) => {
        if (abort.signal.aborted) return;
        setEntries(page.entries);
        olderCursor.current = page.olderCursor;
        setHistoryReady(true);
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        setHistoryFailed(true);
        setHistoryReady(true);
      });
    return () => {
      abort.abort();
    };
  }, [botId, peerBotId, reloadKey]);

  async function loadOlder() {
    const element = transcriptRef.current;
    const before = olderCursor.current;
    if (!element || before === null || loadingOlder.current) return;
    loadingOlder.current = true;
    try {
      const page = await rpc.threads.peerMessages({ botId, peerBotId, before });
      heightBeforeOlder.current = element.scrollHeight;
      setEntries((held) => [...page.entries, ...held]);
      olderCursor.current = page.olderCursor;
    } catch {
    } finally {
      loadingOlder.current = false;
    }
  }

  const title = `${botName} · ${peerBotName}`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-testid="peer-conversation-view"
        showCloseButton={false}
        className="inset-0 top-0 left-0 flex h-full w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-background p-0 text-foreground shadow-none sm:max-w-none"
      >
        <div className="app-drag flex items-center justify-between gap-4 border-b border-sidebar-border px-[18px] py-3.5">
          <div className="app-no-drag flex min-w-0 flex-1 items-center gap-3">
            {/* The overlay covers the shell header, so it reserves room for the window controls itself. */}
            {desktopBridge() ? <WindowChrome /> : null}
            <div className="flex items-center -space-x-2">
              <BotAvatar character={botAvatarCharacter} size={28} />
              <BotAvatar character={peerBotAvatarCharacter} size={28} />
            </div>
            <DialogTitle className="truncate text-[15.5px] font-medium text-foreground" dir="auto">
              {title}
            </DialogTitle>
          </div>
          <DialogClose
            aria-label={t`Close`}
            render={<Button variant="ghost" size="sm" className="app-no-drag" />}
          >
            <Trans>Close</Trans>
          </DialogClose>
        </div>

        {!historyReady ? (
          <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-muted-foreground/80">
            <Trans>Loading…</Trans>
          </div>
        ) : historyFailed ? (
          <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-muted-foreground/80">
            <div className="flex flex-col items-center gap-3">
              <Trans>Could not load this chat.</Trans>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReloadKey((value) => value + 1)}
              >
                <Trans>Retry now</Trans>
              </Button>
            </div>
          </div>
        ) : !conversation || conversation.messages.length === 0 ? (
          <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-muted-foreground/80">
            <Trans>No messages with {peerBotName} yet.</Trans>
          </div>
        ) : (
          <div
            ref={transcriptRef}
            data-testid="peer-conversation-transcript"
            onScroll={(event) => {
              if (event.currentTarget.scrollTop < 400) void loadOlder();
            }}
            className="rk-scroll flex min-h-0 flex-1 flex-col overflow-y-auto py-5 md:py-6"
          >
            <div className="mx-auto flex w-full max-w-thread flex-col gap-3.5 px-6.5">
              {conversation.messages.map((peerMessage, index) => {
                const group = peerGroups[index]!;
                const sent = peerMessage.direction === "sent";
                const name = sent ? botName : peerBotName;
                const avatarCharacter = sent ? botAvatarCharacter : peerBotAvatarCharacter;
                const timeMarker = showsTimeMarker(
                  conversation.messages[index - 1]?.createdAt,
                  peerMessage.createdAt,
                )
                  ? threadTimeMarkerLabel(peerMessage.createdAt, {
                      locale: i18n.locale || "en",
                      today: t`Today`,
                      yesterday: t`Yesterday`,
                    })
                  : "";
                return (
                  <Fragment key={peerMessage.messageId}>
                    {timeMarker ? (
                      <time
                        dateTime={peerMessage.createdAt}
                        className="self-center text-label tabular-nums text-muted-foreground"
                      >
                        {timeMarker}
                      </time>
                    ) : null}
                    {/* Both sides render as bot rows: the dark `chatUser` fill is the human's. */}
                    <MessageRow
                      avatar={<BotAvatar character={avatarCharacter} size={32} />}
                      author={<span dir="auto">{name}</span>}
                      showAuthor={group.isFirstOfGroup}
                      showAvatar={group.isLastOfGroup}
                      className={group.isFirstOfGroup ? undefined : "-mt-2.75"}
                    >
                      <MessageBubble inGroup dir="auto">
                        <ChatMarkdown>{stripPeerAddressPrefix(peerMessage.text)}</ChatMarkdown>
                      </MessageBubble>
                    </MessageRow>
                  </Fragment>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex items-center gap-4 border-t border-sidebar-border px-[18px] py-3.5">
          <p className="text-[13.5px] text-muted-foreground/80">
            <Trans>This chat is view-only</Trans>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

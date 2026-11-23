import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import { Pencil, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { MessageItem } from "../../lib/thread-items";
import { previewMessageText } from "./message-view";

/** What sits above the composer bar: the error, the reply and rewind chips, and the attachment notice. */
export function ComposerNotices({
  sendError,
  runError,
  dictationError,
  runErrorId,
  onRunErrorPresented,
  onDismissError,
  replyTarget,
  replyTargetName,
  onClearReply,
  rewindTarget,
  rewindRemovedCount,
  onCancelRewind,
  attachmentNotice,
}: {
  sendError: string | null;
  runError: string | null;
  dictationError: string | null;
  runErrorId: string | null;
  onRunErrorPresented: (runId: string) => void;
  onDismissError: () => void;
  replyTarget?: MessageItem | null;
  replyTargetName?: string;
  onClearReply?: () => void;
  rewindTarget?: MessageItem | null;
  rewindRemovedCount?: number;
  onCancelRewind?: () => void;
  attachmentNotice: string | null;
}) {
  const { t } = useLingui();
  const runErrorRef = useRef<HTMLDivElement>(null);
  const presentedRunErrorIdRef = useRef<string | null>(null);
  const rewindTime = rewindTarget
    ? new Date(rewindTarget.ts).toLocaleTimeString(i18n.locale || "en", {
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
  const replyName = replyTarget ? (replyTargetName ?? previewMessageText(replyTarget)) : "";

  useEffect(() => {
    if (!runError || !runErrorId) return;
    const currentRunErrorId = runErrorId;
    let frame = 0;
    function recordIfPresented() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const element = runErrorRef.current;
        if (!element || document.visibilityState !== "visible") return;
        const rect = element.getBoundingClientRect();
        const topElement = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        if (topElement && (topElement === element || element.contains(topElement))) {
          if (presentedRunErrorIdRef.current === currentRunErrorId) return;
          presentedRunErrorIdRef.current = currentRunErrorId;
          onRunErrorPresented(currentRunErrorId);
        }
      });
    }
    recordIfPresented();
    const observer = new MutationObserver(recordIfPresented);
    // Uncovering the thread (the phone's bot list closing) only flips these attributes.
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["inert", "aria-hidden"],
    });
    document.addEventListener("transitionend", recordIfPresented);
    document.addEventListener("visibilitychange", recordIfPresented);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("transitionend", recordIfPresented);
      document.removeEventListener("visibilitychange", recordIfPresented);
    };
  }, [onRunErrorPresented, runError, runErrorId]);

  return (
    <>
      {sendError || runError || dictationError ? (
        <div
          ref={runErrorRef}
          role="alert"
          data-testid="composer-error"
          className="mb-3 flex items-center gap-2 rounded-card border border-destructive/40 bg-destructive/10 px-4 py-2 text-meta text-destructive"
        >
          <span className="min-w-0 flex-1">{sendError ?? runError ?? dictationError}</span>
          <button
            type="button"
            aria-label={t`Dismiss error`}
            data-testid="composer-error-dismiss"
            onClick={onDismissError}
            className="shrink-0 text-destructive hover:text-foreground"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ) : null}
      {replyTarget ? (
        <div
          data-testid="reply-chip"
          className="mb-2 flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1.5 text-meta text-foreground/75"
        >
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{t`Replying to ${replyName}`}</span>
          <button
            type="button"
            aria-label={t`Cancel reply`}
            onClick={onClearReply}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ) : null}
      {rewindTarget ? (
        <div
          data-testid="rewind-chip"
          className="mb-2 flex items-center gap-2 rounded-full border border-border bg-sidebar-border px-3 py-1.5 text-meta text-foreground"
        >
          <Pencil size={13} strokeWidth={1.8} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {t`Editing message from ${rewindTime} · ${rewindRemovedCount ?? 0} messages after it will be removed`}
          </span>
          <button
            type="button"
            aria-label={t`Cancel edit`}
            data-testid="rewind-chip-cancel"
            onClick={onCancelRewind}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ) : null}
      {attachmentNotice ? (
        <div className="mb-3 rounded-card border border-warning/40 bg-warning/10 px-4 py-2 text-meta text-warning">
          {attachmentNotice}
        </div>
      ) : null}
    </>
  );
}

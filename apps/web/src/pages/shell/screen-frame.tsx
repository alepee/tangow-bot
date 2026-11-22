import { useLingui } from "@lingui/react/macro";
import type { ScreenLink, ScreenLinkView } from "@tangow/core";
import { createScreenLink, screenLinkChannel } from "@tangow/core";
import { cn, Shimmer } from "@tangow/ui-web";
import { LoaderCircle } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

export interface ScreenLinkHandlers {
  /** Read the status and reuse or replace the screen URL. */
  onAdjudicate(): void;
  /** Force a new screen URL. */
  onReload(): void;
  /** The link to `url` gave up; show the error and its retry. */
  onFailed(url: string): void;
}

export function ScreenLinkOverlay({ view }: { view: "connecting" | "reconnecting" }) {
  const { t } = useLingui();
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 grid place-items-center p-2",
        view === "reconnecting" && "bg-overlay",
      )}
    >
      <span
        role="status"
        className="inline-flex items-center gap-2.5 whitespace-nowrap rounded-full bg-card px-3.5 py-2 text-working text-muted-foreground shadow-floating"
      >
        <LoaderCircle
          aria-hidden
          className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
        />
        <Shimmer>{view === "connecting" ? t`Connecting…` : t`Reconnecting`}</Shimmer>
      </span>
    </div>
  );
}

/**
 * The bot's screen with its connection state on top. The frame is keyed by URL, so a new URL
 * is a new document that starts over at "Connecting…". Place it in a `relative` container.
 */
export function ScreenFrame({
  url,
  title,
  allow,
  interactive,
  handlers,
}: {
  url: string;
  title: string;
  allow: string;
  /** Whether the viewer may drive the screen once it is connected. */
  interactive: boolean;
  handlers: ScreenLinkHandlers;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const linkRef = useRef<ScreenLink | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [view, setView] = useState<ScreenLinkView>("connecting");

  // Layout timing: the link must exist before the new frame can fire its first `load`.
  useLayoutEffect(() => {
    const link = createScreenLink({
      onAdjudicate: () => handlersRef.current.onAdjudicate(),
      onReload: () => handlersRef.current.onReload(),
      onView(next) {
        setView(next);
        if (next === "failed") handlersRef.current.onFailed(url);
      },
    });
    linkRef.current = link;
    let hiddenAt: number | null = null;
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      link.hidden();
    }
    link.url(url);

    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        hiddenAt ??= Date.now();
        link.hidden();
        return;
      }
      if (hiddenAt === null) return;
      const hiddenForMs = Date.now() - hiddenAt;
      hiddenAt = null;
      link.returned(hiddenForMs);
    };
    // Only the frame this component rendered may report the screen's state.
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current?.contentWindow;
      if (frame && event.source === frame) link.message(event.data);
    };
    document.addEventListener("visibilitychange", onVisibility);
    const listening = screenLinkChannel(url) === "embed";
    if (listening) window.addEventListener("message", onMessage);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (listening) window.removeEventListener("message", onMessage);
      link.dispose();
      linkRef.current = null;
    };
  }, [url]);

  if (view === "failed") return null;
  return (
    <>
      <iframe
        key={url}
        ref={frameRef}
        title={title}
        src={url}
        className="h-full w-full border-0 bg-black"
        allow={allow}
        onLoad={() => linkRef.current?.loaded()}
        style={{ pointerEvents: interactive && view === "none" ? "auto" : "none" }}
      />
      {view === "none" ? null : <ScreenLinkOverlay view={view} />}
    </>
  );
}

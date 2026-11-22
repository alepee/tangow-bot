import { Trans, useLingui } from "@lingui/react/macro";
import { LinkMentionGlyph } from "@tangow/chat-ui/web";
import type { MessageBlock } from "@tangow/contracts";
import { abortableDelay } from "@tangow/core";
import { Button, FramedBlock, LinkPreviewPicture, Surface } from "@tangow/ui-web";
import { ImageIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { SuccessPop } from "../../components/ai/primitives";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { connectMcpOauth } from "../../lib/mcp-connect";
import { rpc } from "../../lib/rpc";
import { useArtifactImageSrc } from "./use-artifact-image-src";

const CustomizeOverlay = lazy(() =>
  import("../CustomizeOverlay").then((module) => ({ default: module.CustomizeOverlay })),
);

export function ChoiceCard({
  botId,
  block,
  onBotChanged,
}: {
  botId: string;
  block: Extract<MessageBlock, { kind: "choice" }>;
  onBotChanged: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [pending, setPending] = useState(false);
  const [pendingOptionId, setPendingOptionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locallyDismissed, setLocallyDismissed] = useState(false);
  const dismissed = locallyDismissed || block.answerId === "_dismissed";

  async function choose(optionId: string) {
    setPending(true);
    setPendingOptionId(optionId);
    setError(null);
    try {
      await rpc.onboarding.choose({ botId, optionId });
      await onBotChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save this choice`);
      setPending(false);
      setPendingOptionId(null);
    }
  }

  async function dismiss() {
    setPending(true);
    setError(null);
    try {
      await rpc.onboarding.dismissFocus({ botId });
      setLocallyDismissed(true);
      void onBotChanged().catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not dismiss`);
      setPending(false);
    }
  }

  if (dismissed) return null;

  const answeredOption = block.answerId
    ? block.options.find((option) => option.id === block.answerId)
    : undefined;

  return (
    <FramedBlock
      question={block.question}
      consequence={block.subtitle}
      answered={
        block.answerId ? t`Answered: ${answeredOption?.label ?? block.answerId}` : undefined
      }
      actions={
        !block.answerId ? (
          <Button
            type="button"
            variant="tertiary"
            size="capsule"
            disabled={pending}
            onClick={() => void dismiss()}
          >
            <Trans>Dismiss</Trans>
          </Button>
        ) : undefined
      }
    >
      <div data-testid="ask-options" className="flex flex-wrap gap-2">
        {block.options.map((option) => (
          <Button
            key={option.id}
            type="button"
            variant={pendingOptionId === option.id ? "capsule" : "quickReply"}
            size="quickReply"
            aria-pressed={pendingOptionId === option.id}
            disabled={pending}
            onClick={() => void choose(option.id)}
          >
            {option.letter}. {option.label}
          </Button>
        ))}
      </div>
      {error ? <p className="mt-2 text-meta text-destructive">{error}</p> : null}
    </FramedBlock>
  );
}

export function AppConnectCard({
  botId,
  block,
}: {
  botId: string;
  block: Extract<MessageBlock, { kind: "app_connect" }>;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [localStatus, setLocalStatus] = useState<"pending" | "connected">(block.status);
  const [error, setError] = useState<string | null>(null);
  const connectionAttempt = useRef<AbortController | null>(null);
  // An MCP server a shared bot needs: the person adds it with their own credentials.
  const [adding, setAdding] = useState(false);
  const mcp = block.connectorId === "mcp";
  const status = block.status === "connected" ? "connected" : localStatus;
  useEffect(() => () => connectionAttempt.current?.abort(), []);

  async function authorize() {
    connectionAttempt.current?.abort();
    const controller = new AbortController();
    connectionAttempt.current = controller;
    setBusy(true);
    setError(null);
    try {
      const started = await rpc.connections.begin({
        connectorId: block.connectorId,
        provider: block.provider,
        displayName: block.name,
      });
      if (started.authorizationUrl) {
        window.open(started.authorizationUrl, "tangow-app-connect", "popup,width=560,height=720");
      }
      for (let i = 0; i < 60; i += 1) {
        if (controller.signal.aborted) return;
        const row = await rpc.connections
          .complete({ connectionId: started.connectionId })
          .catch(() => undefined);
        if (row?.status === "connected") {
          if (controller.signal.aborted) return;
          setLocalStatus("connected");
          await rpc.onboarding
            .appConnected({ botId, provider: block.provider, connectorId: block.connectorId })
            .catch(() => undefined);
          return;
        }
        await abortableDelay(2_000, controller.signal);
      }
      if (!controller.signal.aborted) setError(t`Authorization timed out. Please try again.`);
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(error instanceof Error ? error.message : t`Could not authorize this app`);
      }
    } finally {
      if (connectionAttempt.current === controller) {
        connectionAttempt.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <Surface
      role="group"
      aria-label={t`${block.name} connection`}
      className="w-[min(420px,80%)] px-4 py-3.5"
    >
      <div className="flex items-center gap-3.5">
        {block.logo ? (
          <img
            src={block.logo}
            alt=""
            className="h-10 w-10 rounded-row bg-well object-contain p-1"
          />
        ) : (
          <span className="grid h-10 w-10 place-items-center rounded-row bg-well text-meta text-foreground">
            {block.name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-author font-medium text-foreground">{block.name}</span>
          <span className="block truncate text-meta text-muted-foreground">
            {block.description}
          </span>
        </span>
        {status === "connected" ? (
          <SuccessPop label={t`Connected`} />
        ) : (
          <Button
            variant="secondary"
            className="rounded-full hover:border-border hover:bg-accent hover:text-foreground"
            disabled={busy}
            onClick={() => (mcp ? setAdding(true) : void authorize())}
          >
            {busy ? t`Waiting…` : mcp ? t`Add` : t`Authorize`}
          </Button>
        )}
      </div>
      {error ? <p className="mt-2 text-time text-destructive">{error}</p> : null}
      {adding ? (
        <Suspense fallback={null}>
          <CustomizeOverlay
            initialSection="custom-apps"
            declared={{
              botId,
              serverId: block.provider,
              onAdded: () => setLocalStatus("connected"),
            }}
            onClose={() => setAdding(false)}
          />
        </Suspense>
      ) : null}
    </Surface>
  );
}

type McpApprovalState = "pending" | "connecting" | "connected" | "dismissed";

/** Approval card for an agent-created MCP server: the user completes browser
 * OAuth (or confirms no authorization is needed) without leaving the chat. */
export function McpApprovalCard({
  botId,
  name,
  serverId,
  transport,
  endpoint,
  needsOAuth,
}: {
  botId: string | undefined;
  name: string;
  serverId: string;
  transport: string;
  endpoint: string | null;
  needsOAuth: boolean;
}) {
  const { t } = useLingui();
  const [state, setState] = useState<McpApprovalState>("pending");
  const [error, setError] = useState<string | null>(null);

  async function authorize() {
    if (!botId) {
      setError(t`This server cannot be assigned without a bot.`);
      return;
    }
    setState("connecting");
    setError(null);
    try {
      if (needsOAuth) {
        const result = await connectMcpOauth(serverId);
        if (result === "cancelled") {
          setState("pending");
          return;
        }
      }
      await rpc.mcp.assignments.approve({ botId, serverId });
      setState("connected");
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not approve this server`);
      setState("pending");
    }
  }

  const summary = endpoint ?? `stdio · ${transport}`;
  return (
    <Surface className="max-w-[74%] p-4">
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-row bg-well text-time text-foreground">
          M
        </span>
        <span className="text-author font-medium text-foreground">
          <Trans>Connect MCP server “{name}”</Trans>
        </span>
      </div>
      <p className="mt-1.5 truncate text-time text-muted-foreground">{summary}</p>
      {state === "pending" || state === "connecting" ? (
        <>
          <p className="mt-2 text-meta text-foreground">
            {needsOAuth
              ? t`Authorize this server so agents can use its tools. A popup opens.`
              : t`Approve this server to let your agent use its tools.`}
          </p>
          {error ? <p className="mt-2 text-time text-destructive">{error}</p> : null}
          <div className="mt-3 flex gap-2">
            <Button
              className="rounded-full"
              disabled={state === "connecting"}
              onClick={() => void authorize()}
            >
              {state === "connecting" ? t`Connecting…` : needsOAuth ? t`Authorize` : t`Approve`}
            </Button>
            <Button
              variant="secondary"
              className="rounded-full"
              onClick={() => setState("dismissed")}
            >
              <Trans>Not now</Trans>
            </Button>
          </div>
        </>
      ) : null}
      {state === "connected" ? (
        <div className="mt-3">
          <SuccessPop label={t`Connected. Its tools are available from your next message.`} />
        </div>
      ) : null}
      {state === "dismissed" ? (
        <p className="mt-2 text-meta text-muted-foreground">
          <Trans>Dismissed. Reconnect anytime from MCP settings.</Trans>
        </p>
      ) : null}
    </Surface>
  );
}

/**
 * The picture of a link preview card, read from the thread's artifacts like an attached image:
 * never a remote URL. Fills the card's frame; a tile with the image glyph stands in when the
 * artifact cannot be read.
 */
export function LinkPreviewImage({
  target,
  artifactId,
  fit,
}: {
  target: ArtifactTarget;
  artifactId: string;
  /** `contain` for a site icon: drawn whole inside the frame. */
  fit?: "contain";
}) {
  const { container, src, failed } = useArtifactImageSrc(target, artifactId);
  return (
    <div
      ref={container}
      className={`absolute inset-0 overflow-hidden ${failed ? "grid place-items-center" : ""}`}
    >
      {src ? (
        <LinkPreviewPicture src={src} fit={fit} />
      ) : failed ? (
        <ImageIcon className="size-5 text-muted-foreground" strokeWidth={1.7} aria-hidden />
      ) : null}
    </div>
  );
}

/**
 * The site icon of a link mention, read from the thread's artifacts like a card's picture, never
 * a remote URL. The link glyph stands in when the artifact cannot be read or is not an image.
 */
export function LinkMentionIcon({
  target,
  artifactId,
}: {
  target: ArtifactTarget;
  artifactId: string;
}) {
  const { container, src, failed, onImageError } = useArtifactImageSrc<HTMLSpanElement>(
    target,
    artifactId,
  );
  if (failed) return <LinkMentionGlyph />;
  return (
    <span ref={container}>{src ? <img src={src} alt="" onError={onImageError} /> : null}</span>
  );
}

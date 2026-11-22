import { useLingui } from "@lingui/react/macro";
import { isApprovalAskBlock, isSecretAskBlock, narrateTool, speechFromBlocks } from "@tangow/core";
import { BotAvatar, Button, useElapsed } from "@tangow/ui-web";
import { Mic, MicOff, PhoneOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { approvalActionLabel } from "../lib/approval-labels";
import { desktopBridge } from "../lib/desktop";
import { dictation } from "../lib/dictation";
import type { CardAnswerTarget, MessageItem } from "../lib/thread-items";
import { speaker } from "../lib/tts";
import {
  type AskBlock,
  callAskActions,
  canAnswerAskByVoice,
  isScreenOnlyApproval,
  spokenAskAnswer,
} from "../lib/voice-ask";

type Phase = "listening" | "thinking" | "speaking";
type AskAction = NonNullable<AskBlock["actions"]>[number];
type PendingAsk = { block: AskBlock; target: CardAnswerTarget };

export type CallThread = {
  messages: readonly MessageItem[];
  running: boolean;
  ask: PendingAsk | null;
};

const BAR_DELAYS_MS = [0, 90, 180, 270, 360];

export function CallView({
  botId,
  botName,
  botColor,
  botAvatarCharacter,
  transcribe,
  thread,
  onSend,
  onFollowUp,
  onAnswer,
  onClose,
}: {
  botId: string;
  botName: string;
  botColor: string;
  botAvatarCharacter?: string | null;
  transcribe: boolean;
  thread: CallThread | null;
  onSend: (text: string) => Promise<void>;
  onFollowUp: (text: string) => Promise<void>;
  onAnswer: (target: CardAnswerTarget, text: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [phase, setPhase] = useState<Phase>("listening");
  const [caption, setCaption] = useState("");
  const [heard, setHeard] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const phaseRef = useRef<Phase>("listening");
  const mutedRef = useRef(false);
  const spokenMessage = useRef<string | null>(null);
  const narrated = useRef(new Set<string>());
  const closing = useRef(false);
  const threadRef = useRef(thread);
  threadRef.current = thread;
  const rootRef = useRef<HTMLDivElement>(null);
  const askPromptRef = useRef(t`Say yes or no, or answer in a sentence.`);
  askPromptRef.current = t`Say yes or no, or answer in a sentence.`;
  const secretPromptRef = useRef(t`Hang up first, then enter the code on screen.`);
  secretPromptRef.current = t`Hang up first, then enter the code on screen.`;
  const screenApprovalPromptRef = useRef(t`Approve it in the chat, or say no to cancel.`);
  screenApprovalPromptRef.current = t`Approve it in the chat, or say no to cancel.`;
  const duration = useElapsed();

  function setCallPhase(next: Phase) {
    phaseRef.current = next;
    setPhase(next);
  }

  function hangUp() {
    closing.current = true;
    dictation.stop("cancel");
    speaker.stop();
    onClose();
  }

  function toggleMute() {
    setMuted((current) => {
      const next = !current;
      mutedRef.current = next;
      if (next) {
        dictation.stop("cancel");
      } else {
        void listen();
      }
      return next;
    });
  }

  function interrupt() {
    if (phaseRef.current === "speaking") speaker.stop();
    else dictation.stop("cancel");
    void listen();
  }

  async function listen() {
    if (closing.current) return;
    if (mutedRef.current) {
      // Muting only stops the mic from transmitting; it must not leave the
      // phase stuck on "thinking"/"speaking" once the bot is done, or the
      // bars and "{bot} is speaking" caption would linger forever.
      dictation.stop("cancel");
      speaker.stop();
      setCallPhase("listening");
      setHeard("");
      return;
    }
    if (pendingSecretAsk(threadRef.current)) {
      dictation.stop("cancel");
      setCallPhase("listening");
      setHeard("");
      return;
    }
    setCallPhase("listening");
    speaker.stop();
    setHeard("");
    try {
      await dictation.listen({
        mode: "endpoint",
        transcribe,
        // Electron's Chromium reports Web Speech as available but it usually
        // has no speech-service key there, so on desktop the configured
        // provider is tried first (same fix as the composer's dictation).
        preferTranscribe: Boolean(desktopBridge()) && transcribe,
        onFinal: (text) => void handleTranscript(text),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Microphone failed`);
    }
  }

  async function handleTranscript(text: string) {
    if (closing.current || !text.trim()) {
      void listen();
      return;
    }
    dictation.stop("submit");
    const current = threadRef.current;
    if (pendingSecretAsk(current)) {
      setHeard("");
      setCaption("");
      setError(t`Hang up, then enter the code on screen.`);
      return;
    }
    const pendingAsk = current?.ask;
    if (pendingAsk && !canAnswerAskByVoice(pendingAsk.block)) {
      // A multi-question ask needs a structured answer the server can parse;
      // routing a spoken sentence into it always fails, so it is left for
      // the "Answer in text" quick reply instead.
      setHeard("");
      void listen();
      return;
    }
    setHeard(text);
    setCallPhase("thinking");
    try {
      if (pendingAsk) {
        const answer = spokenAskAnswer(pendingAsk.block, text);
        if (answer === null) {
          // A screen-only approval is settled in the thread; only a refusal is taken here.
          setHeard("");
          void speaker.speak(screenApprovalPromptRef.current, { botId });
          return;
        }
        await onAnswer(pendingAsk.target, answer);
      } else if (current?.running) {
        await onFollowUp(text);
      } else {
        await onSend(text);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not send that`);
      void listen();
    }
  }

  async function chooseAskAction(target: CardAnswerTarget, action: AskAction) {
    const block = threadRef.current?.ask?.block;
    if (block && !callAskActions(block).some((offered) => offered.id === action.id)) return;
    dictation.stop("cancel");
    setHeard(action.label);
    setCallPhase("thinking");
    try {
      await onAnswer(target, action.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not send that`);
      void listen();
    }
  }

  useEffect(() => {
    closing.current = false;
    spokenMessage.current = null;
    narrated.current.clear();
    const unsubSpeech = speaker.subscribe((state) => {
      if (state.status === "speaking") {
        setCallPhase("speaking");
        setCaption(state.caption ?? "");
      } else if (state.status === "idle" && phaseRef.current !== "listening") {
        setCaption("");
        void listen();
      }
      if (state.error) setError(state.error);
    });
    const unsubDictation = dictation.subscribe((state) => {
      if (state.status === "listening") {
        setHeard(pendingSecretAsk(threadRef.current) ? "" : state.transcript);
      }
      if (state.error) setError(state.error);
    });
    void listen();
    return () => {
      closing.current = true;
      unsubSpeech();
      unsubDictation();
      dictation.stop("cancel");
      speaker.stop();
    };
  }, [botId]);

  // Focus the call view when it opens; Shell.tsx returns focus to the
  // composer's Voice button once it closes.
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        hangUp();
      }
      if (event.key === " " && !mutedRef.current && phaseRef.current !== "listening") {
        event.preventDefault();
        interrupt();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (closing.current || phaseRef.current === "listening") return;
    const messages = thread?.messages ?? [];
    const lastBot = [...messages].reverse().find((message) => message.role === "bot");
    if (lastBot && lastBot.id !== spokenMessage.current) {
      const text = speechFromBlocks(lastBot.blocks);
      const ask = lastBot.blocks.find(
        (block): block is AskBlock => block.kind === "ask" && block.status !== "answered",
      );
      const secretAsk = ask && isSecretAskBlock(ask);
      if (text) {
        spokenMessage.current = lastBot.id;
        dictation.stop("cancel");
        void speaker.speak(
          secretAsk
            ? `${text}. ${secretPromptRef.current}`
            : ask && isScreenOnlyApproval(ask)
              ? `${text}. ${screenApprovalPromptRef.current}`
              : ask
                ? `${text}. ${askPromptRef.current}`
                : text,
          {
            botId,
            messageId: lastBot.id,
          },
        );
        return;
      }
      if (!thread?.running) {
        spokenMessage.current = lastBot.id;
        void listen();
        return;
      }
    }
    if (thread?.running) {
      const phrases: string[] = [];
      let lastKey = "";
      for (const message of messages) {
        for (const block of message.blocks) {
          if (block.kind !== "progress") continue;
          const key = `${message.id}:${block.kind}:${block.text}`;
          if (narrated.current.has(key)) continue;
          const phrase =
            narrateTool(block.text.split(/\s+/)[0] ?? "") ?? speakableProgress(block.text);
          if (!phrase) continue;
          narrated.current.add(key);
          phrases.push(phrase);
          lastKey = key;
        }
      }
      if (phrases.length) {
        void speaker.speak(phrases.join(". "), { botId, messageId: `narrate:${lastKey}` });
      }
    }
  }, [thread, botId]);

  useEffect(() => {
    const pendingAsk = thread?.ask;
    if (!pendingAsk) return;
    if (isSecretAskBlock(pendingAsk.block) || !canAnswerAskByVoice(pendingAsk.block)) {
      dictation.stop("cancel");
      setHeard("");
    }
  }, [thread]);

  const pendingAsk = thread?.ask;
  const askTarget = pendingAsk?.target;
  const askBlock = pendingAsk?.block;
  const isApproval = Boolean(askBlock && isApprovalAskBlock(askBlock));
  const voiceAnswerable = !askBlock || canAnswerAskByVoice(askBlock);
  const askActions = askBlock && voiceAnswerable ? callAskActions(askBlock) : [];

  return (
    <div
      ref={rootRef}
      data-testid="call-view"
      tabIndex={-1}
      className="flex h-full min-h-0 flex-col outline-none"
    >
      <div className="flex h-header shrink-0 items-center justify-between px-[22px]">
        <span className="truncate text-title text-foreground">{botName}</span>
        <span aria-hidden="true" className="font-mono text-mono text-muted-foreground tabular-nums">
          {duration}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-7 overflow-y-auto px-3.5 py-7">
        <div className="relative flex size-50 shrink-0 items-center justify-center">
          <span
            aria-hidden="true"
            className="rk-halo absolute inset-0 rounded-full opacity-50 blur-3xl"
            style={{ backgroundColor: botColor }}
          />
          <BotAvatar
            className="relative"
            character={botAvatarCharacter}
            size={120}
            status={phase !== "listening" ? "running" : undefined}
          />
        </div>

        {phase === "speaking" ? (
          <div role="status" className="flex flex-col items-center gap-2.5">
            <div aria-hidden="true" className="flex items-end gap-1">
              {BAR_DELAYS_MS.map((delay) => (
                <span
                  key={delay}
                  className="rk-bar h-4 w-0.75 rounded-full bg-foreground"
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </div>
            <p className="text-working text-foreground">{t`${botName} is speaking`}</p>
          </div>
        ) : null}

        <div className="flex w-full max-w-thread flex-col gap-2.5">
          {heard ? <p className="text-end text-body text-foreground-subtle">{heard}</p> : null}
          {caption ? <p className="font-normal text-title text-foreground">{caption}</p> : null}
        </div>

        {error ? <p className="text-center text-meta text-destructive">{error}</p> : null}

        {askTarget && askBlock ? (
          <div className="flex flex-wrap justify-center gap-2">
            {voiceAnswerable ? (
              askActions.map((action) => (
                <Button
                  key={action.id}
                  type="button"
                  variant="quickReply"
                  size="quickReply"
                  consequential={isApproval && action.id !== "deny"}
                  onClick={() => void chooseAskAction(askTarget, action)}
                >
                  {isApproval ? approvalActionLabel(action) : action.label}
                </Button>
              ))
            ) : (
              // The mic cannot answer a multi-question ask (the server always
              // rejects a spoken sentence for it), so this is the only way
              // left to tell the person why and let them finish it in text.
              <Button type="button" variant="quickReply" size="quickReply" onClick={hangUp}>
                {t`Answer in text`}
              </Button>
            )}
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center justify-center gap-4 pb-7">
        <Button
          type="button"
          variant="capsuleSecondary"
          size="call"
          aria-label={t`Mute`}
          aria-pressed={muted}
          onClick={toggleMute}
        >
          {muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
        </Button>
        <Button
          type="button"
          variant="capsule"
          size="call"
          aria-label={t`End call`}
          onClick={hangUp}
          className="bg-destructive text-destructive-foreground"
        >
          <PhoneOff aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

function pendingSecretAsk(thread: CallThread | null): boolean {
  const pending = thread?.ask;
  return Boolean(pending && isSecretAskBlock(pending.block));
}

function speakableProgress(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 80) return null;
  return trimmed;
}

// @vitest-environment jsdom

import type { ComponentProps, ReactNode, Ref } from "react";
import { act, forwardRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vitest doesn't run the lingui macro/babel transform, so these macro imports must be
// mocked to a plain passthrough (same pattern as KnowledgeSection.test.tsx / AskCard.test.tsx).
function identityTag(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, "");
}
vi.mock("@lingui/core/macro", () => ({ t: identityTag }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: identityTag }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));

// Pulls in AskCard/ChatMarkdown/AgentSteps and the rest of the message tree —
// none of it relevant to dictation, and `previewMessageText` is only reached
// when `replyTarget` is set, which these tests never do.
vi.mock("./message-view", () => ({ previewMessageText: () => "" }));

type FakeSnapshot = {
  status: "idle" | "listening" | "transcribing";
  transcript: string;
  interim?: string;
  error?: string;
};

const dictationMock = vi.hoisted(() => {
  let snapshot: FakeSnapshot = { status: "idle", transcript: "" };
  let watchers: Array<(s: FakeSnapshot) => void> = [];
  const listen = vi.fn(async () => undefined);
  const stop = vi.fn((_reason?: string) => {
    snapshot = { status: "idle", transcript: "" };
    for (const watcher of [...watchers]) watcher(snapshot);
  });
  const finishDictate = vi.fn(async () => "");
  return {
    get state() {
      return snapshot;
    },
    subscribe(fn: (s: FakeSnapshot) => void) {
      watchers.push(fn);
      fn(snapshot);
      return () => {
        watchers = watchers.filter((watcher) => watcher !== fn);
      };
    },
    listen,
    stop,
    finishDictate,
    /** Test-only: simulate a snapshot the real engine would have emitted. */
    emit(next: FakeSnapshot) {
      snapshot = next;
      for (const watcher of [...watchers]) watcher(snapshot);
    },
    reset() {
      snapshot = { status: "idle", transcript: "" };
      watchers = [];
      listen.mockClear();
      stop.mockClear();
      finishDictate.mockClear();
    },
  };
});

vi.mock("../../lib/dictation.js", () => ({
  dictation: dictationMock,
  webSpeechAvailable: () => true,
}));

vi.mock("../../lib/desktop.js", () => ({
  desktopBridge: () => undefined,
}));

vi.mock("@tangow/ui-web", () => {
  const Button = ({
    variant: _variant,
    size: _size,
    className: _className,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  );
  const ComposerAttachment = ({
    name,
    removeLabel,
    onRemove,
    disabled,
  }: {
    name: string;
    removeLabel: string;
    onRemove?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" aria-label={removeLabel} onClick={onRemove} disabled={disabled}>
      {name}
    </button>
  );
  const StopContour = () => <span aria-hidden="true" />;
  const BotAvatar = () => <span aria-hidden="true" />;
  const ComposerShell = forwardRef(function ComposerShell(
    {
      attach,
      leading,
      children,
      trailing,
      attachments,
      state,
      dictationCancel,
      dictationConfirm,
      ...rest
    }: {
      attach?: ReactNode;
      leading?: ReactNode;
      children?: ReactNode;
      trailing?: ReactNode;
      attachments?: ReactNode;
      state?: string;
      dictationCancel?: ReactNode;
      dictationConfirm?: ReactNode;
    } & ComponentProps<"div">,
    ref: Ref<HTMLDivElement>,
  ) {
    return (
      <div ref={ref} data-state={state} {...rest}>
        {attachments}
        {attach}
        {leading}
        {children}
        {trailing}
        {dictationCancel}
        {dictationConfirm}
      </div>
    );
  });
  const cn = (...classes: unknown[]) => classes.filter(Boolean).join(" ");
  return { Button, ComposerAttachment, ComposerShell, StopContour, BotAvatar, cn };
});

import { Composer } from "./composer.js";

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    activeName: "Maya",
    running: false,
    disabled: false,
    pendingAttachments: [],
    attachmentNotice: null,
    sendError: null,
    runError: null,
    runErrorId: null,
    onRunErrorPresented: () => {},
    onDismissError: () => {},
    sending: false,
    fileInputRef: { current: null },
    onAttachmentPick: () => {},
    onRemoveAttachment: () => {},
    onSend: async () => {},
    onStop: async () => {},
    dictationTranscribe: true,
    mentionTargets: [],
    agentSkills: [],
    onSlashOpen: () => {},
    onSlashAction: () => {},
    ...overrides,
  };
}

function mount(overrides: Record<string, unknown> = {}): { container: HTMLElement; root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const props = baseProps(overrides) as unknown as ComponentProps<typeof Composer>;
  act(() => {
    root.render(<Composer {...props} />);
  });
  return { container, root };
}

function unmount(root: Root, container: HTMLElement) {
  act(() => {
    root.unmount();
  });
  container.remove();
}

function queryButton(container: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll("button")].find(
      (candidate) => candidate.getAttribute("aria-label") === label,
    ) ?? null
  );
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = queryButton(container, label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function typeInto(textarea: HTMLTextAreaElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setValue?.call(textarea, text);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function draftTextarea(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector('textarea[name="chat-message"]');
  if (!el) throw new Error("composer textarea not found");
  return el as HTMLTextAreaElement;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  dictationMock.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});

describe("Composer dictation forced-cancel paths", () => {
  it("a Web Speech restart alone does not count as activity for the 60s silence cap", async () => {
    vi.useFakeTimers();
    const { container, root } = mount();

    act(() => {
      button(container, "Dictate").click();
    });
    expect(dictationMock.listen).toHaveBeenCalledOnce();

    act(() => {
      dictationMock.emit({ status: "listening", transcript: "hello", interim: "" });
    });
    expect(queryButton(container, "Insert dictation")).toBeTruthy();

    // 50s pass with genuine speech recorded once — well under the 60s cap.
    act(() => {
      vi.advanceTimersByTime(50_000);
    });
    expect(dictationMock.stop).not.toHaveBeenCalled();

    // A natural engine restart re-announces the *same* committed text with an
    // empty interim tail — that reset alone must not look like new speech.
    act(() => {
      dictationMock.emit({ status: "listening", transcript: "hello", interim: "" });
    });
    act(() => {
      vi.advanceTimersByTime(15_000); // 65s since the last genuine speech
    });

    expect(dictationMock.finishDictate).toHaveBeenCalledOnce();
    await act(async () => {});
    expect(dictationMock.stop).not.toHaveBeenCalledWith("cancel");
    expect(queryButton(container, "Dictate")).toBeTruthy();

    unmount(root, container);
  });

  it("a silent 60s with no speech at all ends dictation like ✓", async () => {
    vi.useFakeTimers();
    const { container, root } = mount();

    act(() => {
      button(container, "Dictate").click();
    });
    act(() => {
      vi.advanceTimersByTime(64_000);
    });

    expect(dictationMock.finishDictate).toHaveBeenCalledOnce();
    await act(async () => {});
    expect(queryButton(container, "Dictate")).toBeTruthy();

    unmount(root, container);
  });

  it("a 5-minute session cap ends dictation like ✓ even with continuous genuine activity", async () => {
    vi.useFakeTimers();
    const { container, root } = mount();

    act(() => {
      button(container, "Dictate").click();
    });
    for (let i = 0; i < 31; i += 1) {
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      act(() => {
        dictationMock.emit({ status: "listening", transcript: `hello ${i}`, interim: "" });
      });
      if (dictationMock.finishDictate.mock.calls.length > 0) break;
    }

    expect(dictationMock.finishDictate).toHaveBeenCalledOnce();
    await act(async () => {});
    expect(queryButton(container, "Dictate")).toBeTruthy();

    unmount(root, container);
  });

  it("hiding the tab ends dictation like ✓ and keeps the dictated text", async () => {
    dictationMock.finishDictate.mockResolvedValueOnce("dictated words");
    const { container, root } = mount();
    act(() => {
      typeInto(draftTextarea(container), "keep me");
    });
    act(() => {
      button(container, "Dictate").click();
    });

    act(() => {
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {});

    expect(dictationMock.stop).not.toHaveBeenCalledWith("cancel");
    expect(queryButton(container, "Dictate")).toBeTruthy();
    expect(draftTextarea(container).value).toBe("keep me dictated words");

    unmount(root, container);
  });

  it("✓ with a partial transcription keeps the text and shows the error", async () => {
    dictationMock.finishDictate.mockImplementationOnce(async () => {
      dictationMock.emit({
        status: "idle",
        transcript: "",
        error: "Transcription request timed out.",
      });
      return "partial";
    });
    const { container, root } = mount();
    act(() => {
      button(container, "Dictate").click();
    });
    await act(async () => {
      button(container, "Insert dictation").click();
    });

    expect(draftTextarea(container).value).toBe("partial");
    expect(container.querySelector('[data-testid="composer-error"]')?.textContent).toContain(
      "Transcription request timed out.",
    );

    unmount(root, container);
  });

  it("an engine error keeps the dictated text and shows the error", () => {
    const { container, root } = mount();
    act(() => {
      typeInto(draftTextarea(container), "keep me");
    });
    act(() => {
      button(container, "Dictate").click();
    });
    act(() => {
      dictationMock.emit({ status: "listening", transcript: "two minutes", interim: "of words" });
    });

    act(() => {
      dictationMock.emit({ status: "idle", transcript: "", error: "Dictation failed: network" });
    });

    expect(queryButton(container, "Dictate")).toBeTruthy();
    expect(draftTextarea(container).value).toBe("keep me two minutes of words");
    expect(container.querySelector('[data-testid="composer-error"]')?.textContent).toContain(
      "Dictation failed: network",
    );

    act(() => {
      button(container, "Dismiss error").click();
    });
    expect(container.querySelector('[data-testid="composer-error"]')).toBeNull();

    unmount(root, container);
  });

  it("× restores the pre-dictation draft", () => {
    const { container, root } = mount();
    act(() => {
      typeInto(draftTextarea(container), "keep me");
    });
    act(() => {
      button(container, "Dictate").click();
    });
    act(() => {
      dictationMock.emit({ status: "listening", transcript: "discard this", interim: "" });
    });

    act(() => {
      button(container, "Cancel dictation").click();
    });

    expect(dictationMock.stop).toHaveBeenCalledWith("cancel");
    expect(draftTextarea(container).value).toBe("keep me");

    unmount(root, container);
  });

  it("unmounting while dictating cancels it (a thread change remounts the composer the same way)", () => {
    const { container, root } = mount();
    act(() => {
      button(container, "Dictate").click();
    });
    expect(dictationMock.stop).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });

    expect(dictationMock.stop).toHaveBeenCalledWith("cancel");
    container.remove();
  });

  it("starting the call cuts dictation off and the composer keeps its draft", () => {
    const { container, root } = mount();
    act(() => {
      typeInto(draftTextarea(container), "keep me");
    });
    act(() => {
      button(container, "Dictate").click();
    });

    // The thread header's call button cancels the shared `dictation` instance
    // before opening the call; simulate that external stop reaching it.
    act(() => {
      dictationMock.stop("cancel");
    });

    expect(queryButton(container, "Dictate")).toBeTruthy();
    expect(draftTextarea(container).value).toBe("keep me");

    unmount(root, container);
  });

  it("scrolls the dictation preview to the newest words once the text outgrows its height cap", () => {
    const { container, root } = mount();
    act(() => {
      button(container, "Dictate").click();
    });
    const preview = container.querySelector('[role="textbox"]') as HTMLElement;
    // jsdom never computes layout, so `scrollHeight` stays 0 unless a test
    // pins it — this stands in for the preview's content outgrowing its
    // height cap.
    Object.defineProperty(preview, "scrollHeight", { value: 400, configurable: true });
    preview.scrollTop = 0;

    act(() => {
      dictationMock.emit({ status: "listening", transcript: "hello world", interim: "" });
    });

    expect(preview.scrollTop).toBe(400);

    unmount(root, container);
  });
});

describe("Composer while a bot runs", () => {
  it("replaces Stop with Send while drafting and sends without stopping the run", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const onSend = vi.fn(async () => {});
    const onStop = vi.fn(async () => {});
    const { container, root } = mount({ running: true, onSend, onStop });
    const field = draftTextarea(container);
    expect(queryButton(container, "Stop")).toBeTruthy();
    expect(queryButton(container, "Send")).toBeNull();

    act(() => typeInto(field, "Try another approach"));
    expect(queryButton(container, "Stop")).toBeNull();
    expect(queryButton(container, "Send")).toBeTruthy();

    act(() => typeInto(field, ""));
    expect(queryButton(container, "Stop")).toBeTruthy();
    expect(queryButton(container, "Send")).toBeNull();

    act(() => typeInto(field, "Try another approach"));
    await act(async () => button(container, "Send").click());
    expect(onSend).toHaveBeenCalledWith("Try another approach", [], undefined);
    expect(onStop).not.toHaveBeenCalled();
    expect(field.value).toBe("");
    expect(queryButton(container, "Stop")).toBeTruthy();
    unmount(root, container);
  });
});

describe("Composer while a question waits", () => {
  it("names the bot to answer in its placeholder and accessible name, and keeps Stop", () => {
    const { container, root } = mount({ answerName: "Maya", running: true });
    const field = draftTextarea(container);
    expect([field.placeholder, field.getAttribute("aria-label")]).toEqual([
      "Answer Maya…",
      "Answer Maya…",
    ]);
    expect(queryButton(container, "Stop")?.getAttribute("aria-label")).toBe("Stop");
    unmount(root, container);
  });

  it("says Message again once nothing waits", () => {
    const { container, root } = mount();
    const field = draftTextarea(container);
    expect([field.placeholder, field.getAttribute("aria-label")]).toEqual([
      "Message Maya",
      "Message Maya",
    ]);
    unmount(root, container);
  });
});

describe("Composer slash actions", () => {
  it("offers bot settings only where the chat's settings are yours", () => {
    for (const [chatSettings, offered] of [
      [undefined, true],
      [false, false],
    ] as const) {
      const { container, root } = mount({ chatSettings });
      act(() => typeInto(draftTextarea(container), "/"));
      expect(container.textContent?.includes("Bot settings")).toBe(offered);
      expect(container.textContent).toContain("Settings: General");
      unmount(root, container);
    }
  });
});

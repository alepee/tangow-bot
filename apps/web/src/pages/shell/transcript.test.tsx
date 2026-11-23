// @vitest-environment jsdom

import type { SessionEntry } from "@tangow/contracts";
import { SessionEntrySchema } from "@tangow/contracts";
import { drawsNothing, projectThreadView } from "@tangow/core";
import type { ComponentProps, ReactNode } from "react";
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vitest doesn't run the lingui macro transform: same passthrough as the other web tests.
function identityTag(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, "");
}
vi.mock("@lingui/core/macro", () => ({ t: identityTag }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: identityTag }),
  Trans: ({ children }: { children?: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));

const api = vi.hoisted(() => ({ sessionEntries: vi.fn(), artifactGet: vi.fn() }));
vi.mock("../../lib/rpc", () => ({
  rpc: { sessions: { entries: api.sessionEntries }, artifacts: { get: api.artifactGet } },
}));

import streamedReply from "../../../../../packages/core/src/session-log/fixtures/streamed-reply.jsonl?raw";
import { setDebugMode } from "../../lib/debug-mode";
import { hasRenderableBlock } from "../../lib/message-blocks";
import { Transcript } from "./transcript";

const fixture = streamedReply
  .trim()
  .split("\n")
  .map((line) => SessionEntrySchema.parse(JSON.parse(line)));

const helperSession = [
  {
    id: "scout-00",
    sessionId: "ses_scout",
    seq: 0,
    parentId: null,
    ts: "2026-10-10T09:00:04.000Z",
    type: "user.message",
    payload: { blocks: [{ kind: "text", text: "List competitors" }], source: "app" },
  },
  {
    id: "scout-01",
    sessionId: "ses_scout",
    seq: 1,
    parentId: "scout-00",
    ts: "2026-10-10T09:00:04.500Z",
    botId: "bot_ada",
    runId: "run_scout",
    type: "assistant.text",
    payload: { blocks: [{ kind: "text", text: "Globex and Initech" }] },
  },
].map((entry) => SessionEntrySchema.parse(entry));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  api.sessionEntries.mockReset().mockResolvedValue({ entries: helperSession });
  api.artifactGet.mockReset().mockReturnValue(new Promise(() => undefined));
  Element.prototype.scrollTo = () => undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  setDebugMode(false);
});

async function renderThread(
  entries: number | readonly SessionEntry[],
  props: Partial<ComponentProps<typeof Transcript>> = {},
) {
  const shown = typeof entries === "number" ? fixture.slice(0, entries + 1) : entries;
  await act(async () => {
    root.render(
      <Transcript
        scrollRef={createRef<HTMLDivElement>()}
        followingRef={{ current: true }}
        artifactTarget={{ botId: "bot_ada" }}
        inGroup={false}
        view={projectThreadView(shown, {
          rendersNothing: (item) =>
            drawsNothing(item, (blocks) => hasRenderableBlock(blocks, false)),
        })}
        olderCursor={null}
        loadingOlder={false}
        running={false}
        workingBots={[]}
        onLoadOlder={() => undefined}
        onOpenBot={() => undefined}
        onAnswer={async () => undefined}
        onReply={() => undefined}
        onEdit={() => undefined}
        rewindFromItemId={null}
        onReact={async () => undefined}
        onJumpToMessage={() => undefined}
        onOpenPeerMessages={() => undefined}
        peerBot={() => undefined}
        onRefresh={async () => undefined}
        onBotChanged={async () => undefined}
        onAddRoutine={() => undefined}
        voiceReady={false}
        speakingMessageId={null}
        onSpeak={() => undefined}
        {...props}
      />,
    );
  });
}

const text = (selector: string) =>
  [...document.querySelectorAll(selector)].map((element) => element.textContent);

describe("the transcript", () => {
  it("draws a reply as its bubble with nothing for the run or its helper, and a rewind divider", async () => {
    await renderThread(17);

    expect(
      [...document.querySelectorAll("[data-message-id]")].map((row) =>
        row.getAttribute("data-message-id"),
      ),
    ).toEqual(["str-00", "str-02", "str-08", "str-09", "str-17"]);
    expect(text('[data-testid="thread-divider"]')).toEqual(["Message edited"]);
    expect(text('[data-testid="message-user-bubble"]')).toEqual([
      "Find three competitors and summarize Acme's site",
      "Yes",
    ]);
  });

  it("shows the card a run waits on with no status line above it (CA27)", async () => {
    await renderThread(7);
    expect(text('[data-slot="question-card"] [data-slot="framed-block-question"]')).toEqual([
      "Compare prices too?",
    ]);
    expect(document.body.textContent).not.toContain("Needs input");
  });

  it("keeps the end in view when the thread shortens while following, not after a jump", async () => {
    const observers: Array<() => void> = [];
    const resized = () => {
      for (const callback of observers) callback();
    };
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    const following = { current: true };
    const snaps = vi.fn();
    Element.prototype.scrollTo = snaps;
    await renderThread(9, { followingRef: following });
    snaps.mockClear();
    act(() => resized());
    expect(snaps).toHaveBeenCalledTimes(1);

    const preview = document.querySelector<HTMLElement>('[data-testid="reply-parent-preview"]');
    await act(async () => preview?.click());
    snaps.mockClear();
    act(() => resized());
    expect(snaps).not.toHaveBeenCalled();
  });

  it("holds a jump to a reply's parent against the next row, then follows a scroll back down", async () => {
    const following = { current: true };
    const scrollRef = createRef<HTMLDivElement>();
    const snaps = vi.fn();
    Element.prototype.scrollTo = snaps;
    await renderThread(9, { scrollRef, followingRef: following });
    const preview = document.querySelector<HTMLElement>('[data-testid="reply-parent-preview"]');
    await act(async () => preview?.click());
    expect(following.current).toBe(false);

    // The smooth scroll has not moved yet when a row lands: the browser reports a step down near the end.
    const element = scrollRef.current!;
    Object.defineProperty(element, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(element, "clientHeight", { configurable: true, value: 400 });
    for (const top of [590, 595]) {
      Object.defineProperty(element, "scrollTop", { configurable: true, value: top });
      await act(async () => element.dispatchEvent(new Event("scroll")));
    }
    snaps.mockClear();
    await renderThread(11, { scrollRef, followingRef: following });

    expect(following.current).toBe(false);
    expect(snaps).not.toHaveBeenCalled();

    // Once the hold has passed, scrolling down to the end follows again.
    const settled = performance.now() + 1501;
    vi.spyOn(performance, "now").mockReturnValue(settled);
    for (const top of [596, 600]) {
      Object.defineProperty(element, "scrollTop", { configurable: true, value: top });
      await act(async () => element.dispatchEvent(new Event("scroll")));
    }
    expect(following.current).toBe(true);
  });

  it("follows the end again when a jump lands on a row already on the last screen", async () => {
    vi.useFakeTimers();
    const following = { current: true };
    const scrollRef = createRef<HTMLDivElement>();
    const snaps = vi.fn();
    Element.prototype.scrollTo = snaps;
    await renderThread(9, { scrollRef, followingRef: following });
    const element = scrollRef.current!;
    Object.defineProperty(element, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(element, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(element, "scrollTop", { configurable: true, value: 600 });

    const preview = document.querySelector<HTMLElement>('[data-testid="reply-parent-preview"]');
    await act(async () => preview?.click());
    expect(following.current).toBe(false);
    await act(async () => vi.advanceTimersByTime(1500));
    snaps.mockClear();
    await renderThread(11, { scrollRef, followingRef: following });

    expect(following.current).toBe(true);
    expect(snaps).toHaveBeenCalled();
  });

  it("offers the jump to latest when rows land below a jump during its hold", async () => {
    vi.useFakeTimers();
    const following = { current: true };
    const scrollRef = createRef<HTMLDivElement>();
    await renderThread(9, { scrollRef, followingRef: following });
    const element = scrollRef.current!;
    Object.defineProperty(element, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(element, "scrollTop", { configurable: true, value: 600 });
    const preview = document.querySelector<HTMLElement>('[data-testid="reply-parent-preview"]');
    await act(async () => preview?.click());

    await renderThread(11, { scrollRef, followingRef: following });
    Object.defineProperty(element, "scrollHeight", { configurable: true, value: 1400 });
    await act(async () => vi.advanceTimersByTime(1500));

    expect(following.current).toBe(false);
    expect(
      document.querySelector('[aria-label="Jump to latest"]')?.getAttribute("aria-hidden"),
    ).toBe("false");
  });

  it("keeps following the end through a tap on a row, not through a press that scrolled", async () => {
    const following = { current: true };
    const scrollRef = createRef<HTMLDivElement>();
    await renderThread(9, { scrollRef, followingRef: following });
    const element = scrollRef.current!;
    const row = element.querySelector("[data-message-id]")!;
    const press = async (from: number, to: number) => {
      Object.defineProperty(element, "scrollTop", { configurable: true, value: from });
      await act(async () => row.dispatchEvent(new Event("pointerdown", { bubbles: true })));
      Object.defineProperty(element, "scrollTop", { configurable: true, value: to });
      await act(async () => row.dispatchEvent(new Event("pointerup", { bubbles: true })));
      return following.current;
    };

    expect([await press(600, 600), await press(600, 540)]).toEqual([true, false]);
  });

  it("draws nothing for an effect that carries no card", async () => {
    await renderThread([
      ...fixture.slice(0, 1),
      ...[
        {
          id: "fx-01",
          seq: 1,
          type: "effect.requested",
          payload: { effectId: "eff_1", effectKind: "send_email", proposal: {} },
        },
        {
          id: "fx-02",
          seq: 2,
          type: "effect.resolved",
          payload: { effectId: "eff_1", decision: "approved" },
        },
      ].map((entry) =>
        SessionEntrySchema.parse({
          ...entry,
          sessionId: "ses_streamed",
          parentId: entry.seq === 1 ? "str-00" : "fx-01",
          ts: "2026-10-10T09:00:01.000Z",
          botId: "bot_ada",
        }),
      ),
    ]);

    expect(
      [...document.querySelectorAll("[data-message-id]")].map((row) => row.textContent),
    ).toEqual(["Find three competitors and summarize Acme's site"]);
  });

  it("gives an approval card the hover pill a bot message has, replying to the card itself", async () => {
    const onReply = vi.fn();
    await renderThread(
      [
        ...fixture.slice(0, 2),
        SessionEntrySchema.parse({
          id: "fx-02",
          sessionId: "ses_streamed",
          seq: 2,
          parentId: "str-01",
          ts: "2026-10-10T09:00:02.000Z",
          botId: "bot_ada",
          runId: "run_str_1",
          type: "effect.requested",
          payload: {
            effectId: "eff_1",
            effectKind: "send_email",
            proposal: {},
            card: { kind: "ask", text: "Send the summary to Acme?" },
          },
        }),
      ],
      { onReply },
    );

    const row = document.querySelector('[data-message-id="fx-02"]');
    expect(row?.querySelector('[data-testid="message-bubble-frame"]')).not.toBeNull();
    const pill = row?.querySelector('[data-testid="message-hover-rail"]');
    expect(
      [...(pill?.querySelectorAll("button") ?? [])].map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual(["Reply", "React", "Copy"]);
    expect(
      pill?.querySelector('[data-testid="message-hover-time"]')?.getAttribute("datetime"),
    ).toBe("2026-10-10T09:00:02.000Z");

    await act(async () => pill?.querySelector<HTMLButtonElement>('[aria-label="Reply"]')?.click());
    expect(onReply.mock.calls.map(([message]) => [message.id, message.blocks])).toEqual([
      ["fx-02", [{ kind: "ask", text: "Send the summary to Acme?" }]],
    ]);
  });

  it("gives a routine's result the hover pill of a bot message, and quotes it under a reply", async () => {
    const onReply = vi.fn();
    const entry = (seq: number, body: object) =>
      SessionEntrySchema.parse({
        id: `rt-0${seq}`,
        sessionId: "ses_streamed",
        seq,
        parentId: seq === 1 ? "str-00" : `rt-0${seq - 1}`,
        ts: `2026-10-10T09:00:0${seq}.000Z`,
        ...body,
      });
    const routine = { botId: "bot_ada", runId: "run_routine" };
    await renderThread(
      [
        ...fixture.slice(0, 1),
        entry(1, {
          ...routine,
          type: "routine.started",
          payload: {
            sessionId: "ses_routine",
            routineId: "rtn_brief",
            name: "Morning brief",
            trigger: "routine",
            scheduledAt: "2026-10-10T07:00:00.000Z",
            model: { provider: "openai", id: "gpt-5" },
          },
        }),
        entry(2, {
          ...routine,
          type: "routine.finished",
          payload: {
            status: "completed",
            usage: { inputTokens: 10, outputTokens: 2 },
            result: "Two meetings today.",
          },
        }),
        entry(3, {
          type: "user.message",
          payload: {
            blocks: [{ kind: "text", text: "Which ones?" }],
            replyTo: { entryId: "rt-01" },
            source: "app",
          },
        }),
      ],
      { onReply },
    );

    const row = document.querySelector('[data-message-id="rt-01"]');
    const pill = row?.querySelector('[data-testid="message-hover-rail"]');
    expect(
      [...(pill?.querySelectorAll("button") ?? [])].map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual(["Reply", "React", "Copy"]);
    expect(
      pill?.querySelector('[data-testid="message-hover-time"]')?.getAttribute("datetime"),
    ).toBe("2026-10-10T09:00:02.000Z");
    expect(text('[data-testid="reply-parent-preview"]')).toEqual(["Two meetings today."]);

    await act(async () => pill?.querySelector<HTMLButtonElement>('[aria-label="Reply"]')?.click());
    expect(onReply.mock.calls.map(([message]) => [message.id, message.blocks])).toEqual([
      ["rt-01", [{ kind: "text", text: "Two meetings today." }]],
    ]);
  });

  it("draws three screenshots sent as three messages as one stack that acts on the newest", async () => {
    const onReply = vi.fn();
    const shots = ["a", "b", "c"].map((name, seq) =>
      SessionEntrySchema.parse({
        id: `shot-${seq}`,
        sessionId: "ses_shots",
        seq,
        parentId: seq === 0 ? null : `shot-${seq - 1}`,
        ts: `2026-10-10T09:00:0${seq}.000Z`,
        botId: "bot_ada",
        type: "bot.text",
        payload: {
          blocks: [
            {
              kind: "image",
              artifactId: `art_${name}`,
              mimeType: "image/png",
              name: `${name}.png`,
            },
          ],
        },
      }),
    );
    const view = projectThreadView(shots, { imageStacks: true });
    await renderThread(shots, { view, peerBot: () => ({ color: "#000", name: "Pixel" }), onReply });

    expect(text('[data-slot="image-stack"]')).toEqual([""]);
    expect(
      [...document.querySelectorAll('[data-slot="image-stack"]')].map((stack) =>
        stack.getAttribute("aria-label"),
      ),
    ).toEqual(["Image 1 of 3, from Pixel"]);
    expect(document.querySelectorAll("[data-message-id]")).toHaveLength(1);

    const pill = document.querySelector('[data-testid="message-hover-rail"]');
    await act(async () => pill?.querySelector<HTMLButtonElement>('[aria-label="Reply"]')?.click());
    expect(onReply.mock.calls.map(([message]) => message.id)).toEqual(["shot-2"]);
  });

  it("keeps a captioned host's actions when image-only messages join its stack", async () => {
    const onReply = vi.fn();
    const image = (name: string) => ({
      kind: "image",
      artifactId: `art_${name}`,
      mimeType: "image/png",
      name: `${name}.png`,
    });
    const entries = [
      [{ kind: "text", text: "Here are the results" }, image("a")],
      [image("b")],
    ].map((blocks, seq) =>
      SessionEntrySchema.parse({
        id: `cap-${seq}`,
        sessionId: "ses_caption",
        seq,
        parentId: seq === 0 ? null : `cap-${seq - 1}`,
        ts: `2026-10-10T09:00:0${seq}.000Z`,
        botId: "bot_ada",
        type: "bot.text",
        payload: { blocks },
      }),
    );
    const view = projectThreadView(entries, { imageStacks: true });
    await renderThread(entries, {
      view,
      peerBot: () => ({ color: "#000", name: "Pixel" }),
      onReply,
    });

    expect(document.querySelectorAll("[data-message-id]")).toHaveLength(1);
    const pill = document.querySelector('[data-testid="message-hover-rail"]');
    await act(async () => pill?.querySelector<HTMLButtonElement>('[aria-label="Reply"]')?.click());
    expect(onReply.mock.calls.map(([message]) => message.id)).toEqual(["cap-0"]);
  });

  it("opens a finished helper's own session from its step in debug mode, read-only", async () => {
    setDebugMode(true);
    await renderThread(9);

    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-testid="agent-steps-toggle"]')?.click(),
    );
    const step = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "scout",
    );
    await act(async () => step?.click());

    expect(api.sessionEntries).toHaveBeenCalledWith(
      { sessionId: "ses_scout" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const session = document.querySelector('[data-testid="session-view"]');
    expect(session?.textContent).toContain("Globex and Initech");
    expect(session?.querySelector('[data-testid="message-hover-rail"]')).toBeNull();
  });
});

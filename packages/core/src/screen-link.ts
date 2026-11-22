/**
 * The link between a host (web, Desktop, iOS) and the screen page it shows. The page reports
 * its connection state; the host treats every message as hostile because the bot can serve
 * that page, so a message can only move the indicator or ask for a status read.
 */

export const SCREEN_LINK_MESSAGE_TYPE = "tangow-screen-state";
export const SCREEN_LINK_VERSION = 1;
export const SCREEN_LINK_STATES = [
  "connecting",
  "connected",
  "reconnecting",
  "stalled",
  "failed",
] as const;
export type ScreenLinkState = (typeof SCREEN_LINK_STATES)[number];

const MAX_MESSAGE_CHARS = 256;

export function parseScreenLinkMessage(data: unknown): ScreenLinkState | null {
  if (typeof data !== "string" || data.length > MAX_MESSAGE_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value && "version" in value && "state" in value) ||
    Object.keys(value).length !== 3 ||
    value.type !== SCREEN_LINK_MESSAGE_TYPE ||
    value.version !== SCREEN_LINK_VERSION
  ) {
    return null;
  }
  return SCREEN_LINK_STATES.find((state) => state === value.state) ?? null;
}

/** `embed` is Tangow's own viewer page, which reports its state; `plain` never does. */
export type ScreenLinkChannel = "embed" | "plain";

const CAPABILITY_DIRECTORY = /^\/novnc\/session\/(?:view|control)\/\d+\.[A-Za-z0-9_-]+\//;

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function capabilityDirectory(url: URL): string | null {
  return CAPABILITY_DIRECTORY.exec(url.pathname)?.[0] ?? null;
}

export function screenLinkChannel(url: string): ScreenLinkChannel {
  const parsed = httpUrl(url);
  const directory = parsed ? capabilityDirectory(parsed) : null;
  return parsed && directory && parsed.pathname === `${directory}embed.html` ? "embed" : "plain";
}

/** The document is on the screen's origin, inside the same capability directory. */
export function isScreenDocumentUrl(candidate: string, screenUrl: string): boolean {
  const screen = httpUrl(screenUrl);
  const page = httpUrl(candidate);
  if (!screen || !page || page.origin !== screen.origin) return false;
  const directory = capabilityDirectory(screen);
  return directory !== null && page.pathname.startsWith(directory);
}

/** What a WebView showing `screenUrl` may load as a top-level document. */
export function screenNavigationAllowed(requestUrl: string, screenUrl: string): boolean {
  return requestUrl === "about:blank" || isScreenDocumentUrl(requestUrl, screenUrl);
}

export type ScreenLinkView = "none" | "connecting" | "reconnecting" | "failed";
type Link = Exclude<ScreenLinkState, "stalled">;

export interface ScreenLinkModel {
  readonly url: string;
  readonly channel: ScreenLinkChannel;
  readonly link: Link;
  /** When `link` last changed, with hidden time excluded. */
  readonly since: number;
  /** A valid message arrived for this URL. */
  readonly talking: boolean;
  readonly loadedAt: number | null;
  readonly hidden: boolean;
  readonly resumeDeadline: number | null;
  readonly arrivals: readonly number[];
  readonly adjudications: readonly number[];
}

export type ScreenLinkEvent =
  | { readonly type: "message"; readonly data: unknown; readonly now: number }
  | { readonly type: "loaded"; readonly now: number }
  | { readonly type: "hidden"; readonly now: number }
  | { readonly type: "returned"; readonly hiddenForMs: number; readonly now: number }
  | { readonly type: "tick"; readonly now: number };

/** `adjudicate`: read the status and reuse or replace the URL. `reload`: force a new URL. */
export type ScreenLinkEffect = "adjudicate" | "reload";

const WATCHDOG_MS: Partial<Record<Link, number>> = { connecting: 60_000, reconnecting: 75_000 };
const SILENT_EMBED_MS = 1_500;
const MESSAGES_PER_SECOND = 20;
const FLOOD_MESSAGES = 100;
const FLOOD_WINDOW_MS = 10_000;
const ADJUDICATIONS_PER_WINDOW = 3;
const ADJUDICATION_WINDOW_MS = 60_000;
const ADJUDICATION_SPACING_MS = 5_000;
/** A page hidden this long has lost its viewer connection (iOS suspends it). */
const SCREEN_RESUME_MS = 10_000;

export function initialScreenLink(url: string, now: number, hidden = false): ScreenLinkModel {
  return {
    url,
    channel: screenLinkChannel(url),
    link: "connecting",
    since: now,
    talking: false,
    loadedAt: null,
    hidden,
    resumeDeadline: null,
    arrivals: [],
    adjudications: [],
  };
}

export function screenLinkView(model: ScreenLinkModel): ScreenLinkView {
  return model.link === "connected" ? "none" : model.link;
}

type Step = { model: ScreenLinkModel; effects: ScreenLinkEffect[] };

export function reduceScreenLink(model: ScreenLinkModel, event: ScreenLinkEvent): Step {
  switch (event.type) {
    case "hidden":
      return quiet({ ...model, hidden: true });
    case "returned":
      return returned(model, event.hiddenForMs, event.now);
  }
  if (model.link === "failed") return quiet(model);
  switch (event.type) {
    case "message":
      return message(model, event.data, event.now);
    case "loaded":
      return loaded(model, event.now);
    case "tick":
      return tick(model, event.now);
  }
}

export function nextScreenLinkDeadline(model: ScreenLinkModel): number | null {
  if (model.hidden || model.link === "failed") return null;
  const deadlines = [watchdogAt(model), demotionAt(model), model.resumeDeadline].filter(
    (deadline) => deadline !== null,
  );
  return deadlines.length > 0 ? Math.min(...deadlines) : null;
}

function message(model: ScreenLinkModel, data: unknown, now: number): Step {
  if (model.channel !== "embed") return quiet(model);
  const arrivals = [...model.arrivals.filter((at) => now - at < FLOOD_WINDOW_MS), now];
  const counted = { ...model, arrivals };
  if (arrivals.length > FLOOD_MESSAGES) return quiet(relink(counted, "failed", now));
  if (arrivals.filter((at) => now - at < 1_000).length > MESSAGES_PER_SECOND) return quiet(counted);
  const state = parseScreenLinkMessage(data);
  if (state === null) return quiet(counted);
  const heard = { ...counted, talking: true, resumeDeadline: null };
  return state === "stalled" ? adjudicate(heard, now) : quiet(relink(heard, state, now));
}

function adjudicate(model: ScreenLinkModel, now: number): Step {
  const recent = model.adjudications.filter((at) => now - at < ADJUDICATION_WINDOW_MS);
  const last = recent.at(-1);
  if (last !== undefined && now - last < ADJUDICATION_SPACING_MS) return quiet(model);
  if (recent.length >= ADJUDICATIONS_PER_WINDOW) return quiet(model);
  return { model: { ...model, adjudications: [...recent, now] }, effects: ["adjudicate"] };
}

/**
 * A second load of the same frame means the document navigated away from the one we trust, or a
 * browser reported one load twice: stop listening and show the page as a plain one either way.
 */
function loaded(model: ScreenLinkModel, now: number): Step {
  if (model.loadedAt !== null) {
    if (model.channel === "plain") return quiet(model);
    const deaf = { ...model, channel: "plain" as const, talking: false, resumeDeadline: null };
    return quiet(relink(deaf, "connected", now));
  }
  const next = { ...model, loadedAt: now };
  return quiet(model.channel === "plain" ? relink(next, "connected", now) : next);
}

function tick(model: ScreenLinkModel, now: number): Step {
  if (model.hidden) return quiet(model);
  const watchdog = watchdogAt(model);
  if (watchdog !== null && now >= watchdog) return quiet(relink(model, "failed", now));
  const demotion = demotionAt(model);
  const next =
    demotion !== null && now >= demotion
      ? relink({ ...model, channel: "plain" }, "connected", now)
      : model;
  if (next.resumeDeadline !== null && now >= next.resumeDeadline) {
    return { model: { ...next, resumeDeadline: null }, effects: ["reload"] };
  }
  return quiet(next);
}

/**
 * A talking embed reconnects by itself after a long absence and re-announces its state; a page
 * that stays silent for SCREEN_RESUME_MS afterwards is reloaded like a plain one.
 */
function returned(model: ScreenLinkModel, hiddenForMs: number, now: number): Step {
  const exclude = (at: number) => at + Math.min(hiddenForMs, now - at);
  const shown = {
    ...model,
    hidden: false,
    since: exclude(model.since),
    loadedAt: model.loadedAt === null ? null : exclude(model.loadedAt),
  };
  if (hiddenForMs < SCREEN_RESUME_MS) return quiet(shown);
  if (model.talking && model.link !== "failed") {
    return quiet({ ...shown, since: now, resumeDeadline: now + SCREEN_RESUME_MS });
  }
  return { model: shown, effects: ["reload"] };
}

function watchdogAt(model: ScreenLinkModel): number | null {
  const ms = WATCHDOG_MS[model.link];
  return ms === undefined ? null : model.since + ms;
}

function demotionAt(model: ScreenLinkModel): number | null {
  return model.channel === "embed" && !model.talking && model.loadedAt !== null
    ? model.loadedAt + SILENT_EMBED_MS
    : null;
}

function relink(model: ScreenLinkModel, link: Link, now: number): ScreenLinkModel {
  return link === model.link ? model : { ...model, link, since: now };
}

function quiet(model: ScreenLinkModel): Step {
  return { model, effects: [] };
}

export interface ScreenLinkClock {
  now(): number;
  /** Runs `fn` after `ms`; returns the cancel. */
  schedule(fn: () => void, ms: number): () => void;
}

export interface ScreenLinkDeps {
  onAdjudicate(): void;
  onReload(): void;
  onView(view: ScreenLinkView): void;
  clock?: ScreenLinkClock;
}

export interface ScreenLink {
  /** A new URL starts over at `connecting`; the host remounts its frame with the URL as key. */
  url(url: string | null): void;
  /** Only for data the platform proved came from the displayed screen document. */
  message(data: unknown): void;
  loaded(): void;
  hidden(): void;
  returned(hiddenForMs: number): void;
  view(): ScreenLinkView;
  dispose(): void;
}

const systemClock: ScreenLinkClock = {
  now: () => Date.now(),
  schedule(fn, ms) {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
};

export function createScreenLink(deps: ScreenLinkDeps): ScreenLink {
  const clock = deps.clock ?? systemClock;
  let model: ScreenLinkModel | null = null;
  let hidden = false;
  let view: ScreenLinkView = "none";
  let cancel: (() => void) | null = null;
  let disposed = false;

  const settle = () => {
    cancel?.();
    cancel = null;
    const next = model ? screenLinkView(model) : "none";
    if (next !== view) {
      view = next;
      deps.onView(next);
    }
    const deadline = model ? nextScreenLinkDeadline(model) : null;
    if (deadline === null) return;
    cancel = clock.schedule(
      () => {
        cancel = null;
        dispatch({ type: "tick", now: clock.now() });
      },
      Math.max(0, deadline - clock.now()),
    );
  };

  const dispatch = (event: ScreenLinkEvent) => {
    if (disposed || !model) return;
    const result = reduceScreenLink(model, event);
    model = result.model;
    settle();
    for (const effect of result.effects) {
      if (effect === "adjudicate") deps.onAdjudicate();
      else deps.onReload();
    }
  };

  return {
    url(url) {
      if (disposed || url === model?.url) return;
      model = url === null ? null : initialScreenLink(url, clock.now(), hidden);
      settle();
    },
    message: (data) => dispatch({ type: "message", data, now: clock.now() }),
    loaded: () => dispatch({ type: "loaded", now: clock.now() }),
    hidden() {
      hidden = true;
      dispatch({ type: "hidden", now: clock.now() });
    },
    returned(hiddenForMs) {
      hidden = false;
      dispatch({ type: "returned", hiddenForMs, now: clock.now() });
    },
    view: () => view,
    dispose() {
      disposed = true;
      cancel?.();
      cancel = null;
      model = null;
    },
  };
}

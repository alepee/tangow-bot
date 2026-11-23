// @vitest-environment jsdom
import type { Bot } from "@tangow/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values);
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace("#", String(count)),
}));
vi.mock("../../lib/rpc", () => ({ rpc: {}, clearSpaceSelection: vi.fn() }));
vi.mock("../../lib/auth", () => ({ authClient: {} }));

import { BotsSidebar } from "./sidebar";

const ARCHIVED = {
  id: "bot-9",
  spaceId: "space-1",
  name: "Scout",
  color: "#3BC9A0",
  shapeSeed: null,
  status: "idle",
  archivedAt: "2026-10-01T08:00:00.000Z",
} as unknown as Bot;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function renderSidebar(overrides: Partial<ComponentProps<typeof BotsSidebar>> = {}) {
  const ref = { current: null };
  const props = {
    botsSidebarCollapsed: false,
    mobileSidebarOpen: true,
    activityMode: false,
    toggleActivityMode: vi.fn(),
    setBotsSidebarCollapsedPref: vi.fn(),
    createMenuOpen: false,
    setCreateMenuOpen: vi.fn(),
    bots: [],
    setPanel: vi.fn(),
    navigate: vi.fn(),
    setNewSpaceOpen: vi.fn(),
    setPickerInfoTopic: vi.fn(),
    sidebarGroups: [],
    collapsedSidebarSections: new Set<string>(),
    openSpaceChat: vi.fn(),
    toggleSidebarSection: vi.fn(),
    spaceMenuAnchor: ref,
    setSpaceMenu: vi.fn(),
    sectionMenuAnchor: ref,
    setSectionMenu: vi.fn(),
    botSections: [],
    spaces: [],
    draggedBotId: null,
    setDraggedBotId: vi.fn(),
    reorderRosterBot: vi.fn(),
    bootstrapMe: null,
    botMenuAnchor: ref,
    setBotMenu: vi.fn(),
    inGroup: false,
    active: undefined,
    activeGroup: undefined,
    activeSnapshot: null,
    initials: "AO",
    userImage: null,
    archivedBots: [ARCHIVED],
    archivedGroups: [],
    archivedOpen: true,
    setArchivedOpen: vi.fn(),
    refreshBots: vi.fn(),
    setDeleteTarget: vi.fn(),
    onOpenArchivedBot: vi.fn(),
    onRestoreBot: vi.fn(),
    setDeleteGroupTarget: vi.fn(),
    setLeaveGroupTarget: vi.fn(),
    setCustomizeOpen: vi.fn(),
    menuOpen: false,
    setMenuOpen: vi.fn(),
    userName: "Archive Owner",
    openSettings: vi.fn(),
    openSearch: vi.fn(),
    botsSidebarEdgeDragRef: { current: null },
  } satisfies ComponentProps<typeof BotsSidebar>;
  act(() => root.render(<BotsSidebar {...props} {...overrides} />));
  return props;
}

it("opens an archived bot's page from its row", () => {
  const props = renderSidebar();
  const row = container.querySelector<HTMLButtonElement>('[data-testid="archived-bot-open"]')!;
  expect(row.textContent).toBe("Scout");

  act(() => row.click());

  expect(props.onOpenArchivedBot.mock.calls).toEqual([["bot-9"]]);
  expect(props.onRestoreBot).not.toHaveBeenCalled();
});

it("restores an archived bot from its row without opening its page", () => {
  const props = renderSidebar();
  const restore = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Restore",
  )!;

  act(() => restore.click());

  expect(props.onRestoreBot.mock.calls).toEqual([["bot-9"]]);
  expect(props.onOpenArchivedBot).not.toHaveBeenCalled();
});

it("reads a bot waiting on the person as Waiting for you, with its avatar at rest", () => {
  const waiting = {
    ...ARCHIVED,
    id: "bot-1",
    name: "Maya",
    status: "waiting_input",
    archivedAt: null,
    title: "Which city should I use?",
    preview: "Which city should I use?",
  } as unknown as Bot;
  renderSidebar({
    archivedBots: [],
    sidebarGroups: [
      {
        key: "space-1",
        title: null,
        bots: [{ kind: "bot", chat: waiting, pinned: false, sectionId: null }],
        sectionId: null,
        showLock: false,
        emptySpaceId: undefined,
        spaceId: "space-1",
        spaceName: "Home",
        canDeleteSpace: false,
      },
    ],
  });
  const row = container.querySelector<HTMLButtonElement>('[data-roster-bot-id="bot-1"]')!;
  expect(row.textContent).toBe("MayaWaiting for you");
  expect(row.querySelector("[data-working]")?.getAttribute("data-working")).toBe("false");
});

it("floats on the chrome glass at desktop width and sits on the page as the phone bot list", () => {
  const paneClass = () =>
    container.querySelector('[data-testid="bots-sidebar-pane"]')?.className.split(" ") ?? [];
  renderSidebar();
  expect(paneClass()).toContain("bg-background");

  act(() => root.unmount());
  root = createRoot(container);
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: media === "(min-width: 768px)",
    media,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  renderSidebar({ mobileSidebarOpen: false });
  expect(paneClass()).toContain("rk-glass-chrome");
  expect(paneClass()).not.toContain("bg-background");
});

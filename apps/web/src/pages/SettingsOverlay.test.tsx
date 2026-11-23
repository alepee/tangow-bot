// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray | { message: string }) =>
      "message" in parts ? parts.message : parts.join(""),
  }),
}));
vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => ({ message: parts.join("") }),
}));
vi.mock("../lib/rpc", () => ({ rpc: { computer: { list: async () => [] } } }));
vi.mock("./AccountSettingsOverlay", () => ({
  ProfileSettingsPanels: () => <p>profile body</p>,
  UpdatesSettingsPanel: () => <p>updates body</p>,
}));
vi.mock("./usage-settings", () => ({ UsageSettingsPanel: () => <p>usage body</p> }));
vi.mock("./VoiceSettingsOverlay", () => ({
  VoiceSettingsOverlay: ({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) => {
    useEffect(() => onBusyChange(true), [onBusyChange]);
    return <p>voice body</p>;
  },
}));
vi.mock("./ComputerSettingsPanel", () => ({}));
vi.mock("./DecisionModelSettingsPanel", () => ({}));
vi.mock("./MemorySettingsOverlay", () => ({}));
vi.mock("./ModelSettingsOverlay", () => ({}));
vi.mock("./ProvidersSettings", () => ({}));
vi.mock("./SpaceGeneralSettings", () => ({}));

import { SettingsOverlay } from "./SettingsOverlay";
import type { SettingsSection } from "./settings-sections";

function stubViewport(phone: boolean) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: phone,
    media,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

async function open(initialSection?: SettingsSection) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <SettingsOverlay
        name="Ada"
        initials="A"
        image={null}
        initialSection={initialSection}
        memoryConfig={null}
        onMemoryConfigChange={() => {}}
        spaces={[]}
        currentSpaceId={undefined}
        onSwitchSpace={() => {}}
        onClose={() => {}}
      />,
    ),
  );
  return async () => {
    await act(async () => root.unmount());
    container.remove();
  };
}

const byTestId = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
const title = () => document.querySelector("h2")?.textContent;
const backButton = () =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === "Settings");

afterEach(() => vi.unstubAllGlobals());

it("opens a phone on the section list and pushes then pops a section", async () => {
  stubViewport(true);
  const close = await open();
  expect(title()).toBe("Settings");
  expect(byTestId("settings-nav")).toBeNull();
  expect(byTestId("settings-list-profile")).not.toBeNull();

  await act(async () => byTestId("settings-list-profile")?.click());
  expect(title()).toBe("Profile");
  expect(document.body.textContent).toContain("profile body");
  expect(document.activeElement).toBe(backButton());

  await act(async () => backButton()?.click());
  expect(title()).toBe("Settings");
  expect(document.activeElement).toBe(byTestId("settings-list-profile"));
  await close();
});

it("opens a phone straight on an explicit section, with the list one back away", async () => {
  stubViewport(true);
  const close = await open("usage");
  expect(title()).toBe("Usage");
  expect(document.body.textContent).toContain("usage body");

  await act(async () => backButton()?.click());
  expect(byTestId("settings-list-usage")).not.toBeNull();
  await close();
});

it("disables back while a panel is busy", async () => {
  stubViewport(true);
  const close = await open("voice");
  expect(backButton()?.disabled).toBe(true);
  await close();
});

it("opens a window on the profile with the nav beside it", async () => {
  stubViewport(false);
  const close = await open();
  expect(title()).toBe("Profile");
  expect(byTestId("settings-nav")).not.toBeNull();
  expect(byTestId("settings-list-profile")).toBeNull();
  expect(backButton()).toBeUndefined();
  await close();
});

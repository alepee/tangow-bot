// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useClayFaceState } from "./use-clay-face-state";

let root: Root;
let container: HTMLElement;

function Probe({ status }: { status?: string }) {
  const face = useClayFaceState(status, "narquois", false);
  return face ? face.expression : "still";
}

function show(status?: string) {
  act(() => root.render(createElement(Probe, { status })));
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

it("is pleased for two seconds when a run it watched completes, then goes still", () => {
  show("running");
  expect(container.textContent).toBe("concentre");
  show("completed");
  expect(container.textContent).toBe("content");
  act(() => vi.advanceTimersByTime(2000));
  expect(container.textContent).toBe("narquois");
  act(() => vi.advanceTimersByTime(400));
  expect(container.textContent).toBe("still");
});

it("shows no old reaction when it mounts after the run ended", () => {
  show("completed");
  expect(container.textContent).toBe("still");
});

it("leaves no timer behind once unmounted mid-reaction", () => {
  show("running");
  show("completed");
  expect(vi.getTimerCount()).toBe(1);
  act(() => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  root = createRoot(container);
});

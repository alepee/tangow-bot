// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useClayFaceState } from "./use-clay-face-state.js";

let root: Root;
let container: HTMLElement;

function Probe({ status, live = false }: { status?: string; live?: boolean }) {
  const face = useClayFaceState(status, "narquois", live);
  return <>{face ? face.expression : "still"}</>;
}

function show(status?: string) {
  act(() => root.render(<Probe status={status} />));
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

const after = (ms: number) => act(() => vi.advanceTimersByTime(ms));

it("is pleased for two seconds when a run it watched completes, then eases back to the still", () => {
  show("idle");
  expect(container.textContent).toBe("still");
  show("running");
  expect(container.textContent).toBe("concentre");
  show("completed");
  expect(container.textContent).toBe("content");
  after(1999);
  expect(container.textContent).toBe("content");
  after(1);
  expect(container.textContent).toBe("narquois");
  after(400);
  expect(container.textContent).toBe("still");
});

it("shows a failure, and a retry interrupts it", () => {
  show("running");
  show("failed");
  expect(container.textContent).toBe("decu");
  show("queued");
  expect(container.textContent).toBe("concentre");
});

it("goes straight back to rest when a run is cancelled", () => {
  show("running");
  show("cancelled");
  expect(container.textContent).toBe("narquois");
  after(400);
  expect(container.textContent).toBe("still");
});

it("shows no old reaction when it mounts after the run ended", () => {
  show("completed");
  expect(container.textContent).toBe("still");
});

it("stays live at rest when asked", () => {
  act(() => root.render(<Probe status="idle" live />));
  expect(container.textContent).toBe("narquois");
});

it("leaves no timer behind once unmounted mid-reaction", () => {
  show("running");
  show("completed");
  expect(vi.getTimerCount()).toBe(1);
  act(() => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  root = createRoot(container);
});

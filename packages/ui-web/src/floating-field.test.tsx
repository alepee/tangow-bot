// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { FloatingField } from "./floating-field.js";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function render(node: ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => createRoot(container).render(node));
  return container;
}

function Email({ error, invalid }: { error?: string; invalid?: boolean }) {
  const [value, setValue] = useState("");
  return (
    <FloatingField
      label="Email"
      type="email"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      error={error}
      invalid={invalid}
    />
  );
}

it("names the field by its label and raises the label once filled", async () => {
  const container = await render(<Email />);
  const input = container.querySelector("input")!;
  const label = container.querySelector("label")!;

  expect(input.labels?.[0]?.textContent).toBe("Email");
  expect(label.hasAttribute("data-filled")).toBe(false);

  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, "person@example.test");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(label.hasAttribute("data-filled")).toBe(true);
});

it("describes the field with its error and marks it invalid only when asked", async () => {
  const rejected = await render(<Email error="Wrong email or password." invalid />);
  const rejectedInput = rejected.querySelector("input")!;
  const description = document.getElementById(rejectedInput.getAttribute("aria-describedby") ?? "");
  expect(rejectedInput.getAttribute("aria-invalid")).toBe("true");
  expect(description?.textContent).toBe("Wrong email or password.");

  const unreachable = await render(<Email error="Couldn't reach the server." />);
  expect(unreachable.querySelector("input")!.hasAttribute("aria-invalid")).toBe(false);
  expect(unreachable.querySelector("[role=alert]")?.textContent).toBe("Couldn't reach the server.");
});

// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { FloatingField, FloatingSelect } from "./floating-field.js";

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

function Email({ error }: { error?: string }) {
  const [value, setValue] = useState("");
  return (
    <FloatingField
      label="Email"
      type="email"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      error={error}
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

it("marks the field invalid and describes it with its error", async () => {
  const container = await render(<Email error="Wrong email or password." />);
  const input = container.querySelector("input")!;
  const description = document.getElementById(input.getAttribute("aria-describedby") ?? "");

  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(description?.textContent).toBe("Wrong email or password.");
});

it("names a select by its label", async () => {
  const container = await render(
    <FloatingSelect label="Provider">
      <option value="anthropic">Anthropic</option>
    </FloatingSelect>,
  );

  expect(container.querySelector("select")?.labels?.[0]?.textContent).toBe("Provider");
});

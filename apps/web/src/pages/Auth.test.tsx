// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ requestPasswordReset: vi.fn(), resetPassword: vi.fn() }));
vi.mock("../lib/auth", () => ({ authClient: auth }));
vi.mock("../lib/rpc", () => ({ clearSpaceSelection: () => undefined }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import { AuthPage, PasswordResetPage } from "./Auth";

afterEach(() => {
  vi.unstubAllGlobals();
  auth.requestPasswordReset.mockReset();
  auth.resetPassword.mockReset();
  document.body.innerHTML = "";
});

async function render(node: ReactNode, url = "/") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(<MemoryRouter initialEntries={[url]}>{node}</MemoryRouter>);
  });
  return container;
}

async function type(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function renderForgot(capabilities: Promise<Response>) {
  vi.stubGlobal("fetch", () => capabilities);
  const container = await render(<AuthPage mode="forgot" />);
  await type(container.querySelector<HTMLInputElement>("#email")!, "person@example.test");
  const button = container.querySelector<HTMLButtonElement>("button[type=submit]")!;
  return { container, button };
}

it("waits for capabilities, then sends a reset link without saying whether the account exists", async () => {
  let respond!: (response: Response) => void;
  const { container, button } = await renderForgot(
    new Promise((resolve) => {
      respond = resolve;
    }),
  );
  auth.requestPasswordReset.mockResolvedValue({ error: null });

  await act(async () => button.click());
  expect(button.disabled).toBe(true);
  expect(container.querySelector("[role=alert]")).toBeNull();

  await act(async () => {
    respond(
      new Response(
        JSON.stringify({ passwordReset: true, resetUrl: "https://tangow.test/reset-password" }),
      ),
    );
  });
  expect(button.disabled).toBe(false);

  await act(async () => button.click());
  expect(auth.requestPasswordReset.mock.calls).toEqual([
    [{ email: "person@example.test", redirectTo: "https://tangow.test/reset-password" }],
  ]);
  expect(container.querySelector("h1")?.textContent).toBe("A new key is on its way.");
  expect(container.querySelector("[role=status]")?.textContent).toBe(
    "If person@example.test has an account, the link is in its inbox.",
  );
});

it("reports recovery as unavailable once capabilities fail to load", async () => {
  const { container, button } = await renderForgot(Promise.reject(new Error("offline")));

  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(container.querySelector("[role=alert]")?.textContent).toBe(
    "Password recovery is not configured for this server",
  );
});

it("resets with the link's token and treats a used token as an expired link", async () => {
  const container = await render(<PasswordResetPage />, "/reset-password?token=abc");
  await type(container.querySelector<HTMLInputElement>("#new-password")!, "fresh-password12");
  await type(container.querySelector<HTMLInputElement>("#confirm-password")!, "other-password12");
  const button = container.querySelector<HTMLButtonElement>("button[type=submit]")!;

  await act(async () => button.click());
  expect(container.querySelector("[role=alert]")?.textContent).toBe("Passwords do not match");
  expect(container.querySelector("#confirm-password")?.getAttribute("aria-invalid")).toBe("true");

  await type(container.querySelector<HTMLInputElement>("#confirm-password")!, "fresh-password12");
  auth.resetPassword.mockResolvedValue({ error: { code: "INVALID_TOKEN", message: "Invalid" } });
  await act(async () => button.click());
  expect(auth.resetPassword.mock.calls).toEqual([
    [{ newPassword: "fresh-password12", token: "abc" }],
  ]);
  expect(container.querySelector("[role=alert]")?.textContent).toBe(
    "This link has expired or was already used.",
  );
});

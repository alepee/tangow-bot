import { captureScreenshot } from "./helpers";
import { expect, test } from "./test";

test("touch users can open and dismiss the remote computer keyboard", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 1 });
    const viewport = new EventTarget();
    Object.defineProperties(viewport, {
      height: { configurable: true, value: 420 },
      offsetTop: { configurable: true, value: 12 },
    });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/screen.html?view_only=false");
  const keyboardButton = page.getByRole("button", { name: "Show keyboard" });
  const trackpadButton = page.getByRole("button", { name: "Use trackpad" });
  const keyboardInput = page.getByRole("textbox", { name: "Remote computer keyboard input" });
  await expect(keyboardButton).toBeVisible();
  await expect(trackpadButton).toBeVisible();

  await trackpadButton.click();
  await expect(page.getByRole("button", { name: "Use direct touch" })).toBeVisible();

  await keyboardButton.click();
  await expect(page.getByRole("button", { name: "Hide keyboard" })).toBeVisible();
  await expect(keyboardInput).toBeFocused();
  await expect(page.locator("html")).toHaveClass(/mobile-keyboard-open/);
  await expect(page.locator("#screen")).toHaveCSS("height", "420px");
  await expect
    .poll(() =>
      page.evaluate(() => ({
        height: document.documentElement.style.getPropertyValue("--mobile-visual-height"),
        top: document.documentElement.style.getPropertyValue("--mobile-visual-top"),
      })),
    )
    .toEqual({ height: "420px", top: "12px" });
  await captureScreenshot(page, testInfo, "mobile-computer-keyboard-open");

  await page.getByRole("button", { name: "Hide keyboard" }).click();
  await expect(keyboardButton).toBeVisible();
  await expect(keyboardInput).not.toBeFocused();
  await expect(page.locator("html")).not.toHaveClass(/mobile-keyboard-open/);
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--mobile-visual-height"),
      ),
    )
    .toBe("");
});

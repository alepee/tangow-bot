// Needs the Vite dev server: the fixture is served from source and is not a build entry.

import type { Page } from "@playwright/test";
import { captureScreenshot } from "./helpers";
import { expect, test } from "./test";

const FIXTURE = "/e2e/fixtures/avatar-motion.html";
const CHARACTERS = 11;

const liveFaces = (page: Page, column: "still" | "live") =>
  page.locator(`[data-face="${column}"] .tangow-clay-face`);

/** Every transform the faces carry, which the animator rewrites as the faces move. */
const pose = (page: Page) =>
  page.$$eval(".tangow-clay-face [data-part]", (parts) =>
    parts.map((part) => part.getAttribute("transform")).join("|"),
  );

test("a bot at rest is its still image, and one kept live is drawn over its body", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  await expect(liveFaces(page, "live")).toHaveCount(CHARACTERS);
  await expect(liveFaces(page, "still")).toHaveCount(0);
  await expect(page.locator('[data-face="still"] img')).toHaveCount(CHARACTERS);
});

test("a live bot whose body fails to load keeps its still image", async ({ page }) => {
  let failed = 0;
  // In dev, Vite also serves each body's module under /bodies/: only fail the image itself.
  await page.route("**/bodies/**", (route) => {
    if (route.request().resourceType() !== "image") return route.continue();
    failed += 1;
    return route.abort();
  });
  await page.goto(FIXTURE);
  await expect.poll(() => failed).toBe(CHARACTERS);
  await expect(page.locator('[data-face="live"] img')).toHaveCount(CHARACTERS);
  await expect(liveFaces(page, "live")).toHaveCount(0);
});

for (const size of [80, 28]) {
  test(`captures the still and live faces side by side, ${size} px`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${FIXTURE}?size=${size}`);
    await expect(liveFaces(page, "live")).toHaveCount(CHARACTERS);
    await captureScreenshot(page, testInfo, `avatar-still-and-live-${size}`);
  });
}

test("a working bot comes alive wherever it is shown", async ({ page }) => {
  await page.goto(`${FIXTURE}?status=running&live=none&size=28`);
  await expect(liveFaces(page, "still")).toHaveCount(CHARACTERS);
  await expect(page.locator('.tangow-clay-avatar[data-working="true"]')).toHaveCount(CHARACTERS);
});

test("all live faces share one frame loop, and none runs while no face is live", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const counted = window as unknown as { frames: number };
    counted.frames = 0;
    const request = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      counted.frames++;
      return request(callback);
    };
  });
  const framesDuring = async (ms: number) => {
    const read = () => page.evaluate(() => (window as unknown as { frames: number }).frames);
    const before = await read();
    await page.waitForTimeout(ms);
    return (await read()) - before;
  };

  await page.goto(`${FIXTURE}?live=none`);
  await expect(page.locator('[data-face="still"] img')).toHaveCount(CHARACTERS);
  expect(await framesDuring(500)).toBe(0);

  await page.goto(FIXTURE);
  await expect(liveFaces(page, "live")).toHaveCount(CHARACTERS);
  const frames = await framesDuring(1000);
  // About 60 for one loop; eleven loops would ask for some 660.
  expect(frames).toBeGreaterThan(20);
  expect(frames).toBeLessThan(90);
});

test("reduced motion holds a live face still, also when turned on mid-session", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  await expect(liveFaces(page, "live")).toHaveCount(CHARACTERS);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  const followingLeft = await pose(page);
  await page.mouse.move(1200, 700);
  await page.waitForTimeout(400);
  expect(await pose(page)).not.toBe(followingLeft);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(200);
  const held = await pose(page);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  expect(await pose(page)).toBe(held);
});

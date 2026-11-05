import { expect, test, type Page } from "@playwright/test";

// Every page fits a phone's width. A page that is wider than the screen makes the phone zoom
// the whole thing out, so everything reads small and the edges hang off.
const ROUTES = ["/", "/plan", "/chat", "/weeks", "/check-in", "/dossier", "/settings", "/privacy"];

async function pageWidth(page: Page) {
  return page.evaluate(() => ({
    viewport: window.innerWidth,
    content: document.scrollingElement!.scrollWidth,
  }));
}

test.describe("on a phone", () => {
  for (const width of [375, 320]) {
    test(`no page is wider than a ${width}px screen`, async ({ page }) => {
      await page.setViewportSize({ width, height: 640 });
      for (const route of ROUTES) {
        await page.goto(route);
        await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
        await page.waitForLoadState("networkidle");
        const { viewport, content } = await pageWidth(page);
        expect(viewport, `${route}: the layout grew wider than the screen`).toBe(width);
        expect(content, `${route}: something hangs off the right edge`).toBeLessThanOrEqual(width);
      }
    });
  }

  test("the main places are tabs along the bottom, and Settings stays in the top bar", async ({
    page,
  }) => {
    await page.goto("/plan");
    const nav = page.getByRole("navigation", { name: "Main" });
    const box = (await nav.boundingBox())!;
    const screen = page.viewportSize()!;
    expect(Math.round(box.y + box.height)).toBe(screen.height);
    expect(Math.round(box.width)).toBe(screen.width);
    for (const name of ["Home", "Plan", "Coach Cade", "History"]) {
      const tab = (await nav.getByRole("link", { name }).boundingBox())!;
      // Each tab is a comfortable thumb target.
      expect(tab.height).toBeGreaterThanOrEqual(44);
    }
    await expect(nav.getByRole("link", { name: "Plan" })).toHaveAttribute("aria-current", "page");

    const settings = page.getByRole("link", { name: "Settings" });
    expect((await settings.boundingBox())!.y).toBeLessThan(box.y);
    await nav.getByRole("link", { name: "History" }).click();
    await expect(page).toHaveURL(/\/weeks$/);
  });

  // The conversation is the page: at each size it keeps most of the screen (#68).
  for (const [width, height, least] of [
    [375, 667, 440],
    [320, 568, 340],
  ]) {
    test(`on a ${width}×${height} screen the conversation gets at least ${least}px`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto("/chat");
      const log = page.getByRole("log", { name: "Conversation" });
      await expect(log).toBeVisible();
      expect((await log.boundingBox())!.height).toBeGreaterThanOrEqual(least);
    });
  }

  test("Coach Cade's page has one slim header: the name, and a way to About you", async ({ page }) => {
    await page.goto("/chat");
    const title = page.getByRole("heading", { name: "Coach Cade", level: 1 });
    await expect(title).toBeVisible();
    // The app's own top bar steps aside here; the tabs still lead everywhere else.
    await expect(page.getByRole("link", { name: "Cadence", exact: true })).toBeHidden();
    const header = (await page.locator("main > header").boundingBox())!;
    expect(header.y).toBe(0);
    expect(header.height).toBeLessThanOrEqual(56);

    const about = page.getByRole("link", { name: "What Coach Cade knows about you" });
    expect((await about.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await about.click();
    await expect(page).toHaveURL(/\/dossier$/);
  });

  test("while typing, the tab bar steps aside and the message box sits at the bottom", async ({ page }) => {
    await page.goto("/chat");
    const nav = page.getByRole("navigation", { name: "Main" });
    const box = page.getByLabel("Message to Coach Cade");
    const form = page.getByRole("form", { name: "Write to Coach Cade" });
    await expect(nav).toBeVisible();

    await box.focus();
    await expect(nav).toBeHidden();
    const screen = page.viewportSize()!;
    const typing = (await form.boundingBox())!;
    expect(Math.round(typing.y + typing.height)).toBe(screen.height);

    // Send and Add a run leave the keyboard up, so the tabs don't jump back under the thumb.
    await box.fill("Typed on a phone.");
    await page.getByRole("button", { name: "Send", exact: true }).tap();
    await expect(page.getByRole("log", { name: "Conversation" })).toContainText("Typed on a phone.");
    await expect(box).toBeFocused();
    await expect(nav).toBeHidden();

    await box.blur();
    await expect(nav).toBeVisible();
  });

  test("the page follows the on-screen keyboard, and the newest message stays in view", async ({ page }) => {
    await page.goto("/chat");
    const log = page.getByRole("log", { name: "Conversation" });
    await expect(log.getByRole("article").last()).toBeVisible();
    const box = page.getByLabel("Message to Coach Cade");
    await box.focus();

    // Chromium has no on-screen keyboard, so stand in for one: the visible area shrinks by 300px.
    const visible = page.viewportSize()!.height - 300;
    await page.evaluate((height) => {
      const vv = window.visualViewport!;
      Object.defineProperty(vv, "height", { configurable: true, get: () => height });
      vv.dispatchEvent(new Event("resize"));
    }, visible);

    const form = page.getByRole("form", { name: "Write to Coach Cade" });
    await expect
      .poll(async () => Math.round((await form.boundingBox())!.y + (await form.boundingBox())!.height))
      .toBe(visible);
    // The conversation re-pins itself once the browser reports its new size.
    await expect
      .poll(() => log.evaluate((el) => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 4))
      .toBe(true);
    await expect(log.getByRole("article").last()).toBeInViewport();
  });

  test("the message box is one line, and grows as you type", async ({ page }) => {
    await page.goto("/chat");
    const box = page.getByLabel("Message to Coach Cade");
    const oneLine = (await box.boundingBox())!.height;
    expect(oneLine).toBeLessThanOrEqual(48);

    await box.fill("one\ntwo\nthree");
    const threeLines = (await box.boundingBox())!.height;
    expect(threeLines).toBeGreaterThan(oneLine + 40);

    // It stops growing at about five lines and scrolls inside itself.
    await box.fill(Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"));
    expect((await box.boundingBox())!.height).toBeLessThanOrEqual(150);

    // Return adds a line on a phone; it does not send.
    await box.fill("first");
    await box.press("Enter");
    await expect(box).toHaveValue("first\n");
  });

  test("Coach Cade's message box sits above the tab bar, not behind it", async ({ page }) => {
    await page.goto("/chat");
    const box = page.getByLabel("Message to Coach Cade");
    await expect(box).toBeVisible();
    const send = (await page.getByRole("button", { name: "Send" }).boundingBox())!;
    const nav = (await page.getByRole("navigation", { name: "Main" }).boundingBox())!;
    expect(send.y + send.height).toBeLessThanOrEqual(nav.y);
    // The page itself doesn't scroll; only the conversation does.
    const scroll = await page.evaluate(
      () => document.scrollingElement!.scrollHeight - window.innerHeight,
    );
    expect(scroll).toBeLessThanOrEqual(1);
  });
});

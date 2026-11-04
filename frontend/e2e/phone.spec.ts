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

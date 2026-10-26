import { expect, test } from "@playwright/test";
import { bannedTermsIn } from "./banned";

// Runs first, on a database where nothing has been accepted. Accepting here is what
// lets every later spec start inside the app.
test.describe("welcome", () => {
  test("a new athlete lands on the welcome screen, reads Privacy, and continues to Home", async ({
    page,
  }) => {
    // Any app page sends an unaccepted athlete to the welcome screen.
    // The first visit compiles the page in dev, which can take longer than the usual wait.
    await page.goto("/plan");
    await expect(page).toHaveURL(/\/disclaimer$/, { timeout: 45_000 });
    await expect(page.getByRole("heading", { name: "Welcome to Cadence", level: 1 })).toBeVisible();

    // The text is in titled sections, not one block of preformatted text.
    for (const heading of [
      "What this is",
      "What may be sent to Anthropic",
      "What stays with you",
      "What you tell your coach",
    ]) {
      await expect(page.getByRole("heading", { name: heading, level: 2 })).toBeVisible();
    }
    await expect(page.locator("pre")).toHaveCount(0);
    expect(bannedTermsIn(await page.locator("main").innerText())).toEqual([]);

    // One button, and it asks for no more than an acknowledgement.
    await expect(page.locator("main").getByRole("button")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "I understand, continue" })).toBeVisible();

    // Privacy can be read before accepting, and does not bounce back.
    await page.getByRole("link", { name: "Privacy page" }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/\/privacy$/);

    // Continue lands on Home, with no stop at a checking screen on the way.
    await page.goto("/disclaimer");
    await page.getByRole("button", { name: "I understand, continue" }).click();
    await expect(page).toHaveURL(/localhost:\d+\/$/);
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await expect(page.getByText("Checking disclaimer")).toHaveCount(0);

    // Once accepted, the welcome screen offers no second acceptance.
    await page.goto("/disclaimer");
    await expect(page.getByRole("button", { name: "I understand, continue" })).toHaveCount(0);
    await expect(page.getByText("You accepted this earlier.")).toBeVisible();
  });
});

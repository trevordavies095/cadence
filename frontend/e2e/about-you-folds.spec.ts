import { expect, test, type Page } from "@playwright/test";

// About you after a few weeks: Coach Cade has added a dated update each week and the list of
// changes has grown. This spec serves the page, so it does not depend on what earlier specs noted.

const BODY = [
  "# About you",
  "",
  "## Goal",
  "Lakeshore Half in March.",
  "",
  "## Schedule",
  "You run four days a week.",
  "",
  "## Coach update (Oct 12 – 18)",
  "",
  "- Easy pace is settling near 6:10/km.",
  "",
  "## Coach update (Oct 19 – 25)",
  "",
  "- The calf niggle has cleared.",
  "",
  "## Coach update (Oct 19 – 25)",
  "",
  "- Long runs suit Sunday mornings.",
  "",
].join("\n");

const change = (id: number) => ({
  id,
  kind: "settings",
  status: "accepted",
  summaryBullets: [`Change number ${id}.`],
  appliedVersionId: id + 1,
  previousVersionId: id,
  createdAt: `2026-10-${String(10 + id).padStart(2, "0")}T12:00:00Z`,
  resolvedAt: `2026-10-${String(10 + id).padStart(2, "0")}T12:00:00Z`,
});
// Newest first, as the API lists them.
const CHANGES = [7, 6, 5, 4, 3, 2, 1].map(change);

async function serveAboutYou(page: Page) {
  const json = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });
  await page.route(/\/api\/dossier$/, (route) =>
    route.fulfill(json({ current: { id: 8, body: BODY, createdAt: "2026-10-25T12:00:00Z" } })),
  );
  await page.route(/\/api\/dossier\/proposals$/, (route) => route.fulfill(json({ proposals: [] })));
  await page.route(/\/api\/dossier\/changes$/, (route) => route.fulfill(json({ changes: CHANGES })));
}

test.describe("About you once it has grown", () => {
  test("the dated coach updates are one folded group, by week, after the sections about you", async ({
    page,
  }) => {
    await serveAboutYou(page);
    await page.goto("/dossier");

    const knows = page.getByRole("region", { name: "What Coach Cade knows" });
    await expect(knows.locator("summary")).toHaveText(["Goal", "Schedule", "Since the last tidy-up (3)"]);

    const updates = knows.locator('[data-part="coach-updates"]');
    await expect(updates.getByText("The calf niggle has cleared.")).toBeHidden();
    await updates.locator("summary").click();
    await expect(updates).toContainText("It folds these into the sections above before each weekly read.");
    // Two updates from the same week sit under one date.
    await expect(updates.getByRole("heading", { level: 3 })).toHaveText(["Oct 12 – 18", "Oct 19 – 25"]);
    await expect(updates.locator('[data-part="coach-update"]')).toHaveCount(3);
    await expect(updates.getByText("Long runs suit Sunday mornings.")).toBeVisible();
  });

  test("the five most recent changes show, and the older ones open on request with their Undo", async ({
    page,
  }) => {
    await serveAboutYou(page);
    await page.goto("/dossier");

    const changes = page.getByRole("region", { name: "Changes" });
    await expect(changes.locator("> ul > li")).toHaveCount(5);
    await expect(changes.getByText("Change number 7.")).toBeVisible();
    await expect(changes.getByText("Change number 3.")).toBeVisible();
    await expect(changes.getByText("Change number 2.")).toBeHidden();

    const older = changes.locator('[data-part="older-changes"]');
    await expect(older.locator("summary")).toHaveText("Older changes (2)");
    await older.locator("summary").click();
    const second = older.getByRole("listitem").filter({ hasText: "Change number 2." }).first();
    await expect(second).toBeVisible();
    await expect(second.getByRole("button", { name: "Undo" })).toBeVisible();
  });
});

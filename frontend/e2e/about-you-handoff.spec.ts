import { expect, test, type Page } from "@playwright/test";

// The first answers can be accepted once per database, and first-run.spec.ts does that for
// real on the pinned Sunday. This spec serves About you, so the weekday handoff and the
// tidy-up case can be checked on their own.

const BODY = "## Goal\nLakeshore Half in March.\n";

function proposal(kind: "onboarding" | "audit", status: "pending" | "accepted") {
  return {
    id: 1,
    kind,
    status,
    summaryBullets: ["Training for the Lakeshore Half in March."],
    proposedBody: BODY,
    appliedVersionId: status === "accepted" ? 1 : null,
    previousVersionId: null,
    createdAt: "2026-10-27T12:00:00Z",
    resolvedAt: status === "accepted" ? "2026-10-27T12:05:00Z" : null,
  };
}

const VERSION = { id: 1, body: BODY, createdAt: "2026-10-27T12:05:00Z" };

async function serveAboutYou(page: Page, kind: "onboarding" | "audit", phase: string) {
  let accepted = false;
  // An audit tidies a profile that already exists; first answers have none until accepted.
  const current = () => (accepted || kind === "audit" ? VERSION : null);
  const json = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });
  await page.route(/\/api\/dossier$/, (route) => route.fulfill(json({ current: current() })));
  await page.route(/\/api\/dossier\/proposals$/, (route) =>
    route.fulfill(json({ proposals: accepted ? [] : [proposal(kind, "pending")] })),
  );
  await page.route(/\/api\/dossier\/changes$/, (route) =>
    route.fulfill(json({ changes: accepted ? [proposal(kind, "accepted")] : [] })),
  );
  await page.route(/\/api\/dossier\/proposals\/1\/accept$/, (route) => {
    accepted = true;
    return route.fulfill(json({ proposal: proposal(kind, "accepted"), version: VERSION }));
  });
  await page.route(/\/api\/loop-status(\?.*)?$/, (route) =>
    route.fulfill(json({ phase, flags: { weekEnding: phase === "needs_check_in" } })),
  );
}

test.describe("About you after the first answers", () => {
  test("on a weekday, Looks right says when the first plan comes and points Home", async ({ page }) => {
    await serveAboutYou(page, "onboarding", "mid_week");
    await page.goto("/dossier");

    const card = page.locator('[aria-label="Here’s what Coach Cade understood"]');
    await expect(card.getByRole("button", { name: "Looks right" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Tell Coach Cade" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "You’re set" })).toHaveCount(0);

    await card.getByRole("button", { name: "Looks right" }).click();

    const handoff = page.getByRole("region", { name: "You’re set" });
    await expect(handoff).toContainText(
      "Your weekly check-in opens on Saturday, and Coach Cade plans your first week from it.",
    );
    await expect(handoff.getByRole("link", { name: "Go to Home" })).toHaveAttribute("href", "/");
    await expect(handoff.getByRole("link", { name: "Start check-in" })).toHaveCount(0);
    // The way to tell Coach Cade more comes back once nothing is waiting.
    await expect(page.getByRole("region", { name: "Tell Coach Cade" })).toBeVisible();
  });

  test("a waiting tidy-up keeps the Tell Coach Cade form and has no handoff", async ({ page }) => {
    await serveAboutYou(page, "audit", "mid_week");
    await page.goto("/dossier");

    const card = page.locator('[aria-label="Coach Cade tidied what it knows about you"]');
    await expect(card.getByRole("button", { name: "Looks right" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Tell Coach Cade" })).toBeVisible();

    await card.getByRole("button", { name: "Looks right" }).click();
    await expect(page.getByRole("region", { name: "Waiting for you" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "You’re set" })).toHaveCount(0);
  });
});

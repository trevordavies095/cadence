import { expect, test } from "@playwright/test";
import { bannedTermsIn } from "./banned";

const API_URL = process.env.E2E_API_URL ?? "http://localhost:5102";

const MARATHON = {
  kind: "race",
  distance: "marathon",
  raceName: "Lakeshore Marathon",
  raceDate: "2026-11-15",
  target: "sub 3:30",
};

// Runs after first-run against the real API and the offline coach, so About you exists and
// the change goes through Fix something for real. It starts from a marathon set through the
// API and puts back the goal first-run stored when it is done: later specs read that goal.
test.describe("what you're training for, in Settings", () => {
  let original: unknown = null;

  test.beforeAll(async ({ request }) => {
    const res = await request.get(`${API_URL}/goal`);
    expect(res.ok()).toBeTruthy();
    original = (await res.json()).goal;
    expect((await request.put(`${API_URL}/goal`, { data: { goal: MARATHON } })).ok()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (original) {
      expect((await request.put(`${API_URL}/goal`, { data: { goal: original } })).ok()).toBeTruthy();
    }
  });

  test("change from a marathon to stay fit and see the note card", async ({ page }) => {
    await page.goto("/settings");
    const section = page.getByRole("region", { name: "What you’re training for" });
    await expect(section).toContainText("Race: Lakeshore Marathon on Sun Nov 15 2026, target sub 3:30.");
    // No internal word, "phase" included, reaches the page.
    expect(bannedTermsIn(await section.innerText())).toEqual([]);

    // Change opens the onboarding fields with the stored goal filled in.
    await section.getByRole("button", { name: "Change" }).click();
    await expect(section.getByRole("radio", { name: "A race" })).toHaveAttribute("aria-checked", "true");
    await expect(section.getByRole("radio", { name: "Marathon" })).toHaveAttribute("aria-checked", "true");
    await expect(section.getByLabel("Which race?")).toHaveValue("Lakeshore Marathon");
    await expect(section.getByLabel("Race date")).toHaveValue("2026-11-15");

    await section.getByRole("radio", { name: "Stay fit" }).click();
    const saving = page.waitForResponse(
      (r) => r.url().endsWith("/api/goal") && r.request().method() === "PUT",
    );
    await section.getByRole("button", { name: "Save" }).click();
    const saved = await saving;
    expect(saved.status()).toBe(201);
    expect(saved.request().postDataJSON()).toEqual({ goal: { kind: "fitness" } });

    // The new goal in words, and the note Coach Cade made of it.
    await expect(section).toContainText("General fitness, no race planned.");
    await expect(section.locator('[aria-label="Coach Cade made your change"]')).toBeVisible();

    // About you lists the change as the athlete's own correction.
    await section.getByRole("link", { name: "See it in About you" }).click();
    await expect(page).toHaveURL(/\/dossier/);
    const changes = page.getByRole("region", { name: "Changes" });
    await expect(changes).toContainText("Your correction");
    await expect(changes).toContainText("My goal is now general fitness");
  });
});

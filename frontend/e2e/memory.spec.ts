import { expect, test, type APIRequestContext } from "@playwright/test";

const API_URL = process.env.E2E_API_URL ?? "http://localhost:5102";

// A note the stub coach takes: "skipping" and "niggle" are memory triggers.
const NOTE_MESSAGE = "Skipping Thursday, sore calf niggle after the long run.";

async function currentWeek(request: APIRequestContext) {
  return (await (await request.post(`${API_URL}/weeks/current`)).json()) as { id: string };
}

async function sayAndNote(request: APIRequestContext) {
  const week = await currentWeek(request);
  const res = await request.post(`${API_URL}/weeks/${week.id}/chat`, {
    data: { body: NOTE_MESSAGE },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as { dossierProposal: { id: number } };
}

test.describe("what Coach Cade noted", () => {
  test("a reply that noted something shows a card under it, and Undo takes it back", async ({
    page,
    request,
  }) => {
    await sayAndNote(request);
    await page.goto("/chat");

    const card = page.locator('[aria-label="Coach Cade noted"]').last();
    await expect(card).toBeVisible();
    await expect(card.getByRole("listitem")).not.toHaveCount(0);
    await expect(card.getByRole("button", { name: "Undo" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Fix something" })).toBeVisible();

    // The note is now part of what the coach knows.
    await page.goto("/dossier");
    await expect(page.getByRole("region", { name: "Changes" })).toContainText("Noted by Coach Cade");
    const updateSection = page.getByText(/^Coach update/);
    await expect(updateSection).toHaveCount(1);

    // Undo from the card, and the profile goes back.
    await page.goto("/chat");
    await page.locator('[aria-label="Coach Cade noted"]').last()
      .getByRole("button", { name: "Undo" }).click();
    await expect(page.locator('[aria-label="You undid this"]').last()).toBeVisible();

    await page.goto("/dossier");
    await expect(page.getByText(/^Coach update/)).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Changes" })).toContainText("undone");
  });

  test("Fix something sends a sentence and produces a new card with its own Undo", async ({
    page,
    request,
  }) => {
    await sayAndNote(request);
    await page.goto("/chat");

    const card = page.locator('[aria-label="Coach Cade noted"]').last();
    await card.getByRole("button", { name: "Fix something" }).click();
    await card.getByLabel("What should Coach Cade change?").fill("It was my left calf, not the right.");
    await card.getByRole("button", { name: "Send" }).click();

    const fixed = page.locator('[aria-label="Coach Cade made your change"]').last();
    await expect(fixed).toBeVisible();
    await expect(fixed.getByRole("button", { name: "Undo" })).toBeVisible();

    await fixed.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator('[aria-label="You undid this"]').last()).toBeVisible();
  });

  test("About you: telling Coach Cade something shows a card and a new entry in Changes", async ({
    page,
  }) => {
    await page.goto("/dossier");
    await expect(page.getByRole("heading", { name: "About you", level: 1 })).toBeVisible();

    await page.getByLabel("What should Coach Cade know?").fill("I prefer morning runs.");
    await page.getByRole("button", { name: "Tell Coach Cade" }).click();

    await expect(page.locator('[aria-label="Coach Cade made your change"]').last()).toBeVisible();
    const changes = page.getByRole("region", { name: "Changes" });
    await expect(changes).toContainText("Your correction");
    await expect(changes).toContainText("I prefer morning runs.");

    // Undo from the list puts the profile back and marks the entry.
    const entry = changes.getByRole("listitem").filter({ hasText: "I prefer morning runs." }).first();
    await entry.getByRole("button", { name: "Undo" }).click();
    await expect(entry).toContainText("undone");
  });

  test("the old review sheet and the nav badge are gone", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: /notes/i })).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText(/review (coach|changes)/i)).toHaveCount(0);
  });
});

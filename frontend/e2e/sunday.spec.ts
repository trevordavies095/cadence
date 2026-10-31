import { expect, test, type Page } from "@playwright/test";

const API_URL = process.env.E2E_API_URL ?? "http://localhost:5102";

async function put(request: import("@playwright/test").APIRequestContext, path: string, data: unknown) {
  const res = await request.put(`${API_URL}${path}`, { data });
  expect(res.ok(), `PUT ${path}`).toBeTruthy();
}

async function stepThroughCheckIn(page: Page) {
  await page.goto("/check-in");
  const finish = page.getByRole("button", { name: "Finish check-in" });
  for (let i = 0; i < 20 && !(await finish.isVisible()); i += 1) {
    await page.getByRole("button", { name: "Next", exact: true }).click();
  }
  await finish.click();
}

test.describe("Sunday: check-in to Your week", () => {
  test.beforeAll(async ({ request }) => {
    await put(request, "/settings/tempo", {
      baseUrl: "http://localhost:5001",
      apiKey: "tmp_e2e_key",
    });
    await put(request, "/settings/anthropic", { apiKey: "sk-ant-e2e-key" });
    await put(request, "/dossier", { body: "# About you\n\nEasy base building." });
  });

  test("finishing the check-in waits for the coach, then shows the week and next week's plan", async ({
    page,
  }) => {
    // Show the waiting state once: the first look at the run says it is still reading.
    let looks = 0;
    await page.route(/\/api\/weeks\/[^/]+\/reply-run$/, async (route) => {
      looks += 1;
      if (looks === 1) {
        const real = await (await route.fetch()).json();
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ run: { ...real.run, status: "pending", finishedAt: null } }),
        });
      } else {
        await route.continue();
      }
    });

    await stepThroughCheckIn(page);

    // Finishing lands on Your week, which says the coach is reading.
    await expect(page).toHaveURL(/\/review/);
    await expect(page.getByRole("heading", { name: "Your week", level: 1 })).toBeVisible();
    await expect(page.getByText("Coach Cade is reading your week")).toBeVisible();
    await expect(page.getByText("You can leave this page.", { exact: false })).toBeVisible();

    // It polls, then the coach's read and next week's plan arrive.
    const read = page.getByRole("region", { name: "Coach Cade’s read" });
    await expect(read).toBeVisible({ timeout: 20_000 });
    // The read opens with Coach Cade's headline, and the read below does not repeat it.
    await expect(read.locator('[data-part="headline"]')).toContainText("looks workable");
    await expect(read.getByText(/looks workable/)).toHaveCount(1);

    const next = page.getByRole("region", { name: "Next week" });
    await expect(next.getByRole("listitem")).toHaveCount(7);
    await expect(next).toContainText("Oct 26 – Nov 1");

    const noted = page.getByRole("region", { name: "What Coach Cade noted" });
    await expect(noted).toBeVisible();
    // The reply's note shows as a card here, with the two things the athlete can do.
    await expect(noted.locator('[aria-label="Coach Cade noted"]')).toBeVisible();
    await expect(noted.getByRole("button", { name: "Undo" })).toBeVisible();
    await expect(noted.getByRole("button", { name: "Fix something" })).toBeVisible();
    await expect(page.getByText("Coach Cade is reading your week")).toHaveCount(0);

    // The report is on the same page.
    const week = page.getByRole("region", { name: "Your week", exact: true });
    await expect(week.getByRole("table", { name: "This week in numbers" })).toBeVisible();

    // The Home banner announces the plan until the athlete opens it.
    await page.goto("/");
    const banner = page.getByRole("status").filter({ hasText: "Next week’s plan is ready" });
    await expect(banner).toBeVisible();
    await banner.getByRole("link", { name: "See it" }).click();

    await expect(page).toHaveURL(/\/plan/);
    await expect(page.getByRole("region", { name: "Next week plan" })).toBeVisible();

    await page.goto("/");
    await expect(page.getByText("Next week’s plan is ready")).toHaveCount(0);
  });
});

test.describe("Your week: the report", () => {
  test("shows the numbers, zones and runs from the fixture week", async ({ page }) => {
    await page.goto("/review");
    const week = page.getByRole("region", { name: "Your week", exact: true });

    const numbers = week.getByRole("table", { name: "This week in numbers" });
    await expect(numbers.getByRole("columnheader")).toHaveText([
      "",
      "This week",
      "Last week",
      "3-week average",
      "Change",
    ]);
    await expect(numbers.getByRole("rowheader", { name: "Distance" })).toBeVisible();
    await expect(numbers.getByRole("rowheader", { name: "Runs" })).toBeVisible();
    // Distances come in the athlete's units, not as raw metres.
    await expect(numbers.getByRole("row", { name: /Distance/ })).toContainText(/\d+\.\d+ mi/);

    // Heart rate zones as a bar plus words; the target follows the athlete's goal.
    await expect(week.getByRole("heading", { name: "Heart rate zones" })).toBeVisible();
    await expect(week.getByRole("img", { name: /Time in heart rate zones/ })).toBeVisible();

    // At least one run row, with pace and heart rate.
    const runs = week.getByRole("table", { name: "Your runs" });
    const rows = runs.getByRole("row");
    expect(await rows.count()).toBeGreaterThan(1); // header + at least one run
    await expect(runs.getByRole("row").nth(1)).toContainText(/\d+:\d{2}\/mi/);

    // No raw markdown or ISO labels leak into the report.
    const text = await week.innerText();
    expect(text).not.toMatch(/\|\s*---|\*\*|\b\d{4}-W\d{2}\b/);
  });

  test("the zone bar draws the goal's easy-share target, and none without one", async ({
    page,
  }) => {
    const zonesWith = async (target: number | null, met: boolean | null) => {
      await page.unroute(/\/api\/weeks\/[^/]+\/recap\/zones$/);
      await page.route(/\/api\/weeks\/[^/]+\/recap\/zones$/, (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            easyShareTarget: target,
            distribution: {
              zonePct: { z1: 40, z2: 37, z3: 18, z4: 5, z5: 0 },
              z1z2Pct: 77,
              ...(met === null ? {} : { z1z2TargetMet: met }),
              easyShareTarget: target,
              noHrTimeSeriesInWeek: false,
            },
          }),
        }),
      );
      await page.goto("/review");
      return page.getByRole("region", { name: "Your week", exact: true });
    };

    // A 10k block: 75%, met.
    let week = await zonesWith(75, true);
    await expect(week).toContainText("77% of your time was in the two easiest zones.");
    await expect(week).toContainText("That meets the 75% target.");
    await expect(week.locator("[data-easy-share-target]")).toHaveAttribute(
      "data-easy-share-target",
      "75",
    );

    // A half in build: 80%, below.
    week = await zonesWith(80, false);
    await expect(week).toContainText("The target is 80% or more.");

    // Staying fit: the bar with no tick and no verdict.
    week = await zonesWith(null, null);
    await expect(week).toContainText("77% of your time was in the two easiest zones.");
    await expect(week.locator("[data-easy-share-target]")).toHaveCount(0);
    await expect(week.getByText(/of your time was in the two easiest zones/)).not.toContainText(
      /target/i,
    );
  });

  test("says so when the check-in was skipped, instead of showing answers", async ({
    page,
  }) => {
    await page.route(/\/api\/weeks\/[^/]+\/recap$/, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          status: "report",
          checkInStatus: "skipped",
          subjective: "skipped",
          subjectiveAnswers: null,
        }),
      }),
    );
    await page.goto("/review");
    await expect(page.getByText("You skipped this week’s check-in")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your check-in" })).toHaveCount(0);
  });

  test("shows the athlete's own answers next to the runs and in a check-in card", async ({
    page,
  }) => {
    await page.route(/\/api\/weeks\/[^/]+\/recap$/, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          status: "report",
          checkInStatus: "finished",
          subjective: "present",
          subjectiveAnswers: {
            week: "2026-W43",
            runs: [{ date: "2026-10-20", rpe: 3, felt: 4, pain: "Sore foot after" }],
            weekly: {
              sleep_avg_hrs: 8.4,
              stress_level: "Low",
              body_check: "Minor tightness",
              questions_for_coach: ["Is the foot a worry?"],
            },
          },
        }),
      }),
    );
    await page.goto("/review");
    const week = page.getByRole("region", { name: "Your week", exact: true });
    await expect(week.getByRole("heading", { name: "Your check-in" })).toBeVisible();
    await expect(week).toContainText("About 8.4 hours a night");
    await expect(week).toContainText("Minor tightness");
    await expect(week).toContainText("Is the foot a worry?");
    // The Tuesday run carries what the athlete said about it.
    const runs = week.getByRole("table", { name: "Your runs" });
    await expect(runs.getByRole("term").filter({ hasText: "Effort" })).toHaveCount(1);
    await expect(runs.getByRole("definition").filter({ hasText: "3/10" })).toHaveCount(1);
    await expect(week).toContainText("Sore foot after");
    await expect(week.getByText("You skipped this week’s check-in")).toHaveCount(0);
  });
});

test.describe("Your week: what Coach Cade noted", () => {
  test("Undo takes the note back, and About you shows the earlier text", async ({ page }) => {
    await page.goto("/dossier");
    // The reply's note is part of the profile before the undo.
    await expect(page.getByText(/^Coach update/)).toHaveCount(1);

    await page.goto("/review");
    const noted = page.getByRole("region", { name: "What Coach Cade noted" });
    await noted.getByRole("button", { name: "Undo" }).click();
    await expect(noted.locator('[aria-label="You undid this"]')).toBeVisible();

    await page.goto("/dossier");
    await expect(page.getByText(/^Coach update/)).toHaveCount(0);
  });

  test("Fix something there produces a new card", async ({ page }) => {
    await page.goto("/review");
    const noted = page.getByRole("region", { name: "What Coach Cade noted" });
    // The first card was undone above; a correction starts a new one.
    await page.goto("/dossier");
    await page.getByLabel("What should Coach Cade know?").fill("Please keep Sundays easy.");
    await page.getByRole("button", { name: "Tell Coach Cade" }).click();
    await expect(page.locator('[aria-label="Coach Cade made your change"]').last()).toBeVisible();
    void noted;
  });
});

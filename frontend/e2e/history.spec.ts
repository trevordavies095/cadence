import { expect, test, type Page } from "@playwright/test";

const API_URL = process.env.E2E_API_URL ?? "http://localhost:5102";

type WeekRow = Record<string, unknown> & { id: string; isoWeek: string };

/** The real week list, with changes the pinned clock cannot produce on its own. */
async function serveWeeks(page: Page, change: (weeks: WeekRow[]) => WeekRow[]) {
  await page.route(/\/api\/weeks$/, async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...real, weeks: change(real.weeks as WeekRow[]) }),
    });
  });
}

test.describe("History", () => {
  test.beforeAll(async ({ request }) => {
    // Reading next week creates its session, so the list has more than one week.
    const week = await (await request.post(`${API_URL}/weeks/current`)).json();
    expect((await request.get(`${API_URL}/weeks/${week.id}/prescribed/next`)).ok()).toBeTruthy();
  });

  test("lists the weeks newest first with date range, miles, runs and the current week marked", async ({
    page,
  }) => {
    await page.goto("/weeks");
    await expect(page.getByRole("heading", { name: "History", level: 1 })).toBeVisible();

    const table = page.getByRole("table");
    await expect(table.getByRole("columnheader")).toHaveText([
      "Week",
      "Miles",
      "Runs",
      "From Coach Cade",
    ]);

    const rows = table.locator("tbody tr");
    await expect(rows.first()).toContainText("Oct 26 – Nov 1");
    const current = rows.filter({ hasText: "Oct 19 – 25" });
    await expect(current).toContainText("This week");
    // The fixture has two runs that week, and miles come in the athlete's units.
    await expect(current.getByRole("cell").nth(0)).toHaveText(/^\d+\.\d$/);
    await expect(current.getByRole("cell").nth(1)).toHaveText("2");
    await expect(rows.filter({ hasText: "This week" })).toHaveCount(1);

    // Dates read as ranges: no ISO label, time zone or archiving words.
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/\b\d{4}-W\d{2}\b|America\/|archived|Past week/i);
  });

  test("shows the coach's headline on the week it describes, and not on the week before", async ({ page }) => {
    await serveWeeks(page, (weeks) =>
      weeks.map((w) =>
        w.localRange === "Oct 26 – Nov 1"
          ? { ...w, coachHeadline: "Week 1 of the build. The Oct 31 5K slots in as an easy effort." }
          : w,
      ),
    );
    await page.goto("/weeks");
    const next = page.getByRole("row").filter({ hasText: "Oct 26 – Nov 1" });
    await expect(next).toContainText("Week 1 of the build.");
    const current = page.getByRole("row").filter({ hasText: "Oct 19 – 25" });
    await expect(current).not.toContainText("Week 1 of the build.");
  });

  test("blanks miles and runs, and says why, when the running log can't be read", async ({
    page,
  }) => {
    await page.route(/\/api\/weeks$/, async (route) => {
      const real = await (await route.fetch()).json();
      const weeks = (real.weeks as WeekRow[]).map((w) => ({
        ...w,
        actualDistanceM: null,
        runCount: null,
      }));
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ weeks, tempoUnavailable: true }),
      });
    });
    await page.goto("/weeks");
    await expect(page.getByText("Your running log isn’t responding")).toBeVisible();
    const cells = page.getByRole("row").filter({ hasText: "Oct 19 – 25" }).getByRole("cell");
    await expect(cells.nth(0)).toHaveText("–");
    await expect(cells.nth(1)).toHaveText("–");
  });

  test("a past week opens as a read-only Your week with that week's conversation", async ({
    page,
  }) => {
    const realWeeks: WeekRow[] = (
      await (await page.request.get(`${API_URL}/weeks`)).json()
    ).weeks;
    const real = realWeeks.find((w) => w.isoWeek === "2026-W43")!;

    // A week before the pinned one, answered from the real week's data.
    const PAST = "00000000-0000-4000-8000-000000000042";
    await serveWeeks(page, (weeks) => [
      ...weeks,
      { ...real, id: PAST, isoWeek: "2026-W42", localRange: "Oct 12 – 18", archived: true },
    ]);
    await page.route(new RegExp(`/api/weeks/${PAST}/`), (route) =>
      route.continue({ url: route.request().url().replace(PAST, real.id) }),
    );

    await page.goto("/weeks");
    await page.getByRole("link", { name: "Oct 12 – 18" }).click();

    await expect(page).toHaveURL(new RegExp(`/review\\?week=${PAST}`));
    await expect(page.getByRole("heading", { name: "Your week", level: 1 })).toBeVisible();
    await expect(page.locator("main > p", { hasText: "Oct 12 – 18" })).toBeVisible();
    const report = page.getByRole("region", { name: "Your week", exact: true });
    await expect(report.getByRole("table", { name: "This week in numbers" })).toBeVisible();

    // Read-only: nothing to send, retry or redo, and a way back.
    await expect(page.getByRole("region", { name: "The conversation" })).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.locator("main").getByRole("button", { name: /Retry|Ask Coach Cade/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Start your check-in" })).toHaveCount(0);
    await page.getByRole("link", { name: "Back to History" }).click();
    await expect(page).toHaveURL(/\/weeks$/);
  });
});

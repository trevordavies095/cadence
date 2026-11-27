import { expect, test, type Page } from "@playwright/test";

// This week's Plan marks each day done or missed from Home's day outcomes, and puts the days
// above Coach Cade's read. This spec serves the plan and the outcomes, on a Wednesday.

const DATES = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
const DAYS = DATES.map((date, i) =>
  i === 4
    ? { date, dayType: "rest", run: null }
    : { date, dayType: i === 6 ? "long" : "easy", run: { type: i === 6 ? "long" : "easy", distanceM: 8000 } },
);
const STATES = ["missed", "done", "today", "upcoming", "rest", "upcoming", "upcoming"];

function planRecord(week: string, days: unknown[]) {
  return {
    weekSessionId: `session-${week}`,
    plan: { week, days },
    analysis: "A steady week of easy running.",
    settingsProposalBullets: null,
    safetyCallouts: [{ title: "See a professional", body: "If the calf gets worse, see a clinician.", severity: "caution" }],
    readSections: { headline: "A steady week. Keep it easy.", flags: [{ title: "Sleep", detail: "Down to 6.8 hours." }], answers: [] },
    createdAt: "2026-10-18T16:00:00.000Z",
    updatedAt: "2026-10-18T16:00:00.000Z",
  };
}

async function servePlan(page: Page) {
  const json = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });
  const reply = (prescribed: unknown) => json({ unitPreference: "metric", todayYmd: "2026-10-21", prescribed });
  await page.route(/\/api\/weeks\/[^/]+\/prescribed\/next/, (route) =>
    route.fulfill(reply(planRecord("2026-W44", DAYS.map((d, i) => ({ ...d, date: `2026-10-${26 + i}` })).slice(0, 6)))),
  );
  await page.route(/\/api\/weeks\/[^/]+\/prescribed$/, (route) => route.fulfill(reply(planRecord("2026-W43", DAYS))));
  await page.route(/\/api\/home$/, (route) =>
    route.fulfill(
      json({
        weekSessionId: "11111111-1111-4111-8111-111111111111",
        isoWeek: "2026-W43",
        banner: null,
        today: DAYS[2],
        week: DAYS.map((d, i) => ({
          date: d.date,
          dayType: d.dayType,
          plannedDistanceM: d.run?.distanceM ?? null,
          actualDistanceM: STATES[i] === "done" ? 8200 : 0,
          state: STATES[i],
          isToday: i === 2,
        })),
        totals: { actualDistanceM: 8200, plannedDistanceM: 48000 },
        units: "metric",
        tempoUnavailable: false,
      }),
    ),
  );
}

test.describe("this week's Plan", () => {
  test("marks a day done with what was run, a day missed, and nothing on the rest", async ({ page }) => {
    await servePlan(page);
    await page.goto("/plan");
    await page.getByRole("button", { name: "This week" }).click();

    const days = page.getByRole("region", { name: "Week plan" }).locator("ol > li");
    await expect(days).toHaveCount(7);
    await expect(days.nth(0).locator('[data-part="day-outcome"]')).toHaveText("Missed");
    await expect(days.nth(1).locator('[data-part="day-outcome"]')).toHaveText("Done · 8.2 km");
    // Today, a rest day and the days to come carry no mark.
    for (const i of [2, 3, 4, 5, 6]) {
      await expect(days.nth(i).locator('[data-part="day-outcome"]')).toHaveCount(0);
    }
  });

  test("next week's plan carries no marks: nothing there has happened yet", async ({ page }) => {
    await servePlan(page);
    await page.goto("/plan");
    await page.getByRole("button", { name: "Next week" }).click();
    const next = page.getByRole("region", { name: "Next week plan" });
    await expect(next.locator("ol > li")).toHaveCount(6);
    await expect(next.locator('[data-part="day-outcome"]')).toHaveCount(0);
  });

  test("the safety notice stays on top, the days come next, and Coach Cade's read follows them", async ({
    page,
  }) => {
    await servePlan(page);
    await page.goto("/plan");
    await page.getByRole("button", { name: "This week" }).click();
    const week = page.getByRole("region", { name: "Week plan" });

    const top = async (text: string | RegExp) => (await week.getByText(text).first().boundingBox())!.y;
    const notice = await top("See a professional");
    const monday = (await week.locator("ol > li").first().boundingBox())!.y;
    const sunday = (await week.locator("ol > li").last().boundingBox())!.y;
    const headline = (await week.locator('[data-part="headline"]').boundingBox())!.y;
    expect(notice).toBeLessThan(monday);
    expect(sunday).toBeLessThan(headline);
    await expect(week.getByRole("region", { name: "Watching" })).toBeVisible();

    // On next week's plan the read is fresh, so it still leads.
    await page.getByRole("button", { name: "Next week" }).click();
    const next = page.getByRole("region", { name: "Next week plan" });
    const nextHeadline = (await next.locator('[data-part="headline"]').boundingBox())!.y;
    const nextMonday = (await next.locator("ol > li").first().boundingBox())!.y;
    expect(nextHeadline).toBeLessThan(nextMonday);
  });
});

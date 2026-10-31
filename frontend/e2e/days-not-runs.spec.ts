import { expect, test, type Page } from "@playwright/test";

const API_URL = process.env.E2E_API_URL ?? "http://localhost:5102";

/** Oct 19 – 25: strength on Monday, a walk on Wednesday, a ride on Friday. */
const DAYS = [
  { date: "2026-10-19", dayType: "other", run: null, notes: "Strength: 30 min, legs and core." },
  { date: "2026-10-20", dayType: "easy", run: { type: "easy", distanceM: 8000 }, notes: "Easy and short." },
  { date: "2026-10-21", dayType: "other", run: null, notes: "An hour's walk." },
  { date: "2026-10-22", dayType: "easy", run: { type: "easy", distanceM: 0, durationS: 2400 } },
  { date: "2026-10-23", dayType: "other", run: null, notes: "45 min on the bike, easy." },
  { date: "2026-10-24", dayType: "other", run: null },
  { date: "2026-10-25", dayType: "long", run: { type: "long", distanceM: 16000 } },
];

function planRecord(week: string) {
  return {
    weekSessionId: `session-${week}`,
    plan: { week, days: DAYS },
    analysis: "A steady week.",
    settingsProposalBullets: null,
    safetyCallouts: null,
    createdAt: "2026-10-18T16:00:00.000Z",
    updatedAt: "2026-10-18T16:00:00.000Z",
  };
}

async function servePlan(page: Page) {
  const body = (prescribed: unknown) =>
    JSON.stringify({ unitPreference: "metric", todayYmd: "2026-10-21", prescribed });
  await page.route(/\/api\/weeks\/[^/]+\/prescribed\/next/, (route) =>
    route.fulfill({ contentType: "application/json", body: body(null) }),
  );
  await page.route(/\/api\/weeks\/[^/]+\/prescribed$/, (route) =>
    route.fulfill({ contentType: "application/json", body: body(planRecord("2026-W43")) }),
  );
}

test.describe("days that are not runs", () => {
  test.beforeAll(async ({ request }) => {
    for (const [path, data] of [
      ["/settings/tempo", { baseUrl: "http://localhost:5001", apiKey: "tmp_e2e_key" }],
      ["/settings/anthropic", { apiKey: "sk-ant-e2e-key" }],
      ["/dossier", { body: "# About you\n\nEasy base building." }],
    ] as const) {
      expect((await request.put(`${API_URL}${path}`, { data })).ok()).toBeTruthy();
    }
  });

  test("the plan shows a run-less day's notes, labelled Not a run", async ({ page }) => {
    await servePlan(page);
    await page.goto("/plan");

    const days = page.getByRole("region", { name: "Week plan" }).getByRole("listitem");
    await expect(days.nth(0)).toContainText("Not a run · Strength: 30 min, legs and core.");
    await expect(days.nth(0)).not.toContainText("km");
    await expect(days.nth(0)).not.toContainText("No run");
    await expect(days.nth(4)).toContainText("Not a run · 45 min on the bike, easy.");
    await expect(days.nth(1)).toContainText("8.0 km");
    await expect(days.nth(1)).not.toContainText("Not a run");
    // A run-less day that arrived with no notes shows the label alone.
    await expect(days.nth(5)).toContainText("Not a run");
    await expect(days.nth(5)).not.toContainText("Not a run ·");
    await expect(days.nth(5)).not.toContainText("No run");
  });

  test("Home shows today's run-less day and counts nothing for it", async ({ page }) => {
    const week = DAYS.map((d, i) => ({
      date: d.date,
      dayType: d.dayType,
      plannedDistanceM: d.run?.distanceM ?? null,
      plannedDurationS: d.run?.durationS ?? null,
      actualDistanceM: 0,
      state: i < 2 ? (d.run ? "missed" : "rest") : i === 2 ? "today" : d.run ? "upcoming" : "rest",
      isToday: i === 2,
    }));
    await page.route(/\/api\/home$/, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          weekSessionId: "11111111-1111-4111-8111-111111111111",
          isoWeek: "2026-W43",
          banner: null,
          today: DAYS[2],
          week,
          totals: { actualDistanceM: 0, plannedDistanceM: 8000 + 16000, plannedDurationS: 2400 },
          units: "metric",
          tempoUnavailable: false,
        }),
      }),
    );
    await page.goto("/");

    const card = page.locator('[aria-label="Today"]');
    await expect(card.getByRole("heading", { level: 2 })).toHaveText("Not a run");
    await expect(card).toContainText("An hour's walk.");

    const strip = page.getByRole("list", { name: "This week" }).getByRole("listitem");
    await expect(strip.nth(0)).toContainText("Not a run");
    await expect(strip.nth(0)).not.toContainText("Missed");
    await expect(strip.nth(4)).toContainText("Not a run");
    await expect(strip.nth(5)).toContainText("Not a run");
    await expect(strip.nth(6)).not.toContainText("Not a run");
    await expect(page.getByText("0.0 km of 24.0 km and 40 min planned")).toBeVisible();
  });

  test("the plan-change card shows a run-less day with its notes", async ({ page }) => {
    const current = await (await page.request.post(`${API_URL}/weeks/current`)).json();
    await page.route(/\/api\/thread\?/, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          artifacts: [],
          messages: [
            {
              id: "swim",
              role: "coach",
              kind: "chat",
              body: "Friday goes to the bike to give the calf a rest.",
              createdAt: "2026-10-21T18:00:00.000Z",
              weekSessionId: current.id,
              safetyCallouts: [],
              planChanges: [DAYS[4]],
            },
          ],
        }),
      }),
    );
    await page.goto("/chat");

    const card = page.getByRole("region", { name: "Coach Cade changed Fri" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("Not a run · 45 min on the bike, easy.");
    await expect(card).not.toContainText("km");
  });
});

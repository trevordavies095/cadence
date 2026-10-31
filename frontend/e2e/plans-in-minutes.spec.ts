import { expect, test, type Page } from "@playwright/test";

const API_URL = process.env.E2E_API_URL ?? "http://localhost:5102";

/** Oct 19 – 25: Wednesday by time, Thursday by distance and time, the rest by distance. */
const DAYS = [
  { date: "2026-10-19", dayType: "easy", run: { type: "easy", distanceM: 4828 } },
  { date: "2026-10-20", dayType: "rest", run: null },
  { date: "2026-10-21", dayType: "easy", run: { type: "easy", distanceM: 0, durationS: 2400 } },
  {
    date: "2026-10-22",
    dayType: "quality",
    run: { type: "quality", distanceM: 8000, durationS: 2700, structure: "3 x 8 min at threshold" },
  },
  { date: "2026-10-23", dayType: "rest", run: null },
  { date: "2026-10-24", dayType: "easy", run: { type: "easy", distanceM: 0, durationS: 4320 } },
  { date: "2026-10-25", dayType: "long", run: { type: "long", distanceM: 16093 } },
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

test.describe("plans in minutes", () => {
  test.beforeAll(async ({ request }) => {
    for (const [path, data] of [
      ["/settings/tempo", { baseUrl: "http://localhost:5001", apiKey: "tmp_e2e_key" }],
      ["/settings/anthropic", { apiKey: "sk-ant-e2e-key" }],
      ["/dossier", { body: "# About you\n\nEasy base building." }],
    ] as const) {
      expect((await request.put(`${API_URL}${path}`, { data })).ok()).toBeTruthy();
    }
  });

  test("a day planned by time shows minutes, and both when it has both", async ({ page }) => {
    await servePlan(page);
    await page.goto("/plan");

    const week = page.getByRole("region", { name: "Week plan" });
    const days = week.getByRole("listitem");
    await expect(days.nth(2)).toContainText("40 min");
    await expect(days.nth(2)).not.toContainText("0.0 km");
    await expect(days.nth(3)).toContainText("8.0 km, 45 min");
    await expect(days.nth(5)).toContainText("1 h 12 min");
    await expect(days.nth(0)).toContainText("4.8 km");
    await expect(days.nth(0)).not.toContainText("min");
  });

  test("Home shows today's minutes and totals minutes beside the distance", async ({ page }) => {
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
          totals: { actualDistanceM: 0, plannedDistanceM: 4828 + 8000 + 16093, plannedDurationS: 2400 + 4320 },
          units: "metric",
          tempoUnavailable: false,
        }),
      }),
    );
    await page.goto("/");

    const card = page.locator('[aria-label="Today"]');
    await expect(card).toContainText("Easy run · 40 min");
    await expect(card).not.toContainText("0.0 km");

    const strip = page.getByRole("list", { name: "This week" });
    await expect(strip.getByRole("listitem").nth(2)).toContainText("40 min");
    await expect(strip.getByRole("listitem").nth(5)).toContainText("1 h 12 min");
    await expect(page.getByText("0.0 km of 28.9 km and 1 h 52 min planned")).toBeVisible();
  });

  test("the plan-change card shows a timed day in minutes", async ({ page }) => {
    const current = await (await page.request.post(`${API_URL}/weeks/current`)).json();
    await page.route(/\/api\/thread\?/, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          artifacts: [],
          messages: [
            {
              id: "timed",
              role: "coach",
              kind: "chat",
              body: "Saturday goes by time so you can stop when your legs say so.",
              createdAt: "2026-10-21T18:00:00.000Z",
              weekSessionId: current.id,
              safetyCallouts: [],
              planChanges: [DAYS[5]],
            },
          ],
        }),
      }),
    );
    await page.goto("/chat");

    const card = page.getByRole("region", { name: "Coach Cade changed Sat" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("1 h 12 min");
    await expect(card).not.toContainText("0.0");
  });
});

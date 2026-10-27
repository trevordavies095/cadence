import { expect, test, type Page } from "@playwright/test";

const API_URL = process.env.E2E_API_URL ?? "http://localhost:5102";

const WEEK_DATES = [
  "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22",
  "2026-10-23", "2026-10-24", "2026-10-25",
];

type Day = { state: string; planned?: number | null; actual?: number | null; type?: string | null };

/** A /home response, so each weekday's screen can be shown without moving the server's clock. */
function homeBody(options: {
  todayIndex: number;
  days: Day[];
  today?: unknown;
  banner?: unknown;
  tempoUnavailable?: boolean;
  units?: string;
}) {
  const week = WEEK_DATES.map((date, i) => ({
    date,
    dayType: options.days[i]?.type ?? null,
    plannedDistanceM: options.days[i]?.planned ?? null,
    actualDistanceM: options.tempoUnavailable ? null : (options.days[i]?.actual ?? 0),
    state: options.days[i]?.state ?? "rest",
    isToday: i === options.todayIndex,
  }));
  return {
    weekSessionId: "11111111-1111-4111-8111-111111111111",
    isoWeek: "2026-W43",
    banner: options.banner ?? null,
    today: options.today ?? null,
    week,
    totals: {
      actualDistanceM: week.reduce((n, d) => n + (d.actualDistanceM ?? 0), 0),
      plannedDistanceM: week.reduce((n, d) => n + (d.plannedDistanceM ?? 0), 0),
    },
    units: options.units ?? "imperial",
    tempoUnavailable: options.tempoUnavailable ?? false,
  };
}

async function serveHome(page: Page, body: unknown) {
  await page.route(/\/api\/home$/, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(body) }),
  );
}

const MONDAY = homeBody({
  todayIndex: 0,
  days: [
    { state: "today", planned: 4828, type: "easy" },
    { state: "upcoming", planned: 6437, type: "easy" },
    { state: "rest", type: "rest" },
    { state: "upcoming", planned: 8047, type: "quality" },
    { state: "rest", type: "rest" },
    { state: "upcoming", planned: 6437, type: "easy" },
    { state: "upcoming", planned: 16093, type: "long" },
  ],
  today: {
    date: "2026-10-19",
    dayType: "easy",
    run: {
      type: "easy",
      distanceM: 4828,
      paceOrHr: "Heart rate under 155",
      shoes: "ASICS Nimbus 28",
      structure: "Flat route, no surges.",
    },
    strength: "None",
    notes: "Walk if your heart rate climbs.",
  },
});

test.describe("Home", () => {
  test.beforeAll(async ({ request }) => {
    for (const [path, data] of [
      ["/settings/tempo", { baseUrl: "http://localhost:5001", apiKey: "tmp_e2e_key" }],
      ["/settings/anthropic", { apiKey: "sk-ant-e2e-key" }],
      ["/dossier", { body: "# About you\n\nEasy base building." }],
    ] as const) {
      expect((await request.put(`${API_URL}${path}`, { data })).ok()).toBeTruthy();
    }
  });

  test("on Sunday before the check-in: the real week, one banner, and what happens next", async ({
    page,
  }) => {
    await page.goto("/");

    const banner = page.getByRole("status").filter({ hasText: "Time for your weekly check-in" });
    await expect(banner).toBeVisible();
    await expect(banner.getByRole("link", { name: "Start" })).toHaveAttribute("href", "/check-in");
    // At most one banner.
    await expect(page.getByRole("status")).toHaveCount(1);

    // No plan yet: say when the coach plans, instead of an empty card.
    const today = page.getByRole("heading", { name: "Today" });
    await expect(today).toBeVisible();
    await expect(page.getByText("Coach Cade plans each week for you on Sunday")).toBeVisible();

    // The seven days, with the fixture's two runs marked done and today marked.
    const strip = page.getByRole("list", { name: "This week" });
    await expect(strip.getByRole("listitem")).toHaveCount(7);
    await expect(strip.getByText("Done")).toHaveCount(2);
    await expect(strip.locator('[aria-current="date"]')).toContainText("Sun");
    await expect(page.getByText(/9\.3 mi run so far/)).toBeVisible();
  });

  test("on Monday: today's session with shoes and a way to say something came up", async ({
    page,
  }) => {
    await serveHome(page, MONDAY);
    await page.goto("/");

    const card = page.getByRole("region", { name: "Today" }).or(page.locator('[aria-label="Today"]'));
    await expect(card).toContainText("Easy run · 3.0 mi");
    await expect(card.getByRole("term")).toHaveText(["Effort", "Shoes"]);
    await expect(card.getByRole("definition")).toHaveText(["Heart rate under 155", "ASICS Nimbus 28"]);
    await expect(card).toContainText("Walk if your heart rate climbs.");
    await expect(card).not.toContainText("Strength"); // "None" shows nothing
    await expect(page.getByRole("status")).toHaveCount(0); // quiet when nothing needs the athlete

    const strip = page.getByRole("list", { name: "This week" });
    await expect(strip.locator('[aria-current="date"]')).toContainText("Mon");
    await expect(strip.getByText("Planned")).toHaveCount(4);
    await expect(strip.getByText("Rest")).toHaveCount(2);
    await expect(page.getByText("0.0 mi of 26.0 mi planned")).toBeVisible();

    // The stepper of loop states is gone.
    await expect(page.getByRole("list", { name: /loop/i })).toHaveCount(0);
    await expect(page.getByText("Mid-week")).toHaveCount(0);
  });

  test("Something came up opens Coach with today's session quoted", async ({ page }) => {
    await serveHome(page, MONDAY);
    await page.goto("/");
    await page.getByRole("link", { name: "Something came up" }).click();

    await expect(page).toHaveURL(/\/chat\?about=/);
    const composer = page.getByRole("textbox", { name: "Message to Coach Cade" });
    await expect(composer).toHaveValue(/^About today's session \(Mon, Oct 19, Easy run, 3\.0 mi\): /);
  });

  test("on Saturday: done, missed and today are told apart, with the check-in banner", async ({
    page,
  }) => {
    await serveHome(
      page,
      homeBody({
        todayIndex: 5,
        days: [
          { state: "missed", planned: 4828, type: "easy" },
          { state: "done", planned: 6437, actual: 6437, type: "easy" },
          { state: "rest", type: "rest" },
          { state: "done", planned: 8047, actual: 8200, type: "quality" },
          { state: "rest", type: "rest" },
          { state: "today", planned: 6437, type: "easy" },
          { state: "upcoming", planned: 16093, type: "long" },
        ],
        banner: {
          kind: "needs_check_in",
          text: "Time for your weekly check-in",
          cta: { label: "Start", href: "/check-in" },
        },
      }),
    );
    await page.goto("/");

    await expect(page.getByRole("status")).toContainText("Time for your weekly check-in");
    const strip = page.getByRole("list", { name: "This week" });
    await expect(strip.getByText("Missed")).toHaveCount(1);
    await expect(strip.getByText("Done")).toHaveCount(2);
    await expect(strip.getByText("Today")).toHaveCount(1);
    // Done days show what was run, not what was planned.
    await expect(strip.getByText("5.1 mi")).toHaveCount(1); // 8200 m
  });

  test("distances follow a metric preference", async ({ page }) => {
    await serveHome(page, { ...MONDAY, units: "metric" });
    await page.goto("/");
    await expect(page.locator('[aria-label="Today"]')).toContainText("Easy run · 4.8 km");
    expect(await page.locator("main").innerText()).not.toMatch(/\bmi\b/);
  });

  test("when Tempo can't be read it shows the plan alone, and says so quietly", async ({
    page,
  }) => {
    await serveHome(page, { ...MONDAY, tempoUnavailable: true, week: MONDAY.week.map((d) => ({ ...d, actualDistanceM: null, state: d.isToday ? "today" : "upcoming" })) });
    await page.goto("/");
    await expect(page.getByText("only the plan is shown")).toBeVisible();
    await expect(page.locator('[aria-label="Today"]')).toBeVisible();
    await expect(page.getByText(/run so far|planned/)).toHaveCount(0);
  });

  test("a failed reply offers Retry, which restarts it", async ({ page }) => {
    await serveHome(
      page,
      homeBody({
        todayIndex: 6,
        days: [],
        banner: {
          kind: "reply_failed",
          text: "Coach Cade couldn’t finish reading your week",
          cta: { label: "Retry", action: "retry_reply_run" },
        },
      }),
    );
    let retried = false;
    await page.route(/\/api\/weeks\/[^/]+\/reply-run\/retry$/, async (route) => {
      retried = true;
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ run: { id: "r", status: "pending" } }),
      });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => retried).toBe(true);
  });

  test("before setup there is only the banner and a short note", async ({ page }) => {
    await serveHome(page, {
      weekSessionId: null,
      isoWeek: null,
      banner: {
        kind: "setup_incomplete",
        text: "Finish connecting your accounts",
        cta: { label: "Settings", href: "/settings" },
      },
      today: null,
      week: [],
      totals: { actualDistanceM: 0, plannedDistanceM: 0 },
      units: "imperial",
      tempoUnavailable: false,
    });
    await page.goto("/");
    await expect(page.getByRole("status")).toContainText("Finish connecting your accounts");
    await expect(page.getByRole("list", { name: "This week" })).toHaveCount(0);
    await expect(page.getByText("Once your accounts are connected")).toBeVisible();
  });
});

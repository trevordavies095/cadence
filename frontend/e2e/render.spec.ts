import { expect, test } from "@playwright/test";

const API_URL = process.env.E2E_API_URL ?? "http://localhost:5102";

const MARKDOWN = [
  "## Headline",
  "",
  "A steady week. Keep the **easy days easy**.",
  "",
  "- Protect the long run",
  "- Rest means rest",
  "",
  "| Day | Session |",
  "| --- | --- |",
  "| Tue | 4 mi easy |",
  "| Sun | 8 mi long |",
  "",
  "<b>not markup</b>",
].join("\n");

const NO_RAW_MARKDOWN = [/##/, /\*\*/, /\| ---/, /^\s*- /m];

test.describe("coach text is formatted", () => {
  test("a coach message renders as elements, not characters", async ({ page }) => {
    const week = await (await page.request.post(`${API_URL}/weeks/current`)).json();
    await page.route(/\/api\/thread\?/, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          artifacts: [],
          messages: [
            {
              id: "m1",
              role: "coach",
              body: MARKDOWN,
              createdAt: "2026-10-25T16:00:00.000Z",
              weekSessionId: week.id,
              safetyCallouts: [],
            },
          ],
        }),
      }),
    );
    await page.goto("/chat");

    const main = page.locator("main");
    await expect(main.getByRole("heading", { name: "Headline" })).toBeVisible();
    await expect(main.locator("strong", { hasText: "easy days easy" })).toBeVisible();
    await expect(main.getByRole("listitem")).toHaveText([
      "Protect the long run",
      "Rest means rest",
    ]);
    const table = main.getByRole("table");
    await expect(table.getByRole("columnheader")).toHaveText(["Day", "Session"]);
    await expect(table.getByRole("cell")).toHaveText([
      "Tue",
      "4 mi easy",
      "Sun",
      "8 mi long",
    ]);

    // Raw HTML in the text is shown as text, never turned into markup.
    await expect(main.locator("b")).toHaveCount(0);

    const text = await main.innerText();
    for (const raw of NO_RAW_MARKDOWN) expect(text).not.toMatch(raw);
  });

  test("the coach's analysis on Plan renders formatted", async ({ page }) => {
    const plan = {
      week: "2026-W44",
      days: [
        { date: "2026-10-26", dayType: "easy", run: { type: "easy", distanceM: 4828 } },
        { date: "2026-10-27", dayType: "rest", run: null },
        { date: "2026-10-28", dayType: "easy", run: { type: "easy", distanceM: 4828 } },
        { date: "2026-10-29", dayType: "rest", run: null },
        { date: "2026-10-30", dayType: "easy", run: { type: "easy", distanceM: 4828 } },
        { date: "2026-10-31", dayType: "rest", run: null },
        { date: "2026-11-01", dayType: "long", run: { type: "long", distanceM: 8047 } },
      ],
    };
    await page.route(/\/api\/weeks\/[^/]+\/prescribed\/next/, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          weekSession: {},
          unitPreference: "imperial",
          todayYmd: "2026-10-25",
          prescribed: {
            weekSessionId: "w44",
            plan,
            analysis: MARKDOWN,
            settingsProposalBullets: null,
            safetyCallouts: null,
            createdAt: "2026-10-25T16:00:00.000Z",
            updatedAt: "2026-10-25T16:00:00.000Z",
          },
        }),
      }),
    );
    await page.goto("/plan");

    const next = page.getByRole("region", { name: "Next week plan" });
    await expect(next.getByRole("heading", { name: "Headline" })).toBeVisible();
    await expect(next.getByRole("table")).toBeVisible();
    const text = await next.innerText();
    for (const raw of NO_RAW_MARKDOWN) expect(text).not.toMatch(raw);
  });
});

/** A plan record in the shape the API returns. */
function planRecord(week: string, days: unknown[], analysis = "A steady week.") {
  return {
    weekSessionId: `session-${week}`,
    plan: { week, days },
    analysis,
    settingsProposalBullets: null,
    safetyCallouts: null,
    createdAt: "2026-10-25T16:00:00.000Z",
    updatedAt: "2026-10-25T16:00:00.000Z",
  };
}

const NEXT_DAYS = [
  {
    date: "2026-10-26",
    dayType: "easy",
    run: { type: "easy", distanceM: 4828, paceOrHr: "HR under 155", shoes: "ASICS Nimbus 28" },
    strength: "None",
    notes: "n/a",
  },
  { date: "2026-10-27", dayType: "rest", run: null, strength: "Rest", notes: "Rest." },
  { date: "2026-10-28", dayType: "easy", run: { type: "easy", distanceM: 6437, shoes: "Nimbus" } },
  { date: "2026-10-29", dayType: "rest", run: null },
  { date: "2026-10-30", dayType: "easy", run: { type: "easy", distanceM: 4828 } },
  { date: "2026-10-31", dayType: "rest", run: null },
  { date: "2026-11-01", dayType: "long", run: { type: "long", distanceM: 8047 }, notes: "Take it easy." },
];

const THIS_DAYS = [
  { date: "2026-10-19", dayType: "easy", run: { type: "easy", distanceM: 4828 } },
  { date: "2026-10-20", dayType: "rest", run: null },
  { date: "2026-10-21", dayType: "easy", run: { type: "easy", distanceM: 4828 } },
  { date: "2026-10-22", dayType: "rest", run: null },
  { date: "2026-10-23", dayType: "easy", run: { type: "easy", distanceM: 4828 } },
  { date: "2026-10-24", dayType: "rest", run: null },
  { date: "2026-10-25", dayType: "long", run: { type: "long", distanceM: 8047, shoes: "Cushioned long-run shoe" } },
];

/** Serve the two plans, keeping the real unit preference and local date from the API. */
async function servePlans(
  page: import("@playwright/test").Page,
  overrides?: { unitPreference?: string; todayYmd?: string },
) {
  await page.route(/\/api\/weeks\/[^/]+\/prescribed\/next/, async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...real,
        ...overrides,
        prescribed: planRecord("2026-W44", NEXT_DAYS),
      }),
    });
  });
  await page.route(/\/api\/weeks\/[^/]+\/prescribed$/, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        unitPreference: overrides?.unitPreference ?? "imperial",
        todayYmd: overrides?.todayYmd ?? "2026-10-25",
        prescribed: planRecord("2026-W43", THIS_DAYS),
      }),
    });
  });
}

test.describe("the plan page", () => {
  test("the API says what today is and which units the athlete uses", async ({
    request,
  }) => {
    const week = await (await request.post(`${API_URL}/weeks/current`)).json();
    const next = await (
      await request.get(`${API_URL}/weeks/${week.id}/prescribed/next`)
    ).json();
    // The fixture's Tempo account is imperial; the pinned clock is Sunday Oct 25.
    expect(next.unitPreference).toBe("imperial");
    expect(next.todayYmd).toBe("2026-10-25");
  });

  test("days show miles and shoes, and empty entries show nothing", async ({
    page,
  }) => {
    await servePlans(page);
    await page.goto("/plan");

    const next = page.getByRole("region", { name: "Next week plan" });
    const monday = next.getByRole("listitem").first();
    await expect(monday).toContainText("3.0 mi");
    await expect(monday).toContainText("Shoes · ASICS Nimbus 28");
    await expect(monday).toContainText("Easy run");
    // "None" and "n/a" mean nothing to show.
    await expect(monday).not.toContainText("Strength");
    await expect(monday).not.toContainText("None");
    await expect(monday).not.toContainText("n/a");

    const text = await next.innerText();
    expect(text).not.toMatch(/\bkm\b/);
    expect(text).not.toContain("Strength · Rest");
  });

  test("distances follow a metric preference", async ({ page }) => {
    await servePlans(page, { unitPreference: "metric" });
    await page.goto("/plan");
    const next = page.getByRole("region", { name: "Next week plan" });
    await expect(next.getByRole("listitem").first()).toContainText("4.8 km");
    expect(await next.innerText()).not.toMatch(/\bmi\b/);
  });

  test("today is marked in this week's plan", async ({ page }) => {
    await servePlans(page);
    await page.goto("/plan");
    await page.getByRole("button", { name: "This week" }).click();

    const week = page.getByRole("region", { name: "Week plan" });
    const today = week.locator('[aria-current="date"]');
    await expect(today).toHaveCount(1);
    await expect(today).toContainText("Sun, Oct 25");
    await expect(today).toContainText("Today");
    await expect(today).toContainText("5.0 mi");
    await expect(today).toContainText("Shoes · Cushioned long-run shoe");
  });

  test("opens on next week on Sunday and on this week otherwise", async ({
    page,
  }) => {
    await servePlans(page);
    await page.goto("/plan");
    await expect(page.getByRole("button", { name: "Next week" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.unrouteAll();
    await servePlans(page, { todayYmd: "2026-10-21" });
    await page.goto("/plan");
    await expect(page.getByRole("button", { name: "This week" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("asking for a redo needs a confirmation that says what happens", async ({
    page,
  }) => {
    await servePlans(page);
    await page.route(/\/api\/weeks\/[^/]+\/recap/, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ status: "report", checkInStatus: "finished" }),
      }),
    );
    const requests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/week/reply")) requests.push(r.url());
    });
    await page.goto("/plan");

    await expect(page.getByRole("button", { name: /plan next week/i })).toHaveCount(0);
    await page.getByRole("button", { name: "Ask Coach Cade to redo next week" }).click();
    await expect(
      page.getByText("This replaces next week’s plan and takes a couple of minutes."),
    ).toBeVisible();
    expect(requests).toHaveLength(0);

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(
      page.getByText("This replaces next week’s plan and takes a couple of minutes."),
    ).toHaveCount(0);
    expect(requests).toHaveLength(0);
  });
});

test.describe("safety notices", () => {
  test("a stub safety callout renders once, as a notice, with no text prefix", async ({
    page,
    request,
  }) => {
    const week = await (await request.post(`${API_URL}/weeks/current`)).json();
    // "doctor" is a red flag for the stub, but not a memory-update trigger.
    const sent = await request.post(`${API_URL}/weeks/${week.id}/chat`, {
      data: { body: "Saw my doctor today about a sprain." },
    });
    expect(sent.ok()).toBeTruthy();

    await page.goto("/chat");
    // Earlier messages in this shared week may carry the same callout; look at the reply just provoked.
    const reply = page.locator("article").last();
    const notices = reply.locator("aside", { hasText: "See a professional" });
    await expect(notices).toHaveCount(1);
    await expect(notices.getByText("This coach does not diagnose.")).toBeVisible();

    const text = await reply.innerText();
    expect(text).not.toContain("⚠");
    expect(text).not.toMatch(/Safety \(/);
    expect(text.match(/See a professional/g)).toHaveLength(1);
  });
});

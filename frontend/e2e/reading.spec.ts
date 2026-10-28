import { expect, test, type Page } from "@playwright/test";

const API_URL = process.env.E2E_API_URL ?? "http://localhost:5102";

const PAST = "e2e-past-week";
const FIRST_PARAGRAPH = "Big week. We pull back a little before the next block.";
const FULL_READ = [
  "## Headline",
  FIRST_PARAGRAPH,
  "",
  "## Flags",
  "- Sleep slipped to 6.8 hours. Protect it this week.",
].join("\n");

type WeekRow = Record<string, unknown> & { id: string; isoWeek: string };

function sundayMessage(weekSessionId: string, readLink: "plan" | "week") {
  return {
    id: "sunday-read",
    role: "coach",
    kind: "weekly_read",
    readLink,
    body: FIRST_PARAGRAPH,
    createdAt: "2026-10-18T21:00:00.000Z",
    weekSessionId,
    safetyCallouts: [],
  };
}

/**
 * A past week the pinned clock cannot make: the current week's real data under
 * another id, listed as an earlier week, with the Sunday message in its thread.
 */
async function servePastWeek(page: Page, currentId: string) {
  await page.route(/\/api\/weeks$/, async (route) => {
    const real = await (await route.fetch()).json();
    const weeks = real.weeks as WeekRow[];
    const current = weeks.find((w) => w.id === currentId)!;
    const past = { ...current, id: PAST, isoWeek: "2026-W42", archived: true };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...real, weeks: [...weeks, past] }),
    });
  });
  // Playwright tries the newest route first, so the catch-all goes in before the plan.
  await page.route(new RegExp(`/api/weeks/${PAST}/`), async (route) => {
    const url = route.request().url().replace(`/weeks/${PAST}/`, `/weeks/${currentId}/`);
    await route.fulfill({ response: await route.fetch({ url }) });
  });
  await page.route(new RegExp(`/api/weeks/${PAST}/prescribed/next`), (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        unitPreference: "imperial",
        todayYmd: "2026-10-25",
        prescribed: {
          weekSessionId: "w43",
          plan: { week: "2026-W43", days: [] },
          analysis: FULL_READ,
          settingsProposalBullets: null,
          safetyCallouts: null,
          createdAt: "2026-10-18T21:00:00.000Z",
          updatedAt: "2026-10-18T21:00:00.000Z",
        },
      }),
    }),
  );
  await page.route(new RegExp(`/api/thread\\?weekSessionId=${PAST}`), (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ artifacts: [], messages: [sundayMessage(PAST, "week")] }),
    }),
  );
}

test.describe("the Sunday message", () => {
  // The past week forwards requests to the real API; let any still in flight end quietly.
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("on this week's conversation, shows one paragraph and opens the plan", async ({ page }) => {
    const week = await (await page.request.post(`${API_URL}/weeks/current`)).json();
    await page.route(/\/api\/thread\?/, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ artifacts: [], messages: [sundayMessage(week.id, "plan")] }),
      }),
    );
    await page.goto("/chat");

    const message = page.locator('article[data-role="coach"]');
    await expect(message).toContainText(FIRST_PARAGRAPH);
    await expect(message.getByRole("link", { name: "Open the plan" })).toHaveAttribute(
      "href",
      "/plan",
    );
  });

  test("on a past week's Your week page, the read shows once and the link stays on that week", async ({
    page,
  }) => {
    const week = await (await page.request.post(`${API_URL}/weeks/current`)).json();
    await servePastWeek(page, week.id);
    await page.goto(`/review?week=${PAST}`);

    const read = page.getByRole("region", { name: "Coach Cade’s read" });
    await expect(read).toContainText("Sleep slipped to 6.8 hours");

    const conversation = page.getByRole("region", { name: "The conversation" });
    await expect(conversation).toContainText(FIRST_PARAGRAPH);
    await expect(conversation).not.toContainText("Sleep slipped");
    await expect(conversation.getByRole("link", { name: "Open the plan" })).toHaveAttribute(
      "href",
      `/review?week=${PAST}`,
    );
  });
});

const LONG_PARAGRAPH =
  "Big week in the books with forty-five miles, your longest run in two years, and a long run " +
  "with a genuine negative split. That is a confidence builder, and the goal is still live. " +
  "Two things tell me we pull the reins a little this week before we go hard again: the Thursday " +
  "session drifted into a harder zone than planned, and the Sunday drift was well above target. " +
  "Combine that with short sleep and heavy legs into Monday, and the smart play is a modest " +
  "step-back now so we can hit one more quality block before the taper begins.";

const PROSE = [
  LONG_PARAGRAPH,
  "",
  "**Is the goal still sensible?** Yes, with one caveat about the next long run.",
  "",
  "**Don't** run the easy days fast.",
  "",
  "| Day | Session | Pace | Heart rate | Shoes | Notes |",
  "| --- | --- | --- | --- | --- | --- |",
  "| Tue | 5 mi easy | 9:40 to 9:50 per mile | Zone 2, under 148 | Ghost 16 | Flat canal, walk if grim |",
].join("\n");

/** Characters per rendered line of a block of prose, from its height and line height. */
async function charactersPerLine(page: Page, text: string) {
  return page.getByText(text.slice(0, 40)).evaluate((el) => {
    const style = getComputedStyle(el);
    const lines = Math.round(el.getBoundingClientRect().height / parseFloat(style.lineHeight));
    return (el.textContent ?? "").length / lines;
  });
}

test.describe("coach prose", () => {
  test.beforeEach(async ({ page }) => {
    const week = await (await page.request.post(`${API_URL}/weeks/current`)).json();
    await page.route(/\/api\/thread\?/, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          artifacts: [],
          messages: [
            {
              id: "long",
              role: "coach",
              kind: "chat",
              body: PROSE,
              createdAt: "2026-10-25T16:00:00.000Z",
              weekSessionId: week.id,
              safetyCallouts: [],
            },
          ],
        }),
      }),
    );
    await page.goto("/chat");
  });

  test("keeps paragraphs to a comfortable line length", async ({ page }) => {
    const perLine = await charactersPerLine(page, LONG_PARAGRAPH);
    // About 65: the research range is 50 to 75, and the old column ran past 100.
    expect(perLine).toBeGreaterThan(58);
    expect(perLine).toBeLessThan(70);
  });

  test("lets a table use the full width", async ({ page }) => {
    const message = page.locator('article[data-role="coach"]');
    const widths = await message.evaluate((el) => {
      const p = el.querySelector("p")!.getBoundingClientRect().width;
      const table = el.querySelector("table")!.getBoundingClientRect().width;
      return { p, table };
    });
    expect(widths.table).toBeGreaterThan(widths.p);
  });

  test("sets a bold answer as the lead, and leaves bold words inside a sentence alone", async ({
    page,
  }) => {
    const lead = page.locator("strong", { hasText: "Is the goal still sensible?" });
    await expect(lead).toHaveCSS("display", "block");
    const inline = page.locator("strong", { hasText: "Don't" });
    await expect(inline).toHaveCSS("display", "inline");
  });
});

const PLAN_DAYS = [
  { date: "2026-10-26", dayType: "easy", run: { type: "easy", distanceM: 4828 } },
  { date: "2026-10-27", dayType: "rest", run: null },
  { date: "2026-10-28", dayType: "easy", run: { type: "easy", distanceM: 4828 } },
  { date: "2026-10-29", dayType: "rest", run: null },
  { date: "2026-10-30", dayType: "easy", run: { type: "easy", distanceM: 4828 } },
  { date: "2026-10-31", dayType: "rest", run: null },
  { date: "2026-11-01", dayType: "long", run: { type: "long", distanceM: 8047 } },
];

async function serveNextPlan(page: Page, extra: Record<string, unknown>) {
  await page.route(/\/api\/weeks\/[^/]+\/prescribed\/next/, async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...real,
        prescribed: {
          weekSessionId: "w44",
          plan: { week: "2026-W44", days: PLAN_DAYS },
          analysis: "## Flags\n- Sleep slipped to 6.8 hours.",
          settingsProposalBullets: null,
          safetyCallouts: null,
          createdAt: "2026-10-25T16:00:00.000Z",
          updatedAt: "2026-10-25T16:00:00.000Z",
          ...extra,
        },
      }),
    });
  });
}

test.describe("Coach Cade's read", () => {
  test("opens with the headline, in bold, before the rest of the read", async ({ page }) => {
    await serveNextPlan(page, {
      readSections: { headline: "Big week. We pull back a little before the next block." },
    });
    await page.goto("/plan");
    await page.getByRole("button", { name: "Next week" }).click();

    const next = page.getByRole("region", { name: "Next week plan" });
    const headline = next.locator('[data-part="headline"]');
    await expect(headline).toHaveText("Big week. We pull back a little before the next block.");
    await expect(headline).toHaveCSS("font-weight", "600");
    // The headline comes first inside Coach Cade's surface, then the read.
    const order = await next.evaluate((el) =>
      Array.from(el.querySelectorAll('[data-part="headline"], li')).map((n) => n.textContent),
    );
    expect(order[0]).toBe("Big week. We pull back a little before the next block.");
    expect(order[1]).toContain("Sleep slipped");
  });

  test("a plan made before the headline shows the read as it was", async ({ page }) => {
    await serveNextPlan(page, { readSections: null });
    await page.goto("/plan");
    await page.getByRole("button", { name: "Next week" }).click();

    const next = page.getByRole("region", { name: "Next week plan" });
    await expect(next).toContainText("Sleep slipped");
    await expect(next.locator('[data-part="headline"]')).toHaveCount(0);
  });
});

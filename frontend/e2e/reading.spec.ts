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

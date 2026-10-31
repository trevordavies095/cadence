import { expect, test, type Page } from "@playwright/test";
import { bannedTermsIn } from "./banned";

// The fixture's week (Tue and Thu runs), with the Thursday run typed Race in the running log.
const WEEK_ID = "11111111-1111-4111-8111-111111111111";

const NEEDS_CHECK_IN = {
  status: "needs_subjective",
  weekSessionId: WEEK_ID,
  week: "2026-W43",
  timezone: "America/New_York",
  localRange: { start: "2026-10-19", end: "2026-10-25" },
  note: "Collect subjective answers.",
  checkInStatus: "needed",
  runs: [
    { id: "r1", date: "2026-10-20", runType: "Easy Run", distance: "6.21 mi", duration: "1h 0m", distanceM: 10000, durationS: 3600, apiRpe: null },
    { id: "r2", date: "2026-10-22", runType: "Race", distance: "3.11 mi", duration: "20m 0s", distanceM: 5000, durationS: 1200, apiRpe: null },
  ],
  questionnaire: {
    order: ["per_run (RPE, Felt, Pain for each calendar date)"],
    per_run: {
      rpe: "Optional integer 1–10.",
      felt: "Optional integer 1–10 (how the run felt).",
      pain: "Optional free-text niggles / pain (or omit).",
      result: "Optional free text, only for a run typed Race.",
    },
    weekly: {
      sleep_avg_hrs: "Optional average sleep hours this week.",
      sleep_range_hrs: "Optional [low, high] sleep hours.",
      strength_sessions: "Optional { completed, planned, notes } for strength work.",
      stress_level: "Optional free-text stress level.",
      body_check: "Optional free-text body check.",
      feeling_into_next_week: "Optional free-text outlook.",
      questions_for_coach: "Optional string array of questions for the coach.",
    },
    all_fields_optional: true,
  },
};

const REPORT = {
  status: "report",
  weekSessionId: WEEK_ID,
  isoWeek: "2026-W43",
  subjective: "present",
  subjectiveAnswers: null,
  checkInStatus: "finished",
  reportMarkdown: "",
  sections: { summary: "", zones: "", runByRun: "" },
};

const RUN_BY_RUN = {
  unit: "imperial",
  runs: [
    {
      workoutId: "r2", startedAt: "2026-10-22T16:00:00.000Z", titleDate: "Thu Oct 22", runType: "Race",
      distanceM: 5000, durationS: 1200, avgPaceS: 386, avgHeartRateBpm: 176, drift: null, weather: null, shoe: null,
    },
  ],
};

async function serveCheckIn(page: Page) {
  const saved: unknown[] = [];
  await page.route(/\/api\/weeks\/current$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: WEEK_ID, isoWeek: "2026-W43", timezone: "America/New_York",
        start: "2026-10-19T04:00:00.000Z", end: "2026-10-26T03:59:59.999Z",
        createdAt: "2026-10-19T04:00:00.000Z", archived: false, archivedAt: null,
      }),
    }),
  );
  await page.route(/\/api\/weeks\/[^/]+\/recap(\?.*)?$/, (route) => {
    const body = saved.length > 0 ? { ...REPORT, subjectiveAnswers: saved[saved.length - 1] } : NEEDS_CHECK_IN;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route(/\/api\/weeks\/[^/]+\/recap\/run-by-run$/, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(RUN_BY_RUN) }),
  );
  await page.route(/\/api\/weeks\/[^/]+\/recap\/(summary|zones|trends|notable)$/, (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) }),
  );
  await page.route(/\/api\/weeks\/[^/]+\/recap\/subjective$/, (route) => {
    saved.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ gate: REPORT }) });
  });
  await page.route(/\/api\/weeks\/[^/]+\/(reply-run|prescribed)/, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ run: null, prescribed: null }) }),
  );
  return saved;
}

const next = (page: Page) => page.getByRole("button", { name: "Next", exact: true });

test("a race is asked against its target, and the result reaches Your week", async ({ page }) => {
  const saved = await serveCheckIn(page);
  await page.goto("/check-in");

  // An easy run keeps the usual question.
  const easy = page.getByRole("region", { name: /Tue Oct 20/ });
  await expect(easy.getByRole("slider", { name: "How did it go?" })).toBeVisible();
  await expect(easy.getByText("How did it go against your target?")).toHaveCount(0);
  await next(page).click();

  // The race: effort and pain unchanged, the middle question asked against the target.
  const race = page.getByRole("region", { name: "Thu Oct 22 · Race run · 3.1 mi · 20 min" });
  await expect(race.getByRole("slider", { name: "How hard did it feel?" })).toBeVisible();
  await expect(race.getByText("Any pain or niggles?")).toBeVisible();
  await expect(race.getByRole("slider", { name: "How did it go?" })).toHaveCount(0);
  await race.getByRole("slider", { name: "How hard did it feel?" }).fill("9");
  await race.getByLabel("How did it go against your target?").fill("19:58, just under my 20 min target");
  expect(bannedTermsIn(await page.locator("main").innerText())).toEqual([]);
  await next(page).click();

  for (let i = 0; i < 6; i += 1) await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(page.getByLabel("Your answers")).toContainText("Result: 19:58, just under my 20 min target");
  await page.getByRole("button", { name: "Finish check-in" }).click();

  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0]).toEqual({
    week: "2026-W43",
    runs: [{ date: "2026-10-22", rpe: 9, result: "19:58, just under my 20 min target" }],
  });

  await expect(page).toHaveURL(/\/review/);
  const card = page.getByRole("region", { name: "Your week", exact: true });
  // On the race's row in Your runs, and in the check-in card.
  const runs = card.getByRole("table", { name: "Your runs" });
  await expect(runs.getByRole("term").filter({ hasText: "Result" })).toHaveCount(1);
  await expect(runs).toContainText("19:58, just under my 20 min target");
  await expect(card.getByRole("heading", { name: "Your check-in" })).toBeVisible();
  await expect(card.getByRole("term").filter({ hasText: "Race result" })).toHaveCount(1);
});

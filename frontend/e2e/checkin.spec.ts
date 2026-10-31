import { expect, test, type Page } from "@playwright/test";
import { bannedTermsIn } from "./banned";

// The pinned Sunday has one real check-in, and sunday.spec.ts uses it. This spec serves a
// check-in shaped like the fixture's week (Tue and Thu runs) and captures what the page saves.
const WEEK_ID = "11111111-1111-4111-8111-111111111111";

const NEEDS_CHECK_IN = {
  status: "needs_subjective",
  weekSessionId: WEEK_ID,
  week: "2026-W43",
  timezone: "America/New_York",
  localRange: { start: "2026-10-19", end: "2026-10-25" },
  // The API's own wording, which the page must never show.
  note: "Collect subjective answers.",
  checkInStatus: "needed",
  runs: [
    { id: "r1", date: "2026-10-20", runType: "Easy Run", distance: "6.21 mi", duration: "1h 0m", distanceM: 10000, durationS: 3600, apiRpe: null },
    { id: "r2", date: "2026-10-22", runType: "Easy Run", distance: "3.11 mi", duration: "30m 0s", distanceM: 5000, durationS: 1800, apiRpe: 6 },
  ],
  questionnaire: {
    order: ["per_run (RPE, Felt, Pain for each calendar date)"],
    per_run: {
      rpe: "Optional integer 1–10. If apiRpe is set on the run, prefer that value.",
      felt: "Optional integer 1–10 (how the run felt).",
      pain: "Optional free-text niggles / pain (or omit).",
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

async function serveCheckIn(page: Page, opts: { goalKind?: string } = {}) {
  const saved: unknown[] = [];
  const skips: string[] = [];
  // No goal unless a test gives one: pain stays a line of words.
  await page.route(/\/api\/goal$/, (route) =>
    opts.goalKind
      ? route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            id: 1, goal: { kind: opts.goalKind }, source: "onboarding", createdAt: "2026-10-01T12:00:00.000Z",
          }),
        })
      : route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "goal_not_found" }) }),
  );
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
    const skipped = route.request().url().includes("skip_subjective=true");
    if (skipped) skips.push(route.request().url());
    // Once answers are saved, the week is a report carrying them, as Your week reads it.
    const body = skipped
      ? { ...REPORT, checkInStatus: "skipped", subjective: "skipped" }
      : saved.length > 0
        ? { ...REPORT, subjectiveAnswers: saved[saved.length - 1] }
        : NEEDS_CHECK_IN;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  // Your week's numbers are not under test here; only its check-in card is.
  await page.route(/\/api\/weeks\/[^/]+\/recap\/(summary|zones|run-by-run|trends|notable)$/, (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) }),
  );
  await page.route(/\/api\/weeks\/[^/]+\/recap\/subjective$/, (route) => {
    saved.push(route.request().postDataJSON());
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ gate: REPORT }),
    });
  });
  // Where the page goes afterwards is not under test here.
  await page.route(/\/api\/weeks\/[^/]+\/(reply-run|prescribed)/, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ run: null, prescribed: null }) }),
  );
  return Object.assign(saved, { skips });
}

/** The week as Home reports it, so the page can be shown on any weekday. */
async function serveToday(page: Page, todayIndex: number) {
  const dates = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
  await page.route(/\/api\/home$/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        weekSessionId: WEEK_ID,
        isoWeek: "2026-W43",
        banner: null,
        today: null,
        week: dates.map((date, i) => ({
          date, dayType: null, plannedDistanceM: null, actualDistanceM: 0, state: "upcoming", isToday: i === todayIndex,
        })),
        totals: { actualDistanceM: 0, plannedDistanceM: 0 },
        units: "imperial",
        tempoUnavailable: false,
      }),
    }),
  );
}

const next = (page: Page) => page.getByRole("button", { name: "Next", exact: true });

test.describe("check-in", () => {
  test("each run is a card with its own title and two sliders, and the watch's effort is filled in", async ({ page }) => {
    await serveCheckIn(page);
    await page.goto("/check-in");

    await expect(page.getByText("1 of 8", { exact: true })).toBeVisible();
    const first = page.getByRole("region", { name: "Tue Oct 20 · Easy run · 6.2 mi · 60 min" });
    await expect(first).toBeVisible();
    const effort = first.getByRole("slider", { name: "How hard did it feel?" });
    const feel = first.getByRole("slider", { name: "How did it go?" });
    await expect(effort).toBeVisible();
    await expect(feel).toBeVisible();
    await expect(first.getByText("Very easy")).toBeVisible();
    await expect(first.getByText("All-out")).toBeVisible();
    await expect(first.getByText("Rough")).toBeVisible();
    await expect(first.getByText("Great")).toBeVisible();
    // Nothing is answered until the athlete answers.
    await expect(first.getByText("Slide to answer")).toHaveCount(2);

    await next(page).click();
    await expect(page.getByText("2 of 8", { exact: true })).toBeVisible();
    const second = page.getByRole("region", { name: "Thu Oct 22 · Easy run · 3.1 mi · 30 min" });
    // This run has an effort from the watch.
    await expect(second.getByRole("slider", { name: "How hard did it feel?" })).toHaveValue("6");
    await expect(second.getByText("6 of 10")).toBeVisible();
    await expect(second.getByText("Filled in from your watch")).toBeVisible();
  });

  test("the weekly questions are plain words with the right control, and the API's descriptions never appear", async ({ page }) => {
    await serveCheckIn(page);
    await page.goto("/check-in");
    await next(page).click();
    await next(page).click();

    await expect(page.getByText("3 of 8", { exact: true })).toBeVisible();
    await expect(page.getByText("On average, how many hours a night did you sleep this week?")).toBeVisible();
    await expect(page.getByRole("button", { name: "More hours" })).toBeVisible();
    await next(page).click();
    await expect(page.getByText("How stressed were you this week?")).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Stress this week" }).getByRole("radio")).toHaveText([
      "Very low", "Low", "Moderate", "High", "Very high",
    ]);
    await next(page).click();
    await expect(page.getByText("Strength, rehab or cross-training sessions this week?")).toBeVisible();
    await expect(page.getByRole("button", { name: "More sessions" })).toBeVisible();
    await expect(page.getByRole("button", { name: "More planned" })).toBeVisible();
    await expect(page.getByLabel("What you did, like swimming, cycling or physio exercises")).toBeVisible();
    await next(page).click();
    await expect(page.getByText("How did your body feel?")).toBeVisible();
    await next(page).click();
    await expect(page.getByText("How are you feeling about next week?")).toBeVisible();
    await next(page).click();
    await expect(page.getByText("Anything else you want Coach Cade to know")).toBeVisible();
    // Finishing happens on the summary, not here.
    await expect(page.getByRole("button", { name: "Finish check-in" })).toHaveCount(0);

    // No range question, and none of the API's own descriptions on any screen.
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/Optional|\[low, high\]|\{ completed|string array|integer 1/i);
    expect(bannedTermsIn(text)).toEqual([]);
  });

  test("only Back and Next are buttons; Skip is quiet", async ({ page }) => {
    await serveCheckIn(page);
    await page.goto("/check-in");
    const form = page.getByRole("form", { name: "Weekly check-in" });
    await expect(form.getByRole("button", { name: "Back" })).toBeDisabled();
    const next = form.getByRole("button", { name: "Next", exact: true });
    // The one filled button is the way forward.
    await expect(next).toHaveClass(/bg-volt/);
    await expect(form.getByRole("button", { name: "Skip", exact: true })).not.toHaveClass(/bg-volt/);
    await expect(form.getByRole("button", { name: "Back" })).not.toHaveClass(/bg-volt/);
  });

  test("answers are saved in the shape the coach reads, and the check-in posts nothing to the conversation", async ({ page }) => {
    const saved = await serveCheckIn(page);
    const posted: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && /\/api\/thread\/messages$/.test(r.url())) posted.push(r.url());
    });
    await page.goto("/check-in");

    // Run 1: effort 7, feel 8, pain.
    const first = page.getByRole("region", { name: /Tue Oct 20/ });
    await first.getByRole("slider", { name: "How hard did it feel?" }).fill("7");
    await first.getByRole("slider", { name: "How did it go?" }).fill("8");
    await first.getByRole("textbox").fill("Tight left calf");
    await next(page).click();
    // Run 2: keep the watch's effort of 6, add nothing.
    await next(page).click();

    // Sleep: 7.0 on the first press, then up one step.
    await page.getByRole("button", { name: "More hours" }).click();
    await page.getByRole("button", { name: "More hours" }).click();
    await expect(page.getByText("7.5 hours")).toBeVisible();
    await next(page).click();
    await page.getByRole("radio", { name: "High", exact: true }).click();
    await next(page).click();
    await page.getByRole("button", { name: "More sessions" }).click();
    await page.getByRole("button", { name: "More sessions" }).click();
    await expect(page.getByRole("group", { name: "Sessions you did" })).toContainText("2 sessions");
    for (let i = 0; i < 3; i += 1) await page.getByRole("button", { name: "More planned" }).click();
    await expect(page.getByRole("group", { name: "Sessions you planned" })).toContainText("3 sessions");
    await page
      .getByLabel("What you did, like swimming, cycling or physio exercises")
      .fill("One swim, one physio session");
    await next(page).click();
    await page.getByLabel("How your body felt").fill("Legs heavy midweek.");
    await next(page).click();
    await page.getByLabel("How you feel about next week").fill("Rested and keen.");
    await next(page).click();
    await page.getByLabel("Anything else for Coach Cade").fill("Can I move Thursday?\nAlso, what about shoes?");
    await next(page).click();
    await expect(page.getByText("Here’s what you’re sending Coach Cade.")).toBeVisible();
    await expect(page.getByLabel("Your answers")).toContainText("2 of 3 planned · One swim, one physio session");
    await page.getByRole("button", { name: "Finish check-in" }).click();

    await expect.poll(() => saved.length).toBe(1);
    expect(saved[0]).toEqual({
      week: "2026-W43",
      runs: [
        { date: "2026-10-20", rpe: 7, felt: 8, pain: "Tight left calf" },
        { date: "2026-10-22", rpe: 6 },
      ],
      weekly: {
        sleep_avg_hrs: 7.5,
        stress_level: "High",
        strength_sessions: { completed: 2, planned: 3, notes: "One swim, one physio session" },
        body_check: "Legs heavy midweek.",
        feeling_into_next_week: "Rested and keen.",
        // One entry, not one per line.
        questions_for_coach: ["Can I move Thursday?\nAlso, what about shoes?"],
      },
    });
    expect(posted).toEqual([]);
    await expect(page).toHaveURL(/\/review/);

    // Your week's check-in card shows the strength answer as it was given.
    const card = page.getByRole("region", { name: "Your week", exact: true });
    await expect(card.getByRole("heading", { name: "Your check-in" })).toBeVisible();
    await expect(card.getByRole("term").filter({ hasText: "Strength, rehab or cross-training" })).toHaveCount(1);
    await expect(card).toContainText("2 of 3 planned · One swim, one physio session");
  });

  test("without a return goal, pain is the line of words only", async ({ page }) => {
    await serveCheckIn(page, { goalKind: "race" });
    await page.goto("/check-in");
    const first = page.getByRole("region", { name: /Tue Oct 20/ });
    await expect(first.getByRole("slider")).toHaveCount(2);
    await expect(first.getByRole("slider", { name: "How much did it hurt?" })).toHaveCount(0);
    await expect(first.getByRole("textbox")).toBeVisible();
  });

  test("a return goal asks for pain from 0 to 10, and Your week shows the highest with its day", async ({ page }) => {
    const saved = await serveCheckIn(page, { goalKind: "return" });
    await page.goto("/check-in");

    // Tue: no pain at all, which is an answer, not a blank.
    const first = page.getByRole("region", { name: /Tue Oct 20/ });
    const tuePain = first.getByRole("slider", { name: "How much did it hurt?" });
    await expect(tuePain).toHaveAttribute("min", "0");
    await tuePain.fill("0");
    await expect(first).toContainText("0 of 10");
    await next(page).click();
    // Thu: 3 of 10 with words.
    const second = page.getByRole("region", { name: /Thu Oct 22/ });
    await second.getByRole("slider", { name: "How much did it hurt?" }).fill("3");
    await second.getByRole("textbox").fill("Achilles stiff at the start");
    await next(page).click();
    for (let i = 0; i < 6; i += 1) await page.getByRole("button", { name: "Skip", exact: true }).click();

    await expect(page.getByLabel("Your answers")).toContainText("Pain 3 of 10 (Achilles stiff at the start)");
    await page.getByRole("button", { name: "Finish check-in" }).click();
    await expect.poll(() => saved.length).toBe(1);
    expect(saved[0]).toEqual({
      week: "2026-W43",
      runs: [
        { date: "2026-10-20", pain_score: 0 },
        { date: "2026-10-22", rpe: 6, pain_score: 3, pain: "Achilles stiff at the start" },
      ],
    });

    await expect(page).toHaveURL(/\/review/);
    const card = page.getByRole("region", { name: "Your week", exact: true });
    await expect(card.getByRole("heading", { name: "Your check-in" })).toBeVisible();
    await expect(card.getByRole("term").filter({ hasText: /^Pain$/ })).toHaveCount(1);
    await expect(card).toContainText("Highest 3/10 (Thu)");
  });

  test("a strength answer with only the number done reaches Your week", async ({ page }) => {
    const saved = await serveCheckIn(page);
    await page.goto("/check-in");
    for (let i = 0; i < 4; i += 1) await page.getByRole("button", { name: "Skip", exact: true }).click();
    // Strength: the number done, nothing else.
    await page.getByRole("button", { name: "More sessions" }).click();
    await page.getByRole("button", { name: "More sessions" }).click();
    for (let i = 0; i < 4; i += 1) await next(page).click();
    await page.getByRole("button", { name: "Finish check-in" }).click();

    await expect.poll(() => saved.length).toBe(1);
    expect((saved[0] as { weekly: unknown }).weekly).toEqual({ strength_sessions: { completed: 2 } });
    await expect(page).toHaveURL(/\/review/);
    const card = page.getByRole("region", { name: "Your week", exact: true });
    await expect(card.getByRole("term").filter({ hasText: "Strength, rehab or cross-training" })).toHaveCount(1);
    await expect(card).toContainText("2 sessions");
  });

  test("skipping every question saves only the watch's effort", async ({ page }) => {
    const saved = await serveCheckIn(page);
    await page.goto("/check-in");
    for (let i = 0; i < 8; i += 1) {
      await page.getByRole("button", { name: "Skip", exact: true }).click();
    }
    await page.getByRole("button", { name: "Finish check-in" }).click();
    await expect.poll(() => saved.length).toBe(1);
    expect(saved[0]).toEqual({ week: "2026-W43", runs: [{ date: "2026-10-22", rpe: 6 }] });
  });

  test("Back keeps what was answered", async ({ page }) => {
    await serveCheckIn(page);
    await page.goto("/check-in");
    const first = page.getByRole("region", { name: /Tue Oct 20/ });
    await first.getByRole("slider", { name: "How hard did it feel?" }).fill("4");
    await first.getByRole("textbox").fill("None really");
    await next(page).click();
    await page.getByRole("button", { name: "Back" }).click();
    await expect(first.getByRole("slider", { name: "How hard did it feel?" })).toHaveValue("4");
    await expect(first.getByText("4 of 10")).toBeVisible();
    await expect(first.getByRole("textbox")).toHaveValue("None really");
  });

  test("a summary comes before Finish; each answer can be changed from it", async ({ page }) => {
    const saved = await serveCheckIn(page);
    await page.goto("/check-in");

    const first = page.getByRole("region", { name: /Tue Oct 20/ });
    await first.getByRole("slider", { name: "How hard did it feel?" }).fill("7");
    await next(page).click();
    await next(page).click();
    await page.getByRole("button", { name: "More hours" }).click();
    for (let i = 0; i < 6; i += 1) await next(page).click();
    // Past the last question, the summary: every question, answered or left blank.
    await expect(page.getByText("Here’s what you’re sending Coach Cade.")).toBeVisible();
    const list = page.getByLabel("Your answers");
    await expect(list.locator("dt")).toHaveCount(8);
    await expect(list).toContainText("Effort 7 of 10");
    await expect(list).toContainText("Effort 6 of 10 from your watch");
    await expect(list).toContainText("7.0 hours a night");
    await expect(list).toContainText("Left blank");

    // Change one answer; Next brings you straight back to the summary.
    await page.getByRole("button", { name: "Change Stress" }).click();
    await expect(page.getByText("How stressed were you this week?")).toBeVisible();
    await page.getByRole("radio", { name: "Low", exact: true }).click();
    await next(page).click();
    await expect(page.getByText("Here’s what you’re sending Coach Cade.")).toBeVisible();
    await expect(list).toContainText("Low");
    expect(saved).toHaveLength(0);

    await page.getByRole("button", { name: "Finish check-in" }).click();
    await expect.poll(() => saved.length).toBe(1);
    expect((saved[0] as { weekly: { stress_level: string } }).weekly.stress_level).toBe("Low");
  });

  test("Back from the summary returns to the last question", async ({ page }) => {
    await serveCheckIn(page);
    await page.goto("/check-in");
    for (let i = 0; i < 8; i += 1) await next(page).click();
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByText("8 of 8", { exact: true })).toBeVisible();
    await expect(page.getByText("Anything else you want Coach Cade to know")).toBeVisible();
  });

  test("skipping the whole check-in asks first, from the first screen", async ({ page }) => {
    const served = await serveCheckIn(page);
    await page.goto("/check-in");
    await expect(page.getByText("1 of 8", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Skip the whole check-in" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Skip the whole check-in?" });
    await expect(confirm).toContainText("without your answers");
    await confirm.getByRole("button", { name: "Keep going" }).click();
    await expect(confirm).toHaveCount(0);
    expect(served.skips).toHaveLength(0);

    await page.getByRole("button", { name: "Skip the whole check-in" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Skip it" }).click();
    await expect.poll(() => served.skips.length).toBe(1);
    await expect(page).toHaveURL(/\/review/);
  });

  test("before Saturday it says when the check-in opens and shows no questions", async ({ page }) => {
    await serveCheckIn(page);
    await serveToday(page, 2); // Wednesday
    await page.goto("/check-in");

    await expect(page.getByText("Your check-in opens on Sat Oct 24.")).toBeVisible();
    await expect(page.getByRole("slider")).toHaveCount(0);
    await expect(page.getByRole("form", { name: "Weekly check-in" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Next", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Back to Home" })).toHaveAttribute("href", "/");
  });

  test("on Friday it is still closed, and on Saturday it opens", async ({ page }) => {
    await serveCheckIn(page);
    await serveToday(page, 4); // Friday
    await page.goto("/check-in");
    await expect(page.getByText("Your check-in opens on Sat Oct 24.")).toBeVisible();

    await page.unroute(/\/api\/home$/);
    await serveToday(page, 5); // Saturday
    await page.reload();
    await expect(page.getByText("1 of 8", { exact: true })).toBeVisible();
    await expect(page.getByText("Your check-in opens")).toHaveCount(0);
  });

  test("the Plan page no longer links to the check-in", async ({ page }) => {
    await page.goto("/plan");
    await expect(page.getByRole("heading", { name: "Plan", level: 1 })).toBeVisible();
    await expect(page.locator('main a[href="/check-in"]')).toHaveCount(0);
  });
});

import { expect, test, type Page } from "@playwright/test";
import { bannedTermsIn } from "./banned";

// The first answers can be given once per database, and first-run.spec.ts does that for real.
// This spec serves the questions, so the form can be checked on its own and as often as needed.
const NEEDS_ONBOARDING = {
  status: "needs_onboarding",
  note: "Collect onboarding answers.",
  questionnaire: {
    order: ["goal", "schedule", "injuries_constraints", "preferences"],
    // The API's own wording, which the page must never show.
    fields: {
      goal: "What is your primary goal (race, distance, or general fitness)?",
      schedule: "Which days can you run, and which is your long run?",
      injuries_constraints: "Any injuries, constraints, or things the coach should avoid?",
      preferences: "Any preferences (terrain, time of day, gear)?",
    },
    all_fields_optional: false,
    required: ["goal", "schedule"],
  },
  prefills: { available: false },
};

async function serveQuestions(page: Page) {
  const saved: { answers: Record<string, string>; goal?: Record<string, string> }[] = [];
  await page.route(/\/api\/onboarding$/, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(NEEDS_ONBOARDING) }),
  );
  await page.route(/\/api\/thread\/messages$/, (route) =>
    route.fulfill({ status: 201, contentType: "application/json", body: "{}" }),
  );
  await page.route(/\/api\/onboarding\/answers$/, (route) => {
    saved.push(route.request().postDataJSON());
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        status: "ready",
        answers: route.request().postDataJSON().answers,
        gate: { status: "ready", note: "", answers: {}, questionnaire: NEEDS_ONBOARDING.questionnaire, prefills: { available: false } },
        proposal: { id: 1 },
      }),
    });
  });
  return saved;
}

const next = (page: Page) => page.getByRole("button", { name: "Next", exact: true });

test.describe("onboarding", () => {
  test("a welcome screen says what is coming, with one way forward", async ({ page }) => {
    await serveQuestions(page);
    await page.goto("/onboarding");

    await expect(page.getByRole("heading", { name: "Let Coach Cade get to know you", level: 1 })).toBeVisible();
    await expect(page.getByText("Five short questions")).toBeVisible();
    await expect(page.getByText("Which days you’re free to run")).toBeVisible();
    await expect(page.locator("main").getByRole("button")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(0);

    // The log is not connected here, so the page does not claim to see anything.
    await expect(page.getByText("Coach Cade can already see")).toHaveCount(0);

    await page.getByRole("button", { name: "Start" }).click();
    await expect(page.getByText("1 of 5", { exact: true })).toBeVisible();
  });

  test("when your running log is connected, one sentence says so instead of a list of hints", async ({ page }) => {
    await page.route(/\/api\/onboarding$/, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ...NEEDS_ONBOARDING,
          prefills: {
            available: true,
            unitPreference: "imperial",
            heartRateZones: { calculationMethod: "x", zones: [{ zoneNumber: 2, minBpm: 120, maxBpm: 140 }] },
            shoes: [{ id: "s1", brand: "ASICS", model: "Nimbus 28", isRetired: false }],
            recentTraining: [{ id: "r1", startedAt: "2026-10-20T12:00:00Z", name: null, distanceM: 10000, durationS: 3600, runType: "Easy Run" }],
          },
        }),
      }),
    );
    await page.goto("/onboarding");
    await expect(
      page.getByText("Coach Cade can already see your recent runs and shoes from your running log"),
    ).toBeVisible();

    await page.getByRole("button", { name: "Start" }).click();
    await page.getByRole("radio", { name: "General fitness" }).click();
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/HR Z2|Nimbus|bpm|from Tempo|Recent training/);
  });

  test("a second visit after answering goes on to the summary instead of asking again", async ({ page }) => {
    await page.route(/\/api\/onboarding$/, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          status: "ready",
          note: "",
          answers: { goal: "x", schedule: "y" },
          questionnaire: NEEDS_ONBOARDING.questionnaire,
          prefills: { available: false },
          createdAt: "2026-10-25T12:00:00Z",
          updatedAt: "2026-10-25T12:00:00Z",
        }),
      }),
    );
    await page.goto("/onboarding");
    await expect(page).toHaveURL(/\/dossier/);
    await expect(page.getByText("Answers saved")).toHaveCount(0);
  });

  test("every question is a field, not a paragraph, and the API's wording never shows", async ({ page }) => {
    await serveQuestions(page);
    await page.goto("/onboarding");
    await page.getByRole("button", { name: "Start" }).click();

    // 1: goal. A race asks for a name and a date picker; general fitness asks for nothing more.
    await expect(page.getByText("What are you training for?")).toBeVisible();
    await expect(page.getByLabel("Which race?")).toHaveCount(0);
    await page.getByRole("radio", { name: "A race" }).click();
    await expect(page.getByLabel("Which race?")).toBeVisible();
    await expect(page.getByLabel("Race date")).toHaveAttribute("type", "date");
    await page.getByRole("radio", { name: "General fitness" }).click();
    await expect(page.getByLabel("Which race?")).toHaveCount(0);
    await expect(page.getByText("Required.")).toBeVisible();
    await next(page).click();

    // 2: run days as weekday chips, then a long-run day among them.
    await expect(page.getByText("2 of 5", { exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: "Days you’re free to run" }).getByRole("checkbox")).toHaveText([
      "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun",
    ]);
    await expect(page.getByText("Pick your free days first.")).toBeVisible();
    await page.getByRole("checkbox", { name: "Tue" }).click();
    await page.getByRole("checkbox", { name: "Sun" }).click();
    await expect(page.getByRole("radiogroup", { name: "Long run day" }).getByRole("radio")).toHaveText(["Tue", "Sun"]);
    await page.getByRole("radio", { name: "Sun" }).click();
    // Dropping the long-run day from the run days clears it.
    await page.getByRole("checkbox", { name: "Sun" }).click();
    await expect(page.getByRole("radiogroup", { name: "Long run day" }).getByRole("radio", { checked: true })).toHaveCount(0);
    await next(page).click();

    // 3: hours, optional, stepped.
    await expect(page.getByText("At most, about how many hours a week can you give to training?")).toBeVisible();
    await expect(page.getByText("Optional. You can leave this blank.")).toBeVisible();
    await expect(page.getByText("Not answered")).toBeVisible();
    await page.getByRole("button", { name: "More hours" }).click();
    await expect(page.getByText("4 hours")).toBeVisible();
    await next(page).click();

    // 4 and 5: text, optional.
    await expect(page.getByLabel("Injuries and limits")).toBeVisible();
    await next(page).click();
    await expect(page.getByLabel("Anything else for Coach Cade")).toBeVisible();
    await expect(page.getByRole("button", { name: "Finish" })).toBeVisible();

    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/primary goal|race, distance|constraints|terrain, time of day/i);
    expect(bannedTermsIn(text)).toEqual([]);
  });

  test("Next waits for the two required answers and says why", async ({ page }) => {
    await serveQuestions(page);
    await page.goto("/onboarding");
    await page.getByRole("button", { name: "Start" }).click();

    await next(page).click();
    await expect(page.locator("main").getByRole("alert")).toHaveText("Choose one to continue.");
    await expect(page.getByText("1 of 5", { exact: true })).toBeVisible();

    await page.getByRole("radio", { name: "A race" }).click();
    await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
    await next(page).click();
    await expect(page.locator("main").getByRole("alert")).toHaveText("Tell Coach Cade which race it is.");

    await page.getByLabel("Which race?").fill("10k");
    await next(page).click();
    await next(page).click();
    await expect(page.locator("main").getByRole("alert")).toHaveText("Choose at least one day to continue.");
    await expect(page.getByText("2 of 5", { exact: true })).toBeVisible();
  });

  test("only Back and Next move through the questions, and Back keeps answers", async ({ page }) => {
    await serveQuestions(page);
    await page.goto("/onboarding");
    await page.getByRole("button", { name: "Start" }).click();
    await page.getByRole("radio", { name: "A race" }).click();
    await page.getByLabel("Which race?").fill("10k");
    await next(page).click();

    const form = page.getByRole("form", { name: "A few questions for Coach Cade" });
    await expect(form.getByRole("button", { name: "Back" })).toBeEnabled();
    await expect(form.getByRole("button", { name: /Skip/ })).toHaveCount(0);

    await form.getByRole("button", { name: "Back" }).click();
    await expect(page.getByLabel("Which race?")).toHaveValue("10k");
    await expect(page.getByRole("radio", { name: "A race" })).toHaveAttribute("aria-checked", "true");
  });

  test("general fitness with two run days is worded for the coach as the same four answers", async ({ page }) => {
    const saved = await serveQuestions(page);
    await page.goto("/onboarding");
    await page.getByRole("button", { name: "Start" }).click();
    await page.getByRole("radio", { name: "General fitness" }).click();
    await next(page).click();
    await page.getByRole("checkbox", { name: "Mon" }).click();
    await page.getByRole("checkbox", { name: "Wed" }).click();
    await next(page).click();
    for (let i = 0; i < 2; i += 1) await next(page).click();
    await page.getByLabel("Anything else for Coach Cade").fill("I like trails.");
    await page.getByRole("button", { name: "Finish" }).click();

    await expect.poll(() => saved.length).toBe(1);
    // The goal goes as a record; the API writes the sentence the coach reads.
    expect(saved[0]!.goal).toEqual({ kind: "fitness" });
    expect(saved[0]!.answers).toEqual({
      schedule:
        "Free to run on Mon, Wed. These are the days that work, not a target: the plan decides how many runs to schedule and which of these days to use.",
      preferences: "I like trails.",
    });
  });

  test("run days are availability: ticking all seven says any day works, not run every day", async ({ page }) => {
    const saved = await serveQuestions(page);
    await page.goto("/onboarding");
    await page.getByRole("button", { name: "Start" }).click();
    await page.getByRole("radio", { name: "General fitness" }).click();
    await next(page).click();

    await expect(page.getByText("Your coach decides how many of them to use")).toBeVisible();
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
      await page.getByRole("checkbox", { name: day }).click();
    }
    await page.getByRole("radio", { name: "Sun" }).click();
    await next(page).click();
    await page.getByRole("button", { name: "More hours" }).click();
    await next(page).click();
    await next(page).click();
    await page.getByRole("button", { name: "Finish" }).click();

    await expect.poll(() => saved.length).toBe(1);
    const schedule = saved[0]!.answers.schedule;
    expect(schedule).toBe(
      "Free to run any day of the week. These are the days that work, not a target: the plan decides how many runs to schedule and which of these days to use. Prefers the long run on Sun. Up to about 4 hours a week for training.",
    );
    // Never phrased as an instruction to run on each day.
    expect(schedule).not.toMatch(/^Runs on|run every day/i);
  });
});

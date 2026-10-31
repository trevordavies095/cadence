import { expect, test } from "@playwright/test";

const API_URL = process.env.E2E_API_URL ?? "http://localhost:5102";

// Runs first, on a database with no profile: a new athlete's first answers, from
// the banner to "Looks right".
test.describe("first run", () => {
  test.beforeAll(async ({ request }) => {
    // Connecting the accounts is a technical person's job, done once.
    for (const [path, data] of [
      ["/settings/tempo", { baseUrl: "http://localhost:5001", apiKey: "tmp_e2e_key" }],
      ["/settings/anthropic", { apiKey: "sk-ant-e2e-key" }],
    ] as const) {
      expect((await request.put(`${API_URL}${path}`, { data })).ok()).toBeTruthy();
    }
  });

  test("answers lead to a summary the athlete can say looks right", async ({ page }) => {
    // 1. Home asks for the first answers.
    await page.goto("/");
    const ask = page.getByRole("status").filter({ hasText: "Coach Cade needs a few answers" });
    await expect(ask).toBeVisible();
    await ask.getByRole("link", { name: "Start" }).click();
    await expect(page).toHaveURL(/\/onboarding/);

    // 2. A welcome screen, then fields instead of paragraphs. The goal and the run days are
    //    required; the rest can be left blank.
    // Your running log is connected, so one sentence says there is no need to retype it.
    await expect(page.getByText("Coach Cade can already see your recent runs and shoes")).toBeVisible();
    await page.getByRole("button", { name: "Start" }).click();
    await page.getByRole("radio", { name: "A race" }).click();
    // The raw hints from your running log are not dumped on the questions.
    await expect(page.getByText(/HR Z2|from Tempo|Recent training|Tempo hints/)).toHaveCount(0);
    await page.getByLabel("Which race?").fill("Half marathon");
    await page.getByLabel("Race date").fill("2027-01-16");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    for (const day of ["Tue", "Thu", "Sat"]) {
      await page.getByRole("checkbox", { name: day }).click();
    }
    await page.getByRole("radio", { name: "Sat" }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("button", { name: "More hours" }).click();
    await page.getByRole("button", { name: "More hours" }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByLabel("Injuries and limits").fill("Tight left calf.");
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // The goal goes as a record; the API writes the sentence the coach reads, so the coach
    // still gets the same four answers as before.
    const schedule =
      "Free to run on Tue, Thu, Sat. These are the days that work, not a target: the plan decides how many runs to schedule and which of these days to use. Prefers the long run on Sat. Up to about 5 hours a week for training.";
    const saving = page.waitForResponse((r) => r.url().endsWith("/api/onboarding/answers"));
    await page.getByRole("button", { name: "Finish" }).click();
    const saved = await saving;
    const sent = saved.request().postDataJSON();
    expect(sent.answers).toEqual({ schedule, injuries_constraints: "Tight left calf." });
    expect(sent.goal).toEqual({
      kind: "race",
      distance: "other",
      raceName: "Half marathon",
      raceDate: "2027-01-16",
    });
    expect((await saved.json()).answers).toEqual({
      goal: "Race: Half marathon on Sat Jan 16 2027.",
      schedule,
      injuries_constraints: "Tight left calf.",
    });

    // Finishing lands straight on what the coach understood: no "saved" stop in between.
    await expect(page).toHaveURL(/\/dossier/);
    await expect(page.getByText("Answers saved")).toHaveCount(0);
    await expect(
      page.locator('[aria-label="Here’s what Coach Cade understood"]'),
    ).toContainText("Half marathon");
    // Nothing is written into the conversation in the athlete's name.
    const thread = await (await page.request.get("/api/thread")).json();
    expect(thread.messages.filter((m: { role: string }) => m.role === "athlete")).toEqual([]);

    // 3. Home points at what the coach understood, not at the questions again.
    await page.goto("/");
    const review = page
      .getByRole("status")
      .filter({ hasText: "Here’s what Coach Cade understood" });
    await expect(review).toBeVisible();
    await expect(page.getByText("Coach Cade needs a few answers")).toHaveCount(0);
    await review.getByRole("link", { name: "Have a look" }).click();

    // 4. A short summary with two choices: no diff and no document to edit.
    await expect(page).toHaveURL(/\/dossier/);
    await expect(page.getByRole("heading", { name: "About you", level: 1 })).toBeVisible();
    const card = page.getByRole("region", { name: "Here’s what Coach Cade understood" })
      .or(page.locator('[aria-label="Here’s what Coach Cade understood"]'));
    await expect(card).toContainText("Half marathon");
    await expect(card.getByRole("button", { name: "Looks right" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Fix something" })).toBeVisible();
    await expect(page.getByText("Proposed notes")).toHaveCount(0);
    await expect(page.getByLabel("The full text Coach Cade reads")).toHaveCount(0);

    // 4b. One volt per page: while the note waits, it is the one thing to do on Coach Cade too.
    await page.goto("/chat");
    const chatNote = page.locator('[aria-label="Here’s what Coach Cade understood"]');
    const looksRight = chatNote.getByRole("button", { name: "Looks right" });
    await expect(looksRight).toBeVisible();
    const background = (el: Element) => getComputedStyle(el).backgroundColor;
    const send = page.getByRole("button", { name: "Send", exact: true });
    expect(await send.evaluate(background)).not.toBe(await looksRight.evaluate(background));
    // Opening the fix form makes its Send the action, so Looks right steps back.
    await chatNote.getByRole("button", { name: "Fix something" }).click();
    expect(await looksRight.evaluate(background)).toBe(
      await chatNote.getByRole("button", { name: "Fix something" }).evaluate(background),
    );
    await page.goto("/dossier");

    // 5. Looks right installs the profile and the banner goes away.
    await card.getByRole("button", { name: "Looks right" }).click();
    // The draft is no longer waiting: it is now what the coach knows, and it is listed.
    await expect(page.getByRole("region", { name: "Waiting for you" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Changes" })).toContainText("Your first answers");
    await page.reload();
    await expect(page.getByRole("region", { name: "What Coach Cade knows" })).toBeVisible();
    await expect(page.getByText("Half marathon").first()).toBeVisible();

    await page.goto("/");
    await expect(page.getByText("Here’s what Coach Cade understood")).toHaveCount(0);
    await expect(page.getByText("Coach Cade needs a few answers")).toHaveCount(0);
    // The loop carries on: on the pinned Sunday that means the weekly check-in.
    await expect(page.getByRole("status").filter({ hasText: "Time for your weekly check-in" })).toBeVisible();

    // Back at the questions, there is nothing left to ask.
    await page.goto("/onboarding");
    await expect(page).toHaveURL(/\/(dossier)?$|\/$/);
    await expect(page.getByRole("button", { name: "Start" })).toHaveCount(0);
  });

  test("the text Coach Cade reads is tucked away until asked for", async ({ page }) => {
    await page.goto("/dossier");
    const editor = page.getByLabel("The full text Coach Cade reads");
    await expect(editor).toBeHidden();
    // The coach's own instructions are never shown among the sections.
    // Exact: a plain substring match is case-blind and also finds words that merely contain it.
    await expect(page.getByText("Stance", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Stance" })).toHaveCount(0);

    await page.getByText("Advanced", { exact: true }).click();
    await expect(editor).toBeVisible();
    await expect(page.getByText("skip Coach Cade")).toBeVisible();
  });

  test("a correction fixes a first draft that was still waiting", async ({ page, request }) => {
    // A second athlete-in-progress is not possible, so check the API rule the card relies on.
    const res = await request.post(`${API_URL}/dossier/corrections`, {
      data: { body: "I can only run Mon Wed Fri." },
    });
    expect(res.status()).toBe(201);
    const { dossierProposal } = await res.json();
    expect(dossierProposal.status).toBe("accepted");
    await page.goto("/dossier");
    await expect(page.getByRole("region", { name: "Changes" })).toContainText("Your correction");
    await expect(page.getByRole("region", { name: "Changes" })).toContainText("I can only run Mon Wed Fri.");
  });
});

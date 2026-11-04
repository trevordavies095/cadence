import { expect, test, type Page } from "@playwright/test";
import { bannedTermsIn } from "./banned";

const ALL = ["low", "medium", "high", "xhigh", "max"];

const MODELS = [
  { id: "claude-opus-4-7", displayName: "Claude Opus 4.7", tested: true, efforts: ALL },
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5", tested: false, efforts: ALL },
  { id: "claude-opus-4-6", displayName: "Claude Opus 4.6", tested: false, efforts: ["low", "medium", "high", "max"] },
];

const TESTED = { model: "claude-opus-4-7", effort: "xhigh" };

function view(overrides: Record<string, unknown> = {}) {
  return { saved: null, effective: TESTED, tested: TESTED, models: MODELS, fallback: null, ...overrides };
}

/**
 * The e2e stack runs the offline coach, so the live section is reached by telling the page
 * the live coach is in use, and answering the coach model routes here.
 */
async function liveCoach(page: Page, initial: Record<string, unknown>) {
  await page.route("**/api/settings", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, anthropic: { ...body.anthropic, source: "anthropic" } } });
  });
  const requests: Array<{ method: string; body: unknown }> = [];
  let current = initial;
  await page.route("**/api/settings/coach-model", async (route) => {
    const req = route.request();
    requests.push({ method: req.method(), body: req.postDataJSON() });
    if (req.method() === "PUT") {
      const choice = req.postDataJSON() as { model: string; effort: string };
      current = view({ saved: choice, effective: choice });
    } else if (req.method() === "DELETE") {
      current = view();
    }
    await route.fulfill({ json: current });
  });
  return requests;
}

const section = (page: Page) => page.getByRole("region", { name: "Coach model" });
const level = (page: Page, name: string) =>
  section(page).getByRole("radiogroup", { name: "Thinking level" }).getByRole("radio", { name, exact: true });

test.describe("Coach model, in Settings", () => {
  test("with the offline coach there is nothing to choose", async ({ page }) => {
    await page.goto("/settings");
    await expect(section(page)).toContainText("In use: the offline coach, so there is no model to choose.");
    await expect(section(page).getByLabel("Model")).toHaveCount(0);
    expect(bannedTermsIn(await section(page).innerText())).toEqual([]);
  });

  test("choose a model, see the level follow it, save, and reset", async ({ page }) => {
    const requests = await liveCoach(page, view());
    await page.goto("/settings");
    const s = section(page);

    await expect(s).toContainText("Cadence was built and tested on Claude Opus 4.7 at Extra high.");
    await expect(s).toContainText("Max can take several minutes.");
    await expect(s.getByLabel("Model").locator("option")).toHaveText([
      "Claude Opus 4.7 · tested",
      "Claude Opus 5.5",
      "Claude Opus 4.6",
    ]);
    await expect(level(page, "Extra high")).toHaveAttribute("aria-checked", "true");
    await expect(s.getByRole("button", { name: "Save model" })).toBeDisabled();
    await expect(s.getByRole("button", { name: "Reset to tested default" })).toHaveCount(0);

    // Opus 4.6 has no Extra high: it can't be chosen, and the level steps down to High.
    await s.getByLabel("Model").selectOption("claude-opus-4-6");
    await expect(level(page, "Extra high")).toBeDisabled();
    await expect(level(page, "High")).toHaveAttribute("aria-checked", "true");
    await expect(s).toContainText("Claude Opus 4.6 can’t think at Extra high, so this is set to High.");

    await s.getByRole("button", { name: "Save model" }).click();
    await expect(s).toContainText("Saved. Coach Cade uses Claude Opus 4.6 at High from the next reply.");
    expect(requests.find((r) => r.method === "PUT")?.body).toEqual({ model: "claude-opus-4-6", effort: "high" });

    await s.getByRole("button", { name: "Reset to tested default" }).click();
    await expect(s).toContainText("Back to the tested default.");
    expect(requests.at(-1)?.method).toBe("DELETE");
    await expect(s.getByLabel("Model")).toHaveValue("claude-opus-4-7");
    await expect(level(page, "Extra high")).toHaveAttribute("aria-checked", "true");
    await expect(s.getByRole("button", { name: "Reset to tested default" })).toHaveCount(0);
    expect(bannedTermsIn(await s.innerText())).toEqual([]);
  });

  test("says why the list is short", async ({ page }) => {
    const short = [MODELS[0]];
    await liveCoach(page, view({ models: short, fallback: "no_key" }));
    await page.goto("/settings");
    await expect(section(page)).toContainText("Save your Anthropic key to see other models.");

    await page.unroute("**/api/settings/coach-model");
    await page.route("**/api/settings/coach-model", (route) =>
      route.fulfill({ json: view({ models: short, fallback: "unavailable" }) }),
    );
    await page.reload();
    await expect(section(page)).toContainText("Couldn’t load the models your key can use");
  });

  test("a refused save says so and keeps the choice", async ({ page }) => {
    await liveCoach(page, view());
    await page.route("**/api/settings/coach-model", (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({ status: 400, json: { error: "unknown_model" } })
        : route.fallback(),
    );
    await page.goto("/settings");
    const s = section(page);
    await s.getByLabel("Model").selectOption("claude-opus-5-5");
    await level(page, "Medium").click();
    await s.getByRole("button", { name: "Save model" }).click();

    await expect(s).toContainText("That model isn’t available with your key. Choose another one.");
    await expect(s.getByLabel("Model")).toHaveValue("claude-opus-5-5");
    await expect(level(page, "Medium")).toHaveAttribute("aria-checked", "true");
  });
});

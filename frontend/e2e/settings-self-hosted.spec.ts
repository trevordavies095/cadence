import { expect, test, type Page } from "@playwright/test";
import { bannedTermsIn } from "./banned";

const ALL = ["low", "medium", "high", "xhigh", "max"];

const ANTHROPIC_MODELS = [
  { id: "claude-opus-4-7", displayName: "Claude Opus 4.7", tested: true, efforts: ALL },
  { id: "claude-opus-4-6", displayName: "Claude Opus 4.6", tested: false, efforts: ["low", "medium", "high", "max"] },
];

/** What an oMLX server lists: plain ids, a `model:profile` id, and a display name. */
const SERVER_MODELS = [
  { id: "qwen3-8b", displayName: "qwen3-8b", tested: false, efforts: ALL },
  { id: "qwen3-8b:thinking", displayName: "qwen3-8b:thinking", tested: false, efforts: ALL },
  { id: "gemma-3-27b", displayName: "Gemma 3 27B", tested: false, efforts: ALL },
];

const TESTED = { model: "claude-opus-4-7", effort: "xhigh" };
const BASE_URL = "http://omlx.local:8000";

type Provider = "anthropic" | "self_hosted";
type Saved = { provider: Provider; model: string; effort: string } | null;
type Connection = {
  configured: boolean;
  baseUrl: string | null;
  keyConfigured: boolean;
  maskedKey: string | null;
  updatedAt: string | null;
};

const NO_CONNECTION: Connection = {
  configured: false,
  baseUrl: null,
  keyConfigured: false,
  maskedKey: null,
  updatedAt: null,
};

const connected = (key: string | null): Connection => ({
  configured: true,
  baseUrl: BASE_URL,
  keyConfigured: key != null,
  maskedKey: key ? `••••${key.slice(-4)}` : null,
  updatedAt: "2026-11-01T12:00:00.000Z",
});

type Request = { method: string; url: string; body: unknown };

/**
 * The e2e stack runs the offline coach, so the live section is reached by telling the page
 * the live coach is in use, and answering the coach model and self-hosted routes here
 * the way the API does: the coach model view is for the saved provider, or for the one
 * named by `?provider=`; a self-hosted list needs a saved server.
 */
async function liveCoach(
  page: Page,
  initial: { saved?: Saved; connection?: Connection; listing?: "ok" | "unavailable" } = {},
) {
  let saved: Saved = initial.saved ?? null;
  let connection: Connection = initial.connection ?? NO_CONNECTION;
  const listing = initial.listing ?? "ok";
  const requests: Request[] = [];

  function view(provider: Provider) {
    const mine = saved?.provider === provider ? { model: saved.model, effort: saved.effort } : null;
    const base = { provider, saved: mine, effective: mine ?? TESTED, tested: TESTED };
    if (provider === "anthropic") return { ...base, models: ANTHROPIC_MODELS, fallback: null };
    const savedOnly = mine
      ? [{ id: mine.model, displayName: mine.model, tested: false, efforts: ALL }]
      : [];
    if (!connection.configured) return { ...base, models: savedOnly, fallback: "no_connection" };
    if (listing === "unavailable") return { ...base, models: savedOnly, fallback: "unavailable" };
    return { ...base, models: SERVER_MODELS, fallback: null };
  }

  await page.route("**/api/settings", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, anthropic: { ...body.anthropic, source: "anthropic" } } });
  });

  await page.route(/\/api\/settings\/coach-model(\?.*)?$/, async (route) => {
    const req = route.request();
    const body = req.postDataJSON() as { provider?: Provider; model: string; effort: string } | null;
    requests.push({ method: req.method(), url: req.url(), body });
    if (req.method() === "PUT" && body) {
      saved = { provider: body.provider ?? "anthropic", model: body.model, effort: body.effort };
    } else if (req.method() === "DELETE") {
      saved = null;
    }
    const asked = new URL(req.url()).searchParams.get("provider") as Provider | null;
    await route.fulfill({ json: view(asked ?? saved?.provider ?? "anthropic") });
  });

  await page.route("**/api/settings/self-hosted", async (route) => {
    const req = route.request();
    const body = req.postDataJSON() as { baseUrl: string; apiKey?: string } | null;
    requests.push({ method: req.method(), url: req.url(), body });
    if (req.method() === "PUT" && body) {
      const key =
        body.apiKey === undefined
          ? connection.keyConfigured
            ? connection.maskedKey!.slice(-4)
            : null
          : body.apiKey || null;
      connection = { ...connected(key), baseUrl: body.baseUrl };
    } else if (req.method() === "DELETE") {
      connection = NO_CONNECTION;
    }
    await route.fulfill({ json: connection });
  });

  return requests;
}

const section = (page: Page) => page.getByRole("region", { name: "Coach model" });
const provider = (page: Page, name: string) =>
  section(page).getByRole("radiogroup", { name: "Provider" }).getByRole("radio", { name, exact: true });
const level = (page: Page, name: string) =>
  section(page).getByRole("radiogroup", { name: "Thinking level" }).getByRole("radio", { name, exact: true });
const LEVELS = ["Low", "Medium", "High", "Extra high", "Max"];

const COMPARED =
  "Self-hosted models can coach differently from the tested default. See how each model compared before you choose.";
const REPORT = "https://github.com/trevordavies095/cadence/blob/develop/docs/reports/local-models-2026-11.md";
const MAPPING =
  "Your server may map these levels onto its own, ignore them, or refuse one. If a level is refused, choose another.";

test.describe("Self-hosted model server, in Settings", () => {
  test("with the offline coach there is no provider to choose", async ({ page }) => {
    await page.goto("/settings");
    const s = section(page);
    await expect(s).toContainText("In use: the offline coach, so there is no model to choose.");
    await expect(s.getByRole("radiogroup", { name: "Provider" })).toHaveCount(0);
    await expect(s.getByLabel("Base URL")).toHaveCount(0);
  });

  test("in demo mode there is no provider to choose", async ({ page }) => {
    await page.route("**/api/settings", async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), demo: true } });
    });
    await page.goto("/settings");
    const s = section(page);
    await expect(s).toContainText("This demo uses the offline coach, so there is no model to choose.");
    await expect(s.getByRole("radiogroup", { name: "Provider" })).toHaveCount(0);
    await expect(s.getByLabel("Base URL")).toHaveCount(0);
  });

  test("switch to Self-hosted, save a server, choose one of its models, save, and reset", async ({ page }) => {
    const requests = await liveCoach(page);
    await page.goto("/settings");
    const s = section(page);

    // Anthropic, as in #52.
    await expect(provider(page, "Anthropic")).toHaveAttribute("aria-checked", "true");
    await expect(s).toContainText("Cadence was built and tested on Claude Opus 4.7 at Extra high.");
    await expect(s.getByLabel("Base URL")).toHaveCount(0);

    await provider(page, "Self-hosted").click();
    await expect(provider(page, "Self-hosted")).toHaveAttribute("aria-checked", "true");
    await expect(s.getByLabel("Base URL")).toBeVisible();
    await expect(s.getByLabel("API key")).toBeVisible();
    await expect(s).toContainText("Not configured — your server’s base URL is required.");
    await expect(s).toContainText("Save your server’s address to see its models.");
    await expect(s).toContainText(COMPARED);
    await expect(s).not.toContainText("not been measured");
    const report = s.getByRole("link", { name: "how each model compared" });
    await expect(report).toHaveAttribute("href", REPORT);
    await expect(report).toHaveAttribute("target", "_blank");
    await expect(report).toHaveAttribute("rel", "noopener noreferrer");
    await expect(s).toContainText(MAPPING);
    await expect(s).not.toContainText(/recommended/i);
    expect(bannedTermsIn(await s.innerText())).toEqual([]);
    await expect(s).not.toContainText("Cadence was built and tested on");
    expect(requests.some((r) => r.method === "GET" && r.url.endsWith("/api/settings/coach-model?provider=self_hosted"))).toBe(true);
    // Nothing chosen, every level open, nothing to save yet.
    for (const name of LEVELS) {
      await expect(level(page, name)).toBeEnabled();
      await expect(level(page, name)).toHaveAttribute("aria-checked", "false");
    }
    await expect(s.getByRole("button", { name: "Save model" })).toBeDisabled();
    await expect(s.getByRole("button", { name: "Clear" })).toBeDisabled();

    await s.getByLabel("Base URL").fill(BASE_URL);
    await s.getByLabel("API key").fill("omlx-local-key-ab12");
    await s.getByRole("button", { name: "Save server" }).click();
    await expect(s).toContainText("Model server saved.");
    await expect(s).toContainText(`Configured — ${BASE_URL} · key ••••ab12`);
    await expect(s.getByLabel("API key")).toHaveValue("");
    expect(requests.find((r) => r.method === "PUT" && r.url.endsWith("/api/settings/self-hosted"))?.body).toEqual({
      baseUrl: BASE_URL,
      apiKey: "omlx-local-key-ab12",
    });

    // The server's list, as it gave it: a `model:profile` id as-is, no tested marker.
    await expect(s.getByLabel("Model").locator("option")).toHaveText([
      "Choose a model",
      "qwen3-8b",
      "qwen3-8b:thinking",
      "Gemma 3 27B",
    ]);
    await expect(s.getByLabel("Model")).toHaveValue("");
    await expect(s.getByLabel("Model")).not.toContainText("tested");
    await expect(s).not.toContainText("Save your server’s address to see its models.");
    await expect(s.getByRole("button", { name: "Save model" })).toBeDisabled();

    await s.getByLabel("Model").selectOption("qwen3-8b:thinking");
    // A model alone is not enough: a level is needed too.
    await expect(s.getByRole("button", { name: "Save model" })).toBeDisabled();
    await level(page, "High").click();
    await expect(s.getByRole("button", { name: "Save model" })).toBeEnabled();
    await s.getByRole("button", { name: "Save model" }).click();
    await expect(s).toContainText("Saved. Coach Cade uses qwen3-8b:thinking at High from the next reply.");
    const put = requests.filter((r) => r.method === "PUT" && r.url.includes("/api/settings/coach-model"));
    expect(put.map((r) => r.body)).toEqual([{ provider: "self_hosted", model: "qwen3-8b:thinking", effort: "high" }]);
    await expect(provider(page, "Self-hosted")).toHaveAttribute("aria-checked", "true");
    await expect(s.getByRole("button", { name: "Save model" })).toBeDisabled();
    expect(bannedTermsIn(await s.innerText())).toEqual([]);

    await s.getByRole("button", { name: "Reset to tested default" }).click();
    await expect(s).toContainText("Back to the tested default.");
    expect(requests.at(-1)?.method).toBe("DELETE");
    expect(requests.at(-1)?.url).toMatch(/\/api\/settings\/coach-model$/);
    await expect(provider(page, "Anthropic")).toHaveAttribute("aria-checked", "true");
    await expect(s.getByLabel("Base URL")).toHaveCount(0);
    await expect(s.getByLabel("Model")).toHaveValue("claude-opus-4-7");
    await expect(level(page, "Extra high")).toHaveAttribute("aria-checked", "true");
    await expect(s.getByRole("button", { name: "Reset to tested default" })).toHaveCount(0);
  });

  test("a saved key is kept when the key field is left blank, and the server can be cleared", async ({ page }) => {
    const requests = await liveCoach(page, { connection: connected("omlx-local-key-ab12") });
    await page.goto("/settings");
    const s = section(page);
    await provider(page, "Self-hosted").click();
    await expect(s).toContainText(`Configured — ${BASE_URL} · key ••••ab12`);
    await expect(s.getByLabel("Base URL")).toHaveValue(BASE_URL);

    await s.getByLabel("Base URL").fill("http://studio.local:8000");
    await s.getByRole("button", { name: "Save server" }).click();
    await expect(s).toContainText("Configured — http://studio.local:8000 · key ••••ab12");
    expect(requests.find((r) => r.method === "PUT" && r.url.endsWith("/api/settings/self-hosted"))?.body).toEqual({
      baseUrl: "http://studio.local:8000",
    });

    await s.getByRole("button", { name: "Clear" }).click();
    const confirm = s.getByRole("alertdialog", { name: "Remove your model server?" });
    await expect(confirm).toContainText("Coach Cade can’t reply from your server until you add it again.");
    await confirm.getByRole("button", { name: "Remove" }).click();
    await expect(s).toContainText("Model server cleared.");
    await expect(s).toContainText("Not configured — your server’s base URL is required.");
    await expect(s).toContainText("Save your server’s address to see its models.");
    expect(requests.some((r) => r.method === "DELETE" && r.url.endsWith("/api/settings/self-hosted"))).toBe(true);
    expect(bannedTermsIn(await s.innerText())).toEqual([]);
  });

  test("says why the server's list is short", async ({ page }) => {
    const gemma = { provider: "self_hosted" as const, model: "gemma-3-27b", effort: "max" };
    await liveCoach(page, { saved: gemma, connection: connected(null), listing: "unavailable" });
    await page.goto("/settings");
    const s = section(page);
    await expect(provider(page, "Self-hosted")).toHaveAttribute("aria-checked", "true");
    await expect(s).toContainText(`Configured — ${BASE_URL} · no key`);
    await expect(s).toContainText(
      "Couldn’t load the model list from your server. Your saved model is still shown.",
    );
    await expect(s.getByLabel("Model").locator("option")).toHaveText(["gemma-3-27b"]);
    await expect(level(page, "Max")).toHaveAttribute("aria-checked", "true");
    expect(bannedTermsIn(await s.innerText())).toEqual([]);

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await liveCoach(page, { saved: gemma, connection: NO_CONNECTION });
    await page.reload();
    await expect(provider(page, "Self-hosted")).toHaveAttribute("aria-checked", "true");
    await expect(s).toContainText("Save your server’s address to see its models.");
    await expect(s.getByLabel("Model").locator("option")).toHaveText(["gemma-3-27b"]);
    await expect(s.getByRole("button", { name: "Reset to tested default" })).toBeVisible();
    expect(bannedTermsIn(await s.innerText())).toEqual([]);
  });

  test("switching provider resets the choice; Anthropic is saved without a provider", async ({ page }) => {
    const qwen = { provider: "self_hosted" as const, model: "qwen3-8b", effort: "low" };
    const requests = await liveCoach(page, { saved: qwen, connection: connected(null) });
    await page.goto("/settings");
    const s = section(page);
    await expect(provider(page, "Self-hosted")).toHaveAttribute("aria-checked", "true");
    await expect(s.getByLabel("Model")).toHaveValue("qwen3-8b");
    await expect(level(page, "Low")).toHaveAttribute("aria-checked", "true");
    await expect(s.getByRole("button", { name: "Save model" })).toBeDisabled();

    // To Anthropic: the tested default, which is a change from what is saved.
    await provider(page, "Anthropic").click();
    await expect(s.getByLabel("Base URL")).toHaveCount(0);
    await expect(s.getByLabel("Model")).toHaveValue("claude-opus-4-7");
    await expect(level(page, "Extra high")).toHaveAttribute("aria-checked", "true");
    expect(requests.some((r) => r.method === "GET" && r.url.endsWith("/api/settings/coach-model?provider=anthropic"))).toBe(true);
    await expect(s.getByRole("button", { name: "Save model" })).toBeEnabled();

    // Back to Self-hosted: what is saved there.
    await provider(page, "Self-hosted").click();
    await expect(s.getByLabel("Model")).toHaveValue("qwen3-8b");
    await expect(level(page, "Low")).toHaveAttribute("aria-checked", "true");

    await provider(page, "Anthropic").click();
    await expect(s.getByLabel("Model")).toHaveValue("claude-opus-4-7");
    await s.getByLabel("Model").selectOption("claude-opus-4-6");
    await expect(level(page, "High")).toHaveAttribute("aria-checked", "true");
    await s.getByRole("button", { name: "Save model" }).click();
    await expect(s).toContainText("Saved. Coach Cade uses Claude Opus 4.6 at High from the next reply.");
    const put = requests.filter((r) => r.method === "PUT" && r.url.includes("/api/settings/coach-model"));
    expect(put.map((r) => r.body)).toEqual([{ model: "claude-opus-4-6", effort: "high" }]);
    await expect(provider(page, "Anthropic")).toHaveAttribute("aria-checked", "true");

    // Self-hosted again: nothing carries across, so nothing is chosen.
    await provider(page, "Self-hosted").click();
    await expect(s.getByLabel("Model")).toHaveValue("");
    for (const name of LEVELS) await expect(level(page, name)).toHaveAttribute("aria-checked", "false");
    await expect(s.getByRole("button", { name: "Save model" })).toBeDisabled();
  });

  test("a refused self-hosted save says so in words about the server", async ({ page }) => {
    await liveCoach(page, { connection: connected(null) });
    await page.route(/\/api\/settings\/coach-model(\?.*)?$/, (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({ status: 400, json: { error: "unknown_model" } })
        : route.fallback(),
    );
    await page.goto("/settings");
    const s = section(page);
    await provider(page, "Self-hosted").click();
    await s.getByLabel("Model").selectOption("gemma-3-27b");
    await level(page, "Medium").click();
    await s.getByRole("button", { name: "Save model" }).click();
    await expect(s).toContainText("That model isn’t on your server’s list. Choose another one.");
    await expect(s.getByLabel("Model")).toHaveValue("gemma-3-27b");
    await expect(level(page, "Medium")).toHaveAttribute("aria-checked", "true");
  });
});

const SENT = 40_473;
const DOCS = "https://github.com/trevordavies095/cadence/blob/develop/docs/self-hosted.md";
const PROGRESS = "Checking… this can take a minute or two on home hardware.";

type Probe = {
  ok: boolean;
  verdict?: "ok" | "cut";
  sentTokens: number;
  reportedTokens: number | null;
  wordFound: boolean;
  reason?: string;
};
type TestResult = { listing: { ok: boolean; reason?: string }; probe: Probe };

const passed = (reportedTokens: number | null): TestResult => ({
  listing: { ok: true },
  probe: { ok: true, verdict: "ok", sentTokens: SENT, reportedTokens, wordFound: true },
});
const cut = (reportedTokens: number | null): TestResult => ({
  listing: { ok: true },
  probe: { ok: true, verdict: "cut", sentTokens: SENT, reportedTokens, wordFound: false },
});
const unlisted = (reason: string): TestResult => ({
  listing: { ok: false, reason },
  probe: { ok: false, sentTokens: SENT, reportedTokens: null, wordFound: false, reason: "not_run" },
});
const unfinished = (reason: string): TestResult => ({
  listing: { ok: true },
  probe: { ok: false, sentTokens: SENT, reportedTokens: null, wordFound: false, reason },
});

/**
 * Answers Test connection with the given results in turn (the last one repeats). Each
 * answer waits for `release()` when `held` is set, so the progress state can be seen.
 */
async function answerTests(page: Page, results: TestResult[], held = false) {
  const bodies: unknown[] = [];
  let release: () => void = () => {};
  let gate = Promise.resolve();
  const hold = () => {
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  if (held) hold();
  await page.route("**/api/settings/self-hosted/test", async (route) => {
    bodies.push(route.request().postDataJSON());
    const result = results[Math.min(bodies.length - 1, results.length - 1)];
    await gate;
    await route.fulfill({ json: result });
  });
  return {
    bodies,
    release: () => {
      release();
      if (held) hold();
    },
  };
}

const testButton = (page: Page) => section(page).getByRole("button", { name: "Test connection" });
const testResult = (page: Page) => section(page).getByRole("status", { name: "Test connection result" });

test.describe("Test connection, in Settings", () => {
  test("is open only with a saved server and a chosen model, shows progress, then the outcome", async ({ page }) => {
    await liveCoach(page);
    const tests = await answerTests(page, [passed(SENT)], true);
    await page.goto("/settings");
    const s = section(page);
    await provider(page, "Self-hosted").click();
    await expect(testButton(page)).toBeDisabled();

    await s.getByLabel("Base URL").fill(BASE_URL);
    await s.getByRole("button", { name: "Save server" }).click();
    await expect(s).toContainText("Model server saved.");
    // A server alone is not enough: a model is needed too.
    await expect(testButton(page)).toBeDisabled();

    await s.getByLabel("Model").selectOption("qwen3-8b:thinking");
    // Self-hosted need not be saved first.
    await expect(testButton(page)).toBeEnabled();
    await testButton(page).click();
    await expect(testButton(page)).toBeDisabled();
    await expect(testResult(page)).toHaveText(PROGRESS);
    expect(bannedTermsIn(await s.innerText())).toEqual([]);

    tests.release();
    await expect(testResult(page)).toHaveText(`Connected. The full test message arrived (${SENT} of ${SENT} tokens).`);
    await expect(s).not.toContainText(PROGRESS);
    await expect(testButton(page)).toBeEnabled();
    expect(tests.bodies).toEqual([{ model: "qwen3-8b:thinking" }]);
    expect(bannedTermsIn(await s.innerText())).toEqual([]);
  });

  test("says each outcome in plain words", async ({ page }) => {
    await liveCoach(page, { connection: connected(null) });
    const outcomes: Array<{ result: TestResult; text: string }> = [
      { result: passed(SENT), text: `Connected. The full test message arrived (${SENT} of ${SENT} tokens).` },
      { result: passed(null), text: "Connected. The full test message arrived." },
      {
        result: cut(8192),
        text: `Connected, but the test message was cut (8192 of ${SENT} tokens arrived). Raise your server’s context length to at least 64k, then test again. How to set it on your server`,
      },
      {
        result: cut(null),
        text: "Connected, but the test message was cut. Raise your server’s context length to at least 64k, then test again. How to set it on your server",
      },
      { result: unlisted("unreachable"), text: "Couldn’t reach your server: nothing answered at omlx.local:8000." },
      { result: unlisted("unauthorized"), text: "Couldn’t reach your server: the server refused the key." },
      { result: unlisted("http_error"), text: "Couldn’t reach your server: the server answered with an error." },
      { result: unfinished("timeout"), text: "Reached your server, but the test didn’t finish: it took longer than the time limit." },
      { result: unfinished("unauthorized"), text: "Reached your server, but the test didn’t finish: the server refused the key." },
      { result: unfinished("unreachable"), text: "Reached your server, but the test didn’t finish: the connection dropped." },
      { result: unfinished("http_error"), text: "Reached your server, but the test didn’t finish: the server answered with an error." },
      { result: unfinished("invalid_response"), text: "Reached your server, but the test didn’t finish: the server answered with an error." },
    ];
    await answerTests(page, outcomes.map((o) => o.result));
    await page.goto("/settings");
    const s = section(page);
    await provider(page, "Self-hosted").click();
    await s.getByLabel("Model").selectOption("gemma-3-27b");

    for (const { result, text } of outcomes) {
      await testButton(page).click();
      await expect(testResult(page)).toHaveText(text);
      if (result.probe.verdict === "cut") {
        await expect(testResult(page).getByRole("link", { name: "How to set it on your server" })).toHaveAttribute(
          "href",
          DOCS,
        );
      }
      const shown = await s.innerText();
      expect(bannedTermsIn(shown)).toEqual([]);
      expect(shown).not.toMatch(/not_run|unreachable|unauthorized|http_error|invalid_response|timeout/);
    }
  });

  test("the result is cleared when the model or the server changes", async ({ page }) => {
    await liveCoach(page, { connection: connected(null) });
    await answerTests(page, [cut(8192)]);
    await page.goto("/settings");
    const s = section(page);
    await provider(page, "Self-hosted").click();
    await s.getByLabel("Model").selectOption("gemma-3-27b");
    await testButton(page).click();
    await expect(testResult(page)).toContainText("Connected, but the test message was cut");

    // Choosing a level is neither: the result stays.
    await level(page, "High").click();
    await expect(testResult(page)).toContainText("Connected, but the test message was cut");

    await s.getByLabel("Model").selectOption("qwen3-8b");
    await expect(s).not.toContainText("Connected, but the test message was cut");

    await testButton(page).click();
    await expect(testResult(page)).toContainText("Connected, but the test message was cut");
    await s.getByLabel("Base URL").fill("http://studio.local:8000");
    await s.getByRole("button", { name: "Save server" }).click();
    await expect(s).toContainText("Model server saved.");
    await expect(s).not.toContainText("Connected, but the test message was cut");
  });

  test("a refused test says so in words about the server", async ({ page }) => {
    await liveCoach(page, { connection: connected(null) });
    await page.route("**/api/settings/self-hosted/test", (route) =>
      route.fulfill({ status: 400, json: { error: "no_self_hosted_connection" } }),
    );
    await page.goto("/settings");
    const s = section(page);
    await provider(page, "Self-hosted").click();
    await s.getByLabel("Model").selectOption("gemma-3-27b");
    await testButton(page).click();
    await expect(s).toContainText("Save your server’s address first.");
    await expect(s).not.toContainText("no_self_hosted_connection");
    await expect(testButton(page)).toBeEnabled();
  });
});

import { expect, test } from "@playwright/test";
import { bannedTermsIn } from "./banned";

const API_URL = process.env.E2E_API_URL ?? "http://localhost:5102";

test.describe("shell", () => {
  test("pages never show a disclaimer check", async ({ page }) => {
    for (const route of ["/", "/plan", "/chat", "/weeks", "/settings", "/dossier"]) {
      await page.goto(route);
      await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
      await expect(page.getByText("Checking disclaimer")).toHaveCount(0);
    }
  });

  test("with the API stopped it reads as an outage, not as an unaccepted disclaimer", async ({
    page,
  }) => {
    await page.route("**/api/**", (route) => route.abort("connectionrefused"));
    await page.goto("/plan");

    await expect(page.getByRole("heading", { name: "Can’t reach Coach Cade" })).toBeVisible();
    await expect(page).toHaveURL(/\/plan$/);
    await expect(page.getByRole("heading", { name: "Welcome to Cadence" })).toHaveCount(0);

    // Trying again works once the API is back.
    await page.unroute("**/api/**");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("heading", { name: "Can’t reach Coach Cade" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Plan", level: 1 })).toBeVisible();
  });

  test("a server error on the disclaimer check is also an outage", async ({ page }) => {
    await page.route("**/api/disclaimer", (route) =>
      route.fulfill({ status: 500, body: "Internal Server Error" }),
    );
    await page.goto("/weeks");
    await expect(page.getByRole("heading", { name: "Can’t reach Coach Cade" })).toBeVisible();
    await expect(page).toHaveURL(/\/weeks$/);
  });
});

test.describe("Settings", () => {
  test("holds the connections, appearance and privacy, and no longer the sent-to-coach text", async ({
    page,
  }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    for (const name of ["Tempo", "Anthropic", "Appearance", "Privacy"]) {
      await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
    }
    await expect(page.getByText("Last coaching context sent")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Show JSON/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Privacy", exact: true })).toHaveAttribute(
      "href",
      "/privacy",
    );
    await expect(page.getByRole("link", { name: "Product disclaimer" })).toHaveAttribute(
      "href",
      "/disclaimer",
    );
  });

  test("the appearance control switches the page and is remembered", async ({ page }) => {
    await page.goto("/settings");
    const html = page.locator("html");
    const group = page.getByRole("radiogroup", { name: "Appearance" });

    // Dark is where it starts.
    await expect(html).toHaveClass(/\bdark\b/);
    await expect(group.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");

    await group.getByRole("radio", { name: "Light" }).click();
    await expect(html).not.toHaveClass(/\bdark\b/);
    await expect(group.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");

    // Still light after a reload, with the right option marked.
    await page.reload();
    await expect(html).not.toHaveClass(/\bdark\b/);
    await expect(
      page.getByRole("radiogroup", { name: "Appearance" }).getByRole("radio", { name: "Light" }),
    ).toHaveAttribute("aria-checked", "true");

    // System follows the computer.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.getByRole("radio", { name: "System" }).click();
    await expect(html).toHaveClass(/\bdark\b/);
    await page.emulateMedia({ colorScheme: "light" });
    await page.reload();
    await expect(html).not.toHaveClass(/\bdark\b/);

    await page.getByRole("radio", { name: "Dark" }).click();
    await expect(html).toHaveClass(/\bdark\b/);
  });

  test("clearing a connection asks first, and keeping it changes nothing", async ({
    page,
    request,
  }) => {
    await page.goto("/settings");
    const anthropic = page.getByRole("region", { name: "Anthropic connection" });
    await anthropic.getByRole("button", { name: "Clear" }).click();

    const confirm = page.getByRole("alertdialog", { name: "Remove your Anthropic key?" });
    await expect(confirm).toContainText("Coach Cade can’t reply until you add a key again.");
    await confirm.getByRole("button", { name: "Keep it" }).click();
    await expect(confirm).toHaveCount(0);
    expect(((await (await request.get(`${API_URL}/settings`)).json()).anthropic as { configured: boolean }).configured).toBe(true);

    // Confirming does remove it. Put the key back so later specs have a coach.
    await anthropic.getByRole("button", { name: "Clear" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("Anthropic key cleared.")).toBeVisible();
    expect(((await (await request.get(`${API_URL}/settings`)).json()).anthropic as { configured: boolean }).configured).toBe(false);
    expect(
      (await request.put(`${API_URL}/settings/anthropic`, { data: { apiKey: "sk-ant-e2e-key" } })).ok(),
    ).toBeTruthy();
  });
});

test.describe("Privacy", () => {
  test("shows what was last sent to the coach in plain words, with the exact text behind a disclosure", async ({
    page,
    request,
  }) => {
    // A reply from the coach is what leaves something to show.
    const week = (await (await request.post(`${API_URL}/weeks/current`)).json()) as { id: string };
    const sent = await request.post(`${API_URL}/weeks/${week.id}/chat`, {
      data: { body: "Easy week ahead, nothing to report." },
    });
    expect(sent.ok()).toBeTruthy();

    await page.goto("/privacy");
    const section = page.getByRole("region", { name: "What was sent to Coach Cade" });
    await expect(section).toBeVisible();
    await expect(section.getByText("Sent", { exact: true })).toBeVisible();
    await expect(section.getByText("Week", { exact: true })).toBeVisible();
    await expect(section.getByText("It included")).toBeVisible();
    await expect(section).toContainText("Oct 19 – 25");
    await expect(section).toContainText("what Coach Cade knows about you");

    // The summary is words; the JSON is there only when asked for.
    const disclosure = section.locator("details");
    await expect(disclosure.locator("pre")).toBeHidden();
    await disclosure.getByText("Show exactly what was sent").click();
    await expect(disclosure.locator("pre")).toBeVisible();
    expect(await disclosure.locator("pre").innerText()).toContain("{");

    // Nothing in the visible text is engineering vocabulary or a pointer to the old place.
    await disclosure.getByText("Show exactly what was sent").click();
    const text = await page.locator("main").innerText();
    expect(bannedTermsIn(text)).toEqual([]);
    expect(text).not.toMatch(/Last coaching context|Show JSON|inspect the full/i);
  });
});


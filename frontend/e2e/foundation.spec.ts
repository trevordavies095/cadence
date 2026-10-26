import { expect, test } from "@playwright/test";
import { bannedTermsIn } from "./banned";

const API_URL = process.env.E2E_API_URL ?? "http://localhost:5102";

// Routes that sit inside the app layout and therefore carry the header.
const APP_ROUTES = [
  "/",
  "/plan",
  "/chat",
  "/weeks",
  "/dossier",
  "/settings",
  "/check-in",
  "/onboarding",
  "/privacy",
];

test.describe("header and navigation", () => {
  for (const route of APP_ROUTES) {
    test(`${route} shows the header, four nav items and the settings gear`, async ({
      page,
    }) => {
      await page.goto(route);
      await expect(page.getByRole("link", { name: "Cadence" })).toBeVisible();

      const nav = page.getByRole("navigation", { name: "Main" });
      await expect(nav.getByRole("link")).toHaveText([
        "Home",
        "Plan",
        "Coach Cade",
        "History",
      ]);

      const gear = page
        .locator("header")
        .getByRole("link", { name: "Settings" });
      await expect(gear).toBeVisible();
      await expect(gear).toHaveAttribute("href", "/settings");
    });
  }

  test("Notes and Setup are not in the primary nav", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: /notes|setup/i })).toHaveCount(0);
  });

  test("the active nav item is marked on its own route", async ({ page }) => {
    await page.goto("/plan");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: "Plan" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(nav.getByRole("link", { name: "Home" })).not.toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});

test.describe("look", () => {
  test("dark appearance is the default and body text is 16px", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveClass(/dark/);
    const size = await page.evaluate(
      () => getComputedStyle(document.body).fontSize,
    );
    expect(size).toBe("16px");
  });

  for (const route of APP_ROUTES) {
    test(`${route} has no gradients and no text under 13px`, async ({
      page,
    }) => {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      const problems = await page.evaluate(() => {
        const found: string[] = [];
        for (const el of Array.from(document.body.querySelectorAll("*"))) {
          const style = getComputedStyle(el);
          if (style.backgroundImage.includes("gradient")) {
            found.push(`gradient on <${el.tagName.toLowerCase()}>`);
          }
          const hasText = Array.from(el.childNodes).some(
            (n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "",
          );
          if (hasText && parseFloat(style.fontSize) < 13) {
            found.push(
              `${style.fontSize} text in <${el.tagName.toLowerCase()}>: ${(el.textContent ?? "").trim().slice(0, 40)}`,
            );
          }
        }
        return found;
      });
      expect(problems).toEqual([]);
    });
  }
});

test.describe("vocabulary", () => {
  test("the header and nav use none of the banned terms", async ({ page }) => {
    await page.goto("/");
    const chrome = await page.locator("header").innerText();
    expect(bannedTermsIn(chrome)).toEqual([]);
  });

  for (const route of [...APP_ROUTES, "/disclaimer"]) {
    test(`${route} shows none of the banned terms`, async ({ page }) => {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      const text = await page.locator("body").innerText();
      expect(bannedTermsIn(text)).toEqual([]);
    });
  }

  test("a coach reply written by the system shows none of the banned terms", async ({
    page,
    request,
  }) => {
    const week = await (
      await request.post(`${API_URL}/weeks/current`)
    ).json();
    const reply = await request.post(`${API_URL}/weeks/${week.id}/chat`, {
      data: { body: "Felt good on the easy run today." },
    });
    expect(reply.ok()).toBeTruthy();

    await page.goto("/chat");
    await expect(page.getByText("Quick check-in for this week").last()).toBeVisible();
    const text = await page.locator("main").innerText();
    expect(bannedTermsIn(text)).toEqual([]);
    // Messages are labelled You and Coach Cade, not the raw role names.
    await expect(page.getByText("You", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Coach Cade", { exact: true }).first()).toBeVisible();
  });

  test("weeks read as date ranges, never as an ISO week label", async ({
    page,
  }) => {
    for (const route of ["/", "/plan", "/chat", "/weeks"]) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      const text = await page.locator("body").innerText();
      expect(text, route).not.toMatch(/\b\d{4}-W\d{2}\b/);
    }
    await page.goto("/weeks");
    await expect(page.getByText("Oct 19 – 25").first()).toBeVisible();
  });
});

test.describe("errors", () => {
  test("an API error shows a sentence, never raw JSON", async ({ page }) => {
    await page.route("**/api/home", (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "week_archived",
          message: "Mid-week chat is only writable on the current week session.",
        }),
      }),
    );
    await page.goto("/");
    await expect(
      page.getByText("This week has ended. Open this week’s chat to keep talking."),
    ).toBeVisible();
    const text = await page.locator("body").innerText();
    expect(text).not.toContain("week_archived");
    expect(text).not.toContain("{");
  });

  test("an unknown error shows a generic sentence with details behind a disclosure", async ({
    page,
  }) => {
    await page.route("**/api/home", (route) =>
      route.fulfill({
        status: 418,
        contentType: "application/json",
        body: JSON.stringify({ error: "teapot", message: "short and stout" }),
      }),
    );
    await page.goto("/");
    await expect(
      page.getByText("Couldn’t load this week. Try again in a minute."),
    ).toBeVisible();
    const details = page.locator("details");
    await expect(details).toBeVisible();
    await expect(details.getByText("418 teapot: short and stout")).toBeHidden();
    await details.getByText("Details").click();
    await expect(details.getByText("418 teapot: short and stout")).toBeVisible();
  });

  test("the home page has no close-out or start-next-week actions", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("link", { name: /close out this week|start next week/i }),
    ).toHaveCount(0);
  });
});

import { expect, test } from "@playwright/test";
import { bannedTermsIn } from "./banned";

const AUTH_API_URL = "http://localhost:5103";

// Sign in with Tempo (ADR 0008), on its own instance with sign-in on and a fake Tempo that
// knows one athlete.
test.describe("sign in with Tempo", () => {
  test("the API turns away a request without a session", async ({ request }) => {
    const res = await request.get(`${AUTH_API_URL}/settings`);
    expect(res.status()).toBe(401);
    expect((await res.json()).error).toBe("auth_required");
    expect((await request.get(`${AUTH_API_URL}/health`)).ok()).toBeTruthy();
  });

  test("an athlete signs in with their Tempo password, uses the app, and signs out", async ({
    page,
  }) => {
    // Any page sends a signed-out visitor to sign in. The first visit compiles the page.
    await page.goto("/plan");
    await expect(page).toHaveURL(/\/login$/, { timeout: 45_000 });
    await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
    await expect(page.getByText("Use your Tempo username and password.")).toBeVisible();
    // Nothing of the app shows before sign-in: no tab bar.
    await expect(page.getByRole("link", { name: "Coach Cade" })).toHaveCount(0);
    expect(bannedTermsIn(await page.locator("main").innerText())).toEqual([]);

    // A wrong password says so, and stays here.
    await page.getByLabel("Username").fill("lauren");
    await page.getByLabel("Password").fill("not it");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(
      page.getByText("That username and password don’t match your Tempo account."),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);

    // The right one lets them in. A new instance still asks for the disclaimer first.
    await page.getByLabel("Password").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/disclaimer$/, { timeout: 45_000 });
    await page.getByRole("button", { name: "I understand, continue" }).click();
    await expect(page).toHaveURL(/\/$/);

    // Signed in, pages load straight away.
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();

    // Sign out sits at the bottom of Settings, and puts the athlete back at sign-in.
    const signOut = page.getByRole("region", { name: "Sign out" });
    await expect(signOut).toBeVisible();
    await signOut.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("a forged session is turned away and sent to sign in", async ({ page, context }) => {
    await context.addCookies([
      { name: "cadence_session", value: "forged.value", url: "http://localhost:3102" },
    ]);
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login$/, { timeout: 45_000 });
  });
});

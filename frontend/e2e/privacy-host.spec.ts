import { expect, test, type Page } from "@playwright/test";
import { bannedTermsIn } from "./banned";

// The e2e stack runs on Anthropic, so the self-hosted answers are laid over the real
// responses here. The host rule itself and the copy swap are tested through the API routes.

/** The privacy data as the API sends it with a self-hosted model server at `host`. */
async function selfHostedPrivacy(page: Page, host: string, onNetwork: boolean) {
  await page.route("**/api/privacy", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({
      response: res,
      json: {
        ...body,
        intro:
          "Cadence sends coaching context to the model server you configured to generate replies. This page explains what is sent versus what stays on your deploy.",
        sent: { ...body.sent, heading: "May be sent to the model server you configured" },
        provider: "self_hosted",
        host,
        onNetwork,
      },
    });
  });
}

const where = (page: Page) => page.getByRole("region", { name: "Where coaching context goes" });

test.describe("Privacy names the model server's host", () => {
  test("Anthropic: no host line", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.getByRole("heading", { name: "What leaves this machine" })).toBeVisible();
    await expect(where(page)).toHaveCount(0);
    await expect(page.getByText("May be sent to Anthropic")).toBeVisible();
  });

  test("a private address stays on your network", async ({ page }) => {
    await selfHostedPrivacy(page, "192.168.1.20", true);
    await page.goto("/privacy");
    await expect(where(page)).toHaveText(
      "Coaching context is sent to the model server at 192.168.1.20. This stays on your network.",
    );
    await expect(page.getByText("May be sent to the model server you configured")).toBeVisible();
    await expect(page.getByText("outside your network")).toHaveCount(0);
    expect(bannedTermsIn(await where(page).innerText())).toEqual([]);
  });

  test("a public hostname is outside your network", async ({ page }) => {
    await selfHostedPrivacy(page, "models.example.com", false);
    await page.goto("/privacy");
    await expect(where(page)).toHaveText(
      "Coaching context is sent to the model server at models.example.com. This host is outside your network. Check it is the server you meant.",
    );
    await expect(page.getByText("This stays on your network.")).toHaveCount(0);
    expect(bannedTermsIn(await where(page).innerText())).toEqual([]);
  });
});

test("the disclaimer names the model server you configured when self-hosted", async ({ page }) => {
  await page.route("**/api/disclaimer", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({
      response: res,
      json: {
        ...body,
        provider: "self_hosted",
        text: String(body.text).replace(
          /When you connect your own Anthropic API key[^\n]*/,
          "When you use your own model server, coaching context from this app—including what your coach knows about you, your weekly report, your check-in answers, and messages you send to the coach—may be sent to the model server you configured to generate coaching replies. You control the server and who can reach it.",
        ),
      },
    });
  });
  await page.goto("/disclaimer");
  await expect(
    page.getByRole("heading", { name: "What may be sent to the model server you configured" }),
  ).toBeVisible();
  await expect(page.getByText("may be sent to the model server you configured to generate coaching replies")).toBeVisible();
  const text = await page.locator("main").innerText();
  expect(text).not.toContain("Anthropic");
  expect(bannedTermsIn(text)).toEqual([]);
});

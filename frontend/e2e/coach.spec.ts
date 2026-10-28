import { expect, test, type APIRequestContext } from "@playwright/test";

const API_URL = process.env.E2E_API_URL ?? "http://localhost:5102";
// Words the stub coach treats as something to remember are avoided, so these chats leave no notes.
const CHAT = (n: number) => `Message number ${n}: the week is going fine.`;

async function currentWeek(request: APIRequestContext) {
  return (await (await request.post(`${API_URL}/weeks/current`)).json()) as {
    id: string;
    timezone: string;
  };
}

test.describe("Coach", () => {
  test.beforeAll(async ({ request }) => {
    // Enough conversation that it cannot fit on one screen.
    const week = await currentWeek(request);
    for (let i = 1; i <= 8; i += 1) {
      const res = await request.post(`${API_URL}/weeks/${week.id}/chat`, { data: { body: CHAT(i) } });
      expect(res.ok()).toBeTruthy();
    }
  });

  test("the composer stays in view while the messages scroll, and the newest message is showing", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.goto("/chat");
    const log = page.getByRole("log", { name: "Conversation" });
    await expect(log.getByRole("article").first()).toBeVisible();

    // Only the messages scroll: the page itself does not.
    const m = await page.evaluate(() => {
      const el = document.querySelector('[role="log"]') as HTMLElement;
      return {
        overflowing: el.scrollHeight > el.clientHeight,
        atBottom: Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 4,
        pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
      };
    });
    expect(m).toEqual({ overflowing: true, atBottom: true, pageScrolls: false });

    // The composer is on screen, under the messages.
    const box = await page.getByRole("form", { name: "Write to Coach Cade" }).boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(700 + 1);
    await expect(log.getByRole("article").last()).toBeInViewport();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
  });

  test("a sent message is followed to the bottom", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.goto("/chat");
    await page.getByLabel("Message to Coach Cade").fill("A message sent from the page.");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    const log = page.getByRole("log", { name: "Conversation" });
    await expect(log.getByText("A message sent from the page.", { exact: true })).toBeVisible();
    await expect(log.getByRole("article").last()).toBeInViewport();
    await expect(page.getByLabel("Message to Coach Cade")).toHaveValue("");
  });

  test("the nav tab and the page heading say Coach Cade", async ({ page }) => {
    await page.goto("/chat");
    await expect(
      page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Coach Cade", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Coach Cade", level: 1 })).toBeVisible();
  });

  test("times read as words, and messages are labelled You and Coach Cade", async ({ page }) => {
    await page.goto("/chat");
    const log = page.getByRole("log", { name: "Conversation" });
    await expect(log.getByText("You", { exact: true }).first()).toBeVisible();
    await expect(log.getByText("Coach Cade", { exact: true }).first()).toBeVisible();
    const stamp = (await log.locator("time").last().innerText()).trim();
    // "6:40 pm", "Yesterday 6:40 pm", "Tue 6:40 pm" or "Oct 12, 6:40 pm"; never a raw date and seconds.
    expect(stamp).toMatch(/^(Yesterday |[A-Z][a-z]{2} |[A-Z][a-z]{2} \d{1,2}, )?\d{1,2}:\d{2} (am|pm)$/);
  });

  test("Add a run lists recent runs; the chosen one is a chip that can be removed", async ({ page }) => {
    await page.goto("/chat");
    const add = page.getByRole("button", { name: "Add a run" });
    await expect(add).toBeVisible();
    await expect(page.locator("select")).toHaveCount(0);

    await add.click();
    const list = page.getByRole("dialog", { name: "Add a run" });
    const options = list.getByRole("button");
    await expect(options.first()).toBeVisible();
    // Date, type and distance in the athlete's units.
    await expect(options.first()).toHaveText(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} · .+ · \d+\.\d mi$/);

    await options.first().click();
    await expect(list).toHaveCount(0);
    const chip = page.getByRole("button", { name: "Remove the attached run" });
    await expect(chip).toBeVisible();
    await expect(page.getByRole("button", { name: "Add a run" })).toHaveCount(0);

    await chip.click();
    await expect(chip).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add a run" })).toBeVisible();
  });

  test("a message with a run attached shows a run card, and no map", async ({ page }) => {
    await page.goto("/chat");
    await page.getByRole("button", { name: "Add a run" }).click();
    const first = page.getByRole("dialog", { name: "Add a run" }).getByRole("button").first();
    const label = (await first.innerText()).trim();
    await first.click();

    await page.getByLabel("Message to Coach Cade").fill("How did this run look?");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    const log = page.getByRole("log", { name: "Conversation" });
    const card = log.getByLabel("Attached run").last();
    await expect(card).toBeVisible();
    await expect(card).toContainText(/\d+\.\d mi/);
    await expect(card).toContainText(/\d+ min/);
    await expect(card).toContainText(/\d+:\d{2}\/mi/);
    await expect(card).toContainText(/\d+ bpm max/);
    // The coach sees a summary of the run, never its route.
    await expect(card.locator("img, svg, canvas, iframe")).toHaveCount(0);
    expect(label).toMatch(/Easy run/);
    // The chip is spent once the message is sent.
    await expect(page.getByRole("button", { name: "Remove the attached run" })).toHaveCount(0);

    // The splits are the athlete's to open, so the reply can say what they mean.
    const splits = card.getByRole("table", { name: "Splits" });
    await expect(splits).toBeHidden();
    await card.getByText("Splits", { exact: true }).click();
    await expect(splits).toBeVisible();
    await expect(splits.getByRole("columnheader")).toHaveText(["Split", "Distance", "Pace", "Heart rate"]);
    const firstSplit = splits.locator("tbody tr").first();
    await expect(firstSplit.getByRole("cell")).toHaveText(["1", /^\d+\.\d mi$/, /^\d+:\d{2}\/mi$/, /^\d+ bpm$/]);
  });

  test("a run with no splits shows no Splits toggle", async ({ page, request }) => {
    const week = await currentWeek(request);
    const sent = await request.post(`${API_URL}/weeks/${week.id}/chat`, {
      data: { body: "And the week before?", attachmentWorkoutId: "33333333-3333-4333-8333-333333333333" },
    });
    expect(sent.ok()).toBeTruthy();
    await page.goto("/chat");
    const card = page
      .getByRole("log", { name: "Conversation" })
      .getByLabel("Attached run")
      .filter({ hasText: "Prior week" })
      .last();
    await expect(card).toBeVisible();
    await expect(card.getByText("Splits", { exact: true })).toHaveCount(0);
  });

  test("a send the coach can't answer puts the message and its run back, and leaves nothing behind (#5)", async ({
    page,
  }) => {
    await page.route(/\/api\/weeks\/[^/]+\/chat$/, (route) =>
      route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: "llm_schema_invalid", message: "bad" }),
      }),
    );
    await page.goto("/chat");
    await page.getByRole("button", { name: "Add a run" }).click();
    await page.getByRole("dialog", { name: "Add a run" }).getByRole("button").first().click();
    await page.getByLabel("Message to Coach Cade").fill("This reply will fail.");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    await expect(page.getByLabel("Message to Coach Cade")).toHaveValue("This reply will fail.");
    await expect(page.getByRole("button", { name: "Remove the attached run" })).toBeVisible();
    const log = page.getByRole("log", { name: "Conversation" });
    await expect(log.getByText("This reply will fail.", { exact: true })).toHaveCount(0);
  });

  test("a past week can be read but not added to, with a way back to this week", async ({ page, request }) => {
    const real = await currentWeek(request);
    const PAST = "00000000-0000-4000-8000-000000000042";
    await page.route(/\/api\/weeks$/, async (route) => {
      const body = await (await route.fetch()).json();
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ...body,
          weeks: [...body.weeks, { ...body.weeks[0], id: PAST, isoWeek: "2026-W42", archived: true }],
        }),
      });
    });
    await page.route(/\/api\/thread\?weekSessionId=/, (route) =>
      route.continue({ url: route.request().url().replace(PAST, real.id) }),
    );
    await page.goto(`/chat?week=${PAST}`);

    await expect(page.getByText("This is a past week, so it’s here to read.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to this week" })).toHaveAttribute("href", "/chat");
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
    await expect(page.getByRole("log", { name: "Conversation" }).getByRole("article").first()).toBeVisible();
    await expect(page.locator("main")).not.toContainText(/archived/i);
  });

  test("if the week ended while the page was open, it says so plainly and keeps the draft", async ({ page }) => {
    await page.route(/\/api\/weeks\/[^/]+\/chat$/, (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "week_archived", message: "Week session is archived" }),
      }),
    );
    await page.goto("/chat");
    await page.getByLabel("Message to Coach Cade").fill("Still here after the week ended.");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    await expect(page.getByText("A new week has started, so your message wasn’t sent.")).toBeVisible();
    await expect(page.getByLabel("Message to Coach Cade")).toHaveValue("Still here after the week ended.");
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/archived|week_archived|409/i);
  });

  test("while the coach is replying a bubble says so, then the reply takes its place", async ({ page }) => {
    // A slow reply: the request waits before the real API answers.
    await page.route(/\/api\/weeks\/[^/]+\/chat$/, async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });
    await page.goto("/chat");
    await page.getByLabel("Message to Coach Cade").fill("A slow one.");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    const log = page.getByRole("log", { name: "Conversation" });
    const bubble = log.getByRole("status");
    await expect(bubble).toContainText("Coach Cade is replying");
    // Your message shows straight away, once, and the composer waits.
    await expect(log.getByText("A slow one.", { exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Sending…" })).toBeDisabled();
    await expect(page.getByLabel("Message to Coach Cade")).toHaveValue("");

    // Then the real reply replaces the bubble, and nothing is doubled.
    await expect(bubble).toHaveCount(0);
    await expect(log.getByText("A slow one.", { exact: true })).toHaveCount(1);
    await expect(log.getByRole("article").last()).toContainText("Quick check-in for this week");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  });

  test("coming back to the tab brings in a reply that finished while you were away", async ({ page, request }) => {
    await page.goto("/chat");
    const log = page.getByRole("log", { name: "Conversation" });
    await expect(log.getByRole("article").first()).toBeVisible();
    const week = await currentWeek(request);
    const sent = await request.post(`${API_URL}/weeks/${week.id}/chat`, {
      data: { body: "Sent while the tab was in the background." },
    });
    expect(sent.ok()).toBeTruthy();
    await expect(log.getByText("Sent while the tab was in the background.", { exact: true })).toHaveCount(0);

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(log.getByText("Sent while the tab was in the background.", { exact: true })).toBeVisible();
  });

  test("if the connection drops but the coach carries on, the reply still arrives and nothing is sent twice", async ({
    page,
  }) => {
    await page.clock.install();
    await page.route(/\/api\/weeks\/[^/]+\/chat$/, async (route) => {
      // The server gets the message and answers; the answer never reaches the page.
      await route.fetch();
      await route.abort("connectionreset");
    });
    await page.goto("/chat");
    await page.getByLabel("Message to Coach Cade").fill("The connection will drop on this one.");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    const log = page.getByRole("log", { name: "Conversation" });
    await expect(log.getByRole("status")).toContainText("Coach Cade may still be replying; this will update shortly.");
    // Not shown as a failure.
    await expect(page.getByText(/couldn.t send|something went wrong|failed/i)).toHaveCount(0);

    await page.clock.fastForward(10_000);
    await expect(log.getByRole("status")).toHaveCount(0);
    await expect(log.getByText("The connection will drop on this one.", { exact: true })).toHaveCount(1);
    await expect(log.getByRole("article").last()).toContainText("Quick check-in for this week");
    await expect(page.getByText("Coach Cade didn’t reply")).toHaveCount(0);
  });

  test("after two minutes without a reply it says so plainly, and a message that never arrived goes back in the box", async ({
    page,
  }) => {
    await page.clock.install();
    // The message never reaches the server.
    await page.route(/\/api\/weeks\/[^/]+\/chat$/, (route) => route.abort("connectionreset"));
    await page.goto("/chat");
    await page.getByLabel("Message to Coach Cade").fill("This one never arrives.");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    const log = page.getByRole("log", { name: "Conversation" });
    await expect(log.getByRole("status")).toContainText("may still be replying");
    // Twelve looks, ten seconds apart.
    for (let i = 0; i < 12; i += 1) await page.clock.fastForward(10_000);

    await expect(page.getByText("Coach Cade didn’t reply. Check back in a while, or send your message again.")).toBeVisible();
    await expect(log.getByRole("status")).toHaveCount(0);
    await expect(page.getByLabel("Message to Coach Cade")).toHaveValue("This one never arrives.");
    await expect(page.locator("main")).not.toContainText(/TypeError|Failed to fetch|502|504/);
  });
});

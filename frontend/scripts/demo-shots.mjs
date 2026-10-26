#!/usr/bin/env node
/**
 * Marketing screenshots of the demo instance (Johnny Morrissey, fictional).
 *
 *   scripts/demo.sh up            # in another terminal: the app on http://localhost:3001
 *   npm run demo:shots            # from frontend/
 *
 * Writes PNGs to docs/images/. Light mode, 1440 px wide at 2x, with the browser's clock
 * pinned to the demo "now" (Wed Oct 14 2026, 7:30 pm New York) so message times read the
 * way they would that evening. Not part of the e2e suite.
 *
 * Env: DEMO_URL (default http://localhost:3001), DEMO_SHOTS_OUT (default ../docs/images).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const BASE = (process.env.DEMO_URL ?? "http://localhost:3001").replace(/\/$/, "");
const OUT = path.resolve(
  process.env.DEMO_SHOTS_OUT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "../../docs/images"),
);
const DEMO_NOW = new Date("2026-10-14T19:30:00-04:00");
const CURRENT_WEEK = "2026-W42";
const LAST_WEEK = "2026-W41";
const DESKTOP = { width: 1440, height: 900 };
const LINKEDIN = { width: 1200, height: 627 };
const written = [];

async function newContext(browser, viewport) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "America/New_York",
  });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("cadence-appearance", "light");
    } catch {
      // Private mode: the colour scheme above still asks for light.
    }
  });
  // Only Date is fixed; timers keep running so the app loads normally.
  await context.clock.setFixedTime(DEMO_NOW);
  return context;
}

/** Wait until the page has stopped loading and has drawn the thing we came for. */
async function open(page, route, ready) {
  await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
  await ready(page).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText(/^Loading/).first().waitFor({ state: "detached", timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(500);
}

async function shot(page, name, options = {}) {
  const file = path.join(OUT, `${name}.png`);
  await (options.locator ?? page).screenshot({ path: file });
  written.push(file);
}

async function scrollTo(locator) {
  await locator.evaluate((el) => el.scrollIntoView({ block: "start" }));
  // Leave the sticky header out of the frame.
  await locator.page().evaluate(() => window.scrollBy(0, -90));
  await locator.page().waitForTimeout(300);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const probe = await fetch(`${BASE}/api/home`).catch(() => null);
  if (!probe?.ok) throw new Error(`no app at ${BASE}. Start it with scripts/demo.sh up`);
  if ((await probe.json()).isoWeek !== CURRENT_WEEK) {
    throw new Error(`${BASE} is not showing the demo season (expected ${CURRENT_WEEK} on Home)`);
  }
  const weeks = (await (await fetch(`${BASE}/api/weeks`)).json()).weeks;
  const lastWeek = weeks.find((w) => w.isoWeek === LAST_WEEK);
  if (!lastWeek) throw new Error(`no ${LAST_WEEK} in the week list`);
  const reviewRoute = `/review?week=${lastWeek.id}`;

  const browser = await chromium.launch();
  try {
    // Desktop shots.
    const page = await (await newContext(browser, DESKTOP)).newPage();
    const heading = (name) => (p) => p.getByRole("heading", { name }).first();

    await open(page, "/", heading("Home"));
    await shot(page, "hero");
    await shot(page, "home", { locator: page.locator("main") });

    await page.setViewportSize({ width: 1440, height: 1200 });
    await open(page, reviewRoute, (p) => p.getByText("How your week went").first());
    await shot(page, "your-week");

    await page.setViewportSize(DESKTOP);
    await open(page, "/plan", heading("Plan"));
    await shot(page, "plan");

    await page.setViewportSize({ width: 1440, height: 1000 });
    await open(page, "/chat", (p) => p.getByText("Medium-long 9").first());
    await scrollTo(page.getByText("Medium-long 9").first());
    await shot(page, "coach-chat");

    await open(page, "/dossier", (p) => p.getByText("Looks right").first());
    await shot(page, "about-you");

    // LinkedIn crops, 1.91:1.
    const wide = await (await newContext(browser, LINKEDIN)).newPage();
    await open(wide, reviewRoute, (p) => p.getByText("How your week went").first());
    await shot(wide, "linkedin-week");
    await open(wide, "/chat", (p) => p.getByText("Medium-long 9").first());
    await scrollTo(wide.getByText("Medium-long 9").first());
    await shot(wide, "linkedin-chat");
  } finally {
    await browser.close();
  }

  for (const file of written) console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

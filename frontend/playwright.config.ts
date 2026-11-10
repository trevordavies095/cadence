import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Local end-to-end suite. Boots the API (stub model, mini Tempo export, pinned
// clock, throwaway database) and the frontend on their own ports, so it can run
// beside a normal dev stack. CI is tracked separately.
const API_PORT = 5102;
const WEB_PORT = 3101;
const repoRoot = path.resolve(__dirname, "..");

const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5433/ai_coach_e2e";

export const API_URL = `http://localhost:${API_PORT}`;

// Sign in with Tempo runs on its own pair, with sign-in on, a fake Tempo and its own database.
const AUTH_API_PORT = 5103;
const AUTH_WEB_PORT = 3102;
const FAKE_TEMPO_PORT = 5199;
const authDatabaseUrl =
  process.env.E2E_AUTH_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5433/ai_coach_auth_e2e";
const FAKE_TEMPO_URL = `http://localhost:${FAKE_TEMPO_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 60_000,
  // The first visit to a page compiles it, which can take a few seconds.
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    // A fresh database, first: the welcome screen is the only way in until the disclaimer is
    // accepted, and accepting it is what lets every later project start inside the app.
    {
      name: "welcome",
      testMatch: /welcome\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    // Still a fresh profile: a brand-new athlete's first answers can be tested only here.
    // Everything after it runs with a profile in place.
    {
      name: "first-run",
      testMatch: /first-run\.spec\.ts/,
      dependencies: ["welcome"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      testIgnore: /(welcome|first-run|phone|sign-in)\.spec\.ts/,
      dependencies: ["first-run"],
      use: { ...devices["Desktop Chrome"] },
    },
    // A small phone. Chromium with a phone's viewport and touch, not Safari: this catches a page
    // wider than the screen, not WebKit-only behaviour.
    {
      name: "phone",
      testMatch: /phone\.spec\.ts/,
      dependencies: ["first-run"],
      use: { ...devices["iPhone SE"], browserName: "chromium" },
    },
    // Its own instance with sign-in on: depends on nothing else.
    {
      name: "sign-in",
      testMatch: /sign-in\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${AUTH_WEB_PORT}` },
    },
  ],
  webServer: [
    {
      command: "node ../frontend/e2e/reset-db.mjs && npx tsx src/index.ts",
      cwd: path.join(repoRoot, "api"),
      url: `${API_URL}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        PORT: String(API_PORT),
        DATABASE_URL: databaseUrl,
        E2E_DATABASE_URL: databaseUrl,
        DATA_PROTECTION_SECRET_KEY: "e2e-only-not-a-secret",
        CORS_ORIGIN: `http://localhost:${WEB_PORT}`,
        LLM_PROVIDER: "stub",
        TEMPO_EXPORT_PATH: path.join(
          repoRoot,
          "api/tests/fixtures/tempo-export-mini.zip",
        ),
        // Sunday of 2026-W43, inside the fixture's workout dates.
        DEV_CLOCK_NOW: process.env.E2E_CLOCK_NOW ?? "2026-10-25T16:00:00.000Z",
        ATHLETE_TIMEZONE: "America/New_York",
      },
    },
    {
      // A stale dev cache from an earlier run can leave the page reloading forever once the
      // source has changed, so every run builds from scratch.
      command: `rm -rf .next-e2e && npx next dev -p ${WEB_PORT}`,
      cwd: __dirname,
      url: `http://localhost:${WEB_PORT}/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        API_SERVICE_URL: API_URL,
        NEXT_DIST_DIR: ".next-e2e",
      },
    },
    {
      command: "node e2e/fake-tempo.mjs",
      cwd: __dirname,
      url: `${FAKE_TEMPO_URL}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { FAKE_TEMPO_PORT: String(FAKE_TEMPO_PORT) },
    },
    {
      command: "node ../frontend/e2e/reset-db.mjs && npx tsx src/index.ts",
      cwd: path.join(repoRoot, "api"),
      url: `http://localhost:${AUTH_API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        PORT: String(AUTH_API_PORT),
        DATABASE_URL: authDatabaseUrl,
        E2E_DATABASE_URL: authDatabaseUrl,
        DATA_PROTECTION_SECRET_KEY: "e2e-only-not-a-secret",
        CORS_ORIGIN: `http://localhost:${AUTH_WEB_PORT}`,
        LLM_PROVIDER: "stub",
        TEMPO_EXPORT_PATH: path.join(repoRoot, "api/tests/fixtures/tempo-export-mini.zip"),
        DEV_CLOCK_NOW: process.env.E2E_CLOCK_NOW ?? "2026-10-25T16:00:00.000Z",
        ATHLETE_TIMEZONE: "America/New_York",
        CADENCE_AUTH_TEMPO_URL: FAKE_TEMPO_URL,
      },
    },
    {
      command: `rm -rf .next-e2e-auth && npx next dev -p ${AUTH_WEB_PORT}`,
      cwd: __dirname,
      url: `http://localhost:${AUTH_WEB_PORT}/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        API_SERVICE_URL: `http://localhost:${AUTH_API_PORT}`,
        NEXT_DIST_DIR: ".next-e2e-auth",
        CADENCE_AUTH_TEMPO_URL: FAKE_TEMPO_URL,
      },
    },
  ],
});

import { serve } from "@hono/node-server";
import { resolveAthleteTimezone } from "./clock/athleteTimezone.js";
import { createApp } from "./app.js";
import { resolveAuthConfig } from "./auth/config.js";
import { createDefaultClock } from "./clock/clock.js";
import { migrate } from "./migrate.js";
import { failInterruptedRuns } from "./replyRun/store.js";

// Fail fast on an invalid ATHLETE_TIMEZONE before serving anything.
const athleteTimezone = resolveAthleteTimezone();

// Fail fast when sign-in is on but unsafe (a bad URL, or the example secret).
const authConfig = resolveAuthConfig();

const port = Number(process.env.PORT ?? 5001);

// One clock for startup and the app, so a pinned DEV_CLOCK_NOW stamps both (#7).
const clock = createDefaultClock();

await migrate();
await failInterruptedRuns(clock.now());

const app = createApp({ athleteTimezone, clock, auth: authConfig ? { config: authConfig } : null });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Cadence API listening on http://0.0.0.0:${info.port}`);
  if (authConfig) console.log(`Sign in with Tempo is on (${authConfig.tempoUrl})`);
});

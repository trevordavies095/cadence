import { serve } from "@hono/node-server";
import { resolveAthleteTimezone } from "./clock/athleteTimezone.js";
import { createApp } from "./app.js";
import { createDefaultClock } from "./clock/clock.js";
import { resolveAnthropicEffort } from "./llm/effort.js";
import { migrate } from "./migrate.js";
import { failInterruptedRuns } from "./replyRun/store.js";

// Fail fast on an invalid ATHLETE_TIMEZONE before serving anything.
const athleteTimezone = resolveAthleteTimezone();
// Same for an invalid ANTHROPIC_EFFORT.
resolveAnthropicEffort();

const port = Number(process.env.PORT ?? 5001);

// One clock for startup and the app, so a pinned DEV_CLOCK_NOW stamps both (#7).
const clock = createDefaultClock();

await migrate();
await failInterruptedRuns(clock.now());

const app = createApp({ athleteTimezone, clock });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Cadence API listening on http://0.0.0.0:${info.port}`);
});

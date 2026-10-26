import { serve } from "@hono/node-server";
import { resolveAthleteTimezone } from "./clock/athleteTimezone.js";
import { createApp } from "./app.js";
import { resolveAnthropicEffort } from "./llm/effort.js";
import { migrate } from "./migrate.js";
import { failInterruptedRuns } from "./replyRun/store.js";

// Fail fast on an invalid ATHLETE_TIMEZONE before serving anything.
const athleteTimezone = resolveAthleteTimezone();
// Same for an invalid ANTHROPIC_EFFORT.
resolveAnthropicEffort();

const port = Number(process.env.PORT ?? 5001);

await migrate();
await failInterruptedRuns();

const app = createApp({ athleteTimezone });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Cadence API listening on http://0.0.0.0:${info.port}`);
});

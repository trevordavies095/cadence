/**
 * Lists the Anthropic models the coach can be sent to, with the efforts each
 * accepts, using the Settings catalogue's own call (GET /v1/models, no charge).
 * Reads ANTHROPIC_API_KEY from the environment and prints JSON.
 *
 *   npx tsx scripts/list-coach-models.ts > ../.scratch/benchmark-coaching/models.json
 */
import { createCoachModelCatalogue } from "../src/settings/coachModelCatalogue.js";

const key = process.env.ANTHROPIC_API_KEY?.trim();
if (!key) {
  console.error("Set ANTHROPIC_API_KEY first.");
  process.exit(2);
}
const catalogue = createCoachModelCatalogue({ readApiKey: async () => key });
const { models, fallback } = await catalogue.load({ saved: null });
if (fallback) {
  console.error(`The listing failed (${fallback}); nothing recorded.`);
  process.exit(1);
}
console.log(JSON.stringify({ listedOn: new Date().toISOString().slice(0, 10), models }, null, 2));

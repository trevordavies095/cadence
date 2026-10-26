// Drops and recreates the throwaway end-to-end database before the API boots.
// Uses the API's `pg` so the frontend needs no database dependency.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(here, "../../api/package.json"));
const { Client } = require("pg");

const target = new URL(
  process.env.E2E_DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5433/ai_coach_e2e",
);
const name = target.pathname.replace(/^\//, "");

// The database is dropped on every run, so refuse anything that is not clearly disposable.
if (!/_e2e$/.test(name)) {
  console.error(`Refusing to reset "${name}": e2e database names must end in _e2e.`);
  process.exit(1);
}

const admin = new URL(target);
admin.pathname = "/postgres";

const client = new Client({ connectionString: admin.toString() });
await client.connect();
try {
  await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await client.query(`CREATE DATABASE "${name}"`);
  console.log(`e2e database "${name}" is fresh`);
} finally {
  await client.end();
}

/**
 * The suite deletes every app table (resetAppTables). Refuse to run unless the
 * target database is clearly a test database, so `npm test` can never wipe a
 * real one (e.g. the default `ai_coach` DB).
 */
const DEFAULT_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5433/ai_coach";

export function databaseNameFromUrl(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return "";
  }
}

export function assertTestDatabaseName(name: string): void {
  if (!/_test/.test(name)) {
    throw new Error(
      `Refusing to run tests against database "${name || "(unknown)"}": the suite deletes all app tables. ` +
        `Point DATABASE_URL at a test database whose name contains "_test" ` +
        `(e.g. postgresql://postgres:postgres@localhost:5433/ai_coach_test).`,
    );
  }
}

export default function setup(): void {
  assertTestDatabaseName(
    databaseNameFromUrl(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL),
  );
}

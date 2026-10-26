import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { migrate } from "../src/migrate.js";
import {
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

describe("disclaimer accept → unlock", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
  });

  it("blocks settings/thread until accept, then unlocks and persists", async () => {
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });

    const before = await app.request("/disclaimer");
    expect(before.status).toBe(200);
    const beforeBody = await json(before);
    expect(beforeBody.accepted).toBe(false);
    expect(typeof beforeBody.text).toBe("string");
    expect(String(beforeBody.text).length).toBeGreaterThan(40);

    expect((await app.request("/settings")).status).toBe(403);
    expect((await app.request("/thread")).status).toBe(403);
    const blocked = await json(await app.request("/settings"));
    expect(blocked.error).toBe("disclaimer_required");

    const accept = await app.request("/disclaimer/accept", { method: "POST" });
    expect(accept.status).toBe(200);
    const acceptBody = await json(accept);
    expect(acceptBody.accepted).toBe(true);
    expect(acceptBody.acceptedAt).toBeTruthy();

    // Fresh app instance — acceptance must survive "restart" via Postgres.
    const app2 = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });
    const after = await app2.request("/disclaimer");
    expect(after.status).toBe(200);
    const afterBody = await json(after);
    expect(afterBody.accepted).toBe(true);

    expect((await app2.request("/settings")).status).toBe(200);
    expect((await app2.request("/thread")).status).toBe(200);
    const settings = await json(await app2.request("/settings"));
    expect(settings.tempo).toMatchObject({ configured: false });
    expect(settings.anthropic).toMatchObject({ configured: false });
  });

  it("accept is idempotent", async () => {
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });
    const first = await json(
      await app.request("/disclaimer/accept", { method: "POST" }),
    );
    const second = await json(
      await app.request("/disclaimer/accept", { method: "POST" }),
    );
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(second.acceptedAt).toBe(first.acceptedAt);
  });
});

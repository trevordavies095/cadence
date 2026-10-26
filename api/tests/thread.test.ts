import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { migrate } from "../src/migrate.js";
import {
  acceptAndReady,
  json,
  resetAppTables,
  TEST_DATA_PROTECTION_KEY,
} from "./helpers.js";

describe("coach thread messages", () => {
  beforeAll(async () => {
    process.env.DATA_PROTECTION_SECRET_KEY = TEST_DATA_PROTECTION_KEY;
    await migrate();
  });

  beforeEach(async () => {
    await resetAppTables();
  });

  it("post → list persists across app instances", async () => {
    await acceptAndReady();
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });

    const empty = await json(await app.request("/thread"));
    expect(empty.messages).toEqual([]);

    const created = await app.request("/thread/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Felt heavy on the long run." }),
    });
    expect(created.status).toBe(201);
    const msg = await json(created);
    expect(msg.role).toBe("athlete");
    expect(msg.body).toBe("Felt heavy on the long run.");
    expect(msg.id).toBeTruthy();

    const app2 = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });
    const listed = await json(await app2.request("/thread"));
    const messages = listed.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toBe("Felt heavy on the long run.");
    expect(messages[0]!.id).toBe(msg.id);
  });

  it("disclaimer still gates thread", async () => {
    const app = createApp({ dataProtectionKey: TEST_DATA_PROTECTION_KEY });
    expect((await app.request("/thread")).status).toBe(403);
    expect(
      (
        await app.request("/thread/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "nope" }),
        })
      ).status,
    ).toBe(403);
  });
});

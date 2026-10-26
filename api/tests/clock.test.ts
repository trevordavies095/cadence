import { describe, expect, it } from "vitest";
import { FixedClock, SystemClock } from "../src/clock/clock.js";
import { boundsForIsoWeek, resolveIsoWeek } from "../src/clock/isoWeek.js";
import { createApp } from "../src/app.js";

describe("controllable clock + ISO week", () => {
  it("production default clock is system time", () => {
    const before = Date.now();
    const now = new SystemClock().now().getTime();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it("fixed now + UTC yields deterministic Mon–Sun ISO week", () => {
    // Wednesday 2026-10-21 15:00 UTC → ISO week 2026-W43 (Mon 19 – Sun 25)
    const clock = new FixedClock(new Date("2026-10-21T15:00:00.000Z"));
    const week = resolveIsoWeek(clock, "UTC");
    expect(week.isoWeek).toBe("2026-W43");
    expect(week.start).toBe("2026-10-19T00:00:00.000Z");
    expect(week.end).toBe("2026-10-25T23:59:59.999Z");
    expect(week.now).toBe("2026-10-21T15:00:00.000Z");
  });

  it("time travel across week boundary changes ISO week", () => {
    const sunday = resolveIsoWeek(
      new FixedClock(new Date("2026-10-25T12:00:00.000Z")),
      "UTC",
    );
    const monday = resolveIsoWeek(
      new FixedClock(new Date("2026-10-26T00:00:00.000Z")),
      "UTC",
    );
    expect(sunday.isoWeek).toBe("2026-W43");
    expect(monday.isoWeek).toBe("2026-W44");
    expect(monday.start).toBe("2026-10-26T00:00:00.000Z");
    expect(monday.end).toBe("2026-11-01T23:59:59.999Z");
  });

  it("boundsForIsoWeek matches resolveIsoWeek for the same label", () => {
    const fromClock = resolveIsoWeek(
      new FixedClock(new Date("2026-10-26T12:00:00.000Z")),
      "UTC",
    );
    const fromLabel = boundsForIsoWeek("2026-W44", "UTC");
    expect(fromLabel.isoWeek).toBe(fromClock.isoWeek);
    expect(fromLabel.start).toBe(fromClock.start);
    expect(fromLabel.end).toBe(fromClock.end);
    expect(fromLabel.timezone).toBe("UTC");
  });

  it("boundsForIsoWeek respects America/New_York local midnight", () => {
    const bounds = boundsForIsoWeek("2026-W44", "America/New_York");
    expect(bounds.start).toBe("2026-10-26T04:00:00.000Z");
    expect(bounds.end).toBe("2026-11-02T04:59:59.999Z");
  });

  it("GET /week uses injected clock", async () => {
    const app = createApp({
      clock: new FixedClock(new Date("2026-01-01T08:00:00.000Z")),
    });
    const res = await app.request("/week");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      isoWeek: string;
      start: string;
      end: string;
    };
    // 2026-01-01 is Thursday → week containing Mon 2025-12-29
    expect(body.isoWeek).toBe("2026-W01");
    expect(body.start).toBe("2025-12-29T00:00:00.000Z");
    expect(body.end).toBe("2026-01-04T23:59:59.999Z");
  });
});

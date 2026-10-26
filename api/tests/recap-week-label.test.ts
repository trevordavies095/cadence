import { describe, expect, it } from "vitest";
import { formatRecapWeekRangeLabel } from "../src/recap/weekRangeLabel.js";

describe("formatRecapWeekRangeLabel (tempo-cli title)", () => {
  it("matches tempo-cli for W43 in New York", () => {
    expect(
      formatRecapWeekRangeLabel(
        "2026-W43",
        "2026-10-19T04:00:00.000Z",
        "2026-10-26T03:59:59.999Z",
        "America/New_York",
      ),
    ).toBe("2026-W43 (Mon Oct 19 – Sun Oct 25, 2026)");
  });

  it("puts the year on the Monday when the week crosses a year boundary", () => {
    expect(
      formatRecapWeekRangeLabel(
        "2026-W01",
        "2025-12-29T05:00:00.000Z",
        "2026-01-05T04:59:59.999Z",
        "America/New_York",
      ),
    ).toBe("2026-W01 (Mon Dec 29, 2025 – Sun Jan 4, 2026)");
  });

  it("uses the local date across the DST change (week of Nov 1, 2026)", () => {
    expect(
      formatRecapWeekRangeLabel(
        "2026-W44",
        "2026-10-26T04:00:00.000Z",
        "2026-11-02T04:59:59.999Z",
        "America/New_York",
      ),
    ).toBe("2026-W44 (Mon Oct 26 – Sun Nov 1, 2026)");
  });
});

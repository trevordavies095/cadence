import { expect, test } from "@playwright/test";

for (const checkInStatus of ["needed", "finished", "skipped"] as const) {
  test(`Plan loads independent requests together and keeps ${checkInStatus} gating without a recap`, async ({ page }) => {
    const seen = new Set<string>();
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/api\/weeks\/[^/]+\/(prescribed(?:\/next)?|reply-run|recap)$/, async (route) => {
      const path = new URL(route.request().url()).pathname;
      const name = path.endsWith("/prescribed/next") ? "next" : path.split("/").at(-1)!;
      seen.add(name);
      if (name === "prescribed") {
        await pending;
      }
      const bodies: Record<string, object> = {
        next: {
          prescribed: null,
          unitPreference: "metric",
          todayYmd: "2026-10-25",
          checkInStatus,
        },
        "reply-run": { run: null },
        prescribed: { prescribed: null },
        recap: { checkInStatus: "needed" },
      };
      const body = bodies[name];
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    try {
      await page.goto("/plan");
      await expect.poll(() => [...seen].sort()).toEqual(["next", "prescribed", "reply-run"]);
      release();
      await expect(page.getByRole("heading", { name: "Plan", exact: true })).toBeVisible();
      const button = page.getByRole("button", { name: "Ask Coach Cade to plan next week" });
      if (checkInStatus === "needed") {
        await expect(page.getByText(
          "Coach Cade plans next week once your weekly check-in is done",
        )).toBeVisible();
        await expect(button).toHaveCount(0);
      } else {
        await expect(button).toBeEnabled();
      }
      expect(seen.has("recap")).toBe(false);
    } finally {
      release();
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  });
}

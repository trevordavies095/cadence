import { expect, test } from "@playwright/test";
import { bannedTermsIn } from "./banned";

// What Privacy says about the last message to Coach Cade. The packet is mocked so the goal,
// that week's stage and the training numbers are known.
const LAST_PACKET = {
  savedAt: "2026-10-25T15:00:00.000Z",
  summary: {
    isoWeek: "2026-W43",
    weekSessionId: null,
    dossierVersionId: 1,
    threadMessageCount: 0,
    attachmentCount: 0,
    hasRecap: true,
    attachmentWorkoutIds: [],
  },
  packet: {
    goal: { kind: "race", distance: "half", raceName: "Lakeshore Half", raceDate: "2027-03-07" },
    coaching: {
      phase: "build",
      weeksToRace: 19,
      unitPreference: "imperial",
      thresholdPaceS: 270,
      thresholdHeartRateBpm: 168,
      maxHeartRateBpm: 186,
      observedMaxHeartRateBpm: 189,
    },
  },
};

test("Privacy shows the goal, that week and the training numbers that were sent", async ({ page }) => {
  await page.route("**/api/settings/last-packet", (route) => route.fulfill({ json: { lastPacket: LAST_PACKET } }));
  await page.goto("/privacy");
  const sent = page.locator("dl").filter({ hasText: "Training for" });
  await expect(sent).toContainText("Lakeshore Half (half marathon) on Sun Mar 7 2027, 19 weeks out");
  await expect(sent).toContainText("building toward the goal");
  await expect(sent).toContainText(
    "threshold pace 7:15/mi, threshold heart rate 168 bpm, max heart rate 186 bpm, highest heart rate in the last year 189 bpm",
  );
  expect(bannedTermsIn(await sent.innerText())).toEqual([]);
});

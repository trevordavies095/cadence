import { afterEach } from "vitest";
import { waitForReplyRunsIdle } from "../src/replyRun/inflight.js";

// Finishing or skipping a check-in starts a weekly reply in the background.
// Let it settle before a test ends so it never writes into the next test, or
// holds locks while the next suite migrates the schema.
afterEach(async () => {
  await waitForReplyRunsIdle();
});

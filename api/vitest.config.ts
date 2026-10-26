import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/guardTestDatabase.ts"],
    setupFiles: ["./tests/setupReplyRuns.ts"],
    fileParallelism: false,
    poolOptions: {
      threads: { singleThread: true },
    },
  },
});

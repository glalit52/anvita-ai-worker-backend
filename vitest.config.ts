import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      MODEL_PROVIDER: "scripted",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://anvita:anvita@localhost:5432/anvita_test",
      RATE_LIMIT_PER_MINUTE: "100000",
      SLACK_SIGNING_SECRET: "test-slack-secret",
    },
    // Tests share one database; run files sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

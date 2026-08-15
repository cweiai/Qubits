import { defineConfig, devices } from "@playwright/test";

/**
 * Sandbox-flow e2e runs against the production server with a test-only persisted
 * build fixture. Real model generation is covered separately by npm run eval:real.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3206",
    trace: "retain-on-failure",
    locale: "zh-CN",
  },
  webServer: {
    command: "node tests/e2e/seed.mjs && npm run build && npm run start -- --port 3206",
    url: "http://127.0.0.1:3206",
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    env: {
      DATABASE_URL: "file:./data/e2e.db",
      SANDBOX_PROVIDER: "container",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

import { defineConfig, devices } from "@playwright/test";

/**
 * Sandbox-flow e2e: no real LLM — tests write a valid AppSpec into localStorage
 * to enter preview directly, verifying the iframe sandbox, MessageChannel CRUD,
 * DB persistence, and isolation.
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
    command: "npm run build && npm run start -- --port 3206",
    url: "http://127.0.0.1:3206",
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    env: {
      DATABASE_URL: "file:./data/e2e.db",
      QUIBITS_MOCK_PROVIDER: "true",
      REFERENCE_SEARCH_PROVIDER: "mock",
      // Sandbox: container-only (the default). e2e requires a running Docker daemon
      // because real build checks run inside the container — no local fallback.
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

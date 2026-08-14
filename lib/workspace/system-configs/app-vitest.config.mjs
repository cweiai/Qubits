/**
 * System-maintained Vitest config for generated app workspaces.
 * Pure-logic tests only (node environment); the trusted template ships
 * src/lib/app-data.test.ts as the example.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: false,
    testTimeout: 20000,
    hookTimeout: 20000,
    reporters: ["basic"],
  },
});

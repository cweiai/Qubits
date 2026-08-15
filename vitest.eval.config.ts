import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "server-only": path.resolve(__dirname, "tests/unit/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/eval/**/*.test.ts"],
    testTimeout: 2_700_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});

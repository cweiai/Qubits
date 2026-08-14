import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
      "lib/sandbox/runtime.generated.ts",
      "scripts/**",
      // runtime data: task workspaces, built bundles, snapshots, databases
      "data/**",
    ],
  },
];

export default eslintConfig;

/**
 * System-maintained ESLint flat config for generated app workspaces.
 * Generated code can never override this file (workspace config paths are
 * protected by the filesystem tools); the lint runner points ESLint here.
 */
import js from "@eslint/js";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

const appEslintConfig = [
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.es2021,
        MessagePort: "readonly",
        MessageEvent: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        WindowPostMessageOptions: "readonly",
        Transferable: "readonly",
      },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "no-eval": "error",
      "no-new-func": "error",
      "no-implied-eval": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
];

export default appEslintConfig;

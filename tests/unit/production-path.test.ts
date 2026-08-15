import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Production-path guard: test doubles belong under tests/ and cannot be selected by env flags. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const file = path.join(root, name);
    if (statSync(file).isDirectory()) out.push(...sourceFiles(file));
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(file);
  }
  return out;
}

describe("生产路径不包含 Mock/Demo 替身", () => {
  it("不能通过环境变量或注册表启用测试实现", () => {
    const roots = [path.join(process.cwd(), "lib"), path.join(process.cwd(), "app"), path.join(process.cwd(), "components")];
    const files = roots.flatMap(sourceFiles);
    const forbidden = [
      "QUIBITS_MOCK_PROVIDER",
      "seed_demo_data",
      "demoMode",
      "artifactFile",
      "mockProvider",
      'from "./release"',
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const token of forbidden) expect(text, file + " contains " + token).not.toContain(token);
    }
  });
});

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ROLE_DEFINITIONS } from "@/lib/ai/roles";
import { securityReviewSchema } from "@/lib/contracts/review";

const ROOT = path.resolve(process.cwd());

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "runtime.generated.ts") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("Agent Tool Calling 提示词注入", () => {
  it("迈克是唯一 root Agent 且必须通过真实工具完成编排", () => {
    const prompt = ROLE_DEFINITIONS.team_leader.systemPrompt;
    expect(prompt).toContain("迈克");
    expect(prompt).toContain("delegate_to_agent");
    expect(prompt).toContain("render_preview");
    expect(prompt).toContain("complete_run");
    expect(prompt).toContain("explicit tool-calling protocol");
  });

  it("子 Agent 提示词包含工具规则且不得自行分配 Agent", () => {
    expect(ROLE_DEFINITIONS.product_manager.systemPrompt).toContain("不得自行分配 Agent");
    expect(ROLE_DEFINITIONS.architect.systemPrompt).toContain("不得自行分配 Agent");
    expect(ROLE_DEFINITIONS.engineer.systemPrompt).toContain("workspace_init");
    expect(ROLE_DEFINITIONS.engineer.systemPrompt).toContain("run_build");
    expect(ROLE_DEFINITIONS.engineer.systemPrompt).toContain("qubits.manifest.json");
    expect(ROLE_DEFINITIONS.reviewer.systemPrompt).toContain("approved");
    expect(ROLE_DEFINITIONS.reviewer.systemPrompt).toContain("security_scan");
    expect(ROLE_DEFINITIONS.researcher.systemPrompt).toContain("search_references");
  });

  it("工具权限 allowlist：非迈克角色不能 delegate/render/complete", () => {
    expect(ROLE_DEFINITIONS.product_manager.tools).not.toContain("delegate_to_agent");
    expect(ROLE_DEFINITIONS.engineer.tools).not.toContain("render_preview");
    expect(ROLE_DEFINITIONS.team_leader.tools).toContain("delegate_to_agent");
    expect(ROLE_DEFINITIONS.team_leader.tools).toContain("render_preview");
    expect(ROLE_DEFINITIONS.team_leader.tools).toContain("complete_run");
  });

  it("Reviewer 输出 schema 强制结构化 issues", () => {
    expect(securityReviewSchema.safeParse({ approved: false, summary: "x", issues: [] }).success).toBe(false);
    expect(
      securityReviewSchema.safeParse({
        approved: false,
        summary: "x",
        issues: [{ code: "C", severity: "error", path: "p", message: "m", repairHint: "h" }],
      }).success
    ).toBe(true);
  });
});

describe("沙盒安全断言", () => {
  it("仓库源码中不存在 eval / new Function / 动态 import", () => {
    const files = walk(path.join(ROOT, "app"))
      .concat(walk(path.join(ROOT, "components")))
      .concat(walk(path.join(ROOT, "lib")))
      .filter(
        (file) =>
          !file.includes("lib/app-spec/security.ts") && // pattern-detection definition file
          !file.includes("lib/ai/tools/security.ts") && // pattern-detection definition file (its example copy contains "eval() ...")
          !file.includes("lib/workspace/security-scan.ts") && // static-scan rule definitions (pattern literals + explanatory comments)
          !file.includes("lib/workspace/dependency-policy.ts") // import-specifier regex definition
      );
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} 含 eval(`).not.toMatch(/\beval\s*\(/i);
      expect(source, `${file} 含 new Function(`).not.toMatch(/new\s+Function\s*\(/i);
      expect(source, `${file} 含动态 import(`).not.toMatch(/\bimport\s*\(/i);
    }
  });
});

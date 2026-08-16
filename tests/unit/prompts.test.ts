import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ROLE_DEFINITIONS } from "@/lib/ai/roles";

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
  it("Mike 是唯一 root Agent 且必须通过真实工具完成编排", () => {
    const prompt = ROLE_DEFINITIONS.team_leader.systemPrompt;
    expect(prompt).toContain("Mike");
    expect(prompt).toContain("delegate_to_agent");
    expect(prompt).toContain("render_preview");
    expect(prompt).toContain("complete_run");
    expect(prompt).toContain("explicit tool-calling protocol");
    expect(prompt).toContain("团队固定只有三人");
    expect(prompt).toContain("不得跳过 Emma");
  });

  it("子 Agent 提示词包含工具规则且不得自行分配 Agent", () => {
    expect(ROLE_DEFINITIONS.product_manager.systemPrompt).toContain("不得自行分配 Agent");
    expect(ROLE_DEFINITIONS.engineer.systemPrompt).toContain("workspace_init");
    expect(ROLE_DEFINITIONS.engineer.systemPrompt).toContain("run_build");
    expect(ROLE_DEFINITIONS.engineer.systemPrompt).toContain("qubits.manifest.json");
    expect(ROLE_DEFINITIONS.engineer.systemPrompt).toContain("源码注释只能使用简短英文");
    expect(ROLE_DEFINITIONS.engineer.systemPrompt).toContain("禁止中文代码注释");
    expect(ROLE_DEFINITIONS.engineer.systemPrompt).toContain("security_scan");
    expect(Object.keys(ROLE_DEFINITIONS).sort()).toEqual(["engineer", "product_manager", "team_leader"]);
  });

  it("新应用任务明确跳过不存在的现有应用观察", () => {
    const prompt = ROLE_DEFINITIONS.product_manager.buildTaskPrompt({
      task: "设计一个新应用",
      inputArtifacts: [],
      currentManifest: null,
    });
    expect(prompt).toContain("当前没有现有应用");
    expect(prompt).toContain("不要调用 inspect_current_app");
  });

  it("所有交付角色共享宿主鉴权边界且禁止前端伪鉴权", () => {
    for (const role of ["team_leader", "product_manager", "engineer"] as const) {
      const prompt = ROLE_DEFINITIONS[role].systemPrompt;
      expect(prompt).toContain("Qubits 沙盒信任边界");
      expect(prompt).toContain("生成代码无权修改宿主、SDK bridge 或服务端");
    }
    expect(ROLE_DEFINITIONS.engineer.systemPrompt).toContain("不得在生成代码中实现登录");
    expect(ROLE_DEFINITIONS.team_leader.systemPrompt).toContain("禁止引用或尝试委派其他角色");
  });

  it("工具权限 allowlist：非 Mike 角色不能 delegate/render/complete", () => {
    expect(ROLE_DEFINITIONS.product_manager.tools).not.toContain("delegate_to_agent");
    expect(ROLE_DEFINITIONS.engineer.tools).not.toContain("render_preview");
    expect(ROLE_DEFINITIONS.team_leader.tools).toContain("delegate_to_agent");
    expect(ROLE_DEFINITIONS.team_leader.tools).toContain("render_preview");
    expect(ROLE_DEFINITIONS.team_leader.tools).toContain("complete_run");
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

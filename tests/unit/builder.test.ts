import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { initWorkspace, listSourceFiles } from "@/lib/workspace/workspace-manager";
import { buildApp } from "@/lib/workspace/builder";
import { scanWorkspace } from "@/lib/workspace/security-scan";
import { checkWorkspaceDependencies } from "@/lib/workspace/dependency-policy";
import { resolveWorkspacePath } from "@/lib/workspace/paths";
import { runWorkspaceLint, runWorkspaceTests, runWorkspaceTypecheck } from "@/lib/workspace/runner";
import { LocalDevSandboxProvider } from "@/lib/ai/tools/sandbox-provider";

/**
 * Real build pipeline tests: the trusted template must pass lint/typecheck/tests/build
 * and produce a real preview bundle; security/dependency violations must block.
 * The workspace lives under the repo so type resolution reaches the host node_modules.
 */

const workspaces: string[] = [];
function makeWorkspace(): string {
  const dir = path.join(process.cwd(), "data", "workspaces", "test-builder-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6));
  mkdirSync(dir, { recursive: true });
  workspaces.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of workspaces) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("可信模板构建流水线", () => {
  it("workspace_init 幂等：第二次初始化不覆盖已有文件", () => {
    const dir = makeWorkspace();
    const first = initWorkspace(dir, { taskId: "task-000000000001" });
    expect(first.seededFrom).toBe("template");
    writeFileSync(path.join(dir, "src", "custom.tsx"), "export const marker = 1;\n");
    const second = initWorkspace(dir, { taskId: "task-000000000001" });
    expect(second.seededFrom).toBe("existing");
    expect(readFileSync(path.join(dir, "src", "custom.tsx"), "utf8")).toContain("marker");
    expect(listSourceFiles(dir).some((f) => f.path === "qubits.manifest.json")).toBe(true);
  });

  it("模板通过 lint、typecheck、tests、build，并产生真实 preview bundle", async () => {
    const dir = makeWorkspace();
    initWorkspace(dir, { taskId: "task-000000000002" });
    const sandbox = new LocalDevSandboxProvider();

    const typecheck = await runWorkspaceTypecheck(sandbox, dir);
    expect(typecheck.status).toBe("passed");

    const lint = await runWorkspaceLint(sandbox, dir);
    expect(lint.status).toBe("passed");

    const tests = await runWorkspaceTests(sandbox, dir);
    expect(tests.status).toBe("passed");

    const result = await buildApp(dir);
    expect(result.report.status).toBe("success");
    expect(result.bundle).not.toBeNull();
    expect(result.bundle!.html).toContain("qubits-root");
    expect(result.bundle!.html).toContain("Content-Security-Policy");
    expect(result.bundle!.bytes).toBeGreaterThan(1000);
    // Real artifacts on disk.
    expect(readFileSync(path.join(dir, "dist", "index.html"), "utf8")).toContain("qubits-root");
    expect(JSON.parse(readFileSync(path.join(dir, "dist", "build-report.json"), "utf8")).status).toBe("success");
  }, 180000);

  it("静态扫描阻断 eval / fetch / localStorage（SECURITY_BLOCKED）", async () => {
    const dir = makeWorkspace();
    initWorkspace(dir, { taskId: "task-000000000003" });
    writeFileSync(
      path.join(dir, "src", "evil.ts"),
      'const run = eval("2+2");\nexport const grab = () => fetch("https://evil.example");\nexport const keep = localStorage.getItem("x");\n'
    );
    const scan = scanWorkspace(dir);
    expect(scan.status).toBe("blocked");
    expect(scan.findings.map((f) => f.rule)).toEqual(
      expect.arrayContaining(["NO_EVAL", "NO_NETWORK", "NO_STORAGE"])
    );
    const result = await buildApp(dir);
    expect(result.report.status).toBe("failed");
    expect(result.report.errorCode).toBe("SECURITY_BLOCKED");
    expect(result.bundle).toBeNull();
  });

  it("未授权依赖被拒绝（INVALID_DEPENDENCY）", async () => {
    const dir = makeWorkspace();
    initWorkspace(dir, { taskId: "task-000000000004" });
    writeFileSync(path.join(dir, "src", "app.ts"), 'import something from "left-pad";\nexport default something;\n');
    const manifest = JSON.parse(readFileSync(path.join(dir, "qubits.manifest.json"), "utf8"));
    const check = checkWorkspaceDependencies(dir, manifest);
    expect(check.valid).toBe(false);
    expect(check.problems.join(";")).toContain("left-pad");
    const result = await buildApp(dir);
    expect(result.report.status).toBe("failed");
    expect(result.report.errorCode).toBe("INVALID_DEPENDENCY");
  });

  it("构建失败不产出 bundle（错误代码保留在报告中）", async () => {
    const dir = makeWorkspace();
    initWorkspace(dir, { taskId: "task-000000000005" });
    writeFileSync(path.join(dir, "src", "App.tsx"), "export function App( {\n");
    const result = await buildApp(dir);
    expect(result.report.status).toBe("failed");
    expect(result.report.errorCode).toBe("BUILD_FAILED");
    expect(result.bundle).toBeNull();
    expect(result.report.message ?? "").not.toContain("/Users/"); // host paths redacted
  });
});

describe("路径 jail", () => {
  it("拒绝绝对路径、../ 与敏感文件", () => {
    const dir = makeWorkspace();
    initWorkspace(dir, { taskId: "task-000000000006" });
    expect(() => resolveWorkspacePath(dir, "/etc/passwd")).toThrowError(/绝对路径/);
    expect(() => resolveWorkspacePath(dir, "../outside.txt")).toThrowError(/工作区外|路径/);
    expect(() => resolveWorkspacePath(dir, ".env")).toThrowError(/敏感文件/);
  });
});

beforeAll(() => {
  process.env.SANDBOX_PROVIDER = "local-dev";
});

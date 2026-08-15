import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { initWorkspace, listSourceFiles } from "@/lib/workspace/workspace-manager";
import { buildApp } from "@/lib/workspace/builder";
import { scanWorkspace } from "@/lib/workspace/security-scan";
import { checkWorkspaceDependencies } from "@/lib/workspace/dependency-policy";
import { safeResolveWorkspacePath } from "@/lib/workspace/paths";
import { runWorkspaceLint, runWorkspaceTests, runWorkspaceTypecheck } from "@/lib/workspace/runner";
import { ContainerSandboxProvider } from "@/lib/ai/tools/sandbox-provider";
import { dockerAvailable } from "./fakes";

/**
 * Real build pipeline tests: a workspace starts with ONLY the system skeleton
 * (package.json / tsconfig.json / src/lib/qubits.ts — no example-app template), the
 * agent-side fixture writes the app itself, and lint/typecheck/tests/build run inside
 * the Docker container against the mounted toolchain.
 */

const workspaces: string[] = [];
function makeWorkspace(): string {
  const dir = path.join(process.cwd(), "data", "workspaces", "test-builder-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6));
  mkdirSync(dir, { recursive: true });
  workspaces.push(dir);
  return dir;
}

/** Minimal valid manifest fixture (the agent normally writes this via fs_write). */
function writeFixtureManifest(dir: string): void {
  const manifest = {
    schemaVersion: 1,
    name: "Fixture 应用",
    description: "builder 测试 fixture 应用",
    main: "src/main.tsx",
    collections: [
      {
        name: "notes",
        label: "笔记",
        fields: [{ name: "title", label: "标题", type: "text", required: true, maxLength: 100 }],
        allowedOperations: ["list", "count", "create", "update", "delete"],
      },
    ],
    dependencies: [],
  };
  writeFileSync(path.join(dir, "qubits.manifest.json"), JSON.stringify(manifest, null, 2));
}

/** Minimal app fixture: entry point + component + real test (the agent writes these). */
function writeFixtureApp(dir: string): void {
  writeFileSync(
    path.join(dir, "src", "main.tsx"),
    'import { createRoot } from "react-dom/client";\nimport "./lib/qubits";\nimport { App } from "./App";\n\nfunction ensureRoot(): HTMLElement {\n  const existing = document.getElementById("qubits-root");\n  if (existing) return existing;\n  const el = document.createElement("div");\n  el.id = "qubits-root";\n  document.body.appendChild(el);\n  return el;\n}\n\ncreateRoot(ensureRoot()).render(<App />);\n'
  );
  writeFileSync(
    path.join(dir, "src", "App.tsx"),
    'export function App() {\n  return <div data-testid="fixture-app">fixture</div>;\n}\n'
  );
  writeFileSync(
    path.join(dir, "src", "app.test.ts"),
    'import { describe, expect, it } from "vitest";\n\ndescribe("fixture", () => {\n  it("sanity", () => {\n    expect(1 + 1).toBe(2);\n  });\n});\n'
  );
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

describe("工作区初始化（系统骨架，无模板）", () => {
  it("workspace_init 只写入系统骨架；幂等：第二次初始化不覆盖已有文件", () => {
    const dir = makeWorkspace();
    const first = initWorkspace(dir, { taskId: "task-000000000001" });
    expect(first.seededFrom).toBe("skeleton");
    // System skeleton present, example-app template absent.
    expect(listSourceFiles(dir).some((f) => f.path === "package.json")).toBe(true);
    expect(listSourceFiles(dir).some((f) => f.path === "tsconfig.json")).toBe(true);
    expect(listSourceFiles(dir).some((f) => f.path === "src/lib/qubits.ts")).toBe(true);
    expect(listSourceFiles(dir).some((f) => f.path === "qubits.manifest.json")).toBe(false);
    expect(listSourceFiles(dir).some((f) => f.path === "src/main.tsx")).toBe(false);

    writeFileSync(path.join(dir, "src", "custom.tsx"), "export const marker = 1;\n");
    const second = initWorkspace(dir, { taskId: "task-000000000001" });
    expect(second.seededFrom).toBe("existing");
    expect(readFileSync(path.join(dir, "src", "custom.tsx"), "utf8")).toContain("marker");
  });

  it.skipIf(!dockerAvailable())("骨架 + 自写应用通过 lint、typecheck、tests、build（真实 Docker 容器内执行），并产生真实 preview bundle", async () => {    const dir = makeWorkspace();
    initWorkspace(dir, { taskId: "task-000000000002" });
    writeFixtureManifest(dir);
    writeFixtureApp(dir);
    const sandbox = new ContainerSandboxProvider();

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
    expect(result.bundle!.html).toContain('id="root"');
    expect(result.bundle!.html).toContain("Content-Security-Policy");
    expect(result.bundle!.bytes).toBeGreaterThan(1000);
    // Real artifacts on disk.
    expect(readFileSync(path.join(dir, "dist", "index.html"), "utf8")).toContain("qubits-root");
    expect(JSON.parse(readFileSync(path.join(dir, "dist", "build-report.json"), "utf8")).status).toBe("success");
  }, 300000);

  it("Engineer 未创建 manifest 时 build 失败关闭（INVALID_MANIFEST，严格要求存在）", async () => {
    const dir = makeWorkspace();
    initWorkspace(dir, { taskId: "task-000000000007" });
    // Skeleton-only: no qubits.manifest.json — build must fail, never fabricate one.
    const result = await buildApp(dir);
    expect(result.report.status).toBe("failed");
    expect(result.report.errorCode).toBe("INVALID_MANIFEST");
    expect(result.bundle).toBeNull();
  });

  it("静态扫描阻断 eval / fetch / localStorage（SECURITY_BLOCKED）", async () => {
    const dir = makeWorkspace();
    initWorkspace(dir, { taskId: "task-000000000003" });
    writeFixtureManifest(dir);
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
    writeFixtureManifest(dir);
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
    writeFixtureManifest(dir);
    writeFileSync(path.join(dir, "src", "main.tsx"), "export function App( {\n");
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
    expect(() => safeResolveWorkspacePath(dir, "/etc/passwd")).toThrowError(/绝对路径/);
    expect(() => safeResolveWorkspacePath(dir, "../outside.txt")).toThrowError(/拒绝|路径/);
    expect(() => safeResolveWorkspacePath(dir, ".env")).toThrowError(/敏感文件/);
  });
});

beforeAll(() => {
  delete process.env.SANDBOX_PROVIDER; // container is the only provider
});

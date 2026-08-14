import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeTool } from "@/lib/ai/tools/registry";
import { ArtifactStore } from "@/lib/ai/artifact-store";
import { LocalDevSandboxProvider } from "@/lib/ai/tools/sandbox-provider";
import type { ToolExecutionContext } from "@/lib/ai/tools/types";
import { initWorkspace } from "@/lib/workspace/workspace-manager";
import { createCodeSnapshot } from "@/lib/workspace/snapshot";

/**
 * Workspace/dependency tool tests: workspace_init is idempotent, dependency_add only
 * accepts the server allowlist with fixed versions, manifest writes are validated,
 * and the build/check tools reject uninitialized workspaces.
 */

let wsDir: string;
beforeAll(() => {
  wsDir = mkdtempSync(path.join(tmpdir(), "qubits-wstools-"));
});
afterAll(() => {
  rmSync(wsDir, { recursive: true, force: true });
});

function makeContext(role: ToolExecutionContext["roleId"] = "engineer"): ToolExecutionContext {
  return {
    runId: "run-wstools",
    parentAgentRunId: "agent-mike-000000000001",
    roleId: role,
    depth: 0,
    signal: new AbortController().signal,
    currentManifest: null,
    currentAppId: "test-app-0001",
    currentVersion: 0,
    projectRecords: null,
    dataAdapter: null,
    artifacts: new ArtifactStore("run-wstools"),
    emit: () => undefined,
    childAgentRunner: async () => ({ status: "completed", artifactId: null, summary: "ok", issues: [] }),
    reviewerApproved: false,
    previewCommitted: false,
    workspaceDir: wsDir,
    workspaceReady: false,
    sandbox: new LocalDevSandboxProvider(),
    approvedTools: new Set<string>(),
    counters: { toolCalls: 0, childAgents: 0 },
  };
}

describe("workspace 工具", () => {
  it("未初始化时 fs_write / run_build 返回 WORKSPACE_NOT_INITIALIZED", async () => {
    const ctx = makeContext();
    await expect(executeTool("fs_write", { path: "a.ts", content: "export const a = 1;\n" }, ctx)).rejects.toThrowError(/尚未初始化/);
    await expect(executeTool("run_build", {}, ctx)).rejects.toThrowError(/尚未初始化/);
  });

  it("workspace_init 幂等；模板文件存在且系统文件受保护", async () => {
    const ctx = makeContext();
    const first = await executeTool("workspace_init", {}, ctx) as { initialized: boolean; seededFrom: string };
    expect(first.initialized).toBe(true);
    const second = await executeTool("workspace_init", {}, ctx) as { initialized: boolean; seededFrom: string };
    expect(second.initialized).toBe(false);
    expect(second.seededFrom).toBe("existing");

    const files = await executeTool("workspace_list_files", { maxEntries: 100 }, ctx) as { entries: Array<{ path: string; systemOwned: boolean }> };
    expect(files.entries.some((f) => f.path === "src/main.tsx")).toBe(true);
    expect(files.entries.some((f) => f.path === "qubits.manifest.json")).toBe(true);
    expect(files.entries.find((f) => f.path === "package.json")?.systemOwned).toBe(true);
    expect(files.entries.find((f) => f.path === "src/lib/qubits.ts")?.systemOwned).toBe(true);

    // System-owned files cannot be written.
    await expect(executeTool("fs_write", { path: "package.json", content: "{}" }, ctx)).rejects.toThrowError(/系统维护/);
    await expect(executeTool("fs_write", { path: "src/lib/qubits.ts", content: "// hacked" }, ctx)).rejects.toThrowError(/系统维护/);
    await expect(executeTool("fs_write", { path: "vite.config.ts", content: "export default {}" }, ctx)).rejects.toThrowError(/系统维护/);
  });

  it("qubits.manifest.json 可写但必须通过校验（构建入口被固定）", async () => {
    const ctx = makeContext();
    await executeTool("workspace_init", {}, ctx);
    await expect(
      executeTool("fs_write", { path: "qubits.manifest.json", content: JSON.stringify({ schemaVersion: 1, name: "x", main: "src/evil.tsx" }) }, ctx)
    ).rejects.toThrowError(/校验失败/);
    const manifest = await executeTool("workspace_get_manifest", {}, ctx) as { name: string; main: string };
    expect(manifest.main).toBe("src/main.tsx");
  });
});

describe("dependency 工具", () => {
  it("dependency_add 只接受 allowlist 固定版本", async () => {
    const ctx = makeContext();
    await executeTool("workspace_init", {}, ctx);
    const list = await executeTool("dependency_list", {}, ctx) as { allowlist: Array<{ name: string }> };
    expect(list.allowlist.some((d) => d.name === "lucide-react")).toBe(true);

    await expect(executeTool("dependency_add", { name: "left-pad" }, ctx)).rejects.toThrowError(/allowlist/);
    await expect(executeTool("dependency_add", { name: "https://evil.example/pkg.tgz" }, ctx)).rejects.toThrowError(/allowlist|校验失败/);
    await expect(executeTool("dependency_add", { name: "lucide-react", version: "99.99.99" }, ctx)).rejects.toThrowError(/固定版本/);
    await expect(executeTool("dependency_add", { name: "git+ssh://github.com/x/y" }, ctx)).rejects.toThrowError(/校验失败|allowlist/);

    const added = await executeTool("dependency_add", { name: "lucide-react" }, ctx) as { name: string; version: string };
    expect(added.name).toBe("lucide-react");
    expect(added.version).toBe("0.469.0");

    const removed = await executeTool("dependency_remove", { name: "lucide-react" }, ctx) as { removed: boolean };
    expect(removed.removed).toBe(true);
  });

  it("security_scan 检测 eval / child_process / 密钥", async () => {
    const ctx = makeContext();
    await executeTool("workspace_init", {}, ctx);
    await executeTool(
      "fs_write",
      { path: "src/evil.ts", content: 'const x = eval("1");\nconst cp = require("child_process");\nconst apiKey = "sk-live-abcdefghijklmn";\n' },
      ctx
    );
    const scan = await executeTool("security_scan", {}, ctx) as { status: string; findings: Array<{ rule: string }> };
    expect(scan.status).toBe("blocked");
    expect(scan.findings.map((f) => f.rule)).toEqual(
      expect.arrayContaining(["NO_EVAL", "NO_CHILD_PROCESS", "NO_CREDENTIALS"])
    );
  });
});

describe("initWorkspace 与快照种子", () => {
  it("新任务从快照种子创建（在既有项目上修改应用）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qubits-seed-"));
    try {
      initWorkspace(dir, { taskId: "task-a" });
      writeFileSync(path.join(dir, "src", "App.tsx"), "export function App() { return null; }\n");
      const snap = createCodeSnapshot("prj-seed-00000001", dir);
      const dir2 = mkdtempSync(path.join(tmpdir(), "qubits-seed2-"));
      const info = initWorkspace(dir2, { taskId: "task-b", sourceDir: snap.dir });
      expect(info.seededFrom).toBe("snapshot");
      expect(readFileSync(path.join(dir2, "src", "App.tsx"), "utf8")).toContain("return null");
      rmSync(dir2, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(path.join(process.cwd(), "data", "snapshots", "prj-seed-00000001"), { recursive: true, force: true });
    }
  });
});

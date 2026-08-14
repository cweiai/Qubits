import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeTool, getToolDefinition, getToolNamesForRole, listToolNames } from "@/lib/ai/tools/registry";
import { ArtifactStore } from "@/lib/ai/artifact-store";
import { resetApprovalsForTests } from "@/lib/ai/tools/approval";
import { LocalDevSandboxProvider } from "@/lib/ai/tools/sandbox-provider";
import type { ToolExecutionContext } from "@/lib/ai/tools/types";
import { makeTaskManifest } from "./fixtures";

let wsDir: string;
function makeContext(role: ToolExecutionContext["roleId"] = "engineer", overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  const artifacts = new ArtifactStore("run-p0");
  return {
    runId: "run-p0",
    parentAgentRunId: "agent-mike-000000000001",
    roleId: role,
    depth: 0,
    signal: new AbortController().signal,
    currentManifest: makeTaskManifest(),
    currentAppId: "test-task-app",
    currentVersion: 1,
    projectRecords: [{ id: "r1", title: "写周报", priority: "高", completed: false, amount: 10 }],
    dataAdapter: null,
    artifacts,
    emit: () => undefined,
    childAgentRunner: async () => ({ status: "completed", artifactId: null, summary: "ok", issues: [] }),
    reviewerApproved: true,
    previewCommitted: false,
    workspaceDir: wsDir,
    workspaceReady: true,
    sandbox: new LocalDevSandboxProvider(),
    approvedTools: new Set<string>(),
    counters: { toolCalls: 0, childAgents: 0 },
    ...overrides,
  };
}

beforeAll(() => {
  wsDir = mkdtempSync(path.join(tmpdir(), "qubits-ws-"));
  process.env.SANDBOX_COMMAND_ALLOWLIST = "npm,node,npx,next,eslint,tsc,git";
  process.env.SANDBOX_NETWORK_ENABLED = "false";
  resetApprovalsForTests();
});

describe("Registry 与权限", () => {
  it("所有工具都有唯一名称与完整定义", () => {
    const names = listToolNames();
    expect(names.length).toBeGreaterThanOrEqual(50);
    for (const name of names) {
      const def = getToolDefinition(name);
      expect(def).toBeTruthy();
      expect(def!.argsSchema).toBeTruthy();
      expect(def!.resultSchema).toBeTruthy();
      expect(def!.risk).toBeTruthy();
    }
  });

  it("能力矩阵：非迈克不能 delegate；艾玛不能写文件；大卫不能 fs_list", () => {
    expect(getToolNamesForRole("team_leader")).toContain("delegate_to_agent");
    expect(getToolNamesForRole("product_manager")).not.toContain("delegate_to_agent");
    expect(getToolNamesForRole("product_manager")).not.toContain("fs_write");
    expect(getToolNamesForRole("data_scientist")).not.toContain("fs_list");
    expect(getToolNamesForRole("engineer")).toContain("sandbox_exec");
    expect(getToolNamesForRole("reviewer")).toContain("secret_scan");
  });

  it("越权调用被拒绝；未知工具被拒绝", async () => {
    await expect(executeTool("delegate_to_agent", { targetRole: "engineer", task: "x", expectedOutput: "code_workspace" }, makeContext("engineer"))).rejects.toThrowError(/无权/);
    await expect(executeTool("fs_write", { path: "a.txt", content: "x" }, makeContext("product_manager"))).rejects.toThrowError(/无权/);
    await expect(executeTool("no_such_tool", {}, makeContext())).rejects.toThrowError(/未知工具/);
  });
});

describe("文件系统 jail", () => {
  it("workspace 内写入/读取/搜索/stat", async () => {
    const ctx = makeContext();
    await executeTool("fs_write", { path: "src/app.tsx", content: "export const App = () => 1;\n" }, ctx);
    const read = await executeTool("fs_read", { path: "src/app.tsx", maxBytes: 1000 }, ctx) as { content: string };
    expect(read.content).toContain("export const App");
    const search = await executeTool("fs_search", { pattern: "App", glob: "**/*", maxResults: 10 }, ctx) as { matches: Array<{ path: string }> };
    expect(search.matches.some((m) => m.path === "src/app.tsx")).toBe(true);
  });

  it("../ 与绝对路径被拒绝；敏感文件被拒绝", async () => {
    const ctx = makeContext();
    await expect(executeTool("fs_read", { path: "../.env", maxBytes: 100 }, ctx)).rejects.toThrowError(/路径|敏感|工作区/);
    await expect(executeTool("fs_read", { path: "/etc/passwd", maxBytes: 100 }, ctx)).rejects.toThrowError(/绝对路径/);
    await expect(executeTool("fs_write", { path: ".env", content: "OPENAI_API_KEY=sk-xxx" }, ctx)).rejects.toThrowError(/敏感/);
  });

  it("fs_patch 未命中不破坏原文件；fs_delete 需要审批", async () => {
    const ctx = makeContext();
    await executeTool("fs_write", { path: "note.txt", content: "hello world\n" }, ctx);
    await expect(executeTool("fs_patch", { path: "note.txt", oldText: "不存在", newText: "x", replaceAll: false }, ctx)).rejects.toThrowError(/未找到/);
    const read = await executeTool("fs_read", { path: "note.txt", maxBytes: 100 }, ctx) as { content: string };
    expect(read.content).toBe("hello world\n");
    await expect(executeTool("fs_delete", { path: "note.txt", soft: true }, ctx)).rejects.toThrowError(/审批/);
    grantApprovalForTest(ctx, "fs_delete");
    const del = await executeTool("fs_delete", { path: "note.txt", soft: true }, ctx) as { soft: boolean };
    expect(del.soft).toBe(true);
  });
});

function grantApprovalForTest(context: ToolExecutionContext, toolName: string): void {
  // Write directly to the run-level granted set (equivalent to an approval API grant).
  context.approvedTools.add(toolName);
}

describe("沙盒 Shell", () => {
  it("sandbox_exec 真实执行（node -e），命令白名单生效", async () => {
    const ctx = makeContext();
    const result = await executeTool("sandbox_exec", { command: "node", args: ["-e", "console.log('hello-from-sandbox')"], cwd: "", timeoutMs: 15000 }, ctx) as { exitCode: number; stdout: string };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello-from-sandbox");
    const denied = await executeTool("sandbox_exec", { command: "rm", args: ["-rf", "/"], cwd: "", timeoutMs: 5000 }, ctx) as { exitCode: number };
    expect(denied.exitCode).toBe(126);
  });

  it("敏感环境变量被剥离", async () => {
    process.env.OPENAI_API_KEY = "sk-test-should-not-leak";
    const ctx = makeContext();
    const result = await executeTool("sandbox_exec", { command: "node", args: ["-e", "console.log(process.env.OPENAI_API_KEY || 'EMPTY')"], cwd: "", timeoutMs: 15000 }, ctx) as { stdout: string };
    expect(result.stdout).toContain("EMPTY");
    delete process.env.OPENAI_API_KEY;
  });

  it("超时返回 timedOut", async () => {
    const ctx = makeContext();
    const result = await executeTool("sandbox_exec", { command: "node", args: ["-e", "setInterval(()=>{},1000)"], cwd: "", timeoutMs: 1500 }, ctx) as { timedOut: boolean };
    expect(result.timedOut).toBe(true);
  });
});

describe("工程检查与数据工具", () => {
  it("run_lint 对真实 lint 错误返回 LINT_FAILED（真实 eslint 执行）", async () => {
    const ctx = makeContext();
    await executeTool("workspace_init", {}, ctx);
    await executeTool("fs_write", { path: "src/bad.ts", content: "const unused = 1;\n" }, ctx);
    await expect(executeTool("run_lint", { timeoutMs: 60000 }, ctx)).rejects.toThrowError(/unused|失败/);
  }, 60000);

  it("数据工具尊重 manifest allowlist", async () => {
    const ctx = makeContext("data_scientist");
    const count = await executeTool("count_records", { collection: "task" }, ctx) as { count: number };
    expect(count.count).toBe(1);
    await expect(executeTool("query_records", { collection: "undeclared", limit: 10 }, ctx)).rejects.toThrowError(/未声明/);
    await expect(executeTool("aggregate_records", { collection: "task", fieldId: "amount", metric: "sum" }, ctx)).rejects.toThrowError(/未声明|number/);
    // David can't query undeclared fields (validated in aggregate); non-data_scientist roles can't query.
    await expect(executeTool("query_records", { collection: "task", limit: 10 }, makeContext("product_manager"))).rejects.toThrowError(/无权/);
  });
});

describe("P2 适配器 NOT_CONFIGURED", () => {
  it("未配置外部服务时返回明确错误", async () => {
    await expect(executeTool("publish_preview", {}, makeContext("team_leader"))).rejects.toThrowError(/未配置部署平台/);
    await expect(executeTool("create_migration_plan", {}, makeContext("team_leader"))).rejects.toThrowError(/未配置迁移服务/);
    await expect(executeTool("sandbox_network_request", { url: "https://example.com", method: "GET", maxBytes: 1000 }, makeContext("engineer"))).rejects.toThrowError(/审批|未配置/);
  });
});

afterAll(() => {
  rmSync(wsDir, { recursive: true, force: true });
});

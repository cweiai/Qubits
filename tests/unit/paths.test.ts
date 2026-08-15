import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  assertWorkspaceTreeSafe,
  assertWorkspaceUsable,
  clearWorkspaceBlock,
  safeReadFile,
  safeResolveWorkspacePath,
  safeWriteFile,
} from "@/lib/workspace/paths";
import { initWorkspace } from "@/lib/workspace/workspace-manager";
import { buildApp } from "@/lib/workspace/builder";
import { executeTool } from "@/lib/ai/tools/registry";
import { ArtifactStore } from "@/lib/ai/artifact-store";
import type { ToolExecutionContext } from "@/lib/ai/tools/types";
import { ContainerSandboxProvider, type SandboxProvider } from "@/lib/ai/tools/sandbox-provider";
import { FakeSandboxProvider, dockerAvailable } from "./fakes";
import { makeTaskManifest } from "./fixtures";

/**
 * Workspace path jail + TOCTOU guard tests: absolute/../-Windows/NUL rejection,
 * final and intermediate symlink rejection (incl. escape to outside), special files,
 * tool-level enforcement, fail-closed build/snapshot, and a real-Docker integration
 * test where the container plants a symlink and host-side reads/writes must fail.
 */

let wsDir: string;
const scratchDirs: string[] = [];

function makeScratch(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function makeContext(workspaceDir: string, sandbox: SandboxProvider = new FakeSandboxProvider(), role: ToolExecutionContext["roleId"] = "engineer"): ToolExecutionContext {
  return {
    runId: "run-paths",
    parentAgentRunId: "agent-mike-000000000001",
    roleId: role,
    depth: 0,
    signal: new AbortController().signal,
    currentManifest: makeTaskManifest(),
    currentAppId: "test-task-app",
    currentVersion: 1,
    projectRecords: null,
    dataAdapter: null,
    artifacts: new ArtifactStore("run-paths"),
    emit: () => undefined,
    childAgentRunner: async () => ({ status: "completed", artifactId: null, summary: "ok", issues: [] }),
    quality: { buildPassed: true, testsPassed: true, securityScanPassed: true },
    previewCommitted: false,
    workspaceDir,
    workspaceReady: true,
    sandbox,
    approvedTools: new Set<string>(),
    counters: { toolCalls: 0, childAgents: 0 },
  };
}

beforeAll(() => {
  wsDir = makeScratch("qubits-jail-");
  process.env.SANDBOX_COMMAND_ALLOWLIST = "npm,node,npx,next,eslint,tsc,git,bash,sh";
});

afterAll(() => {
  for (const dir of scratchDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("safeResolveWorkspacePath（统一 jail）", () => {
  it("拒绝绝对路径 /etc/hosts", () => {
    expect(() => safeResolveWorkspacePath(wsDir, "/etc/hosts")).toThrowError(/绝对路径/);
  });

  it("拒绝 ../package.json", () => {
    expect(() => safeResolveWorkspacePath(wsDir, "../package.json")).toThrowError(/拒绝|\.\./);
    expect(() => safeResolveWorkspacePath(wsDir, "a/../../package.json")).toThrowError(/拒绝|\.\./);
  });

  it("拒绝 Windows 风格与混合分隔符路径", () => {
    expect(() => safeResolveWorkspacePath(wsDir, "src\\app.tsx")).toThrowError(/分隔符/);
    expect(() => safeResolveWorkspacePath(wsDir, "C:\\temp\\x.ts")).toThrowError(/分隔符/);
    expect(() => safeResolveWorkspacePath(wsDir, "a/b\\c")).toThrowError(/分隔符/);
    expect(() => safeResolveWorkspacePath(wsDir, "\\\\server\\share")).toThrowError(/分隔符/);
  });

  it("拒绝 NUL、空路径与超长路径", () => {
    expect(() => safeResolveWorkspacePath(wsDir, "a\0b")).toThrowError(/非法字符/);
    expect(() => safeResolveWorkspacePath(wsDir, "")).toThrowError(/为空|不合法/);
    expect(() => safeResolveWorkspacePath(wsDir, "x".repeat(500))).toThrowError(/过长|不合法/);
  });

  it("拒绝最终组件是符号链接（含指向 workspace 外部）", () => {
    const outside = makeScratch("qubits-outside-");
    writeFileSync(path.join(outside, "secret.txt"), "external-secret");
    const dir = makeScratch("qubits-final-link-");
    writeFileSync(path.join(dir, "ok.txt"), "inside");
    symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "link.txt"));
    expect(() => safeResolveWorkspacePath(dir, "link.txt")).toThrowError(/符号链接/);
    expect(() => safeReadFile(dir, "link.txt")).toThrowError(/符号链接|PATH_ESCAPE|拒绝/);
    expect(() => safeWriteFile(dir, "link.txt", "pwn")).toThrowError(/符号链接|PATH_ESCAPE|拒绝/);
    // The external marker must remain untouched.
    expect(readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("external-secret");
  });

  it("拒绝中间目录是符号链接（escape/../../ 型逃逸）", () => {
    const outside = makeScratch("qubits-outside2-");
    mkdirSync(path.join(outside, "Users", "cweiai", "Documents"), { recursive: true });
    writeFileSync(path.join(outside, "Users", "cweiai", "Documents", "secret.txt"), "external-secret");
    const dir = makeScratch("qubits-mid-link-");
    // workspace/escape -> outside directory (the classic middle-directory escape).
    symlinkSync(outside, path.join(dir, "escape"));
    expect(() => safeResolveWorkspacePath(dir, "escape/Users/cweiai/Documents/secret.txt")).toThrowError(/符号链接/);
    expect(() => safeReadFile(dir, "escape/Users/cweiai/Documents/secret.txt")).toThrowError();
    expect(() => safeWriteFile(dir, "escape/Users/cweiai/Documents/secret.txt", "pwn")).toThrowError();
    expect(readFileSync(path.join(outside, "Users", "cweiai", "Documents", "secret.txt"), "utf8")).toBe("external-secret");
  });

  it("拒绝特殊文件（FIFO）", () => {
    const dir = makeScratch("qubits-fifo-");
    const fifoPath = path.join(dir, "pipe");
    try {
      const result = spawnSync("mkfifo", [fifoPath], { timeout: 3000 });
      if (result.error || result.status !== 0) return; // mkfifo unavailable on this host
    } catch {
      return;
    }
    expect(() => safeResolveWorkspacePath(dir, "pipe")).toThrowError(/特殊文件/);
  });

  it("新文件路径检查最近存在的父目录：父目录是符号链接时拒绝创建", () => {
    const outside = makeScratch("qubits-outside3-");
    const dir = makeScratch("qubits-newfile-");
    symlinkSync(outside, path.join(dir, "linked-dir"));
    expect(() => safeResolveWorkspacePath(dir, "linked-dir/new.txt")).toThrowError(/符号链接/);
    expect(() => safeWriteFile(dir, "linked-dir/new.txt", "x")).toThrowError();
    expect(existsSync(path.join(outside, "new.txt"))).toBe(false);
  });
});

describe("assertWorkspaceTreeSafe / SECURITY_BLOCKED", () => {
  it("检测符号链接后标记 SECURITY_BLOCKED，后续访问失败关闭，clear 后恢复", () => {
    const dir = makeScratch("qubits-block-");
    const outside = makeScratch("qubits-outside4-");
    writeFileSync(path.join(dir, "normal.txt"), "ok");
    symlinkSync(outside, path.join(dir, "escape"));
    expect(() => assertWorkspaceTreeSafe(dir)).toThrowError(/SECURITY_BLOCKED|符号链接/);
    expect(() => assertWorkspaceUsable(dir)).toThrowError(/SECURITY_BLOCKED|安全阻断/);
    expect(() => safeReadFile(dir, "normal.txt")).toThrowError(/SECURITY_BLOCKED|安全阻断/);
    clearWorkspaceBlock(dir);
    // After clearing the state, the symlink is still there: the next scan blocks again.
    expect(() => assertWorkspaceTreeSafe(dir)).toThrowError(/SECURITY_BLOCKED|符号链接/);
  });
});

describe("文件工具级 jail（executeTool）", () => {
  it("workspace 内创建符号链接后 fs_read 不能读取外部文件", async () => {
    const dir = makeScratch("qubits-fsread-");
    initWorkspace(dir, { taskId: "task-jail-00000001" });
    const outside = makeScratch("qubits-outside5-");
    writeFileSync(path.join(outside, "secret.txt"), "external-secret");
    symlinkSync(outside, path.join(dir, "escape"));
    const ctx = makeContext(dir);
    await expect(executeTool("fs_read", { path: "escape/secret.txt", maxBytes: 100 }, ctx)).rejects.toThrowError(/符号链接|SECURITY_BLOCKED|拒绝/);
  });

  it("fs_write 不能通过符号链接修改外部文件（marker 保持不变）", async () => {
    const dir = makeScratch("qubits-fswrite-");
    initWorkspace(dir, { taskId: "task-jail-00000002" });
    const outside = makeScratch("qubits-outside6-");
    writeFileSync(path.join(outside, "marker.txt"), "original-marker");
    symlinkSync(outside, path.join(dir, "escape"));
    const ctx = makeContext(dir);
    await expect(executeTool("fs_write", { path: "escape/marker.txt", content: "pwned" }, ctx)).rejects.toThrowError();
    expect(readFileSync(path.join(outside, "marker.txt"), "utf8")).toBe("original-marker");
  });

  it("fs_copy / fs_move / fs_delete 不能越界", async () => {
    const dir = makeScratch("qubits-fsops-");
    initWorkspace(dir, { taskId: "task-jail-00000003" });
    // No template manifest: write one as the copy/move source fixture.
    writeFileSync(path.join(dir, "qubits.manifest.json"), JSON.stringify({ schemaVersion: 1, name: "x", description: "x", main: "src/main.tsx", collections: [], dependencies: [] }));
    const outside = makeScratch("qubits-outside7-");
    writeFileSync(path.join(outside, "victim.txt"), "outside-content");
    symlinkSync(outside, path.join(dir, "escape"));
    const ctx = makeContext(dir);
    // Copy: source through the symlink is refused.
    await expect(executeTool("fs_copy", { from: "escape/victim.txt", to: "copy.txt" }, ctx)).rejects.toThrowError();
    // Copy: destination outside the workspace is refused.
    await expect(executeTool("fs_copy", { from: "qubits.manifest.json", to: "../victim.txt" }, ctx)).rejects.toThrowError();
    // Move: through the symlink refused.
    await expect(executeTool("fs_move", { from: "escape/victim.txt", to: "moved.txt" }, ctx)).rejects.toThrowError();
    await expect(executeTool("fs_move", { from: "qubits.manifest.json", to: "../moved.txt" }, ctx)).rejects.toThrowError();
    // Delete: outside path refused.
    await expect(executeTool("fs_delete", { path: "../victim.txt", soft: true }, ctx)).rejects.toThrowError();
    expect(readFileSync(path.join(outside, "victim.txt"), "utf8")).toBe("outside-content");
  });

  it("review_changes(\"/\") 与 review_changes(\"../\") 被拒绝", async () => {
    const dir = makeScratch("qubits-review-");
    initWorkspace(dir, { taskId: "task-jail-00000004" });
    const ctx = makeContext(dir, new FakeSandboxProvider(), "engineer");
    await expect(executeTool("review_changes", { path: "/" }, ctx)).rejects.toThrowError(/绝对路径/);
    await expect(executeTool("review_changes", { path: "../" }, ctx)).rejects.toThrowError(/拒绝|\.\./);
  });

  it("secret_scan 不跟随符号链接（发现符号链接即失败关闭）", async () => {
    const dir = makeScratch("qubits-scan-");
    initWorkspace(dir, { taskId: "task-jail-00000005" });
    const outside = makeScratch("qubits-outside8-");
    writeFileSync(path.join(outside, "leak.txt"), "sk-live-abcdefghijklmnop");
    symlinkSync(outside, path.join(dir, "escape"));
    const ctx = makeContext(dir, new FakeSandboxProvider(), "engineer");
    await expect(executeTool("secret_scan", {}, ctx)).rejects.toThrowError(/SECURITY_BLOCKED|符号链接/);
  });

  it("build 遇到符号链接失败关闭（failed report，errorCode=SECURITY_BLOCKED）", async () => {
    const dir = makeScratch("qubits-build-");
    initWorkspace(dir, { taskId: "task-jail-00000006" });
    const outside = makeScratch("qubits-outside9-");
    symlinkSync(outside, path.join(dir, "escape"));
    const result = await buildApp(dir);
    expect(result.report.status).toBe("failed");
    expect(result.report.errorCode).toBe("SECURITY_BLOCKED");
    expect(result.bundle).toBeNull();
  });
});

describe("真实 Docker 集成：容器种植符号链接逃逸", () => {
  const enabled = dockerAvailable();
  it.skipIf(!enabled)("容器内 ln -s 后，宿主 fs_read/fs_write 必须失败且外部 marker 不变", async () => {
    const ws = path.join(homedir(), ".qubits-jail-docker-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6));
    const outside = path.join(homedir(), ".qubits-jail-outside-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6));
    mkdirSync(ws, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "marker.txt"), "outside-secret-marker");
    try {
      initWorkspace(ws, { taskId: "task-jail-docker" });
      const ctx = makeContext(ws, new ContainerSandboxProvider());
      // The container plants a symlink pointing at the HOST outside directory.
      await expect(
        executeTool("bash", { command: "ln -s " + outside + " escape", timeoutMs: 30000 }, ctx)
      ).rejects.toThrowError(/SECURITY_BLOCKED|符号链接/);
      // Host-side reads through the planted symlink must fail.
      await expect(executeTool("fs_read", { path: "escape/marker.txt", maxBytes: 100 }, ctx)).rejects.toThrowError(/SECURITY_BLOCKED|符号链接|拒绝/);
      expect(() => safeReadFile(ws, "escape/marker.txt")).toThrowError();
      // Host-side writes must fail and the external marker must stay unchanged.
      await expect(executeTool("fs_write", { path: "escape/marker.txt", content: "pwned" }, ctx)).rejects.toThrowError();
      expect(() => safeWriteFile(ws, "escape/marker.txt", "pwned")).toThrowError();
      expect(readFileSync(path.join(outside, "marker.txt"), "utf8")).toBe("outside-secret-marker");
    } finally {
      clearWorkspaceBlock(ws);
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }, 120000);
});

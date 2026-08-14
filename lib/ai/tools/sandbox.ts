import "server-only";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { ServerToolDefinition, ToolExecutionContext } from "./types";
import { ToolExecutionError } from "./types";
import {
  sandboxCreateArgsSchema, sandboxCreateResultSchema, sandboxExecArgsSchema, sandboxExecResultSchema,
  sandboxStreamArgsSchema, sandboxStreamResultSchema, sandboxReadLogsArgsSchema, sandboxReadLogsResultSchema,
  sandboxKillArgsSchema, sandboxKillResultSchema, sandboxResetArgsSchema, sandboxResetResultSchema,
  sandboxGetProcessArgsSchema, sandboxGetProcessResultSchema, sandboxExportArgsSchema, sandboxExportResultSchema,
  sandboxNetworkArgsSchema, sandboxNetworkResultSchema,
} from "./schemas";

/**
 * Sandbox shell tools: real spawn execution (no shell:true), command allowlist, timeout,
 * output cap; networking disabled by default (network tool only with an explicit allowlist).
 */

const streamLogs = new Map<string, string>();

function requireSandbox(context: ToolExecutionContext) {
  if (!context.sandbox) {
    throw new ToolExecutionError("SANDBOX_NOT_CONFIGURED", "未配置沙盒 provider", false);
  }
  return context.sandbox;
}

export const sandboxCreateTool: ServerToolDefinition<{ template: "empty" | "qubits-app" }, { sandboxId: string; provider: string; workspaceDir: string; demoMode: boolean }> = {
  name: "sandbox_create",
  description: "创建/初始化当前 run 的隔离 workspace（Demo 模式：本地目录 + 白名单命令）。",
  argsSchema: sandboxCreateArgsSchema,
  resultSchema: sandboxCreateResultSchema,
  allowedRoles: ["engineer"],
  risk: "medium",
  requiresApproval: false,
  async execute(_args, context) {
    const provider = requireSandbox(context);
    const info = await provider.create(context.workspaceDir);
    return { sandboxId: info.sandboxId, provider: info.provider, workspaceDir: info.workspaceDir, demoMode: info.demoMode };
  },
};

export const sandboxExecTool: ServerToolDefinition<{ command: string; args: string[]; cwd: string; timeoutMs: number }, { exitCode: number; stdout: string; stderr: string; timedOut: boolean; durationMs: number }> = {
  name: "sandbox_exec",
  description: "在 workspace 内执行白名单命令（command+args，无 shell），返回 exitCode/输出。",
  argsSchema: sandboxExecArgsSchema,
  resultSchema: sandboxExecResultSchema,
  allowedRoles: ["engineer"],
  risk: "medium",
  requiresApproval: false,
  async execute(args, context) {
    const provider = requireSandbox(context);
    const cwd = args.cwd ? path.join(context.workspaceDir, args.cwd) : context.workspaceDir;
    return provider.exec({ command: args.command, args: args.args, cwd, timeoutMs: args.timeoutMs });
  },
};

export const sandboxExecStreamTool: ServerToolDefinition<{ command: string; args: string[]; cwd: string; timeoutMs: number }, { streamId: string; exitCode: number; timedOut: boolean }> = {
  name: "sandbox_exec_stream",
  description: "流式执行命令，输出经 sandbox_log 事件回传。",
  argsSchema: sandboxStreamArgsSchema,
  resultSchema: sandboxStreamResultSchema,
  allowedRoles: ["engineer"],
  risk: "medium",
  requiresApproval: false,
  async execute(args, context) {
    const provider = requireSandbox(context);
    const streamId = "log-" + Math.random().toString(36).slice(2, 10);
    streamLogs.set(streamId, "");
    const cwd = args.cwd ? path.join(context.workspaceDir, args.cwd) : context.workspaceDir;
    const result = await provider.exec({ command: args.command, args: args.args, cwd, timeoutMs: args.timeoutMs }, (chunk) => {
      streamLogs.set(streamId, (streamLogs.get(streamId) ?? "") + chunk);
      context.emit({ type: "sandbox_log", streamId, chunk: chunk.slice(0, 2000) });
    });
    return { streamId, exitCode: result.exitCode, timedOut: result.timedOut };
  },
};

export const sandboxReadLogsTool: ServerToolDefinition<{ streamId: string; maxBytes: number }, { streamId: string; logs: string }> = {
  name: "sandbox_read_logs",
  description: "读取流式执行日志。",
  argsSchema: sandboxReadLogsArgsSchema,
  resultSchema: sandboxReadLogsResultSchema,
  allowedRoles: ["engineer", "reviewer", "team_leader"],
  risk: "low",
  requiresApproval: false,
  async execute(args) {
    const logs = (streamLogs.get(args.streamId) ?? "").slice(0, args.maxBytes);
    return { streamId: args.streamId, logs };
  },
};

export const sandboxKillTool: ServerToolDefinition<{ pid: number }, { pid: number; killed: boolean }> = {
  name: "sandbox_kill_process",
  description: "终止沙盒内的子进程。",
  argsSchema: sandboxKillArgsSchema,
  resultSchema: sandboxKillResultSchema,
  allowedRoles: ["engineer"],
  risk: "medium",
  requiresApproval: false,
  async execute(args, context) {
    const provider = requireSandbox(context);
    return { pid: args.pid, killed: await provider.kill(args.pid) };
  },
};

export const sandboxGetProcessTool: ServerToolDefinition<{ pid: number }, { pid: number; alive: boolean; command: string }> = {
  name: "sandbox_get_process",
  description: "查询沙盒子进程状态。",
  argsSchema: sandboxGetProcessArgsSchema,
  resultSchema: sandboxGetProcessResultSchema,
  allowedRoles: ["engineer", "reviewer"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const provider = requireSandbox(context);
    return { pid: args.pid, alive: provider.isAlive(args.pid), command: "" };
  },
};

export const sandboxResetTool: ServerToolDefinition<{ preserve: string[] }, { reset: true }> = {
  name: "sandbox_reset",
  description: "清空当前 run 的 workspace（不影响其他 run）。",
  argsSchema: sandboxResetArgsSchema,
  resultSchema: sandboxResetResultSchema,
  allowedRoles: ["engineer"],
  risk: "high",
  requiresApproval: true,
  async execute(_args, context) {
    const provider = requireSandbox(context);
    await provider.reset(context.workspaceDir);
    rmSync(context.workspaceDir, { recursive: true, force: true });
    await provider.create(context.workspaceDir);
    return { reset: true };
  },
};

export const sandboxExportArtifactTool: ServerToolDefinition<{ path: string }, { artifactId: string; bytes: number }> = {
  name: "sandbox_export_artifact",
  description: "把 workspace 内文件导出为当前 run 的 artifact。",
  argsSchema: sandboxExportArgsSchema,
  resultSchema: sandboxExportResultSchema,
  allowedRoles: ["engineer"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const full = path.resolve(context.workspaceDir, args.path);
    if (!full.startsWith(path.resolve(context.workspaceDir))) throw new ToolExecutionError("PATH_ESCAPE", "拒绝工作区外路径", false);
    const content = readFileSync(full, "utf8");
    const ref = context.artifacts.put({ kind: "file", createdBy: "engineer", parentAgentRunId: context.parentAgentRunId, value: { path: args.path, content } });
    return { artifactId: ref.id, bytes: Buffer.byteLength(content) };
  },
};

const NETWORK_ALLOWLIST = (process.env.SANDBOX_NETWORK_ALLOWLIST || "").split(",").map((d) => d.trim()).filter(Boolean);

export const sandboxNetworkRequestTool: ServerToolDefinition<{ url: string; method: "GET" | "POST"; maxBytes: number }, { status: number; body: string }> = {
  name: "sandbox_network_request",
  description: "仅在显式配置的 HTTPS 域名 allowlist 内发起网络请求；默认 NOT_CONFIGURED。",
  argsSchema: sandboxNetworkArgsSchema,
  resultSchema: sandboxNetworkResultSchema,
  allowedRoles: ["engineer"],
  risk: "high",
  requiresApproval: true,
  async execute(args) {
    if (process.env.SANDBOX_NETWORK_ENABLED !== "true" || NETWORK_ALLOWLIST.length === 0) {
      throw new ToolExecutionError("SANDBOX_NETWORK_NOT_CONFIGURED", "沙盒网络未配置（SANDBOX_NETWORK_ENABLED=true + SANDBOX_NETWORK_ALLOWLIST）", false);
    }
    const url = new URL(args.url);
    if (url.protocol !== "https:" || !NETWORK_ALLOWLIST.includes(url.hostname)) {
      throw new ToolExecutionError("NETWORK_DENIED", "域名不在 allowlist 中", false);
    }
    const response = await fetch(url.toString(), { method: args.method, signal: AbortSignal.timeout(10_000) });
    const body = (await response.text()).slice(0, args.maxBytes);
    return { status: response.status, body };
  },
};

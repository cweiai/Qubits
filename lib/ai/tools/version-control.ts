import "server-only";
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { ServerToolDefinition } from "./types";
import { ToolExecutionError } from "./types";
import { z } from "zod";
import { notConfiguredResultSchema } from "./schemas";
import { assertApproved } from "./approval";

/**
 * Version/checkpoint tools: git tools work only when the workspace is a git repo;
 * create_checkpoint/restore_checkpoint use workspace snapshots (no external service).
 */

const checkpointsDir = path.join(process.cwd(), "data", "checkpoints");

export const gitStatusTool: ServerToolDefinition<Record<string, never>, { available: false; provider: string; reason: string }> = {
  name: "git_status",
  description: "workspace git 状态（非 git 仓库时 NOT_CONFIGURED）。",
  argsSchema: z.object({}).strict(),
  resultSchema: notConfiguredResultSchema,
  allowedRoles: ["engineer", "reviewer", "team_leader"],
  risk: "low",
  requiresApproval: false,
  async execute(_args, context) {
    const hasGit = existsSync(path.join(context.workspaceDir, ".git"));
    if (!hasGit) throw new ToolExecutionError("GIT_NOT_CONFIGURED", "workspace 不是 git 仓库", false);
    const provider = context.sandbox;
    const result = provider
      ? await provider.exec({ command: "git", args: ["status", "--porcelain"], cwd: context.workspaceDir, timeoutMs: 15000 })
      : null;
    if (!result) throw new ToolExecutionError("GIT_NOT_CONFIGURED", "未配置沙盒 provider", false);
    throw new ToolExecutionError("GIT_UNSUPPORTED", "git_status 需要 provider 支持（demo 模式请使用 checkpoint）", false);
  },
};

export const gitDiffTool: ServerToolDefinition<Record<string, never>, { available: false; provider: string; reason: string }> = {
  name: "git_diff",
  description: "workspace git diff（非 git 仓库时 NOT_CONFIGURED）。",
  argsSchema: z.object({}).strict(),
  resultSchema: notConfiguredResultSchema,
  allowedRoles: ["engineer", "reviewer", "team_leader"],
  risk: "low",
  requiresApproval: false,
  async execute(_args, context) {
    if (!existsSync(path.join(context.workspaceDir, ".git"))) {
      throw new ToolExecutionError("GIT_NOT_CONFIGURED", "workspace 不是 git 仓库", false);
    }
    throw new ToolExecutionError("GIT_UNSUPPORTED", "git_diff 需要 provider 支持（demo 模式请使用 create_checkpoint）", false);
  },
};

export const createCheckpointTool: ServerToolDefinition<{ name: string }, { checkpointId: string; name: string; files: number }> = {
  name: "create_checkpoint",
  description: "对当前 run 的 workspace 打快照（可 restore）。",
  argsSchema: z.object({ name: z.string().min(1).max(120) }),
  resultSchema: z.object({ checkpointId: z.string(), name: z.string(), files: z.number().int() }),
  allowedRoles: ["engineer", "team_leader"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const checkpointId = "ckp-" + Math.random().toString(36).slice(2, 10);
    const target = path.join(checkpointsDir, context.runId, checkpointId);
    cpSync(context.workspaceDir, target, { recursive: true });
    const files = countFiles(target);
    return { checkpointId, name: args.name, files };
  },
};

export const restoreCheckpointTool: ServerToolDefinition<{ checkpointId: string }, { restored: true; checkpointId: string }> = {
  name: "restore_checkpoint",
  description: "恢复 workspace 快照（破坏性，需要审批）。",
  argsSchema: z.object({ checkpointId: z.string().min(4).max(64) }),
  resultSchema: z.object({ restored: z.literal(true), checkpointId: z.string() }),
  allowedRoles: ["engineer", "team_leader"],
  risk: "critical",
  requiresApproval: true,
  async execute(args, context) {
    assertApproved(context, "restore_checkpoint");
    const source = path.join(checkpointsDir, context.runId, args.checkpointId);
    if (!existsSync(source)) throw new ToolExecutionError("NOT_FOUND", "检查点不存在", false);
    rmSync(context.workspaceDir, { recursive: true, force: true });
    cpSync(source, context.workspaceDir, { recursive: true });
    return { restored: true, checkpointId: args.checkpointId };
  },
};

export const createPatchTool: ServerToolDefinition<{ name: string }, { patchId: string; name: string; bytes: number }> = {
  name: "create_patch",
  description: "把当前 workspace 相对最近检查点的变化导出为 patch artifact。",
  argsSchema: z.object({ name: z.string().min(1).max(120) }),
  resultSchema: z.object({ patchId: z.string(), name: z.string(), bytes: z.number().int() }),
  allowedRoles: ["engineer"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const patchId = "patch-" + Math.random().toString(36).slice(2, 10);
    const snapshot = JSON.stringify({ name: args.name, workspace: context.workspaceDir, note: "demo patch：完整 workspace 快照" });
    context.artifacts.put({ kind: "file", createdBy: "engineer", parentAgentRunId: context.parentAgentRunId, value: { patchId, name: args.name, snapshot } });
    return { patchId, name: args.name, bytes: Buffer.byteLength(snapshot) };
  },
};

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) count += countFiles(full);
    else count += 1;
  }
  return count;
}

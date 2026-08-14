import "server-only";
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ServerToolDefinition } from "./types";
import { ToolExecutionError } from "./types";
import { assertApproved } from "./approval";

/**
 * Checkpoint tools: in-run workspace snapshots with restore (git operations are
 * covered by the bash tool).
 */

const checkpointsDir = path.join(process.cwd(), "data", "checkpoints");

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

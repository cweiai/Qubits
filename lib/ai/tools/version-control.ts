import "server-only";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ServerToolDefinition } from "./types";
import { ToolExecutionError } from "./types";
import { assertApproved } from "./approval";
import {
  assertWorkspaceTreeSafe,
  clearWorkspaceBlock,
  readFileNofollow,
  safeWriteFile,
  withWorkspaceLock,
  writeFileNofollow,
} from "@/lib/workspace/paths";
import { WorkspaceError } from "@/lib/workspace/errors";

/**
 * Checkpoint tools: in-run workspace snapshots with restore (git operations are
 * covered by the bash tool). Checkpoints are created/restored under the per-workspace
 * mutex and refuse to run when the workspace contains symlinks or special files —
 * symlink content can never be copied out of or into the workspace.
 */

const checkpointsDir = path.join(process.cwd(), "data", "checkpoints");

function copyTreeSafe(fromDir: string, toDir: string): number {
  mkdirSync(toDir, { recursive: true });
  let count = 0;
  for (const name of readdirSync(fromDir)) {
    const from = path.join(fromDir, name);
    const to = path.join(toDir, name);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink() || stat.isSocket() || stat.isFIFO() || stat.isBlockDevice() || stat.isCharacterDevice()) {
      continue; // never copy symlinks or special files
    }
    if (stat.isDirectory()) {
      count += copyTreeSafe(from, to);
    } else if (stat.isFile()) {
      mkdirSync(path.dirname(to), { recursive: true });
      writeFileNofollow(to, readFileNofollow(from));
      count++;
    }
  }
  return count;
}

export const createCheckpointTool: ServerToolDefinition<{ name: string }, { checkpointId: string; name: string; files: number }> = {
  name: "create_checkpoint",
  description: "对当前 run 的 workspace 打快照（可 restore；跳过符号链接与特殊文件）。",
  argsSchema: z.object({ name: z.string().min(1).max(120) }),
  resultSchema: z.object({ checkpointId: z.string(), name: z.string(), files: z.number().int() }),
  allowedRoles: ["engineer", "team_leader"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    return withWorkspaceLock(context.workspaceDir, async () => {
      assertWorkspaceTreeSafe(context.workspaceDir);
      const checkpointId = "ckp-" + Math.random().toString(36).slice(2, 10);
      const target = path.join(checkpointsDir, context.runId, checkpointId);
      const files = copyTreeSafe(context.workspaceDir, target);
      return { checkpointId, name: args.name, files };
    });
  },
};

export const restoreCheckpointTool: ServerToolDefinition<{ checkpointId: string }, { restored: true; checkpointId: string }> = {
  name: "restore_checkpoint",
  description: "恢复 workspace 快照（破坏性，需要审批；恢复后清除安全阻断标记）。",
  argsSchema: z.object({ checkpointId: z.string().min(4).max(64) }),
  resultSchema: z.object({ restored: z.literal(true), checkpointId: z.string() }),
  allowedRoles: ["engineer", "team_leader"],
  risk: "critical",
  requiresApproval: true,
  async execute(args, context) {
    assertApproved(context, "restore_checkpoint");
    if (!/^ckp-[a-z0-9]{4,64}$/.test(args.checkpointId)) {
      throw new ToolExecutionError("NOT_FOUND", "检查点不存在", false);
    }
    const source = path.join(checkpointsDir, context.runId, args.checkpointId);
    if (!existsSync(source)) throw new ToolExecutionError("NOT_FOUND", "检查点不存在", false);
    return withWorkspaceLock(context.workspaceDir, async () => {
      rmSync(context.workspaceDir, { recursive: true, force: true });
      mkdirSync(context.workspaceDir, { recursive: true });
      let restored = 0;
      const walk = (current: string, rel: string): void => {
        for (const name of readdirSync(current)) {
          const full = path.join(current, name);
          const relPath = rel ? rel + "/" + name : name;
          const stat = lstatSync(full);
          if (stat.isSymbolicLink() || stat.isSocket() || stat.isFIFO()) continue; // never restore symlinks/special files
          if (stat.isDirectory()) {
            walk(full, relPath);
          } else if (stat.isFile()) {
            // Write through the workspace jail so every target path is re-validated.
            safeWriteFile(context.workspaceDir, relPath, readFileNofollow(full).toString("utf8"));
            restored++;
          }
        }
      };
      walk(source, "");
      if (restored === 0) {
        // Restoring an empty checkpoint (nothing was copied) is a data-loss risk: fail loudly.
        throw new WorkspaceError("WORKSPACE_ERROR", "检查点内容为空，拒绝恢复", false);
      }
      clearWorkspaceBlock(context.workspaceDir);
      return { restored: true, checkpointId: args.checkpointId };
    });
  },
};

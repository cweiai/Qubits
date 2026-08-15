import "server-only";
import { z } from "zod";
import type { ServerToolDefinition } from "./types";
import { invalidateQualityGates } from "./types";
import { bashArgsSchema, bashResultSchema } from "./schemas";
import { WorkspaceError, redactHostText } from "@/lib/workspace/errors";
import { assertWorkspaceTreeSafe, withWorkspaceLock } from "@/lib/workspace/paths";

/**
 * bash: run one shell command inside the Docker ContainerSandbox (stateless — every
 * call is an isolated `bash -lc`, like a CI step). The container can physically see
 * ONLY the mounted workspace, so agent commands can never read host files outside it.
 * After each call the workspace tree is re-scanned: if the command planted a symlink
 * or special file, the workspace is marked SECURITY_BLOCKED and every later read,
 * build, preview and snapshot fails closed. Output redaction is log hygiene only —
 * it is NOT the isolation mechanism.
 */
export const bashTool: ServerToolDefinition<z.infer<typeof bashArgsSchema>, z.infer<typeof bashResultSchema>> = {
  name: "bash",
  description:
    "在 Docker 容器沙盒内执行一条 shell 命令（bash -lc，无持久 shell 状态；容器只挂载当前工作区，物理隔离，禁网）。用于搜索（grep/find）、查看文件（cat/ls）、检查环境（ps/env）、运行命令（node/npm/git 等）。输出有大小上限并自动脱敏。",
  argsSchema: bashArgsSchema,
  resultSchema: bashResultSchema,
  allowedRoles: ["engineer"],
  risk: "medium",
  requiresApproval: false,
  async execute(args, context) {
    if (!context.workspaceReady) {
      throw new WorkspaceError("WORKSPACE_NOT_INITIALIZED", "工作区尚未初始化，请先调用 workspace_init", false);
    }
    if (!context.sandbox) {
      throw new WorkspaceError("PROVIDER_UNAVAILABLE", "未配置沙盒 provider，无法执行 bash", false);
    }
    return withWorkspaceLock(context.workspaceDir, async () => {
      // Fail closed before running if the tree already contains symlinks/special files.
      assertWorkspaceTreeSafe(context.workspaceDir);
      const result = await context.sandbox!.exec({
        command: "bash",
        args: ["-lc", args.command],
        cwd: context.workspaceDir,
        timeoutMs: args.timeoutMs,
      });
      invalidateQualityGates(context);
      // A bash command that plants symlinks/special files blocks the whole task.
      assertWorkspaceTreeSafe(context.workspaceDir);
      return {
        exitCode: result.exitCode,
        stdout: redactHostText(result.stdout, context.workspaceDir).slice(0, 30000),
        stderr: redactHostText(result.stderr, context.workspaceDir).slice(0, 10000),
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      };
    });
  },
};

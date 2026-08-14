import "server-only";
import { z } from "zod";
import type { ServerToolDefinition } from "./types";
import { bashArgsSchema, bashResultSchema } from "./schemas";
import { WorkspaceError, redactHostText } from "@/lib/workspace/errors";

/**
 * bash: run one shell command inside the workspace sandbox (stateless — every call
 * is an isolated `bash -lc`, like a CI step). Replaces the old per-command sandbox
 * tools and file search: agents grep/find/ls/cat/ps directly. Output is capped,
 * timed out and host-path redacted. Execution happens through the SandboxProvider
 * (cwd jail + no secrets; LocalDevSandbox is a dev-only boundary, ContainerSandbox
 * is the production one).
 */
export const bashTool: ServerToolDefinition<z.infer<typeof bashArgsSchema>, z.infer<typeof bashResultSchema>> = {
  name: "bash",
  description:
    "在工作区沙盒内执行一条 shell 命令（bash -lc，无持久 shell 状态）。用于搜索（grep/find）、查看文件（cat/ls）、检查环境（ps/env）、运行命令（node/npm/git 等）。cwd 固定为工作区根目录；输出有大小上限并自动脱敏。",
  argsSchema: bashArgsSchema,
  resultSchema: bashResultSchema,
  allowedRoles: ["architect", "engineer", "reviewer"],
  risk: "medium",
  requiresApproval: false,
  async execute(args, context) {
    if (!context.workspaceReady) {
      throw new WorkspaceError("WORKSPACE_NOT_INITIALIZED", "工作区尚未初始化，请先调用 workspace_init", false);
    }
    if (!context.sandbox) {
      throw new WorkspaceError("PROVIDER_UNAVAILABLE", "未配置沙盒 provider，无法执行 bash", false);
    }
    const result = await context.sandbox.exec({
      command: "bash",
      args: ["-lc", args.command],
      cwd: context.workspaceDir,
      timeoutMs: args.timeoutMs,
    });
    return {
      exitCode: result.exitCode,
      stdout: redactHostText(result.stdout, context.workspaceDir).slice(0, 30000),
      stderr: redactHostText(result.stderr, context.workspaceDir).slice(0, 10000),
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    };
  },
};

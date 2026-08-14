import "server-only";
import { z } from "zod";
import type { ServerToolDefinition, ToolExecutionContext } from "./types";
import { ToolExecutionError } from "./types";
import {
  getBuildErrorsResultSchema,
  getTestFailuresResultSchema,
  runBuildArgsSchema,
  runBuildResultSchema,
  workspaceCheckArgsSchema,
  workspaceCheckResultSchema,
} from "./schemas";
import { buildApp } from "@/lib/workspace/builder";
import { runWorkspaceLint, runWorkspaceTests, runWorkspaceTypecheck } from "@/lib/workspace/runner";
import { WorkspaceError } from "@/lib/workspace/errors";

/**
 * Engineering check/build tools: everything runs through the system builder/runner
 * against the real workspace; Alex can never claim "tests passed" in prose — only these
 * tool results (and the artifacts they produce) count.
 */

function requireWorkspace(context: ToolExecutionContext): string {
  if (!context.workspaceReady) {
    throw new WorkspaceError("WORKSPACE_NOT_INITIALIZED", "工作区尚未初始化，请先调用 workspace_init", false);
  }
  return context.workspaceDir;
}

function checkError(error: unknown, fallback: string): ToolExecutionError {
  if (error instanceof WorkspaceError) {
    return new ToolExecutionError(error.code, error.message, error.retryable);
  }
  if (error instanceof ToolExecutionError) return error;
  return new ToolExecutionError(fallback, error instanceof Error ? error.message.slice(0, 300) : "检查失败");
}

export const runLintTool: ServerToolDefinition<z.infer<typeof workspaceCheckArgsSchema>, z.infer<typeof workspaceCheckResultSchema>> = {
  name: "run_lint",
  description: "用系统 ESLint 配置对工作区 src 执行真实 lint（受限沙盒执行，真实 exitCode）。",
  argsSchema: workspaceCheckArgsSchema,
  resultSchema: workspaceCheckResultSchema,
  allowedRoles: ["engineer", "reviewer"],
  risk: "medium",
  requiresApproval: false,
  async execute(_args, context) {
    try {
      const result = await runWorkspaceLint(context.sandbox, requireWorkspace(context));
      return { status: result.status, exitCode: result.exitCode, summary: result.summary };
    } catch (error) {
      throw checkError(error, "LINT_FAILED");
    }
  },
};

export const runTypecheckTool: ServerToolDefinition<z.infer<typeof workspaceCheckArgsSchema>, z.infer<typeof workspaceCheckResultSchema>> = {
  name: "run_typecheck",
  description: "用系统 tsconfig 对工作区执行真实 TypeScript 类型检查。",
  argsSchema: workspaceCheckArgsSchema,
  resultSchema: workspaceCheckResultSchema,
  allowedRoles: ["engineer", "reviewer"],
  risk: "medium",
  requiresApproval: false,
  async execute(_args, context) {
    try {
      const result = await runWorkspaceTypecheck(context.sandbox, requireWorkspace(context));
      return { status: result.status, exitCode: result.exitCode, summary: result.summary };
    } catch (error) {
      throw checkError(error, "TYPECHECK_FAILED");
    }
  },
};

export const runTestsTool: ServerToolDefinition<z.infer<typeof workspaceCheckArgsSchema>, z.infer<typeof workspaceCheckResultSchema>> = {
  name: "run_tests",
  description: "用系统 vitest 配置运行工作区测试（真实执行；通过时产出 test_report）。",
  argsSchema: workspaceCheckArgsSchema,
  resultSchema: workspaceCheckResultSchema,
  allowedRoles: ["engineer", "reviewer"],
  risk: "medium",
  requiresApproval: false,
  async execute(_args, context) {
    try {
      const result = await runWorkspaceTests(context.sandbox, requireWorkspace(context));
      if (result.status === "passed") {
        context.artifacts.put({
          kind: "test_report",
          createdBy: context.roleId,
          parentAgentRunId: context.parentAgentRunId,
          value: { status: "passed", summary: result.summary.slice(0, 2000), durationMs: result.durationMs },
        });
      }
      return { status: result.status, exitCode: result.exitCode, summary: result.summary };
    } catch (error) {
      throw checkError(error, "TEST_FAILED");
    }
  },
};

export const runBuildTool: ServerToolDefinition<z.infer<typeof runBuildArgsSchema>, z.infer<typeof runBuildResultSchema>> = {
  name: "run_build",
  description: "用系统 esbuild/postcss 构建配置打包工作区：成功时产出真实 preview_bundle 与 build_report 产物。",
  argsSchema: runBuildArgsSchema,
  resultSchema: runBuildResultSchema,
  allowedRoles: ["engineer", "reviewer"],
  risk: "medium",
  requiresApproval: false,
  async execute(_args, context) {
    const workspaceDir = requireWorkspace(context);
    const result = await buildApp(workspaceDir);
    const buildArtifactId = context.artifacts.put({
      kind: "build_report",
      createdBy: context.roleId,
      parentAgentRunId: context.parentAgentRunId,
      value: result.report,
    }).id;
    let previewArtifactId: string | null = null;
    if (result.report.status === "success" && result.bundle) {
      previewArtifactId = context.artifacts.put({
        kind: "preview_bundle",
        createdBy: context.roleId,
        parentAgentRunId: context.parentAgentRunId,
        value: { html: result.bundle.html, bytes: result.bundle.bytes, builtAt: result.bundle.builtAt },
      }).id;
    }
    return {
      status: result.report.status,
      errorCode: result.report.errorCode,
      message: result.report.message,
      log: result.report.log.slice(-2800),
      outputBytes: result.report.outputBytes,
      durationMs: result.report.durationMs,
      buildArtifactId,
      previewArtifactId,
      files: result.report.files.slice(0, 80).map((file) => ({ path: file.path, hash: file.hash })),
    };
  },
};

/** get_build_errors: reads the REAL persisted build report (never fabricates errors). */
export const getBuildErrorsTool: ServerToolDefinition<z.infer<typeof runBuildArgsSchema>, z.infer<typeof getBuildErrorsResultSchema>> = {
  name: "get_build_errors",
  description: "返回最近一次真实构建报告的错误与日志（无报告时不伪造）。",
  argsSchema: runBuildArgsSchema,
  resultSchema: getBuildErrorsResultSchema,
  allowedRoles: ["engineer", "reviewer"],
  risk: "low",
  requiresApproval: false,
  async execute(_args, context) {
    requireWorkspace(context);
    const report = context.artifacts.findLatest("build_report");
    if (!report) {
      return { hasReport: false, status: "none", errorCode: null, message: null, log: "" };
    }
    const value = context.artifacts.get(report.id) as {
      status?: string;
      errorCode?: string | null;
      message?: string | null;
      log?: string;
    } | null;
    return {
      hasReport: true,
      status: value?.status === "success" ? "success" : "failed",
      errorCode: value?.errorCode ?? null,
      message: value?.message ?? null,
      log: (value?.log ?? "").slice(-2800),
    };
  },
};

/** get_test_failures: reads the last REAL test report. */
export const getTestFailuresTool: ServerToolDefinition<z.infer<typeof runBuildArgsSchema>, z.infer<typeof getTestFailuresResultSchema>> = {
  name: "get_test_failures",
  description: "返回最近一次真实测试报告（无报告时不伪造）。",
  argsSchema: runBuildArgsSchema,
  resultSchema: getTestFailuresResultSchema,
  allowedRoles: ["engineer", "reviewer"],
  risk: "low",
  requiresApproval: false,
  async execute(_args, context) {
    requireWorkspace(context);
    const report = context.artifacts.findLatest("test_report");
    if (!report) {
      return { hasReport: false, status: "none", summary: "" };
    }
    const value = context.artifacts.get(report.id) as { status?: string; summary?: string } | null;
    return {
      hasReport: true,
      status: value?.status === "passed" ? "passed" : "failed",
      summary: (value?.summary ?? "").slice(-2800),
    };
  },
};

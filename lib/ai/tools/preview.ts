import "server-only";
import { z } from "zod";
import type { ServerToolDefinition } from "./types";
import { ToolExecutionError } from "./types";
import {
  completeRunArgsSchema,
  completeRunResultSchema,
  renderPreviewArgsSchema,
  renderPreviewResultSchema,
} from "./schemas";
import { SearchProviderError } from "./search-provider";
import { readWorkspaceManifest } from "@/lib/workspace/workspace-manager";
import { WorkspaceError } from "@/lib/workspace/errors";
import { assertWorkspaceTreeSafe, withWorkspaceLock } from "@/lib/workspace/paths";

/**
 * render_preview: the only preview submission entry point. It can ONLY accept a
 * successful preview_bundle/build artifact produced by run_build — never an AppSpec —
 * and only after Alex's deterministic quality gates pass. preview_ready fires only on success.
 */
export const renderPreviewTool: ServerToolDefinition<z.infer<typeof renderPreviewArgsSchema>, z.infer<typeof renderPreviewResultSchema>> = {
  name: "render_preview",
  description: "把成功构建的 preview_bundle 提交为可预览产物（唯一入口）。构建、测试或安全扫描未通过时返回 PREVIEW_BLOCKED，旧预览保持不变。",
  argsSchema: renderPreviewArgsSchema,
  resultSchema: renderPreviewResultSchema,
  allowedRoles: ["team_leader"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    if (context.roleId !== "team_leader") {
      throw new SearchProviderError("FORBIDDEN_ROLE", "只有迈克可以提交预览");
    }
    if (!context.workspaceReady) {
      throw new WorkspaceError("WORKSPACE_NOT_INITIALIZED", "工作区尚未初始化，无法提交预览", false);
    }
    const ref = context.artifacts.getRef(args.artifactId);
    if (!ref || ref.kind !== "preview_bundle") {
      throw new SearchProviderError("ARTIFACT_NOT_FOUND", "render_preview 只能接受 run_build 产出的 preview_bundle artifact");
    }
    const bundle = context.artifacts.get(args.artifactId) as { html?: string; bytes?: number } | null;
    if (!bundle || typeof bundle.html !== "string" || bundle.html.length === 0) {
      throw new SearchProviderError("PREVIEW_FAILED", "preview_bundle 内容缺失，请重新执行 run_build");
    }
    const buildReport = context.artifacts.findLatest("build_report");
    const build = buildReport ? (context.artifacts.get(buildReport.id) as { status?: string } | null) : null;
    if (build?.status !== "success") {
      throw new SearchProviderError("PREVIEW_FAILED", "最近一次构建未成功，不能提交预览");
    }
    if (!context.quality.buildPassed || !context.quality.testsPassed || !context.quality.securityScanPassed) {
      throw new SearchProviderError("PREVIEW_BLOCKED", "最新工作区尚未同时通过构建、测试与安全扫描，预览保持旧版本");
    }
    let manifest;
    try {
      manifest = await withWorkspaceLock(context.workspaceDir, async () => {
        assertWorkspaceTreeSafe(context.workspaceDir);
        return readWorkspaceManifest(context.workspaceDir);
      });
    } catch {
      throw new SearchProviderError("PREVIEW_FAILED", "工作区校验失败（manifest 或安全扫描），不能提交预览");
    }
    const version = context.currentVersion + 1;
    context.previewCommitted = true;
    context.emit({ type: "preview_requested", toolCallId: "tc-preview", artifactId: args.artifactId });
    context.emit({
      type: "preview_ready",
      previewArtifactId: args.artifactId,
      appName: manifest.name.slice(0, 120),
      manifest,
      version,
    });
    return { previewArtifactId: args.artifactId, version, appName: manifest.name.slice(0, 120) };
  },
};

/** complete_run: the only completion entry point; promotes the immutable snapshot. */
export const completeRunTool: ServerToolDefinition<z.infer<typeof completeRunArgsSchema>, z.infer<typeof completeRunResultSchema>> = {
  name: "complete_run",
  description: "在 render_preview 成功后结束本次运行（唯一完成入口）：创建不可变代码快照并提升为项目当前版本。",
  argsSchema: completeRunArgsSchema,
  resultSchema: completeRunResultSchema,
  allowedRoles: ["team_leader"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    if (context.roleId !== "team_leader") {
      throw new SearchProviderError("FORBIDDEN_ROLE", "只有迈克可以结束运行");
    }
    if (!context.artifacts.findLatest("product_brief")) {
      throw new SearchProviderError("MISSING_ARTIFACT", "缺少 ProductBrief，不能完成运行");
    }
    if (!context.artifacts.findLatest("code_workspace")) {
      throw new SearchProviderError("MISSING_ARTIFACT", "缺少 Engineer 的代码工作区产物，不能完成运行");
    }
    const buildReport = context.artifacts.findLatest("build_report");
    const build = buildReport ? (context.artifacts.get(buildReport.id) as { status?: string } | null) : null;
    if (build?.status !== "success") {
      throw new SearchProviderError("BUILD_REQUIRED", "没有成功的构建报告，不能完成运行");
    }
    if (!context.quality.buildPassed || !context.quality.testsPassed || !context.quality.securityScanPassed) {
      throw new SearchProviderError("QUALITY_GATE_BLOCKED", "最新工作区没有同时通过构建、测试与安全扫描，不能完成运行");
    }
    if (!context.previewCommitted) {
      throw new SearchProviderError("PREVIEW_REQUIRED", "必须先成功调用 render_preview");
    }
    if (context.promoteRun) {
      const manifest = await withWorkspaceLock(context.workspaceDir, async () => {
        assertWorkspaceTreeSafe(context.workspaceDir);
        return readWorkspaceManifest(context.workspaceDir);
      });
      const testReport = context.artifacts.findLatest("test_report");
      const securityReport = context.artifacts.findLatest("security_report");
      const preview = context.artifacts.findLatest("preview_bundle");
      await context.promoteRun({
        workspaceDir: context.workspaceDir,
        manifest,
        previewArtifactId: preview?.id ?? null,
        buildReport: build,
        testReport: testReport ? context.artifacts.get(testReport.id) : null,
        reviewReport: securityReport ? context.artifacts.get(securityReport.id) : null,
      });
    }
    context.emit({ type: "run_completed", summary: args.summary, suggestions: args.nextSuggestions });
    return { ok: true, summary: args.summary.slice(0, 300) };
  },
};

export function toolExecutionErrorOf(error: unknown): ToolExecutionError {
  if (error instanceof WorkspaceError) return new ToolExecutionError(error.code, error.message, error.retryable);
  if (error instanceof SearchProviderError) return new ToolExecutionError(error.code, error.message, false);
  return new ToolExecutionError("TOOL_ERROR", error instanceof Error ? error.message.slice(0, 300) : "工具执行失败");
}

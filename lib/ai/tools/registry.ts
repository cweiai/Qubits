import "server-only";
import type { AnyToolDefinition, ToolExecutionContext } from "./types";
import { MAX_TOOL_RESULT_BYTES, ToolExecutionError } from "./types";
export { ToolExecutionError } from "./types";
import type { RoleId } from "@/lib/contracts/agent-events";
import { delegateToAgentTool } from "./delegation";
import { openReferenceTool, searchReferencesTool } from "./references";
import { inspectCurrentAppTool } from "./executor";
import { completeRunTool, renderPreviewTool } from "./preview";
import {
  fsCopyTool, fsCreateDirTool, fsDeleteTool, fsListTool, fsMoveTool, fsPatchTool,
  fsReadTool, fsSearchTool, fsStatTool, fsWriteTool,
} from "./filesystem";
import {
  sandboxCreateTool, sandboxExecTool, sandboxExecStreamTool, sandboxExportArtifactTool,
  sandboxGetProcessTool, sandboxKillTool, sandboxNetworkRequestTool, sandboxReadLogsTool, sandboxResetTool,
} from "./sandbox";
import { getBuildErrorsTool, getTestFailuresTool, runBuildTool, runLintTool, runTestsTool, runTypecheckTool } from "./build";
import {
  createCodeSnapshotTool, dependencyAddTool, dependencyListTool, dependencyRemoveTool,
  restoreCodeSnapshotTool, runFormatTool, securityScanTool, workspaceGetManifestTool,
  workspaceInitTool, workspaceListFilesTool,
} from "./workspace-tools";
import {
  aggregateRecordsTool, analyzeProjectDataTool as analyzeProjectDataToolV2, checkDataIsolationTool,
  countRecordsTool, createRecordTool, deleteRecordTool, inspectDataSchemaTool, queryRecordsTool,
  seedDemoDataTool, updateRecordTool, validateDataAccessTool,
} from "./data";
import { requestUserApprovalTool } from "./approval";
import { compareArtifactsTool, createArtifactTool, getArtifactTool } from "./artifacts";
import { createCheckpointTool, createPatchTool, gitDiffTool, gitStatusTool, restoreCheckpointTool } from "./version-control";
import { dependencyAuditTool, reviewChangesTool, secretScanTool, securityReviewTool } from "./security";
import { createMigrationPlanTool, createShareLinkTool, gitCommitTool, publishPreviewTool, rollbackReleaseTool, runMigrationTool } from "./release";
import { extractReferenceContentTool, listReferencesTool, saveReferenceTool, searchCompetitorsTool, searchDocsTool, searchUiExamplesTool, summarizeReferencesTool, verifyReferenceTool } from "./reference-extras";

const DEFINITIONS: Record<string, AnyToolDefinition> = {
  delegate_to_agent: delegateToAgentTool,
  search_references: searchReferencesTool,
  open_reference: openReferenceTool,
  inspect_current_app: inspectCurrentAppTool,
  render_preview: renderPreviewTool,
  complete_run: completeRunTool,
  create_artifact: createArtifactTool,
  get_artifact: getArtifactTool,
  compare_artifacts: compareArtifactsTool,
  request_user_approval: requestUserApprovalTool,
  workspace_init: workspaceInitTool,
  workspace_get_manifest: workspaceGetManifestTool,
  workspace_list_files: workspaceListFilesTool,
  dependency_list: dependencyListTool,
  dependency_add: dependencyAddTool,
  dependency_remove: dependencyRemoveTool,
  security_scan: securityScanTool,
  create_code_snapshot: createCodeSnapshotTool,
  restore_code_snapshot: restoreCodeSnapshotTool,
  fs_list: fsListTool, fs_read: fsReadTool, fs_write: fsWriteTool, fs_patch: fsPatchTool,
  fs_search: fsSearchTool, fs_stat: fsStatTool, fs_delete: fsDeleteTool,
  fs_create_dir: fsCreateDirTool, fs_copy: fsCopyTool, fs_move: fsMoveTool,
  sandbox_create: sandboxCreateTool, sandbox_exec: sandboxExecTool,
  sandbox_exec_stream: sandboxExecStreamTool, sandbox_read_logs: sandboxReadLogsTool,
  sandbox_kill_process: sandboxKillTool, sandbox_get_process: sandboxGetProcessTool,
  sandbox_reset: sandboxResetTool, sandbox_export_artifact: sandboxExportArtifactTool,
  sandbox_network_request: sandboxNetworkRequestTool,
  run_format: runFormatTool,
  run_lint: runLintTool, run_typecheck: runTypecheckTool, run_tests: runTestsTool,
  run_build: runBuildTool,
  get_build_errors: getBuildErrorsTool, get_test_failures: getTestFailuresTool,
  inspect_data_schema: inspectDataSchemaTool, query_records: queryRecordsTool,
  count_records: countRecordsTool, aggregate_records: aggregateRecordsTool,
  create_record: createRecordTool, update_record: updateRecordTool, delete_record: deleteRecordTool,
  seed_demo_data: seedDemoDataTool, analyze_project_data: analyzeProjectDataToolV2,
  validate_data_access: validateDataAccessTool, check_data_isolation: checkDataIsolationTool,
  git_status: gitStatusTool, git_diff: gitDiffTool, create_checkpoint: createCheckpointTool,
  restore_checkpoint: restoreCheckpointTool, create_patch: createPatchTool,
  review_changes: reviewChangesTool, security_review: securityReviewTool,
  secret_scan: secretScanTool, dependency_audit: dependencyAuditTool,
  extract_reference_content: extractReferenceContentTool, search_docs: searchDocsTool,
  search_ui_examples: searchUiExamplesTool, search_competitors: searchCompetitorsTool,
  summarize_references: summarizeReferencesTool, verify_reference: verifyReferenceTool,
  save_reference: saveReferenceTool, list_references: listReferencesTool,
  create_migration_plan: createMigrationPlanTool, run_migration: runMigrationTool,
  publish_preview: publishPreviewTool, create_share_link: createShareLinkTool,
  rollback_release: rollbackReleaseTool, git_commit: gitCommitTool,
};

/** Server-enforced capability matrix. */
const TOOL_PERMISSIONS: Record<RoleId, string[]> = {
  team_leader: ["delegate_to_agent", "search_references", "inspect_current_app", "render_preview", "complete_run", "request_user_approval", "create_artifact", "get_artifact", "compare_artifacts", "workspace_get_manifest", "workspace_list_files", "fs_list", "fs_read", "fs_stat", "fs_search", "create_code_snapshot", "restore_code_snapshot", "list_references", "summarize_references", "create_checkpoint", "restore_checkpoint", "create_migration_plan", "run_migration", "publish_preview", "create_share_link", "rollback_release", "git_commit", "git_status", "git_diff"],
  product_manager: ["fs_read", "inspect_current_app", "get_artifact", "workspace_get_manifest"],
  researcher: ["search_references", "open_reference", "extract_reference_content", "search_docs", "search_ui_examples", "search_competitors", "summarize_references", "verify_reference", "save_reference", "list_references"],
  architect: ["fs_read", "fs_search", "fs_stat", "inspect_current_app", "get_artifact", "create_artifact", "workspace_get_manifest", "workspace_list_files"],
  engineer: ["workspace_init", "workspace_get_manifest", "workspace_list_files", "fs_list", "fs_read", "fs_write", "fs_patch", "fs_search", "fs_stat", "fs_delete", "fs_create_dir", "fs_copy", "fs_move", "dependency_list", "dependency_add", "dependency_remove", "run_format", "run_lint", "run_typecheck", "run_tests", "run_build", "get_build_errors", "get_test_failures", "security_scan", "create_code_snapshot", "restore_code_snapshot", "sandbox_create", "sandbox_exec", "sandbox_exec_stream", "sandbox_read_logs", "sandbox_kill_process", "sandbox_get_process", "sandbox_reset", "sandbox_export_artifact", "sandbox_network_request", "inspect_current_app", "create_artifact", "get_artifact", "compare_artifacts", "create_checkpoint", "create_patch", "request_user_approval", "seed_demo_data", "create_record", "update_record", "delete_record"],
  data_scientist: ["inspect_data_schema", "query_records", "count_records", "aggregate_records", "analyze_project_data", "get_artifact", "create_artifact", "validate_data_access", "create_record", "update_record", "delete_record", "seed_demo_data"],
  reviewer: ["inspect_current_app", "workspace_get_manifest", "workspace_list_files", "fs_read", "fs_list", "fs_search", "fs_stat", "dependency_list", "run_lint", "run_typecheck", "run_tests", "run_build", "get_build_errors", "get_test_failures", "security_scan", "review_changes", "security_review", "secret_scan", "dependency_audit", "check_data_isolation", "get_artifact", "count_records", "list_references"],
  security_reviewer: ["inspect_current_app", "workspace_get_manifest", "fs_read", "security_scan", "review_changes", "security_review", "secret_scan", "dependency_audit", "check_data_isolation", "get_artifact"],
};

export function getToolNamesForRole(roleId: RoleId): string[] {
  return TOOL_PERMISSIONS[roleId] ?? [];
}

export function getToolDefinitionsForRole(roleId: RoleId): AnyToolDefinition[] {
  return (TOOL_PERMISSIONS[roleId] ?? []).map((name) => DEFINITIONS[name]).filter(Boolean);
}

export function getToolDefinition(name: string): AnyToolDefinition | null {
  return DEFINITIONS[name] ?? null;
}

export function listToolNames(): string[] {
  return Object.keys(DEFINITIONS).sort();
}

export async function executeTool(name: string, rawArgs: unknown, context: ToolExecutionContext): Promise<unknown> {
  const definition = getToolDefinition(name);
  if (!definition) throw new ToolExecutionError("UNKNOWN_TOOL", "未知工具：" + String(name).slice(0, 60), false);
  if (!definition.allowedRoles.includes(context.roleId)) {
    throw new ToolExecutionError("FORBIDDEN_ROLE", "角色 " + context.roleId + " 无权调用工具 " + name, false);
  }
  let args: unknown;
  try {
    args = definition.argsSchema.parse(rawArgs);
  } catch (error) {
    throw new ToolExecutionError("INVALID_ARGS", "工具参数校验失败：" + (error instanceof Error ? error.message.slice(0, 200) : "参数不合法"), false);
  }
  const result = await definition.execute(args, context);
  const parsed = definition.resultSchema.safeParse(result);
  if (!parsed.success) throw new ToolExecutionError("INVALID_RESULT", "工具结果校验失败", false);
  let size = 0;
  try {
    size = Buffer.byteLength(JSON.stringify(parsed.data));
  } catch {
    size = 0;
  }
  if (size > MAX_TOOL_RESULT_BYTES) throw new ToolExecutionError("TOOL_RESULT_TOO_LARGE", "工具结果超过大小上限", false);
  return parsed.data;
}

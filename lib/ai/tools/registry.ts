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
  fsReadTool, fsStatTool, fsWriteTool,
} from "./filesystem";
import { bashTool } from "./bash";
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
import { createCheckpointTool, restoreCheckpointTool } from "./version-control";
import { dependencyAuditTool, reviewChangesTool, secretScanTool, securityReviewTool } from "./security";
import { createMigrationPlanTool, createShareLinkTool, publishPreviewTool, rollbackReleaseTool, runMigrationTool } from "./release";
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
  bash: bashTool,
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
  fs_stat: fsStatTool, fs_delete: fsDeleteTool,
  fs_create_dir: fsCreateDirTool, fs_copy: fsCopyTool, fs_move: fsMoveTool,
  run_format: runFormatTool,
  run_lint: runLintTool, run_typecheck: runTypecheckTool, run_tests: runTestsTool,
  run_build: runBuildTool,
  get_build_errors: getBuildErrorsTool, get_test_failures: getTestFailuresTool,
  inspect_data_schema: inspectDataSchemaTool, query_records: queryRecordsTool,
  count_records: countRecordsTool, aggregate_records: aggregateRecordsTool,
  create_record: createRecordTool, update_record: updateRecordTool, delete_record: deleteRecordTool,
  seed_demo_data: seedDemoDataTool, analyze_project_data: analyzeProjectDataToolV2,
  validate_data_access: validateDataAccessTool, check_data_isolation: checkDataIsolationTool,
  create_checkpoint: createCheckpointTool, restore_checkpoint: restoreCheckpointTool,
  review_changes: reviewChangesTool, security_review: securityReviewTool,
  secret_scan: secretScanTool, dependency_audit: dependencyAuditTool,
  extract_reference_content: extractReferenceContentTool, search_docs: searchDocsTool,
  search_ui_examples: searchUiExamplesTool, search_competitors: searchCompetitorsTool,
  summarize_references: summarizeReferencesTool, verify_reference: verifyReferenceTool,
  save_reference: saveReferenceTool, list_references: listReferencesTool,
  create_migration_plan: createMigrationPlanTool, run_migration: runMigrationTool,
  publish_preview: publishPreviewTool, create_share_link: createShareLinkTool,
  rollback_release: rollbackReleaseTool,
};

/**
 * Server-enforced capability matrix. It is NOT hand-written: it is derived from each
 * tool definition's allowedRoles field, which is the single source of truth for role
 * permissions. This guarantees a tool is never advertised to a role that cannot
 * execute it (no more FORBIDDEN_ROLE surprises). Adding a new RoleId is a compile
 * error here — every role must be present even with an empty list.
 */
const TOOL_PERMISSIONS: Record<RoleId, string[]> = (() => {
  const matrix: Record<RoleId, string[]> = {
    team_leader: [], product_manager: [], researcher: [], architect: [],
    engineer: [], data_scientist: [], reviewer: [], security_reviewer: [],
  };
  for (const [name, definition] of Object.entries(DEFINITIONS)) {
    for (const role of definition.allowedRoles) {
      matrix[role].push(name);
    }
  }
  return matrix;
})();

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

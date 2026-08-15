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
  updateRecordTool, validateDataAccessTool,
} from "./data";
import { compareArtifactsTool, createArtifactTool, getArtifactTool } from "./artifacts";
import { createCheckpointTool, restoreCheckpointTool } from "./version-control";
import { dependencyAuditTool, reviewChangesTool, secretScanTool } from "./security";
import { extractReferenceContentTool, listReferencesTool, saveReferenceTool, searchCompetitorsTool, searchDocsTool, searchUiExamplesTool, summarizeReferencesTool, verifyReferenceTool } from "./reference-extras";

const DEFINITIONS = {
  delegate_to_agent: delegateToAgentTool,
  search_references: searchReferencesTool,
  open_reference: openReferenceTool,
  inspect_current_app: inspectCurrentAppTool,
  render_preview: renderPreviewTool,
  complete_run: completeRunTool,
  create_artifact: createArtifactTool,
  get_artifact: getArtifactTool,
  compare_artifacts: compareArtifactsTool,
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
  analyze_project_data: analyzeProjectDataToolV2,
  validate_data_access: validateDataAccessTool, check_data_isolation: checkDataIsolationTool,
  create_checkpoint: createCheckpointTool, restore_checkpoint: restoreCheckpointTool,
  review_changes: reviewChangesTool,
  secret_scan: secretScanTool, dependency_audit: dependencyAuditTool,
  extract_reference_content: extractReferenceContentTool, search_docs: searchDocsTool,
  search_ui_examples: searchUiExamplesTool, search_competitors: searchCompetitorsTool,
  summarize_references: summarizeReferencesTool, verify_reference: verifyReferenceTool,
  save_reference: saveReferenceTool, list_references: listReferencesTool,
} satisfies Record<string, AnyToolDefinition>;

type RegisteredToolName = keyof typeof DEFINITIONS;
export type ToolEffect = "observation" | "action";

/**
 * Tool effects are controller contracts, not risk levels.
 * Observations may be cached for an unchanged state; actions must always retain
 * their real execution semantics because they can mutate state or advance workflow.
 */
const TOOL_EFFECTS: Record<RegisteredToolName, ToolEffect> = {
  delegate_to_agent: "action",
  search_references: "observation",
  open_reference: "observation",
  inspect_current_app: "observation",
  render_preview: "action",
  complete_run: "action",
  create_artifact: "action",
  get_artifact: "observation",
  compare_artifacts: "observation",
  bash: "action",
  workspace_init: "action",
  workspace_get_manifest: "observation",
  workspace_list_files: "observation",
  dependency_list: "observation",
  dependency_add: "action",
  dependency_remove: "action",
  security_scan: "observation",
  create_code_snapshot: "action",
  restore_code_snapshot: "action",
  fs_list: "observation",
  fs_read: "observation",
  fs_write: "action",
  fs_patch: "action",
  fs_stat: "observation",
  fs_delete: "action",
  fs_create_dir: "action",
  fs_copy: "action",
  fs_move: "action",
  run_format: "action",
  run_lint: "observation",
  run_typecheck: "observation",
  run_tests: "observation",
  run_build: "observation",
  get_build_errors: "observation",
  get_test_failures: "observation",
  inspect_data_schema: "observation",
  query_records: "observation",
  count_records: "observation",
  aggregate_records: "observation",
  create_record: "action",
  update_record: "action",
  delete_record: "action",
  analyze_project_data: "observation",
  validate_data_access: "observation",
  check_data_isolation: "observation",
  create_checkpoint: "action",
  restore_checkpoint: "action",
  review_changes: "observation",
  secret_scan: "observation",
  dependency_audit: "observation",
  extract_reference_content: "observation",
  search_docs: "observation",
  search_ui_examples: "observation",
  search_competitors: "observation",
  summarize_references: "observation",
  verify_reference: "observation",
  save_reference: "action",
  list_references: "observation",
};

/**
 * Server-enforced capability matrix. It is NOT hand-written: it is derived from each
 * tool definition's allowedRoles field, which is the single source of truth for role
 * permissions. This guarantees a tool is never advertised to a role that cannot
 * execute it (no more FORBIDDEN_ROLE surprises). Adding a new RoleId is a compile
 * error here; every role must be present even with an empty list.
 */
const TOOL_PERMISSIONS: Record<RoleId, string[]> = (() => {
  const matrix: Record<RoleId, string[]> = {
    team_leader: [], product_manager: [], engineer: [],
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
  const definitions = DEFINITIONS as Record<string, AnyToolDefinition>;
  return (TOOL_PERMISSIONS[roleId] ?? []).map((name) => definitions[name]).filter(Boolean);
}

export function getToolDefinition(name: string): AnyToolDefinition | null {
  return (DEFINITIONS as Record<string, AnyToolDefinition>)[name] ?? null;
}

export function getToolEffect(name: string): ToolEffect | null {
  return (TOOL_EFFECTS as Record<string, ToolEffect>)[name] ?? null;
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

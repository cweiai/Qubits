import "server-only";
import { z, type ZodType } from "zod";
import type { QubitsManifest } from "@/lib/contracts/manifest";
import type { RoleId, AgentEvent } from "@/lib/contracts/agent-events";
import type { ArtifactStore } from "../artifact-store";
import type { SandboxProvider } from "./sandbox-provider";

export type ArtifactKind =
  | "product_brief"
  | "research_report"
  | "app_blueprint"
  | "code_workspace"
  | "build_report"
  | "test_report"
  | "review_report"
  | "preview_bundle"
  | "data_report"
  | "file"
  | "reference";

export interface ArtifactRef {
  id: string;
  kind: ArtifactKind;
  createdBy: RoleId;
  parentAgentRunId: string | null;
  schemaVersion: number;
  size: number;
}

export interface DataAdapter {
  list(collection: string): Array<Record<string, unknown>>;
  insert(collection: string, record: Record<string, unknown>): { id: string } & Record<string, unknown>;
  update(collection: string, id: string, patch: Record<string, unknown>): boolean;
  remove(collection: string, id: string): boolean;
}

export interface ChildAgentRequest {
  roleId: RoleId;
  task: string;
  expectedOutput: string;
  inputArtifacts: Array<{ id: string; kind: ArtifactKind }>;
}

export interface ChildAgentResult {
  status: "completed" | "failed";
  artifactId: string | null;
  summary: string;
  issues: string[];
}

/** Promotion request from complete_run: creates the immutable snapshot + project version. */
export interface PromoteRunInput {
  workspaceDir: string;
  manifest: QubitsManifest;
  previewArtifactId: string | null;
  buildReport: unknown | null;
  testReport: unknown | null;
  reviewReport: unknown | null;
}

export interface PromoteRunResult {
  snapshotId: string;
  version: number;
}

export interface ToolExecutionContext {
  runId: string;
  parentAgentRunId: string | null;
  roleId: RoleId;
  depth: number;
  signal: AbortSignal;
  /** Current validated manifest (code is the source of truth; never an AppSpec). */
  currentManifest: QubitsManifest | null;
  /** Data scope id (manifest.appId ?? projectId); stable across app versions. */
  currentAppId: string;
  /** Project's current promoted version (0 when nothing has been promoted yet). */
  currentVersion: number;
  projectRecords: Array<Record<string, unknown>> | null;
  dataAdapter: DataAdapter | null;
  artifacts: ArtifactStore;
  emit(event: AgentEvent): void;
  childAgentRunner: (request: ChildAgentRequest) => Promise<ChildAgentResult>;
  reviewerApproved: boolean;
  previewCommitted: boolean;
  /** Workspace root for this run (jail for file and sandbox tools). */
  workspaceDir: string;
  /** Set to true after workspace_init succeeds (or the orchestrator seeded it). */
  workspaceReady: boolean;
  sandbox: SandboxProvider | null;
  /** Tool names already approved for this run (written by the approval flow). */
  approvedTools: Set<string>;
  counters: { toolCalls: number; childAgents: number };
  /** Promotes the workspace into an immutable snapshot + project version (complete_run). */
  promoteRun?: (input: PromoteRunInput) => Promise<PromoteRunResult>;
}

export type ToolRisk = "low" | "medium" | "high" | "critical";

export interface ServerToolDefinition<TArgs, TResult> {
  name: string;
  description: string;
  argsSchema: ZodType<TArgs, z.ZodTypeDef, unknown>;
  resultSchema: ZodType<TResult, z.ZodTypeDef, unknown>;
  allowedRoles: RoleId[];
  risk: ToolRisk;
  requiresApproval: boolean;
  execute(args: TArgs, context: ToolExecutionContext): Promise<TResult>;
}

export type AnyToolDefinition = ServerToolDefinition<unknown, unknown>;

export const MAX_TOOL_RESULT_BYTES = 32 * 1024;
export const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

export class ToolExecutionError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = true) {
    super(message);
    this.name = "ToolExecutionError";
    this.code = code;
    this.retryable = retryable;
  }
}

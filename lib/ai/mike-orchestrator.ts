import "server-only";
import type { QubitsManifest } from "@/lib/contracts/manifest";
import type { AgentEvent } from "@/lib/contracts/agent-events";
import { securityReviewSchema } from "@/lib/contracts/review";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ArtifactKind, ChildAgentRequest, ChildAgentResult, DataAdapter, PromoteRunInput, PromoteRunResult, ToolExecutionContext } from "./tools/types";
import { ArtifactStore, type StoredArtifactEntry } from "./artifact-store";
import { runToolCallingAgent, ToolLoopError } from "./tool-loop";
import { getSandboxProvider, type SandboxProvider } from "./tools/sandbox-provider";
import { ROLE_DEFINITIONS } from "./roles";
import { isAbortLike } from "@/lib/workspace/errors";
import type { AIProvider } from "./provider";

/**
 * Mike orchestration: single entry point for every run.
 * Root invariant: the first agent call/event must be Mike (team_leader);
 * child agents, preview and completion are all driven by Mike's real tool calls,
 * while the server only manages budget/permissions/lifecycle — never assigning tasks for Mike.
 */

interface MikeRunInput {
  prompt: string;
  currentManifest: QubitsManifest | null;
  currentAppId: string;
  currentVersion: number;
  projectRecords: Array<Record<string, unknown>> | null;
  signal?: AbortSignal;
  emit(event: AgentEvent): void;
  workspaceDir?: string;
  sandbox?: SandboxProvider | null;
  dataAdapter?: DataAdapter | null;
  /** Retry context injected by the caller so Mike continues from the failure point. */
  resumeContext?: string | null;
  /** Artifact persistence file: saves/restores the ArtifactStore across attempts. */
  artifactFile?: string | null;
  /** Snapshot promotion callback (server-injected; writes the database). */
  promoteRun?: (input: PromoteRunInput) => Promise<PromoteRunResult>;
  /** Test injection: overrides the model provider (timeout/abort semantics). */
  providerOverride?: AIProvider;
}

interface MikeRunResult {
  status: "completed" | "failed";
  summary: string;
  suggestions: string[];
}

/** Server-enforced expectedOutput → artifact kind mapping (unknown outputs are rejected). */
function expectedKind(expectedOutput: string): ArtifactKind {
  switch (expectedOutput) {
    case "product_brief":
      return "product_brief";
    case "research_report":
      return "research_report";
    case "app_blueprint":
      return "app_blueprint";
    case "code_workspace":
      return "code_workspace";
    case "data_report":
      return "data_report";
    case "review_report":
      return "review_report";
    default:
      throw new ToolLoopError("INVALID_EXPECTED_OUTPUT", "未知的 expectedOutput：" + String(expectedOutput).slice(0, 60));
  }
}

export async function runMikeOrchestrator(input: MikeRunInput): Promise<MikeRunResult> {
  const runId = "run-" + crypto.randomUUID();
  const mikeAgentRunId = "agent-" + crypto.randomUUID();
  const artifactFile = input.artifactFile ?? null;
  // Retry: restore previous artifacts and persist after each put.
  let seed: StoredArtifactEntry[] | undefined;
  if (artifactFile && existsSync(artifactFile)) {
    try {
      const parsed = JSON.parse(readFileSync(artifactFile, "utf8")) as unknown;
      if (Array.isArray(parsed)) seed = parsed as StoredArtifactEntry[];
    } catch {
      seed = undefined;
    }
  }
  const artifacts = new ArtifactStore(runId, seed, artifactFile ? (entries) => {
    try {
      mkdirSync(path.dirname(artifactFile), { recursive: true });
      writeFileSync(artifactFile, JSON.stringify(entries));
    } catch {
      // Persistence failure must not fail the run
    }
  } : undefined);
  const counters = { toolCalls: 0, childAgents: 0 };
  const workspaceDir = input.workspaceDir ?? path.join(process.cwd(), "data", "workspaces", runId);
  // The route seeds the workspace (snapshot or system skeleton) before the run starts;
  // workspace_init remains idempotent and Alex may still call it.
  const runState = {
    reviewerApproved: false,
    previewCommitted: false,
    // workspace_init (called by Alex in a child context) must write through to the run state.
    workspaceReady: existsSync(path.join(workspaceDir, ".qubits-workspace.json")),
  };

  const context: ToolExecutionContext = {
    runId,
    parentAgentRunId: mikeAgentRunId,
    roleId: "team_leader",
    depth: 0,
    signal: input.signal ?? new AbortController().signal,
    currentManifest: input.currentManifest,
    currentAppId: input.currentAppId,
    currentVersion: input.currentVersion,
    projectRecords: input.projectRecords,
    dataAdapter: input.dataAdapter ?? null,
    artifacts,
    emit: input.emit,
    childAgentRunner: (request) => runChildAgent(request),
    get reviewerApproved() {
      return runState.reviewerApproved;
    },
    set reviewerApproved(value: boolean) {
      runState.reviewerApproved = value;
    },
    get previewCommitted() {
      return runState.previewCommitted;
    },
    set previewCommitted(value: boolean) {
      runState.previewCommitted = value;
    },
    workspaceDir,
    get workspaceReady() {
      return runState.workspaceReady;
    },
    set workspaceReady(value: boolean) {
      runState.workspaceReady = value;
    },
    sandbox: input.sandbox ?? getSandboxProvider(),
    approvedTools: new Set<string>(),
    counters,
    promoteRun: input.promoteRun,
  };

  async function runChildAgent(request: ChildAgentRequest): Promise<ChildAgentResult> {
    const definition = ROLE_DEFINITIONS[request.roleId];
    // Shared id: delegated/started/completed events all reference the same run row.
    const childAgentRunId = request.agentRunId;
    input.emit({
      type: "agent_started",
      agentRunId: childAgentRunId,
      roleId: request.roleId,
      parentAgentRunId: mikeAgentRunId,
      taskSummary: request.task.slice(0, 300),
    });
    const inputArtifacts = request.inputArtifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      value: artifacts.get(artifact.id),
    }));
    const childContext: ToolExecutionContext = {
      ...context,
      parentAgentRunId: mikeAgentRunId,
      roleId: request.roleId,
      depth: 1,
      // write-through accessors so workspace_init (and any child state change) is shared with the run
      get workspaceReady() {
        return runState.workspaceReady;
      },
      set workspaceReady(value: boolean) {
        runState.workspaceReady = value;
      },
      get reviewerApproved() {
        return runState.reviewerApproved;
      },
      set reviewerApproved(value: boolean) {
        runState.reviewerApproved = value;
      },
      get previewCommitted() {
        return runState.previewCommitted;
      },
      set previewCommitted(value: boolean) {
        runState.previewCommitted = value;
      },
    };
    try {
      const result = await runToolCallingAgent({
        roleId: request.roleId,
        agentRunId: childAgentRunId,
        systemPrompt: definition.systemPrompt,
        taskPrompt: definition.buildTaskPrompt({ task: request.task, inputArtifacts, currentManifest: input.currentManifest }),
        finalSchema: definition.finalSchema,
        context: childContext,
        signal: input.signal,
        requireToolCall: request.roleId === "engineer", // Alex must produce real code via tool calls
        providerOverride: input.providerOverride,
      });
      const kind = expectedKind(request.expectedOutput);
      const artifactId = artifacts.put({
        kind,
        createdBy: request.roleId,
        parentAgentRunId: mikeAgentRunId,
        value: result.artifact,
      }).id;
      if (request.roleId === "reviewer" || request.roleId === "security_reviewer") {
        const review = securityReviewSchema.safeParse(result.artifact);
        if (review.success) {
          runState.reviewerApproved = review.data.approved;
        }
      }
      return { status: "completed", artifactId, summary: result.summary, issues: result.issues };
    } catch (error) {
      // Aborts propagate to Mike's loop and the orchestrator maps them to CLIENT_ABORTED.
      if (input.signal?.aborted || isAbortLike(error)) throw error;
      const message = error instanceof Error ? error.message.slice(0, 300) : "子 Agent 失败";
      return { status: "failed", artifactId: null, summary: message, issues: [message] };
    }
  }

  // 1) First agent call: Mike
  input.emit({
    type: "agent_started",
    agentRunId: mikeAgentRunId,
    roleId: "team_leader",
    parentAgentRunId: null,
    taskSummary: input.prompt.slice(0, 300),
  });

  // 2) Run only Mike (root agent); everything after is driven by Mike's real tool calls
  try {
    const result = await runToolCallingAgent({
      roleId: "team_leader",
      agentRunId: mikeAgentRunId,
      systemPrompt: ROLE_DEFINITIONS.team_leader.systemPrompt,
      taskPrompt:
        (input.resumeContext ? input.resumeContext + "\n\n" : "") +
        "用户需求：\n" +
        input.prompt.slice(0, 4000) +
        (input.currentManifest
          ? "\n\n当前应用（代码为准，仅供 inspect_current_app 参考）：「" + input.currentManifest.name + "」v" + input.currentVersion
          : ""),
      finalSchema: ROLE_DEFINITIONS.team_leader.finalSchema,
      context,
      signal: input.signal,
      requireToolCall: true,
      providerOverride: input.providerOverride,
    });
    // Server-side gate: complete_run is the ONLY completion entry. Mike's final text can
    // never substitute for the preview + completion tool calls.
    if (!runState.previewCommitted) {
      const message = "[INCOMPLETE_RUN] 运行结束前未成功完成 render_preview + complete_run（构建/评审/预览任一环节未通过）。当前成功版本保持不变。";
      input.emit({ type: "error", roleId: "team_leader", message: message.slice(0, 400), code: "INCOMPLETE_RUN" });
      return { status: "failed", summary: message, suggestions: [] };
    }
    input.emit({
      type: "agent_completed",
      agentRunId: mikeAgentRunId,
      roleId: "team_leader",
      summary: result.summary.slice(0, 300),
    });
    return { status: "completed", summary: result.summary, suggestions: [] };
  } catch (error) {
    if (input.signal?.aborted || isAbortLike(error)) {
      const message = "[CLIENT_ABORTED] 请求已取消（页面刷新或断开连接）。工作区与产物已保留，可重试；当前成功版本不受影响。";
      input.emit({ type: "error", roleId: "team_leader", message: message.slice(0, 400), code: "CLIENT_ABORTED" });
      return { status: "failed", summary: message, suggestions: [] };
    }
    const message = error instanceof ToolLoopError ? "[" + error.code + "] " + error.message.slice(0, 260) : error instanceof Error ? error.message.slice(0, 300) : "编排失败";
    input.emit({ type: "error", roleId: "team_leader", message, code: error instanceof ToolLoopError ? error.code : "ORCHESTRATION_ERROR" });
    return { status: "failed", summary: message, suggestions: [] };
  }
}

import "server-only";
import type { QubitsManifest } from "@/lib/contracts/manifest";
import type { AgentEvent } from "@/lib/contracts/agent-events";
import { codeWorkspaceSchema, productBriefWithSummarySchema } from "@/lib/contracts/artifacts";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ArtifactKind, ChildAgentRequest, ChildAgentResult, DataAdapter, PromoteRunInput, PromoteRunResult, ToolExecutionContext } from "./tools/types";
import { ArtifactStore, type StoredArtifactEntry } from "./artifact-store";
import { runToolCallingAgent, ToolLoopError } from "./tool-loop";
import { getSandboxProvider, type SandboxProvider } from "./tools/sandbox-provider";
import { ProviderError } from "./openai-provider";
import { ROLE_DEFINITIONS } from "./roles";
import { isAbortLike } from "@/lib/workspace/errors";
import type { AIProvider } from "./provider";
import type { z } from "zod";

/**
 * Mike orchestration: single entry point for every run.
 * Root invariant: the first agent call/event must be Mike (team_leader);
 * child agents, preview and completion are all driven by Mike's real tool calls,
 * while the server only manages budget/permissions/lifecycle — never assigning tasks for Mike.
 */

interface MikeRunInput {
  prompt: string;
  projectId?: string | null;
  taskId?: string | null;
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
  /** Durable artifact persistence injected by the server repository. */
  artifactSeed?: StoredArtifactEntry[];
  persistArtifacts?: (entries: StoredArtifactEntry[]) => void;
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
    case "code_workspace":
      return "code_workspace";
    default:
      throw new ToolLoopError("INVALID_EXPECTED_OUTPUT", "未知的 expectedOutput：" + String(expectedOutput).slice(0, 60));
  }
}

/** Final-artifact kind → Zod schema. Persisting a deliverable REQUIRES passing this check. */
const FINAL_ARTIFACT_SCHEMAS: Record<string, z.ZodType> = {
  product_brief: productBriefWithSummarySchema,
  code_workspace: codeWorkspaceSchema,
};

/** Stable error code → short human label (the full message stays in the summary). */
const ERROR_LABELS: Record<string, string> = {
  PROVIDER_TIMEOUT: "模型超时",
  PROVIDER_NETWORK_ERROR: "模型网络错误",
  PROVIDER_RATE_LIMIT: "模型请求受限",
  PROVIDER_AUTH_ERROR: "模型鉴权失败",
  PROVIDER_BAD_REQUEST: "模型请求被拒绝",
  PROVIDER_SERVER_ERROR: "模型服务错误",
  AGENT_TOOL_BUDGET_EXCEEDED: "Agent 工具预算耗尽",
  AGENT_DEADLINE_EXCEEDED: "Agent 总执行时间超限",
  TOOL_FAILURE_LIMIT_EXCEEDED: "工具调用失败过多",
  INVALID_TOOL_MESSAGE_SEQUENCE: "工具消息协议错误",
};

/** Extract a stable error code from any thrown value (ToolLoopError / ProviderError / code-carrying errors). */
function stableErrorCode(error: unknown): string | null {
  if (error instanceof ToolLoopError) return error.code;
  if (error instanceof ProviderError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return null;
}

function friendlyMessage(error: unknown): { code: string; message: string } {
  const code = stableErrorCode(error) ?? "ORCHESTRATION_ERROR";
  const raw = error instanceof Error ? error.message.slice(0, 300) : "编排失败";
  const label = ERROR_LABELS[code];
  return {
    code,
    message: "[" + code + "] " + (label ? label + "：" : "") + raw,
  };
}

export async function runMikeOrchestrator(input: MikeRunInput): Promise<MikeRunResult> {
  const runId = "run-" + crypto.randomUUID();
  const mikeAgentRunId = "agent-" + crypto.randomUUID();
  // Retry restores the task's durable entries; every new artifact is persisted immediately.
  const artifacts = new ArtifactStore(runId, input.artifactSeed, input.persistArtifacts);
  const counters = { toolCalls: 0, childAgents: 0 };
  const workspaceDir = input.workspaceDir ?? path.join(process.cwd(), "data", "workspaces", runId);
  // The route seeds the workspace (snapshot or system skeleton) before the run starts;
  // workspace_init remains idempotent and Alex may still call it.
  const runState = {
    quality: {
      buildPassed: false,
      testsPassed: false,
      securityScanPassed: false,
    },
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
    projectId: input.projectId ?? null,
    taskId: input.taskId ?? null,
    projectRecords: input.projectRecords,
    dataAdapter: input.dataAdapter ?? null,
    artifacts,
    emit: input.emit,
    childAgentRunner: (request) => runChildAgent(request),
    quality: runState.quality,
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
      // Single persistence point: the orchestrator (never the child via create_artifact)
      // stores the finalSchema-validated structured output exactly once.
      const kindSchema = FINAL_ARTIFACT_SCHEMAS[kind];
      if (kindSchema && !kindSchema.safeParse(result.artifact).success) {
        const message = "子 Agent 最终产物未通过 " + kind + " 的结构校验（拒绝 JSON 字符串冒充结构化对象）。";
        input.emit({ type: "agent_failed", agentRunId: childAgentRunId, roleId: request.roleId, message: message.slice(0, 300) });
        return { status: "failed", artifactId: null, summary: message, issues: [message], errorCode: "INVALID_FINAL_ARTIFACT" };
      }
      const artifactId = artifacts.put({
        kind,
        createdBy: request.roleId,
        parentAgentRunId: mikeAgentRunId,
        value: result.artifact,
      }).id;
      return { status: "completed", artifactId, summary: result.summary, issues: result.issues };
    } catch (error) {
      // Aborts propagate to Mike's loop and the orchestrator maps them to CLIENT_ABORTED.
      if (input.signal?.aborted || isAbortLike(error)) throw error;
      const { code, message } = friendlyMessage(error);
      return { status: "failed", artifactId: null, summary: message.slice(0, 300), issues: [message.slice(0, 300)], errorCode: code };
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
      const message = "[INCOMPLETE_RUN] 运行结束前未成功完成 render_preview + complete_run（构建/测试/安全扫描/预览任一环节未通过）。当前成功版本保持不变。";
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
    // Stable provider/tool-loop codes survive to the API route and the database;
    // a raw fetch failure is never recorded as ORCHESTRATION_ERROR again.
    const { code, message } = friendlyMessage(error);
    input.emit({ type: "error", roleId: "team_leader", message, code });
    return { status: "failed", summary: message, suggestions: [] };
  }
}

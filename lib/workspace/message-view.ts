import type { MessageJson, TaskJson } from "./api";
import type { ConversationMessage, RoleState } from "@/lib/contracts/conversation";
import type { RoleId } from "@/lib/contracts/agent-events";
import { ROLE_META } from "@/lib/contracts/agent-events";
import type { PipelineStage } from "@/lib/contracts/conversation";

/** Server message/task → client view (pure mapping). */
const KNOWN_ROLES: RoleId[] = ["team_leader", "product_manager", "researcher", "architect", "engineer", "data_scientist", "reviewer", "security_reviewer"];

export function messageToView(message: MessageJson): ConversationMessage | null {
  const metadata = message.metadata ?? {};
  const rawRoleId = typeof metadata.roleId === "string" ? metadata.roleId : message.roleId;
  const roleId: RoleId | null =
    rawRoleId && KNOWN_ROLES.includes(rawRoleId as RoleId) ? (rawRoleId as RoleId) : null;
  const kind = metadata.kind as "role" | "error" | undefined;

  let type: ConversationMessage["type"];
  let status: ConversationMessage["status"] = null;
  if (message.role === "user") {
    type = "user";
  } else if (message.role === "system") {
    type = "system";
  } else if (kind === "error") {
    type = "error";
    status = message.status === "error" ? "error" : null;
  } else if (kind === "role" && roleId) {
    type = roleId as ConversationMessage["type"];
    status = message.status === "error" ? "error" : message.status === "completed" ? "success" : "running";
  } else {
    type = "system";
    status = message.status === "error" ? "error" : null;
  }

  return {
    id: message.id,
    type,
    runId: message.taskId,
    roleId: kind === "role" ? roleId : type === "error" && roleId ? roleId : null,
    text: message.content,
    artifact: metadata.artifact != null ? metadata.artifact : null,
    status,
    timestamp: message.createdAt,
  };
}

export function messagesToViews(messages: MessageJson[]): ConversationMessage[] {
  return messages.map(messageToView).filter((view): view is ConversationMessage => view !== null);
}

export interface AgentRunView {
  agentRunId: string;
  roleId: RoleId;
  parentAgentRunId: string | null;
  status: "pending" | "running" | "completed" | "failed";
  taskSummary: string;
  summary: string | null;
  artifactId: string | null;
  errorMessage: string | null;
  timestamp: number;
}

export interface ToolEventView {
  toolCallId: string;
  agentRunId: string;
  roleId: RoleId;
  toolName: string;
  status: "running" | "success" | "failed";
  inputSummary: string;
  resultSummary: string;
  errorCode: string | null;
  timestamp: number;
  reference?: {
    resultId: string;
    title: string;
    url: string;
    domain: string;
    snippet: string;
    source: string;
  };
}

export interface TaskView {
  id: string;
  conversationId: string;
  prompt: string;
  status: "pending" | "running" | "ready" | "failed" | "conflict";
  stage: PipelineStage;
  roles: Record<string, RoleState>;
  agentRuns: AgentRunView[];
  toolEvents: ToolEventView[];
  references: ToolEventView["reference"][];
  error: { roleId: RoleId; message: string } | null;
  createdAt: number;
}

// ── Tool-card stage grouping (collapsible blocks) ──

export type ToolStage = "planning" | "architecting" | "coding" | "validating" | "reviewing" | "previewing";

export const TOOL_STAGE_ORDER: ToolStage[] = ["planning", "architecting", "coding", "validating", "reviewing", "previewing"];

export const TOOL_STAGE_LABELS: Record<ToolStage, string> = {
  planning: "规划与任务分配",
  architecting: "架构设计",
  coding: "编写代码",
  validating: "构建验证",
  reviewing: "安全评审",
  previewing: "预览提交",
};

/** Collapsible block for a pipeline stage (no active block once the task finishes). */
export function activeToolStage(taskStage: string | undefined): ToolStage | null {
  if (!taskStage) return null;
  if (TOOL_STAGE_ORDER.includes(taskStage as ToolStage)) return taskStage as ToolStage;
  return null;
}

/** Build/check tools belong to the validating stage (mirrors the server ROLE_STAGE mapping). */
const VALIDATING_TOOLS = new Set(["run_lint", "run_typecheck", "run_tests", "run_build", "get_build_errors", "get_test_failures"]);

/** Stable stage for a tool event (events never migrate between blocks). */
export function toolEventStage(event: Pick<ToolEventView, "roleId" | "toolName">): ToolStage {
  if (event.roleId === "team_leader") {
    return event.toolName === "render_preview" || event.toolName === "complete_run" ? "previewing" : "planning";
  }
  if (event.roleId === "architect") return "architecting";
  if (event.roleId === "engineer") {
    return VALIDATING_TOOLS.has(event.toolName) ? "validating" : "coding";
  }
  if (event.roleId === "reviewer" || event.roleId === "security_reviewer") return "reviewing";
  return "planning";
}

export interface ToolStageGroupView {
  stage: ToolStage;
  events: ToolEventView[];
}

/** Group task tool events by stage, keeping pipeline order. */
export function groupToolEvents(events: ToolEventView[]): ToolStageGroupView[] {
  const byStage = new Map<ToolStage, ToolEventView[]>();
  for (const event of events) {
    const stage = toolEventStage(event);
    const bucket = byStage.get(stage);
    if (bucket) bucket.push(event);
    else byStage.set(stage, [event]);
  }
  return TOOL_STAGE_ORDER.filter((stage) => byStage.has(stage)).map((stage) => ({
    stage,
    events: byStage.get(stage)!,
  }));
}

export type StageGroupStatus = "running" | "failed" | "success";

/**
 * Aggregate status of a stage block. The currently active stage stays "running" even
 * while the model thinks between tool calls (all its tool events may already be
 * success) — a green check must never appear before the stage is finished.
 */
export function stageGroupStatus(events: ToolEventView[], active: boolean): StageGroupStatus {
  if (active) return "running";
  if (events.some((event) => event.status === "failed")) return "failed";
  if (events.some((event) => event.status === "running")) return "running";
  return "success";
}

function parseRoleState(value: unknown): RoleState {
  if (typeof value !== "object" || value === null) {
    return { status: "pending", summary: null, startedAt: null, completedAt: null };
  }
  const record = value as Record<string, unknown>;
  const status = record.status === "running" || record.status === "success" || record.status === "error" ? record.status : "pending";
  return {
    status,
    summary: typeof record.summary === "string" ? record.summary : null,
    startedAt: typeof record.startedAt === "number" ? record.startedAt : null,
    completedAt: typeof record.completedAt === "number" ? record.completedAt : null,
  };
}

function parseAgentRun(raw: unknown): AgentRunView {
  const record = (raw ?? {}) as Record<string, unknown>;
  const roleId = typeof record.roleId === "string" ? (record.roleId as RoleId) : "team_leader";
  return {
    agentRunId: typeof record.agentRunId === "string" ? record.agentRunId : "agent-unknown",
    roleId,
    parentAgentRunId: typeof record.parentAgentRunId === "string" ? record.parentAgentRunId : null,
    status: (record.status as AgentRunView["status"]) ?? "pending",
    taskSummary: typeof record.taskSummary === "string" ? record.taskSummary : "",
    summary: typeof record.summary === "string" ? record.summary : null,
    artifactId: typeof record.artifactId === "string" ? record.artifactId : null,
    errorMessage: typeof record.errorMessage === "string" ? record.errorMessage : null,
    timestamp: typeof record.at === "number" ? record.at : 0,
  };
}

function parseToolEvent(raw: unknown): ToolEventView {
  const record = (raw ?? {}) as Record<string, unknown>;
  const reference = record.reference && typeof record.reference === "object" ? (record.reference as ToolEventView["reference"]) : undefined;
  return {
    toolCallId: typeof record.toolCallId === "string" ? record.toolCallId : "tc-unknown",
    agentRunId: typeof record.agentRunId === "string" ? record.agentRunId : "",
    roleId: (record.roleId as RoleId) ?? "team_leader",
    toolName: typeof record.toolName === "string" ? record.toolName : "",
    status: (record.status as ToolEventView["status"]) ?? "running",
    inputSummary: typeof record.inputSummary === "string" ? record.inputSummary : "",
    resultSummary: typeof record.resultSummary === "string" ? record.resultSummary : "",
    errorCode: typeof record.errorCode === "string" ? record.errorCode : null,
    timestamp: typeof record.at === "number" ? record.at : 0,
    reference,
  };
}

const STAGES: PipelineStage[] = ["idle", "planning", "architecting", "coding", "validating", "reviewing", "previewing", "ready", "failed"];

export function taskToView(task: TaskJson): TaskView {
  const rolesRaw = (task.roles ?? {}) as Record<string, unknown>;
  const roles: Record<string, RoleState> = {};
  for (const key of Object.keys(rolesRaw)) roles[key] = parseRoleState(rolesRaw[key]);
  const agentRuns = Array.isArray(task.agentRuns) ? task.agentRuns.map(parseAgentRun) : [];
  const toolEvents = Array.isArray(task.toolEvents) ? task.toolEvents.map(parseToolEvent) : [];
  const references = toolEvents.filter((t) => t.reference).map((t) => t.reference!);
  let error: TaskView["error"] = null;
  if (task.status === "failed") {
    const failedRole = agentRuns.find((r) => r.status === "failed")?.roleId ?? "team_leader";
    error = { roleId: failedRole, message: task.errorMessage ?? "生成失败，请重试" };
  }
  const stage = STAGES.includes(task.stage as PipelineStage) ? (task.stage as PipelineStage) : "idle";
  return {
    id: task.id,
    conversationId: task.conversationId,
    prompt: task.prompt,
    status: task.status,
    stage,
    roles,
    agentRuns,
    toolEvents,
    references,
    error,
    createdAt: task.createdAt,
  };
}

export function runningRoleOf(task: TaskView): RoleId | null {
  if (task.status !== "running") return null;
  const running = task.agentRuns.find((r) => r.status === "running");
  return running ? running.roleId : null;
}

export function roleName(roleId: RoleId): string {
  return ROLE_META[roleId]?.name ?? roleId;
}

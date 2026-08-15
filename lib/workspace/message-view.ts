import type { MessageJson, TaskJson } from "./api";
import type { ConversationMessage, RoleState } from "@/lib/contracts/conversation";
import type { ProgressPhase, RoleId } from "@/lib/contracts/agent-events";
import { ROLE_META } from "@/lib/contracts/agent-events";
import type { PipelineStage } from "@/lib/contracts/conversation";

/** Server message/task → client view (pure mapping). */
const KNOWN_ROLES: RoleId[] = ["team_leader", "product_manager", "engineer"];

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

/** Sanitized per-phase progress text produced from the model's reasoning side-channel. */
export interface ProgressSummaryView {
  phase: ProgressPhase;
  summary: string;
  timestamp: number;
}

/** Extract a complete JSON string field even when the surrounding object is truncated. */
function extractJsonStringField(text: string, field: string): string | null {
  const match = text.match(new RegExp('"' + field + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"'));
  if (!match) return null;
  try {
    const value = JSON.parse('"' + match[1] + '"') as unknown;
    return typeof value === "string" ? value.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Client-side defense for stage progress text: JSON envelopes (including truncated
 * ones) are unwrapped to their `summary` field; anything still structured is rejected.
 */
export function sanitizeStageProgressText(value: unknown): string | null {
  let text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  const start = text.trimStart();
  if (start.startsWith("[")) return null;
  if (start.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
      const summary = (parsed as { summary?: unknown }).summary;
      if (typeof summary !== "string") return null;
      text = summary.trim();
    } catch {
      const extracted = extractJsonStringField(text, "summary");
      if (!extracted) return null;
      text = extracted;
    }
  }
  const cleaned = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!cleaned || /^[\[{]/.test(cleaned)) return null;
  return cleaned.slice(0, 240) || null;
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
  /** Latest sanitized summary per phase (server persists at most one entry per phase per run). */
  progressSummaries: ProgressSummaryView[];
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

// ── Pipeline stage grouping (used for status only; individual tool calls are never rendered) ──

export type ToolStage = ProgressPhase;

export const TOOL_STAGE_ORDER: ToolStage[] = ["planning", "coding", "validating", "previewing"];

export const TOOL_STAGE_LABELS: Record<ToolStage, string> = {
  planning: "规划与任务分配",
  coding: "编写代码",
  validating: "构建验证",
  previewing: "预览提交",
};

/** Map a persisted pipeline stage to a progress phase (null once the task is not actively progressing). */
export function activeToolStage(taskStage: string | undefined): ToolStage | null {
  if (!taskStage) return null;
  if (TOOL_STAGE_ORDER.includes(taskStage as ToolStage)) return taskStage as ToolStage;
  return null;
}

/** Build/check tools belong to the validating stage (mirrors the server ROLE_STAGE mapping). */
const VALIDATING_TOOLS = new Set(["run_lint", "run_typecheck", "run_tests", "run_build", "security_scan", "get_build_errors", "get_test_failures"]);

/** Stable stage for a tool event (events never migrate between blocks). */
export function toolEventStage(event: Pick<ToolEventView, "roleId" | "toolName">): ToolStage {
  if (event.roleId === "team_leader") {
    return event.toolName === "render_preview" || event.toolName === "complete_run" ? "previewing" : "planning";
  }
  if (event.roleId === "engineer") {
    return VALIDATING_TOOLS.has(event.toolName) ? "validating" : "coding";
  }
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

// ── Phase progress derived from staged chain-of-thought summaries ──

export type StageProgressStatus = "pending" | "running" | "completed" | "failed";

export interface StageProgressEntryView extends ProgressSummaryView {
  agentRunId: string;
  roleId: RoleId;
}

export interface StageProgressView {
  stage: ToolStage;
  status: StageProgressStatus;
  /** Latest staged reasoning summary for this phase; null when only legacy tool evidence exists. */
  summary: string | null;
  entries: StageProgressEntryView[];
}

function progressEntriesOf(agentRuns: AgentRunView[]): StageProgressEntryView[] {
  return agentRuns
    .flatMap((run) =>
      run.progressSummaries.map((entry) => ({
        ...entry,
        agentRunId: run.agentRunId,
        roleId: run.roleId,
      }))
    )
    .sort(
      (left, right) =>
        left.timestamp - right.timestamp || left.agentRunId.localeCompare(right.agentRunId)
    );
}

/** Current phase while the pipeline is active, falling back to the newest live evidence. */
function currentProgressPhase(
  task: Pick<TaskView, "agentRuns" | "stage" | "toolEvents">
): ToolStage | null {
  const direct = activeToolStage(task.stage);
  if (direct) return direct;
  const entries = progressEntriesOf(task.agentRuns);
  if (entries.length > 0) return entries[entries.length - 1].phase;
  const events = task.toolEvents
    .filter((event) => event.timestamp > 0)
    .sort((left, right) => left.timestamp - right.timestamp);
  if (events.length > 0) return toolEventStage(events[events.length - 1]);
  return null;
}

/** On failure, the last phase with live evidence is the one the UI marks as failed. */
function failedProgressPhase(task: Pick<TaskView, "agentRuns" | "stage" | "toolEvents">): ToolStage {
  const failedEvents = task.toolEvents
    .filter((event) => event.status === "failed")
    .sort((left, right) => left.timestamp - right.timestamp);
  if (failedEvents.length > 0) return toolEventStage(failedEvents[failedEvents.length - 1]);
  const entries = progressEntriesOf(task.agentRuns);
  if (entries.length > 0) return entries[entries.length - 1].phase;
  return activeToolStage(task.stage) ?? "planning";
}

/**
 * Build the four-phase progress list for a task. Status is derived from the pipeline
 * stage plus (hidden) tool evidence; the visible text comes from the staged
 * chain-of-thought summaries, never from individual tool calls.
 */
export function buildStageProgress(
  task: Pick<TaskView, "agentRuns" | "error" | "stage" | "status" | "toolEvents">
): StageProgressView[] {
  const entriesByStage = new Map<ToolStage, StageProgressEntryView[]>(
    TOOL_STAGE_ORDER.map((stage) => [stage, []])
  );
  for (const entry of progressEntriesOf(task.agentRuns)) {
    entriesByStage.get(entry.phase)?.push(entry);
  }

  const statuses = new Map<ToolStage, StageProgressStatus>(
    TOOL_STAGE_ORDER.map((stage) => [stage, "pending"])
  );
  const isActive = task.status === "running" || task.status === "pending";
  if (task.status === "ready") {
    for (const stage of TOOL_STAGE_ORDER) statuses.set(stage, "completed");
  } else if (task.status === "failed") {
    const failedStage = failedProgressPhase(task);
    const failedIndex = TOOL_STAGE_ORDER.indexOf(failedStage);
    for (const [index, stage] of TOOL_STAGE_ORDER.entries()) {
      statuses.set(stage, index < failedIndex ? "completed" : index === failedIndex ? "failed" : "pending");
    }
  } else if (isActive) {
    const current = currentProgressPhase(task) ?? "planning";
    const currentIndex = TOOL_STAGE_ORDER.indexOf(current);
    for (const [index, stage] of TOOL_STAGE_ORDER.entries()) {
      statuses.set(stage, index < currentIndex ? "completed" : index === currentIndex ? "running" : "pending");
    }
  }

  return TOOL_STAGE_ORDER.map((stage) => {
    const entries = entriesByStage.get(stage) ?? [];
    return {
      stage,
      status: statuses.get(stage) ?? "pending",
      summary: entries[entries.length - 1]?.summary ?? null,
      entries,
    };
  });
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

function parseProgressSummary(raw: unknown): ProgressSummaryView | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const phase =
    typeof record.phase === "string" && TOOL_STAGE_ORDER.includes(record.phase as ToolStage)
      ? (record.phase as ToolStage)
      : null;
  const summary = sanitizeStageProgressText(record.summary);
  if (!phase || !summary) return null;
  return {
    phase,
    summary,
    timestamp: typeof record.at === "number" ? record.at : 0,
  };
}

function parseProgressSummaries(raw: unknown): ProgressSummaryView[] {
  const source = Array.isArray(raw) ? raw : [];
  // Server persists at most one summary per phase per run; parsing keeps that invariant
  // even for hand-written legacy data and preserves first-seen phase order.
  const byPhase = new Map<ProgressPhase, ProgressSummaryView>();
  for (const item of source) {
    const parsed = parseProgressSummary(item);
    if (!parsed) continue;
    const existing = byPhase.get(parsed.phase);
    if (!existing || parsed.timestamp >= existing.timestamp) byPhase.set(parsed.phase, parsed);
  }
  return [...byPhase.values()];
}

function parseAgentRun(raw: unknown): AgentRunView {
  const record = (raw ?? {}) as Record<string, unknown>;
  const roleId = typeof record.roleId === "string" ? (record.roleId as RoleId) : "team_leader";
  const progress = Array.isArray(record.progress)
    ? record.progress
    : Array.isArray(record.progressSummaries)
      ? record.progressSummaries
      : [];
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
    progressSummaries: parseProgressSummaries(progress),
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

const STAGES: PipelineStage[] = ["idle", "planning", "coding", "validating", "previewing", "awaiting_approval", "ready", "failed"];

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

import { z } from "zod";
import { appSpecSchema } from "./app-spec";
import { qubitsManifestSchema } from "./manifest";

/**
 * Agent and Tool Call event protocol.
 * New path: Mike (team_leader) is the single root agent per run; all sub-agents, search,
 * Preview, and completion are driven by real Tool Calls; legacy role_started/role_completed/app_ready
 * are kept for compat parsing (old data), new runs only emit new events.
 */

export const roleIdSchema = z.enum([
  "team_leader",
  "product_manager",
  "engineer",
]);
export type RoleId = z.infer<typeof roleIdSchema>;

/** Display mapping: Chinese display names (role ids stay English for protocol compatibility). */
export const ROLE_META: Record<RoleId, { id: RoleId; name: string; title: string; responsibility: string; accent: string; internal?: boolean }> = {
  team_leader: {
    id: "team_leader",
    name: "迈克",
    title: "团队领队",
    responsibility: "协调用户需求，把任务分配给最合适的团队成员",
    accent: "bg-sky-600",
  },
  product_manager: {
    id: "product_manager",
    name: "艾玛",
    title: "产品经理",
    responsibility: "把愿景转化为 PRD、用户旅程、目标与优先级",
    accent: "bg-violet-500",
  },
  engineer: {
    id: "engineer",
    name: "亚历克斯",
    title: "工程师",
    responsibility: "通过 workspace 工具编写真实 React/TypeScript 代码并构建验证",
    accent: "bg-emerald-500",
  },
};

export const ROLE_RUNNING_TEXT: Record<RoleId, string> = {
  team_leader: "正在理解需求并决定任务分配…",
  product_manager: "正在把愿景转化为产品简报…",
  engineer: "正在编写并验证应用代码…",
};

export const progressPhaseSchema = z.enum(["planning", "coding", "validating", "previewing"]);
export type ProgressPhase = z.infer<typeof progressPhaseSchema>;

// Real gateways may return non "tc-" tool call ids (call_xxx / toolu_xxx); strict regexes
// would silently drop streamed events client-side.
const toolCallId = z.string().min(1).max(128);
const agentRunId = z.string().min(1).max(128);
const delegationId = z.string().min(1).max(128);
const artifactId = z.string().min(1).max(128);

export const agentEventSchema = z.discriminatedUnion("type", [
  // ── New path: agent tree and tool-call activity stream ──
  z.object({
    type: z.literal("agent_started"),
    agentRunId,
    roleId: roleIdSchema,
    parentAgentRunId: agentRunId.nullable(),
    taskSummary: z.string().max(300).default(""),
  }),
  z.object({
    type: z.literal("agent_delegated"),
    delegationId,
    parentAgentRunId: agentRunId,
    childAgentRunId: agentRunId,
    targetRole: roleIdSchema,
    taskSummary: z.string().max(300),
  }),
  z.object({
    type: z.literal("tool_call_started"),
    toolCallId,
    agentRunId,
    roleId: roleIdSchema,
    toolName: z.string().max(60),
    inputSummary: z.string().max(300).default(""),
    /** Index in the model's tool_calls array (aligns with streamed deltas). */
    index: z.number().int().nonnegative().max(16).optional(),
  }),
  z.object({
    type: z.literal("tool_result"),
    toolCallId,
    agentRunId,
    roleId: roleIdSchema,
    toolName: z.string().max(60),
    ok: z.boolean(),
    resultSummary: z.string().max(300).default(""),
    artifactIds: z.array(artifactId).default([]),
    errorCode: z.string().max(60).optional(),
    durationMs: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("agent_completed"),
    agentRunId,
    roleId: roleIdSchema,
    summary: z.string().max(300),
    artifactId: artifactId.optional(),
  }),
  z.object({
    type: z.literal("agent_failed"),
    agentRunId,
    roleId: roleIdSchema,
    message: z.string().max(300),
  }),
  z.object({
    type: z.literal("reference_found"),
    resultId: z.string().max(64),
    title: z.string().max(200),
    url: z.string().max(500),
    domain: z.string().max(120),
    snippet: z.string().max(600),
    source: z.string().max(40),
  }),
  z.object({
    type: z.literal("preview_requested"),
    toolCallId,
    artifactId,
  }),
  z.object({
    type: z.literal("preview_ready"),
    previewArtifactId: artifactId,
    /** Preview now carries the built code bundle + the validated manifest (never AppSpec). */
    appName: z.string().max(120),
    manifest: qubitsManifestSchema,
    version: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("run_completed"),
    summary: z.string().max(300),
    suggestions: z.array(z.string().max(160)).max(3),
  }),
  z.object({
    type: z.literal("approval_requested"),
    approvalId: z.string().max(64),
    toolCallId: z.string().max(64),
    toolName: z.string().max(60),
    reason: z.string().max(400),
  }),
  z.object({
    type: z.literal("sandbox_log"),
    streamId: z.string().max(64),
    chunk: z.string().max(2000),
  }),
  z.object({
    /** Safe, independently generated progress text; raw reasoning is never an event. */
    type: z.literal("progress_summary"),
    agentRunId,
    roleId: roleIdSchema,
    phase: progressPhaseSchema,
    summary: z.string().min(1).max(240),
  }),
  z.object({
    type: z.literal("tool_call_delta"),
    agentRunId,
    roleId: roleIdSchema,
    index: z.number().int().nonnegative().max(16),
    toolCallId: z.string().min(1).max(128).optional(),
    toolName: z.string().max(60).optional(),
    argumentsDelta: z.string().max(4000).default(""),
  }),
  z.object({
    type: z.literal("error"),
    roleId: roleIdSchema.optional(),
    toolName: z.string().max(60).optional(),
    message: z.string().max(400),
    code: z.string().max(60).optional(),
  }),
  z.object({ type: z.literal("done") }),
  // ── Legacy path compatibility (old data / old client parsing) ──
  z.object({ type: z.literal("role_started"), roleId: roleIdSchema }),
  z.object({ type: z.literal("role_completed"), roleId: roleIdSchema, artifact: z.unknown(), summary: z.string() }),
  z.object({ type: z.literal("app_ready"), appSpec: appSpecSchema }),
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;

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
  "researcher",
  "architect",
  "engineer",
  "data_scientist",
  "reviewer",
  "security_reviewer", // legacy data compatibility
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
  researcher: {
    id: "researcher",
    name: "艾瑞斯",
    title: "研究员",
    responsibility: "通过受控搜索收集市场、用户与竞品参考，输出带来源报告",
    accent: "bg-cyan-600",
  },
  architect: {
    id: "architect",
    name: "鲍勃",
    title: "系统架构师",
    responsibility: "设计与 Qubits 能力匹配的可靠技术蓝图",
    accent: "bg-amber-500",
  },
  engineer: {
    id: "engineer",
    name: "亚历克斯",
    title: "工程师",
    responsibility: "通过 workspace 工具编写真实 React/TypeScript 代码并构建验证",
    accent: "bg-emerald-500",
  },
  data_scientist: {
    id: "data_scientist",
    name: "大卫",
    title: "数据科学家",
    responsibility: "通过受控工具分析结构化数据，输出可验证的数据洞察",
    accent: "bg-orange-500",
  },
  reviewer: {
    id: "reviewer",
    name: "小卫",
    title: "安全评审员（内部）",
    responsibility: "内部质量与安全审查，输出 approved 或结构化 issues",
    accent: "bg-rose-500",
    internal: true,
  },
  security_reviewer: {
    id: "security_reviewer",
    name: "小卫",
    title: "安全评审员（旧）",
    responsibility: "旧版本兼容映射",
    accent: "bg-rose-400",
    internal: true,
  },
};

export const ROLE_RUNNING_TEXT: Record<RoleId, string> = {
  team_leader: "正在理解需求并决定任务分配…",
  product_manager: "正在把愿景转化为产品简报…",
  researcher: "正在搜索并整理参考资料…",
  architect: "正在设计应用蓝图…",
  engineer: "正在编写并验证应用代码…",
  data_scientist: "正在分析结构化数据…",
  reviewer: "正在审校代码与构建报告…",
  security_reviewer: "正在审校应用…",
};

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
    type: z.literal("reasoning_delta"),
    agentRunId,
    roleId: roleIdSchema,
    delta: z.string().min(1).max(4000),
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

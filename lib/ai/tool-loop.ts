import "server-only";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { AgentTurnResponse, AIProvider, ChatMessage, ToolCall, ToolSpec } from "./provider";
import { getProvider } from "./provider";
import type { RoleId } from "@/lib/contracts/agent-events";
import { getToolDefinition, getToolDefinitionsForRole, executeTool, ToolExecutionError } from "./tools/registry";
import { createApproval, isApproved } from "./tools/approval";
import type { ToolExecutionContext } from "./tools/types";
import { isToolError } from "./tools/references";
import { isAbortLike } from "@/lib/workspace/errors";

/**
 * Centralized tool-calling agent loop:
 * - every provider round trip has a timeout/AbortSignal;
 * - max 20 rounds per agent (no global tool-call count limit);
 * - tool results are fed back to the same message as role:tool + tool_call_id;
 * - final text must pass the corresponding Zod schema;
 * - when the model makes no tool call but one is required, return TOOL_CALL_REQUIRED (never fake tool events).
 */

const MAX_ROUNDS = 20;
const TOOL_REQUIRED_CODE = "TOOL_CALL_REQUIRED";

export class ToolLoopError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolLoopError";
    this.code = code;
  }
}

interface RunAgentInput {
  roleId: RoleId;
  agentRunId: string;
  systemPrompt: string;
  taskPrompt: string;
  finalSchema: z.ZodType;
  context: ToolExecutionContext;
  signal?: AbortSignal;
  /** Whether this agent must produce at least one real tool call (e.g. Mike's app tasks). */
  requireToolCall: boolean;
  /** Test injection: overrides the model provider from getProvider(). */
  providerOverride?: AIProvider;
}

/** Consecutive tool-failure threshold: QUIBITS_MAX_TOOL_FAILURES (default 3, min 1). */
export function readMaxToolFailures(): number {
  const parsed = Number.parseInt(process.env.QUIBITS_MAX_TOOL_FAILURES ?? "3", 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 3;
}

/** Common tool error codes → model-facing repair suggestions: injected into role:tool results and correction messages to help the agent fix on the first try. */
const REPAIR_HINTS: Record<string, string> = {
  PATH_ESCAPE: "文件工具只接受工作区内的相对路径（禁止以 / 开头的绝对路径与 ../），可先用 fs_list 查看目录结构。",
  INVALID_PATH: "路径格式不合法，请改用工作区内的相对路径。",
  SENSITIVE_FILE: "目标属于敏感文件（如 .env、密钥），请改用普通业务文件。",
  SYSTEM_OWNED_FILE: "目标属于系统维护文件（package.json/tsconfig/SDK bridge/构建配置），AI 不能修改，请改用可写文件。",
  NOT_FOUND: "目标不存在，请先用 fs_list 确认路径与文件名后重试。",
  PATCH_NO_MATCH: "oldText 未在文件中命中，请先用 fs_read 确认文件当前内容再重试。",
  INVALID_ARGS: "参数不符合该工具的 schema，请检查参数名、类型与必填字段。",
  ARTIFACT_NOT_FOUND: "artifact 不存在，请先用 get_artifact 确认有效 id 后重试。",
  COLLECTION_NOT_DECLARED: "集合未在 qubits.manifest.json 中声明，请修改 manifest 声明该集合并通过校验。",
  WORKSPACE_NOT_INITIALIZED: "工作区尚未初始化，请先调用 workspace_init。",
  INVALID_MANIFEST: "qubits.manifest.json 未通过校验，请按问题清单修正（构建入口 src/main.tsx 由系统固定）。",
  INVALID_DEPENDENCY: "依赖必须来自服务端 allowlist 固定版本（用 dependency_list 查看），禁止任意包名/URL/Git 依赖。",
  BUILD_FAILED: "构建失败，请用 get_build_errors 查看真实错误并修复后重新 run_build，不要虚构成功。",
  TYPECHECK_FAILED: "类型检查失败，请按 tsc 报错修复后重新 run_typecheck。",
  TEST_FAILED: "测试失败，请修复断言或实现后重新 run_tests。",
  SECURITY_BLOCKED: "静态安全扫描阻断（eval/网络/存储/密钥等），请移除违规代码后重新 build。",
  PREVIEW_BLOCKED: "Reviewer 尚未批准，请先委派 Reviewer 审校并在通过后重试。",
  SEARCH_NOT_CONFIGURED: "参考搜索服务未配置，重试无法解决；请改用其他方式或向迈克报告。",
  SANDBOX_NOT_CONFIGURED: "沙箱未配置，重试无法解决；请改用其他方式或向迈克报告。",
  DATA_NOT_CONFIGURED: "数据服务未配置，重试无法解决；请改用其他方式或向迈克报告。",
  APPROVAL_REQUIRED: "该操作需要用户审批，请等待审批通过后重试，不要反复触发审批。",
  TOOL_BUDGET_EXCEEDED: "调用预算已用尽（对话轮次或子 Agent 数量上限），请基于已有信息直接给出结论或改用其他方式。",
  PREVIEW_REQUIRED: "必须先成功调用 render_preview 提交预览，才能继续或完成运行。",
  REPEATED_CALL: "不要原样重复上一次失败的调用，请先修改参数。",
  TOOL_RESULT_TOO_LARGE: "上一次工具结果过大，请缩小读取范围或按需筛选。",
};

/** Don't fabricate suggestions for unknown error codes; the model still receives the raw error message. */
function repairHint(code?: string): string {
  if (!code) return "";
  return REPAIR_HINTS[code] ?? "";
}

/** Extract tool args for the correction message (redacted + truncated) so the model sees what it last passed. */
function summarizeArgsForCorrection(rawArguments: string): string {
  const SECRET_KEYS = /(apiKey|api_key|apikey|secret|password|token|authorization)/i;
  try {
    const parsed = JSON.parse(rawArguments || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const cleaned: Record<string, string> = {};
      for (const [key, value] of Object.entries(record)) {
        if (SECRET_KEYS.test(key)) {
          cleaned[key] = "***";
        } else if (value === null || value === undefined) {
          cleaned[key] = String(value);
        } else if (typeof value === "object") {
          cleaned[key] = JSON.stringify(value).slice(0, 120);
        } else {
          cleaned[key] = String(value).slice(0, 120);
        }
      }
      return JSON.stringify(cleaned).slice(0, 400);
    }
    return rawArguments.slice(0, 300);
  } catch {
    return rawArguments.slice(0, 300);
  }
}

/** Normalize arg keys to detect a call identical to the previous failure (order-independent). */
function argsKeyFor(call: ToolCall): string {
  try {
    return JSON.stringify(JSON.parse(call.rawArguments || "{}"));
  } catch {
    return call.rawArguments || "{}";
  }
}

interface ValidatedAgentResult {
  status: "completed" | "failed";
  summary: string;
  artifact: unknown | null;
  issues: string[];
  toolCallsMade: number;
}

/** Providers may omit call ids; generate one before writing assistant history and reuse it in the result. */
export function normalizeTurnToolCalls(toolCalls: ToolCall[]): ToolCall[] {
  const seen = new Set<string>();
  return toolCalls.map((call, index) => {
    const name = call.name.trim();
    if (!name) throw new ToolLoopError("INVALID_TOOL_CALL", `模型返回的第 ${index + 1} 个工具调用缺少名称`);
    const id = call.id.trim() || "tc-" + crypto.randomUUID();
    if (seen.has(id)) {
      throw new ToolLoopError("INVALID_TOOL_CALL", `模型返回了重复的 tool call id：${id}`);
    }
    seen.add(id);
    return { ...call, id, name };
  });
}

function extractJsonObject(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return { ok: true, value: JSON.parse(trimmed.slice(start, end + 1)) };
      } catch {
        return { ok: false, error: "JSON 解析失败" };
      }
    }
    return { ok: false, error: "未找到 JSON 对象" };
  }
}

function toolSpecsFor(roleId: RoleId): ToolSpec[] {
  return getToolDefinitionsForRole(roleId).map((definition) => ({
    name: definition.name,
    description: definition.description,
    parameters: zodToJsonSchema(definition.argsSchema, { $refStrategy: "none", name: undefined }) as Record<string, unknown>,
  }));
}

export async function runToolCallingAgent(input: RunAgentInput): Promise<ValidatedAgentResult> {
  const provider = input.providerOverride ?? getProvider();
  const maxToolFailures = readMaxToolFailures();
  const messages: ChatMessage[] = [{ role: "user", content: input.taskPrompt }];
  let toolCallsMade = 0;
  let consecutiveFailures = 0;
  // the previous failed call (tool name + normalized args + error code): used to fast-reject identical retries.
  let lastFailure: { name: string; argsKey: string; code: string } | null = null;

  const respondTool = (callId: string, content: string): ChatMessage => ({
    role: "tool",
    tool_call_id: callId,
    content: content.slice(0, 24 * 1024),
  });

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let turn: AgentTurnResponse;
    try {
      turn = await provider.generateWithTools({
        system: input.systemPrompt,
        messages,
        tools: toolSpecsFor(input.roleId),
        roleId: input.roleId,
        signal: input.signal,
      });
    } catch (error) {
      // Provider errors carry stable codes (e.g. PROVIDER_TIMEOUT) that must survive to the task error.
      const code = (error as { code?: unknown })?.code;
      if (typeof code === "string" && code.length > 0) {
        throw new ToolLoopError(code, error instanceof Error ? error.message.slice(0, 300) : "模型服务错误");
      }
      throw error;
    }

    if (turn.toolCalls.length > 0) {
      const calls = normalizeTurnToolCalls(turn.toolCalls);
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: turn.content,
        tool_calls: calls,
        reasoning_content: turn.reasoningContent ?? null,
      };
      messages.push(assistantMessage);
      const toolResults: ChatMessage[] = [];
      const failureInstructions: string[] = [];
      for (const call of calls) {
        // No global call cap: only counted for stats; the failure threshold and round budget trip instead.
        input.context.counters.toolCalls += 1;
        toolCallsMade += 1;
        const toolCallId = call.id;
        input.context.emit({
          type: "tool_call_started",
          toolCallId,
          agentRunId: input.agentRunId,
          roleId: input.roleId,
          toolName: call.name.slice(0, 60),
          inputSummary: summarizeArgs(call),
        });
        const argsKey = argsKeyFor(call);
        // fast-fail a call identical to the previous failure to avoid retry loops (except approvals: after approval an identical retry should be allowed).
        const identicalRetry =
          lastFailure !== null &&
          lastFailure.code !== "APPROVAL_REQUIRED" &&
          lastFailure.name === call.name &&
          lastFailure.argsKey === argsKey;
        let outcome: { ok: boolean; result: unknown; summary: string; errorCode?: string; artifactIds: string[]; durationMs: number };
        const startedAt = Date.now();
        if (identicalRetry) {
          outcome = {
            ok: false,
            result: null,
            summary: "与上一次失败的调用完全相同（" + call.name + "），已跳过执行。请修改参数或改用其他工具，不要原样重试。",
            errorCode: "REPEATED_CALL",
            artifactIds: [],
            durationMs: 0,
          };
        } else {
          try {
            const definition = getToolDefinition(call.name);
            if (definition?.requiresApproval && !isToolApproved(input.context, call.name)) {
              const approvalId = createApprovalFor(input.context.runId, call.name);
              input.context.emit({
                type: "approval_requested",
                approvalId,
                toolCallId,
                toolName: call.name,
                reason: "工具 " + call.name + " 属于高风险操作，需要用户审批后重试。",
              });
              throw new ToolExecutionError("APPROVAL_REQUIRED", "工具需要用户审批（approvalId: " + approvalId + "）", true);
            }
            const result = await executeTool(call.name, parseToolArgs(call), input.context);
            outcome = {
              ok: true,
              result,
              summary: summarizeResult(call.name, result),
              artifactIds: collectArtifactIds(result),
              durationMs: Date.now() - startedAt,
            };
          } catch (error) {
            // Client aborts must propagate (they map to CLIENT_ABORTED upstream), never mask as tool failures.
            if (input.context.signal.aborted || isAbortLike(error)) throw error;
            const shape = isToolError(error) || error instanceof ToolExecutionError
              ? { code: (error as { code: string }).code, message: error instanceof Error ? error.message : "工具执行失败" }
              : { code: "TOOL_ERROR", message: error instanceof Error ? error.message.slice(0, 300) : "工具执行失败" };
            outcome = { ok: false, result: null, summary: shape.message.slice(0, 300), errorCode: shape.code.slice(0, 60), artifactIds: [], durationMs: Date.now() - startedAt };
          }
        }
        input.context.emit({
          type: "tool_result",
          toolCallId,
          agentRunId: input.agentRunId,
          roleId: input.roleId,
          toolName: call.name.slice(0, 60),
          ok: outcome.ok,
          resultSummary: outcome.summary.slice(0, 300),
          artifactIds: outcome.artifactIds,
          errorCode: outcome.errorCode,
          durationMs: outcome.durationMs,
        });
        // real protocol: results are fed back as role:tool, never concatenated into plain user text
        const errorHint = repairHint(outcome.errorCode);
        const toolPayload = JSON.stringify(
          outcome.ok
            ? outcome.result
            : { error: { code: outcome.errorCode, message: outcome.summary, ...(errorHint ? { hint: errorHint } : {}) } }
        ) ?? "null";
        toolResults.push(respondTool(toolCallId, toolPayload));
        if (outcome.ok) {
          consecutiveFailures = 0;
          lastFailure = null;
        } else {
          consecutiveFailures += 1;
          lastFailure = { name: call.name, argsKey, code: outcome.errorCode ?? "TOOL_ERROR" };
          // inject the failure and error into context so the agent corrects itself (fix args or try another approach)
          failureInstructions.push(
            "工具调用失败：" + call.name + "（错误码 " + (outcome.errorCode ?? "TOOL_ERROR") + "）：" + outcome.summary +
            "。你传入的参数：" + summarizeArgsForCorrection(call.rawArguments) +
            (errorHint ? "。修复建议：" + errorHint : "") +
            "。请修改参数、换一种方式完成目标，或改用其他可用工具后重试。"
          );
          if (consecutiveFailures > maxToolFailures) {
            const message =
              "工具调用连续失败 " + consecutiveFailures + " 次（阈值 " + maxToolFailures + "），已停止执行。最后错误：" + outcome.summary;
            input.context.emit({ type: "error", roleId: input.roleId, message, code: "TOOL_FAILURE_LIMIT_EXCEEDED" });
            throw new ToolLoopError("TOOL_FAILURE_LIMIT_EXCEEDED", message);
          }
        }
      }
      // after assistant.tool_calls, the whole batch of tool messages must be filled in first; user correction text can only come after the batch.
      messages.push(...toolResults);
      if (failureInstructions.length > 0) {
        messages.push({
          role: "user",
          content:
            failureInstructions.join("\n") +
            "\n请针对以上每一条失败分别修正后继续，不要原样重复任何一次失败的调用。",
        });
      }
      continue;
    }

    // no tool call: try the final structured result
    const content = turn.content ?? "";
    const extracted = extractJsonObject(content);
    if (extracted.ok) {
      const parsed = input.finalSchema.safeParse(extracted.value);
      if (parsed.success) {
        if (input.requireToolCall && toolCallsMade === 0) {
          throw new ToolLoopError(TOOL_REQUIRED_CODE, "该阶段必须通过真实工具调用完成，模型未发起任何工具调用");
        }
        const summary = typeof (parsed.data as { summary?: unknown }).summary === "string"
          ? ((parsed.data as { summary: string }).summary.slice(0, 300))
          : "已完成";
        return { status: "completed", summary, artifact: parsed.data, issues: [], toolCallsMade };
      }
      messages.push({ role: "user", content: "你的输出未通过校验：" + JSON.stringify(parsed.error.issues.slice(0, 8)) + "。请修正后重新输出符合 schema 的 JSON。" });
      continue;
    }
    messages.push({ role: "user", content: "你的输出不是合法 JSON：" + extracted.error.slice(0, 200) + "。请重新输出。" });
  }
  throw new ToolLoopError("TOOL_BUDGET_EXCEEDED", "该 Agent 的对话轮次超出预算（20）");
}

function parseToolArgs(call: ToolCall): unknown {
  try {
    return JSON.parse(call.rawArguments || "{}");
  } catch {
    throw new ToolExecutionError("INVALID_ARGS", "工具参数不是合法 JSON");
  }
}

function summarizeArgs(call: ToolCall): string {
  try {
    const parsed = JSON.parse(call.rawArguments || "{}") as Record<string, unknown>;
    const entries = Object.entries(parsed)
      .filter(([key, value]) => key !== "task" && value != null)
      .map(([key, value]) => key + "=" + String(value).slice(0, 40))
      .join(", ");
    const task = typeof parsed.task === "string" ? parsed.task.slice(0, 80) : "";
    // The client event schema caps inputSummary length; truncate server-side or events get dropped.
    return ((task ? "task:" + task + " " : "") + entries.slice(0, 160)).slice(0, 240);
  } catch {
    return call.rawArguments.slice(0, 160);
  }
}

function summarizeResult(toolName: string, result: unknown): string {
  const record = (typeof result === "object" && result !== null ? result : {}) as Record<string, unknown>;
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  const num = (value: unknown): number => (typeof value === "number" ? value : Number(value) || 0);
  const len = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

  switch (toolName) {
    case "delegate_to_agent": {
      const r = record as { targetRole?: string; status?: string; summary?: string };
      return "已委派 " + (r.targetRole ?? "") + "：" + (r.status ?? "") + " " + (r.summary ?? "").slice(0, 120);
    }
    case "search_references":
      return "找到 " + len(record.results) + " 条参考";
    case "open_reference":
      return "读取参考：" + str(record.title).slice(0, 120);
    case "inspect_current_app":
      return record.hasApp ? "当前应用：" + str(record.appSummary).slice(0, 160) : "当前没有可用应用";
    case "workspace_init":
      return "工作区就绪（" + SEEDED_LABELS[str(record.seededFrom)] + "）· " + num(record.fileCount) + " 个文件";
    case "workspace_get_manifest":
      return "manifest：「" + str(record.name) + "」· " + len(record.collections) + " 个集合 · " + len(record.dependencies) + " 个依赖";
    case "workspace_list_files":
      return "共 " + len(record.entries) + " 项" + (record.truncated ? "（已截断）" : "");
    case "dependency_list":
      return "已声明 " + len(record.dependencies) + " 个依赖 · allowlist " + len(record.allowlist) + " 项";
    case "dependency_add":
      return "添加依赖 " + str(record.name) + "@" + str(record.version);
    case "dependency_remove":
      return (record.removed ? "已移除依赖 " : "依赖未声明：") + str(record.name);
    case "fs_write":
      return "写入 " + str(record.path) + "（" + num(record.bytesWritten) + " 字节）· " + str(record.diffSummary);
    case "fs_patch":
      return "修改 " + str(record.path) + "（" + num(record.replaced) + " 处）· " + str(record.diffSummary);
    case "fs_read":
      return "读取 " + str(record.path) + (record.truncated ? "（已截断）" : "");
    case "fs_list":
      return "列出 " + len(record.entries) + " 项";
    case "fs_stat":
      return "stat " + str(record.path) + "（" + str(record.type) + " · " + num(record.size) + " 字节）";
    case "fs_search":
      return "搜索命中 " + len(record.matches) + " 处";
    case "fs_delete":
      return "已删除 " + str(record.path) + (record.soft ? "（软删除）" : "");
    case "fs_create_dir":
      return "创建目录 " + str(record.path);
    case "fs_copy":
      return "复制 " + str(record.from) + " → " + str(record.to);
    case "fs_move":
      return "移动 " + str(record.from) + " → " + str(record.to);
    case "run_format":
      return "已检查 " + num(record.formatted) + " 个文件，改写 " + num(record.changed) + " 个";
    case "run_lint":
    case "run_typecheck":
    case "run_tests": {
      const label = toolName === "run_lint" ? "Lint" : toolName === "run_typecheck" ? "类型检查" : "测试";
      const status = str(record.status);
      if (status === "passed") return label + "通过";
      if (status === "timeout") return label + "超时";
      return label + "失败（exitCode=" + num(record.exitCode) + "）";
    }
    case "run_build":
      return record.status === "success"
        ? "构建成功 · preview_bundle 已产出"
        : "构建失败：" + (str(record.errorCode) || "BUILD_FAILED");
    case "get_build_errors":
      return record.hasReport
        ? "最近构建：" + (record.status === "success" ? "成功" : "失败（" + str(record.errorCode) + "）")
        : "暂无构建报告";
    case "get_test_failures":
      return record.hasReport ? "最近测试：" + (record.status === "passed" ? "通过" : "失败") : "暂无测试报告";
    case "security_scan":
      return record.status === "pass"
        ? "静态扫描通过（" + num(record.filesScanned) + " 个文件）"
        : "发现 " + len(record.findings) + " 项阻断问题";
    case "create_code_snapshot":
      return "快照 " + str(record.snapshotId).slice(0, 12) + "…（" + len(record.files) + " 个文件）";
    case "restore_code_snapshot":
      return "已恢复 " + num(record.restored) + " 个文件";
    case "render_preview": {
      const r = record as { appName?: string; version?: number };
      return "预览已就绪：" + (r.appName ?? "") + " v" + (r.version ?? 0);
    }
    case "complete_run":
      return "运行已完成";
    case "sandbox_exec":
      return "沙盒执行 exitCode=" + num(record.exitCode) + (record.timedOut ? "（超时）" : "");
    case "query_records":
      return "查询到 " + len(record.records) + " 条记录" + (record.truncated ? "（已截断）" : "");
    case "count_records":
      return "共 " + num(record.count) + " 条记录";
    case "aggregate_records":
    case "analyze_project_data":
      return "聚合 " + str(record.metric) + " = " + str(record.value);
    case "create_record":
      return "已创建记录";
    case "update_record":
      return record.updated ? "已更新记录" : "记录未更新";
    case "delete_record":
      return record.deleted ? "已删除记录" : "记录未删除";
    case "seed_demo_data":
      return "写入演示数据 " + num(record.seeded) + " 条";
    case "create_artifact":
      return "已保存 artifact（" + str(record.artifactId).slice(0, 12) + "…）";
    case "get_artifact":
      return "artifact：" + str(record.kind);
    case "compare_artifacts":
      return record.sameKind ? "同类 artifact · 差异 " + len(record.changedKeys) + " 项" : "不同类 artifact";
    default:
      break;
  }

  // Generic fallback: flatten JSON into a compact key/value list instead of raw JSON.
  const parts = Object.entries(record)
    .filter(([, value]) => value !== undefined && value !== null)
    .slice(0, 5)
    .map(([key, value]) => key + " " + compactValue(value));
  return parts.length > 0 ? parts.join(" · ") : "完成";
}

const SEEDED_LABELS: Record<string, string> = {
  template: "可信模板",
  snapshot: "上次成功快照",
  existing: "已存在（复用）",
};

function compactValue(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 48);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length + " 项";
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return text.length > 56 ? text.slice(0, 56) + "…" : text;
  }
  return String(value ?? "");
}

function createApprovalFor(runId: string, toolName: string): string {
  return createApproval(runId, toolName);
}

function isToolApproved(context: ToolExecutionContext, toolName: string): boolean {
  return context.approvedTools.has(toolName) || isApproved(context.runId, toolName);
}

function collectArtifactIds(result: unknown): string[] {
  if (typeof result !== "object" || result === null) return [];
  const record = result as Record<string, unknown>;
  const ids: string[] = [];
  if (typeof record.artifactId === "string") ids.push(record.artifactId);
  if (typeof record.previewArtifactId === "string") ids.push(record.previewArtifactId);
  return ids.slice(0, 12);
}

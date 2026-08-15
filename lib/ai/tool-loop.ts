import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { AgentTurnResponse, AIProvider, ChatMessage, ToolCall, ToolChoiceSpec, ToolSpec } from "./provider";
import { getProvider } from "./provider";
import type { RoleId } from "@/lib/contracts/agent-events";
import { getToolDefinition, getToolDefinitionsForRole, getToolEffect, executeTool, ToolExecutionError } from "./tools/registry";
import { createApproval, isApproved } from "./tools/approval";
import type { ToolExecutionContext } from "./tools/types";
import { isToolError } from "./tools/references";
import { isAbortLike } from "@/lib/workspace/errors";

/**
 * Centralized tool-calling agent loop.
 *
 * The Controller, not the prompt, decides what the model may do next:
 * - every provider round trip has a timeout/AbortSignal and per-role budgets
 *   (rounds / tool calls / total deadline);
 * - every successful observation is fingerprinted (semantic args + normalized result
 *   digest + state version) into a bounded history; identical observations, even with
 *   different arguments, are recognized as DUPLICATE_OBSERVATION and the tool is
 *   gated without retry advice;
 * - identical failed calls become REPEATED_FAILED_CALL (execution skipped; fixable
 *   errors may still be retried with different arguments);
 * - A-B-A-B alternations and other non-progressing loops trigger NO_PROGRESS, and the
 *   Controller forces the next step: force_final (tools disabled, tool_choice "none")
 *   or force_next_tool (only one tool exposed and forced);
 * - tool results and Controller instructions are separate: the role:"tool" message
 *   only explains what happened; a following user message carries the directive.
 */

interface RoleBudget {
  maxRounds: number;
  maxToolCalls: number;
  deadlineMs: number;
}

/** Per-role convergence budgets: the architect is a pure designer and must converge fast. */
const ROLE_BUDGETS: Record<RoleId, RoleBudget> = {
  team_leader: { maxRounds: 40, maxToolCalls: 60, deadlineMs: 900_000 },
  product_manager: { maxRounds: 8, maxToolCalls: 10, deadlineMs: 240_000 },
  researcher: { maxRounds: 12, maxToolCalls: 20, deadlineMs: 300_000 },
  architect: { maxRounds: 12, maxToolCalls: 12, deadlineMs: 240_000 },
  engineer: { maxRounds: 60, maxToolCalls: 120, deadlineMs: 1_200_000 },
  data_scientist: { maxRounds: 10, maxToolCalls: 15, deadlineMs: 240_000 },
  reviewer: { maxRounds: 15, maxToolCalls:30, deadlineMs: 600_000 },
  security_reviewer: { maxRounds: 10, maxToolCalls: 20, deadlineMs: 300_000 },
};

function roleBudget(roleId: RoleId): RoleBudget {
  const budget = ROLE_BUDGETS[roleId] ?? ROLE_BUDGETS.team_leader;
  let next = { ...budget };
  const deadlineOverride = Number.parseInt(process.env.QUIBITS_AGENT_DEADLINE_MS ?? "", 10);
  if (Number.isFinite(deadlineOverride) && deadlineOverride > 0) next = { ...next, deadlineMs: deadlineOverride };
  const maxRounds = Number.parseInt(process.env.QUIBITS_AGENT_MAX_ROUNDS ?? "", 10);
  if (Number.isFinite(maxRounds) && maxRounds >= 1) next = { ...next, maxRounds };
  const maxToolCalls = Number.parseInt(process.env.QUIBITS_AGENT_MAX_TOOL_CALLS ?? "", 10);
  if (Number.isFinite(maxToolCalls) && maxToolCalls >= 1) next = { ...next, maxToolCalls };
  return next;
}

/** Total tool-failure cap (regardless of interleaved successes). */
export function readMaxTotalToolFailures(): number {
  const parsed = Number.parseInt(process.env.QUIBITS_MAX_TOOL_FAILURES_TOTAL ?? "8", 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 8;
}

/** Consecutive tool-failure threshold: QUIBITS_MAX_TOOL_FAILURES (default 3, min 1). */
export function readMaxToolFailures(): number {
  const parsed = Number.parseInt(process.env.QUIBITS_MAX_TOOL_FAILURES ?? "3", 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 3;
}

const TOOL_REQUIRED_CODE = "TOOL_CALL_REQUIRED";
/** How many executions of the same observation digest are allowed before it becomes DUPLICATE_OBSERVATION. */
const HISTORY_LIMIT = 32;

export class ToolLoopError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolLoopError";
    this.code = code;
  }
}

/** Deterministic canonical JSON: object keys sorted recursively (order-independent). */
export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizeJson(item));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = canonicalizeJson((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function canonicalKey(value: unknown): string {
  try {
    return JSON.stringify(canonicalizeJson(value));
  } catch {
    return String(value);
  }
}

function resultDigest(value: unknown): string {
  return createHash("sha256").update(canonicalKey(normalizeResultForDigest(value))).digest("hex");
}

/** Volatile metadata that must never make two identical observations look different. */
const VOLATILE_RESULT_KEYS = /^(durationMs|duration|builtAt|createdAt|updatedAt|modifiedAt|startedAt|completedAt|elapsedMs|requestId|toolCallId|callId|streamId|sandboxId|pid|at)$/i;

function normalizeResultForDigest(value: unknown): unknown {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (VOLATILE_RESULT_KEYS.test(key)) continue;
        out[key] = strip(child);
      }
      return out;
    }
    return node;
  };
  return strip(canonicalizeJson(value));
}

/**
 * Semantic args: argument dimensions that cannot change the observation are dropped.
 * For inspect_current_app without an existing app, includeRecords/includeSchema have
 * no meaning, so all flag combinations represent one observation.
 */
function semanticArgsFor(toolName: string, args: unknown, state: StateVersion): unknown {
  if (toolName === "inspect_current_app" && !state.appPresent) {
    return {};
  }
  return canonicalizeJson(args);
}

interface StateVersion {
  /** Local key including the mutation revision (used for tool gating). */
  key: string;
  /** External app-state key (version + manifest identity; used for observation identity and the inspect cache). */
  appKey: string;
  appPresent: boolean;
}

/** State version: local revision (mutating successes) + the externally visible app state. */
function stateVersionOf(context: ToolExecutionContext, revision: number): StateVersion {
  const manifest = context.currentManifest;
  const appPresent = manifest != null;
  const appKey =
    "app" + context.currentVersion +
    "|" + (manifest ? manifest.name + ":" + manifest.collections.map((c) => c.name).join(",") : "none");
  return {
    appPresent,
    appKey,
    key: "rev" + revision + "|" + appKey,
  };
}

interface ObservationFingerprint {
  name: string;
  semanticArgsKey: string;
  resultDigest: string;
  stateKey: string;
  ok: boolean;
  errorCode: string | null;
}

interface ObservationRecord extends ObservationFingerprint {
  at: number;
}

/** Same observation regardless of argument spelling: name + state + result digest. */
function observationIdentity(record: ObservationFingerprint): string {
  return record.name + "|" + record.stateKey + "|" + (record.ok ? "ok:" + record.resultDigest : "err:" + (record.errorCode ?? "TOOL_ERROR"));
}

/** Detect an alternating loop among successful observation tools. */
function detectNoProgress(history: ObservationRecord[]): boolean {
  const last = history
    .filter((record) => record.ok && getToolEffect(record.name) === "observation")
    .slice(-4);
  if (last.length < 4) return false;
  const [a, b, c, d] = last.map((record) => observationIdentity(record));
  return a === c && b === d && a !== b;
}

function isAlternatingPrefix(history: ObservationRecord[]): boolean {
  const last = history
    .filter((record) => record.ok && getToolEffect(record.name) === "observation")
    .slice(-3);
  if (last.length < 3) return false;
  const [a, b, c] = last.map((record) => observationIdentity(record));
  return a === c && a !== b;
}

type ControllerDirective =
  | { kind: "auto" }
  | { kind: "force_final" }
  | { kind: "force_next_tool"; name: string };

/** DUPLICATE_OBSERVATION policy per role. */
function duplicateObservationPolicy(roleId: RoleId, toolName: string): ControllerDirective | "gate" {
  switch (roleId) {
    case "product_manager":
    case "architect":
    case "data_scientist":
    case "researcher":
      return { kind: "force_final" };
    case "team_leader":
      // Repeatedly re-checking the current app: the next round MUST delegate.
      return toolName === "inspect_current_app" ? { kind: "force_next_tool", name: "delegate_to_agent" } : "gate";
    default:
      // engineer / reviewer / security_reviewer: disable the proven-no-progress tool.
      return "gate";
  }
}

/** NO_PROGRESS policy per role. */
function noProgressPolicy(roleId: RoleId): ControllerDirective | "gate" {
  switch (roleId) {
    case "product_manager":
    case "architect":
    case "data_scientist":
    case "researcher":
      return { kind: "force_final" };
    case "team_leader":
      return { kind: "force_next_tool", name: "delegate_to_agent" };
    default:
      return "gate";
  }
}

/** Codes that must never receive retry advice. */
const NO_RETRY_CODES = new Set([
  "DUPLICATE_OBSERVATION",
  "NO_PROGRESS",
  "CONTROLLER_DIRECTIVE",
  "AGENT_TOOL_BUDGET_EXCEEDED",
  "AGENT_DEADLINE_EXCEEDED",
  "TOOL_FAILURE_LIMIT_EXCEEDED",
  "TOOL_CALL_REQUIRED",
  "SECURITY_BLOCKED",
  "PREVIEW_BLOCKED",
  "PREVIEW_REQUIRED",
  "SEARCH_NOT_CONFIGURED",
  "DATA_NOT_CONFIGURED",
  "PROVIDER_UNAVAILABLE",
  "TOOL_RESULT_TOO_LARGE",
  "REPEATED_CALL",
]);

/** Model-facing repair suggestions for fixable tool errors. */
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
  REPEATED_FAILED_CALL: "该调用与之前失败的调用完全相同：请修复参数后重试，或改用其他工具完成目标；不要原样重复。",
  APPROVAL_REQUIRED: "该操作需要用户审批，请等待审批通过后重试，不要反复触发审批。",
};

/** Don't fabricate suggestions for unknown error codes; the model still receives the raw error message. */
function repairHint(code?: string): string {
  if (!code) return "";
  if (NO_RETRY_CODES.has(code)) return "";
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

/** Normalize arg keys to a canonical semantic key (order-independent, meaningless dims dropped). */
function semanticArgsKeyFor(toolName: string, rawArguments: string, state: StateVersion): string {
  try {
    return canonicalKey(semanticArgsFor(toolName, JSON.parse(rawArguments || "{}"), state));
  } catch {
    return rawArguments || "{}";
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

function toolSpecsFor(roleId: RoleId, exclude: Set<string>): ToolSpec[] {
  return getToolDefinitionsForRole(roleId)
    .filter((definition) => !exclude.has(definition.name))
    .map((definition) => ({
      name: definition.name,
      description: definition.description,
      parameters: zodToJsonSchema(definition.argsSchema, { $refStrategy: "none", name: undefined }) as Record<string, unknown>,
    }));
}

export async function runToolCallingAgent(input: RunAgentInput): Promise<ValidatedAgentResult> {
  const provider = input.providerOverride ?? getProvider();
  const maxToolFailures = readMaxToolFailures();
  const maxTotalFailures = readMaxTotalToolFailures();
  const budget = roleBudget(input.roleId);
  const loopStartedAt = Date.now();
  const messages: ChatMessage[] = [{ role: "user", content: input.taskPrompt }];
  let toolCallsMade = 0;
  let consecutiveFailures = 0;
  let totalFailures = 0;

  // Controller state is scoped to one agent run.
  let revision = 0;
  let directive: ControllerDirective = { kind: "auto" };
  const history: ObservationRecord[] = [];
  const observationCache = new Map<string, {
    result: unknown;
    artifactIds: string[];
    summary: string;
  }>();
  /** Tools gated for the current state version (proven to yield no new information). */
  const gates = new Map<string, string>();

  const respondTool = (callId: string, content: string): ChatMessage => ({
    role: "tool",
    tool_call_id: callId,
    content: content.slice(0, 24 * 1024),
  });

  const pushHistory = (record: ObservationRecord): void => {
    history.push(record);
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  };

  for (let round = 0; round < budget.maxRounds; round++) {
    if (Date.now() - loopStartedAt > budget.deadlineMs) {
      throw new ToolLoopError(
        "AGENT_DEADLINE_EXCEEDED",
        "该 Agent 已超出总执行时限（" + Math.round(budget.deadlineMs / 1000) + " 秒）。已停止执行，请基于已有信息直接给出最终输出。"
      );
    }
    const state = stateVersionOf(input.context, revision);
    const gatedNames = new Set<string>();
    for (const [name, gatedAt] of gates) {
      if (gatedAt === state.key) gatedNames.add(name);
    }
    // Expose no tools for force_final and one tool for force_next_tool.
    let exposedNames: Set<string> | null = null;
    if (directive.kind === "force_next_tool") exposedNames = new Set([directive.name]);
    else if (directive.kind === "force_final") exposedNames = new Set();
    const tools = toolSpecsFor(input.roleId, gatedNames).filter((spec) => exposedNames === null || exposedNames.has(spec.name));
    const toolChoice: ToolChoiceSpec =
      directive.kind === "auto" ? { mode: "auto" } :
      directive.kind === "force_final" ? { mode: "none" } :
      { mode: "function", name: directive.name };

    let turn: AgentTurnResponse;
    try {
      turn = await provider.generateWithTools({
        system: input.systemPrompt,
        messages,
        tools,
        roleId: input.roleId,
        signal: input.signal,
        toolChoice,
      });
    } catch (error) {
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
      const duplicateTools = new Set<string>();
      const noProgressTools = new Set<string>();
      let sawGatedCall = false;
      // Successful forced actions return the controller to normal routing.
      const batchSucceeded = new Set<string>();
      for (const call of calls) {
        input.context.counters.toolCalls += 1;
        toolCallsMade += 1;
        if (toolCallsMade > budget.maxToolCalls) {
          const message = "该 Agent 的工具调用次数超出预算（" + budget.maxToolCalls + "）。已停止执行，请基于已有信息直接给出最终输出。";
          input.context.emit({ type: "error", roleId: input.roleId, message, code: "AGENT_TOOL_BUDGET_EXCEEDED" });
          throw new ToolLoopError("AGENT_TOOL_BUDGET_EXCEEDED", message);
        }
        const toolCallId = call.id;
        input.context.emit({
          type: "tool_call_started",
          toolCallId,
          agentRunId: input.agentRunId,
          roleId: input.roleId,
          toolName: call.name.slice(0, 60),
          inputSummary: summarizeArgs(call),
        });
        const semanticKey = semanticArgsKeyFor(call.name, call.rawArguments, state);
        const effect = getToolEffect(call.name);
        const cacheStateKey = call.name === "inspect_current_app" ? state.appKey : state.key;
        const cacheKey = call.name + "|" + cacheStateKey + "|" + semanticKey;
        const startedAt = Date.now();
        let outcome: { ok: boolean; result: unknown; summary: string; errorCode?: string; artifactIds: string[]; durationMs: number };

        // A gated observation already proved it cannot add information for this state.
        if (gates.get(call.name) === state.key) {
          sawGatedCall = true;
          outcome = {
            ok: false,
            result: null,
            summary: "该工具在当前应用状态下已被禁用（此前调用没有产生新信息）。请执行下一步或输出最终结果。",
            errorCode: "CONTROLLER_DIRECTIVE",
            artifactIds: [],
            durationMs: 0,
          };
        }
        // Provider output is still validated if a compatible backend ignores tool choice.
        else if (directive.kind === "force_final" || (directive.kind === "force_next_tool" && directive.name !== call.name)) {
          outcome = {
            ok: false,
            result: null,
            summary: directive.kind === "force_final"
              ? "Controller 已禁用全部工具：请立即输出最终结构化 JSON，不要调用工具。"
              : "Controller 当前只允许调用 " + directive.name + "。",
            errorCode: "CONTROLLER_DIRECTIVE",
            artifactIds: [],
            durationMs: 0,
          };
        }
        // Exact observation replays use cached data and still participate in loop detection.
        else if (effect === "observation" && observationCache.has(cacheKey)) {
          const cached = observationCache.get(cacheKey)!;
          outcome = {
            ok: true,
            result: cached.result,
            summary: cached.summary,
            artifactIds: cached.artifactIds,
            durationMs: 0,
          };
        } else {
          outcome = await executeCall(call, input, toolCallId, startedAt, state.key, semanticKey, history);
        }

        if (outcome.ok && effect === "observation") {
          const digest = resultDigest(outcome.result);
          const fingerprint: ObservationFingerprint = {
            name: call.name,
            semanticArgsKey: semanticKey,
            resultDigest: digest,
            stateKey: cacheStateKey,
            ok: true,
            errorCode: null,
          };
          const sameResult = history.some(
            (record) => record.ok && observationIdentity(record) === observationIdentity(fingerprint)
          );
          observationCache.set(cacheKey, {
            result: outcome.result,
            artifactIds: outcome.artifactIds,
            summary: outcome.summary,
          });
          pushHistory({ ...fingerprint, at: Date.now() });
          if (detectNoProgress(history)) {
            for (const record of history.filter((record) => record.ok).slice(-4)) {
              noProgressTools.add(record.name);
            }
            outcome = {
              ok: false,
              result: outcome.result,
              summary: "检测到交替重复且没有状态推进的工具循环。相关观察工具将被禁用，请执行真正不同的下一步。",
              errorCode: "NO_PROGRESS",
              artifactIds: outcome.artifactIds,
              durationMs: outcome.durationMs,
            };
          } else if (sameResult && !isAlternatingPrefix(history)) {
            duplicateTools.add(call.name);
            outcome = {
              ok: false,
              result: outcome.result,
              summary: "本次调用返回了与当前状态下已有观察相同的信息。该工具不会继续产生新信息，请执行下一步。",
              errorCode: "DUPLICATE_OBSERVATION",
              artifactIds: outcome.artifactIds,
              durationMs: outcome.durationMs,
            };
          }
        } else if (outcome.errorCode === "DUPLICATE_OBSERVATION" || outcome.errorCode === "NO_PROGRESS" || outcome.errorCode === "CONTROLLER_DIRECTIVE") {
          // Controller responses are not observations and cannot establish progress.
        } else if (!outcome.ok) {
          pushHistory({
            name: call.name,
            semanticArgsKey: semanticKey,
            resultDigest: "error:" + (outcome.errorCode ?? "TOOL_ERROR"),
            stateKey: cacheStateKey,
            ok: false,
            errorCode: outcome.errorCode ?? "TOOL_ERROR",
            at: Date.now(),
          });
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

        // role:"tool" content: the error text only explains WHAT happened; the Controller's
        // instruction (if any) goes into the user message after the whole batch.
        const errorHint = repairHint(outcome.errorCode);
        let toolPayload: string;
        if (outcome.ok) {
          toolPayload = JSON.stringify(outcome.result) ?? "null";
        } else if ((outcome.errorCode === "DUPLICATE_OBSERVATION" || outcome.errorCode === "NO_PROGRESS") && outcome.result != null) {
          toolPayload = JSON.stringify({ error: { code: outcome.errorCode, message: outcome.summary }, observation: outcome.result }) ?? "null";
        } else {
          toolPayload = JSON.stringify({ error: { code: outcome.errorCode, message: outcome.summary, ...(errorHint ? { hint: errorHint } : {}) } }) ?? "null";
        }
        toolResults.push(respondTool(toolCallId, toolPayload));

        if (!outcome.ok) {
          const code = outcome.errorCode ?? "TOOL_ERROR";
          if (NO_RETRY_CODES.has(code)) {
            // Not an ordinary failure: no retry advice, no failure counting.
            continue;
          }
          consecutiveFailures += 1;
          totalFailures += 1;
          failureInstructions.push(
            "工具调用失败：" + call.name + "（错误码 " + code + "）：" + outcome.summary +
            "。你传入的参数：" + summarizeArgsForCorrection(call.rawArguments) +
            (errorHint ? "。修复建议：" + errorHint : "") +
            "。请修改参数、换一种方式完成目标，或改用其他可用工具后重试。"
          );
          if (consecutiveFailures > maxToolFailures || totalFailures > maxTotalFailures) {
            const message =
              "工具调用连续失败 " + consecutiveFailures + " 次（累计 " + totalFailures + " 次，上限 " + maxTotalFailures + "），已停止执行。最后错误：" + outcome.summary;
            input.context.emit({ type: "error", roleId: input.roleId, message, code: "TOOL_FAILURE_LIMIT_EXCEEDED" });
            throw new ToolLoopError("TOOL_FAILURE_LIMIT_EXCEEDED", message);
          }
        } else {
          consecutiveFailures = 0;
          if (effect === "action") revision += 1;
          batchSucceeded.add(call.name);
        }
      }
      // after assistant.tool_calls, the whole batch of tool messages must be filled in first;
      // the Controller instruction can only come after the complete batch.
      messages.push(...toolResults);

      // Controller update based on this batch's signals.
      let controllerInstruction = "";
      // A successful forced tool restores normal routing.
      if (directive.kind === "force_next_tool" && batchSucceeded.has(directive.name)) {
        directive = { kind: "auto" };
      }
      if (noProgressTools.size > 0 && directive.kind === "auto") {
        const policy = noProgressPolicy(input.roleId);
        if (policy === "gate") {
          for (const name of noProgressTools) gates.set(name, state.key);
          controllerInstruction = "检测到无进展循环（NO_PROGRESS）：相关观察工具已禁用。请执行真正不同的操作或输出最终结果。";
        } else {
          directive = policy;
        }
      } else if (duplicateTools.size > 0 && directive.kind === "auto") {
        const duplicateTool = [...calls].reverse().find((call) => duplicateTools.has(call.name))?.name ?? [...duplicateTools][0];
        const policy = duplicateObservationPolicy(input.roleId, duplicateTool);
        if (policy === "gate") {
          gates.set(duplicateTool, state.key);
          controllerInstruction = "工具 " + duplicateTool + " 已禁用（重复观察不会产生新信息）。请改用其他工具继续，或直接输出最终结果。";
        } else {
          directive = policy;
        }
      } else if (sawGatedCall && directive.kind === "auto") {
        // The model called an already-gated tool: escalate to force_final.
        directive = { kind: "force_final" };
      }
      if (directive.kind === "force_final" && controllerInstruction === "") {
        controllerInstruction = "Controller 指令：请立即依据已有信息输出最终 JSON（符合给定 schema），不要调用任何工具。";
      } else if (directive.kind === "force_next_tool" && controllerInstruction === "") {
        controllerInstruction = "Controller 指令：下一步必须调用 " + directive.name + "，然后根据其结果继续。";
      }
      if (failureInstructions.length > 0) {
        messages.push({ role: "user", content: failureInstructions.join("\n") + "\n请针对以上每一条失败分别修正后继续，不要原样重复任何一次失败的调用。" });
      } else if (controllerInstruction !== "") {
        messages.push({ role: "user", content: controllerInstruction });
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
      const correction = directive.kind === "force_final"
        ? "必须输出符合 schema 的最终 JSON，不要调用任何工具。未通过校验：" + JSON.stringify(parsed.error.issues.slice(0, 8))
        : "你的输出未通过校验：" + JSON.stringify(parsed.error.issues.slice(0, 8)) + "。请修正后重新输出符合 schema 的 JSON。";
      messages.push({ role: "user", content: correction });
      continue;
    }
    const correction = directive.kind === "force_next_tool"
      ? "Controller 指令：当前必须调用工具 " + directive.name + "。"
      : directive.kind === "force_final"
        ? "Controller 指令：请直接输出最终 JSON，不要调用任何工具。"
        : "你的输出不是合法 JSON：" + extracted.error.slice(0, 200) + "。请重新输出。";
    messages.push({ role: "user", content: correction });
  }
  throw new ToolLoopError("AGENT_TOOL_BUDGET_EXCEEDED", "该 Agent 的对话轮次超出预算（" + budget.maxRounds + " 轮）");
}

/** Execute one tool call after controller checks have passed. */
async function executeCall(
  call: ToolCall,
  input: RunAgentInput,
  toolCallId: string,
  startedAt: number,
  stateKey: string,
  semanticKey: string,
  history: ObservationRecord[]
): Promise<{ ok: boolean; result: unknown; summary: string; errorCode?: string; artifactIds: string[]; durationMs: number }> {
  // Skip an unchanged call that already failed in the same state.
  const previousFailure = history.find(
    (record) =>
      !record.ok &&
      record.name === call.name &&
      record.stateKey === stateKey &&
      record.semanticArgsKey === semanticKey &&
      record.errorCode !== "APPROVAL_REQUIRED" &&
      record.errorCode !== "CONTROLLER_DIRECTIVE" &&
      record.errorCode !== "DUPLICATE_OBSERVATION"
  );
  if (previousFailure) {
    return {
      ok: false,
      result: null,
      summary: "与之前失败的调用完全相同（" + call.name + " + 相同参数 + 错误码 " + previousFailure.errorCode + "），本次未执行。请修复参数后重试，或改用其他工具。",
      errorCode: "REPEATED_FAILED_CALL",
      artifactIds: [],
      durationMs: 0,
    };
  }
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
    return {
      ok: true,
      result,
      summary: summarizeResult(call.name, result),
      artifactIds: collectArtifactIds(result),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (input.context.signal.aborted || isAbortLike(error)) throw error;
    const shape = isToolError(error) || error instanceof ToolExecutionError
      ? { code: (error as { code: string }).code, message: error instanceof Error ? error.message : "工具执行失败" }
      : { code: "TOOL_ERROR", message: error instanceof Error ? error.message.slice(0, 300) : "工具执行失败" };
    return {
      ok: false,
      result: null,
      summary: shape.message.slice(0, 300),
      errorCode: shape.code.slice(0, 60),
      artifactIds: [],
      durationMs: Date.now() - startedAt,
    };
  }
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
      return record.exists === false ? "manifest 尚未创建（新工作区正常状态）" : "manifest：「" + str(record.name) + "」· " + len(record.collections) + " 个集合 · " + len(record.dependencies) + " 个依赖";
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
    case "bash":
      return "命令 exitCode=" + num(record.exitCode) + (record.timedOut ? "（超时）" : "") + " · 输出 " + num(str(record.stdout).length) + " 字符";
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
  skeleton: "系统骨架",
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

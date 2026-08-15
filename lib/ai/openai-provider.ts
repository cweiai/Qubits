import "server-only";
import type {
  AIProvider,
  AgentTurnResponse,
  GenerateWithToolsInput,
  ProgressSummaryInput,
} from "./provider";
import type { ProgressPhase, RoleId } from "@/lib/contracts/agent-events";
import { redactProgressText, sanitizeProgressSummary } from "./progress-summary";

/**
 * OpenAI-compatible provider: consumes chat/completions SSE directly, without the AI SDK.
 * Reads OPENAI_API_KEY / OPENAI_MODEL / OPENAI_BASE_URL server-side, never exposed to
 * the client.
 *
 * Stable error contract:
 * - PROVIDER_TIMEOUT: our own request deadline fired without an HTTP response
 * - PROVIDER_NETWORK_ERROR: fetch TypeError or a known network cause code
 * - PROVIDER_RATE_LIMIT: HTTP 429 or 408
 * - PROVIDER_AUTH_ERROR: HTTP 401 or 403
 * - PROVIDER_BAD_REQUEST: HTTP 400 or a protocol error
 * - PROVIDER_SERVER_ERROR: HTTP 5xx
 * Retry policy: network errors + 408/429/5xx are retried at most twice, while a
 * side-effect-free provider timeout is retried once; 400/401/403, protocol errors,
 * and user aborts never retry.
 * Error messages never contain the API key, Authorization header or request body.
 */

const DEFAULT_MODEL = "gpt-4o-mini";

/** Code tool arguments need more output room than routing and compact structured artifacts. */
export function readMaxOutputTokens(roleId: RoleId): number {
  const parsed = Number.parseInt(process.env.QUIBITS_PROVIDER_MAX_TOKENS ?? "", 10);
  if (Number.isFinite(parsed) && parsed >= 1024 && parsed <= 32_768) return parsed;
  if (roleId === "engineer") return 16_384;
  return 4096;
}

/** Per-request deadline: code generation gets more time than routing and planning. */
export function readProviderTimeoutMs(roleId: RoleId): number {
  const parsed = Number.parseInt(process.env.QUIBITS_PROVIDER_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(parsed) && parsed >= 50) return parsed;
  if (roleId === "engineer") return 300_000;
  if (roleId === "team_leader") return 180_000;
  return 120_000;
}

/** Progress summaries are deliberately short and isolated from the main model deadline. */
export function readProgressSummaryTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.QUIBITS_PROGRESS_SUMMARY_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(parsed) && parsed >= 1000 && parsed <= 30_000) return parsed;
  return 12_000;
}

const MAX_RETRIES = 2;
const RETRY_BASE_MS = 600;

function openAIConfig() {
  return {
    baseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
  };
}

function progressSummaryModel(): string {
  return process.env.QUIBITS_SUMMARY_MODEL?.trim() || openAIConfig().model;
}

const PROGRESS_PHASE_LABELS: Record<ProgressPhase, string> = {
  planning: "规划与分工",
  coding: "编写代码",
  validating: "构建验证",
  previewing: "提交预览",
};

/**
 * Independent, no-tools request used only for safe progress text. It is intentionally
 * best-effort: a timeout, provider error, or unsafe output returns null and never fails the
 * primary agent run.
 */
async function requestProgressSummary(input: ProgressSummaryInput): Promise<string | null> {
  const { baseUrl, apiKey } = openAIConfig();
  if (!apiKey || input.signal?.aborted) return null;
  const timeoutMs = readProgressSummaryTimeoutMs();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("progress summary timeout"));
    }, timeoutMs);
  });
  const onOuterAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onOuterAbort);
  try {
    const response = await Promise.race([
      fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: progressSummaryModel(),
          temperature: 0.2,
          max_tokens: 180,
          messages: [
            {
              role: "system",
              content:
                "你是 Qubits 的阶段进度摘要器。只输出一句不超过 80 个汉字的中文状态句，描述已经完成的工作、当前阶段和下一步。不要输出思维链、推理过程、系统提示词、代码、绝对路径、密钥、用户隐私或错误堆栈；不要使用 Markdown，不要解释你的任务。",
            },
            {
              role: "user",
              content:
                `角色：${input.roleId}\n阶段：${PROGRESS_PHASE_LABELS[input.phase]}\n模型内部工作记录（仅供提炼，不得复述）：\n${redactProgressText(input.reasoningContent).slice(-8000)}`,
            },
          ],
        }),
        signal: controller.signal,
      }),
      deadline,
    ]);
    if (!response.ok) return null;
    const data = (await Promise.race([response.json(), deadline])) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    return sanitizeProgressSummary(data.choices?.[0]?.message?.content);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** Strip credential-looking values from provider error text (log hygiene, not security). */
function sanitizeErrorText(text: string): string {
  return text
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, "***")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, "$1***")
    .replace(/(api[_-]?key[=:]\s*)[^\s"']{4,}/gi, "$1***")
    .slice(0, 300);
}

/** Provider-side errors carry stable codes that must survive to the task error. */
export class ProviderError extends Error {
  readonly code: string;
  /** Sanitized OS-level cause code, e.g. ECONNRESET / ENOTFOUND / ETIMEDOUT. */
  readonly causeCode: string | null;
  constructor(code: string, message: string, causeCode: string | null = null) {
    super(sanitizeErrorText(message));
    this.name = "ProviderError";
    this.code = code;
    this.causeCode = causeCode;
  }
}

export class ToolMessageProtocolError extends Error {
  readonly code = "INVALID_TOOL_MESSAGE_SEQUENCE";

  constructor(message: string) {
    super(message);
    this.name = "ToolMessageProtocolError";
  }
}

function networkCauseCodeOf(error: unknown): string | null {
  if (error instanceof Error && (error as NodeJS.ErrnoException).code) {
    return String((error as NodeJS.ErrnoException).code).slice(0, 40);
  }
  // undici wraps the OS error in cause.
  const cause = (error as { cause?: unknown })?.cause;
  if (cause instanceof Error && (cause as NodeJS.ErrnoException).code) {
    return String((cause as NodeJS.ErrnoException).code).slice(0, 40);
  }
  return null;
}

function mapHttpStatus(status: number, detail: string): ProviderError {
  if (status === 402) {
    return new ProviderError("PROVIDER_BILLING_ERROR", "模型服务账户余额不足或账单不可用，请检查服务商账户配置。" + detail, null);
  }
  if (status === 401 || status === 403) {
    return new ProviderError("PROVIDER_AUTH_ERROR", "模型服务鉴权失败（" + status + "）：请检查服务端 OPENAI_API_KEY。" + detail, null);
  }
  if (status === 429) {
    return new ProviderError("PROVIDER_RATE_LIMIT", "模型服务请求受限（429）：额度不足或请求过于频繁，请稍后重试。" + detail, null);
  }
  if (status === 408) {
    return new ProviderError("PROVIDER_SERVER_ERROR", "模型服务响应超时（408）。" + detail, null);
  }
  if (status >= 500) {
    return new ProviderError("PROVIDER_SERVER_ERROR", "模型服务内部错误（" + status + "）。" + detail, null);
  }
  return new ProviderError("PROVIDER_BAD_REQUEST", "模型服务拒绝了请求（" + status + "）。" + detail, null);
}

async function readErrorDetail(response: Response): Promise<string> {
  let detail = "";
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      const err = (body as { error?: { message?: unknown } }).error;
      if (err && typeof err.message === "string") detail = "：" + err.message;
    }
  } catch {
    // ignore failure to parse the error body
  }
  return sanitizeErrorText(detail);
}

/** Map an internal provider timeout vs an external client abort to distinct stable errors. */
function mapAbortError(error: unknown, signal: AbortSignal | undefined, timeoutMs: number): Error {
  if (signal?.aborted) {
    // Client aborted (page refresh / disconnect): keep the AbortError so the orchestrator
    // can emit CLIENT_ABORTED (a different, more specific code than a provider timeout).
    return error instanceof Error ? error : new Error("请求已取消");
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new ProviderError("PROVIDER_TIMEOUT", "模型服务请求超时（" + Math.round(timeoutMs / 1000) + " 秒），请稍后重试。");
  }
  return error instanceof Error ? error : new Error("模型服务请求失败");
}

function retryDelayMs(attempt: number): number {
  return RETRY_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 200);
}

/**
 * OpenAI requires that every tool message after assistant.tool_calls correspond one-to-one
 * to all call ids. Validate before the HTTP request so local sequencing bugs surface as our
 * own error instead of an opaque provider 400.
 */
export function assertValidToolMessageSequence(messages: GenerateWithToolsInput["messages"]): void {
  let pending: { ids: Set<string>; assistantIndex: number } | null = null;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (pending) {
      if (message.role !== "tool") {
        throw new ToolMessageProtocolError(
          `messages[${pending.assistantIndex}] 的 tool_calls 尚有 ${pending.ids.size} 个结果未回填，messages[${index}] 必须是 role:\"tool\"`
        );
      }
      const callId = message.tool_call_id.trim();
      if (!callId || !pending.ids.has(callId)) {
        throw new ToolMessageProtocolError(
          `messages[${index}] 的 tool_call_id 无法匹配前一条 assistant.tool_calls`
        );
      }
      pending.ids.delete(callId);
      if (pending.ids.size === 0) pending = null;
      continue;
    }

    if (message.role === "tool") {
      throw new ToolMessageProtocolError(`messages[${index}] 是没有对应 assistant.tool_calls 的孤立 tool 消息`);
    }
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;

    const ids = new Set<string>();
    for (const call of message.tool_calls) {
      const callId = call.id.trim();
      if (!callId) {
        throw new ToolMessageProtocolError(`messages[${index}] 包含空的 tool call id`);
      }
      if (ids.has(callId)) {
        throw new ToolMessageProtocolError(`messages[${index}] 包含重复的 tool call id：${callId}`);
      }
      if (!call.name.trim()) {
        throw new ToolMessageProtocolError(`messages[${index}] 包含空的工具名称`);
      }
      ids.add(callId);
    }
    pending = { ids, assistantIndex: index };
  }

  if (pending) {
    throw new ToolMessageProtocolError(
      `messages[${pending.assistantIndex}] 的 tool_calls 缺少 ${pending.ids.size} 个对应的 role:\"tool\" 结果`
    );
  }
}

/**
 * Build chat/completions messages.
 * compat=true is a full legacy-text adaptation: assistant calls and tool results are both
 * downgraded to plain text. Converting only tool results would leave assistant.tool_calls
 * without role:tool responses, which the provider rejects.
 */
export function buildChatMessages(
  system: string,
  messages: GenerateWithToolsInput["messages"],
  compat: boolean
): Array<Record<string, unknown>> {
  assertValidToolMessageSequence(messages);
  const mapped = messages.map((message) => {
    if (message.role === "tool") {
      if (compat) {
        return {
          role: "user" as const,
          content: "[Tool result tool_call_id=" + message.tool_call_id + "]\n" + message.content,
        };
      }
      return { role: "tool", tool_call_id: message.tool_call_id.trim(), content: message.content };
    }
    if (message.role === "assistant") {
      const assistant: Record<string, unknown> = {
        role: "assistant",
        content: message.content,
      };
      if (message.reasoning_content != null) {
        // reasoning mode requires echoing reasoning_content (not displayed, not persisted)
        assistant.reasoning_content = message.reasoning_content;
      }
      if (message.tool_calls && message.tool_calls.length > 0) {
        if (compat) {
          const callSummary = message.tool_calls
            .map((call) => `${call.name} (tool_call_id=${call.id})`)
            .join(", ");
          assistant.content = [message.content, `[Tool calls executed: ${callSummary}]`]
            .filter((part): part is string => typeof part === "string" && part.length > 0)
            .join("\n\n");
        } else {
          // OpenAI requires type:"function" for every internal flat tool call.
          assistant.tool_calls = message.tool_calls.map((call) => ({
            id: call.id.trim(),
            type: "function",
            function: { name: call.name, arguments: call.rawArguments },
          }));
        }
      }
      return assistant;
    }
    return { role: message.role, content: message.content };
  });
  return [{ role: "system", content: system }, ...mapped];
}

function toolMessageCompatEnabled(): boolean {
  const value = process.env.OPENAI_TOOL_MESSAGE_COMPAT?.trim().toLowerCase();
  if (!value || value === "false") return false;
  if (value === "true") return true;
  throw new Error("OPENAI_TOOL_MESSAGE_COMPAT 只能设置为 true 或 false");
}

type RawToolCall = {
  id?: unknown;
  type?: unknown;
  function?: { name?: unknown; arguments?: unknown };
};

interface OpenAIToolRequestFields {
  tools?: Array<{ type: "function"; function: GenerateWithToolsInput["tools"][number] }>;
  tool_choice?: "auto";
}

/** Build only valid OpenAI tool fields; a final-only turn omits both fields. */
export function buildToolRequestFields(input: GenerateWithToolsInput): OpenAIToolRequestFields {
  const choice = input.toolChoice ?? { mode: "auto" as const };
  if (choice.mode === "none" || input.tools.length === 0) return {};

  const tools = input.tools.map((tool) => ({ type: "function" as const, function: tool }));
  if (choice.mode === "auto") return { tools, tool_choice: "auto" };

  const selected = tools.find((tool) => tool.function.name === choice.name);
  if (!selected) {
    throw new ToolMessageProtocolError("Controller 指定的工具未暴露给当前角色：" + choice.name);
  }
  return {
    tools: [selected],
    // Thinking models reject a forced function object. Exposing only the
    // selected tool keeps the Controller constraint while remaining compatible.
    tool_choice: "auto",
  };
}

/** Normalize a provider response into internal ToolCalls; malformed responses must fail loudly, never silently drop calls. */
export function parseProviderToolCalls(raw: unknown): AgentTurnResponse["toolCalls"] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ToolMessageProtocolError("模型返回的 tool_calls 不是数组");

  const seen = new Set<string>();
  return raw.map((value, index) => {
    if (typeof value !== "object" || value === null) {
      throw new ToolMessageProtocolError(`模型返回的 tool_calls[${index}] 不是对象`);
    }
    const call = value as RawToolCall;
    if (call.type != null && call.type !== "function") {
      throw new ToolMessageProtocolError(`模型返回了不支持的 tool_calls[${index}].type`);
    }
    const name = typeof call.function?.name === "string" ? call.function.name.trim() : "";
    if (!name) throw new ToolMessageProtocolError(`模型返回的 tool_calls[${index}] 缺少 function.name`);

    let id = typeof call.id === "string" ? call.id.trim() : "";
    if (!id) id = "tc-" + crypto.randomUUID();
    if (seen.has(id)) {
      throw new ToolMessageProtocolError(`模型返回了重复的 tool call id：${id}`);
    }
    seen.add(id);

    const args = call.function?.arguments;
    if (args != null && typeof args !== "string") {
      throw new ToolMessageProtocolError(`模型返回的 tool_calls[${index}].function.arguments 不是字符串`);
    }
    return { id, name, rawArguments: args ?? "{}" };
  });
}

interface StreamingToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface StreamAccumulator {
  content: string[];
  reasoning: string[];
  toolCalls: Map<number, StreamingToolCall>;
  sawChoice: boolean;
}

function applyStreamPayload(
  payload: string,
  accumulator: StreamAccumulator,
  onReasoningDelta?: (delta: string) => void,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new ToolMessageProtocolError("模型返回了无法解析的流式事件");
  }
  if (typeof parsed !== "object" || parsed === null) return;
  const record = parsed as {
    error?: { message?: unknown };
    choices?: Array<{
      delta?: {
        content?: unknown;
        reasoning_content?: unknown;
        tool_calls?: unknown;
      };
      message?: {
        content?: unknown;
        reasoning_content?: unknown;
        tool_calls?: unknown;
      };
    }>;
  };
  if (record.error) {
    throw new ProviderError(
      "PROVIDER_SERVER_ERROR",
      typeof record.error.message === "string" ? record.error.message : "模型流返回错误",
    );
  }
  const choice = record.choices?.[0];
  if (!choice) return;
  accumulator.sawChoice = true;
  const delta = choice.delta ?? choice.message ?? {};
  if (typeof delta.content === "string") accumulator.content.push(delta.content);
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
    accumulator.reasoning.push(delta.reasoning_content);
    try {
      onReasoningDelta?.(delta.reasoning_content);
    } catch {
      // The stream consumer is observational and cannot break the provider response.
    }
  }
  if (!Array.isArray(delta.tool_calls)) return;
  for (let arrayIndex = 0; arrayIndex < delta.tool_calls.length; arrayIndex++) {
    const raw = delta.tool_calls[arrayIndex];
    if (typeof raw !== "object" || raw === null) continue;
    const call = raw as {
      index?: unknown;
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const index = typeof call.index === "number" && Number.isInteger(call.index) ? call.index : arrayIndex;
    const current = accumulator.toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
    if (typeof call.id === "string") current.id += call.id;
    if (typeof call.function?.name === "string") current.name += call.function.name;
    if (typeof call.function?.arguments === "string") current.arguments += call.function.arguments;
    accumulator.toolCalls.set(index, current);
  }
}

/** Parse OpenAI-compatible SSE without ever forwarding raw reasoning to the client. */
async function readStreamingTurn(
  response: Response,
  input: GenerateWithToolsInput,
  deadline: Promise<never>,
): Promise<AgentTurnResponse> {
  if (!response.body) throw new ProviderError("PROVIDER_SERVER_ERROR", "模型服务返回了空的流式响应。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const accumulator: StreamAccumulator = {
    content: [],
    reasoning: [],
    toolCalls: new Map(),
    sawChoice: false,
  };
  let buffer = "";
  let finished = false;

  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      finished = true;
      return;
    }
    applyStreamPayload(payload, accumulator, input.onReasoningDelta);
  };

  while (!finished) {
    const { done, value } = await Promise.race([reader.read(), deadline]);
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) processLine(line);
    if (done) {
      if (buffer.trim()) processLine(buffer);
      break;
    }
  }
  try {
    await reader.cancel();
  } catch {
    // The server may already have closed the stream after [DONE].
  }
  if (!accumulator.sawChoice) {
    throw new ProviderError("PROVIDER_SERVER_ERROR", "模型服务未返回有效的流式结果。");
  }
  const rawCalls = [...accumulator.toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments || "{}" },
    }));
  const content = accumulator.content.join("");
  const reasoningContent = accumulator.reasoning.join("");
  return {
    content: content || null,
    reasoningContent: reasoningContent || null,
    toolCalls: parseProviderToolCalls(rawCalls),
  };
}

/** Real tool calling: native tools/tool_calls protocol (not mixed with response_format json_object). */
/** One chat/completions attempt. Returns parsed turn; throws ProviderError/AbortError/protocol errors. */
async function attemptChatWithTools(input: GenerateWithToolsInput): Promise<AgentTurnResponse> {
  const { baseUrl, apiKey, model } = openAIConfig();
  const timeoutMs = readProviderTimeoutMs(input.roleId);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Some OpenAI-compatible gateways do not settle fetch promptly after abort.
  // Race the whole response lifecycle so the wall-clock deadline is still real.
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderError("PROVIDER_TIMEOUT", "模型服务请求超时（" + Math.round(timeoutMs / 1000) + " 秒）。"));
    }, timeoutMs);
  });
  const onOuterAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onOuterAbort);
  try {
    let response: Response;
    try {
      const toolFields = buildToolRequestFields(input);
      response = await Promise.race([
        fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            max_tokens: readMaxOutputTokens(input.roleId),
            stream: true,
            ...toolFields,
            messages: buildChatMessages(input.system, input.messages, toolMessageCompatEnabled()),
          }),
          signal: controller.signal,
        }),
        deadline,
      ]);
    } catch (error) {
      // Map connection, DNS, and abort failures to stable provider errors.
      if (input.signal?.aborted) throw error; // user abort: no retry, CLIENT_ABORTED upstream
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderError("PROVIDER_TIMEOUT", "模型服务请求超时（" + Math.round(timeoutMs / 1000) + " 秒）。");
      }
      if (error instanceof TypeError) {
        const causeCode = networkCauseCodeOf(error);
        throw new ProviderError(
          "PROVIDER_NETWORK_ERROR",
          "模型服务网络错误" + (causeCode ? "（" + causeCode + "）" : "") + "：无法连接模型服务，请检查网络后重试。",
          causeCode
        );
      }
      throw error;
    }
    if (!response.ok) {
      throw mapHttpStatus(response.status, await Promise.race([readErrorDetail(response), deadline]));
    }
    if (response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      return await readStreamingTurn(response, input, deadline);
    }
    const data = (await Promise.race([response.json(), deadline])) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: unknown;
        };
      }>;
    };
    const message = data.choices?.[0]?.message;
    if (!message) throw new ProviderError("PROVIDER_SERVER_ERROR", "模型服务未返回结果。");
    if (message.reasoning_content) input.onReasoningDelta?.(message.reasoning_content);
    return {
      content: message.content ?? null,
      reasoningContent: message.reasoning_content ?? null,
      toolCalls: parseProviderToolCalls(message.tool_calls),
    };
  } catch (error) {
    throw mapAbortError(error, input.signal, timeoutMs);
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener("abort", onOuterAbort);
  }
}

function isRetryableProviderError(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  return (
    error.code === "PROVIDER_NETWORK_ERROR" ||
    error.code === "PROVIDER_RATE_LIMIT" ||
    error.code === "PROVIDER_SERVER_ERROR" ||
    error.code === "PROVIDER_TIMEOUT"
  );
}

async function callChatWithTools(input: GenerateWithToolsInput): Promise<AgentTurnResponse> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await attemptChatWithTools(input);
    } catch (error) {
      lastError = error;
      // No retry: user aborts, auth/bad-request/protocol errors, and non-provider errors.
      if (input.signal?.aborted) throw error;
      if (!isRetryableProviderError(error)) throw error;
      const retryLimit = error instanceof ProviderError && error.code === "PROVIDER_TIMEOUT" ? 1 : MAX_RETRIES;
      if (attempt >= retryLimit) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
    }
  }
  throw lastError instanceof Error ? lastError : new ProviderError("PROVIDER_SERVER_ERROR", "模型服务请求失败");
}

export const openaiProvider: AIProvider = {
  kind: "openai",
  async generateWithTools(input: GenerateWithToolsInput): Promise<AgentTurnResponse> {
    if (!openAIConfig().apiKey) {
      throw new Error("未配置 OPENAI_API_KEY：请在项目根目录的 .env 文件中填写后重启服务。");
    }
    return callChatWithTools(input);
  },
  summarizeProgress: requestProgressSummary,
};

import "server-only";
import type { AIProvider, AgentTurnResponse, GenerateWithToolsInput } from "./provider";

/**
 * OpenAI provider: calls chat/completions (JSON mode) directly, without the AI SDK.
 * Reads OPENAI_API_KEY / OPENAI_MODEL / OPENAI_BASE_URL server-side, never exposed to the client.
 */

const DEFAULT_MODEL = "gpt-4o-mini";

function openAIConfig() {
  return {
    baseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
  };
}

async function toProviderError(response: Response): Promise<Error> {
  let detail = "";
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      const err = (body as { error?: { message?: unknown } }).error;
      if (err && typeof err.message === "string") detail = err.message;
    }
  } catch {
    // ignore failure to parse the error body
  }
  if (response.status === 401) {
    return new Error("OpenAI 鉴权失败（401）：请检查服务端环境变量 OPENAI_API_KEY 是否有效。");
  }
  if (response.status === 429) {
    return new Error("OpenAI 请求受限（429）：额度不足或请求过于频繁，请稍后重试。");
  }
  return new Error(
    `OpenAI 请求失败（${response.status}）${detail ? `：${detail.slice(0, 200)}` : ""}`
  );
}

/** Provider-side timeout must surface as PROVIDER_TIMEOUT — never as a generic aborted message. */
export class ProviderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
  }
}

/** Map an internal provider timeout vs an external client abort to distinct stable errors. */
function mapAbortError(error: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted) {
    // Client aborted (page refresh / disconnect): keep the AbortError so the orchestrator
    // can emit CLIENT_ABORTED (a different, more specific code than a provider timeout).
    return error instanceof Error ? error : new Error("请求已取消");
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new ProviderError("PROVIDER_TIMEOUT", "模型服务请求超时（90 秒），请稍后重试。");
  }
  return error instanceof Error ? error : new Error("模型服务请求失败");
}

export class ToolMessageProtocolError extends Error {
  readonly code = "INVALID_TOOL_MESSAGE_SEQUENCE";

  constructor(message: string) {
    super(message);
    this.name = "ToolMessageProtocolError";
  }
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
          // internal flat shape → OpenAI protocol: every tool_call needs type:"function".
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

/** Real tool calling: native tools/tool_calls protocol (not mixed with response_format json_object). */
async function callChatWithTools(input: GenerateWithToolsInput): Promise<AgentTurnResponse> {
  const { baseUrl, apiKey, model } = openAIConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  const onOuterAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onOuterAbort);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 4096,
        tools: input.tools.map((tool) => ({ type: "function", function: tool })),
        tool_choice: "auto",
        messages: buildChatMessages(input.system, input.messages, toolMessageCompatEnabled()),
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw await toProviderError(response);
    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: unknown;
        };
      }>;
    };
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error("模型服务未返回结果");
    return {
      content: message.content ?? null,
      reasoningContent: message.reasoning_content ?? null,
      toolCalls: parseProviderToolCalls(message.tool_calls),
    };
  } catch (error) {
    throw mapAbortError(error, input.signal);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onOuterAbort);
  }
}

export const openaiProvider: AIProvider = {
  kind: "openai",
  async generateWithTools(input: GenerateWithToolsInput): Promise<AgentTurnResponse> {
    if (!openAIConfig().apiKey) {
      throw new Error("未配置 OPENAI_API_KEY：请在项目根目录的 .env 文件中填写后重启服务。");
    }
    return callChatWithTools(input);
  },
};

import "server-only";
import type { z } from "zod";
import { referenceSearchResultSchema } from "./schemas";

/**
 * Reference search adapter: real search can only enter through here.
 * - none: unconfigured → SEARCH_NOT_CONFIGURED (never return fake results);
 * - mock: test/local demo only (must be explicitly configured, results carry a mock marker);
 * - generic: an OpenAI-compatible search endpoint configured via env (self-hosted Brave/Tavily proxy).
 * API keys are read only from server-side environment variables.
 */

interface SearchProviderInput {
  query: string;
  intent: string;
  maxResults: number;
  recencyDays: number | null;
  signal: AbortSignal;
}

type SearchProviderOutput = Array<z.infer<typeof referenceSearchResultSchema>>;

interface ReferenceSearchProvider {
  readonly kind: string;
  search(input: SearchProviderInput): Promise<SearchProviderOutput>;
}

export class SearchNotConfiguredError extends Error {
  readonly code = "SEARCH_NOT_CONFIGURED";
  constructor() {
    super("未配置参考搜索服务：请在服务端设置 REFERENCE_SEARCH_PROVIDER 与 REFERENCE_SEARCH_API_KEY。");
    this.name = "SearchNotConfiguredError";
  }
}

export class SearchProviderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SearchProviderError";
    this.code = code;
  }
}

/** SSRF guard: https only, reject localhost/private/file/data protocols. */
export function assertSafePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SearchProviderError("INVALID_URL", "URL 不合法");
  }
  if (url.protocol !== "https:") {
    throw new SearchProviderError("INVALID_URL", "仅允许 https 链接");
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new SearchProviderError("INVALID_URL", "拒绝内网地址");
  }
  return url;
}

function toResult(input: { title?: unknown; url?: unknown; domain?: unknown; snippet?: unknown; publishedAt?: unknown; source?: unknown }, index: number): z.infer<typeof referenceSearchResultSchema> {
  const urlRaw = typeof input.url === "string" ? input.url : "";
  const url = assertSafePublicUrl(urlRaw);
  const title = typeof input.title === "string" && input.title.trim() ? input.title.slice(0, 200) : url.hostname;
  const snippet = typeof input.snippet === "string" ? input.snippet.slice(0, 600) : "";
  return referenceSearchResultSchema.parse({
    resultId: "ref-" + url.hostname.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) + "-" + index + "-" + Math.random().toString(36).slice(2, 6),
    title,
    url: url.toString().slice(0, 500),
    domain: url.hostname,
    snippet,
    source: input.source === "string" ? (input.source as string).slice(0, 40) : "web",
    publishedAt: typeof input.publishedAt === "string" ? input.publishedAt : null,
  });
}

const MOCK_RESULTS = [
  { title: "Qubits 文档：受限 AppSpec 与沙盒渲染", url: "https://docs.example.com/qubits/sandbox", domain: "docs.example.com", snippet: "关于沙盒 iframe、MessageChannel 与数据代理的官方文档（Mock，仅测试）。" },
  { title: "任务管理应用设计模式", url: "https://example.com/task-app-patterns", domain: "example.com", snippet: "常见任务管理单页应用的交互与信息架构模式（Mock，仅测试）。" },
];

const mockProvider: ReferenceSearchProvider = {
  kind: "mock",
  async search(input) {
    const count = Math.min(input.maxResults, MOCK_RESULTS.length);
    return MOCK_RESULTS.slice(0, count).map((item, index) => ({
      resultId: "ref-mock-" + index + "-" + Math.random().toString(36).slice(2, 6),
      title: item.title,
      url: item.url,
      domain: item.domain,
      snippet: item.snippet,
      source: "mock",
      publishedAt: null,
    }));
  },
};

const noneProvider: ReferenceSearchProvider = {
  kind: "none",
  async search() {
    throw new SearchNotConfiguredError();
  },
};

const genericProvider: ReferenceSearchProvider = {
  kind: "generic",
  async search(input) {
    const baseUrl = (process.env.REFERENCE_SEARCH_BASE_URL || "").replace(/\/$/, "");
    const apiKey = process.env.REFERENCE_SEARCH_API_KEY || "";
    if (!baseUrl || !apiKey) throw new SearchNotConfiguredError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const onAbort = () => controller.abort();
    input.signal.addEventListener("abort", onAbort);
    try {
      const response = await fetch(baseUrl + "/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
        body: JSON.stringify({
          query: input.query.slice(0, 400),
          intent: input.intent,
          maxResults: input.maxResults,
          recencyDays: input.recencyDays,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new SearchProviderError("SEARCH_FAILED", "搜索服务返回 " + response.status);
      }
      const payload = (await response.json()) as { results?: unknown[] };
      if (!Array.isArray(payload.results)) {
        throw new SearchProviderError("SEARCH_FAILED", "搜索服务响应格式异常");
      }
      const results = payload.results
        .slice(0, input.maxResults)
        .map((raw, index) => toResult((raw ?? {}) as Record<string, unknown>, index));
      if (results.length === 0) {
        throw new SearchProviderError("SEARCH_EMPTY", "没有找到相关结果");
      }
      return results;
    } catch (error) {
      if (error instanceof SearchProviderError || error instanceof SearchNotConfiguredError) throw error;
      if (controller.signal.aborted) throw new SearchProviderError("SEARCH_TIMEOUT", "搜索超时，请重试");
      throw new SearchProviderError("SEARCH_FAILED", "搜索服务不可用，请稍后重试");
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
    }
  },
};

export function getSearchProvider(): ReferenceSearchProvider {
  const kind = process.env.REFERENCE_SEARCH_PROVIDER || "none";
  if (kind === "none") return noneProvider;
  if (kind === "mock") return mockProvider;
  if (kind === "generic" || kind === "brave" || kind === "tavily") return genericProvider;
  return noneProvider;
}

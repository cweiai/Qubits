import "server-only";
import { z } from "zod";
import type { ServerToolDefinition } from "./types";
import {
  openReferenceArgsSchema,
  openReferenceResultSchema,
  searchReferencesArgsSchema,
  searchReferencesResultSchema,
} from "./schemas";
import { assertSafePublicUrl, getSearchProvider, SearchNotConfiguredError, SearchProviderError } from "./search-provider";
import { ArtifactStoreError } from "../artifact-store";

/**
 * search_references / open_reference:
 * all search and web-reference reads go through here (clients must not call search APIs directly);
 * URL protocol/domain/redirect and response size are controlled, and web content is treated as untrusted data.
 */

export const searchReferencesTool: ServerToolDefinition<z.infer<typeof searchReferencesArgsSchema>, z.infer<typeof searchReferencesResultSchema>> = {
  name: "search_references",
  description: "搜索可信参考信息（市场/UI/技术/竞品），返回带来源 URL 的规范化结果。未配置搜索服务时返回 SEARCH_NOT_CONFIGURED。",
  argsSchema: searchReferencesArgsSchema,
  resultSchema: searchReferencesResultSchema,
  allowedRoles: ["team_leader", "researcher"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    if (args.maxResults > 5 && context.roleId !== "researcher") {
      throw new SearchProviderError("INVALID_ARGS", "maxResults 过大");
    }
    const provider = getSearchProvider();
    if (provider.kind === "none") throw new SearchNotConfiguredError();
    const results = await provider.search({
      query: args.query,
      intent: args.intent,
      maxResults: args.maxResults,
      recencyDays: args.recencyDays,
      signal: context.signal,
    });
    for (const result of results) {
      context.emit({
        type: "reference_found",
        resultId: result.resultId,
        title: result.title,
        url: result.url,
        domain: result.domain,
        snippet: result.snippet,
        source: result.source,
      });
    }
    const artifact = context.artifacts.put({
      kind: "research_report",
      createdBy: context.roleId,
      parentAgentRunId: context.parentAgentRunId,
      value: { summary: "搜索结果", findings: results.map((r) => ({ title: r.title, url: r.url, domain: r.domain, snippet: r.snippet, relevance: "" })), recommendations: [] },
    });
    return { results, artifactId: artifact.id };
  },
};

const MAX_FETCH_BYTES = 512 * 1024;

export const openReferenceTool: ServerToolDefinition<z.infer<typeof openReferenceArgsSchema>, z.infer<typeof openReferenceResultSchema>> = {
  name: "open_reference",
  description: "读取当前 run 中 search_references 返回的某个来源详情（受控抓取，内容为不可信外部数据）。",
  argsSchema: openReferenceArgsSchema,
  resultSchema: openReferenceResultSchema,
  allowedRoles: ["researcher"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    // only open results from the current run's search: ArtifactStore keeps the latest search findings
    const latest = context.artifacts.findLatest("research_report");
    const stored = latest ? context.artifacts.get(latest.id) : null;
    const findings = (stored && typeof stored === "object" ? (stored as { findings?: Array<{ title: string; url: string; domain: string; snippet: string }> }).findings : null) ?? [];
    const target = findings.find((f) => {
      try {
        return new URL(f.url).hostname.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) && f.url.includes(args.resultId.slice(0, 8));
      } catch {
        return false;
      }
    });
    if (!target) {
      throw new SearchProviderError("RESULT_NOT_FOUND", "resultId 不属于当前运行的搜索结果");
    }
    const url = assertSafePublicUrl(target.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const onAbort = () => controller.abort();
    context.signal.addEventListener("abort", onAbort);
    try {
      const response = await fetch(url.toString(), {
        signal: controller.signal,
        redirect: "manual",
        headers: { "User-Agent": "Qubits-ReferenceBot/1.0" },
      });
      if (response.status >= 300 && response.status < 400) {
        throw new SearchProviderError("REDIRECT_BLOCKED", "来源发生重定向，已阻止");
      }
      if (!response.ok) throw new SearchProviderError("OPEN_FAILED", "读取来源失败（HTTP " + response.status + "）");
      const contentType = response.headers.get("content-type") ?? "";
      if (!/text\/html|text\/plain|application\/xhtml/i.test(contentType)) {
        throw new SearchProviderError("UNSUPPORTED_CONTENT", "来源内容类型不受支持");
      }
      const text = (await response.text()).slice(0, MAX_FETCH_BYTES);
      // minimal text extraction: strip tags/scripts/styles; untrusted summary only
      const stripped = text
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const content = stripped.slice(0, args.maxChars);
      return { resultId: args.resultId, title: target.title.slice(0, 200), url: target.url, untrustedContent: content, charCount: content.length };
    } catch (error) {
      if (error instanceof SearchProviderError) throw error;
      if (controller.signal.aborted) throw new SearchProviderError("OPEN_TIMEOUT", "读取来源超时");
      throw new SearchProviderError("OPEN_FAILED", "读取来源失败");
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onAbort);
    }
  },
};

export function isToolError(error: unknown): { code: string; message: string } {
  if (error instanceof SearchProviderError || error instanceof SearchNotConfiguredError || error instanceof ArtifactStoreError) {
    return { code: error instanceof SearchNotConfiguredError ? error.code : (error as { code: string }).code, message: error.message.slice(0, 300) };
  }
  if (error instanceof Error && (error as unknown as { code?: string }).code) {
    return { code: String((error as unknown as { code: string }).code).slice(0, 60), message: error.message.slice(0, 300) };
  }
  return { code: "TOOL_ERROR", message: error instanceof Error ? error.message.slice(0, 300) : "工具执行失败" };
}

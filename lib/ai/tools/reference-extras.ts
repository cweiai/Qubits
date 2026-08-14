import "server-only";
import { z } from "zod";
import type { ServerToolDefinition, ToolExecutionContext } from "./types";
import { ToolExecutionError } from "./types";
import { openReferenceTool, searchReferencesTool } from "./references";

/**
 * Reference info extension tools: work off the current run's ReferenceArtifact;
 * search_docs/search_ui_examples/search_competitors are intent wrappers around search_references.
 */

function getReferences(context: ToolExecutionContext): Array<{ resultId: string; title: string; url: string; domain: string; snippet: string; source: string }> {
  const ref = context.artifacts.findLatest("reference");
  if (!ref) return [];
  const value = context.artifacts.get(ref.id) as { results?: Array<{ resultId: string; title: string; url: string; domain: string; snippet: string; source: string }> } | null;
  return value?.results ?? [];
}

const listRefsResultSchema = z.object({
  references: z.array(z.object({ resultId: z.string(), title: z.string(), url: z.string(), domain: z.string(), snippet: z.string() })).max(20),
});

export const listReferencesTool: ServerToolDefinition<Record<string, never>, { references: Array<{ resultId: string; title: string; url: string; domain: string; snippet: string }> }> = {
  name: "list_references",
  description: "列出当前 run 已保存的参考来源。",
  argsSchema: z.object({}).strict(),
  resultSchema: listRefsResultSchema,
  allowedRoles: ["researcher", "team_leader", "reviewer"],
  risk: "low",
  requiresApproval: false,
  async execute(_args, context) {
    return { references: getReferences(context).map((r) => ({ resultId: r.resultId, title: r.title, url: r.url, domain: r.domain, snippet: r.snippet })) };
  },
};

export const saveReferenceTool: ServerToolDefinition<{ resultId: string }, { saved: boolean }> = {
  name: "save_reference",
  description: "把搜索结果加入当前 run 的参考 artifact。",
  argsSchema: z.object({ resultId: z.string().min(1).max(64) }),
  resultSchema: z.object({ saved: z.boolean() }),
  allowedRoles: ["researcher"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const existing = getReferences(context);
    const target = existing.find((r) => r.resultId === args.resultId);
    if (!target) throw new ToolExecutionError("RESULT_NOT_FOUND", "resultId 不在当前搜索结果中", false);
    const ref = context.artifacts.findLatest("reference");
    const value = ref ? (context.artifacts.get(ref.id) as { results?: unknown[] } | null) : null;
    const saved = new Set((value?.results ?? []).map((r) => (r as { resultId: string }).resultId));
    saved.add(args.resultId);
    context.artifacts.put({
      kind: "reference",
      createdBy: "researcher",
      parentAgentRunId: context.parentAgentRunId,
      value: { results: existing.filter((r) => saved.has(r.resultId)) },
    });
    return { saved: true };
  },
};

export const summarizeReferencesTool: ServerToolDefinition<Record<string, never>, { summary: string; count: number }> = {
  name: "summarize_references",
  description: "汇总当前 run 参考来源的摘要（基于已保存结果）。",
  argsSchema: z.object({}).strict(),
  resultSchema: z.object({ summary: z.string().max(2000), count: z.number().int() }),
  allowedRoles: ["researcher", "team_leader"],
  risk: "low",
  requiresApproval: false,
  async execute(_args, context) {
    const refs = getReferences(context);
    const summary = refs.map((r) => r.domain + "：" + r.title + "——" + r.snippet.slice(0, 80)).join("\n").slice(0, 2000);
    return { summary, count: refs.length };
  },
};

export const verifyReferenceTool: ServerToolDefinition<{ resultId: string }, { resultId: string; reachable: boolean; status: number | null }> = {
  name: "verify_reference",
  description: "校验参考链接可访问性（仅 https，受控请求）。",
  argsSchema: z.object({ resultId: z.string().min(1).max(64) }),
  resultSchema: z.object({ resultId: z.string(), reachable: z.boolean(), status: z.number().nullable() }),
  allowedRoles: ["researcher"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const target = getReferences(context).find((r) => r.resultId === args.resultId);
    if (!target) throw new ToolExecutionError("RESULT_NOT_FOUND", "resultId 不在当前搜索结果中", false);
    if (!target.url.startsWith("https://")) return { resultId: args.resultId, reachable: false, status: null };
    try {
      const response = await fetch(target.url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(6000) });
      return { resultId: args.resultId, reachable: response.status < 400, status: response.status };
    } catch {
      return { resultId: args.resultId, reachable: false, status: null };
    }
  },
};

function intentTool(name: string, intent: "product" | "ui" | "technical" | "competitor", description: string): ServerToolDefinition<{ query: string; maxResults: number }, { results: unknown[]; artifactId: string }> {
  return {
    name,
    description,
    argsSchema: z.object({ query: z.string().min(2).max(400), maxResults: z.number().int().min(1).max(8).default(5) }),
    resultSchema: z.object({ results: z.array(z.unknown()).max(8), artifactId: z.string() }),
    allowedRoles: ["researcher"],
    risk: "low",
    requiresApproval: false,
    async execute(args, context) {
      return searchReferencesTool.execute({ query: args.query, intent, maxResults: args.maxResults, recencyDays: null }, context);
    },
  };
}

export const searchDocsTool = intentTool("search_docs", "technical", "搜索技术文档参考。");
export const searchUiExamplesTool = intentTool("search_ui_examples", "ui", "搜索 UI 设计示例参考。");
export const searchCompetitorsTool = intentTool("search_competitors", "competitor", "搜索竞品参考。");

export const extractReferenceContentTool: ServerToolDefinition<{ resultId: string; maxChars: number }, { resultId: string; untrustedContent: string }> = {
  name: "extract_reference_content",
  description: "提取已打开来源的正文（不可信外部内容）。",
  argsSchema: z.object({ resultId: z.string().min(1).max(64), maxChars: z.number().int().min(500).max(12000).default(6000) }),
  resultSchema: z.object({ resultId: z.string(), untrustedContent: z.string().max(14000) }),
  allowedRoles: ["researcher"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const result = await openReferenceTool.execute({ resultId: args.resultId, maxChars: args.maxChars }, context);
    return { resultId: result.resultId, untrustedContent: result.untrustedContent };
  },
};

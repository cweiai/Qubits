import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@/lib/ai/artifact-store";
import { openaiProvider } from "@/lib/ai/openai-provider";
import { redactProgressText, sanitizeProgressSummary } from "@/lib/ai/progress-summary";
import { runToolCallingAgent } from "@/lib/ai/tool-loop";
import type { AIProvider } from "@/lib/ai/provider";
import type { AgentEvent } from "@/lib/contracts/agent-events";
import type { ToolExecutionContext } from "@/lib/ai/tools/types";
import { z } from "zod";

const REAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.QUIBITS_SUMMARY_MODEL;
  delete process.env.QUIBITS_PROGRESS_SUMMARY_TIMEOUT_MS;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeContext(emit: (event: AgentEvent) => void): ToolExecutionContext {
  return {
    runId: "run-progress",
    parentAgentRunId: null,
    roleId: "team_leader",
    depth: 0,
    signal: new AbortController().signal,
    currentManifest: null,
    currentAppId: "app-progress",
    currentVersion: 0,
    projectRecords: null,
    dataAdapter: null,
    artifacts: new ArtifactStore("run-progress"),
    emit,
    childAgentRunner: async () => ({ status: "completed", artifactId: null, summary: "ok", issues: [] }),
    quality: { buildPassed: false, testsPassed: false, securityScanPassed: false },
    previewCommitted: false,
    workspaceDir: process.cwd(),
    workspaceReady: true,
    sandbox: null,
    approvedTools: new Set<string>(),
    counters: { toolCalls: 0, childAgents: 0 },
  };
}

describe("独立阶段进度摘要", () => {
  it("摘要请求不暴露工具字段，并使用独立模型配置", async () => {
    process.env.OPENAI_API_KEY = "sk-summary-test-key-000000000000";
    process.env.QUIBITS_SUMMARY_MODEL = "summary-model";
    const requestBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ choices: [{ message: { content: "正在整理需求并准备下一步分工。" } }] });
    }) as unknown as typeof fetch;

    const summary = await openaiProvider.summarizeProgress!({
      roleId: "team_leader",
      phase: "planning",
      reasoningContent: "准备读取 /Users/cweiai/private/project.ts 并规划任务。",
    });

    expect(summary).toBe("正在整理需求并准备下一步分工。");
    expect(requestBodies[0]?.model).toBe("summary-model");
    expect(requestBodies[0]?.tools).toBeUndefined();
    expect(JSON.stringify(requestBodies[0])).not.toContain("/Users/cweiai/private");
  });

  it("消费流式 reasoning 增量并完整拼接工具调用", async () => {
    process.env.OPENAI_API_KEY = "sk-summary-test-key-000000000000";
    const deltas: string[] = [];
    globalThis.fetch = (async () => {
      const body = [
        'data: {"choices":[{"delta":{"reasoning_content":"先确认需求。"}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc-stream","function":{"name":"inspect_"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"current_app","arguments":"{}"}}]}}]}',
        'data: {"choices":[{"delta":{"content":"完成"}}]}',
        "data: [DONE]",
        "",
      ].join("\n");
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const result = await openaiProvider.generateWithTools({
      system: "sys",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "inspect_current_app", description: "inspect", parameters: { type: "object" } }],
      roleId: "team_leader",
      onReasoningDelta: (delta) => deltas.push(delta),
    });

    expect(deltas).toEqual(["先确认需求。"]);
    expect(result.reasoningContent).toBe("先确认需求。");
    expect(result.content).toBe("完成");
    expect(result.toolCalls).toEqual([{ id: "tc-stream", name: "inspect_current_app", rawArguments: "{}" }]);
  });

  it("脱敏路径和凭据，并拒绝把内部推理当作用户进度", () => {
    expect(redactProgressText("读取 /Users/cweiai/app.ts，使用 sk-secret-1234567890")).toContain("[path]");
    expect(redactProgressText("读取 /Users/cweiai/app.ts，使用 sk-secret-1234567890")).not.toContain("sk-secret");
    expect(redactProgressText("path=/etc/hosts")).toBe("path=[path]");
    expect(redactProgressText("参考 https://example.com/docs")).toContain("https://example.com/docs");
    expect(sanitizeProgressSummary("这里是 reasoning_content 的完整分析过程")).toBeNull();
    expect(sanitizeProgressSummary("正在修复交互并准备运行测试。\n")).toBe("正在修复交互并准备运行测试。");
  });

  it("摘要失败不会阻塞主 Agent，并成功发出安全事件", async () => {
    const events: AgentEvent[] = [];
    let calls = 0;
    const provider: AIProvider = {
      kind: "summary-test",
      async generateWithTools() {
        return {
          content: JSON.stringify({ ok: true, summary: "完成" }),
          toolCalls: [],
          reasoningContent: "我正在整理详细需求，确认当前阶段目标、约束条件和接下来的具体输出。",
        };
      },
      async summarizeProgress() {
        calls += 1;
        if (calls === 1) return "正在规划并准备下一步工作。";
        throw new Error("summary provider unavailable");
      },
    };

    const result = await runToolCallingAgent({
      roleId: "team_leader",
      agentRunId: "agent-progress",
      systemPrompt: "test",
      taskPrompt: "test",
      finalSchema: z.object({ ok: z.literal(true), summary: z.string() }),
      context: makeContext((event) => events.push(event)),
      requireToolCall: false,
      providerOverride: provider,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.status).toBe("completed");
    expect(calls).toBe(1);
    expect(events.filter((event) => event.type === "progress_summary")).toEqual([
      expect.objectContaining({
        type: "progress_summary",
        agentRunId: "agent-progress",
        roleId: "team_leader",
        phase: "planning",
        summary: "正在规划并准备下一步工作。",
      }),
    ]);
    expect(events.some((event) => JSON.stringify(event).includes("整理需求"))).toBe(false);

    const secondEvents: AgentEvent[] = [];
    const secondResult = await runToolCallingAgent({
      roleId: "team_leader",
      agentRunId: "agent-progress-failed-summary",
      systemPrompt: "test",
      taskPrompt: "test",
      finalSchema: z.object({ ok: z.literal(true), summary: z.string() }),
      context: makeContext((event) => secondEvents.push(event)),
      requireToolCall: false,
      providerOverride: provider,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondResult.status).toBe("completed");
    expect(secondEvents.some((event) => event.type === "progress_summary")).toBe(false);
  });
});

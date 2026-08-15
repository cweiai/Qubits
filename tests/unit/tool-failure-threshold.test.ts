import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runToolCallingAgent, readMaxToolFailures, ToolLoopError } from "@/lib/ai/tool-loop";
import { appBlueprintWithSummarySchema } from "@/lib/contracts/artifacts";
import { ArtifactStore } from "@/lib/ai/artifact-store";
import type { AgentEvent } from "@/lib/contracts/agent-events";
import type { ToolExecutionContext } from "@/lib/ai/tools/types";
import type { AIProvider, AgentTurnResponse, ChatMessage, GenerateWithToolsInput } from "@/lib/ai/provider";
import { makeTaskManifest } from "./fixtures";

/**
 * Exercises the tool-failure threshold: failures inject correction context, and exceeding the env threshold stops the run with an error.
 * The scripted fake provider replaces only the model, not tool execution, the threshold, or events.
 */

const FAIL_WORKSPACE = path.join(tmpdir(), "qubits-fail-test");

function makeContext(events: AgentEvent[]): ToolExecutionContext {
  mkdirSync(FAIL_WORKSPACE, { recursive: true });
  return {
    runId: "run-fail",
    parentAgentRunId: "agent-mike-000000000001",
    roleId: "engineer",
    depth: 1,
    signal: new AbortController().signal,
    currentManifest: makeTaskManifest(),
    currentAppId: "test-task-app",
    currentVersion: 1,
    projectRecords: null,
    dataAdapter: null,
    artifacts: new ArtifactStore("run-fail"),
    emit: (event) => events.push(event),
    childAgentRunner: async () => ({ status: "completed", artifactId: null, summary: "ok", issues: [] }),
    reviewerApproved: false,
    previewCommitted: false,
    workspaceDir: FAIL_WORKSPACE,
    workspaceReady: true,
    sandbox: null,
    approvedTools: new Set<string>(),
    counters: { toolCalls: 0, childAgents: 0 },
  };
}

function blueprintJson(): string {
  return JSON.stringify({
    appType: "任务管理",
    dataModel: {
      primaryCollection: "task",
      collections: [
        {
          name: "task",
          label: "任务",
          fields: [{ name: "title", label: "标题", type: "text", required: true }],
          allowedOperations: ["list", "count", "create", "update", "delete"],
        },
      ],
    },
    pages: [
      {
        id: "home",
        title: "任务看板",
        purpose: "管理任务",
        sections: [{ id: "list", kind: "list", title: "任务列表", description: "列表" }],
      },
    ],
    components: [],
    state: [],
    technicalApproach: { styling: "css", dataFlow: "qubits sdk", build: "esbuild", testing: "vitest" },
    validationRules: [],
    visualDirection: "简洁",
    summary: "完成",
  });
}

/** Every fs_read call targets a missing file, so the real executor returns NOT_FOUND. */
function failingProvider(seen: ChatMessage[][]): AIProvider {
  const turn = (): AgentTurnResponse => ({
    content: null,
    toolCalls: [{ id: "tc-fail-" + Math.random().toString(36).slice(2, 6), name: "fs_read", rawArguments: JSON.stringify({ path: "missing-file.txt", maxBytes: 100 }) }],
    reasoningContent: null,
  });
  return {
    kind: "mock",
    async generateWithTools(input: GenerateWithToolsInput): Promise<AgentTurnResponse> {
      seen.push(input.messages);
      return turn();
    },  };
}

describe("工具失败阈值", () => {
  afterEach(() => {
    delete process.env.QUIBITS_MAX_TOOL_FAILURES;
  });

  it("失败结果与报错注入上下文（后续请求包含改正指令）", async () => {
    process.env.QUIBITS_MAX_TOOL_FAILURES = "2";
    const events: AgentEvent[] = [];
    const seen: ChatMessage[][] = [];
    const context = makeContext(events);
    await expect(
      runToolCallingAgent({
        roleId: "engineer",
        agentRunId: "agent-test-000000000001",
        systemPrompt: "测试",
        taskPrompt: "校验一个不存在的 artifact",
        finalSchema: appBlueprintWithSummarySchema,
        context,
        requireToolCall: true,
        providerOverride: failingProvider(seen),
      })
    ).rejects.toThrowError(/连续失败 3 次/);
    // The second request's messages must include the error code and correction instructions.
    const second = seen[1] ?? [];
    const correction = second.filter((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("工具调用失败")).length;
    expect(correction).toBeGreaterThan(0);
    const toolMsg = second.find((m) => m.role === "tool");
    expect(toolMsg).toBeTruthy();
    expect((toolMsg as { content: string }).content).toContain("NOT_FOUND");
    // Every failure emits a tool_result with ok:false.
    expect(events.filter((e) => e.type === "tool_result" && e.ok === false).length).toBeGreaterThanOrEqual(3);
    // Stopping emits an error event.
    expect(events.some((e) => e.type === "error" && e.code === "TOOL_FAILURE_LIMIT_EXCEEDED")).toBe(true);
  });

  it("env 阈值解析：缺省 3、非法回退 3、可配置", () => {
    delete process.env.QUIBITS_MAX_TOOL_FAILURES;
    expect(readMaxToolFailures()).toBe(3);
    process.env.QUIBITS_MAX_TOOL_FAILURES = "abc";
    expect(readMaxToolFailures()).toBe(3);
    process.env.QUIBITS_MAX_TOOL_FAILURES = "5";
    expect(readMaxToolFailures()).toBe(5);
  });

  it("成功一次后失败计数清零", async () => {
    process.env.QUIBITS_MAX_TOOL_FAILURES = "1";
    const events: AgentEvent[] = [];
    const seen: ChatMessage[][] = [];
    const context = makeContext(events);
    // Fail once, then succeed: the successful turn returns the final JSON (no more tool calls).
    let calls = 0;
    const provider: AIProvider = {
      kind: "mock",
      async generateWithTools(input: GenerateWithToolsInput): Promise<AgentTurnResponse> {
        seen.push(input.messages);
        calls += 1;
        if (calls === 1) {
          return { content: null, toolCalls: [{ id: "tc-x", name: "fs_read", rawArguments: JSON.stringify({ path: "missing-file.txt", maxBytes: 100 }) }], reasoningContent: null };
        }
        // Success path: inspect_current_app (real execution succeeds).
        if (calls === 2) {
          return { content: null, toolCalls: [{ id: "tc-ok", name: "inspect_current_app", rawArguments: "{}" }], reasoningContent: null };
        }
        return { content: blueprintJson(), toolCalls: [], reasoningContent: null };
      },
    };
    const result = await runToolCallingAgent({
      roleId: "engineer",
      agentRunId: "agent-test-000000000002",
      systemPrompt: "测试",
      taskPrompt: "先失败后成功",
      finalSchema: appBlueprintWithSummarySchema,
      context,
      requireToolCall: true,
      providerOverride: provider,
    });
    expect(result.status).toBe("completed");
    void ToolLoopError;
  }, 30000);
});

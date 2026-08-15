import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { runToolCallingAgent, ToolLoopError, readMaxTotalToolFailures } from "@/lib/ai/tool-loop";
import { runMikeOrchestrator } from "@/lib/ai/mike-orchestrator";
import { ProviderError } from "@/lib/ai/openai-provider";
import { appBlueprintWithSummarySchema } from "@/lib/contracts/artifacts";
import { ArtifactStore } from "@/lib/ai/artifact-store";
import type { AgentEvent } from "@/lib/contracts/agent-events";
import type { ToolExecutionContext } from "@/lib/ai/tools/types";
import type { AIProvider, AgentTurnResponse } from "@/lib/ai/provider";
import { dockerAvailable } from "./fakes";
import { makeTaskManifest } from "./fixtures";

/**
 * Agent-convergence tests (FakeProvider, no real model):
 * repeated-success loop guard, total tool-call budget, total deadline, malformed-args
 * failure cap, string-blueprint rejection, and stable provider error codes reaching
 * the orchestrator's error event (what the API route persists to build_tasks.error_code).
 */

let workspace: string;
const scratch: string[] = [];

function makeContext(events: AgentEvent[] = [], overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    runId: "run-conv",
    parentAgentRunId: "agent-mike-000000000001",
    roleId: "engineer",
    depth: 0,
    signal: new AbortController().signal,
    currentManifest: makeTaskManifest(),
    currentAppId: "test-task-app",
    currentVersion: 1,
    projectRecords: null,
    dataAdapter: null,
    artifacts: new ArtifactStore("run-conv"),
    emit: (event) => events.push(event),
    childAgentRunner: async () => ({ status: "completed", artifactId: null, summary: "ok", issues: [] }),
    reviewerApproved: false,
    previewCommitted: false,
    workspaceDir: workspace,
    workspaceReady: true,
    sandbox: null,
    approvedTools: new Set<string>(),
    counters: { toolCalls: 0, childAgents: 0 },
    ...overrides,
  };
}

/** Provider that always emits one tool call (optionally with a delay per turn). */
function loopingProvider(build: (n: number) => { name: string; rawArguments: string }, delayMs = 0): AIProvider {
  let n = 0;
  return {
    kind: "mock",
    async generateWithTools(): Promise<AgentTurnResponse> {
      n += 1;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const call = build(n);
      return { content: null, toolCalls: [{ id: "tc-" + n, ...call }], reasoningContent: null };
    },
  };
}

function engineerContext(events: AgentEvent[]): ToolExecutionContext {
  return makeContext(events, { roleId: "engineer" });
}

beforeAll(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "qubits-conv-"));
  scratch.push(workspace);
});

afterEach(() => {
  delete process.env.QUIBITS_AGENT_MAX_TOOL_CALLS;
  delete process.env.QUIBITS_AGENT_MAX_ROUNDS;
  delete process.env.QUIBITS_AGENT_DEADLINE_MS;
  delete process.env.QUIBITS_MAX_TOOL_FAILURES_TOTAL;
});

afterAll(() => {
  for (const dir of scratch) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("收敛控制（FakeProvider）", () => {
  it("重复成功调用触发循环保护：第三次起 REPEATED_CALL，随后失败阈值终止 Agent", async () => {
    const events: AgentEvent[] = [];
    const context = engineerContext(events);
    const provider = loopingProvider(() => ({
      name: "fs_write",
      rawArguments: JSON.stringify({ path: "loop.txt", content: "x" }),
    }));
    await expect(
      runToolCallingAgent({
        roleId: "engineer",
        agentRunId: "agent-conv-000000000001",
        systemPrompt: "测试",
        taskPrompt: "循环",
        finalSchema: appBlueprintWithSummarySchema,
        context,
        requireToolCall: false,
        providerOverride: provider,
      })
    ).rejects.toSatisfy((error: unknown) => error instanceof ToolLoopError && (error as ToolLoopError).code === "TOOL_FAILURE_LIMIT_EXCEEDED");
    // The loop guard fired: a REPEATED_CALL result was emitted for an identical SUCCESSFUL call.
    expect(events.some((e) => e.type === "tool_result" && e.errorCode === "REPEATED_CALL")).toBe(true);
    // The file was written at most REPEAT_SUCCESS_LIMIT times (real execution stops).
    expect(existsSync(path.join(workspace, "loop.txt"))).toBe(true);
  });

  it("总工具调用预算能终止 Agent（AGENT_TOOL_BUDGET_EXCEEDED）", async () => {
    process.env.QUIBITS_AGENT_MAX_TOOL_CALLS = "4";
    const events: AgentEvent[] = [];
    const context = engineerContext(events);
    const provider = loopingProvider((n) => ({
      name: "fs_write",
      rawArguments: JSON.stringify({ path: "unique-" + n + ".txt", content: "x" }),
    }));
    await expect(
      runToolCallingAgent({
        roleId: "engineer",
        agentRunId: "agent-conv-000000000002",
        systemPrompt: "测试",
        taskPrompt: "预算",
        finalSchema: appBlueprintWithSummarySchema,
        context,
        requireToolCall: false,
        providerOverride: provider,
      })
    ).rejects.toSatisfy((error: unknown) => error instanceof ToolLoopError && (error as ToolLoopError).code === "AGENT_TOOL_BUDGET_EXCEEDED");
    expect(events.some((e) => e.type === "error" && e.code === "AGENT_TOOL_BUDGET_EXCEEDED")).toBe(true);
  });

  it("总 deadline 能终止 Agent（AGENT_DEADLINE_EXCEEDED）", async () => {
    process.env.QUIBITS_AGENT_DEADLINE_MS = "150";
    const events: AgentEvent[] = [];
    const context = engineerContext(events);
    const provider = loopingProvider(
      (n) => ({ name: "fs_write", rawArguments: JSON.stringify({ path: "deadline-" + n + ".txt", content: "x" }) }),
      60
    );
    await expect(
      runToolCallingAgent({
        roleId: "engineer",
        agentRunId: "agent-conv-000000000003",
        systemPrompt: "测试",
        taskPrompt: "超时",
        finalSchema: appBlueprintWithSummarySchema,
        context,
        requireToolCall: false,
        providerOverride: provider,
      })
    ).rejects.toSatisfy((error: unknown) => error instanceof ToolLoopError && (error as ToolLoopError).code === "AGENT_DEADLINE_EXCEEDED");
  });

  it("malformed tool arguments 达到阈值后返回稳定错误码（TOOL_FAILURE_LIMIT_EXCEEDED）", async () => {
    process.env.QUIBITS_MAX_TOOL_FAILURES_TOTAL = "4";
    const events: AgentEvent[] = [];
    const context = engineerContext(events);
    const provider = loopingProvider(() => ({ name: "fs_write", rawArguments: "{oops not json" }));
    await expect(
      runToolCallingAgent({
        roleId: "engineer",
        agentRunId: "agent-conv-000000000004",
        systemPrompt: "测试",
        taskPrompt: "坏参数",
        finalSchema: appBlueprintWithSummarySchema,
        context,
        requireToolCall: false,
        providerOverride: provider,
      })
    ).rejects.toSatisfy((error: unknown) => error instanceof ToolLoopError && (error as ToolLoopError).code === "TOOL_FAILURE_LIMIT_EXCEEDED");
    expect(events.some((e) => e.type === "tool_result" && e.errorCode === "INVALID_ARGS")).toBe(true);
  });

  it("architect 输出 JSON 字符串（非结构化对象）被 finalSchema 拒绝并耗尽轮次预算", async () => {
    const events: AgentEvent[] = [];
    const context = makeContext(events, { roleId: "architect" });
    const blueprint = JSON.stringify({ appType: "x", summary: "完成" });
    const provider: AIProvider = {
      kind: "mock",
      async generateWithTools(): Promise<AgentTurnResponse> {
        // The model returns the blueprint as a STRING inside content — must be rejected.
        return { content: JSON.stringify(blueprint), toolCalls: [], reasoningContent: null };
      },
    };
    await expect(
      runToolCallingAgent({
        roleId: "architect",
        agentRunId: "agent-conv-000000000005",
        systemPrompt: "测试",
        taskPrompt: "产出蓝图",
        finalSchema: appBlueprintWithSummarySchema,
        context,
        requireToolCall: false,
        providerOverride: provider,
      })
    ).rejects.toSatisfy((error: unknown) => error instanceof ToolLoopError && (error as ToolLoopError).code === "AGENT_TOOL_BUDGET_EXCEEDED");
  });

  it("总失败上限存在且可配置（readMaxTotalToolFailures）", () => {
    expect(readMaxTotalToolFailures()).toBeGreaterThanOrEqual(4);
  });
});

describe("Provider 错误码穿透到编排错误事件", () => {
  it("PROVIDER_NETWORK_ERROR 成为 error 事件的稳定 code（不再落 ORCHESTRATION_ERROR）", async () => {
    const events: AgentEvent[] = [];
    const failing: AIProvider = {
      kind: "mock",
      async generateWithTools(): Promise<AgentTurnResponse> {
        throw new ProviderError("PROVIDER_NETWORK_ERROR", "模型服务网络错误（ECONNRESET）：无法连接模型服务，请检查网络后重试。", "ECONNRESET");
      },
    };
    const result = await runMikeOrchestrator({
      prompt: "网络故障测试",
      currentManifest: null,
      currentAppId: "test-app-0001",
      currentVersion: 0,
      projectRecords: null,
      emit: (event) => events.push(event),
      workspaceDir: workspace,
      providerOverride: failing,
    });
    expect(result.status).toBe("failed");
    const errorEvent = events.find((e) => e.type === "error") as { code?: string; message: string } | undefined;
    expect(errorEvent?.code).toBe("PROVIDER_NETWORK_ERROR");
    expect(errorEvent?.message).toContain("模型网络错误");
    expect(errorEvent?.message).toContain("ECONNRESET");
    // The legacy generic code must not appear.
    expect(events.some((e) => e.type === "error" && e.code === "ORCHESTRATION_ERROR")).toBe(false);
  });
});

describe("完整 Mock 流程：每类最终 artifact 只有一份", () => {
  it.skipIf(!dockerAvailable())("番茄钟应用：ProductBrief→Blueprint→CodeWorkspace→Reviewer→Preview 依次完成且单份产物", async () => {
    process.env.QUIBITS_MOCK_PROVIDER = "true";
    process.env.REFERENCE_SEARCH_PROVIDER = "mock";
    try {
      const ws = path.join(homedir(), ".qubits-conv-full-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6));
      const artifactFile = path.join(homedir(), ".qubits-conv-art-" + Date.now() + ".json");
      mkdirSync(ws, { recursive: true });
      scratch.push(ws);
      scratch.push(artifactFile);
      const events: AgentEvent[] = [];
      const result = await runMikeOrchestrator({
        prompt: "做一个番茄钟应用",
        currentManifest: null,
        currentAppId: "test-app-0001",
        currentVersion: 0,
        projectRecords: null,
        emit: (event) => events.push(event),
        workspaceDir: ws,
        artifactFile,
      });
      expect(result.status).toBe("completed");
      // One artifact per final kind — persisted exactly once by the orchestrator.
      const entries = JSON.parse(readFileSync(artifactFile, "utf8")) as Array<{ ref: { kind: string } }>;
      const countByKind = (kind: string): number => entries.filter((entry) => entry.ref.kind === kind).length;
      expect(countByKind("product_brief")).toBe(1);
      expect(countByKind("app_blueprint")).toBe(1);
      expect(countByKind("code_workspace")).toBe(1);
      expect(countByKind("review_report")).toBe(1);
      expect(countByKind("build_report")).toBeGreaterThanOrEqual(1);
      expect(countByKind("preview_bundle")).toBeGreaterThanOrEqual(1);
      // The pipeline really finished: preview_ready + run completed events exist.
      expect(events.some((e) => e.type === "preview_ready")).toBe(true);
    } finally {
      delete process.env.QUIBITS_MOCK_PROVIDER;
      delete process.env.REFERENCE_SEARCH_PROVIDER;
    }
  }, 300000);
});

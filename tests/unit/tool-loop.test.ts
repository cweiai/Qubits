import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { runMikeOrchestrator } from "@/lib/ai/mike-orchestrator";
import { executeTool, ToolExecutionError } from "@/lib/ai/tools/registry";
import { ArtifactStore } from "@/lib/ai/artifact-store";
import { renderPreviewTool, completeRunTool } from "@/lib/ai/tools/preview";
import { delegateToAgentTool } from "@/lib/ai/tools/delegation";
import type { AgentEvent } from "@/lib/contracts/agent-events";
import type { ToolExecutionContext } from "@/lib/ai/tools/types";
import { runToolCallingAgent, ToolLoopError } from "@/lib/ai/tool-loop";
import { assertValidToolMessageSequence } from "@/lib/ai/openai-provider";
import type { AIProvider, ChatMessage } from "@/lib/ai/provider";
import type { StoredArtifactEntry } from "@/lib/ai/artifact-store";

/**
 * Tool Calling orchestration tests: the mock replaces only the external model service (QUIBITS_MOCK_PROVIDER),
 * while the tool registry, permissions, delegation, preview/complete gating, and event protocol all run through real execution paths.
 */

beforeAll(() => {
  process.env.QUIBITS_MOCK_PROVIDER = "true";
  process.env.REFERENCE_SEARCH_PROVIDER = "mock";
  delete process.env.SANDBOX_PROVIDER; // container-only; the orchestrator builds the real provider
});

/** Workspace under the repo so type resolution reaches the host node_modules (real checks run). */
function repoWorkspaceDir(): string {
  return path.join(process.cwd(), "data", "workspaces", "test-ws-" + crypto.randomUUID());
}

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  const artifacts = new ArtifactStore("run-test");
  return {
    runId: "run-test",
    parentAgentRunId: "agent-mike-000000000001",
    roleId: "team_leader",
    depth: 0,
    signal: new AbortController().signal,
    currentManifest: null,
    currentAppId: "test-app-0001",
    currentVersion: 0,
    projectRecords: null,
    artifacts,
    emit: () => undefined,
    childAgentRunner: async () => ({ status: "completed", artifactId: null, summary: "ok", issues: [] }),
    reviewerApproved: false,
    previewCommitted: false,
    workspaceDir: repoWorkspaceDir(),
    workspaceReady: true,
    sandbox: null,
    dataAdapter: null,
    approvedTools: new Set<string>(),
    counters: { toolCalls: 0, childAgents: 0 },
    ...overrides,
  };
}

describe("迈克主编排（mock provider）", () => {
  it("第一条事件必须是迈克的 agent_started，且完整闭环事件真实存在", async () => {
    const wsDir = repoWorkspaceDir();
    const events: AgentEvent[] = [];
    try {
      const result = await runMikeOrchestrator({
        prompt: "创建一个个人任务管理器",
        currentManifest: null,
        currentAppId: "test-app-0001",
        currentVersion: 0,
        projectRecords: null,
        emit: (event) => events.push(event),
        workspaceDir: wsDir,
      });
      expect(result.status).toBe("completed");
      expect(events[0]).toMatchObject({ type: "agent_started", roleId: "team_leader", parentAgentRunId: null });
      const first = events[0] as { agentRunId: string };
      // The delegated sub-agent must really exist and point to Mike as parent.
      const delegated = events.find((e) => e.type === "agent_delegated");
      expect(delegated).toBeTruthy();
      const productDelegate = events.find(
        (e) => e.type === "agent_delegated" && e.targetRole === "product_manager"
      );
      expect(productDelegate).toBeTruthy();
      expect((productDelegate as { parentAgentRunId: string }).parentAgentRunId).toBe(first.agentRunId);
      // A single run id must thread through delegated → started → completed (no ghost rows).
      const delegatedEvents = events.filter((e) => e.type === "agent_delegated");
      const startedEvents = events.filter((e) => e.type === "agent_started");
      for (const del of delegatedEvents) {
        const id = (del as { childAgentRunId: string }).childAgentRunId;
        expect(startedEvents.some((e) => (e as { agentRunId: string }).agentRunId === id)).toBe(true);
        expect(
          events.some((e) => e.type === "agent_completed" && (e as { agentRunId: string }).agentRunId === id)
        ).toBe(true);
      }
      // Every tool_call_started has a matching tool_result.
      const started = events.filter((e) => e.type === "tool_call_started");
      const results = events.filter((e) => e.type === "tool_result");
      expect(started.length).toBeGreaterThanOrEqual(5);
      expect(results.length).toBe(started.length);
      expect(results.every((r) => r.type === "tool_result" && r.ok === true)).toBe(true);
      // Tool cards show human-readable summaries, never raw JSON.
      for (const result of results) {
        const summary = (result as { resultSummary: string }).resultSummary;
        expect(summary.trim().startsWith("{")).toBe(false);
      }
      // Alex must write files and build successfully through real tool calls.
      const builds = results.filter((r) => r.type === "tool_result" && r.toolName === "run_build");
      expect(builds.length).toBeGreaterThanOrEqual(1);
      expect(builds.every((r) => r.ok === true)).toBe(true);
      // Preview and completion must come from tools.
      expect(events.some((e) => e.type === "preview_ready")).toBe(true);
      expect(events.some((e) => e.type === "run_completed")).toBe(true);
      // Ordering invariant: preview_ready precedes run_completed, and Mike starts first.
      const previewIndex = events.findIndex((e) => e.type === "preview_ready");
      const completeIndex = events.findIndex((e) => e.type === "run_completed");
      expect(previewIndex).toBeGreaterThan(0);
      expect(completeIndex).toBeGreaterThan(previewIndex);
    } finally {
      rmSync(wsDir, { recursive: true, force: true });
    }
  }, 180000);

  it("同任务续跑：artifactFile 跨尝试持久化并恢复原产物 id（不重做已完成工作）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qubits-art-"));
    const artifactFile = path.join(dir, "artifacts.json");
    const wsDir = repoWorkspaceDir();
    try {
      const events1: AgentEvent[] = [];
      const first = await runMikeOrchestrator({
        prompt: "创建一个任务管理器（续跑测试）",
        currentManifest: null,
        currentAppId: "test-app-0001",
        currentVersion: 0,
        projectRecords: null,
        emit: (event) => events1.push(event),
        workspaceDir: wsDir,
        artifactFile,
      });
      expect(first.status).toBe("completed");
      const raw1 = JSON.parse(readFileSync(artifactFile, "utf8")) as StoredArtifactEntry[];
      expect(raw1.length).toBeGreaterThan(0);
      const ids1 = new Set(raw1.map((e) => e.ref.id));

      const events2: AgentEvent[] = [];
      const second = await runMikeOrchestrator({
        prompt: "同上（续跑第二次）",
        currentManifest: null,
        currentAppId: "test-app-0001",
        currentVersion: 0,
        projectRecords: null,
        emit: (event) => events2.push(event),
        workspaceDir: wsDir,
        artifactFile,
        resumeContext: "【续跑第 1 次：从失败的那一步继续】测试上下文",
      });
      expect(second.status).toBe("completed");
      const raw2 = JSON.parse(readFileSync(artifactFile, "utf8")) as StoredArtifactEntry[];
      const ids2 = raw2.map((e) => e.ref.id);
      // First attempt's artifact ids survive (restored, not dropped) and new ones are added.
      expect(ids1.size).toBeGreaterThan(0);
      for (const id of ids1) expect(ids2).toContain(id);
      expect(ids2.length).toBeGreaterThan(ids1.size);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(wsDir, { recursive: true, force: true });
    }
  }, 180000);
});

describe("Tool Calling 消息批次", () => {
  const finalSchema = z.object({ ok: z.literal(true), summary: z.string() });

  it("多工具调用失败时，先回完全部 tool 结果，再追加 user 纠错消息", async () => {
    let providerRound = 0;
    let secondRequest: ChatMessage[] = [];
    const provider: AIProvider = {
      kind: "mock",
      async generateWithTools(input) {
        providerRound += 1;
        if (providerRound === 1) {
          return {
            content: null,
            toolCalls: [
              { id: "tc-a", name: "missing_tool_a", rawArguments: "{}" },
              { id: "tc-b", name: "missing_tool_b", rawArguments: "{}" },
            ],
            reasoningContent: null,
          };
        }
        secondRequest = [...input.messages];
        assertValidToolMessageSequence(secondRequest);
        return {
          content: JSON.stringify({ ok: true, summary: "已处理失败" }),
          toolCalls: [],
          reasoningContent: null,
        };
      },
    };

    const result = await runToolCallingAgent({
      roleId: "team_leader",
      agentRunId: "agent-protocol-batch",
      systemPrompt: "test",
      taskPrompt: "test",
      finalSchema,
      context: makeContext(),
      requireToolCall: true,
      providerOverride: provider,
    });

    expect(result.status).toBe("completed");
    expect(secondRequest.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "user",
    ]);
    expect((secondRequest[2] as { tool_call_id: string }).tool_call_id).toBe("tc-a");
    expect((secondRequest[3] as { tool_call_id: string }).tool_call_id).toBe("tc-b");
  });

  it("空 call id 在 assistant 与 tool 结果中复用同一个生成值", async () => {
    let providerRound = 0;
    let secondRequest: ChatMessage[] = [];
    const provider: AIProvider = {
      kind: "mock",
      async generateWithTools(input) {
        providerRound += 1;
        if (providerRound === 1) {
          return {
            content: null,
            toolCalls: [{ id: "", name: "inspect_current_app", rawArguments: "{}" }],
            reasoningContent: null,
          };
        }
        secondRequest = [...input.messages];
        return {
          content: JSON.stringify({ ok: true, summary: "完成" }),
          toolCalls: [],
          reasoningContent: null,
        };
      },
    };

    await runToolCallingAgent({
      roleId: "team_leader",
      agentRunId: "agent-protocol-id",
      systemPrompt: "test",
      taskPrompt: "test",
      finalSchema,
      context: makeContext(),
      requireToolCall: true,
      providerOverride: provider,
    });

    const assistant = secondRequest[1] as Extract<ChatMessage, { role: "assistant" }>;
    const tool = secondRequest[2] as Extract<ChatMessage, { role: "tool" }>;
    expect(assistant.tool_calls?.[0].id).toMatch(/^tc-/);
    expect(tool.tool_call_id).toBe(assistant.tool_calls?.[0].id);
  });

  it("重复 call id 在执行工具前失败", async () => {
    const provider: AIProvider = {
      kind: "mock",
      async generateWithTools() {
        return {
          content: null,
          toolCalls: [
            { id: "duplicate", name: "inspect_current_app", rawArguments: "{}" },
            { id: "duplicate", name: "inspect_current_app", rawArguments: "{}" },
          ],
          reasoningContent: null,
        };
      },
    };

    await expect(runToolCallingAgent({
      roleId: "team_leader",
      agentRunId: "agent-protocol-duplicate",
      systemPrompt: "test",
      taskPrompt: "test",
      finalSchema,
      context: makeContext(),
      requireToolCall: true,
      providerOverride: provider,
    })).rejects.toMatchObject({ code: "INVALID_TOOL_CALL" } satisfies Partial<ToolLoopError>);
  });
});

describe("工具权限与门控（真实执行器）", () => {
  it("非迈克角色调用 delegate_to_agent 被拒绝", async () => {
    await expect(
      delegateToAgentTool.execute(
        { targetRole: "engineer", task: "x", expectedOutput: "code_workspace", inputArtifactIds: [] },
        makeContext({ roleId: "engineer" })
      )
    ).rejects.toThrowError(/只有团队领队/);
  });

  it("targetRole 与 expectedOutput 不匹配被拒绝", async () => {
    await expect(
      delegateToAgentTool.execute(
        { targetRole: "engineer", task: "x", expectedOutput: "product_brief", inputArtifactIds: [] },
        makeContext()
      )
    ).rejects.toThrowError(/不匹配/);
  });

  it("未知工具与非法参数被拒绝", async () => {
    await expect(executeTool("eval_code", {}, makeContext())).rejects.toThrowError(/未知工具/);
    await expect(
      executeTool("render_preview", { artifactId: "x", reason: "bad" }, makeContext())
    ).rejects.toThrowError(ToolExecutionError);
  });

  it("Reviewer 未批准时 render_preview 返回 PREVIEW_BLOCKED（即使构建成功）", async () => {
    const context = makeContext({ reviewerApproved: false });
    const store = context.artifacts;
    const bundleRef = store.put({
      kind: "preview_bundle",
      createdBy: "engineer",
      parentAgentRunId: "agent-mike-000000000001",
      value: { html: "<!doctype html><html><body>ok</body></html>", bytes: 48 },
    });
    store.put({
      kind: "build_report",
      createdBy: "engineer",
      parentAgentRunId: "agent-mike-000000000001",
      value: { status: "success", errorCode: null, message: null, log: "", entry: "src/main.tsx", files: [], deps: [], outputBytes: 48, durationMs: 1, builtAt: Date.now() },
    });
    await expect(
      renderPreviewTool.execute({ artifactId: bundleRef.id, reason: "initial_generation", deviceHint: null }, context)
    ).rejects.toThrowError(/尚未批准或存在阻断/);
  });

  it("render_preview 不接受非 preview_bundle artifact", async () => {
    const context = makeContext({ reviewerApproved: true });
    const store = context.artifacts;
    const ref = store.put({
      kind: "code_workspace",
      createdBy: "engineer",
      parentAgentRunId: "agent-mike-000000000001",
      value: { summary: "x" },
    });
    await expect(
      renderPreviewTool.execute({ artifactId: ref.id, reason: "initial_generation", deviceHint: null }, context)
    ).rejects.toThrowError(/只能接受/);
  });

  it("未 render_preview 时 complete_run 返回 PREVIEW_REQUIRED", async () => {
    const context = makeContext({ reviewerApproved: true, previewCommitted: false });
    const store = context.artifacts;
    store.put({ kind: "product_brief", createdBy: "product_manager", parentAgentRunId: null, value: { summary: "x" } });
    store.put({ kind: "app_blueprint", createdBy: "architect", parentAgentRunId: null, value: { summary: "x" } });
    store.put({ kind: "code_workspace", createdBy: "engineer", parentAgentRunId: null, value: { summary: "x" } });
    store.put({ kind: "preview_bundle", createdBy: "engineer", parentAgentRunId: null, value: { html: "<html></html>", bytes: 13 } });
    store.put({
      kind: "build_report",
      createdBy: "engineer",
      parentAgentRunId: null,
      value: { status: "success", errorCode: null, message: null, log: "", entry: "src/main.tsx", files: [], deps: [], outputBytes: 13, durationMs: 1, builtAt: Date.now() },
    });
    await expect(
      completeRunTool.execute({ summary: "完成", nextSuggestions: [] }, context)
    ).rejects.toThrowError(/必须先成功调用 render_preview/);
  });

  it("搜索未配置时 search_references 返回 SEARCH_NOT_CONFIGURED", async () => {
    const previous = process.env.REFERENCE_SEARCH_PROVIDER;
    process.env.REFERENCE_SEARCH_PROVIDER = "none";
    const { searchReferencesTool } = await import("@/lib/ai/tools/references");
    await expect(
      searchReferencesTool.execute({ query: "测试", intent: "ui", maxResults: 3, recencyDays: null }, makeContext())
    ).rejects.toThrowError(/未配置参考搜索服务/);
    process.env.REFERENCE_SEARCH_PROVIDER = previous;
  });
});

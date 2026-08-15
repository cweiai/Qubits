import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runToolCallingAgent } from "@/lib/ai/tool-loop";
import { ROLE_DEFINITIONS } from "@/lib/ai/roles";
import {
  productBriefWithSummarySchema,
  appBlueprintWithSummarySchema,
  codeWorkspaceSchema,
} from "@/lib/contracts/artifacts";
import { ArtifactStore } from "@/lib/ai/artifact-store";
import type { AgentEvent } from "@/lib/contracts/agent-events";
import type { ToolExecutionContext } from "@/lib/ai/tools/types";
import type {
  AIProvider,
  AgentTurnResponse,
  ChatMessage,
  GenerateWithToolsInput,
  ToolChoiceSpec,
} from "@/lib/ai/provider";
import type { RoleId } from "@/lib/contracts/agent-events";
import { initWorkspace } from "@/lib/workspace/workspace-manager";
import { FakeSandboxProvider } from "./fakes";

/**
 * No-progress loop tests (FakeProvider, no real LLM):
 * DUPLICATE_OBSERVATION semantics for inspect_current_app (boolean-flag variants are ONE
 * observation), per-state-version cache invalidation, role-specific Controller
 * directives (force_final / force_next_tool), A-B-A-B NO_PROGRESS detection, and the
 * tool-message protocol invariant (every assistant.tool_calls batch is fully backfilled).
 */

let workspace: string;
const scratch: string[] = [];

function makeContext(
  role: RoleId,
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    runId: "run-noprog",
    parentAgentRunId: "agent-mike-000000000001",
    roleId: role,
    depth: 0,
    signal: new AbortController().signal,
    currentManifest: null,
    currentAppId: "test-task-app",
    currentVersion: 1,
    projectRecords: null,
    dataAdapter: null,
    artifacts: new ArtifactStore("run-noprog"),
    emit: () => undefined,
    childAgentRunner: async () => ({
      status: "completed",
      artifactId: null,
      summary: "ok",
      issues: [],
    }),
    quality: { buildPassed: false, testsPassed: false, securityScanPassed: false },
    previewCommitted: false,
    workspaceDir: workspace,
    workspaceReady: true,
    sandbox: null,
    approvedTools: new Set<string>(),
    counters: { toolCalls: 0, childAgents: 0 },
    ...overrides,
  };
}

function productBriefJson(): string {
  return JSON.stringify({
    appName: "番茄钟",
    targetUser: "个人用户",
    problem: "专注管理",
    coreFeatures: ["计时", "统计"],
    primaryEntity: "计时",
    assumptions: ["mock"],
    outOfScope: [],
    summary: "完成",
  });
}

function blueprintJson(): string {
  return JSON.stringify({
    appType: "番茄钟",
    dataModel: {
      primaryCollection: "pomodoros",
      collections: [
        {
          name: "pomodoros",
          label: "番茄",
          fields: [
            { name: "title", label: "标题", type: "text", required: true },
          ],
          allowedOperations: ["list", "count", "create", "update", "delete"],
        },
      ],
    },
    pages: [
      {
        id: "home",
        title: "计时",
        purpose: "计时",
        sections: [
          { id: "s", kind: "list", title: "列表", description: "列表" },
        ],
      },
    ],
    components: [],
    state: [],
    technicalApproach: {
      styling: "css",
      dataFlow: "qubits sdk",
      build: "esbuild",
      testing: "vitest",
    },
    validationRules: [],
    visualDirection: "简洁",
    summary: "完成",
  });
}

function createEngineeringWorkspace(prefix: string): string {
  const buildWorkspace = mkdtempSync(path.join(tmpdir(), prefix));
  scratch.push(buildWorkspace);
  initWorkspace(buildWorkspace, { taskId: prefix.replace(/[^a-z0-9-]/gi, "") });
  mkdirSync(path.join(buildWorkspace, "src"), { recursive: true });
  writeFileSync(
    path.join(buildWorkspace, "qubits.manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "通用应用",
      description: "控制器收尾测试",
      main: "src/main.tsx",
      collections: [],
      dependencies: [],
    }),
  );
  writeFileSync(
    path.join(buildWorkspace, "src", "main.tsx"),
    'const root = document.getElementById("root");\nif (root) root.textContent = "ready";\n',
  );
  return buildWorkspace;
}

interface Round {
  toolCalls?: Array<{ name: string; rawArguments: string }>;
  content?: string | null;
}

/** Scripted provider that also records what the Controller exposed each round. */
function scriptedProvider(
  rounds: Round[],
  seenInputs: Array<{
    tools: string[];
    toolChoice: ToolChoiceSpec | undefined;
    messages: ChatMessage[];
  }>,
): AIProvider {
  let index = 0;
  return {
    kind: "mock",
    async generateWithTools(
      input: GenerateWithToolsInput,
    ): Promise<AgentTurnResponse> {
      seenInputs.push({
        tools: input.tools.map((t) => t.name),
        toolChoice: input.toolChoice,
        messages: input.messages.map((m) => ({ ...m })),
      });
      const round = rounds[Math.min(index, rounds.length - 1)];
      index += 1;
      const toolCalls = (round.toolCalls ?? []).map((call, i) => ({
        id: "tc-" + index + "-" + i,
        ...call,
      }));
      return {
        content: round.content ?? null,
        toolCalls,
        reasoningContent: null,
      };
    },
  };
}

beforeAll(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "qubits-noprog-"));
  scratch.push(workspace);
});

afterEach(() => {
  delete process.env.QUIBITS_AGENT_MAX_ROUNDS;
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

/** Protocol invariant: every assistant.tool_calls batch is followed by one tool message per call id. */
function assertToolMessagesBackfilled(messages: ChatMessage[]): void {
  let pending: string[] = [];
  for (const message of messages) {
    if (
      message.role === "assistant" &&
      message.tool_calls &&
      message.tool_calls.length > 0
    ) {
      expect(pending).toHaveLength(0); // previous batch must be complete first
      pending = message.tool_calls.map((call) => call.id);
    } else if (message.role === "tool") {
      expect(pending).toContain(message.tool_call_id);
      pending = pending.filter((id) => id !== message.tool_call_id);
    }
  }
  expect(pending).toHaveLength(0);
}

describe("inspect_current_app 缓存与门控", () => {
  it("hasApp=false 时三种布尔参数只真实执行一次；第二次起 DUPLICATE_OBSERVATION；product_manager 被强制输出 ProductBrief", async () => {
    const events: AgentEvent[] = [];
    const seenInputs: Array<{
      tools: string[];
      toolChoice: ToolChoiceSpec | undefined;
      messages: ChatMessage[];
    }> = [];
    const context = makeContext("product_manager", {
      emit: (event) => events.push(event),
    });
    const provider = scriptedProvider(
      [
        {
          toolCalls: [
            {
              name: "inspect_current_app",
              rawArguments: JSON.stringify({
                includeRecords: false,
                includeSchema: true,
              }),
            },
          ],
        },
        {
          toolCalls: [
            {
              name: "inspect_current_app",
              rawArguments: JSON.stringify({
                includeRecords: true,
                includeSchema: true,
              }),
            },
          ],
        },
        {
          toolCalls: [
            {
              name: "inspect_current_app",
              rawArguments: JSON.stringify({
                includeRecords: true,
                includeSchema: false,
              }),
            },
          ],
        },
        { content: productBriefJson() },
      ],
      seenInputs,
    );
    const result = await runToolCallingAgent({
      roleId: "product_manager",
      agentRunId: "agent-noprog-000000000001",
      systemPrompt: "测试",
      taskPrompt: "产出产品简报",
      finalSchema: productBriefWithSummarySchema,
      context,
      requireToolCall: false,
      providerOverride: provider,
    });
    expect(result.status).toBe("completed");
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(3);
    expect((results[0] as { ok: boolean }).ok).toBe(true);
    expect((results[1] as { errorCode?: string }).errorCode).toBe(
      "DUPLICATE_OBSERVATION",
    );
    expect((results[2] as { errorCode?: string }).errorCode).toBe(
      "CONTROLLER_DIRECTIVE",
    );
    // After the duplicate, the Controller forced final: the model saw NO tools + tool_choice none.
    const finalRound = seenInputs[seenInputs.length - 1];
    expect(finalRound.tools).toEqual([]);
    expect(finalRound.toolChoice).toEqual({ mode: "none" });
    // The duplicate observation feedback really reached the model's next round.
    const duplicateFeedback = seenInputs.some((input) =>
      input.messages.some(
        (m) => m.role === "tool" && m.content.includes("DUPLICATE_OBSERVATION"),
      ),
    );
    expect(duplicateFeedback).toBe(true);
    // Duplicate feedback must not advise another parameter-only retry.
    const allToolText = seenInputs.flatMap((input) =>
      input.messages
        .filter((m) => m.role === "tool")
        .map((m) => m.content as string),
    );
    expect(allToolText.join("\n")).not.toContain("修改参数");
    assertToolMessagesBackfilled(seenInputs[seenInputs.length - 1].messages);
  });

  it("product_manager 被拦截后成功输出 ProductBrief（不耗尽轮次预算）", async () => {
    const events: AgentEvent[] = [];
    const seenInputs: Array<{
      tools: string[];
      toolChoice: ToolChoiceSpec | undefined;
      messages: ChatMessage[];
    }> = [];
    const context = makeContext("product_manager", {
      emit: (event) => events.push(event),
    });
    const provider = scriptedProvider(
      [
        {
          toolCalls: [
            {
              name: "inspect_current_app",
              rawArguments: JSON.stringify({
                includeRecords: false,
                includeSchema: false,
              }),
            },
          ],
        },
        {
          toolCalls: [
            {
              name: "inspect_current_app",
              rawArguments: JSON.stringify({
                includeRecords: true,
                includeSchema: false,
              }),
            },
          ],
        },
        { content: productBriefJson() },
      ],
      seenInputs,
    );
    const result = await runToolCallingAgent({
      roleId: "product_manager",
      agentRunId: "agent-noprog-000000000002",
      systemPrompt: "测试",
      taskPrompt: "产出产品简报",
      finalSchema: productBriefWithSummarySchema,
      context,
      requireToolCall: false,
      providerOverride: provider,
    });
    expect(result.status).toBe("completed");
    const results = events.filter((e) => e.type === "tool_result");
    expect((results[1] as { errorCode?: string }).errorCode).toBe(
      "DUPLICATE_OBSERVATION",
    );
    const finalRound = seenInputs[seenInputs.length - 1];
    expect(finalRound.tools).toEqual([]);
    expect(finalRound.toolChoice).toEqual({ mode: "none" });
  });

  it("team_leader 重复检查被拦截后，下一轮只允许 delegate_to_agent", async () => {
    const events: AgentEvent[] = [];
    const seenInputs: Array<{
      tools: string[];
      toolChoice: ToolChoiceSpec | undefined;
      messages: ChatMessage[];
    }> = [];
    const context = makeContext("team_leader", {
      emit: (event) => events.push(event),
    });
    const provider = scriptedProvider(
      [
        {
          toolCalls: [
            {
              name: "inspect_current_app",
              rawArguments: JSON.stringify({
                includeRecords: false,
                includeSchema: true,
              }),
            },
          ],
        },
        {
          toolCalls: [
            {
              name: "inspect_current_app",
              rawArguments: JSON.stringify({
                includeRecords: true,
                includeSchema: false,
              }),
            },
          ],
        },
        {
          toolCalls: [
            {
              name: "delegate_to_agent",
              rawArguments: JSON.stringify({
                targetRole: "product_manager",
                task: "分析需求",
                expectedOutput: "product_brief",
                inputArtifactIds: [],
              }),
            },
          ],
        },
        { content: JSON.stringify({ ok: true, summary: "完成" }) },
      ],
      seenInputs,
    );
    const result = await runToolCallingAgent({
      roleId: "team_leader",
      agentRunId: "agent-noprog-000000000003",
      systemPrompt: "测试",
      taskPrompt: "编排",
      finalSchema: ROLE_DEFINITIONS.team_leader.finalSchema,
      context,
      requireToolCall: false,
      providerOverride: provider,
    });
    // The forced round exposed exactly delegate_to_agent with a forced function choice.
    const forcedRound = seenInputs[2];
    expect(forcedRound.tools).toEqual(["delegate_to_agent"]);
    expect(forcedRound.toolChoice).toEqual({
      mode: "function",
      name: "delegate_to_agent",
    });
    expect(result.status).toBe("completed");
  });

  it("currentVersion 变化后允许重新执行 inspect_current_app（缓存按 stateVersion 失效）", async () => {
    const events: AgentEvent[] = [];
    const seenInputs: Array<{
      tools: string[];
      toolChoice: ToolChoiceSpec | undefined;
      messages: ChatMessage[];
    }> = [];
    const context = makeContext("product_manager", {
      emit: (event) => events.push(event),
      currentVersion: 1,
    });
    const provider = scriptedProvider(
      [
        {
          toolCalls: [
            {
              name: "inspect_current_app",
              rawArguments: JSON.stringify({
                includeRecords: false,
                includeSchema: false,
              }),
            },
          ],
        },
        { content: productBriefJson() },
      ],
      seenInputs,
    );
    const first = await runToolCallingAgent({
      roleId: "product_manager",
      agentRunId: "agent-noprog-000000000004a",
      systemPrompt: "测试",
      taskPrompt: "简报",
      finalSchema: productBriefWithSummarySchema,
      context,
      requireToolCall: false,
      providerOverride: provider,
    });
    expect(first.status).toBe("completed");
    // Bump the app version: the same inspection is a NEW observation.
    const contextV2 = makeContext("product_manager", {
      emit: (event) => events.push(event),
      currentVersion: 2,
    });
    const providerV2 = scriptedProvider(
      [
        {
          toolCalls: [
            {
              name: "inspect_current_app",
              rawArguments: JSON.stringify({
                includeRecords: false,
                includeSchema: false,
              }),
            },
          ],
        },
        { content: productBriefJson() },
      ],
      seenInputs,
    );
    const second = await runToolCallingAgent({
      roleId: "product_manager",
      agentRunId: "agent-noprog-000000000004b",
      systemPrompt: "测试",
      taskPrompt: "简报",
      finalSchema: productBriefWithSummarySchema,
      context: contextV2,
      requireToolCall: false,
      providerOverride: providerV2,
    });
    expect(second.status).toBe("completed");
    const okResults = events.filter(
      (e) => e.type === "tool_result" && e.ok === true,
    );
    expect(okResults).toHaveLength(2); // one real execution per app version
  });
});

describe("NO_PROGRESS：A-B-A-B 交替循环", () => {
  it("fs_read 交替读取两个文件触发 NO_PROGRESS，观察工具被禁用后 Agent 成功收敛", async () => {
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "a.txt"), "aaa");
    writeFileSync(path.join(workspace, "b.txt"), "bbb");
    const events: AgentEvent[] = [];
    const seenInputs: Array<{
      tools: string[];
      toolChoice: ToolChoiceSpec | undefined;
      messages: ChatMessage[];
    }> = [];
    const context = makeContext("engineer", {
      emit: (event) => events.push(event),
    });
    const provider = scriptedProvider(
      [
        {
          toolCalls: [
            {
              name: "fs_read",
              rawArguments: JSON.stringify({ path: "a.txt", maxBytes: 100 }),
            },
          ],
        },
        {
          toolCalls: [
            {
              name: "fs_read",
              rawArguments: JSON.stringify({ path: "b.txt", maxBytes: 100 }),
            },
          ],
        },
        {
          toolCalls: [
            {
              name: "fs_read",
              rawArguments: JSON.stringify({ path: "a.txt", maxBytes: 100 }),
            },
          ],
        },
        {
          toolCalls: [
            {
              name: "fs_read",
              rawArguments: JSON.stringify({ path: "b.txt", maxBytes: 100 }),
            },
          ],
        },
        { content: blueprintJson() },
      ],
      seenInputs,
    );
    const result = await runToolCallingAgent({
      roleId: "engineer",
      agentRunId: "agent-noprog-000000000005",
      systemPrompt: "测试",
      taskPrompt: "读取文件",
      finalSchema: appBlueprintWithSummarySchema,
      context,
      requireToolCall: false,
      providerOverride: provider,
    });
    expect(result.status).toBe("completed");
    // The A-B-A-B pattern produced a NO_PROGRESS Controller instruction for the model.
    const noProgressInstruction = seenInputs.some((input) =>
      input.messages.some(
        (m) => m.role === "user" && m.content.includes("NO_PROGRESS"),
      ),
    );
    expect(noProgressInstruction).toBe(true);
    // The final round no longer exposes the gated observation tool.
    const finalRound = seenInputs[seenInputs.length - 1];
    expect(finalRound.tools).not.toContain("fs_read");
    // Every assistant.tool_calls batch was fully backfilled with matching tool messages.
    for (const input of seenInputs)
      assertToolMessagesBackfilled(input.messages);
    // The agent converged without relying on failure budgets.
    expect(
      events.some(
        (e) => e.type === "error" && e.code === "TOOL_FAILURE_LIMIT_EXCEEDED",
      ),
    ).toBe(false);
  });

  it("动作工具不会在执行后被改写成重复观察", async () => {
    const events: AgentEvent[] = [];
    const seenInputs: Array<{
      tools: string[];
      toolChoice: ToolChoiceSpec | undefined;
      messages: ChatMessage[];
    }> = [];
    const context = makeContext("engineer", {
      emit: (event) => events.push(event),
    });
    const writeArgs = JSON.stringify({ path: "action.txt", content: "stable" });
    const provider = scriptedProvider(
      [
        { toolCalls: [{ name: "fs_write", rawArguments: writeArgs }] },
        { toolCalls: [{ name: "fs_write", rawArguments: writeArgs }] },
        { content: blueprintJson() },
      ],
      seenInputs,
    );

    const result = await runToolCallingAgent({
      roleId: "engineer",
      agentRunId: "agent-noprog-000000000006",
      systemPrompt: "测试",
      taskPrompt: "写入文件",
      finalSchema: appBlueprintWithSummarySchema,
      context,
      requireToolCall: true,
      providerOverride: provider,
    });

    expect(result.status).toBe("completed");
    const toolResults = events.filter((event) => event.type === "tool_result");
    expect(toolResults).toHaveLength(2);
    expect(
      toolResults.every((event) => event.ok && event.errorCode === undefined),
    ).toBe(true);
    expect(
      toolResults.some((event) => event.errorCode === "DUPLICATE_OBSERVATION"),
    ).toBe(false);
  });
});

describe("工程阶段收尾契约", () => {
  it("构建成功后依次补齐缺失验证，全部通过才关闭工具", async () => {
    const buildWorkspace = createEngineeringWorkspace("qubits-build-close-");
    const context = makeContext("engineer", {
      workspaceDir: buildWorkspace,
      sandbox: new FakeSandboxProvider(),
    });
    const seenInputs: Array<{
      tools: string[];
      toolChoice: ToolChoiceSpec | undefined;
      messages: ChatMessage[];
    }> = [];
    let round = 0;
    const provider: AIProvider = {
      kind: "mock",
      async generateWithTools(input): Promise<AgentTurnResponse> {
        seenInputs.push({
          tools: input.tools.map((tool) => tool.name),
          toolChoice: input.toolChoice,
          messages: input.messages.map((m) => ({ ...m })),
        });
        round += 1;
        if (round === 1) {
          return {
            content: null,
            toolCalls: [
              { id: "tc-build", name: "run_build", rawArguments: "{}" },
            ],
            reasoningContent: null,
          };
        }
        if (round === 2) {
          return {
            content: null,
            toolCalls: [
              { id: "tc-lint", name: "run_lint", rawArguments: "{}" },
            ],
            reasoningContent: null,
          };
        }
        if (round === 3) {
          return {
            content: null,
            toolCalls: [
              { id: "tc-typecheck", name: "run_typecheck", rawArguments: "{}" },
            ],
            reasoningContent: null,
          };
        }
        if (round === 4) {
          return {
            content: null,
            toolCalls: [
              { id: "tc-tests", name: "run_tests", rawArguments: "{}" },
            ],
            reasoningContent: null,
          };
        }
        if (round === 5) {
          return {
            content: null,
            toolCalls: [
              { id: "tc-scan", name: "security_scan", rawArguments: "{}" },
            ],
            reasoningContent: null,
          };
        }
        const build = context.artifacts.list("build_report").at(-1);
        return {
          content: JSON.stringify({
            summary: "代码完成",
            files: [],
            manifest: { name: "通用应用", collections: [] },
            buildStatus: "success",
            buildArtifactId: build?.id ?? null,
            notes: [],
          }),
          toolCalls: [],
          reasoningContent: null,
        };
      },
    };
    const result = await runToolCallingAgent({
      roleId: "engineer",
      agentRunId: "agent-noprog-engineer-build",
      systemPrompt: "测试",
      taskPrompt: "完成工程阶段",
      finalSchema: codeWorkspaceSchema,
      context,
      requireToolCall: true,
      providerOverride: provider,
    });
    expect(result.status).toBe("completed");
    expect(seenInputs.slice(1, 5).map((input) => input.tools)).toEqual([
      ["run_lint"],
      ["run_typecheck"],
      ["run_tests"],
      ["security_scan"],
    ]);
    expect(seenInputs.slice(1, 5).map((input) => input.toolChoice)).toEqual([
      { mode: "function", name: "run_lint" },
      { mode: "function", name: "run_typecheck" },
      { mode: "function", name: "run_tests" },
      { mode: "function", name: "security_scan" },
    ]);
    expect(seenInputs[5]?.tools).toEqual([]);
    expect(seenInputs[5]?.toolChoice).toEqual({ mode: "none" });
  });

  it("测试失败后即使构建和扫描成功也允许修改，修复后必须重新验证", async () => {
    const buildWorkspace = createEngineeringWorkspace("qubits-test-repair-");
    const sandbox = new FakeSandboxProvider();
    sandbox.results.push({
      exitCode: 1,
      stdout: "2 tests failed",
      stderr: "",
      timedOut: false,
      durationMs: 1,
    });
    const context = makeContext("engineer", {
      workspaceDir: buildWorkspace,
      sandbox,
    });
    const seenInputs: Array<{
      tools: string[];
      toolChoice: ToolChoiceSpec | undefined;
      messages: ChatMessage[];
    }> = [];
    let round = 0;
    const provider: AIProvider = {
      kind: "mock",
      async generateWithTools(input): Promise<AgentTurnResponse> {
        seenInputs.push({
          tools: input.tools.map((tool) => tool.name),
          toolChoice: input.toolChoice,
          messages: input.messages.map((m) => ({ ...m })),
        });
        round += 1;
        if (round === 1) {
          return {
            content: null,
            toolCalls: [
              { id: "tc-failed-tests", name: "run_tests", rawArguments: "{}" },
              { id: "tc-early-build", name: "run_build", rawArguments: "{}" },
              {
                id: "tc-early-scan",
                name: "security_scan",
                rawArguments: "{}",
              },
            ],
            reasoningContent: null,
          };
        }
        if (round === 2) {
          return {
            content: null,
            toolCalls: [
              {
                id: "tc-fix",
                name: "fs_patch",
                rawArguments: JSON.stringify({
                  path: "src/main.tsx",
                  oldText: '"ready"',
                  newText: '"fixed"',
                  replaceAll: false,
                }),
              },
            ],
            reasoningContent: null,
          };
        }
        if (round === 3)
          return {
            content: null,
            toolCalls: [
              { id: "tc-tests-pass", name: "run_tests", rawArguments: "{}" },
            ],
            reasoningContent: null,
          };
        if (round === 4)
          return {
            content: null,
            toolCalls: [
              { id: "tc-build-pass", name: "run_build", rawArguments: "{}" },
            ],
            reasoningContent: null,
          };
        if (round === 5)
          return {
            content: null,
            toolCalls: [
              { id: "tc-lint-pass", name: "run_lint", rawArguments: "{}" },
            ],
            reasoningContent: null,
          };
        if (round === 6)
          return {
            content: null,
            toolCalls: [
              { id: "tc-type-pass", name: "run_typecheck", rawArguments: "{}" },
            ],
            reasoningContent: null,
          };
        if (round === 7)
          return {
            content: null,
            toolCalls: [
              { id: "tc-scan-pass", name: "security_scan", rawArguments: "{}" },
            ],
            reasoningContent: null,
          };
        const build = context.artifacts.list("build_report").at(-1);
        return {
          content: JSON.stringify({
            summary: "代码完成",
            files: [],
            manifest: { name: "通用应用", collections: [] },
            buildStatus: "success",
            buildArtifactId: build?.id ?? null,
            notes: [],
          }),
          toolCalls: [],
          reasoningContent: null,
        };
      },
    };
    const result = await runToolCallingAgent({
      roleId: "engineer",
      agentRunId: "agent-noprog-engineer-repair",
      systemPrompt: "测试",
      taskPrompt: "完成工程阶段",
      finalSchema: codeWorkspaceSchema,
      context,
      requireToolCall: true,
      providerOverride: provider,
    });
    expect(result.status).toBe("completed");
    expect(seenInputs[1]?.toolChoice).toEqual({ mode: "auto" });
    expect(seenInputs[1]?.tools).toContain("fs_patch");
    expect(
      seenInputs[1]?.messages.some(
        (m) => m.role === "user" && m.content.includes("工程验证未通过"),
      ),
    ).toBe(true);
    expect(seenInputs.slice(4, 7).map((input) => input.toolChoice)).toEqual([
      { mode: "function", name: "run_lint" },
      { mode: "function", name: "run_typecheck" },
      { mode: "function", name: "security_scan" },
    ]);
    expect(seenInputs[7]?.toolChoice).toEqual({ mode: "none" });
  });

  it("工作区修改会使同批次中更早的全部验证结果失效", async () => {
    const buildWorkspace = createEngineeringWorkspace(
      "qubits-mutation-invalidates-",
    );
    const context = makeContext("engineer", {
      workspaceDir: buildWorkspace,
      sandbox: new FakeSandboxProvider(),
    });
    const seenInputs: Array<{
      tools: string[];
      toolChoice: ToolChoiceSpec | undefined;
      messages: ChatMessage[];
    }> = [];
    let round = 0;
    const provider: AIProvider = {
      kind: "mock",
      async generateWithTools(input): Promise<AgentTurnResponse> {
        seenInputs.push({
          tools: input.tools.map((tool) => tool.name),
          toolChoice: input.toolChoice,
          messages: input.messages.map((m) => ({ ...m })),
        });
        round += 1;
        if (round === 1) {
          return {
            content: null,
            toolCalls: [
              { id: "tc-lint-old", name: "run_lint", rawArguments: "{}" },
              { id: "tc-type-old", name: "run_typecheck", rawArguments: "{}" },
              { id: "tc-tests-old", name: "run_tests", rawArguments: "{}" },
              { id: "tc-build-old", name: "run_build", rawArguments: "{}" },
              { id: "tc-scan-old", name: "security_scan", rawArguments: "{}" },
              {
                id: "tc-late-patch",
                name: "fs_patch",
                rawArguments: JSON.stringify({
                  path: "src/main.tsx",
                  oldText: '"ready"',
                  newText: '"changed"',
                  replaceAll: false,
                }),
              },
            ],
            reasoningContent: null,
          };
        }
        if (round === 2)
          return {
            content: null,
            toolCalls: [
              { id: "tc-lint-new", name: "run_lint", rawArguments: "{}" },
            ],
            reasoningContent: null,
          };
        if (round === 3)
          return {
            content: null,
            toolCalls: [
              { id: "tc-type-new", name: "run_typecheck", rawArguments: "{}" },
            ],
            reasoningContent: null,
          };
        if (round === 4)
          return {
            content: null,
            toolCalls: [
              { id: "tc-tests-new", name: "run_tests", rawArguments: "{}" },
            ],
            reasoningContent: null,
          };
        if (round === 5)
          return {
            content: null,
            toolCalls: [
              { id: "tc-build-new", name: "run_build", rawArguments: "{}" },
            ],
            reasoningContent: null,
          };
        if (round === 6)
          return {
            content: null,
            toolCalls: [
              { id: "tc-scan-new", name: "security_scan", rawArguments: "{}" },
            ],
            reasoningContent: null,
          };
        const build = context.artifacts.list("build_report").at(-1);
        return {
          content: JSON.stringify({
            summary: "代码完成",
            files: [],
            manifest: { name: "通用应用", collections: [] },
            buildStatus: "success",
            buildArtifactId: build?.id ?? null,
            notes: [],
          }),
          toolCalls: [],
          reasoningContent: null,
        };
      },
    };
    const result = await runToolCallingAgent({
      roleId: "engineer",
      agentRunId: "agent-noprog-engineer-mutation",
      systemPrompt: "测试",
      taskPrompt: "完成工程阶段",
      finalSchema: codeWorkspaceSchema,
      context,
      requireToolCall: true,
      providerOverride: provider,
    });
    expect(result.status).toBe("completed");
    expect(seenInputs[1]?.tools).toEqual(["run_lint"]);
    expect(seenInputs[1]?.toolChoice).toEqual({
      mode: "function",
      name: "run_lint",
    });
    expect(seenInputs[6]?.tools).toEqual([]);
    expect(seenInputs[6]?.toolChoice).toEqual({ mode: "none" });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runToolCallingAgent } from "@/lib/ai/tool-loop";
import { appBlueprintWithSummarySchema } from "@/lib/contracts/artifacts";
import { ArtifactStore } from "@/lib/ai/artifact-store";
import type { AgentEvent } from "@/lib/contracts/agent-events";
import type { ToolExecutionContext } from "@/lib/ai/tools/types";
import type { AIProvider, AgentTurnResponse, ChatMessage } from "@/lib/ai/provider";
import { makeTaskManifest } from "./fixtures";
import { FakeSandboxProvider } from "./fakes";
import { initWorkspace } from "@/lib/workspace/workspace-manager";
import { grantApproval } from "@/lib/ai/tools/approval";

/**
 * Self-correction loop: after a failure, the role:tool result and the user correction
 * message must carry 1) the last sanitized arguments and 2) the repair hint for the
 * error code. An identical failing call is fast-rejected (REPEATED_CALL) instead of
 * retrying verbatim until the threshold. Approval failures skip the fast rejection:
 * retrying the same call after approval is legitimate.
 */

const WORKSPACE = path.join(tmpdir(), "qubits-selfcorrection-" + Date.now());

beforeAll(() => {
  mkdirSync(path.join(WORKSPACE, "src"), { recursive: true });
  writeFileSync(path.join(WORKSPACE, "src", "a.txt"), "hello qubits");
});

afterAll(() => {
  rmSync(WORKSPACE, { recursive: true, force: true });
});

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

function makeContext(events: AgentEvent[]): ToolExecutionContext {
  const runId = "run-selfcorr-" + crypto.randomUUID();
  return {
    runId,
    parentAgentRunId: "agent-mike-000000000009",
    roleId: "engineer",
    depth: 1,
    signal: new AbortController().signal,
    currentManifest: makeTaskManifest(),
    currentAppId: "test-task-app",
    currentVersion: 1,
    projectRecords: null,
    dataAdapter: null,
    artifacts: new ArtifactStore(runId),
    emit: (event) => events.push(event),
    childAgentRunner: async () => ({ status: "completed", artifactId: null, summary: "ok", issues: [] }),
    quality: { buildPassed: false, testsPassed: false, securityScanPassed: false },
    previewCommitted: false,
    workspaceDir: WORKSPACE,
    workspaceReady: true,
    sandbox: null,
    approvedTools: new Set<string>(),
    counters: { toolCalls: 0, childAgents: 0 },
  };
}

const ABS_CALL = { id: "tc-abs", name: "fs_read", rawArguments: JSON.stringify({ path: "/etc/hosts", maxBytes: 4096 }) };

/** Returns the same tool call every turn (fresh call id per turn) to exercise repeat-call handling. */
function repeatingProvider(seen: ChatMessage[][], call: { id: string; name: string; rawArguments: string }): AIProvider {
  return {
    kind: "mock",
    async generateWithTools(input): Promise<AgentTurnResponse> {
      // Snapshot this turn's messages (the loop appends to the same array in place, so copy).
      seen.push([...input.messages]);
      return {
        content: null,
        toolCalls: [{ ...call, id: call.id + "-" + Math.random().toString(36).slice(2, 6) }],
        reasoningContent: null,
      };
    },  };
}

function errorCodes(events: AgentEvent[]): (string | undefined)[] {
  return events
    .filter((e) => e.type === "tool_result")
    .map((e) => (e as { errorCode?: string }).errorCode);
}

describe("工具失败后的自我纠错", () => {
  it("模型收到完整诊断，同时 UI 工具事件保持短摘要", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "qubits-long-diagnostic-"));
    const events: AgentEvent[] = [];
    const seen: ChatMessage[][] = [];
    const sandbox = new FakeSandboxProvider();
    const marker = "ACTIONABLE_DIAGNOSTIC_AT_END";
    sandbox.defaultResult = {
      exitCode: 1,
      stdout: "lint failure\n" + "x".repeat(700) + "\n" + marker,
      stderr: "",
      timedOut: false,
      durationMs: 1,
    };
    initWorkspace(workspaceDir, { taskId: "long-diagnostic" });
    const context = { ...makeContext(events), workspaceDir, sandbox };
    let round = 0;
    const provider: AIProvider = {
      kind: "mock",
      async generateWithTools(input): Promise<AgentTurnResponse> {
        seen.push([...input.messages]);
        round += 1;
        if (round === 1) {
          return {
            content: null,
            toolCalls: [{ id: "tc-long-lint", name: "run_lint", rawArguments: "{}" }],
            reasoningContent: null,
          };
        }
        return { content: blueprintJson(), toolCalls: [], reasoningContent: null };
      },
    };

    try {
      const result = await runToolCallingAgent({
        roleId: "engineer",
        agentRunId: "agent-selfcorr-long-diagnostic",
        systemPrompt: "测试",
        taskPrompt: "运行检查并根据完整错误修复",
        finalSchema: appBlueprintWithSummarySchema,
        context,
        requireToolCall: true,
        providerOverride: provider,
      });
      expect(result.status).toBe("completed");
      const event = events.find((item) => item.type === "tool_result");
      expect(event?.type).toBe("tool_result");
      if (event?.type === "tool_result") {
        expect(event.resultSummary.length).toBeLessThanOrEqual(300);
        expect(event.resultSummary).not.toContain(marker);
      }
      const toolMessage = seen[1]?.find((message) => message.role === "tool");
      expect(toolMessage?.content.length).toBeGreaterThan(300);
      expect(toolMessage?.content).toContain(marker);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("绝对路径失败：纠错消息包含违规参数与相对路径建议，原样重试被 REPEATED_FAILED_CALL 拦截", async () => {
    process.env.QUIBITS_MAX_TOOL_FAILURES = "2";
    const events: AgentEvent[] = [];
    const seen: ChatMessage[][] = [];
    const context = makeContext(events);
    await expect(
      runToolCallingAgent({
        roleId: "engineer",
        agentRunId: "agent-selfcorr-a",
        systemPrompt: "测试",
        taskPrompt: "读取 /etc/hosts",
        finalSchema: appBlueprintWithSummarySchema,
        context,
        requireToolCall: true,
        providerOverride: repeatingProvider(seen, ABS_CALL),
      })
    ).rejects.toThrowError(/连续失败 3 次/);
    // First real execution reports PATH_ESCAPE; verbatim retries are skipped as REPEATED_FAILED_CALL (never re-executed).
    expect(errorCodes(events)).toEqual(["PATH_ESCAPE", "REPEATED_FAILED_CALL", "REPEATED_FAILED_CALL"]);
    // The first retry round's role:tool result (last tool message of the third request) carries REPEATED_FAILED_CALL.
    const third = seen[2] ?? [];
    const toolMsgs = third.filter((m) => m.role === "tool") as { content: string }[];
    const toolMsg = toolMsgs[toolMsgs.length - 1];
    expect(toolMsg?.content).toContain("REPEATED_FAILED_CALL");
    expect(toolMsg?.content).toContain("修复参数");
    const second = seen[1] ?? [];
    const userMsgs = second.filter((m) => m.role === "user" && typeof m.content === "string") as { content: string }[];
    const correction = userMsgs[userMsgs.length - 1].content;
    expect(correction).toContain("fs_read");
    expect(correction).toContain("/etc/hosts");
    expect(correction).toContain("相对路径");
    // TOOL_FAILURE_LIMIT_EXCEEDED error event is emitted before giving up.
    expect(events.some((e) => e.type === "error" && e.code === "TOOL_FAILURE_LIMIT_EXCEEDED")).toBe(true);
  });

  it("高风险工具会等待数据库审批后再执行", async () => {
    const events: AgentEvent[] = [];
    const seen: ChatMessage[][] = [];
    const context = makeContext(events);
    writeFileSync(path.join(WORKSPACE, "src", "a.txt"), "hello qubits");
    context.emit = (event) => {
      events.push(event);
      if (event.type === "approval_requested") {
        setTimeout(() => { grantApproval(event.approvalId); }, 20);
      }
    };
    let round = 0;
    const result = await runToolCallingAgent({
      roleId: "engineer",
      agentRunId: "agent-selfcorr-b",
      systemPrompt: "测试",
      taskPrompt: "删除文件",
      finalSchema: appBlueprintWithSummarySchema,
      context,
      requireToolCall: true,
      providerOverride: {
        kind: "mock",
        async generateWithTools(input) {
          seen.push([...input.messages]);
          round += 1;
          if (round === 1) return { content: null, toolCalls: [{ id: "tc-del", name: "fs_delete", rawArguments: JSON.stringify({ path: "src/a.txt", soft: true }) }], reasoningContent: null };
          return { content: blueprintJson(), toolCalls: [], reasoningContent: null };
        },
      },
    });
    expect(result.status).toBe("completed");
    expect(events.some((event) => event.type === "approval_requested")).toBe(true);
    expect(events.some((event) => event.type === "tool_result" && event.toolName === "fs_delete" && event.ok)).toBe(true);
    writeFileSync(path.join(WORKSPACE, "src", "a.txt"), "hello qubits");
  });

  it("失败历史跨成功保留：间隔成功后相同失败调用不再真实执行（REPEATED_FAILED_CALL）", async () => {
    process.env.QUIBITS_MAX_TOOL_FAILURES = "4";
    const events: AgentEvent[] = [];
    const seen: ChatMessage[][] = [];
    const context = makeContext(events);
    let round = 0;
    const provider: AIProvider = {
      kind: "mock",
      async generateWithTools(input): Promise<AgentTurnResponse> {
        seen.push([...input.messages]);
        round += 1;
        if (round === 1) return { content: null, toolCalls: [{ ...ABS_CALL, id: "tc-1" }], reasoningContent: null };
        if (round === 2) {
          return {
            content: null,
            toolCalls: [{ id: "tc-2", name: "fs_read", rawArguments: JSON.stringify({ path: "src/a.txt", maxBytes: 4096 }) }],
            reasoningContent: null,
          };
        }
        if (round === 3) return { content: null, toolCalls: [{ ...ABS_CALL, id: "tc-3" }], reasoningContent: null };
        return {
          content: blueprintJson(),
          toolCalls: [],
          reasoningContent: null,
        };
      },
    };
    const result = await runToolCallingAgent({
      roleId: "engineer",
      agentRunId: "agent-selfcorr-c",
      systemPrompt: "测试",
      taskPrompt: "读取文件",
      finalSchema: appBlueprintWithSummarySchema,
      context,
      requireToolCall: true,
      providerOverride: provider,
    });
    expect(result.status).toBe("completed");
    const results = events.filter((e) => e.type === "tool_result");
    // Round 1: real PATH_ESCAPE execution; round 2: real success; round 3: the identical
    // failure is not re-executed because bounded history survives the success.
    expect(results).toHaveLength(3);
    expect((results[0] as { errorCode?: string }).errorCode).toBe("PATH_ESCAPE");
    expect((results[1] as { errorCode?: string }).errorCode).toBeUndefined();
    expect((results[2] as { errorCode?: string }).errorCode).toBe("REPEATED_FAILED_CALL");
    // The successful read was real and its summary is the human-readable form.
    expect((results[1] as { resultSummary: string }).resultSummary).toContain("读取 src/a.txt");
    // Verify the read really happened at the filesystem level.
    expect(readFileSync(path.join(WORKSPACE, "src", "a.txt"), "utf8")).toContain("hello qubits");
  }, 30000);

  it("状态变更后允许重试先前失败的相同观察", async () => {
    const events: AgentEvent[] = [];
    const context = makeContext(events);
    const target = "src/recovered.txt";
    let round = 0;
    const provider: AIProvider = {
      kind: "mock",
      async generateWithTools(): Promise<AgentTurnResponse> {
        round += 1;
        if (round === 1 || round === 3) {
          return {
            content: null,
            toolCalls: [{ id: "tc-read-" + round, name: "fs_read", rawArguments: JSON.stringify({ path: target, maxBytes: 4096 }) }],
            reasoningContent: null,
          };
        }
        if (round === 2) {
          return {
            content: null,
            toolCalls: [{ id: "tc-write", name: "fs_write", rawArguments: JSON.stringify({ path: target, content: "recovered" }) }],
            reasoningContent: null,
          };
        }
        return { content: blueprintJson(), toolCalls: [], reasoningContent: null };
      },
    };

    const result = await runToolCallingAgent({
      roleId: "engineer",
      agentRunId: "agent-selfcorr-d",
      systemPrompt: "测试",
      taskPrompt: "修复缺失文件",
      finalSchema: appBlueprintWithSummarySchema,
      context,
      requireToolCall: true,
      providerOverride: provider,
    });

    expect(result.status).toBe("completed");
    expect(errorCodes(events)).toEqual(["NOT_FOUND", undefined, undefined]);
    expect(readFileSync(path.join(WORKSPACE, target), "utf8")).toBe("recovered");
  });
});

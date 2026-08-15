import { describe, expect, it } from "vitest";
import { agentEventSchema } from "@/lib/contracts/agent-events";

/**
 * Regression: real gateways may return non "tc-" tool call ids (call_xxx / toolu_xxx /
 * raw uuids). The client event parser must accept them or live tool cards get silently
 * dropped until the post-task refresh.
 */

describe("agentEventSchema 对真实网关 id 的兼容", () => {
  it("接受 OpenAI 风格 call_xxx 工具调用 id 的 tool_call_started / tool_result", () => {
    const started = agentEventSchema.safeParse({
      type: "tool_call_started",
      toolCallId: "call_9f8c2b1a4d5e6f70",
      agentRunId: "agent-91b5bb3a-6e45-4d53-86b7-a293e0ee6c78",
      roleId: "engineer",
      toolName: "fs_read",
      inputSummary: "path=/etc/hosts",
    });
    expect(started.success).toBe(true);
    const result = agentEventSchema.safeParse({
      type: "tool_result",
      toolCallId: "call_9f8c2b1a4d5e6f70",
      agentRunId: "agent-91b5bb3a-6e45-4d53-86b7-a293e0ee6c78",
      roleId: "engineer",
      toolName: "fs_read",
      ok: false,
      resultSummary: "拒绝绝对路径",
      errorCode: "PATH_ESCAPE",
      durationMs: 12,
    });
    expect(result.success).toBe(true);
  });

  it("接受 toolu_ 前缀与纯 uuid 的 artifact / delegation id", () => {
    const preview = agentEventSchema.safeParse({
      type: "preview_requested",
      toolCallId: "toolu_bdrk_01AbCdEfGhIj",
      artifactId: "c3e5f7a9-2b4d-4f6a-8c0e-1a2b3c4d5e6f",
    });
    expect(preview.success).toBe(true);
    const delegated = agentEventSchema.safeParse({
      type: "agent_delegated",
      delegationId: "dlg-11111111-2222-3333-4444-555555555555",
      parentAgentRunId: "agent-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      childAgentRunId: "agent-run-12345",
      targetRole: "engineer",
      taskSummary: "生成 AppSpec",
    });
    expect(delegated.success).toBe(true);
  });

  it("拒绝缺少必填字段或非法 type 的事件（仍保持基本校验）", () => {
    expect(agentEventSchema.safeParse({ type: "tool_call_started", agentRunId: "x", roleId: "engineer", toolName: "fs_read" }).success).toBe(false);
    expect(agentEventSchema.safeParse({ type: "not_an_event" }).success).toBe(false);
  });

  it("只接受安全阶段摘要，不接受原始 reasoning 增量", () => {
    expect(agentEventSchema.safeParse({
      type: "progress_summary",
      agentRunId: "agent-progress",
      roleId: "engineer",
      phase: "validating",
      summary: "类型检查已完成，正在运行测试。",
    }).success).toBe(true);
    expect(agentEventSchema.safeParse({
      type: "reasoning_delta",
      agentRunId: "agent-progress",
      roleId: "engineer",
      delta: "raw reasoning",
    }).success).toBe(false);
  });
});

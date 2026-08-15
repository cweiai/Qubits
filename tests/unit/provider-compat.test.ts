import { describe, expect, it } from "vitest";
import {
  assertValidToolMessageSequence,
  buildChatMessages,
  buildToolRequestFields,
  parseProviderToolCalls,
  ToolMessageProtocolError,
} from "@/lib/ai/openai-provider";
import type { ChatMessage } from "@/lib/ai/provider";

function validToolRound(): ChatMessage[] {
  return [
    { role: "user", content: "需求" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "tc-1", name: "inspect_current_app", rawArguments: "{}" },
        { id: "tc-2", name: "search_references", rawArguments: "{\"query\":\"dashboard\"}" },
      ],
    },
    { role: "tool", tool_call_id: "tc-1", content: "{\"hasApp\":false}" },
    { role: "tool", tool_call_id: "tc-2", content: "{\"results\":[]}" },
    { role: "user", content: "继续" },
  ];
}

describe("OpenAI Tool Calling 消息协议", () => {
  it("控制器只发送兼容的工具字段，final-only 轮次省略空 tools", () => {
    const tool = { name: "inspect_current_app", description: "inspect", parameters: { type: "object" } };
    const base = {
      system: "sys",
      messages: [{ role: "user" as const, content: "hello" }],
      tools: [tool],
      roleId: "team_leader" as const,
    };

    expect(buildToolRequestFields({ ...base, tools: [], toolChoice: { mode: "none" } })).toEqual({});
    expect(buildToolRequestFields({ ...base, toolChoice: { mode: "auto" } })).toEqual({
      tools: [{ type: "function", function: tool }],
      tool_choice: "auto",
    });
    expect(buildToolRequestFields({ ...base, toolChoice: { mode: "function", name: tool.name } })).toEqual({
      tools: [{ type: "function", function: tool }],
      tool_choice: "auto",
    });
    expect(() => buildToolRequestFields({ ...base, toolChoice: { mode: "function", name: "missing" } }))
      .toThrowError(ToolMessageProtocolError);
  });

  it("标准模式输出完整的 type:function，并保留连续的一对一 tool 结果", () => {
    const out = buildChatMessages("sys", validToolRound(), false);
    expect(out[0]).toEqual({ role: "system", content: "sys" });
    const assistant = out[2] as {
      tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    };
    expect(assistant.tool_calls).toEqual([
      {
        id: "tc-1",
        type: "function",
        function: { name: "inspect_current_app", arguments: "{}" },
      },
      {
        id: "tc-2",
        type: "function",
        function: { name: "search_references", arguments: "{\"query\":\"dashboard\"}" },
      },
    ]);
    expect(out.slice(3, 5)).toEqual([
      { role: "tool", tool_call_id: "tc-1", content: "{\"hasApp\":false}" },
      { role: "tool", tool_call_id: "tc-2", content: "{\"results\":[]}" },
    ]);
  });

  it("legacy-text 模式同时移除 assistant.tool_calls 和 role:tool，不产生孤立调用", () => {
    const out = buildChatMessages("sys", validToolRound(), true);
    const assistant = out[2] as { role: string; content: string; tool_calls?: unknown };
    expect(assistant.tool_calls).toBeUndefined();
    expect(assistant.content).toContain("Tool calls executed");
    expect(out.some((message) => message.role === "tool")).toBe(false);
    expect((out[3] as { content: string }).content).toContain("Tool result tool_call_id=tc-1");
    expect((out[4] as { content: string }).content).toContain("Tool result tool_call_id=tc-2");
  });

  it("发送前拒绝缺失、插队、错配和重复的 tool 结果", () => {
    const assistant: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "tc-1", name: "a", rawArguments: "{}" },
        { id: "tc-2", name: "b", rawArguments: "{}" },
      ],
    };
    expect(() => assertValidToolMessageSequence([assistant, { role: "tool", tool_call_id: "tc-1", content: "{}" }]))
      .toThrowError(/缺少 1 个/);
    expect(() => assertValidToolMessageSequence([
      assistant,
      { role: "tool", tool_call_id: "tc-1", content: "{}" },
      { role: "user", content: "插队" },
      { role: "tool", tool_call_id: "tc-2", content: "{}" },
    ])).toThrowError(/必须是 role:\"tool\"/);
    expect(() => assertValidToolMessageSequence([
      assistant,
      { role: "tool", tool_call_id: "wrong", content: "{}" },
    ])).toThrowError(/无法匹配/);
    expect(() => assertValidToolMessageSequence([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "same", name: "a", rawArguments: "{}" },
          { id: "same", name: "b", rawArguments: "{}" },
        ],
      },
    ])).toThrowError(/重复/);
  });

  it("归一化供应商响应：空 id 生成稳定可回填 id，重复 id 显式失败", () => {
    const parsed = parseProviderToolCalls([
      { type: "function", id: "", function: { name: "inspect_current_app", arguments: "{}" } },
    ]);
    expect(parsed[0].id).toMatch(/^tc-/);
    expect(parsed[0]).toMatchObject({ name: "inspect_current_app", rawArguments: "{}" });

    expect(() => parseProviderToolCalls([
      { type: "function", id: "tc-1", function: { name: "a", arguments: "{}" } },
      { type: "function", id: "tc-1", function: { name: "b", arguments: "{}" } },
    ])).toThrowError(ToolMessageProtocolError);
  });
});

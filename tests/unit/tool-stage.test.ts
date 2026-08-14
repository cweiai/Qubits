import { describe, expect, it } from "vitest";
import {
  activeToolStage,
  groupToolEvents,
  toolEventStage,
  TOOL_STAGE_LABELS,
  TOOL_STAGE_ORDER,
  type ToolEventView,
} from "@/lib/workspace/message-view";

/**
 * Tool-card stage grouping: each event maps to a stable pipeline stage; groups keep
 * pipeline order and every stage has a readable label.
 */

function event(roleId: ToolEventView["roleId"], toolName: string): Pick<ToolEventView, "roleId" | "toolName"> {
  return { roleId, toolName };
}

describe("toolEventStage 阶段映射", () => {
  it("迈克的委派/搜索属于规划；render_preview/complete_run 属于预览提交", () => {
    expect(toolEventStage(event("team_leader", "delegate_to_agent"))).toBe("planning");
    expect(toolEventStage(event("team_leader", "search_references"))).toBe("planning");
    expect(toolEventStage(event("team_leader", "render_preview"))).toBe("previewing");
    expect(toolEventStage(event("team_leader", "complete_run"))).toBe("previewing");
  });

  it("鲍勃属于架构设计；艾玛/大卫/艾瑞斯属于规划", () => {
    expect(toolEventStage(event("architect", "workspace_get_manifest"))).toBe("architecting");
    expect(toolEventStage(event("product_manager", "inspect_current_app"))).toBe("planning");
    expect(toolEventStage(event("data_scientist", "query_records"))).toBe("planning");
    expect(toolEventStage(event("researcher", "search_references"))).toBe("planning");
  });

  it("亚历克斯的写文件属于编写代码；lint/typecheck/tests/build 属于构建验证", () => {
    expect(toolEventStage(event("engineer", "fs_write"))).toBe("coding");
    expect(toolEventStage(event("engineer", "workspace_init"))).toBe("coding");
    expect(toolEventStage(event("engineer", "dependency_add"))).toBe("coding");
    expect(toolEventStage(event("engineer", "run_lint"))).toBe("validating");
    expect(toolEventStage(event("engineer", "run_typecheck"))).toBe("validating");
    expect(toolEventStage(event("engineer", "run_tests"))).toBe("validating");
    expect(toolEventStage(event("engineer", "run_build"))).toBe("validating");
    expect(toolEventStage(event("engineer", "get_build_errors"))).toBe("validating");
  });

  it("Reviewer 的工具属于安全评审（含复跑的检查）", () => {
    expect(toolEventStage(event("reviewer", "security_scan"))).toBe("reviewing");
    expect(toolEventStage(event("reviewer", "run_lint"))).toBe("reviewing");
    expect(toolEventStage(event("reviewer", "fs_read"))).toBe("reviewing");
  });
});

describe("groupToolEvents 分组", () => {
  const makeEvent = (roleId: ToolEventView["roleId"], toolName: string, at: number): ToolEventView => ({
    toolCallId: "tc-" + toolName,
    agentRunId: "agent-1",
    roleId,
    toolName,
    status: "success",
    inputSummary: "",
    resultSummary: "",
    errorCode: null,
    timestamp: at,
  });

  it("按阶段分组并保持流水线顺序；没有事件的阶段不出现", () => {
    const groups = groupToolEvents([
      makeEvent("team_leader", "delegate_to_agent", 1),
      makeEvent("engineer", "fs_write", 2),
      makeEvent("engineer", "run_build", 3),
      makeEvent("reviewer", "security_scan", 4),
      makeEvent("team_leader", "render_preview", 5),
      makeEvent("team_leader", "complete_run", 6),
    ]);
    expect(groups.map((g) => g.stage)).toEqual(["planning", "coding", "validating", "reviewing", "previewing"]);
    expect(groups.map((g) => g.events.length)).toEqual([1, 1, 1, 1, 2]);
  });

  it("每个阶段都有标签与固定顺序", () => {
    expect(TOOL_STAGE_ORDER.length).toBe(6);
    for (const stage of TOOL_STAGE_ORDER) {
      expect(TOOL_STAGE_LABELS[stage]).toBeTruthy();
    }
  });
});

describe("activeToolStage 活动阶段", () => {
  it("运行中的流水线阶段映射到折叠块；非工具阶段返回 null", () => {
    expect(activeToolStage("coding")).toBe("coding");
    expect(activeToolStage("validating")).toBe("validating");
    expect(activeToolStage("ready")).toBeNull();
    expect(activeToolStage("idle")).toBeNull();
    expect(activeToolStage(undefined)).toBeNull();
  });
});

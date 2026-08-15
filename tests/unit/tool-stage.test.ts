import { describe, expect, it } from "vitest";
import {
  activeToolStage,
  groupToolEvents,
  stageGroupStatus,
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

  it("艾玛的工具属于规划", () => {
    expect(toolEventStage(event("product_manager", "inspect_current_app"))).toBe("planning");
  });

  it("亚历克斯的写文件属于编写代码；lint/typecheck/tests/build 属于构建验证", () => {
    expect(toolEventStage(event("engineer", "fs_write"))).toBe("coding");
    expect(toolEventStage(event("engineer", "workspace_init"))).toBe("coding");
    expect(toolEventStage(event("engineer", "dependency_add"))).toBe("coding");
    expect(toolEventStage(event("engineer", "run_lint"))).toBe("validating");
    expect(toolEventStage(event("engineer", "run_typecheck"))).toBe("validating");
    expect(toolEventStage(event("engineer", "run_tests"))).toBe("validating");
    expect(toolEventStage(event("engineer", "run_build"))).toBe("validating");
    expect(toolEventStage(event("engineer", "security_scan"))).toBe("validating");
    expect(toolEventStage(event("engineer", "get_build_errors"))).toBe("validating");
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
      makeEvent("engineer", "security_scan", 4),
      makeEvent("team_leader", "render_preview", 5),
      makeEvent("team_leader", "complete_run", 6),
    ]);
    expect(groups.map((g) => g.stage)).toEqual(["planning", "coding", "validating", "previewing"]);
    expect(groups.map((g) => g.events.length)).toEqual([1, 1, 2, 2]);
  });

  it("每个阶段都有标签与固定顺序", () => {
    expect(TOOL_STAGE_ORDER.length).toBe(4);
    for (const stage of TOOL_STAGE_ORDER) {
      expect(TOOL_STAGE_LABELS[stage]).toBeTruthy();
    }
  });
});

describe("stageGroupStatus 块状态", () => {
  const makeEvent = (status: ToolEventView["status"]): ToolEventView => ({
    toolCallId: "tc-" + status,
    agentRunId: "agent-1",
    roleId: "engineer",
    toolName: "fs_write",
    status,
    inputSummary: "",
    resultSummary: "",
    errorCode: null,
    timestamp: 1,
  });

  it("活动阶段永远是 running——即使块内工具调用已全部 success", () => {
    expect(stageGroupStatus([makeEvent("success"), makeEvent("success")], true)).toBe("running");
  });

  it("非活动阶段按工具状态聚合：failed > running > success", () => {
    expect(stageGroupStatus([makeEvent("success"), makeEvent("failed")], false)).toBe("failed");
    expect(stageGroupStatus([makeEvent("success"), makeEvent("running")], false)).toBe("running");
    expect(stageGroupStatus([makeEvent("success")], false)).toBe("success");
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

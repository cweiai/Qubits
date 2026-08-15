import { describe, expect, it } from "vitest";
import {
  activeToolStage,
  buildStageProgress,
  groupToolEvents,
  sanitizeStageProgressText,
  stageGroupStatus,
  taskToView,
  toolEventStage,
  TOOL_STAGE_LABELS,
  TOOL_STAGE_ORDER,
  type AgentRunView,
  type TaskView,
  type ToolEventView,
} from "@/lib/workspace/message-view";
import type { TaskJson } from "@/lib/workspace/api";

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

describe("buildStageProgress 阶段进度摘要", () => {
  function run(roleId: AgentRunView["roleId"], agentRunId: string, progress: AgentRunView["progressSummaries"]): AgentRunView {
    return {
      agentRunId,
      roleId,
      parentAgentRunId: null,
      status: "completed",
      taskSummary: "",
      summary: null,
      artifactId: null,
      errorMessage: null,
      timestamp: 1,
      progressSummaries: progress,
    };
  }

  function task(overrides: Partial<Pick<TaskView, "agentRuns" | "error" | "stage" | "status" | "toolEvents">>): Pick<TaskView, "agentRuns" | "error" | "stage" | "status" | "toolEvents"> {
    return {
      agentRuns: [],
      error: null,
      stage: "planning",
      status: "running",
      toolEvents: [],
      ...overrides,
    };
  }

  it("运行中的任务按阶段给出 pending/running/completed，并展示各阶段最新摘要", () => {
    const rows = buildStageProgress(task({
      stage: "coding",
      agentRuns: [
        run("team_leader", "agent-mike", [{ phase: "planning", summary: "需求已确认，开始分工。", timestamp: 1 }]),
        run("engineer", "agent-alex", [{ phase: "coding", summary: "正在写入应用组件。", timestamp: 2 }]),
      ],
    }));
    expect(rows.map((row) => row.status)).toEqual(["completed", "running", "pending", "pending"]);
    expect(rows[0].summary).toBe("需求已确认，开始分工。");
    expect(rows[1].summary).toBe("正在写入应用组件。");
    expect(rows[2].summary).toBeNull();
  });

  it("ready 任务全部完成；failed 任务标记最后一个失败阶段", () => {
    const ready = buildStageProgress(task({ status: "ready", stage: "ready" }));
    expect(ready.map((row) => row.status)).toEqual(["completed", "completed", "completed", "completed"]);

    const failed = buildStageProgress(task({
      status: "failed",
      stage: "failed",
      toolEvents: [
        { toolCallId: "tc-1", agentRunId: "agent-alex", roleId: "engineer", toolName: "run_build", status: "failed", inputSummary: "", resultSummary: "构建失败", errorCode: "BUILD_FAILED", timestamp: 3 },
      ],
    }));
    expect(failed.map((row) => row.status)).toEqual(["completed", "completed", "failed", "pending"]);
  });

  it("同一阶段的多个摘要按时间保留最新的一条", () => {
    const rows = buildStageProgress(task({
      stage: "planning",
      agentRuns: [
        run("team_leader", "agent-mike", [
          { phase: "planning", summary: "初步理解需求。", timestamp: 1 },
          { phase: "planning", summary: "需求与分工已确认。", timestamp: 2 },
        ]),
      ],
    }));
    expect(rows[0].summary).toBe("需求与分工已确认。");
    expect(rows[0].entries).toHaveLength(2);
  });

  it("sanitizeStageProgressText 拆包 JSON 摘要并拒绝结构化文本", () => {
    expect(
      sanitizeStageProgressText('{"summary":"阶段引擎已完成核心工程落地。","files":[{"path":"a.ts"}]}')
    ).toBe("阶段引擎已完成核心工程落地。");
    expect(
      sanitizeStageProgressText('{"summary":"阶段引擎已完成核心工程落地。","files":[{"path":"a.ts"')
    ).toBe("阶段引擎已完成核心工程落地。");
    expect(sanitizeStageProgressText('{"files":[{"path":"a.ts"}]}')).toBeNull();
    expect(sanitizeStageProgressText('[{"summary":"数组"}]')).toBeNull();
    expect(sanitizeStageProgressText("正在修复交互并准备运行测试。")).toBe("正在修复交互并准备运行测试。");
  });

  it("taskToView 解析服务端持久化的 agentRuns.progress 摘要", () => {
    const json: TaskJson = {
      id: "task-progress",
      conversationId: "conv-progress",
      prompt: "test",
      status: "ready",
      stage: "ready",
      roles: {},
      agentRuns: [
        {
          agentRunId: "agent-mike",
          roleId: "team_leader",
          parentAgentRunId: null,
          status: "completed",
          taskSummary: "",
          at: 1,
          progress: [
            { phase: "planning", summary: "需求已确认。", at: 1 },
            { phase: "previewing", summary: '{"summary":"预览已提交。","files":[{"path":"a.ts"', at: 6 },
          ],
        },
      ],
      toolEvents: [],
      errorCode: null,
      errorMessage: null,
      createdAt: 1,
      updatedAt: 2,
    };
    const view = taskToView(json);
    expect(view.agentRuns[0].progressSummaries).toEqual([
      { phase: "planning", summary: "需求已确认。", timestamp: 1 },
      { phase: "previewing", summary: "预览已提交。", timestamp: 6 },
    ]);
    expect(buildStageProgress(view).map((row) => row.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { buildResumeContext, type ResumeSource } from "@/lib/ai/resume-context";

/**
 * Retry context: compresses the previous attempt's failures and completed work into
 * a short brief so the run continues from the failure point.
 */

const BASE: ResumeSource = {
  attempts: 0,
  errorCode: null,
  errorMessage: null,
  agentRuns: [],
  toolEvents: [],
};

describe("buildResumeContext", () => {
  it("首次运行（attempts=0）不注入续跑上下文", () => {
    expect(buildResumeContext(BASE)).toBeNull();
  });

  it("重试时包含失败原因、已完成角色与失败步骤，并要求从失败处继续", () => {
    const context = buildResumeContext({
      ...BASE,
      attempts: 2,
      errorCode: "TOOL_FAILURE_LIMIT_EXCEEDED",
      errorMessage: "工具调用连续失败 3 次（阈值 3），已停止执行",
      agentRuns: [
        { roleId: "product_manager", status: "completed", summary: "需求已梳理", artifactId: "art-1" },
        { roleId: "engineer", status: "failed", errorMessage: "拒绝绝对路径：/etc/hosts" },
      ],
      toolEvents: [
        { toolName: "fs_read", status: "failed", errorCode: "PATH_ESCAPE", resultSummary: "拒绝绝对路径" },
      ],
    });
    expect(context).not.toBeNull();
    const text = context as string;
    expect(text).toContain("续跑第 2 次");
    expect(text).toContain("从失败的那一步继续");
    expect(text).toContain("[TOOL_FAILURE_LIMIT_EXCEEDED]");
    expect(text).toContain("product_manager");
    expect(text).toContain("art-1");
    expect(text).toContain("engineer");
    expect(text).toContain("fs_read");
    expect(text).toContain("PATH_ESCAPE");
    expect(text).toContain("重复整个流程");
  });

  it("空历史也能给出基本续跑指令", () => {
    const context = buildResumeContext({ ...BASE, attempts: 1 });
    expect(context).not.toBeNull();
    expect(context).toContain("续跑第 1 次");
    expect(context).toContain("fs_list");
  });
});

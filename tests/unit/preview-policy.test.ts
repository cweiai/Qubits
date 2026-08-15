import { describe, expect, it } from "vitest";
import {
  INITIAL_PREVIEW_POLICY,
  reducePreviewPolicy,
  type PreviewPolicyState,
} from "@/lib/workspace/preview-policy";

describe("Preview 自动展开策略", () => {
  it("生成成功后自动展开一次（幂等）", () => {
    let state: PreviewPolicyState = { ...INITIAL_PREVIEW_POLICY, mode: "collapsed" };
    state = reducePreviewPolicy(state, { type: "build_succeeded", taskId: "t1" });
    expect(state.mode).toBe("expanded");
    // Repeated events for the same task do not transition again.
    state = reducePreviewPolicy(state, { type: "build_succeeded", taskId: "t1" });
    expect(state.mode).toBe("expanded");
    expect(state.autoExpandedForTaskId).toBe("t1");
  });

  it("用户在任务进行中手动折叠后，该任务的成功不再自动展开", () => {
    let state: PreviewPolicyState = INITIAL_PREVIEW_POLICY;
    state = reducePreviewPolicy(state, { type: "user_collapsed", taskId: "t1" });
    expect(state.mode).toBe("collapsed");
    state = reducePreviewPolicy(state, { type: "build_succeeded", taskId: "t1" });
    expect(state.mode).toBe("collapsed");
    // A new task's success after the previous task ends can auto-expand again.
    state = reducePreviewPolicy(state, { type: "build_succeeded", taskId: "t2" });
    expect(state.mode).toBe("expanded");
  });

  it("任务开始前折叠：首次生成的 build_started 不展开", () => {
    let state: PreviewPolicyState = { ...INITIAL_PREVIEW_POLICY, mode: "collapsed", collapsedBeforeTask: true };
    state = reducePreviewPolicy(state, { type: "build_started", taskId: "t1", firstGeneration: true });
    expect(state.mode).toBe("collapsed");
  });

  it("用户明确请求（查看预览）总是展开并清除抑制", () => {
    let state: PreviewPolicyState = INITIAL_PREVIEW_POLICY;
    state = reducePreviewPolicy(state, { type: "user_collapsed", taskId: "t1" });
    state = reducePreviewPolicy(state, { type: "user_requested" });
    expect(state.mode).toBe("expanded");
    state = reducePreviewPolicy(state, { type: "build_succeeded", taskId: "t1" });
    expect(state.mode).toBe("expanded");
  });

  it("恢复偏好：保存的折叠偏好优先；无偏好时默认展开", () => {
    const collapsed = reducePreviewPolicy(INITIAL_PREVIEW_POLICY, {
      type: "restore_prefs",
      saved: "collapsed",
    });
    expect(collapsed.mode).toBe("collapsed");
    const expanded = reducePreviewPolicy(INITIAL_PREVIEW_POLICY, {
      type: "restore_prefs",
      saved: null,
    });
    expect(expanded.mode).toBe("expanded");
  });
});

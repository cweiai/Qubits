/**
 * Preview auto-expand policy: a centralized, testable pure state machine.
 * The component layer only dispatches events in; setOpen(true) is never scattered across call sites.
 *
 * Rules:
 * - build_succeeded auto-expands once, idempotently;
 * - user manually collapses while a task is running → that task's later status updates no longer auto-expand;
 * - user manually collapses before the task starts → build_started does not auto-expand;
 * - an explicit user request (user_requested) always expands and clears suppression;
 * - ordinary re-renders/polling/stream tokens produce no events, so they never change state.
 */

export type PreviewPanelMode = "expanded" | "collapsed";

export type PreviewExpandReason =
  | "initial_ready"
  | "build_started"
  | "build_succeeded"
  | "user_requested"
  | "project_restored";

export interface PreviewPolicyState {
  mode: PreviewPanelMode;
  /** taskId of the last auto-expand (idempotent dedupe) */
  autoExpandedForTaskId: string | null;
  /** taskId the user manually collapsed while the task was running */
  collapsedDuringTaskId: string | null;
  /** User manually collapsed before the task started (build_started won't expand) */
  collapsedBeforeTask: boolean;
}

export type PreviewPolicyEvent =
  | { type: "build_started"; taskId: string; firstGeneration: boolean }
  | { type: "build_succeeded"; taskId: string }
  | { type: "user_requested" }
  | { type: "user_collapsed"; taskId: string | null }
  | { type: "user_expanded" }
  | { type: "restore_prefs"; saved: PreviewPanelMode | null };

export const INITIAL_PREVIEW_POLICY: PreviewPolicyState = {
  mode: "expanded",
  autoExpandedForTaskId: null,
  collapsedDuringTaskId: null,
  collapsedBeforeTask: false,
};

export function reducePreviewPolicy(
  state: PreviewPolicyState,
  event: PreviewPolicyEvent
): PreviewPolicyState {
  switch (event.type) {
    case "user_collapsed": {
      return {
        mode: "collapsed",
        autoExpandedForTaskId: state.autoExpandedForTaskId,
        collapsedDuringTaskId: event.taskId,
        // Collapse with no task running → applies to the next build_started
        collapsedBeforeTask: state.collapsedBeforeTask || event.taskId === null,
      };
    }
    case "user_expanded": {
      return {
        mode: "expanded",
        autoExpandedForTaskId: null,
        collapsedDuringTaskId: null,
        collapsedBeforeTask: false,
      };
    }
    case "user_requested": {
      return {
        mode: "expanded",
        autoExpandedForTaskId: null,
        collapsedDuringTaskId: null,
        collapsedBeforeTask: false,
      };
    }
    case "build_started": {
      if (!event.firstGeneration) return state;
      // User explicitly collapsed before the task started → respect the decision
      if (state.collapsedBeforeTask) {
        return { ...state, collapsedBeforeTask: false, collapsedDuringTaskId: event.taskId };
      }
      return state.mode === "expanded" ? state : { ...state, mode: "expanded" };
    }
    case "build_succeeded": {
      const collapsedDuring = state.collapsedDuringTaskId === event.taskId;
      const alreadyExpanded = state.autoExpandedForTaskId === event.taskId;
      if (collapsedDuring || alreadyExpanded) {
        // Task ended: clear the suppression markers for this task (idempotent)
        return {
          ...state,
          collapsedDuringTaskId: state.collapsedDuringTaskId === event.taskId ? null : state.collapsedDuringTaskId,
        };
      }
      return { ...state, mode: "expanded", autoExpandedForTaskId: event.taskId };
    }
    case "restore_prefs": {
      const mode: PreviewPanelMode = event.saved ?? "expanded";
      return { ...state, mode };
    }
  }
}

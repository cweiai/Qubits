"use client";

import { useCallback, useReducer, useRef } from "react";
import {
  INITIAL_PREVIEW_POLICY,
  reducePreviewPolicy,
  type PreviewExpandReason,
  type PreviewPolicyEvent,
} from "@/lib/workspace/preview-policy";

/**
 * Wraps the pure state machine: exposes semantic actions (expand/collapse/notify)
 * and tracks event boundaries via a ref to survive Strict Mode double-invoke and re-renders.
 */
export function usePreviewPanelPolicy(initialMode: "expanded" | "collapsed" = "expanded") {
  const [state, dispatch] = useReducer(reducePreviewPolicy, {
    ...INITIAL_PREVIEW_POLICY,
    mode: initialMode, // Initialize from the saved preference so the mount sync effect doesn't write the default back
  });
  const lastEventRef = useRef<string | null>(null);

  const notify = useCallback((event: PreviewPolicyEvent) => {
    // Idempotent event key: handle each task/event only once
    const key =
      event.type === "build_started" || event.type === "build_succeeded"
        ? `${event.type}:${event.taskId}`
        : event.type + ":" + (event.type === "user_collapsed" ? event.taskId ?? "none" : "");
    if (lastEventRef.current === key && (event.type === "build_started" || event.type === "build_succeeded")) return;
    lastEventRef.current = key;
    dispatch(event);
  }, []);

  const expand = useCallback((reason: PreviewExpandReason) => {
    void reason; // Every reason collapses to a user_requested transition
    dispatch({ type: "user_requested" });
  }, []);

  const collapse = useCallback((taskId: string | null) => {
    dispatch({ type: "user_collapsed", taskId });
  }, []);

  const expandByUser = useCallback(() => {
    dispatch({ type: "user_expanded" });
  }, []);

  return { mode: state.mode, notify, expand, collapse, expandByUser };
}

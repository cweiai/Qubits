"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { appSpecSchema, type AppSpec } from "@/lib/contracts/app-spec";
import { qubitsManifestSchema, type QubitsManifest } from "@/lib/contracts/manifest";
import type { RoleId } from "@/lib/contracts/agent-events";
import { ROLE_META } from "@/lib/contracts/agent-events";
import type { PipelineStage } from "@/lib/contracts/conversation";
import { newId } from "@/lib/app/records";
import {
  clearLegacyProjectState,
  loadLegacyProjectState,
  loadPreferences,
  savePreferences,
  type WorkspacePreferences,
} from "@/lib/storage/project-storage";
import { api, friendlyError } from "@/lib/workspace/api";
import { messageToView, messagesToViews, runningRoleOf, taskToView, type TaskView } from "@/lib/workspace/message-view";
import { streamTaskRun } from "@/lib/state/run-agents";
import { createWorkspaceState, workspaceReducer } from "@/lib/state/workspace-reducer";

/**
 * Workspace global state: conversations/messages/build tasks/AppSpec draft all come from the server database;
 * localStorage only keeps UI preferences. Switching threads only loads that thread's messages;
 * the AI context is assembled server-side per conversationId, so the client never mixes in other threads.
 */

type PreviewDevice = "desktop" | "mobile";

type ParsedManifest = { ok: true; manifest: QubitsManifest } | { ok: false; issues: string } | null;
type ParsedSpec = { ok: true; spec: AppSpec } | { ok: false; issues: string } | null;

interface WorkspaceContextValue {
  state: ReturnType<typeof createWorkspaceState>;
  parsedManifest: ParsedManifest;
  parsedSpec: ParsedSpec;
  isRunning: boolean;
  currentStage: PipelineStage;
  currentRoleId: RoleId | null;
  currentRoleName: string | null;
  latestError: { roleId: RoleId; message: string } | null;
  latestFailedTask: TaskView | null;
  switchConversation(id: string): void;
  createConversation(): Promise<void>;
  renameConversation(id: string, title: string): Promise<void>;
  setConversationStatus(id: string, status: "active" | "archived"): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  submitPrompt(content: string): Promise<boolean>;
  retryTask(taskId: string): void;
  setPreviewDevice(device: PreviewDevice): void;
  setPreferences(prefs: WorkspacePreferences): void;
  refreshPreview(): void;
  clearError(): void;
  resolveApproval(approvalId: string, decision: "grant" | "deny"): Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function readConversationIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("conversationId");
  return value && /^conv-[a-zA-Z0-9-]{8,64}$/.test(value) ? value : null;
}

function writeConversationIdToUrl(id: string | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("conversationId", id);
  else url.searchParams.delete("conversationId");
  window.history.replaceState(null, "", url.toString());
}

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(workspaceReducer, loadPreferences(), createWorkspaceState);
  const [mounted, setMounted] = useState(false);
  const stateRef = useRef(state);
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const loadSeqRef = useRef(0);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    setMounted(true);
    return () => abortRef.current?.abort();
  }, []);

  const reloadConversation = useCallback(async (conversationId: string) => {
    const seq = ++loadSeqRef.current;
    dispatch({ type: "set-messages-loading", value: true });
    try {
      const detail = await api.getConversation(conversationId);
      if (seq !== loadSeqRef.current) return; // drop stale responses
      dispatch({
        type: "set-current",
        id: conversationId,
        messages: messagesToViews(detail.messages),
        tasks: detail.tasks.map((task) => taskToView(task)),
        app: detail.conversation.app ?? { manifest: null, previewVersion: 0, previewBundleId: null, currentSnapshotId: null },
        pendingApprovals: detail.pendingApprovals ?? [],
      });
    } catch (error) {
      if (seq !== loadSeqRef.current) return;
      dispatch({ type: "set-messages-loading", value: false });
      dispatch({ type: "set-error", message: friendlyError(error) });
    }
  }, []);

  const refreshConversationList = useCallback(async () => {
    try {
      const { conversations } = await api.listConversations();
      dispatch({ type: "set-conversations", conversations });
    } catch {
      // List refresh failure must not block the main flow.
    }
  }, []);

  const streamTask = useCallback(
    async (taskId: string, conversationId: string) => {
      runningRef.current = true;
      dispatch({ type: "set-running", task: { taskId, conversationId } });
      const controller = new AbortController();
      abortRef.current = controller;
      await streamTaskRun(
        taskId,
        controller.signal,
        (event) => dispatch({ type: "task-event", taskId, event, now: Date.now() }),
        (message) => dispatch({ type: "task-error", taskId, message, now: Date.now() })
      );
      try {
        const detail = await api.getConversation(conversationId);
        if (stateRef.current.currentConversationId === conversationId) {
          dispatch({ type: "task-refreshed", tasks: detail.tasks });
          dispatch({ type: "approvals-refreshed", approvals: detail.pendingApprovals ?? [] });
        }
      } catch {
        // ignore
      }
      dispatch({ type: "set-running", task: null });
      runningRef.current = false;
      void refreshConversationList();
    },
    [refreshConversationList]
  );

  // Init: migrate legacy data → project draft → conversation list → restore current thread
  useEffect(() => {
    if (!mounted) return;
    let cancelled = false;
    void (async () => {
      try {
        const legacy = loadLegacyProjectState();
        if (legacy && (legacy.appSpec != null || legacy.conversation.length > 1)) {
          try {
            const result = await api.migrateLegacy({
              appSpec: legacy.appSpec,
              productBrief: legacy.productBrief,
              appBlueprint: legacy.appBlueprint,
              legacyConversation: legacy.conversation,
            });
            if (result.migrated) clearLegacyProjectState();
          } catch {
            // Migration failure must not block the workspace (legacy data kept, retried next time).
          }
        }
        const project = await api.getProject();
        if (cancelled) return;
        dispatch({
          type: "init",
          projectId: project.projectId,
          appSpec: project.appSpec,
          productBrief: project.productBrief,
          appBlueprint: project.appBlueprint,
        });
        const { conversations } = await api.listConversations();
        if (cancelled) return;
        dispatch({ type: "set-conversations", conversations });
        const urlId = readConversationIdFromUrl();
        const active = conversations.filter((c) => c.status === "active");
        let target = urlId && conversations.some((c) => c.id === urlId) ? urlId : null;
        if (!target) target = active[0]?.id ?? null;
        if (!target) {
          const created = await api.createConversation("conv-" + crypto.randomUUID());
          target = created.conversation.id;
          dispatch({ type: "add-conversation", conversation: created.conversation });
        }
        writeConversationIdToUrl(target);
        await reloadConversation(target);
      } catch (error) {
        if (!cancelled) {
          dispatch({ type: "set-error", message: friendlyError(error) });
          dispatch({
            type: "init",
            projectId: null,
            appSpec: null,
            productBrief: null,
            appBlueprint: null,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mounted, reloadConversation]);

  // popstate: restore the thread on browser forward/back
  useEffect(() => {
    if (!mounted) return;
    const onPopState = () => {
      const urlId = readConversationIdFromUrl();
      if (urlId && urlId !== stateRef.current.currentConversationId) {
        void reloadConversation(urlId);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [mounted, reloadConversation]);

  const switchConversation = useCallback(
    (id: string) => {
      if (id === stateRef.current.currentConversationId) return;
      writeConversationIdToUrl(id);
      void reloadConversation(id);
    },
    [reloadConversation]
  );

  const createConversation = useCallback(async () => {
    try {
      const created = await api.createConversation("conv-" + crypto.randomUUID());
      dispatch({ type: "add-conversation", conversation: created.conversation });
      switchConversation(created.conversation.id);
    } catch (error) {
      dispatch({ type: "set-error", message: friendlyError(error) });
    }
  }, [switchConversation]);

  const renameConversation = useCallback(async (id: string, title: string) => {
    try {
      const { conversation } = await api.patchConversation(id, { title });
      if (conversation) dispatch({ type: "patch-conversation", id, patch: conversation });
    } catch (error) {
      dispatch({ type: "set-error", message: friendlyError(error) });
    }
  }, []);

  const setConversationStatus = useCallback(
    async (id: string, status: "active" | "archived") => {
      try {
        const { conversation } = await api.patchConversation(id, { status });
        if (conversation) dispatch({ type: "patch-conversation", id, patch: conversation });
        if (status === "archived" && id === stateRef.current.currentConversationId) {
          const { conversations } = await api.listConversations();
          dispatch({ type: "set-conversations", conversations });
          const next = conversations.find((c) => c.status === "active" && c.id !== id);
          if (next) switchConversation(next.id);
        }
      } catch (error) {
        dispatch({ type: "set-error", message: friendlyError(error) });
      }
    },
    [switchConversation]
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      try {
        const { fallbackConversationId } = await api.deleteConversation(id);
        dispatch({ type: "remove-conversation", id });
        if (id === stateRef.current.currentConversationId) {
          const fallback =
            fallbackConversationId ??
            stateRef.current.conversations.find((c) => c.id !== id && c.status === "active")?.id ??
            null;
          if (fallback) switchConversation(fallback);
        }
        void refreshConversationList();
      } catch (error) {
        dispatch({ type: "set-error", message: friendlyError(error) });
      }
    },
    [switchConversation, refreshConversationList]
  );

  const submitPrompt = useCallback(
    async (content: string): Promise<boolean> => {
      const trimmed = content.trim();
      const conversationId = stateRef.current.currentConversationId;
      if (!trimmed || !conversationId || runningRef.current) return false;
      const conversation = stateRef.current.conversations.find((c) => c.id === conversationId);
      if (conversation?.status === "archived") {
        dispatch({ type: "set-error", message: "归档对话不能发送消息，请先恢复" });
        return false;
      }
      const requestId = newId("req");
      try {
        const result = await api.sendMessage(conversationId, trimmed, requestId);
        const userView = messageToView(result.userMessage);
        if (userView) dispatch({ type: "add-message", message: userView });
        if (!result.task) {
          dispatch({ type: "set-error", message: "任务创建失败，请重试" });
          return false;
        }
        dispatch({ type: "task-created", task: result.task, conversationId });
        dispatch({ type: "set-error", message: null }); // clear the global error banner
        if (result.deduplicated) {
          const detail = await api.getConversation(conversationId);
          if (stateRef.current.currentConversationId === conversationId) {
            dispatch({ type: "task-refreshed", tasks: detail.tasks });
            dispatch({ type: "approvals-refreshed", approvals: detail.pendingApprovals ?? [] });
          }
          return true;
        }
        await streamTask(result.task.id, conversationId);
        return true;
      } catch (error) {
        dispatch({ type: "set-error", message: friendlyError(error) });
        return false;
      }
    },
    [streamTask]
  );

  const retryTask = useCallback(
    (taskId: string) => {
      if (runningRef.current) return;
      void (async () => {
        try {
          const { task } = await api.retryTask(taskId);
          if (!task) {
            dispatch({ type: "set-error", message: "重试失败：任务不存在" });
            return;
          }
          dispatch({ type: "task-created", task, conversationId: task.conversationId });
          await streamTask(task.id, task.conversationId);
        } catch (error) {
          dispatch({ type: "set-error", message: friendlyError(error) });
        }
      })();
    },
    [streamTask]
  );

  const setPreviewDevice = useCallback((device: PreviewDevice) => {
    const prefs = { ...stateRef.current.prefs, previewDevice: device };
    savePreferences(prefs);
    dispatch({ type: "set-prefs", prefs });
  }, []);

  const setPreferences = useCallback((prefs: WorkspacePreferences) => {
    savePreferences(prefs);
    dispatch({ type: "set-prefs", prefs });
  }, []);

  const refreshPreview = useCallback(() => dispatch({ type: "refresh-tick" }), []);
  const clearError = useCallback(() => dispatch({ type: "set-error", message: null }), []);
  const resolveApproval = useCallback(async (approvalId: string, decision: "grant" | "deny") => {
    try {
      await api.resolveApproval(approvalId, decision);
      dispatch({ type: "approval-resolved", approvalId });
    } catch (error) {
      dispatch({ type: "set-error", message: friendlyError(error) });
    }
  }, []);

  const value = useMemo<WorkspaceContextValue>(() => {
    const runningTaskView = state.tasks.find((t) => t.status === "running" || t.status === "pending") ?? null;
    const isRunning = state.runningTask != null || runningTaskView != null;
    const currentRoleId = runningTaskView ? runningRoleOf(runningTaskView) : null;
    const latestFailedTask = state.tasks.find((t) => t.status === "failed") ?? null;

    let parsedManifest: ParsedManifest = null;
    if (state.manifest != null) {
      const result = qubitsManifestSchema.safeParse(state.manifest);
      parsedManifest = result.success
        ? { ok: true, manifest: result.data }
        : {
            ok: false,
            issues: result.error.issues
              .slice(0, 8)
              .map((issue) => (issue.path.join(".") || "(root)") + ": " + issue.message)
              .join("\n"),
          };
    }

    let parsedSpec: ParsedSpec = null;
    if (state.appSpec != null) {
      const result = appSpecSchema.safeParse(state.appSpec);
      parsedSpec = result.success
        ? { ok: true, spec: result.data }
        : {
            ok: false,
            issues: result.error.issues
              .slice(0, 8)
              .map((issue) => (issue.path.join(".") || "(root)") + ": " + issue.message)
              .join("\n"),
          };
    }

    return {
      state,
      parsedManifest,
      parsedSpec,
      isRunning,
      currentStage: runningTaskView?.stage ?? "idle",
      currentRoleId,
      currentRoleName: currentRoleId ? ROLE_META[currentRoleId].name : null,
      latestError: latestFailedTask?.error ?? null,
      latestFailedTask,
      switchConversation,
      createConversation,
      renameConversation,
      setConversationStatus,
      deleteConversation,
      submitPrompt,
      retryTask,
      setPreviewDevice,
      setPreferences,
      refreshPreview,
      clearError,
      resolveApproval,
    };
  }, [state, switchConversation, createConversation, renameConversation, setConversationStatus, deleteConversation, submitPrompt, retryTask, setPreviewDevice, setPreferences, refreshPreview, clearError, resolveApproval]);

  if (!mounted) {
    return <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">正在加载工作台…</div>;
  }

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspace 必须在 WorkspaceProvider 内使用");
  }
  return context;
}

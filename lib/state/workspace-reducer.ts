import { ROLE_RUNNING_TEXT, type AgentEvent, type RoleId } from "@/lib/contracts/agent-events";
import { type ConversationMessage } from "@/lib/contracts/conversation";
import type { ConversationSummary, TaskJson } from "@/lib/workspace/api";
import { taskToView, type AgentRunView, type TaskView } from "@/lib/workspace/message-view";
import type { WorkspacePreferences } from "@/lib/storage/project-storage";

/**
 * Workspace reducer: conversations/messages/build tasks/drafts all come from the server database.
 * Stream events only update the view of their own task; events for other threads only update the list summary.
 */

interface WorkspaceState {
  phase: "loading" | "ready" | "error";
  projectId: string | null;
  /** App state of the current conversation (the code workspace is the source of truth). */
  manifest: unknown;
  previewVersion: number;
  previewBundleId: string | null;
  currentSnapshotId: string | null;
  /** Legacy AppSpec draft (read-only compat; kept, never drives new previews). */
  appSpec: unknown;
  productBrief: unknown;
  appBlueprint: unknown;
  conversations: ConversationSummary[];
  currentConversationId: string | null;
  messages: ConversationMessage[];
  tasks: TaskView[];
  messagesLoading: boolean;
  runningTask: { taskId: string; conversationId: string } | null;
  workspaceError: string | null;
  refreshTick: number;
  prefs: WorkspacePreferences;
}

type WorkspaceAction =
  | {
      type: "init";
      projectId: string | null;
      appSpec: unknown;
      productBrief: unknown;
      appBlueprint: unknown;
    }
  | { type: "set-conversations"; conversations: ConversationSummary[] }
  | {
      type: "set-current";
      id: string;
      messages: ConversationMessage[];
      tasks: TaskView[];
      app: { manifest: unknown; previewVersion: number; previewBundleId: string | null; currentSnapshotId: string | null };
    }
  | { type: "set-messages-loading"; value: boolean }
  | { type: "add-conversation"; conversation: ConversationSummary }
  | { type: "patch-conversation"; id: string; patch: Partial<ConversationSummary> }
  | { type: "remove-conversation"; id: string }
  | { type: "task-created"; task: TaskJson; conversationId: string }
  | { type: "add-message"; message: ConversationMessage }
  | { type: "task-event"; taskId: string; event: AgentEvent; now: number }
  | { type: "task-refreshed"; tasks: TaskJson[] }
  | { type: "task-error"; taskId: string; message: string; now: number }
  | { type: "set-running"; task: { taskId: string; conversationId: string } | null }
  | { type: "set-error"; message: string | null }
  | { type: "refresh-tick" }
  | { type: "set-prefs"; prefs: WorkspacePreferences };

export function createWorkspaceState(prefs: WorkspacePreferences): WorkspaceState {
  return {
    phase: "loading",
    projectId: null,
    manifest: null,
    previewVersion: 0,
    previewBundleId: null,
    currentSnapshotId: null,
    appSpec: null,
    productBrief: null,
    appBlueprint: null,
    conversations: [],
    currentConversationId: null,
    messages: [],
    tasks: [],
    messagesLoading: false,
    runningTask: null,
    workspaceError: null,
    refreshTick: 0,
    prefs,
  };
}

function appendErrorCard(messages: ConversationMessage[], card: ConversationMessage): ConversationMessage[] {
  const exists = messages.some(
    (m) => m.type === "error" && m.runId === card.runId && m.text === card.text
  );
  return exists ? messages : [...messages, card];
}

function upsertViewMessage(messages: ConversationMessage[], message: ConversationMessage): ConversationMessage[] {
  const index = messages.findIndex((m) => m.runId === message.runId && m.roleId === message.roleId && m.roleId !== null);
  if (index >= 0) {
    const next = [...messages];
    next[index] = message;
    return next;
  }
  return [...messages, message];
}

function updateTaskInList(tasks: TaskView[], taskId: string, patch: (task: TaskView) => TaskView): TaskView[] {
  return tasks.map((task) => (task.id === taskId ? patch(task) : task));
}

function upsertAgentRun(runs: AgentRunView[], run: AgentRunView) {
  const index = runs.findIndex((r) => r.agentRunId === run.agentRunId);
  if (index >= 0) {
    const next = [...runs];
    next[index] = run;
    return next;
  }
  return [...runs, run];
}

function applyTaskEvent(state: WorkspaceState, taskId: string, event: AgentEvent, now: number): WorkspaceState {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) {
    const conversations = state.conversations.map((conversation) => {
      if (conversation.lastTask?.id !== taskId) return conversation;
      const lastTask = conversation.lastTask;
      return {
        ...conversation,
        lastTask: {
          ...lastTask,
          status: event.type === "error" ? ("failed" as const) : lastTask.status,
          stage: event.type === "role_started" ? event.roleId : lastTask.stage,
        },
      };
    });
    return { ...state, conversations };
  }

  let messages = state.messages;
  let tasks = state.tasks;
  let manifest = state.manifest;
  let previewVersion = state.previewVersion;
  let previewBundleId = state.previewBundleId;
  let appSpec = state.appSpec; // legacy read-only draft

  const patchTask = (patch: (t: TaskView) => TaskView) => {
    tasks = tasks.map((t) => (t.id === taskId ? patch(t) : t));
  };
  const upsertMessage = (message: ConversationMessage) => {
    const index = messages.findIndex((m) => m.runId === message.runId && m.roleId === message.roleId && m.roleId !== null);
    if (index >= 0) {
      const next = [...messages];
      next[index] = message;
      messages = next;
    } else {
      messages = [...messages, message];
    }
  };
  // Replace preview/done cards by id across retries instead of appending duplicates.
  const upsertLiveCard = (message: ConversationMessage) => {
    const index = messages.findIndex((m) => m.id === message.id);
    if (index >= 0) {
      const next = [...messages];
      next[index] = message;
      messages = next;
    } else {
      messages = [...messages, message];
    }
  };

  switch (event.type) {
    case "agent_started": {
      patchTask((t) => ({
        ...t,
        roles: { ...t.roles, [event.roleId]: { ...(t.roles[event.roleId] ?? { status: "pending", summary: null, startedAt: null, completedAt: null }), status: "running", startedAt: now } },
        agentRuns: upsertAgentRun(t.agentRuns, { agentRunId: event.agentRunId, roleId: event.roleId, parentAgentRunId: event.parentAgentRunId, status: "running", taskSummary: event.taskSummary, summary: null, artifactId: null, errorMessage: null, timestamp: now }),
      }));
      break;
    }
    case "agent_delegated": {
      patchTask((t) => ({
        ...t,
        agentRuns: upsertAgentRun(t.agentRuns, { agentRunId: event.childAgentRunId, roleId: event.targetRole, parentAgentRunId: event.parentAgentRunId, status: "pending", taskSummary: event.taskSummary, summary: null, artifactId: null, errorMessage: null, timestamp: now }),
      }));
      break;
    }
    case "agent_completed": {
      patchTask((t) => ({
        ...t,
        roles: { ...t.roles, [event.roleId]: { ...(t.roles[event.roleId] ?? { status: "pending", summary: null, startedAt: null, completedAt: null }), status: "success", summary: event.summary, completedAt: now } },
        agentRuns: t.agentRuns.map((r) => (r.agentRunId === event.agentRunId ? { ...r, status: "completed" as const, summary: event.summary, artifactId: event.artifactId ?? null } : r)),
      }));
      upsertMessage({
        id: "live:" + event.agentRunId,
        type: event.roleId,
        runId: taskId,
        roleId: event.roleId,
        text: event.summary,
        artifact: null,
        status: "success",
        timestamp: now,
      });
      break;
    }
    case "agent_failed": {
      patchTask((t) => ({
        ...t,
        roles: { ...t.roles, [event.roleId]: { ...(t.roles[event.roleId] ?? { status: "pending", summary: null, startedAt: null, completedAt: null }), status: "error", summary: event.message, completedAt: now } },
        agentRuns: t.agentRuns.map((r) => (r.agentRunId === event.agentRunId ? { ...r, status: "failed" as const, errorMessage: event.message } : r)),
      }));
      messages = appendErrorCard(messages, {
        id: "live:" + event.agentRunId + ":err",
        type: "error",
        runId: taskId,
        roleId: event.roleId,
        text: event.message,
        artifact: null,
        status: null,
        timestamp: now,
      });
      break;
    }
    case "tool_call_started": {
      patchTask((t) => ({
        ...t,
        toolEvents: [...t.toolEvents, { toolCallId: event.toolCallId, agentRunId: event.agentRunId, roleId: event.roleId, toolName: event.toolName, status: "running", inputSummary: event.inputSummary, resultSummary: "", errorCode: null, timestamp: now }],
      }));
      break;
    }
    case "tool_result": {
      patchTask((t) => ({
        ...t,
        toolEvents: t.toolEvents.map((te) =>
          te.toolCallId === event.toolCallId
            ? { ...te, status: event.ok ? "success" : "failed", resultSummary: event.resultSummary, errorCode: event.errorCode ?? null }
            : te
        ),
      }));
      break;
    }
    case "reference_found": {
      patchTask((t) => ({
        ...t,
        references: [...t.references, { resultId: event.resultId, title: event.title, url: event.url, domain: event.domain, snippet: event.snippet, source: event.source }],
        toolEvents: [...t.toolEvents, { toolCallId: "ref:" + event.resultId, agentRunId: "", roleId: "researcher", toolName: "search_references", status: "success", inputSummary: "", resultSummary: event.title, errorCode: null, timestamp: now, reference: { resultId: event.resultId, title: event.title, url: event.url, domain: event.domain, snippet: event.snippet, source: event.source } }],
      }));
      break;
    }
    case "preview_ready": {
      patchTask((t) => ({ ...t, status: "running", stage: "previewing" }));
      manifest = event.manifest;
      previewVersion = event.version;
      previewBundleId = event.previewArtifactId;
      upsertLiveCard({
        id: "live:" + taskId + ":preview",
        type: "system",
        runId: taskId,
        roleId: null,
        text: "应用「" + event.appName + "」已通过构建与评审并更新预览（v" + event.version + "）。",
        artifact: null,
        status: null,
        timestamp: now,
      });
      break;
    }
    case "run_completed": {
      patchTask((t) => ({ ...t, status: "ready", stage: "ready" }));
      upsertLiveCard({ id: "live:" + taskId + ":done", type: "system", runId: taskId, roleId: null, text: event.summary, artifact: null, status: null, timestamp: now });
      break;
    }
    case "preview_requested":
      break;
    case "role_started": {
      tasks = updateTaskInList(tasks, taskId, (t) => ({
        ...t,
        roles: { ...t.roles, [event.roleId]: { ...t.roles[event.roleId], status: "running", startedAt: now } },
      }));
      const runningMessage: ConversationMessage = {
        id: "live:" + taskId + ":" + event.roleId,
        type: event.roleId,
        runId: taskId,
        roleId: event.roleId,
        text: ROLE_RUNNING_TEXT[event.roleId],
        artifact: null,
        status: "running",
        timestamp: now,
      };
      messages = upsertViewMessage(messages, runningMessage);
      break;
    }
    case "role_completed": {
      tasks = updateTaskInList(tasks, taskId, (t) => ({
        ...t,
        roles: { ...t.roles, [event.roleId]: { ...t.roles[event.roleId], status: "success", summary: event.summary, completedAt: now } },
      }));
      const completedMessage: ConversationMessage = {
        id: "live:" + taskId + ":" + event.roleId,
        type: event.roleId,
        runId: taskId,
        roleId: event.roleId,
        text: event.summary,
        artifact: event.artifact,
        status: "success",
        timestamp: now,
      };
      messages = upsertViewMessage(messages, completedMessage);
      break;
    }
    case "app_ready": {
      // Legacy event compat: old clients/tasks only — new runs emit preview_ready + run_completed.
      tasks = updateTaskInList(tasks, taskId, (t) => ({ ...t, status: "ready", stage: "ready" }));
      appSpec = event.appSpec;
      messages = [
        ...messages,
        {
          id: "live:" + taskId + ":system",
          type: "system",
          runId: taskId,
          roleId: null,
          text: "应用「" + event.appSpec.name + "」已生成（旧版 AppSpec 记录，只读兼容）。",
          artifact: null,
          status: null,
          timestamp: now,
        },
      ];
      break;
    }
    case "error": {
      const roleId: RoleId = event.roleId ?? "engineer";
      tasks = updateTaskInList(tasks, taskId, (t) => ({
        ...t,
        status: "failed",
        stage: "failed",
        error: { roleId, message: event.message },
        roles: { ...t.roles, [roleId]: { ...t.roles[roleId], status: "error", summary: event.message, completedAt: now } },
      }));
      // Render only one error card: the role failure state is shown by the role list (RoleProgress);
      // don't also append a role message card for the same error, so error content doesn't appear twice.
      const errorCard: ConversationMessage = {
        id: "live:" + taskId + ":error",
        type: "error",
        runId: taskId,
        roleId,
        text: event.message,
        artifact: null,
        status: null,
        timestamp: now,
      };
      messages = appendErrorCard(messages, errorCard);
      break;
    }
    case "done":
      break;
  }
  return { ...state, tasks, messages, manifest, previewVersion, previewBundleId, appSpec };
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "init":
      return {
        ...state,
        phase: "ready",
        projectId: action.projectId,
        appSpec: action.appSpec,
        productBrief: action.productBrief,
        appBlueprint: action.appBlueprint,
      };
    case "set-conversations":
      return { ...state, conversations: action.conversations };
    case "set-current":
      return {
        ...state,
        currentConversationId: action.id,
        messages: action.messages,
        tasks: action.tasks,
        // Switching conversations switches the app state.
        manifest: action.app.manifest,
        previewVersion: action.app.previewVersion,
        previewBundleId: action.app.previewBundleId,
        currentSnapshotId: action.app.currentSnapshotId,
        messagesLoading: false,
      };
    case "set-messages-loading":
      return { ...state, messagesLoading: action.value };
    case "add-conversation":
      return { ...state, conversations: [action.conversation, ...state.conversations] };
    case "patch-conversation":
      return {
        ...state,
        conversations: state.conversations.map((conversation) =>
          conversation.id === action.id ? { ...conversation, ...action.patch } : conversation
        ),
      };
    case "remove-conversation":
      return { ...state, conversations: state.conversations.filter((c) => c.id !== action.id) };
    case "task-created": {
      const view = taskToView(action.task);
      return {
        ...state,
        tasks: [view, ...state.tasks.filter((t) => t.id !== view.id)],
        runningTask: { taskId: view.id, conversationId: action.conversationId },
        // A new attempt replaces the old failure result: clear error cards (history stays on the server).
        messages: state.messages.filter((m) => m.type !== "error"),
        workspaceError: null,
        conversations: state.conversations.map((c) =>
          c.id === action.conversationId ? { ...c, lastTask: action.task } : c
        ),
      };
    }
    case "add-message":
      return { ...state, messages: [...state.messages, action.message] };
    case "task-event":
      return applyTaskEvent(state, action.taskId, action.event, action.now);
    case "task-refreshed":
      return { ...state, tasks: action.tasks.map(taskToView) };
    case "task-error": {
      const message: ConversationMessage = {
        id: "live:" + action.taskId + ":neterr",
        type: "error",
        runId: action.taskId,
        roleId: null,
        text: action.message,
        artifact: null,
        status: null,
        timestamp: action.now,
      };
      return {
        ...state,
        messages: [...state.messages, message],
        tasks: updateTaskInList(state.tasks, action.taskId, (t) => ({
          ...t,
          status: "failed",
          stage: "failed",
          error: { roleId: "engineer", message: action.message },
        })),
      };
    }
    case "set-running":
      return { ...state, runningTask: action.task };
    case "set-error":
      return { ...state, workspaceError: action.message };
    case "refresh-tick":
      return { ...state, refreshTick: state.refreshTick + 1 };
    case "set-prefs":
      return { ...state, prefs: action.prefs };
  }
}

/**
 * Workspace API client: all conversation/message/build-task reads and writes go through the server;
 * the client keeps only UI state; errors are normalized to ApiError ({ code, message, requestId }).
 */

interface ApiErrorBody {
  code: string;
  message: string;
  requestId?: string | null;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  constructor(code: string, message: string, status: number, requestId: string | null) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = (await response.json().catch(() => null)) as
    | { ok?: boolean; data?: T; error?: ApiErrorBody }
    | null;
  if (!response.ok || !payload?.ok) {
    const error = payload?.error;
    throw new ApiError(
      error?.code ?? "NETWORK",
      error?.message ?? `请求失败（HTTP ${response.status}）`,
      response.status,
      error?.requestId ?? null
    );
  }
  return payload.data as T;
}

interface ProjectData {
  projectId: string;
  /** Legacy AppSpec draft (read-only compat; app state now lives per conversation). */
  appSpec: unknown;
  productBrief: unknown;
  appBlueprint: unknown;
  updatedAt: number | null;
}

export interface CodeFile {
  path: string;
  size: number;
}

export interface CodeFileContent {
  path: string;
  content: string;
}

export interface LogSection {
  kind: string;
  title: string;
  status: string | null;
  content: string;
}

export interface ConversationSummary {
  id: string;
  projectId: string;
  title: string;
  titleSource: "auto" | "user";
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
  messageCount?: number;
  lastTask?: TaskJson | null;
  /** Per-conversation app state. */
  app: ConversationApp;
}

export interface ConversationApp {
  manifest: unknown;
  previewVersion: number;
  previewBundleId: string | null;
  currentSnapshotId: string | null;
}

export interface MessageJson {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  status: "pending" | "streaming" | "completed" | "error";
  errorCode: string | null;
  metadata: Record<string, unknown>;
  taskId: string | null;
  roleId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TaskJson {
  id: string;
  conversationId: string;
  prompt: string;
  status: "pending" | "running" | "ready" | "failed" | "conflict";
  stage: string;
  roles: Record<string, unknown>;
  agentRuns?: unknown;
  toolEvents?: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ApprovalJson {
  approvalId: string;
  taskId: string | null;
  toolCallId: string | null;
  toolName: string;
  reason: string;
  status: "pending" | "granted" | "denied" | "expired";
  createdAt: number;
  expiresAt: number;
}

export interface ConversationDetail {
  conversation: ConversationSummary;
  messages: MessageJson[];
  tasks: TaskJson[];
  messageCount: number;
  pendingApprovals: ApprovalJson[];
}

export const api = {
  getProject: () => request<ProjectData>("/api/projects/current"),
  migrateLegacy: (payload: unknown) =>
    request<{ migrated: boolean; conversationId?: string; migratedMessages?: number }>(
      "/api/projects/current",
      { method: "POST", body: JSON.stringify(payload) }
    ),
  listConversations: () =>
    request<{ conversations: ConversationSummary[] }>("/api/projects/current/conversations"),
  createConversation: (id: string, title?: string) =>
    request<{ conversation: ConversationSummary; created: boolean }>(
      "/api/projects/current/conversations",
      { method: "POST", body: JSON.stringify({ id, title }) }
    ),
  getConversation: (conversationId: string) =>
    request<ConversationDetail>(`/api/conversations/${conversationId}?limit=100`),
  patchConversation: (conversationId: string, patch: { title?: string; status?: "active" | "archived" }) =>
    request<{ conversation: ConversationSummary | null }>(`/api/conversations/${conversationId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteConversation: (conversationId: string) =>
    request<{ deleted: boolean; fallbackConversationId: string | null }>(
      `/api/conversations/${conversationId}`,
      { method: "DELETE" }
    ),
  sendMessage: (conversationId: string, content: string, requestId: string) =>
    request<{ userMessage: MessageJson; task: TaskJson | null; deduplicated: boolean }>(
      `/api/conversations/${conversationId}/messages`,
      { method: "POST", body: JSON.stringify({ content, requestId }) }
    ),
  retryTask: (taskId: string) =>
    request<{ task: TaskJson | null }>(`/api/build-tasks/${taskId}`, { method: "POST" }),
  getTask: (taskId: string) =>
    request<{ task: TaskJson }>(`/api/build-tasks/${taskId}`),
  resetProject: () =>
    request<{ reset: boolean }>("/api/projects/current/reset", { method: "POST", body: "{}" }),
  getCodeFiles: (conversationId: string) =>
    request<{ version: number | null; files: CodeFile[] }>(
      `/api/projects/current/code?conversationId=${encodeURIComponent(conversationId)}`
    ),
  getCodeFile: (conversationId: string, path: string) =>
    request<CodeFileContent>(
      `/api/projects/current/code?conversationId=${encodeURIComponent(conversationId)}&path=${encodeURIComponent(path)}`
    ),
  getLogs: (conversationId: string) =>
    request<{ sections: LogSection[]; version: number | null }>(
      `/api/projects/current/logs?conversationId=${encodeURIComponent(conversationId)}`
    ),
  resolveApproval: (approvalId: string, decision: "grant" | "deny") =>
    request<{ approvalId: string; status: string }>(`/api/approvals/${encodeURIComponent(approvalId)}`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    }),
};

export function friendlyError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message || "操作失败，请重试";
  return "操作失败，请重试";
}

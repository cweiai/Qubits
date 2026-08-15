import type { ApprovalRow, ConversationRow, MessageRow, TaskRow } from "@/lib/db/repository";

/** Server row → API JSON (parses metadata/roles; the client rebuilds views from this). */

export function toConversationJson(row: ConversationRow): Record<string, unknown> {
  let manifest: unknown = null;
  if (row.manifestJson) {
    try {
      manifest = JSON.parse(row.manifestJson);
    } catch {
      manifest = null;
    }
  }
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    titleSource: row.titleSource,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastMessageAt: row.lastMessageAt,
    // Per-conversation app state.
    app: {
      manifest,
      previewVersion: row.previewVersion,
      previewBundleId: row.previewBundleId,
      currentSnapshotId: row.currentSnapshotId,
    },
  };
}

export function toMessageJson(row: MessageRow): Record<string, unknown> {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = row.metadataJson ? (JSON.parse(row.metadataJson) as Record<string, unknown>) : {};
  } catch {
    metadata = {};
  }
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    status: row.status,
    errorCode: row.errorCode,
    metadata,
    taskId: row.taskId,
    roleId: row.roleId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseTaskRoles(row: TaskRow): Record<string, unknown> {
  try {
    return row.rolesJson ? (JSON.parse(row.rolesJson) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseJsonOrNull(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function toTaskJson(row: TaskRow): Record<string, unknown> {
  return {
    id: row.id,
    conversationId: row.conversationId,
    prompt: row.prompt.slice(0, 200),
    status: row.status,
    stage: row.stage,
    roles: parseTaskRoles(row),
    agentRuns: parseJsonOrNull(row.agentRunsJson),
    toolEvents: parseJsonOrNull(row.toolEventsJson),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toApprovalJson(row: ApprovalRow): Record<string, unknown> {
  return {
    approvalId: row.id,
    taskId: row.taskId,
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    reason: row.reason,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

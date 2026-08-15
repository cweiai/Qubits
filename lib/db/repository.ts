import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ArtifactKind } from "@/lib/ai/tools/types";
import type { RoleId } from "@/lib/contracts/agent-events";

/**
 * Data repository: node:sqlite implementation (a real file database, the server's single entry point).
 * Covers project drafts / conversations / messages / build tasks / sandbox sessions / business records.
 * The repository abstraction isolates the storage implementation; production can swap in a PostgreSQL driver.
 * This module is only referenced by Route Handlers and never enters the client bundle.
 */

interface ProjectRow {
  id: string;
  appSpecJson: string | null;
  productBriefJson: string | null;
  appBlueprintJson: string | null;
  manifestJson: string | null;
  currentSnapshotId: string | null;
  previewBundleId: string | null;
  previewVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationRow {
  id: string;
  projectId: string;
  title: string;
  titleSource: "auto" | "user";
  status: "active" | "archived";
  /** Per-conversation app state (manifest/snapshot/preview/version). */
  manifestJson: string | null;
  currentSnapshotId: string | null;
  previewBundleId: string | null;
  previewVersion: number;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  status: "pending" | "streaming" | "completed" | "error";
  errorCode: string | null;
  metadataJson: string | null;
  taskId: string | null;
  roleId: string | null;
  messageKind: "role" | "error" | null;
  createdAt: number;
  updatedAt: number;
}

export interface TaskRow {
  id: string;
  projectId: string;
  conversationId: string;
  userMessageId: string | null;
  prompt: string;
  status: "pending" | "running" | "ready" | "failed" | "conflict";
  stage: string;
  rolesJson: string | null;
  agentRunsJson: string | null;
  toolEventsJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** Retry count: 0 = first run; >0 = resume from a failed/finished state. */
  attempts: number;
  requestId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SessionRow {
  id: string;
  projectId: string;
  appId: string;
  appVersion: number;
  collectionsJson: string;
  createdAt: number;
  expiresAt: number;
}

export interface RecordRow {
  id: string;
  projectId: string;
  appId: string;
  collection: string;
  dataJson: string;
  createdAt: number;
  updatedAt: number;
}

export interface CodeSnapshotRow {
  id: string;
  projectId: string;
  taskId: string;
  version: number;
  manifestJson: string;
  filesJson: string;
  depsJson: string;
  buildReportJson: string | null;
  testReportJson: string | null;
  reviewReportJson: string | null;
  previewBundleId: string | null;
  createdAt: number;
}

export interface ArtifactRow {
  id: string;
  projectId: string;
  taskId: string | null;
  kind: string;
  name: string;
  content: string;
  createdBy: string | null;
  parentAgentRunId: string | null;
  schemaVersion: number | null;
  sizeBytes: number | null;
  artifactOrder: number | null;
  createdAt: number;
}

export type ApprovalStatus = "pending" | "granted" | "denied" | "expired";

export interface ApprovalRow {
  id: string;
  projectId: string | null;
  taskId: string | null;
  runId: string;
  toolCallId: string | null;
  toolName: string;
  reason: string;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
}

const SCHEMA_PATH = path.join(process.cwd(), "lib", "db", "schema.sql");

export class AppRepository {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    // Idempotent migration: apply schema.sql at startup.
    this.db.exec(readFileSync(SCHEMA_PATH, "utf8"));
    this.migrateLegacyColumns();
  }

  /** Legacy upgrade: backfill draft columns for existing projects tables (a real migration, not just TS types). */
  private migrateLegacyColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((c) => c.name));
    if (!names.has("app_spec_json")) this.db.exec("ALTER TABLE projects ADD COLUMN app_spec_json TEXT");
    if (!names.has("product_brief_json")) this.db.exec("ALTER TABLE projects ADD COLUMN product_brief_json TEXT");
    if (!names.has("app_blueprint_json")) this.db.exec("ALTER TABLE projects ADD COLUMN app_blueprint_json TEXT");
    if (!names.has("updated_at")) this.db.exec("ALTER TABLE projects ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0");
    // Code-workspace migration columns (AppSpec stays untouched — read-only legacy data).
    if (!names.has("manifest_json")) this.db.exec("ALTER TABLE projects ADD COLUMN manifest_json TEXT");
    if (!names.has("current_snapshot_id")) this.db.exec("ALTER TABLE projects ADD COLUMN current_snapshot_id TEXT");
    if (!names.has("preview_bundle_id")) this.db.exec("ALTER TABLE projects ADD COLUMN preview_bundle_id TEXT");
    if (!names.has("preview_version")) this.db.exec("ALTER TABLE projects ADD COLUMN preview_version INTEGER NOT NULL DEFAULT 0");
    const taskColumns = this.db.prepare("PRAGMA table_info(build_tasks)").all() as Array<{ name: string }>;
    const taskNames = new Set(taskColumns.map((c) => c.name));
    if (!taskNames.has("agent_runs_json")) this.db.exec("ALTER TABLE build_tasks ADD COLUMN agent_runs_json TEXT");
    if (!taskNames.has("tool_events_json")) this.db.exec("ALTER TABLE build_tasks ADD COLUMN tool_events_json TEXT");
    if (!taskNames.has("attempts")) this.db.exec("ALTER TABLE build_tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
    const approvalColumns = this.db.prepare("PRAGMA table_info(approvals)").all() as Array<{ name: string }>;
    if (!new Set(approvalColumns.map((c) => c.name)).has("tool_call_id")) {
      this.db.exec("ALTER TABLE approvals ADD COLUMN tool_call_id TEXT");
    }
    // Per-conversation app-state columns.
    const convColumns = this.db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
    const convNames = new Set(convColumns.map((c) => c.name));
    if (!convNames.has("manifest_json")) this.db.exec("ALTER TABLE conversations ADD COLUMN manifest_json TEXT");
    if (!convNames.has("current_snapshot_id")) this.db.exec("ALTER TABLE conversations ADD COLUMN current_snapshot_id TEXT");
    if (!convNames.has("preview_bundle_id")) this.db.exec("ALTER TABLE conversations ADD COLUMN preview_bundle_id TEXT");
    if (!convNames.has("preview_version")) this.db.exec("ALTER TABLE conversations ADD COLUMN preview_version INTEGER NOT NULL DEFAULT 0");
    const artifactColumns = this.db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
    const artifactNames = new Set(artifactColumns.map((c) => c.name));
    if (!artifactNames.has("created_by")) this.db.exec("ALTER TABLE artifacts ADD COLUMN created_by TEXT");
    if (!artifactNames.has("parent_agent_run_id")) this.db.exec("ALTER TABLE artifacts ADD COLUMN parent_agent_run_id TEXT");
    if (!artifactNames.has("schema_version")) this.db.exec("ALTER TABLE artifacts ADD COLUMN schema_version INTEGER");
    if (!artifactNames.has("size_bytes")) this.db.exec("ALTER TABLE artifacts ADD COLUMN size_bytes INTEGER");
    if (!artifactNames.has("artifact_order")) this.db.exec("ALTER TABLE artifacts ADD COLUMN artifact_order INTEGER");
  }

  private mapConversation(row: Record<string, unknown>): ConversationRow {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      title: row.title as string,
      titleSource: (row.title_source as "auto" | "user") ?? "auto",
      status: (row.status as "active" | "archived") ?? "active",
      manifestJson: (row.manifest_json as string | null) ?? null,
      currentSnapshotId: (row.current_snapshot_id as string | null) ?? null,
      previewBundleId: (row.preview_bundle_id as string | null) ?? null,
      previewVersion: Number(row.preview_version ?? 0),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastMessageAt: row.last_message_at == null ? null : Number(row.last_message_at),
    };
  }

  private mapMessage(row: Record<string, unknown>): MessageRow {
    return {
      id: row.id as string,
      conversationId: row.conversation_id as string,
      role: (row.role as MessageRow["role"]) ?? "assistant",
      content: row.content as string,
      status: (row.status as MessageRow["status"]) ?? "completed",
      errorCode: (row.error_code as string | null) ?? null,
      metadataJson: (row.metadata_json as string | null) ?? null,
      taskId: (row.task_id as string | null) ?? null,
      roleId: (row.role_id as string | null) ?? null,
      messageKind: (row.message_kind as MessageRow["messageKind"]) ?? null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private mapTask(row: Record<string, unknown>): TaskRow {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      conversationId: row.conversation_id as string,
      userMessageId: (row.user_message_id as string | null) ?? null,
      prompt: row.prompt as string,
      status: (row.status as TaskRow["status"]) ?? "pending",
      stage: row.stage as string,
      rolesJson: (row.roles_json as string | null) ?? null,
      agentRunsJson: (row.agent_runs_json as string | null) ?? null,
      toolEventsJson: (row.tool_events_json as string | null) ?? null,
      errorCode: (row.error_code as string | null) ?? null,
      errorMessage: (row.error_message as string | null) ?? null,
      attempts: Number(row.attempts ?? 0),
      requestId: (row.request_id as string | null) ?? null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  /** Transaction wrapper: used when the domain layer needs atomic multi-step writes. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ── Project drafts ──

  ensureProject(projectId: string): void {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO projects (id, app_spec_json, product_brief_json, app_blueprint_json, created_at, updated_at) VALUES (?, NULL, NULL, NULL, ?, ?) ON CONFLICT(id) DO NOTHING"
      )
      .run(projectId, now, now);
  }

  getProject(projectId: string): ProjectRow | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      appSpecJson: (row.app_spec_json as string | null) ?? null,
      productBriefJson: (row.product_brief_json as string | null) ?? null,
      appBlueprintJson: (row.app_blueprint_json as string | null) ?? null,
      manifestJson: (row.manifest_json as string | null) ?? null,
      currentSnapshotId: (row.current_snapshot_id as string | null) ?? null,
      previewBundleId: (row.preview_bundle_id as string | null) ?? null,
      previewVersion: Number(row.preview_version ?? 0),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  updateProjectDraft(
    projectId: string,
    patch: {
      appSpecJson?: string | null;
      productBriefJson?: string | null;
      appBlueprintJson?: string | null;
      manifestJson?: string | null;
      currentSnapshotId?: string | null;
      previewBundleId?: string | null;
      previewVersion?: number;
    }
  ): void {
    const current = this.getProject(projectId);
    if (!current) return;
    this.db
      .prepare(
        "UPDATE projects SET app_spec_json = ?, product_brief_json = ?, app_blueprint_json = ?, manifest_json = ?, current_snapshot_id = ?, preview_bundle_id = ?, preview_version = ?, updated_at = ? WHERE id = ?"
      )
      .run(
        patch.appSpecJson !== undefined ? patch.appSpecJson : current.appSpecJson,
        patch.productBriefJson !== undefined ? patch.productBriefJson : current.productBriefJson,
        patch.appBlueprintJson !== undefined ? patch.appBlueprintJson : current.appBlueprintJson,
        patch.manifestJson !== undefined ? patch.manifestJson : current.manifestJson,
        patch.currentSnapshotId !== undefined ? patch.currentSnapshotId : current.currentSnapshotId,
        patch.previewBundleId !== undefined ? patch.previewBundleId : current.previewBundleId,
        patch.previewVersion !== undefined ? patch.previewVersion : current.previewVersion,
        Date.now(),
        projectId
      );
  }

  // ── Conversations ──

  insertConversation(input: {
    id: string;
    projectId: string;
    title: string;
    titleSource: "auto" | "user";
  }): ConversationRow {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO conversations (id, project_id, title, title_source, status, manifest_json, current_snapshot_id, preview_bundle_id, preview_version, created_at, updated_at, last_message_at) VALUES (?, ?, ?, ?, 'active', NULL, NULL, NULL, 0, ?, ?, NULL)"
      )
      .run(input.id, input.projectId, input.title, input.titleSource, now, now);
    return {
      id: input.id,
      projectId: input.projectId,
      title: input.title,
      titleSource: input.titleSource,
      status: "active",
      manifestJson: null,
      currentSnapshotId: null,
      previewBundleId: null,
      previewVersion: 0,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
    };
  }

  getConversation(id: string): ConversationRow | null {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapConversation(row) : null;
  }

  listConversations(projectId: string): ConversationRow[] {
    const rows = this.db
      .prepare("SELECT * FROM conversations WHERE project_id = ? ORDER BY COALESCE(last_message_at, updated_at) DESC")
      .all(projectId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapConversation(r));
  }

  renameConversation(id: string, projectId: string, title: string, titleSource: "auto" | "user"): boolean {
    const result = this.db
      .prepare("UPDATE conversations SET title = ?, title_source = ?, updated_at = ? WHERE id = ? AND project_id = ?")
      .run(title, titleSource, Date.now(), id, projectId);
    return Number(result.changes ?? 0) > 0;
  }

  setConversationStatus(id: string, projectId: string, status: "active" | "archived"): boolean {
    const result = this.db
      .prepare("UPDATE conversations SET status = ?, updated_at = ? WHERE id = ? AND project_id = ?")
      .run(status, Date.now(), id, projectId);
    return Number(result.changes ?? 0) > 0;
  }

  touchConversation(id: string, lastMessageAt: number): void {
    this.db
      .prepare("UPDATE conversations SET updated_at = ?, last_message_at = ? WHERE id = ?")
      .run(Date.now(), lastMessageAt, id);
  }

  /** Update a conversation's app state. */
  updateConversationApp(
    id: string,
    projectId: string,
    patch: {
      manifestJson?: string | null;
      currentSnapshotId?: string | null;
      previewBundleId?: string | null;
      previewVersion?: number;
    }
  ): void {
    const current = this.getConversation(id);
    if (!current || current.projectId !== projectId) return;
    this.db
      .prepare(
        "UPDATE conversations SET manifest_json = ?, current_snapshot_id = ?, preview_bundle_id = ?, preview_version = ?, updated_at = ? WHERE id = ? AND project_id = ?"
      )
      .run(
        patch.manifestJson !== undefined ? patch.manifestJson : current.manifestJson,
        patch.currentSnapshotId !== undefined ? patch.currentSnapshotId : current.currentSnapshotId,
        patch.previewBundleId !== undefined ? patch.previewBundleId : current.previewBundleId,
        patch.previewVersion !== undefined ? patch.previewVersion : current.previewVersion,
        Date.now(),
        id,
        projectId
      );
  }

  /**
   * One-time migration: attach legacy project-level app state (manifest/snapshot/preview/
   * version) to the most recent conversation and clear the project fields. Idempotent —
   * any conversation with app state means it already ran. Legacy drafts (app_spec_json,
   * product_brief_json, app_blueprint_json) are never deleted.
   */
  migrateProjectAppToLatestConversation(projectId: string): void {
    const project = this.getProject(projectId);
    if (!project) return;
    const hasProjectState =
      project.previewBundleId != null || project.currentSnapshotId != null || project.manifestJson != null;
    if (!hasProjectState) return;
    const conversations = this.listConversations(projectId);
    if (conversations.length === 0) return; // no conversation to attach to yet
    if (
      conversations.some(
        (c) => c.previewBundleId != null || c.currentSnapshotId != null || c.manifestJson != null
      )
    ) {
      return; // already migrated
    }
    const target = conversations[0]; // most recently active
    this.updateConversationApp(target.id, projectId, {
      manifestJson: project.manifestJson,
      currentSnapshotId: project.currentSnapshotId,
      previewBundleId: project.previewBundleId,
      previewVersion: project.previewVersion,
    });
    this.updateProjectDraft(projectId, {
      manifestJson: null,
      currentSnapshotId: null,
      previewBundleId: null,
      previewVersion: 0,
    });
  }

  countActiveConversations(projectId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM conversations WHERE project_id = ? AND status = 'active'")
      .get(projectId) as { n: number | bigint } | undefined;
    return Number(row?.n ?? 0);
  }

  deleteConversation(id: string, projectId: string): boolean {
    const conversation = this.getConversation(id);
    if (!conversation || conversation.projectId !== projectId) return false;
    this.db.exec("BEGIN");
    try {
      const taskIds = this.db.prepare("SELECT id FROM build_tasks WHERE conversation_id = ?").all(id) as Array<{ id: string }>;
      this.db.prepare("DELETE FROM build_tasks WHERE conversation_id = ?").run(id);
      for (const task of taskIds) this.db.prepare("DELETE FROM approvals WHERE task_id = ?").run(task.id);
      this.db.prepare("DELETE FROM conversation_messages WHERE conversation_id = ?").run(id);
      this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ── Messages ──

  insertMessage(input: {
    id: string;
    conversationId: string;
    role: "user" | "assistant" | "system";
    content: string;
    status: "pending" | "streaming" | "completed" | "error";
    errorCode?: string | null;
    metadataJson?: string | null;
    requestId?: string | null;
    taskId?: string | null;
    roleId?: string | null;
    messageKind?: "role" | "error" | null;
  }): MessageRow {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO conversation_messages (id, conversation_id, role, content, status, error_code, metadata_json, request_id, task_id, role_id, message_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        input.id,
        input.conversationId,
        input.role,
        input.content,
        input.status,
        input.errorCode ?? null,
        input.metadataJson ?? null,
        input.requestId ?? null,
        input.taskId ?? null,
        input.roleId ?? null,
        input.messageKind ?? null,
        now,
        now
      );
    return {
      id: input.id,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      status: input.status,
      errorCode: input.errorCode ?? null,
      metadataJson: input.metadataJson ?? null,
      taskId: input.taskId ?? null,
      roleId: input.roleId ?? null,
      messageKind: input.messageKind ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  getMessageByRequestId(conversationId: string, requestId: string): MessageRow | null {
    const row = this.db
      .prepare("SELECT * FROM conversation_messages WHERE conversation_id = ? AND request_id = ?")
      .get(conversationId, requestId) as Record<string, unknown> | undefined;
    return row ? this.mapMessage(row) : null;
  }

  listMessages(conversationId: string, before: number | null, limit: number): MessageRow[] {
    const rows = before
      ? (this.db
          .prepare(
            "SELECT * FROM conversation_messages WHERE conversation_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?"
          )
          .all(conversationId, before, limit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare("SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?")
          .all(conversationId, limit) as Array<Record<string, unknown>>);
    return rows.reverse().map((r) => this.mapMessage(r));
  }

  countMessages(conversationId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id = ?")
      .get(conversationId) as { n: number | bigint } | undefined;
    return Number(row?.n ?? 0);
  }

  upsertRoleMessage(input: {
    id: string;
    conversationId: string;
    taskId: string;
    roleId: string;
    content: string;
    status: "completed" | "error";
    errorCode?: string | null;
    metadataJson?: string | null;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO conversation_messages (id, conversation_id, role, content, status, error_code, metadata_json, task_id, role_id, message_kind, created_at, updated_at) VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, 'role', ?, ?) ON CONFLICT(id) DO NOTHING"
      )
      .run(
        input.id,
        input.conversationId,
        input.content,
        input.status,
        input.errorCode ?? null,
        input.metadataJson ?? null,
        input.taskId,
        input.roleId,
        now,
        now
      );
    this.db
      .prepare(
        "UPDATE conversation_messages SET content = ?, status = ?, error_code = ?, metadata_json = ?, updated_at = ? WHERE conversation_id = ? AND task_id = ? AND role_id = ? AND message_kind = 'role'"
      )
      .run(input.content, input.status, input.errorCode ?? null, input.metadataJson ?? null, now, input.conversationId, input.taskId, input.roleId);
  }

  upsertTaskError(input: {
    id: string;
    conversationId: string;
    taskId: string;
    roleId: string | null;
    content: string;
    errorCode: string | null;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO conversation_messages (id, conversation_id, role, content, status, error_code, metadata_json, task_id, role_id, message_kind, created_at, updated_at) VALUES (?, ?, 'assistant', ?, 'error', ?, ?, ?, ?, 'error', ?, ?) ON CONFLICT(id) DO NOTHING"
      )
      .run(
        input.id,
        input.conversationId,
        input.content,
        input.errorCode,
        JSON.stringify({ kind: "error", taskId: input.taskId, roleId: input.roleId }),
        input.taskId,
        input.roleId,
        now,
        now
      );
    this.db
      .prepare(
        "UPDATE conversation_messages SET content = ?, error_code = ?, metadata_json = ?, updated_at = ? WHERE conversation_id = ? AND task_id = ? AND message_kind = 'error'"
      )
      .run(
        input.content,
        input.errorCode,
        JSON.stringify({ kind: "error", taskId: input.taskId, roleId: input.roleId }),
        now,
        input.conversationId,
        input.taskId
      );
  }

  // ── Build tasks ──

  insertTask(input: {
    id: string;
    projectId: string;
    conversationId: string;
    userMessageId: string | null;
    prompt: string;
    requestId: string;
  }): TaskRow {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO build_tasks (id, project_id, conversation_id, user_message_id, prompt, status, stage, roles_json, error_code, error_message, request_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 'idle', ?, NULL, NULL, ?, ?, ?)"
      )
      .run(
        input.id,
        input.projectId,
        input.conversationId,
        input.userMessageId,
        input.prompt,
        JSON.stringify({
          team_leader: { status: "pending", summary: null, startedAt: null, completedAt: null },
          product_manager: { status: "pending", summary: null, startedAt: null, completedAt: null },
          engineer: { status: "pending", summary: null, startedAt: null, completedAt: null },
        }),
        input.requestId,
        now,
        now
      );
    return this.getTask(input.id)!;
  }

  getTask(id: string): TaskRow | null {
    const row = this.db.prepare("SELECT * FROM build_tasks WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapTask(row) : null;
  }

  getTaskByRequestId(requestId: string): TaskRow | null {
    const row = this.db.prepare("SELECT * FROM build_tasks WHERE request_id = ?").get(requestId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapTask(row) : null;
  }

  listTasks(conversationId: string, limit: number): TaskRow[] {
    const rows = this.db
      .prepare("SELECT * FROM build_tasks WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(conversationId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapTask(r));
  }

  findRunningTask(projectId: string): TaskRow | null {
    const row = this.db
      .prepare("SELECT * FROM build_tasks WHERE project_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1")
      .get(projectId) as Record<string, unknown> | undefined;
    return row ? this.mapTask(row) : null;
  }

  updateTask(
    id: string,
    patch: {
      status?: TaskRow["status"];
      stage?: string;
      rolesJson?: string | null;
      agentRunsJson?: string | null;
      toolEventsJson?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      attempts?: number;
    }
  ): void {
    const current = this.getTask(id);
    if (!current) return;
    this.db
      .prepare(
        "UPDATE build_tasks SET status = ?, stage = ?, roles_json = ?, agent_runs_json = ?, tool_events_json = ?, error_code = ?, error_message = ?, attempts = ?, updated_at = ? WHERE id = ?"
      )
      .run(
        patch.status ?? current.status,
        patch.stage ?? current.stage,
        patch.rolesJson !== undefined ? patch.rolesJson : current.rolesJson,
        patch.agentRunsJson !== undefined ? patch.agentRunsJson : current.agentRunsJson,
        patch.toolEventsJson !== undefined ? patch.toolEventsJson : current.toolEventsJson,
        patch.errorCode !== undefined ? patch.errorCode : current.errorCode,
        patch.errorMessage !== undefined ? patch.errorMessage : current.errorMessage,
        patch.attempts ?? current.attempts,
        Date.now(),
        id
      );
  }

  /** Remove a task's stale error cards before a retry. */
  removeTaskErrors(taskId: string): void {
    this.db
      .prepare("DELETE FROM conversation_messages WHERE task_id = ? AND metadata_json LIKE '%\"kind\":\"error\"%'")
      .run(taskId);
  }

  /** Remove a task's previous role messages (retry re-upserts them). */
  removeTaskRoleMessages(taskId: string): void {
    this.db
      .prepare("DELETE FROM conversation_messages WHERE task_id = ? AND message_kind = 'role'")
      .run(taskId);
  }

  /** Stale task recovery: tasks running past the threshold are marked as recoverable failures. */
  markStaleRunningTasks(projectId: string, staleBefore: number): number {
    const result = this.db
      .prepare(
        "UPDATE build_tasks SET status = 'failed', stage = 'failed', error_code = 'STALE', error_message = '会话中断（页面刷新或连接断开），可重试。', updated_at = ? WHERE project_id = ? AND status = 'running' AND updated_at < ?"
      )
      .run(Date.now(), projectId, staleBefore);
    this.db.prepare("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE project_id = ? AND status = 'pending'").run(Date.now(), projectId);
    return Number(result.changes ?? 0);
  }

  /** Reset project: clears conversations/messages/tasks/drafts/records/sandbox sessions. */
  clearProject(projectId: string): void {
    this.db.exec("BEGIN");
    try {
      const conversationIds = this.db
        .prepare("SELECT id FROM conversations WHERE project_id = ?")
        .all(projectId) as Array<{ id: string }>;
      for (const row of conversationIds) {
        this.db.prepare("DELETE FROM build_tasks WHERE conversation_id = ?").run(row.id);
        this.db.prepare("DELETE FROM conversation_messages WHERE conversation_id = ?").run(row.id);
      }
      this.db.prepare("DELETE FROM conversations WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM sandbox_sessions WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM app_records WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM code_snapshots WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM artifacts WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM approvals WHERE project_id = ?").run(projectId);
      this.db
        .prepare(
          "UPDATE projects SET app_spec_json = NULL, product_brief_json = NULL, app_blueprint_json = NULL, manifest_json = NULL, current_snapshot_id = NULL, preview_bundle_id = NULL, preview_version = 0, updated_at = ? WHERE id = ?"
        )
        .run(Date.now(), projectId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ── Sandbox sessions ──

  createSession(input: {
    id: string;
    projectId: string;
    appId: string;
    appVersion: number;
    collectionsJson: string;
    expiresAt: number;
  }): SessionRow {
    const createdAt = Date.now();
    this.db
      .prepare(
        "INSERT INTO sandbox_sessions (id, project_id, app_id, app_version, collections_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(input.id, input.projectId, input.appId, input.appVersion, input.collectionsJson, createdAt, input.expiresAt);
    return {
      id: input.id,
      projectId: input.projectId,
      appId: input.appId,
      appVersion: input.appVersion,
      collectionsJson: input.collectionsJson,
      createdAt,
      expiresAt: input.expiresAt,
    };
  }

  getSession(id: string): SessionRow | null {
    const row = this.db.prepare("SELECT * FROM sandbox_sessions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      appId: row.app_id as string,
      appVersion: Number(row.app_version),
      collectionsJson: row.collections_json as string,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    };
  }

  setSessionExpiry(id: string, expiresAt: number): void {
    this.db.prepare("UPDATE sandbox_sessions SET expires_at = ? WHERE id = ?").run(expiresAt, id);
  }

  deleteExpiredSessions(now: number): number {
    const result = this.db.prepare("DELETE FROM sandbox_sessions WHERE expires_at <= ?").run(now);
    return Number(result.changes ?? 0);
  }

  // ── Business records ──

  countRecords(projectId: string, appId: string, collection: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM app_records WHERE project_id = ? AND app_id = ? AND collection = ?")
      .get(projectId, appId, collection) as { n: number | bigint } | undefined;
    return Number(row?.n ?? 0);
  }

  listRecords(projectId: string, appId: string, collection: string): RecordRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM app_records WHERE project_id = ? AND app_id = ? AND collection = ? ORDER BY created_at DESC, id DESC"
      )
      .all(projectId, appId, collection) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      projectId: row.project_id as string,
      appId: row.app_id as string,
      collection: row.collection as string,
      dataJson: row.data_json as string,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  getRecordById(id: string): RecordRow | null {
    const row = this.db.prepare("SELECT * FROM app_records WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      appId: row.app_id as string,
      collection: row.collection as string,
      dataJson: row.data_json as string,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  insertRecord(input: {
    id: string;
    projectId: string;
    appId: string;
    collection: string;
    dataJson: string;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO app_records (id, project_id, app_id, collection, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(input.id, input.projectId, input.appId, input.collection, input.dataJson, now, now);
  }

  updateRecord(input: {
    id: string;
    projectId: string;
    appId: string;
    collection: string;
    dataJson: string;
  }): boolean {
    const result = this.db
      .prepare(
        "UPDATE app_records SET data_json = ?, updated_at = ? WHERE id = ? AND project_id = ? AND app_id = ? AND collection = ?"
      )
      .run(input.dataJson, Date.now(), input.id, input.projectId, input.appId, input.collection);
    return Number(result.changes ?? 0) > 0;
  }

  deleteRecord(input: { id: string; projectId: string; appId: string; collection: string }): boolean {
    const result = this.db
      .prepare("DELETE FROM app_records WHERE id = ? AND project_id = ? AND app_id = ? AND collection = ?")
      .run(input.id, input.projectId, input.appId, input.collection);
    return Number(result.changes ?? 0) > 0;
  }

  // ── Code snapshots (immutable promoted versions) ──

  createCodeSnapshot(input: {
    id: string;
    projectId: string;
    taskId: string;
    version: number;
    manifestJson: string;
    filesJson: string;
    depsJson: string;
    buildReportJson?: string | null;
    testReportJson?: string | null;
    reviewReportJson?: string | null;
    previewBundleId?: string | null;
  }): CodeSnapshotRow {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO code_snapshots (id, project_id, task_id, version, manifest_json, files_json, deps_json, build_report_json, test_report_json, review_report_json, preview_bundle_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        input.id,
        input.projectId,
        input.taskId,
        input.version,
        input.manifestJson,
        input.filesJson,
        input.depsJson,
        input.buildReportJson ?? null,
        input.testReportJson ?? null,
        input.reviewReportJson ?? null,
        input.previewBundleId ?? null,
        now
      );
    return {
      id: input.id,
      projectId: input.projectId,
      taskId: input.taskId,
      version: input.version,
      manifestJson: input.manifestJson,
      filesJson: input.filesJson,
      depsJson: input.depsJson,
      buildReportJson: input.buildReportJson ?? null,
      testReportJson: input.testReportJson ?? null,
      reviewReportJson: input.reviewReportJson ?? null,
      previewBundleId: input.previewBundleId ?? null,
      createdAt: now,
    };
  }

  getCodeSnapshot(id: string): CodeSnapshotRow | null {
    const row = this.db.prepare("SELECT * FROM code_snapshots WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      taskId: row.task_id as string,
      version: Number(row.version),
      manifestJson: row.manifest_json as string,
      filesJson: row.files_json as string,
      depsJson: row.deps_json as string,
      buildReportJson: (row.build_report_json as string | null) ?? null,
      testReportJson: (row.test_report_json as string | null) ?? null,
      reviewReportJson: (row.review_report_json as string | null) ?? null,
      previewBundleId: (row.preview_bundle_id as string | null) ?? null,
      createdAt: Number(row.created_at),
    };
  }

  getLatestSnapshot(projectId: string): CodeSnapshotRow | null {
    const row = this.db
      .prepare("SELECT * FROM code_snapshots WHERE project_id = ? ORDER BY version DESC LIMIT 1")
      .get(projectId) as Record<string, unknown> | undefined;
    return row ? this.getCodeSnapshot(row.id as string) : null;
  }

  // ── Persisted artifacts ──

  private mapArtifact(row: Record<string, unknown>): ArtifactRow {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      taskId: (row.task_id as string | null) ?? null,
      kind: row.kind as string,
      name: row.name as string,
      content: row.content as string,
      createdBy: (row.created_by as string | null) ?? null,
      parentAgentRunId: (row.parent_agent_run_id as string | null) ?? null,
      schemaVersion: row.schema_version == null ? null : Number(row.schema_version),
      sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
      artifactOrder: row.artifact_order == null ? null : Number(row.artifact_order),
      createdAt: Number(row.created_at),
    };
  }

  insertArtifact(input: {
    id: string;
    projectId: string;
    taskId: string | null;
    kind: string;
    name: string;
    content: string;
  }): ArtifactRow {
    const now = Date.now();
    this.db
      .prepare("INSERT INTO artifacts (id, project_id, task_id, kind, name, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(input.id, input.projectId, input.taskId, input.kind, input.name, input.content, now);
    return this.getArtifact(input.id)!;
  }

  getArtifact(id: string): ArtifactRow | null {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return this.mapArtifact(row);
  }

  getLatestArtifact(projectId: string, kind: string): ArtifactRow | null {
    const row = this.db
      .prepare("SELECT * FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1")
      .get(projectId, kind) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapArtifact(row);
  }

  /** Latest artifact for a conversation (joined through build_tasks). */
  getLatestArtifactForConversation(projectId: string, conversationId: string, kind: string): ArtifactRow | null {
    const row = this.db
      .prepare(
        "SELECT a.* FROM artifacts a JOIN build_tasks t ON a.task_id = t.id WHERE a.project_id = ? AND a.kind = ? AND t.conversation_id = ? ORDER BY a.created_at DESC LIMIT 1"
      )
      .get(projectId, kind, conversationId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapArtifact(row);
  }

  /** Persist the orchestrator's run-scoped artifact entries without a local JSON sidecar. */
  upsertArtifactEntries(taskId: string, projectId: string, entries: Array<{
    ref: { id: string; kind: string; createdBy: string; parentAgentRunId: string | null; schemaVersion: number; size: number };
    value: unknown;
  }>): void {
    const now = Date.now();
    const statement = this.db.prepare(
      "INSERT INTO artifacts (id, project_id, task_id, kind, name, content, created_by, parent_agent_run_id, schema_version, size_bytes, artifact_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content, kind = excluded.kind, name = excluded.name, created_by = excluded.created_by, parent_agent_run_id = excluded.parent_agent_run_id, schema_version = excluded.schema_version, size_bytes = excluded.size_bytes, artifact_order = excluded.artifact_order, created_at = excluded.created_at"
    );
    this.transaction(() => {
      entries.forEach((entry, index) => {
        statement.run(
          entry.ref.id,
          projectId,
          taskId,
          entry.ref.kind,
          entry.ref.kind,
          JSON.stringify(entry.value),
          entry.ref.createdBy,
          entry.ref.parentAgentRunId,
          entry.ref.schemaVersion,
          entry.ref.size,
          index,
          now + index,
        );
      });
    });
  }

  /** Restore only orchestrator entries; UI-only artifacts without ref metadata are ignored. */
  listArtifactEntries(taskId: string): Array<{ ref: { id: string; kind: ArtifactKind; createdBy: RoleId; parentAgentRunId: string | null; schemaVersion: number; size: number }; value: unknown }> {
    const rows = this.db.prepare("SELECT * FROM artifacts WHERE task_id = ? AND created_by IS NOT NULL ORDER BY artifact_order ASC, created_at ASC, id ASC").all(taskId) as Array<Record<string, unknown>>;
    const entries: Array<{ ref: { id: string; kind: ArtifactKind; createdBy: RoleId; parentAgentRunId: string | null; schemaVersion: number; size: number }; value: unknown }> = [];
    for (const row of rows) {
      try {
        entries.push({
          ref: {
            id: row.id as string,
            kind: row.kind as ArtifactKind,
            createdBy: row.created_by as RoleId,
            parentAgentRunId: (row.parent_agent_run_id as string | null) ?? null,
            schemaVersion: Number(row.schema_version ?? 1),
            size: Number(row.size_bytes ?? 0),
          },
          value: JSON.parse(row.content as string) as unknown,
        });
      } catch {
        // Ignore corrupted entries; the next run will regenerate them.
      }
    }
    return entries;
  }

  deleteProjectArtifacts(projectId: string): void {
    this.db.prepare("DELETE FROM artifacts WHERE project_id = ?").run(projectId);
  }

  deleteProjectSnapshots(projectId: string): void {
    this.db.prepare("DELETE FROM code_snapshots WHERE project_id = ?").run(projectId);
  }

  // ── Durable tool approvals ──

  private mapApproval(row: Record<string, unknown>): ApprovalRow {
    return {
      id: row.id as string,
      projectId: (row.project_id as string | null) ?? null,
      taskId: (row.task_id as string | null) ?? null,
      runId: row.run_id as string,
      toolCallId: (row.tool_call_id as string | null) ?? null,
      toolName: row.tool_name as string,
      reason: row.reason as string,
      status: row.status as ApprovalStatus,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      resolvedAt: row.resolved_at == null ? null : Number(row.resolved_at),
      resolvedBy: (row.resolved_by as string | null) ?? null,
    };
  }

  createApproval(input: {
    id: string;
    projectId: string | null;
    taskId: string | null;
    runId: string;
    toolCallId?: string | null;
    toolName: string;
    reason: string;
    expiresAt: number;
  }): ApprovalRow {
    const now = Date.now();
    this.db.prepare(
      "INSERT INTO approvals (id, project_id, task_id, run_id, tool_call_id, tool_name, reason, status, created_at, expires_at, resolved_at, resolved_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL)"
    ).run(input.id, input.projectId, input.taskId, input.runId, input.toolCallId ?? null, input.toolName, input.reason, now, input.expiresAt);
    return this.getApproval(input.id)!;
  }

  getApproval(id: string): ApprovalRow | null {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (row.status === "pending" && Number(row.expires_at) <= Date.now()) {
      this.db.prepare("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'").run(Date.now(), id);
      row.status = "expired";
      row.resolved_at = Date.now();
    }
    return this.mapApproval(row);
  }

  resolveApproval(id: string, status: "granted" | "denied", resolvedBy: string | null = null): ApprovalRow | null {
    const current = this.getApproval(id);
    if (!current || current.status !== "pending") return null;
    const now = Date.now();
    this.db.prepare("UPDATE approvals SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ? AND status = 'pending'").run(status, now, resolvedBy, id);
    return this.getApproval(id);
  }

  getLatestApproval(runId: string, toolName: string): ApprovalRow | null {
    const rows = this.db.prepare("SELECT * FROM approvals WHERE run_id = ? AND tool_name = ? ORDER BY created_at DESC LIMIT 1").all(runId, toolName) as Array<Record<string, unknown>>;
    if (rows.length === 0) return null;
    return this.getApproval(rows[0].id as string);
  }

  listPendingApprovals(taskId: string): ApprovalRow[] {
    const rows = this.db.prepare("SELECT * FROM approvals WHERE task_id = ? AND status = 'pending' ORDER BY created_at ASC").all(taskId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.getApproval(row.id as string)).filter((row): row is ApprovalRow => row !== null && row.status === "pending");
  }

  expirePendingApprovals(taskId: string): number {
    const result = this.db.prepare("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE task_id = ? AND status = 'pending'").run(Date.now(), taskId);
    return Number(result.changes ?? 0);
  }

  clearApprovalsForTests(): void {
    this.db.exec("DELETE FROM approvals");
  }

  close(): void {
    this.db.close();
  }
}

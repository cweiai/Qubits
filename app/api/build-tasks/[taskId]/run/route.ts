import path from "node:path";
import { NextRequest } from "next/server";
import { qubitsManifestSchema, type QubitsManifest } from "@/lib/contracts/manifest";
import { runMikeOrchestrator } from "@/lib/ai/mike-orchestrator";
import { buildResumeContext, type ResumeSource } from "@/lib/ai/resume-context";
import { getRepository } from "@/lib/db";
import { newProjectId, readProjectId } from "@/lib/sandbox/server-session";
import { ApiError, apiErrorResponse } from "@/lib/server/api-response";
import { toTaskJson } from "@/lib/server/conversation-io";
import type { AgentEvent } from "@/lib/contracts/agent-events";
import { initWorkspace } from "@/lib/workspace/workspace-manager";
import { createCodeSnapshot, snapshotDirFor } from "@/lib/workspace/snapshot";
import { legacyManifestFromJson } from "@/lib/workspace/legacy-convert";
import { composeAbortSignals, registerRun, unregisterRun } from "@/lib/ai/run-registry";
import type { PromoteRunInput } from "@/lib/ai/tools/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type RouteContext = { params: Promise<{ taskId: string }> };

/**
 * POST /api/build-tasks/:taskId/run
 * Real Tool Calling orchestration entry: every run's first agent event must be Mike (team_leader).
 * Sub-agents, preview, and completion are all driven by Mike's real tool calls;
 * preview_ready is the sole writer of the current preview (persisted code bundle + manifest),
 * run_completed (via complete_run) promotes the immutable snapshot as the project version.
 */

function parseJsonArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const ROLE_STAGE: Record<string, string> = {
  team_leader: "planning",
  product_manager: "planning",
  engineer: "coding",
};

const VALIDATING_TOOLS = new Set(["run_lint", "run_typecheck", "run_tests", "run_build", "security_scan", "get_build_errors", "get_test_failures"]);

function withRolePatch(roles: Record<string, unknown>, roleId: string, patch: Record<string, unknown>): string {
  const next = { ...roles, [roleId]: { ...((roles[roleId] as Record<string, unknown>) ?? {}), ...patch } };
  return JSON.stringify(next);
}

export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  const requestId = "req-" + crypto.randomUUID();
  // The run handle must outlive the stream setup (cleanup path in the outer catch).
  let runHandle: ReturnType<typeof registerRun> | null = null;
  let runSettled = false;
  let taskId = "";
  try {
    const params = await context.params;
    taskId = params.taskId;
    const repo = getRepository();
    const projectId = readProjectId(request) ?? newProjectId();
    const task = repo.getTask(taskId);
    if (!task || task.projectId !== projectId) {
      return apiErrorResponse(new ApiError("TASK_NOT_FOUND", "构建任务不存在", 404), requestId);
    }
    const conversation = repo.getConversation(task.conversationId);
    if (!conversation || conversation.projectId !== projectId) {
      return apiErrorResponse(new ApiError("CONVERSATION_NOT_FOUND", "对话不存在", 404), requestId);
    }
    if (conversation.status === "archived") {
      return apiErrorResponse(new ApiError("CONVERSATION_ARCHIVED", "归档对话不能执行生成任务", 403), requestId);
    }

    const project = repo.getProject(projectId);
    // App state lives on the conversation, not the project. Legacy AppSpec data stays
    // read-only; it is converted to a manifest once and attached to this conversation.
    let currentManifest: QubitsManifest | null = null;
    if (conversation.manifestJson) {
      try {
        const parsed = qubitsManifestSchema.safeParse(JSON.parse(conversation.manifestJson));
        currentManifest = parsed.success ? parsed.data : null;
      } catch {
        currentManifest = null;
      }
    }
    if (!currentManifest && project?.appSpecJson) {
      const converted = legacyManifestFromJson(project.appSpecJson);
      if (converted) {
        currentManifest = converted;
        repo.updateConversationApp(conversation.id, projectId, { manifestJson: JSON.stringify(converted) });
      }
    }
    // Data scope: legacy manifests carry appId; new apps are isolated per conversation.
    const currentAppId = currentManifest?.appId ?? conversation.id;
    const latestSnapshot = conversation.currentSnapshotId
      ? repo.getCodeSnapshot(conversation.currentSnapshotId)
      : null;
    const currentVersion = conversation.previewVersion;

    // Records authorized for the current app (used by data tools)
    let projectRecords: Array<Record<string, unknown>> | null = null;
    if (currentManifest) {
      const collection = currentManifest.collections[0]?.name;
      if (collection) {
        projectRecords = repo
          .listRecords(projectId, currentAppId, collection)
          .map((row) => {
            try {
              return { id: row.id, ...(JSON.parse(row.dataJson) as Record<string, unknown>) };
            } catch {
              return { id: row.id };
            }
          });
      }
    }

    // attempts>0 means a retry: keep history/workspace and continue from the failure.
    const isRetry = (task.attempts ?? 0) > 0;
    if (isRetry) {
      repo.removeTaskErrors(task.id);
      repo.removeTaskRoleMessages(task.id);
    }
    repo.updateTask(task.id, {
      status: "running",
      stage: "planning",
      errorCode: null,
      errorMessage: null,
      ...(isRetry ? {} : { rolesJson: "{}", agentRunsJson: "[]", toolEventsJson: "[]" }),
    });
    // Register the run handle immediately so conversation deletion can always find it.
    runHandle = registerRun(task.id);
    const resumeContext = isRetry
      ? buildResumeContext({
          attempts: task.attempts,
          errorCode: task.errorCode,
          errorMessage: task.errorMessage,
          agentRuns: parseJsonArray(task.agentRunsJson) as ResumeSource["agentRuns"],
          toolEvents: parseJsonArray(task.toolEventsJson) as ResumeSource["toolEvents"],
        })
      : null;

    // Workspace per task: seeded idempotently from the last successful snapshot (or the trusted
    // template for the first generation). Retries reuse the same workspace — files are kept.
    const workspaceDir = path.join(process.cwd(), "data", "workspaces", task.id);
    const snapshotSourceDir = latestSnapshot ? snapshotDirFor(projectId, latestSnapshot.id) : null;
    initWorkspace(workspaceDir, { taskId, sourceDir: snapshotSourceDir });

    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let rolesJson = isRetry ? (task.rolesJson ?? "{}") : "{}";
    let agentRuns: unknown[] = isRetry ? parseJsonArray(task.agentRunsJson) : [];
    let toolEvents: unknown[] = isRetry ? parseJsonArray(task.toolEventsJson) : [];

    const promoteRun = async (input: PromoteRunInput): Promise<{ snapshotId: string; version: number }> => {
      const snapshot = await createCodeSnapshot(projectId, input.workspaceDir);
      const fresh = repo.getConversation(task.conversationId);
      const version = fresh?.previewVersion ?? (currentVersion + 1);
      repo.createCodeSnapshot({
        id: snapshot.snapshotId,
        projectId,
        taskId,
        version,
        manifestJson: JSON.stringify(input.manifest),
        filesJson: JSON.stringify(snapshot.files),
        depsJson: JSON.stringify(input.manifest.dependencies),
        buildReportJson: input.buildReport != null ? JSON.stringify(input.buildReport) : null,
        testReportJson: input.testReport != null ? JSON.stringify(input.testReport) : null,
        reviewReportJson: input.reviewReport != null ? JSON.stringify(input.reviewReport) : null,
        previewBundleId: fresh?.previewBundleId ?? null,
      });
      // Promote the snapshot as this conversation's version.
      repo.updateConversationApp(task.conversationId, projectId, { currentSnapshotId: snapshot.snapshotId });
      return { snapshotId: snapshot.snapshotId, version };
    };

    const send = (event: AgentEvent): void => {
      try {
        const now = Date.now();
        switch (event.type) {
          case "agent_started": {
            rolesJson = withRolePatch(JSON.parse(rolesJson), event.roleId, { status: "running", startedAt: now });
            agentRuns = [...agentRuns.filter((r) => (r as { agentRunId: string }).agentRunId !== event.agentRunId), { agentRunId: event.agentRunId, roleId: event.roleId, parentAgentRunId: event.parentAgentRunId, status: "running", taskSummary: event.taskSummary, at: now }];
            repo.updateTask(task.id, { stage: ROLE_STAGE[event.roleId] ?? "planning", rolesJson, agentRunsJson: JSON.stringify(agentRuns) });
            break;
          }
          case "agent_delegated": {
            agentRuns = [...agentRuns, { agentRunId: event.childAgentRunId, roleId: event.targetRole, parentAgentRunId: event.parentAgentRunId, status: "pending", taskSummary: event.taskSummary, delegationId: event.delegationId, at: now }];
            repo.updateTask(task.id, { agentRunsJson: JSON.stringify(agentRuns) });
            break;
          }
          case "agent_completed": {
            rolesJson = withRolePatch(JSON.parse(rolesJson), event.roleId, { status: "success", summary: event.summary, completedAt: now });
            agentRuns = agentRuns.map((r) => ((r as { agentRunId: string }).agentRunId === event.agentRunId ? { ...(r as object), status: "completed", summary: event.summary, artifactId: event.artifactId ?? null } : r));
            repo.upsertRoleMessage({
              id: "msg-" + crypto.randomUUID(),
              conversationId: task.conversationId,
              taskId: task.id,
              roleId: event.roleId,
              content: event.summary,
              status: "completed",
              metadataJson: JSON.stringify({ kind: "role", roleId: event.roleId, artifactId: event.artifactId ?? null, taskId: task.id }),
            });
            repo.updateTask(task.id, { rolesJson, agentRunsJson: JSON.stringify(agentRuns) });
            repo.touchConversation(task.conversationId, now);
            break;
          }
          case "agent_failed": {
            rolesJson = withRolePatch(JSON.parse(rolesJson), event.roleId, { status: "error", summary: event.message, completedAt: now });
            agentRuns = agentRuns.map((r) => ((r as { agentRunId: string }).agentRunId === event.agentRunId ? { ...(r as object), status: "failed", errorMessage: event.message } : r));
            repo.updateTask(task.id, { rolesJson, agentRunsJson: JSON.stringify(agentRuns) });
            repo.touchConversation(task.conversationId, now);
            break;
          }
          case "progress_summary": {
            // Only the bounded summary is persisted; raw reasoning_content never enters task state.
            rolesJson = withRolePatch(JSON.parse(rolesJson), event.roleId, { summary: event.summary });
            agentRuns = agentRuns.map((r) => ((r as { agentRunId: string }).agentRunId === event.agentRunId
              ? { ...(r as object), summary: event.summary }
              : r));
            repo.updateTask(task.id, {
              stage: event.phase,
              rolesJson,
              agentRunsJson: JSON.stringify(agentRuns),
            });
            break;
          }
          case "tool_call_started":
            toolEvents = [...toolEvents, { toolCallId: event.toolCallId, agentRunId: event.agentRunId, roleId: event.roleId, toolName: event.toolName, inputSummary: event.inputSummary, status: "running", at: now }];
            repo.updateTask(task.id, { toolEventsJson: JSON.stringify(toolEvents.slice(-200)) });
            break;
          case "tool_result":
            toolEvents = toolEvents.map((t) => ((t as { toolCallId: string }).toolCallId === event.toolCallId ? { ...(t as object), status: event.ok ? "success" : "failed", resultSummary: event.resultSummary, errorCode: event.errorCode ?? null } : t));
            // Real validation events: build/check tools move the pipeline to "validating"
            if (VALIDATING_TOOLS.has(event.toolName)) {
              repo.updateTask(task.id, { stage: "validating", toolEventsJson: JSON.stringify(toolEvents.slice(-200)) });
            } else {
              repo.updateTask(task.id, { stage: ROLE_STAGE[event.roleId] ?? "planning", toolEventsJson: JSON.stringify(toolEvents.slice(-200)) });
            }
            break;
          case "reference_found":
            toolEvents = [...toolEvents, { toolCallId: "ref:" + event.resultId, roleId: "team_leader", toolName: "search_references", status: "success", reference: event, at: now }];
            repo.updateTask(task.id, { toolEventsJson: JSON.stringify(toolEvents.slice(-200)) });
            break;
          case "approval_requested":
            toolEvents = [...toolEvents, {
              toolCallId: event.toolCallId,
              roleId: "team_leader",
              toolName: event.toolName,
              status: "running",
              inputSummary: event.reason,
              approvalId: event.approvalId,
              at: now,
            }];
            repo.updateTask(task.id, { stage: "awaiting_approval", toolEventsJson: JSON.stringify(toolEvents.slice(-200)) });
            break;
          case "preview_requested":
            repo.updateTask(task.id, { stage: "previewing" });
            break;
          case "preview_ready": {
            // The artifact store has already persisted the real bundle before this event.
            const artifact = repo.getArtifact(event.previewArtifactId);
            if (!artifact || artifact.projectId !== projectId || artifact.kind !== "preview_bundle") {
              throw new Error("preview_ready 引用的预览产物不存在");
            }
            repo.updateConversationApp(task.conversationId, projectId, {
              manifestJson: JSON.stringify(event.manifest),
              previewBundleId: event.previewArtifactId,
              previewVersion: event.version,
            });
            repo.insertMessage({
              id: "msg-" + crypto.randomUUID(),
              conversationId: task.conversationId,
              role: "system",
              content: "应用「" + event.appName + "」已通过构建、测试与安全扫描并更新预览（v" + event.version + "）。",
              status: "completed",
              taskId: task.id,
              metadataJson: JSON.stringify({ kind: "system", taskId: task.id, previewVersion: event.version }),
            });
            repo.updateTask(task.id, { stage: "previewing" });
            repo.touchConversation(task.conversationId, now);
            break;
          }
          case "run_completed": {
            rolesJson = withRolePatch(JSON.parse(rolesJson), "team_leader", { status: "success", summary: event.summary, completedAt: now });
            agentRuns = agentRuns.map((r) => ((r as { roleId: string }).roleId === "team_leader" ? { ...(r as object), status: "completed", summary: event.summary } : r));
            repo.updateTask(task.id, { status: "ready", stage: "ready", rolesJson, agentRunsJson: JSON.stringify(agentRuns) });
            repo.touchConversation(task.conversationId, now);
            break;
          }
          case "error":
            rolesJson = withRolePatch(JSON.parse(rolesJson), event.roleId ?? "engineer", { status: "error", summary: event.message, completedAt: now });
            repo.upsertTaskError({
              id: "msg-" + crypto.randomUUID(),
              conversationId: task.conversationId,
              taskId: task.id,
              roleId: event.roleId ?? null,
              content: event.message,
              errorCode: event.code ?? "BUILD_FAILED",
            });
            repo.updateTask(task.id, { status: "failed", stage: "failed", rolesJson, errorCode: event.code ?? "BUILD_FAILED", errorMessage: event.message, agentRunsJson: JSON.stringify(agentRuns) });
            repo.touchConversation(task.conversationId, now);
            break;
          case "role_started":
          case "role_completed":
          case "app_ready":
          case "done":
            // Legacy event compat: not emitted by the new path
            break;
        }
        streamController?.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      } catch {
        // Stream already closed, ignore
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        streamController = controller;
        const activeHandle = runHandle!; // registered before the stream starts
        const signal = composeAbortSignals(request.signal, activeHandle.controller.signal);
        try {
          // Failures surface via the error event above; the orchestrator's return value is otherwise unused.
          await runMikeOrchestrator({
            prompt: task.prompt,
            projectId,
            taskId: task.id,
            currentManifest,
            currentAppId,
            currentVersion,
            projectRecords,
            signal,
            emit: send,
            workspaceDir,
            resumeContext,
            artifactSeed: repo.listArtifactEntries(task.id),
            persistArtifacts: (entries) => repo.upsertArtifactEntries(task.id, projectId, entries),
            promoteRun,
            dataAdapter: {
              list: (collection) => repo.listRecords(projectId, currentAppId, collection).map((row) => { try { return { id: row.id, ...(JSON.parse(row.dataJson) as Record<string, unknown>) }; } catch { return { id: row.id }; } }),
              insert: (collection, record) => { const id = "rec-" + crypto.randomUUID(); repo.insertRecord({ id, projectId, appId: currentAppId, collection, dataJson: JSON.stringify(record) }); return { id, ...record }; },
              update: (collection, id, patch) => { const existing = repo.getRecordById(id); if (!existing) return false; try { const data = JSON.parse(existing.dataJson) as Record<string, unknown>; return repo.updateRecord({ id, projectId, appId: currentAppId, collection, dataJson: JSON.stringify({ ...data, ...patch }) }); } catch { return false; } },
              remove: (collection, id) => repo.deleteRecord({ id, projectId, appId: currentAppId, collection }),
            },
          });
        } catch (error) {
          // The orchestrator normally emits its own error event; this is the safety net.
          const aborted = signal.aborted || (error instanceof Error && error.name === "AbortError");
          repo.updateTask(task.id, {
            status: "failed",
            stage: "failed",
            errorCode: aborted ? "CLIENT_ABORTED" : "INTERNAL",
            errorMessage: aborted
              ? "请求已取消（页面刷新、断开连接或对话已删除）。工作区与产物已保留；当前成功版本不受影响。"
              : error instanceof Error ? error.message.slice(0, 240) : "生成失败",
          });
        } finally {
          runSettled = true;
          unregisterRun(task.id);
          activeHandle.markDone();
          try {
            controller.close();
          } catch {
            // Already closed
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    // Stream never started: release the run handle.
    if (!runSettled && runHandle) {
      unregisterRun(taskId);
      runHandle.markDone();
    }
    return apiErrorResponse(error, requestId);
  }
}

export async function GET(_request: NextRequest, context: RouteContext): Promise<Response> {
  const requestId = "req-" + crypto.randomUUID();
  try {
    const { taskId } = await context.params;
    const repo = getRepository();
    const projectId = readProjectId(_request) ?? newProjectId();
    const task = repo.getTask(taskId);
    if (!task || task.projectId !== projectId) {
      return apiErrorResponse(new ApiError("TASK_NOT_FOUND", "构建任务不存在", 404), requestId);
    }
    return Response.json({ ok: true, data: { task: toTaskJson(task) } });
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}

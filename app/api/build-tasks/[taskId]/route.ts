import { NextRequest, NextResponse } from "next/server";
import { getRepository } from "@/lib/db";
import { newProjectId, newRequestId, readProjectId } from "@/lib/sandbox/server-session";
import { apiErrorResponse, ApiError } from "@/lib/server/api-response";
import { toTaskJson } from "@/lib/server/conversation-io";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ taskId: string }> };

function requireTask(repo: ReturnType<typeof getRepository>, projectId: string, taskId: string) {
  const task = repo.getTask(taskId);
  if (!task || task.projectId !== projectId) {
    throw new ApiError("TASK_NOT_FOUND", "构建任务不存在", 404);
  }
  return task;
}

export async function GET(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const { taskId } = await context.params;
    const repo = getRepository();
    const projectId = readProjectId(_request) ?? newProjectId();
    const task = requireTask(repo, projectId, taskId);
    return NextResponse.json({ ok: true, data: { task: toTaskJson(task) } });
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}

/**
 * Retries the same user message on the SAME task (resume, not restart):
 * workspace files, saved artifacts, and completed agent history are reused,
 * so the next run continues from the failed step instead of redoing the whole pipeline.
 * No duplicate user message is appended.
 */
export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const { taskId } = await context.params;
    const repo = getRepository();
    const projectId = readProjectId(request) ?? newProjectId();
    const task = requireTask(repo, projectId, taskId);

    const conversation = repo.getConversation(task.conversationId);
    if (!conversation || conversation.projectId !== projectId) {
      throw new ApiError("CONVERSATION_NOT_FOUND", "对话不存在", 404);
    }
    if (conversation.status === "archived") {
      throw new ApiError("CONVERSATION_ARCHIVED", "归档对话不能重试，请先恢复", 403);
    }
    if (task.status === "running") {
      throw new ApiError("BUILD_IN_PROGRESS", "该任务正在执行，不能重复重试", 409);
    }
    const running = repo.findRunningTask(projectId);
    if (running && running.id !== task.id) throw new ApiError("BUILD_IN_PROGRESS", "已有生成任务进行中", 409);

    // Retry keeps the workspace/artifacts/history; only status and stale cards are reset.
    repo.removeTaskErrors(task.id);
    repo.removeTaskRoleMessages(task.id);
    repo.updateTask(task.id, {
      status: "pending",
      stage: "idle",
      errorCode: null,
      errorMessage: null,
      attempts: (task.attempts ?? 0) + 1,
    });
    const retried = repo.getTask(task.id);
    return NextResponse.json({ ok: true, data: { task: retried ? toTaskJson(retried) : null } });
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}

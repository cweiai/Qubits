import { NextRequest, NextResponse } from "next/server";
import { getRepository } from "@/lib/db";
import { newRequestId, resolveProjectId } from "@/lib/sandbox/server-session";
import { apiErrorResponse, ApiError, readJson } from "@/lib/server/api-response";
import { toMessageJson, toTaskJson } from "@/lib/server/conversation-io";
import { listMessagesQuerySchema, sendMessageBodySchema } from "@/lib/validation/conversation";
import { autoTitle } from "@/lib/workspace/auto-title";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ conversationId: string }> };

function requireConversation(repo: ReturnType<typeof getRepository>, projectId: string, conversationId: string) {
  const conversation = repo.getConversation(conversationId);
  if (!conversation || conversation.projectId !== projectId) {
    throw new ApiError("CONVERSATION_NOT_FOUND", "对话不存在", 404);
  }
  return conversation;
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const { conversationId } = await context.params;
    const repo = getRepository();
    const projectId = resolveProjectId(request, repo);
    requireConversation(repo, projectId, conversationId);

    const url = new URL(request.url);
    const query = listMessagesQuerySchema.safeParse({
      before: url.searchParams.get("before") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    if (!query.success) throw new ApiError("INVALID_REQUEST", "分页参数不合法", 400);
    const messages = repo.listMessages(conversationId, query.data.before ?? null, query.data.limit);
    return NextResponse.json({
      ok: true,
      data: { messages: messages.map(toMessageJson), messageCount: repo.countMessages(conversationId) },
    });
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}

/**
 * Sends a message: in a transaction, creates the user message + build task and updates the
 * conversation timestamp; the client then calls /api/build-tasks/:id/run to start the AI work.
 * Idempotent: a repeated requestId returns the existing message and task without appending.
 */
export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const { conversationId } = await context.params;
    const repo = getRepository();
    const projectId = resolveProjectId(request, repo);
    const conversation = requireConversation(repo, projectId, conversationId);

    if (conversation.status === "archived") {
      throw new ApiError("CONVERSATION_ARCHIVED", "归档对话不能发送消息，请先恢复", 403);
    }

    const body = sendMessageBodySchema.safeParse(await readJson(request));
    if (!body.success) throw new ApiError("INVALID_REQUEST", "消息内容不合法（1-4000 字）", 400);

    // Idempotent: return immediately if this requestId was already processed
    const existingMessage = repo.getMessageByRequestId(conversationId, body.data.requestId);
    if (existingMessage) {
      const existingTask = repo.getTaskByRequestId(body.data.requestId);
      return NextResponse.json({
        ok: true,
        data: {
          userMessage: toMessageJson(existingMessage),
          task: existingTask ? toTaskJson(existingTask) : null,
          deduplicated: true,
        },
      });
    }

    // Project-level concurrency: only one active build task per project
    const running = repo.findRunningTask(projectId);
    if (running) {
      throw new ApiError("BUILD_IN_PROGRESS", "已有生成任务进行中，请等待完成后再发送", 409);
    }

    const now = Date.now();
    const userMessageId = "msg-" + crypto.randomUUID();
    const taskId = "task-" + crypto.randomUUID();

    const userMessage = repo.transaction(() => {
      const message = repo.insertMessage({
        id: userMessageId,
        conversationId,
        role: "user",
        content: body.data.content,
        status: "completed",
        requestId: body.data.requestId,
      });
      repo.insertTask({
        id: taskId,
        projectId,
        conversationId,
        userMessageId,
        prompt: body.data.content,
        requestId: body.data.requestId,
      });
      repo.touchConversation(conversationId, now);
      // Auto-generate a short title after the first valid message (don't overwrite user-renamed conversations)
      if (conversation.title === "新对话" && conversation.titleSource !== "user") {
        repo.renameConversation(conversationId, projectId, autoTitle(body.data.content), "auto");
      }
      return message;
    });

    const task = repo.getTask(taskId);
    return NextResponse.json({
      ok: true,
      data: { userMessage: toMessageJson(userMessage), task: task ? toTaskJson(task) : null, deduplicated: false },
    });
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}

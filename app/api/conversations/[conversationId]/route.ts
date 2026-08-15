import { NextRequest, NextResponse } from "next/server";
import { getRepository } from "@/lib/db";
import { newProjectId, newRequestId, readProjectId } from "@/lib/sandbox/server-session";
import { apiErrorResponse, ApiError, readJson } from "@/lib/server/api-response";
import { toApprovalJson, toConversationJson, toMessageJson, toTaskJson } from "@/lib/server/conversation-io";
import { listMessagesQuerySchema, patchConversationBodySchema } from "@/lib/validation/conversation";
import { isRunActive, terminateRun } from "@/lib/ai/run-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ conversationId: string }> };

/** Validates conversation ownership: missing or cross-project always 404s without leaking existence. */
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
    const projectId = readProjectId(request) ?? newProjectId();
    // One-time migration of legacy project-level app state.
    repo.migrateProjectAppToLatestConversation(projectId);
    const conversation = requireConversation(repo, projectId, conversationId);

    const url = new URL(request.url);
    const query = listMessagesQuerySchema.safeParse({
      before: url.searchParams.get("before") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    if (!query.success) throw new ApiError("INVALID_REQUEST", "分页参数不合法", 400);
    const messages = repo.listMessages(conversationId, query.data.before ?? null, query.data.limit);
    const tasks = repo.listTasks(conversationId, 20);
    const pendingApprovals = tasks.flatMap((task) => repo.listPendingApprovals(task.id).map(toApprovalJson));

    return NextResponse.json({
      ok: true,
      data: {
        conversation: toConversationJson(conversation),
        messages: messages.map(toMessageJson),
        tasks: tasks.map(toTaskJson),
        pendingApprovals,
        messageCount: repo.countMessages(conversationId),
      },
    });
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const { conversationId } = await context.params;
    const repo = getRepository();
    const projectId = readProjectId(request) ?? newProjectId();
    requireConversation(repo, projectId, conversationId);

    const body = patchConversationBodySchema.safeParse(await readJson(request));
    if (!body.success) throw new ApiError("INVALID_REQUEST", "请求结构不合法", 400);

    if (body.data.status !== undefined) {
      repo.setConversationStatus(conversationId, projectId, body.data.status);
    }
    if (body.data.title !== undefined) {
      const title = body.data.title.trim().slice(0, 60);
      if (!title) throw new ApiError("INVALID_REQUEST", "标题不能为空", 400);
      // Manual rename → titleSource = user, so auto-titles no longer overwrite
      repo.renameConversation(conversationId, projectId, title, "user");
    }
    const updated = repo.getConversation(conversationId);
    return NextResponse.json({ ok: true, data: { conversation: updated ? toConversationJson(updated) : null } });
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const { conversationId } = await context.params;
    const repo = getRepository();
    const projectId = readProjectId(request) ?? newProjectId();
    requireConversation(repo, projectId, conversationId);

    // Terminate running generations first and wait for them to settle, so a deleted
    // conversation never receives late writes (messages/snapshots/artifacts).
    for (const task of repo.listTasks(conversationId, 50)) {
      if (task.status === "running" || task.status === "pending") {
        if (isRunActive(task.id)) {
          await terminateRun(task.id);
        }
      }
    }

    repo.deleteConversation(conversationId, projectId);
    // Recreate a default writable conversation after deleting the last one
    let fallbackConversationId: string | null = null;
    if (repo.countActiveConversations(projectId) === 0) {
      const fallback = repo.insertConversation({
        id: "conv-" + crypto.randomUUID(),
        projectId,
        title: "新对话",
        titleSource: "auto",
      });
      fallbackConversationId = fallback.id;
    }
    return NextResponse.json({ ok: true, data: { deleted: true, fallbackConversationId } });
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}

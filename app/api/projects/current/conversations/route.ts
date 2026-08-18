import { NextRequest, NextResponse } from "next/server";
import { getRepository } from "@/lib/db";
import {
  attachProjectCookie,
  newRequestId,
  resolveProjectId,
} from "@/lib/sandbox/server-session";
import { apiErrorResponse, ApiError, readJson } from "@/lib/server/api-response";
import { toConversationJson, toTaskJson } from "@/lib/server/conversation-io";
import { createConversationBodySchema } from "@/lib/validation/conversation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The current project's conversation list (minimal fields + latest task status, no full messages).
 */

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const repo = getRepository();
    const projectId = resolveProjectId(request, repo);
    repo.ensureProject(projectId);
    // One-time migration of legacy project-level app state to the most recent conversation.
    repo.migrateProjectAppToLatestConversation(projectId);
    const rows = repo.listConversations(projectId);
    const conversations = rows.map((row) => {
      const messageCount = repo.countMessages(row.id);
      const lastTask = repo.listTasks(row.id, 1)[0] ?? null;
      return {
        ...toConversationJson(row),
        messageCount,
        lastTask: lastTask ? toTaskJson(lastTask) : null,
      };
    });
    const response = NextResponse.json({ ok: true, data: { conversations } });
    attachProjectCookie(request, response, projectId);
    return response;
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const repo = getRepository();
    const projectId = resolveProjectId(request, repo);
    repo.ensureProject(projectId);

    const body = createConversationBodySchema.safeParse(await readJson(request));
    if (!body.success) {
      throw new ApiError("INVALID_REQUEST", "请求结构不合法", 400);
    }
    const existing = repo.getConversation(body.data.id);
    if (existing) {
      if (existing.projectId !== projectId) {
        throw new ApiError("CONVERSATION_NOT_FOUND", "对话不存在", 404);
      }
      // Idempotent: a repeated create intent returns the existing conversation
      const response = NextResponse.json({
        ok: true,
        data: { conversation: toConversationJson(existing), created: false },
      });
      attachProjectCookie(request, response, projectId);
      return response;
    }
    const conversation = repo.insertConversation({
      id: body.data.id,
      projectId,
      title: body.data.title ?? "新对话",
      titleSource: body.data.title ? "user" : "auto",
    });
    // Retry the migration now that a conversation exists.
    repo.migrateProjectAppToLatestConversation(projectId);
    const response = NextResponse.json({
      ok: true,
      data: { conversation: toConversationJson(repo.getConversation(conversation.id)!), created: true },
    });
    attachProjectCookie(request, response, projectId);
    return response;
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}

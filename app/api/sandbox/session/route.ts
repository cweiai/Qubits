import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { qubitsManifestSchema } from "@/lib/contracts/manifest";
import { getRepository } from "@/lib/db";
import { SESSION_TTL_MS } from "@/lib/db/sandbox-data";
import {
  attachProjectCookie,
  newProjectId,
  newRequestId,
  readProjectId,
  sandboxErrorResponse,
} from "@/lib/sandbox/server-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/sandbox/session
 * Conversation-scoped sessions: appId = manifest.appId ?? conversationId, version =
 * the conversation's preview_version. The server re-validates ownership and the
 * collection contract; generated code's permission claims are never trusted.
 */

const bodySchema = z.object({ manifest: qubitsManifestSchema, conversationId: z.string().min(8).max(64) }).strict();

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    let body: unknown = null;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: "manifest/conversationId 校验失败",
            requestId,
          },
        },
        { status: 400 }
      );
    }
    const manifest = parsed.data.manifest;
    const collections = manifest.collections;

    // Project ownership comes from an HTTP-only cookie (created when absent)
    const projectId = readProjectId(request) ?? newProjectId();

    const repo = getRepository();
    repo.ensureProject(projectId);
    const conversation = repo.getConversation(parsed.data.conversationId);
    if (!conversation || conversation.projectId !== projectId) {
      return NextResponse.json(
        { ok: false, error: { code: "CONVERSATION_NOT_FOUND", message: "对话不存在", requestId } },
        { status: 404 }
      );
    }
    repo.deleteExpiredSessions(Date.now());

    const sessionId = "sess-" + crypto.randomUUID();
    const expiresAt = Date.now() + SESSION_TTL_MS;
    // Data scope: legacy manifests carry appId; new apps are isolated per conversation.
    const appId = manifest.appId ?? conversation.id;
    const appVersion = conversation.previewVersion || 1;
    repo.createSession({
      id: sessionId,
      projectId,
      appId,
      appVersion,
      collectionsJson: JSON.stringify(collections),
      expiresAt,
    });

    const response = NextResponse.json({
      ok: true,
      data: {
        sessionId,
        appId,
        appVersion,
        expiresAt,
        collections,
      },
    });
    // Idempotent renewal: always write the project cookie with the final response
    attachProjectCookie(response, projectId);
    return response;
  } catch (error) {
    return sandboxErrorResponse(error, requestId);
  }
}

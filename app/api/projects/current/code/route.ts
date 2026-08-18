import { NextRequest, NextResponse } from "next/server";
import { getRepository } from "@/lib/db";
import { newRequestId, resolveProjectId } from "@/lib/sandbox/server-session";
import { apiErrorResponse, ApiError } from "@/lib/server/api-response";
import { readSnapshotFile } from "@/lib/workspace/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/projects/current/code?conversationId=<id>[&path=<file>]
 * Per-conversation read-only source view of the current immutable snapshot.
 * ?path= returns one file (path-jailed); without it the snapshot manifest is returned.
 */

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const repo = getRepository();
    const projectId = resolveProjectId(request, repo);
    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversationId") ?? "";
    const conversation = repo.getConversation(conversationId);
    if (!conversation || conversation.projectId !== projectId) {
      throw new ApiError("CONVERSATION_NOT_FOUND", "对话不存在", 404);
    }
    const snapshotId = conversation.currentSnapshotId;
    if (!snapshotId) {
      throw new ApiError("SNAPSHOT_NOT_FOUND", "该对话还没有可查看的代码快照", 404);
    }
    const snapshot = repo.getCodeSnapshot(snapshotId);
    if (!snapshot || snapshot.projectId !== projectId) {
      throw new ApiError("SNAPSHOT_NOT_FOUND", "代码快照不存在", 404);
    }
    const pathParam = url.searchParams.get("path");
    if (!pathParam) {
      let files: Array<{ path: string; hash: string; size: number }> = [];
      try {
        files = JSON.parse(snapshot.filesJson) as Array<{ path: string; hash: string; size: number }>;
      } catch {
        files = [];
      }
      return NextResponse.json({
        ok: true,
        data: {
          version: snapshot.version,
          files: files
            .filter((file) => !file.path.startsWith("dist/") && !file.path.startsWith(".qubits"))
            .map((file) => ({ path: file.path, size: file.size })),
        },
      });
    }
    const content = readSnapshotFile(projectId, snapshotId, pathParam);
    return NextResponse.json({ ok: true, data: { path: pathParam, content: content.slice(0, 128 * 1024) } });
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}

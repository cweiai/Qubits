import { NextRequest, NextResponse } from "next/server";
import { getRepository } from "@/lib/db";
import { newProjectId, newRequestId, readProjectId } from "@/lib/sandbox/server-session";
import { apiErrorResponse } from "@/lib/server/api-response";
import { rmSync } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/projects/current/reset
 * Clears the current project: conversations/messages/build tasks/drafts/records/sandbox
 * sessions/snapshots/artifacts, plus the on-disk workspaces of this project's tasks.
 * The client recreates the default conversation after resetting.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const repo = getRepository();
    const projectId = readProjectId(request) ?? newProjectId();
    // Remove task workspaces belonging to this project before clearing rows.
    const conversations = repo.listConversations(projectId);
    const taskIds = new Set<string>();
    for (const conversation of conversations) {
      for (const task of repo.listTasks(conversation.id, 200)) {
        taskIds.add(task.id);
      }
    }
    for (const taskId of taskIds) {
      try {
        rmSync(path.join(process.cwd(), "data", "workspaces", taskId), { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    try {
      rmSync(path.join(process.cwd(), "data", "snapshots", projectId), { recursive: true, force: true });
    } catch {
      // best effort
    }
    repo.clearProject(projectId);
    return NextResponse.json({ ok: true, data: { reset: true } });
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}

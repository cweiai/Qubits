import { NextRequest, NextResponse } from "next/server";
import { getRepository } from "@/lib/db";
import { attachProjectCookie, newProjectId, readProjectId } from "@/lib/sandbox/server-session";
import { ApiError, apiErrorResponse, readJson } from "@/lib/server/api-response";
import { attachAuthCookie, createSession, verifyPassword, validateCredentials } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = `req-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const body = (await readJson(request)) as { email?: unknown; password?: unknown };
    const credentials = validateCredentials(body?.email, body?.password);
    const repo = getRepository();
    const user = repo.getUserByEmail(credentials.email);
    if (!user || !verifyPassword(credentials.password, user.passwordHash)) throw new ApiError("INVALID_LOGIN", "邮箱或密码错误", 401);
    const currentProjectId = readProjectId(request);
    let projectId: string;
    const currentProject = currentProjectId ? repo.getProject(currentProjectId) : null;
    const ownedProject = repo.listUserProjects(user.id)[0] ?? null;
    if (currentProject?.userId === user.id) {
      projectId = currentProject.id;
    } else if (ownedProject) {
      projectId = ownedProject.id;
    } else if (currentProject?.userId === null) {
      projectId = currentProject.id;
      repo.claimProject(projectId, user.id);
    } else {
      projectId = newProjectId();
      repo.ensureProject(projectId);
      repo.setProjectUser(projectId, user.id);
    }
    const response = NextResponse.json({ ok: true, data: { user: { id: user.id, email: user.email, createdAt: user.createdAt } } });
    attachAuthCookie(request, response, createSession(repo, user.id));
    attachProjectCookie(request, response, projectId);
    return response;
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}

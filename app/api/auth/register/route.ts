import { NextRequest, NextResponse } from "next/server";
import { getRepository } from "@/lib/db";
import { attachProjectCookie, newProjectId, readProjectId } from "@/lib/sandbox/server-session";
import { ApiError, apiErrorResponse, readJson } from "@/lib/server/api-response";
import { attachAuthCookie, createSession, hashPassword, validateCredentials } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = `req-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const body = (await readJson(request)) as { email?: unknown; password?: unknown; confirmPassword?: unknown };
    const credentials = validateCredentials(body?.email, body?.password);
    if (body?.confirmPassword !== credentials.password) {
      throw new ApiError("PASSWORD_MISMATCH", "两次输入的密码不一致", 400);
    }
    const repo = getRepository();
    if (repo.getUserByEmail(credentials.email)) throw new ApiError("EMAIL_IN_USE", "该邮箱已注册，请直接登录", 409);
    const user = repo.createUser({ id: `usr-${crypto.randomUUID()}`, email: credentials.email, passwordHash: hashPassword(credentials.password) });
    const cookieProjectId = readProjectId(request);
    const anonymousProject = cookieProjectId ? repo.getProject(cookieProjectId) : null;
    const projectId = anonymousProject?.userId === null ? anonymousProject.id : newProjectId();
    repo.ensureProject(projectId);
    if (!repo.claimProject(projectId, user.id)) repo.setProjectUser(projectId, user.id);
    const response = NextResponse.json({ ok: true, data: { user: { id: user.id, email: user.email, createdAt: user.createdAt } } });
    attachAuthCookie(request, response, createSession(repo, user.id));
    attachProjectCookie(request, response, projectId);
    return response;
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}

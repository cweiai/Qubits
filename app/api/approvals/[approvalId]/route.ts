import { NextRequest, NextResponse } from "next/server";
import { denyApproval, grantApproval } from "@/lib/ai/tools/approval";
import { getRepository } from "@/lib/db";
import { resolveProjectId } from "@/lib/sandbox/server-session";
import { apiErrorResponse, ApiError } from "@/lib/server/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/approvals/:approvalId — records an explicit grant or denial. */
export async function POST(request: NextRequest, context: { params: Promise<{ approvalId: string }> }): Promise<NextResponse> {
  const requestId = crypto.randomUUID();
  try {
    const { approvalId } = await context.params;
    const repo = getRepository();
    const projectId = resolveProjectId(request, repo);
    const approval = repo.getApproval(approvalId);
    if (!approval || (approval.projectId !== null && approval.projectId !== projectId)) {
      throw new ApiError("APPROVAL_NOT_FOUND", "审批不存在或不属于当前项目", 404);
    }
    const payload = (await request.json().catch(() => ({}))) as { decision?: unknown };
    const decision = payload.decision === "deny" ? "deny" : payload.decision === "grant" ? "grant" : null;
    if (!decision) throw new ApiError("INVALID_ARGS", "decision 必须是 grant 或 deny", 400);
    const resolved = decision === "grant" ? grantApproval(approvalId) : denyApproval(approvalId);
    if (!resolved) throw new ApiError("APPROVAL_ALREADY_RESOLVED", "审批已处理或已过期", 409);
    return NextResponse.json({ ok: true, data: { approvalId, status: resolved.status } });
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}

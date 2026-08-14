import { NextRequest, NextResponse } from "next/server";
import { grantApproval } from "@/lib/ai/tools/approval";
import { apiErrorResponse } from "@/lib/server/api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/approvals/:approvalId — grants a high-risk tool from the UI approval dialog. */
export async function POST(_request: NextRequest, context: { params: Promise<{ approvalId: string }> }): Promise<NextResponse> {
  const { approvalId } = await context.params;
  const granted = grantApproval(approvalId);
  if (!granted) {
    return apiErrorResponse(Object.assign(new Error("审批不存在或已失效"), { name: "ApiError" }), null);
  }
  return NextResponse.json({ ok: true, data: { approvalId, granted: true } });
}

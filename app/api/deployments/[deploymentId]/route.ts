import { NextRequest, NextResponse } from "next/server";
import { getRepository } from "@/lib/db";
import { apiErrorResponse, ApiError } from "@/lib/server/api-response";
import { newRequestId, resolveProjectId } from "@/lib/sandbox/server-session";
import { DeployError } from "@/lib/deploy/errors";
import { stopDeployment } from "@/lib/deploy/manager";
import { DEPLOYMENT_ID_PATTERN } from "@/lib/deploy/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELETE /api/deployments/<deploymentId> — take a deployment down (下线).
 * Only the owning project (cookie-scoped) may stop its own deployments.
 */

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ deploymentId: string }> }
): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const { deploymentId } = await context.params;
    if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) {
      throw new ApiError("INVALID_REQUEST", "deploymentId 不合法", 400);
    }
    const repo = getRepository();
    const projectId = resolveProjectId(request, repo);
    const row = repo.getDeployment(deploymentId);
    if (!row || row.projectId !== projectId) {
      throw new ApiError("DEPLOYMENT_NOT_FOUND", "部署不存在或已删除", 404);
    }
    try {
      stopDeployment(deploymentId);
    } catch (error) {
      if (error instanceof DeployError) {
        throw new ApiError(error.code, error.message, 404);
      }
      throw error;
    }
    return NextResponse.json({
      ok: true,
      data: { id: deploymentId, status: "stopped" },
    });
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}

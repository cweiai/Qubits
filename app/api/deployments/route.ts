import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getRepository } from "@/lib/db";
import type { DeploymentRow } from "@/lib/db/repository";
import { apiErrorResponse, ApiError } from "@/lib/server/api-response";
import { newProjectId, newRequestId, readProjectId } from "@/lib/sandbox/server-session";
import { qubitsManifestSchema } from "@/lib/contracts/manifest";
import { DeployError } from "@/lib/deploy/errors";
import { deployConversationApp, deploymentPublicUrl, getDeployRuntimeStatus } from "@/lib/deploy/manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/deployments?conversationId=<id>  → list the conversation's deployments
 * POST /api/deployments { conversationId }   → one-click deploy the current bundle
 */

function deploymentToJson(row: DeploymentRow): Record<string, unknown> {
  return {
    id: row.id,
    conversationId: row.conversationId,
    status: row.status,
    url: row.status === "live" ? deploymentPublicUrl(row.id) : null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    stoppedAt: row.stoppedAt,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
  };
}

function runtimeToJson(): Record<string, unknown> {
  const runtime = getDeployRuntimeStatus();
  return {
    state: runtime.state,
    publicBaseUrl: runtime.publicBaseUrl,
    localBaseUrl: runtime.localBaseUrl,
    tunnel: runtime.tunnel,
    initError: runtime.initError,
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const repo = getRepository();
    const projectId = readProjectId(request) ?? newProjectId();
    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversationId") ?? "";
    const conversation = repo.getConversation(conversationId);
    if (!conversation || conversation.projectId !== projectId) {
      throw new ApiError("CONVERSATION_NOT_FOUND", "对话不存在", 404);
    }
    return NextResponse.json({
      ok: true,
      data: {
        deployments: repo.listDeploymentsByConversation(conversationId).map(deploymentToJson),
        runtime: runtimeToJson(),
      },
    });
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}

const bodySchema = z.object({ conversationId: z.string().min(8).max(64) }).strict();

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
      throw new ApiError("INVALID_REQUEST", "conversationId 校验失败", 400);
    }

    const repo = getRepository();
    const projectId = readProjectId(request) ?? newProjectId();
    const conversation = repo.getConversation(parsed.data.conversationId);
    if (!conversation || conversation.projectId !== projectId) {
      throw new ApiError("CONVERSATION_NOT_FOUND", "对话不存在", 404);
    }
    if (!conversation.previewBundleId) {
      throw new ApiError("DEPLOY_NO_BUNDLE", "该对话还没有可上线的应用，请先生成一版。", 404);
    }
    if (!conversation.manifestJson) {
      throw new ApiError("INVALID_MANIFEST", "该对话缺少应用清单，无法上线。", 400);
    }
    let rawManifest: unknown = null;
    try {
      rawManifest = JSON.parse(conversation.manifestJson);
    } catch {
      rawManifest = null;
    }
    const manifest = qubitsManifestSchema.safeParse(rawManifest);
    if (!manifest.success) {
      throw new ApiError("INVALID_MANIFEST", "应用清单校验失败，请重新生成后再上线。", 400);
    }

    const result = await deployConversationApp({
      projectId,
      conversationId: conversation.id,
      manifest: manifest.data,
      previewBundleArtifactId: conversation.previewBundleId,
    });
    return NextResponse.json({
      ok: true,
      data: {
        deployment: deploymentToJson(result.deployment),
        url: result.url,
        runtime: runtimeToJson(),
      },
    });
  } catch (error) {
    if (error instanceof DeployError) {
      return apiErrorResponse(new ApiError(error.code, error.message, 400), requestId);
    }
    return apiErrorResponse(error, requestId);
  }
}

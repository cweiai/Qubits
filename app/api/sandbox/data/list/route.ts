import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getRepository } from "@/lib/db";
import { performListOperation, resolveSession } from "@/lib/db/sandbox-data";
import { newRequestId, resolveProjectId, sandboxErrorResponse } from "@/lib/sandbox/server-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/sandbox/data/list
 * Only list / count; the server enforces project_id / app_id / collection scope.
 */

const bodySchema = z
  .object({
    sessionId: z.string().min(8).max(128),
    operation: z.enum(["list", "count"]),
    collection: z.string().max(64),
    query: z.unknown().optional(),
    requestId: z.string().max(64).optional(),
  })
  .strict();

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
          error: { code: "INVALID_REQUEST", message: "请求结构不合法", requestId },
        },
        { status: 400 }
      );
    }
    const { sessionId, operation, collection: collectionName } = parsed.data;
    const repo = getRepository();
    const projectId = resolveProjectId(request, repo);
    const session = resolveSession(repo, projectId, sessionId);
    const result = performListOperation(repo, session, {
      operation,
      collection: collectionName,
      query: parsed.data.query,
    });
    return NextResponse.json(result);
  } catch (error) {
    return sandboxErrorResponse(error, requestId);
  }
}

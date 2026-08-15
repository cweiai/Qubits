import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getRepository } from "@/lib/db";
import { performListOperation, performMutateOperation } from "@/lib/db/sandbox-data";
import { newRequestId, sandboxErrorResponse } from "@/lib/sandbox/server-session";
import { resolveDeploymentSession } from "@/lib/deploy/public-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/deploy/data
 * Public data API for deployed apps: no project cookie — authorization comes from the
 * deploymentId + sessionId pair baked into the served bundle, bound to a live,
 * unexpired deployment. All visitors of one link share the same dataset, and every
 * operation is re-validated (collections / operations / queries / payloads) exactly
 * like sandbox preview requests. Rate limiting is per shared session.
 */

const bodySchema = z
  .object({
    deploymentId: z.string().min(8).max(64),
    sessionId: z.string().min(8).max(128),
    operation: z.enum(["list", "count", "create", "update", "delete"]),
    collection: z.string().max(64),
    id: z.string().max(64).optional(),
    query: z.unknown().optional(),
    input: z.unknown().optional(),
    patch: z.unknown().optional(),
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
    const repo = getRepository();
    const { session } = resolveDeploymentSession(repo, parsed.data.deploymentId, parsed.data.sessionId);

    const result =
      parsed.data.operation === "list" || parsed.data.operation === "count"
        ? performListOperation(repo, session, {
            operation: parsed.data.operation,
            collection: parsed.data.collection,
            query: parsed.data.query,
          })
        : performMutateOperation(repo, session, {
            operation: parsed.data.operation,
            collection: parsed.data.collection,
            id: parsed.data.id,
            recordInput: parsed.data.input,
            patch: parsed.data.patch,
          });
    return NextResponse.json(result);
  } catch (error) {
    return sandboxErrorResponse(error, requestId);
  }
}

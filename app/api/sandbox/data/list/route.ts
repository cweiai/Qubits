import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getRepository } from "@/lib/db";
import {
  applyQuery,
  checkRateLimit,
  parseRecordRow,
  parseSessionCollections,
  requireCollection,
  requireOperation,
  resolveSession,
  validateQuery,
} from "@/lib/db/sandbox-data";
import { newRequestId, readProjectId, sandboxErrorResponse } from "@/lib/sandbox/server-session";

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
    const projectId = readProjectId(request);
    const session = resolveSession(repo, projectId, sessionId);
    const collections = parseSessionCollections(session);
    const collection = requireCollection(collections, collectionName);
    requireOperation(collection, operation);
    checkRateLimit(sessionId);

    const query = validateQuery(collection, parsed.data.query);
    const rows = repo.listRecords(projectId!, session.appId, collection.name)
      .map(parseRecordRow)
      .map((row) => ({ id: row.id, ...row.data }));
    const filtered = applyQuery(
      rows.map((row) => ({ id: row.id, data: row })),
      query,
      collection
    ).map((row) => row.data);

    if (operation === "count") {
      return NextResponse.json({ ok: true, data: { count: filtered.length } });
    }
    return NextResponse.json({ ok: true, data: { records: filtered } });
  } catch (error) {
    return sandboxErrorResponse(error, requestId);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getRepository } from "@/lib/db";
import {
  checkRateLimit,
  parseRecordRow,
  parseSessionCollections,
  requireCollection,
  requireOperation,
  resolveSession,
  SandboxError,
  validateRecordInput,
} from "@/lib/db/sandbox-data";
import { newId } from "@/lib/app/records";
import { newRequestId, readProjectId, sandboxErrorResponse } from "@/lib/sandbox/server-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/sandbox/data/mutate
 * Only create / update / delete; update/delete ids must belong to the current app/project.
 */

const bodySchema = z
  .object({
    sessionId: z.string().min(8).max(128),
    operation: z.enum(["create", "update", "delete"]),
    collection: z.string().max(64),
    id: z.string().max(64).optional(),
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
    const { sessionId, operation, collection: collectionName } = parsed.data;
    const repo = getRepository();
    const projectId = readProjectId(request);
    const session = resolveSession(repo, projectId, sessionId);
    const collections = parseSessionCollections(session);
    const collection = requireCollection(collections, collectionName);
    requireOperation(collection, operation);
    checkRateLimit(sessionId);

    const scope = { projectId: projectId!, appId: session.appId, collection: collection.name };

    if (operation === "create") {
      const cleaned = validateRecordInput(collection, parsed.data.input, "create");
      const record = { id: newId("rec"), ...cleaned };
      repo.insertRecord({ ...scope, id: record.id, dataJson: JSON.stringify(cleaned) });
      return NextResponse.json({ ok: true, data: { record } });
    }

    const id = parsed.data.id;
    if (!id) {
      throw new SandboxError("INVALID_REQUEST", "update/delete 必须提供记录 id", 400);
    }

    if (operation === "update") {
      const existing = repo.getRecordById(id);
      if (!existing || existing.projectId !== scope.projectId || existing.appId !== scope.appId || existing.collection !== scope.collection) {
        throw new SandboxError("RECORD_NOT_FOUND", "记录不存在或不属于当前应用", 404);
      }
      const patch = validateRecordInput(collection, parsed.data.patch, "patch");
      const merged = { ...parseRecordRow(existing).data, ...patch };
      const updated = repo.updateRecord({ ...scope, id, dataJson: JSON.stringify(merged) });
      if (!updated) {
        throw new SandboxError("RECORD_NOT_FOUND", "记录不存在或不属于当前应用", 404);
      }
      return NextResponse.json({ ok: true, data: { record: { id, ...merged } } });
    }

    // delete
    const deleted = repo.deleteRecord({ ...scope, id });
    if (!deleted) {
      throw new SandboxError("RECORD_NOT_FOUND", "记录不存在或不属于当前应用", 404);
    }
    return NextResponse.json({ ok: true, data: { id } });
  } catch (error) {
    return sandboxErrorResponse(error, requestId);
  }
}

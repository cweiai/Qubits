import { NextRequest, NextResponse } from "next/server";
import { appSpecSchema } from "@/lib/contracts/app-spec";
import { getRepository } from "@/lib/db";
import {
  attachProjectCookie,
  newProjectId,
  newRequestId,
  readProjectId,
} from "@/lib/sandbox/server-session";
import { apiErrorResponse, ApiError, readJson } from "@/lib/server/api-response";
import { migrateBodySchema } from "@/lib/validation/conversation";
import { legacyManifestFromJson } from "@/lib/workspace/legacy-convert";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Current anonymous project:
 * - GET: returns project state (validated manifest + preview reference + legacy drafts)
 *   and recovers orphaned build tasks; legacy AppSpec projects are converted once
 *   (app_spec_json is kept untouched — read-only compat).
 * - POST: one-time migration of legacy localStorage data (idempotent: skipped when conversations exist).
 */

const STALE_TASK_MS = 5 * 60 * 1000;

function parseDraft(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const repo = getRepository();
    const projectId = readProjectId(request) ?? newProjectId();
    repo.ensureProject(projectId);
    // Orphan recovery: mark running tasks past the threshold as retriable failures
    repo.markStaleRunningTasks(projectId, Date.now() - STALE_TASK_MS);
    const project = repo.getProject(projectId);
    if (project?.appSpecJson) {
      const latest = repo.listConversations(projectId)[0];
      if (latest && !latest.manifestJson) {
        const converted = legacyManifestFromJson(project.appSpecJson);
        if (converted) {
          repo.updateConversationApp(latest.id, projectId, { manifestJson: JSON.stringify(converted) });
        }
      }
    }
    repo.migrateProjectAppToLatestConversation(projectId);
    const response = NextResponse.json({
      ok: true,
      data: {
        projectId,
        appSpec: project ? parseDraft(project.appSpecJson) : null,
        productBrief: project ? parseDraft(project.productBriefJson) : null,
        appBlueprint: project ? parseDraft(project.appBlueprintJson) : null,
        updatedAt: project?.updatedAt ?? null,
      },
    });
    attachProjectCookie(response, projectId);
    return response;
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const repo = getRepository();
    const projectId = readProjectId(request) ?? newProjectId();
    repo.ensureProject(projectId);

    const existing = repo.listConversations(projectId);

    const body = migrateBodySchema.safeParse(await readJson(request));
    if (!body.success) {
      throw new ApiError("INVALID_REQUEST", "迁移数据校验失败", 400);
    }

    // Write the draft only when AppSpec is valid (the draft app takes effect unconditionally for recovery/seeding)
    let appSpec: unknown = null;
    if (body.data.appSpec != null) {
      const parsed = appSpecSchema.safeParse(body.data.appSpec);
      if (!parsed.success) throw new ApiError("INVALID_REQUEST", "AppSpec 校验失败，拒绝迁移", 400);
      appSpec = parsed.data;
    }

    if (existing.length > 0) {
      if (appSpec != null) {
        repo.updateProjectDraft(projectId, {
          appSpecJson: JSON.stringify(appSpec),
          productBriefJson: body.data.productBrief != null ? JSON.stringify(body.data.productBrief) : null,
          appBlueprintJson: body.data.appBlueprint != null ? JSON.stringify(body.data.appBlueprint) : null,
        });
        const converted = legacyManifestFromJson(JSON.stringify(appSpec));
        if (converted) {
          // Attach the manifest to the most recent conversation (legacy records keep their old appId scope).
          const latest = repo.listConversations(projectId)[0];
          if (latest) repo.updateConversationApp(latest.id, projectId, { manifestJson: JSON.stringify(converted) });
        }
      }
      // Existing conversations: update only the draft, don't re-import messages (idempotent)
      return NextResponse.json({ ok: true, data: { migrated: false, projectId } });
    }

    const conversationId = "conv-" + crypto.randomUUID();
    repo.insertConversation({ id: conversationId, projectId, title: "新对话", titleSource: "auto" });

    const legacy = (body.data.legacyConversation ?? []).slice(0, 500);
    let migratedMessages = 0;
    for (const item of legacy) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as Record<string, unknown>;
      const text = typeof record.text === "string" ? record.text.slice(0, 4000) : "";
      if (!text) continue;
      const type = typeof record.type === "string" ? record.type : "";
      const legacyStatus = typeof record.status === "string" ? record.status : null;
      const status = legacyStatus === "running" || legacyStatus === "pending" ? "error" : legacyStatus === "error" ? "error" : "completed";
      const base = {
        id: "msg-" + crypto.randomUUID(),
        conversationId,
        content: text,
        status: status as "completed" | "error",
      };
      if (type === "user") {
        repo.insertMessage({ ...base, role: "user" });
        migratedMessages += 1;
      } else if (type === "system") {
        repo.insertMessage({ ...base, role: "system" });
        migratedMessages += 1;
      } else if (type === "error") {
        repo.insertMessage({
          ...base,
          role: "assistant",
          messageKind: "error",
          errorCode: "LEGACY",
          metadataJson: JSON.stringify({ kind: "error" }),
        });
        migratedMessages += 1;
      } else if (type === "product_manager" || type === "architect" || type === "engineer" || type === "security_reviewer") {
        repo.insertMessage({
          ...base,
          role: "assistant",
          roleId: type,
          messageKind: "role",
          metadataJson: JSON.stringify({ kind: "role", roleId: type, artifact: record.artifact ?? null }),
        });
        migratedMessages += 1;
      }
    }
    const lastMessageAt = migratedMessages > 0 ? Date.now() : null;
    if (lastMessageAt) repo.touchConversation(conversationId, lastMessageAt);

    if (appSpec != null) {
      repo.updateProjectDraft(projectId, {
        appSpecJson: JSON.stringify(appSpec),
        productBriefJson: body.data.productBrief != null ? JSON.stringify(body.data.productBrief) : null,
        appBlueprintJson: body.data.appBlueprint != null ? JSON.stringify(body.data.appBlueprint) : null,
      });
      const converted = legacyManifestFromJson(JSON.stringify(appSpec));
      if (converted) {
        // Attach the manifest to the migrated conversation (legacy records keep their old appId scope).
        repo.updateConversationApp(conversationId, projectId, { manifestJson: JSON.stringify(converted) });
      }
    }

    const response = NextResponse.json({
      ok: true,
      data: { migrated: true, projectId, conversationId, migratedMessages },
    });
    attachProjectCookie(response, projectId);
    return response;
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}

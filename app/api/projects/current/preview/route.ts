import { NextRequest, NextResponse } from "next/server";
import { getRepository } from "@/lib/db";
import { newRequestId, resolveProjectId } from "@/lib/sandbox/server-session";
import { apiErrorResponse, ApiError } from "@/lib/server/api-response";
import { injectPostMessageGuard } from "@/lib/workspace/postmessage-guard";
import { extractBundleHtml } from "@/lib/deploy/bundle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/projects/current/preview?conversationId=<id>
 * Serve the conversation's real built bundle (preview_bundle artifact) with a strict
 * CSP. The iframe loads with sandbox="allow-scripts" (no allow-same-origin), so the app
 * cannot read cookies/localStorage/parent/network.
 */

function ensurePreviewMountNodes(html: string): string {
  const hasQubitsRoot = /\bid=["']qubits-root["']/i.test(html);
  const hasRoot = /\bid=["']root["']/i.test(html);
  const missing = [
    hasQubitsRoot ? "" : '<div id="qubits-root"></div>',
    hasRoot ? "" : '<div id="root"></div>',
  ].join("");
  if (!missing) return html;
  const bodyOpen = html.match(/<body(?:\s[^>]*)?>/i);
  if (bodyOpen?.index != null) {
    const insertAt = bodyOpen.index + bodyOpen[0].length;
    return html.slice(0, insertAt) + missing + html.slice(insertAt);
  }
  const firstScript = html.search(/<script(?:\s[^>]*)?>/i);
  if (firstScript !== -1) return html.slice(0, firstScript) + missing + html.slice(firstScript);
  return missing + html;
}

const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const repo = getRepository();
    const projectId = resolveProjectId(request, repo);
    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversationId") ?? "";
    const conversation = repo.getConversation(conversationId);
    if (!conversation || conversation.projectId !== projectId) {
      throw new ApiError("CONVERSATION_NOT_FOUND", "对话不存在", 404);
    }
    const artifactId = conversation.previewBundleId;
    if (!artifactId) {
      throw new ApiError("PREVIEW_NOT_AVAILABLE", "该对话还没有可用的应用预览", 404);
    }
    const artifact = repo.getArtifact(artifactId);
    if (!artifact || artifact.projectId !== projectId || artifact.kind !== "preview_bundle") {
      throw new ApiError("PREVIEW_NOT_AVAILABLE", "预览产物不存在", 404);
    }
    const html = extractBundleHtml(artifact.content);
    if (!html) {
      throw new ApiError("PREVIEW_NOT_AVAILABLE", "预览产物内容缺失或已损坏，请重新生成", 404);
    }
    return new NextResponse(injectPostMessageGuard(ensurePreviewMountNodes(html)), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": PREVIEW_CSP,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getRepository } from "@/lib/db";
import { newProjectId, newRequestId, readProjectId } from "@/lib/sandbox/server-session";
import { apiErrorResponse, ApiError } from "@/lib/server/api-response";
import { redactHostText } from "@/lib/workspace/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/projects/current/logs?conversationId=<id>
 * Per-conversation build/test/review reports (sanitized + truncated, scoped
 * through the conversation's own task artifacts).
 */

interface LogSection {
  kind: string;
  title: string;
  status: string | null;
  content: string;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + "\n…（已截断）" : value;
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
    const snapshot = conversation.currentSnapshotId
      ? repo.getCodeSnapshot(conversation.currentSnapshotId)
      : null;
    const sections: LogSection[] = [];

    const build = repo.getLatestArtifactForConversation(projectId, conversationId, "build_report");
    if (build) {
      try {
        const parsed = JSON.parse(build.content) as { status?: string; errorCode?: string | null; message?: string | null; log?: string };
        sections.push({
          kind: "build_report",
          title: "构建报告",
          status: parsed.status ?? null,
          content: truncate(redactHostText((parsed.log ?? "") || (parsed.message ?? ""), undefined), 6000),
        });
      } catch {
        // corrupted report is skipped, not fabricated
      }
    }
    if (snapshot?.buildReportJson && !sections.some((s) => s.kind === "build_report")) {
      try {
        const parsed = JSON.parse(snapshot.buildReportJson) as { status?: string; log?: string };
        sections.push({
          kind: "build_report",
          title: "构建报告",
          status: parsed.status ?? null,
          content: truncate(redactHostText(parsed.log ?? "", undefined), 6000),
        });
      } catch {
        // skip
      }
    }

    const test = repo.getLatestArtifactForConversation(projectId, conversationId, "test_report");
    if (test) {
      try {
        const parsed = JSON.parse(test.content) as { status?: string; summary?: string };
        sections.push({
          kind: "test_report",
          title: "测试报告",
          status: parsed.status ?? null,
          content: truncate(redactHostText(parsed.summary ?? "", undefined), 4000),
        });
      } catch {
        // skip
      }
    }

    const security = repo.getLatestArtifactForConversation(projectId, conversationId, "security_report");
    if (security) {
      try {
        const parsed = JSON.parse(security.content) as { status?: string; findings?: unknown[]; filesScanned?: number };
        const findings = Array.isArray(parsed.findings)
          ? parsed.findings
              .slice(0, 10)
              .map((finding) => {
                const record = finding as Record<string, unknown>;
                return "- [" + String(record.rule ?? "") + "] " + String(record.path ?? "") + ":" + String(record.line ?? "") + " " + String(record.message ?? "");
              })
              .join("\n")
          : "";
        sections.push({
          kind: "security_report",
          title: "安全扫描",
          status: parsed.status ?? null,
          content: truncate("扫描文件：" + String(parsed.filesScanned ?? 0) + (findings ? "\n" + findings : ""), 4000),
        });
      } catch {
        // skip
      }
    }

    return NextResponse.json({
      ok: true,
      data: { sections, version: snapshot?.version ?? null },
    });
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { SandboxError } from "@/lib/db/sandbox-data";

/**
 * Anonymous project session: project ownership is decided only by the server-issued HTTP-only cookie;
 * the projectId sent by the browser is never trusted.
 */

const PROJECT_COOKIE = "qubits_project";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const COOKIE_PATTERN = /^prj-[a-zA-Z0-9-]{8,64}$/;

export function readProjectId(request: NextRequest): string | null {
  const value = request.cookies.get(PROJECT_COOKIE)?.value ?? null;
  return value && COOKIE_PATTERN.test(value) ? value : null;
}

export function newProjectId(): string {
  return "prj-" + crypto.randomUUID();
}

/** (Re)writes the project cookie on the response: idempotent renewal, always returned with the final response. */
export function attachProjectCookie(response: NextResponse, projectId: string): void {
  response.cookies.set({
    name: PROJECT_COOKIE,
    value: projectId,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}

export function newRequestId(): string {
  return "req-" + crypto.randomUUID().slice(0, 8);
}

export function sandboxErrorResponse(error: unknown, requestId: string | null): NextResponse {
  if (error instanceof SandboxError) {
    return NextResponse.json(
      { ok: false, error: { code: error.code, message: error.message, requestId } },
      { status: error.status }
    );
  }
  // Log real errors server-side (without keys or full sensitive payload).
  console.error("[sandbox]", requestId, error instanceof Error ? error.message : error);
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "DB_ERROR",
        message: "数据服务暂时不可用，请稍后重试。",
        requestId,
      },
    },
    { status: 500 }
  );
}

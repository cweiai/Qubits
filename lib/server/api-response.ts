import { NextResponse } from "next/server";
import { SandboxError } from "@/lib/db/sandbox-data";

/** Workspace API business error: stable { code, message, requestId }, never leaks stack traces or internals. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export function apiErrorResponse(error: unknown, requestId: string | null): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { ok: false, error: { code: error.code, message: error.message, requestId } },
      { status: error.status }
    );
  }
  if (error instanceof SandboxError) {
    return NextResponse.json(
      { ok: false, error: { code: error.code, message: error.message, requestId } },
      { status: error.status }
    );
  }
  console.error("[api]", requestId, error instanceof Error ? error.message : error);
  return NextResponse.json(
    { ok: false, error: { code: "INTERNAL", message: "服务暂时不可用，请稍后重试。", requestId } },
    { status: 500 }
  );
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

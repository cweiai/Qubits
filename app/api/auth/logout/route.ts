import { NextRequest, NextResponse } from "next/server";
import { getRepository } from "@/lib/db";
import { clearAuthCookie, deleteCurrentSession } from "@/lib/server/auth";
import { clearProjectCookie } from "@/lib/sandbox/server-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: NextRequest): NextResponse {
  const repo = getRepository();
  deleteCurrentSession(request, repo);
  const response = NextResponse.json({ ok: true, data: { loggedOut: true } });
  clearAuthCookie(request, response);
  clearProjectCookie(request, response);
  return response;
}

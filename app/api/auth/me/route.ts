import { NextRequest, NextResponse } from "next/server";
import { getRepository } from "@/lib/db";
import { readAuthUser } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest): NextResponse {
  const user = readAuthUser(request, getRepository());
  return NextResponse.json({ ok: true, data: { user } });
}


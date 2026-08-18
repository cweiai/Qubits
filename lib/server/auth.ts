import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { AppRepository, UserRow } from "@/lib/db/repository";
import { ApiError } from "./api-response";

const AUTH_COOKIE = "qubits_auth";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_PATTERN = /^sess-[a-f0-9-]{16,80}$/;

export interface AuthUser {
  id: string;
  email: string;
  createdAt: number;
}

function toUser(row: UserRow): AuthUser {
  return { id: row.id, email: row.email, createdAt: row.createdAt };
}

export function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function validateCredentials(email: unknown, password: unknown): { email: string; password: string } {
  const normalized = normalizeEmail(email);
  if (!EMAIL_PATTERN.test(normalized) || normalized.length > 254) {
    throw new ApiError("INVALID_CREDENTIALS", "请输入有效的邮箱地址", 400);
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    throw new ApiError("INVALID_CREDENTIALS", "密码长度需为 8-128 位", 400);
  }
  return { email: normalized, password };
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("hex")}:${derived.toString("hex")}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, saltHex, hashHex] = encoded.split(":");
  if (algorithm !== "scrypt" || !saltHex || !hashHex) return false;
  try {
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function readAuthUser(request: NextRequest, repo: AppRepository): AuthUser | null {
  const sessionId = request.cookies.get(AUTH_COOKIE)?.value;
  if (!sessionId || !SESSION_PATTERN.test(sessionId)) return null;
  const session = repo.getAuthSession(sessionId);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    repo.deleteAuthSession(sessionId);
    return null;
  }
  const user = repo.getUser(session.userId);
  return user ? toUser(user) : null;
}

export function requireAuthUser(request: NextRequest, repo: AppRepository): AuthUser {
  const user = readAuthUser(request, repo);
  if (!user) throw new ApiError("AUTH_REQUIRED", "请先登录", 401);
  return user;
}

export function createSession(repo: AppRepository, userId: string): string {
  repo.deleteExpiredAuthSessions();
  const id = `sess-${randomBytes(24).toString("hex")}`;
  repo.createAuthSession({ id, userId, expiresAt: Date.now() + SESSION_TTL_MS });
  return id;
}

/** Whether the client reached us over HTTPS (directly or via a reverse proxy). */
export function isSecureRequest(request: NextRequest): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0].trim().toLowerCase() === "https";
  return request.nextUrl.protocol === "https:";
}

export function attachAuthCookie(request: NextRequest, response: NextResponse, sessionId: string): void {
  response.cookies.set({
    name: AUTH_COOKIE,
    value: sessionId,
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearAuthCookie(request: NextRequest, response: NextResponse): void {
  response.cookies.set({ name: AUTH_COOKIE, value: "", httpOnly: true, sameSite: "lax", secure: isSecureRequest(request), path: "/", maxAge: 0 });
}

export function deleteCurrentSession(request: NextRequest, repo: AppRepository): void {
  const sessionId = request.cookies.get(AUTH_COOKIE)?.value;
  if (sessionId && SESSION_PATTERN.test(sessionId)) repo.deleteAuthSession(sessionId);
}

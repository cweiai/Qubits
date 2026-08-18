import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { resetRepositoryForTests } from "@/lib/db";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as currentUser } from "@/app/api/auth/me/route";
import { GET as currentProject } from "@/app/api/projects/current/route";
import { POST as createConversation } from "@/app/api/projects/current/conversations/route";
import { GET as getConversation } from "@/app/api/conversations/[conversationId]/route";

function request(url: string, body?: unknown, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function authCookie(response: Response): string {
  const auth = (response as Response & { cookies: { get(name: string): { value: string } | undefined } }).cookies.get("qubits_auth")?.value;
  const project = (response as Response & { cookies: { get(name: string): { value: string } | undefined } }).cookies.get("qubits_project")?.value;
  return `qubits_auth=${auth}; qubits_project=${project}`;
}

describe("authentication routes", () => {
  let dir: string;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "qubits-auth-routes-"));
    process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
    resetRepositoryForTests();
  });

  afterEach(() => {
    resetRepositoryForTests();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers, logs in, and exposes the current user", async () => {
    const registered = await register(request("/api/auth/register", { email: "User@Example.com", password: "password-123", confirmPassword: "password-123" }));
    expect(registered.status).toBe(200);
    const cookie = authCookie(registered);
    const me = await currentUser(request("/api/auth/me", undefined, cookie));
    expect((await me.json()).data.user.email).toBe("user@example.com");

    const wrong = await login(request("/api/auth/login", { email: "user@example.com", password: "wrong-password" }));
    expect(wrong.status).toBe(401);
    const loggedIn = await login(request("/api/auth/login", { email: "user@example.com", password: "password-123" }));
    expect(loggedIn.status).toBe(200);
  });

  it("rejects registration when password confirmation does not match", async () => {
    const response = await register(
      request("/api/auth/register", {
        email: "mismatch@example.com",
        password: "password-123",
        confirmPassword: "password-456",
      })
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("PASSWORD_MISMATCH");
  });

  it("rejects project access without a login session", async () => {
    const response = await currentProject(request("/api/projects/current"));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("AUTH_REQUIRED");
  });

  it("isolates conversations between registered users", async () => {
    const firstRegistration = await register(request("/api/auth/register", { email: "first@example.com", password: "password-123", confirmPassword: "password-123" }));
    const firstCookie = authCookie(firstRegistration);
    const created = await createConversation(request("/api/projects/current/conversations", { id: "conv-auth-00000001" }, firstCookie));
    expect(created.status).toBe(200);

    const secondRegistration = await register(request("/api/auth/register", { email: "second@example.com", password: "password-456", confirmPassword: "password-456" }));
    const secondCookie = authCookie(secondRegistration);
    const denied = await getConversation(request("/api/conversations/conv-auth-00000001", undefined, secondCookie), {
      params: Promise.resolve({ conversationId: "conv-auth-00000001" }),
    });
    expect(denied.status).toBe(404);
    expect((await denied.json()).error.code).toBe("CONVERSATION_NOT_FOUND");
  });
});

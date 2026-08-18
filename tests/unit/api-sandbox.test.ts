import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { getRepository, resetRepositoryForTests } from "@/lib/db";
import { resetRateLimitsForTests } from "@/lib/db/sandbox-data";
import { POST as sessionPost } from "@/app/api/sandbox/session/route";
import { POST as listPost } from "@/app/api/sandbox/data/list/route";
import { POST as mutatePost } from "@/app/api/sandbox/data/mutate/route";
import { makeTaskManifest } from "./fixtures";

let dbDir: string;
const authCookies = new Map<string, string>();

function authenticatedCookie(cookie: string): string {
  const projectId = /(?:^|;\s*)qubits_project=([^;]+)/.exec(cookie)?.[1];
  if (!projectId) return cookie;
  const existing = authCookies.get(projectId);
  if (existing) return existing;
  const repo = getRepository();
  const suffix = crypto.randomUUID().replace(/-/g, "");
  const userId = `usr-${suffix}`;
  repo.createUser({ id: userId, email: `${suffix}@example.com`, passwordHash: "test" });
  repo.ensureProject(projectId);
  repo.setProjectUser(projectId, userId);
  const sessionId = `sess-${crypto.randomUUID().replace(/-/g, "")}`;
  repo.createAuthSession({ id: sessionId, userId, expiresAt: Date.now() + 60_000 });
  const value = `qubits_project=${projectId}; qubits_auth=${sessionId}`;
  authCookies.set(projectId, value);
  return value;
}

function request(pathname: string, body: unknown, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie: authenticatedCookie(cookie) } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function parseBody(response: Response): Promise<{ ok?: boolean; data?: Record<string, unknown>; error?: { code?: string; message?: string } }> {
  return (await response.json()) as { ok?: boolean; data?: Record<string, unknown>; error?: { code?: string; message?: string } };
}

/** Conversation-scoped sessions: create the project's conversation first. */
async function ensureConversation(cookie: string, id = "conv-" + crypto.randomUUID()): Promise<string> {
  const { getRepository } = await import("@/lib/db");
  const repo = getRepository();
  const projectId = cookie.split("=")[1] ?? "prj-test";
  repo.ensureProject(projectId);
  const existing = repo.getConversation(id);
  if (existing) return existing.id;
  repo.insertConversation({ id, projectId, title: "测试对话", titleSource: "auto" });
  return id;
}

async function createSession(
  manifest = makeTaskManifest(),
  cookie = "qubits_project=prj-test-0001"
): Promise<{ sessionId: string; conversationId: string; setCookie: string | null }> {
  const conversationId = await ensureConversation(cookie);
  const response = await sessionPost(request("/api/sandbox/session", { manifest, conversationId }, cookie));
  const body = await parseBody(response);
  expect(body.ok).toBe(true);
  const data = body.data as { sessionId: string };
  return { sessionId: data.sessionId, conversationId, setCookie: response.headers.getSetCookie().join("; ") };
}

beforeAll(() => {
  dbDir = mkdtempSync(path.join(tmpdir(), "qubits-api-"));
  process.env.DATABASE_URL = "file:" + path.join(dbDir, "test.db");
  resetRepositoryForTests();
  resetRateLimitsForTests();
});

afterAll(() => {
  resetRepositoryForTests();
  rmSync(dbDir, { recursive: true, force: true });
  delete process.env.DATABASE_URL;
});

describe("沙盒数据 API", () => {
  it("session → list/count → create 后持久化", async () => {
    const { sessionId } = await createSession();
    const cookie = "qubits_project=prj-test-0001";
    // New code model: no seeds in the manifest — starts empty.
    const list = await listPost(
      request("/api/sandbox/data/list", { sessionId, operation: "list", collection: "task" }, cookie)
    );
    const listBody = await parseBody(list);
    expect(listBody.ok).toBe(true);
    expect((listBody.data as { records: unknown[] }).records.length).toBe(0);

    const count = await listPost(
      request("/api/sandbox/data/list", { sessionId, operation: "count", collection: "task" }, cookie)
    );
    expect((await parseBody(count)).data).toEqual({ count: 0 });

    const created = await mutatePost(
      request("/api/sandbox/data/mutate", { sessionId, operation: "create", collection: "task", input: { title: "写周报", priority: "高" } }, cookie)
    );
    expect((await parseBody(created)).ok).toBe(true);
    const after = await listPost(
      request("/api/sandbox/data/list", { sessionId, operation: "list", collection: "task" }, cookie)
    );
    const records = (await parseBody(after)).data as { records: Array<{ title: string }> };
    expect(records.records.length).toBe(1);
    expect(records.records.some((r) => r.title === "写周报")).toBe(true);
  });

  it("create / update / delete 完整闭环（跨请求持久化）", async () => {
    const { sessionId } = await createSession(makeTaskManifest(), "qubits_project=prj-test-0002");
    const cookie = "qubits_project=prj-test-0002";

    const created = await mutatePost(
      request("/api/sandbox/data/mutate", { sessionId, operation: "create", collection: "task", input: { title: "新任务", priority: "高" } }, cookie)
    );
    const createdBody = await parseBody(created);
    expect(createdBody.ok).toBe(true);
    const record = (createdBody.data as { record: { id: string; title: string; priority: string } }).record;
    expect(record.title).toBe("新任务");

    const updated = await mutatePost(
      request("/api/sandbox/data/mutate", { sessionId, operation: "update", collection: "task", id: record.id, patch: { completed: true } }, cookie)
    );
    const updatedBody = await parseBody(updated);
    expect(updatedBody.ok).toBe(true);
    expect((updatedBody.data as { record: { completed: boolean } }).record.completed).toBe(true);

    const deleted = await mutatePost(
      request("/api/sandbox/data/mutate", { sessionId, operation: "delete", collection: "task", id: record.id }, cookie)
    );
    expect((await parseBody(deleted)).ok).toBe(true);

    const list = await listPost(
      request("/api/sandbox/data/list", { sessionId, operation: "list", collection: "task" }, cookie)
    );
    const records = (await parseBody(list)).data as { records: unknown[] };
    expect(records.records.length).toBe(0);
  });

  it("未声明的 collection 被拒绝", async () => {
    const { sessionId } = await createSession();
    const response = await listPost(
      request("/api/sandbox/data/list", { sessionId, operation: "list", collection: "undeclared" }, "qubits_project=prj-test-0001")
    );
    expect(response.status).toBe(403);
    expect((await parseBody(response)).error?.code).toBe("COLLECTION_NOT_DECLARED");
  });

  it("未声明的 operation 被拒绝", async () => {
    // Override the collection to allow only "list", so "create" is an undeclared operation.
    const manifest = makeTaskManifest({
      collections: [
        {
          name: "task",
          label: "任务",
          fields: [{ name: "title", label: "标题", type: "text", required: true, maxLength: 60 }],
          allowedOperations: ["list"],
        },
      ],
    });
    const { sessionId } = await createSession(manifest);
    const response = await mutatePost(
      request("/api/sandbox/data/mutate", { sessionId, operation: "create", collection: "task", input: { title: "x" } }, "qubits_project=prj-test-0001")
    );
    expect(response.status).toBe(403);
    expect((await parseBody(response)).error?.code).toBe("OPERATION_NOT_ALLOWED");
  });

  it("缺少必填字段 / 错误类型 / 超长 / 非法 query 被拒绝", async () => {
    const { sessionId } = await createSession();
    const cookie = "qubits_project=prj-test-0001";

    const missing = await mutatePost(
      request("/api/sandbox/data/mutate", { sessionId, operation: "create", collection: "task", input: { priority: "高" } }, cookie)
    );
    expect((await parseBody(missing)).error?.code).toBe("INVALID_INPUT");

    const badType = await mutatePost(
      request("/api/sandbox/data/mutate", { sessionId, operation: "create", collection: "task", input: { title: "x", priority: "高", completed: "yes" } }, cookie)
    );
    expect((await parseBody(badType)).error?.code).toBe("INVALID_INPUT");

    const tooLong = await mutatePost(
      request("/api/sandbox/data/mutate", { sessionId, operation: "create", collection: "task", input: { title: "x".repeat(61), priority: "高" } }, cookie)
    );
    expect((await parseBody(tooLong)).error?.code).toBe("INVALID_INPUT");

    const badQuery = await listPost(
      request("/api/sandbox/data/list", { sessionId, operation: "list", collection: "task", query: { sql: "SELECT 1" } }, cookie)
    );
    expect((await parseBody(badQuery)).error?.code).toBe("INVALID_QUERY");
  });

  it("跨项目隔离：不同 cookie 读不到对方记录", async () => {
    const { sessionId } = await createSession(makeTaskManifest({ appId: "app-shared" }), "qubits_project=prj-test-0001");
    // Project 1 creates a record.
    await mutatePost(
      request("/api/sandbox/data/mutate", { sessionId, operation: "create", collection: "task", input: { title: "项目一的记录", priority: "高" } }, "qubits_project=prj-test-0001")
    );
    const otherConversationId = await ensureConversation("qubits_project=prj-test-9999");
    const other = await sessionPost(
      request("/api/sandbox/session", { manifest: makeTaskManifest({ appId: "app-shared" }), conversationId: otherConversationId }, "qubits_project=prj-test-9999")
    );
    const otherBody = await parseBody(other);
    const otherSession = (otherBody.data as { sessionId: string }).sessionId;

    // Project 2 uses project 1's sessionId: scope mismatch.
    const cross = await listPost(
      request("/api/sandbox/data/list", { sessionId, operation: "list", collection: "task" }, "qubits_project=prj-test-9999")
    );
    expect(cross.status).toBe(403);

    // Project 2's own session can't see project 1's records (same appId, different project).
    const own = await listPost(
      request("/api/sandbox/data/list", { sessionId: otherSession, operation: "list", collection: "task" }, "qubits_project=prj-test-9999")
    );
    const ownBody = await parseBody(own);
    expect((ownBody.data as { records: unknown[] }).records.length).toBe(0);
  });

  it("未授权记录 id：update/delete 他人记录返回 RECORD_NOT_FOUND", async () => {
    const { sessionId } = await createSession(makeTaskManifest({ appId: "app-a" }), "qubits_project=prj-test-0001");
    // Project 2 creates its own record under the same appId.
    const other = await createSession(makeTaskManifest({ appId: "app-a" }), "qubits_project=prj-test-8888");
    const created = await mutatePost(
      request("/api/sandbox/data/mutate", { sessionId: other.sessionId, operation: "create", collection: "task", input: { title: "他人记录", priority: "低" } }, "qubits_project=prj-test-8888")
    );
    const record = ((await parseBody(created)).data as { record: { id: string } }).record;

    const update = await mutatePost(
      request("/api/sandbox/data/mutate", { sessionId, operation: "update", collection: "task", id: record.id, patch: { title: "篡改" } }, "qubits_project=prj-test-0001")
    );
    expect((await parseBody(update)).error?.code).toBe("RECORD_NOT_FOUND");
  });

  it("过期会话被拒绝", async () => {
    const conversationId = await ensureConversation("qubits_project=prj-test-0001");
    const response = await sessionPost(request("/api/sandbox/session", { manifest: makeTaskManifest(), conversationId }, "qubits_project=prj-test-0001"));
    const body = await parseBody(response);
    const sessionId = (body.data as { sessionId: string }).sessionId;

    // Mark the session as expired directly.
    const { getRepository } = await import("@/lib/db");
    getRepository().setSessionExpiry(sessionId, 1);

    const list = await listPost(
      request("/api/sandbox/data/list", { sessionId, operation: "list", collection: "task" }, "qubits_project=prj-test-0001")
    );
    expect((await parseBody(list)).error?.code).toBe("SESSION_EXPIRED");
  });

  it("无 cookie 时返回 UNAUTHORIZED", async () => {
    const response = await listPost(request("/api/sandbox/data/list", { sessionId: "sess-fake-0000", operation: "list", collection: "task" }));
    expect(response.status).toBe(401);
  });

  it("session 创建时校验 manifest 并返回集合契约；非法 manifest/跨对话被拒绝", async () => {
    const { setCookie } = await createSession();
    expect(setCookie).toContain("qubits_project=");
    const conversationId = await ensureConversation("qubits_project=prj-test-0001");
    const invalid = await sessionPost(
      request("/api/sandbox/session", { manifest: { schemaVersion: 1, name: "", collections: [{ name: "x", label: "x", fields: [], allowedOperations: [] }] }, conversationId }, "qubits_project=prj-test-0001")
    );
    expect(invalid.status).toBe(400);
    expect((await parseBody(invalid)).error?.code).toBe("INVALID_REQUEST");
    // Cross-project / missing conversation: 404 without leaking existence.
    const missing = await sessionPost(
      request("/api/sandbox/session", { manifest: makeTaskManifest(), conversationId: "conv-missing-00000001" }, "qubits_project=prj-test-0001")
    );
    expect(missing.status).toBe(404);
    expect((await parseBody(missing)).error?.code).toBe("CONVERSATION_NOT_FOUND");
  });

  it("一个对话对应一个应用：不同对话的数据相互隔离", async () => {
    // Conversation A creates a record; conversation B (same project) cannot see it.
    const sessionA = await createSession(makeTaskManifest(), "qubits_project=prj-test-0001");
    await mutatePost(
      request("/api/sandbox/data/mutate", { sessionId: sessionA.sessionId, operation: "create", collection: "task", input: { title: "对话 A 的记录", priority: "高" } }, "qubits_project=prj-test-0001")
    );
    const conversationB = await ensureConversation("qubits_project=prj-test-0001");
    const sessionB = await sessionPost(
      request("/api/sandbox/session", { manifest: makeTaskManifest(), conversationId: conversationB }, "qubits_project=prj-test-0001")
    );
    const sessionBId = ((await parseBody(sessionB)).data as { sessionId: string }).sessionId;
    expect(sessionBId).not.toBe(sessionA.sessionId);
    const listB = await listPost(
      request("/api/sandbox/data/list", { sessionId: sessionBId, operation: "list", collection: "task" }, "qubits_project=prj-test-0001")
    );
    const bodyB = await parseBody(listB);
    expect((bodyB.data as { records: unknown[] }).records.length).toBe(0);
    // Conversation A keeps its own data.
    const listA = await listPost(
      request("/api/sandbox/data/list", { sessionId: sessionA.sessionId, operation: "list", collection: "task" }, "qubits_project=prj-test-0001")
    );
    const bodyA = await parseBody(listA);
    expect((bodyA.data as { records: unknown[] }).records.length).toBe(1);
  });
});

import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { resetRepositoryForTests } from "@/lib/db";
import { resetRateLimitsForTests } from "@/lib/db/sandbox-data";
import { GET as projectGet, POST as projectMigrate } from "@/app/api/projects/current/route";
import { GET as listGet, POST as listPost } from "@/app/api/projects/current/conversations/route";
import { GET as convGet, PATCH as convPatch, DELETE as convDelete } from "@/app/api/conversations/[conversationId]/route";
import { POST as msgPost } from "@/app/api/conversations/[conversationId]/messages/route";
import { POST as taskRetry } from "@/app/api/build-tasks/[taskId]/route";
import { autoTitle } from "@/lib/workspace/auto-title";
import { makeTaskManifest, makeTaskSpec } from "./fixtures";
import { isRunActive, registerRun, resetRunRegistryForTests } from "@/lib/ai/run-registry";

let dbDir: string;

function req(pathname: string, method: string, body: unknown, cookie = "qubits_project=prj-cv-000001") {
  return new NextRequest("http://localhost" + pathname, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body === null ? undefined : JSON.stringify(body),
  });
}

async function json(response: Response): Promise<{ ok?: boolean; data?: Record<string, unknown>; error?: { code?: string } }> {
  return (await response.json()) as { ok?: boolean; data?: Record<string, unknown>; error?: { code?: string } };
}

beforeAll(() => {
  dbDir = mkdtempSync(path.join(tmpdir(), "qubits-cv-"));
  process.env.DATABASE_URL = "file:" + path.join(dbDir, "test.db");
  resetRepositoryForTests();
  resetRateLimitsForTests();
  resetRunRegistryForTests();
});

afterAll(() => {
  resetRepositoryForTests();
  rmSync(dbDir, { recursive: true, force: true });
  delete process.env.DATABASE_URL;
});

async function createConv(id: string) {
  const res = await listPost(req("/api/projects/current/conversations", "POST", { id }));
  const body = await json(res);
  expect(body.ok).toBe(true);
  return (body.data as { conversation: { id: string; title: string; titleSource: string } }).conversation;
}

async function send(conversationId: string, content: string, requestId: string) {
  const res = await msgPost(
    req("/api/conversations/" + conversationId + "/messages", "POST", { content, requestId }),
    convCtx(conversationId)
  );
  return { res, body: await json(res) };
}

const convCtx = (id: string) => ({ params: Promise.resolve({ conversationId: id }) });
const taskCtx = (id: string) => ({ params: Promise.resolve({ taskId: id }) });

describe("多对话 API", () => {
  it("创建多个对话，列表按最近更新时间排序，默认标题为“新对话”", async () => {
    const a = await createConv("conv-aaaa-000000000001");
    const b = await createConv("conv-aaaa-000000000002");
    expect(a.title).toBe("新对话");
    const list = await json(await listGet(req("/api/projects/current/conversations", "GET", null)));
    const conversations = (list.data as { conversations: Array<{ id: string }> }).conversations;
    expect(conversations.length).toBeGreaterThanOrEqual(2);
    // b was created later → sorted first.
    expect(conversations[0].id).toBe(b.id);
  });

  it("首条消息后自动生成短标题；手动重命名后不被覆盖", async () => {
    const conv = await createConv("conv-aaaa-000000000003");
    await send(conv.id, "创建一个个人任务管理器，可以新增任务", "req-idemp-000001");
    const detail = await json(await convGet(req("/api/conversations/" + conv.id, "GET", null), convCtx(conv.id)));
    const title = (detail.data as { conversation: { title: string } }).conversation.title;
    expect(title).not.toBe("新对话");
    expect(title).toBe(autoTitle("创建一个个人任务管理器，可以新增任务"));
    // Rename manually.
    await convPatch(req("/api/conversations/" + conv.id, "PATCH", { title: "我的自定义标题" }), convCtx(conv.id));
    await send(conv.id, "再改一下主题", "req-idemp-000002");
    const after = await json(await convGet(req("/api/conversations/" + conv.id, "GET", null), convCtx(conv.id)));
    expect((after.data as { conversation: { title: string; titleSource: string } }).conversation.title).toBe("我的自定义标题");
  });

  it("幂等：同一 requestId 不重复创建消息/任务", async () => {
    const conv = await createConv("conv-aaaa-000000000004");
    const first = await send(conv.id, "幂等测试消息", "req-idemp-000003");
    const second = await send(conv.id, "幂等测试消息", "req-idemp-000003");
    expect(second.body.ok).toBe(true);
    expect((second.body.data as { deduplicated: boolean }).deduplicated).toBe(true);
    expect((first.body.data as { userMessage: { id: string } }).userMessage.id).toBe(
      (second.body.data as { userMessage: { id: string } }).userMessage.id
    );
    const detail = await json(await convGet(req("/api/conversations/" + conv.id, "GET", null), convCtx(conv.id)));
    const messages = (detail.data as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages.filter((m) => m.role === "user" && m.content === "幂等测试消息")).toHaveLength(1);
  });

  it("项目级并发：有 running 任务时发送返回 409", async () => {
    const conv = await createConv("conv-aaaa-000000000005");
    const first = await send(conv.id, "第一条消息", "req-idemp-000004");
    const task = (first.body.data as { task: { id: string } }).task;
    // Manually mark the task as running.
    const { getRepository } = await import("@/lib/db");
    getRepository().updateTask(task.id, { status: "running", stage: "planning" });
    const second = await send(conv.id, "第二条消息", "req-idemp-000005");
    expect(second.res.status).toBe(409);
    expect(second.body.error?.code).toBe("BUILD_IN_PROGRESS");
    // Cleanup: avoid affecting later tests.
    getRepository().updateTask(task.id, { status: "failed", stage: "failed" });
  });

  it("归档后不能发送/重试；恢复后可发送", async () => {
    const conv = await createConv("conv-aaaa-000000000006");
    await convPatch(req("/api/conversations/" + conv.id, "PATCH", { status: "archived" }), convCtx(conv.id));
    const denied = await send(conv.id, "归档后发送", "req-idemp-000006");
    expect(denied.res.status).toBe(403);
    expect(denied.body.error?.code).toBe("CONVERSATION_ARCHIVED");
    await convPatch(req("/api/conversations/" + conv.id, "PATCH", { status: "active" }), convCtx(conv.id));
    const allowed = await send(conv.id, "恢复后发送", "req-idemp-000007");
    expect(allowed.body.ok).toBe(true);
  });

  it("跨项目无法读取对话/消息；无效 id 返回 404 且不泄漏", async () => {
    const conv = await createConv("conv-aaaa-000000000007");
    await send(conv.id, "项目 A 的消息", "req-idemp-000008");
    const otherCookie = "qubits_project=prj-cv-999999";
    const cross = await json(await convGet(req("/api/conversations/" + conv.id, "GET", null, otherCookie), convCtx(conv.id)));
    expect(cross.ok).toBe(false);
    expect(cross.error?.code).toBe("CONVERSATION_NOT_FOUND");
    const missing = await json(await convGet(req("/api/conversations/conv-aaaa-00000000ff", "GET", null), convCtx("conv-aaaa-00000000ff")));
    expect(missing.error?.code).toBe("CONVERSATION_NOT_FOUND");
  });

  it("删除最后一个对话后自动创建默认对话", async () => {
    // Use an isolated project to avoid affecting other tests.
    const soloCookie = "qubits_project=prj-cv-777777";
    const created = await json(await listPost(req("/api/projects/current/conversations", "POST", { id: "conv-aaaa-000000000008" }, soloCookie)));
    const convId = (created.data as { conversation: { id: string } }).conversation.id;
    const deleted = await json(await convDelete(req("/api/conversations/" + convId, "DELETE", null, soloCookie), convCtx(convId)));
    expect(deleted.ok).toBe(true);
    const fallback = (deleted.data as { fallbackConversationId: string }).fallbackConversationId;
    expect(fallback).toBeTruthy();
    const list = await json(await listGet(req("/api/projects/current/conversations", "GET", null, soloCookie)));
    const conversations = (list.data as { conversations: Array<{ id: string }> }).conversations;
    expect(conversations.some((c) => c.id === fallback)).toBe(true);
  });

  it("删除对话前先终止该对话运行中的生成任务，且等待其收尾后才删除", async () => {
    const conv = await createConv("conv-aaaa-000000000010");
    const first = await send(conv.id, "删除时正在生成", "req-idemp-000010");
    const taskId = (first.body.data as { task: { id: string } }).task.id;
    // Mark the task running and register a run handle (simulates an active run route).
    const { getRepository } = await import("@/lib/db");
    getRepository().updateTask(taskId, { status: "running", stage: "coding" });
    const handle = registerRun(taskId);
    let settled = false;
    void handle.done.then(() => {
      settled = true;
    });

    const deletePromise = convDelete(req("/api/conversations/" + conv.id, "DELETE", null), convCtx(conv.id));
    // Deletion must abort the loop and wait: nothing is deleted before done resolves.
    await vi.waitFor(() => expect(handle.controller.signal.aborted).toBe(true));
    expect(isRunActive(taskId)).toBe(true);
    expect(settled).toBe(false);
    // Loop fully settled → deletion proceeds.
    handle.markDone();
    const deleted = await json(await deletePromise);
    expect(deleted.ok).toBe(true);
    expect(settled).toBe(true);
    const after = await json(await convGet(req("/api/conversations/" + conv.id, "GET", null), convCtx(conv.id)));
    expect(after.ok).toBe(false);
    expect(after.error?.code).toBe("CONVERSATION_NOT_FOUND");
  });

  it("重试同一任务：同任务续跑（不新建任务、不追加用户消息）", async () => {
    const conv = await createConv("conv-aaaa-000000000009");
    const first = await send(conv.id, "待重试的消息", "req-idemp-000009");
    const taskId = (first.body.data as { task: { id: string } }).task.id;
    const retry = await json(await taskRetry(req("/api/build-tasks/" + taskId, "POST", {}, undefined), taskCtx(taskId)));
    expect(retry.ok).toBe(true);
    const retried = (retry.data as { task: { id: string; conversationId: string; status: string } }).task;
    // Retry, not recreate: same task id, back to pending.
    expect(retried.id).toBe(taskId);
    expect(retried.conversationId).toBe(conv.id);
    expect(retried.status).toBe("pending");
    const detail = await json(await convGet(req("/api/conversations/" + conv.id, "GET", null), convCtx(conv.id)));
    const users = (detail.data as { messages: Array<{ role: string }> }).messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
  });

  it("一个对话对应一个应用：对话 A 的应用状态不影响对话 B", async () => {
    const convA = await createConv("conv-aaaa-000000000011");
    const convB = await createConv("conv-aaaa-000000000012");
    const { getRepository } = await import("@/lib/db");
    const repo = getRepository();
    // Give conversation A app state (manifest + preview bundle artifact).
    repo.insertArtifact({
      id: "art-preview-000000000001",
      projectId: "prj-cv-000001",
      taskId: null,
      kind: "preview_bundle",
      name: "对话 A 应用",
      content: "<!doctype html><html><body>app-a</body></html>",
    });
    repo.updateConversationApp(convA.id, "prj-cv-000001", {
      manifestJson: JSON.stringify(makeTaskManifest()),
      previewBundleId: "art-preview-000000000001",
      previewVersion: 1,
      currentSnapshotId: null,
    });
    // Detail A carries app state; detail B does not.
    const detailA = await json(await convGet(req("/api/conversations/" + convA.id, "GET", null), convCtx(convA.id)));
    const appA = (detailA.data as { conversation: { app: { previewVersion: number; previewBundleId: string } } }).conversation.app;
    expect(appA.previewVersion).toBe(1);
    expect(appA.previewBundleId).toBe("art-preview-000000000001");
    const detailB = await json(await convGet(req("/api/conversations/" + convB.id, "GET", null), convCtx(convB.id)));
    const appB = (detailB.data as { conversation: { app: { previewVersion: number; previewBundleId: string | null } } }).conversation.app;
    expect(appB.previewVersion).toBe(0);
    expect(appB.previewBundleId).toBeNull();

    // Preview is conversation-scoped: B has none, A has one.
    const { GET: previewGet } = await import("@/app/api/projects/current/preview/route");
    const missing = await previewGet(
      new NextRequest("http://localhost/api/projects/current/preview?conversationId=" + convB.id, {
        method: "GET",
        headers: { cookie: "qubits_project=prj-cv-000001" },
      })
    );
    expect(missing.status).toBe(404);
    expect((await json(missing)).error?.code).toBe("PREVIEW_NOT_AVAILABLE");
    const present = await previewGet(
      new NextRequest("http://localhost/api/projects/current/preview?conversationId=" + convA.id, {
        method: "GET",
        headers: { cookie: "qubits_project=prj-cv-000001" },
      })
    );
    expect(present.status).toBe(200);
    expect(await present.text()).toContain("app-a");
  });

  it("旧项目级应用状态一次性迁移到最近对话（AppSpec 草稿保留）", async () => {
    // Isolated project: write legacy project-level state.
    const soloCookie = "qubits_project=prj-cv-666666";
    const { getRepository } = await import("@/lib/db");
    const repo = getRepository();
    repo.ensureProject("prj-cv-666666");
    repo.updateProjectDraft("prj-cv-666666", {
      appSpecJson: JSON.stringify(makeTaskSpec()),
      manifestJson: JSON.stringify(makeTaskManifest()),
      previewBundleId: "art-legacy-000000000001",
      previewVersion: 3,
      currentSnapshotId: null,
    });
    repo.insertArtifact({
      id: "art-legacy-000000000001",
      projectId: "prj-cv-666666",
      taskId: null,
      kind: "preview_bundle",
      name: "旧应用",
      content: "<!doctype html><html><body>legacy</body></html>",
    });
    const created = await json(await listPost(req("/api/projects/current/conversations", "POST", { id: "conv-aaaa-000000000013" }, soloCookie)));
    const convId = (created.data as { conversation: { id: string; app: { previewVersion: number } } }).conversation.id;
    // Project-level state migrated to this conversation.
    const detail = await json(await convGet(req("/api/conversations/" + convId, "GET", null, soloCookie), convCtx(convId)));
    const app = (detail.data as { conversation: { app: { previewVersion: number; previewBundleId: string | null; manifest: { name: string } | null } } }).conversation.app;
    expect(app.previewVersion).toBe(3);
    expect(app.previewBundleId).toBe("art-legacy-000000000001");
    expect(app.manifest?.name).toBe("测试任务管理器");
    // Project fields cleared (state handed over); the AppSpec draft remains.
    const project = repo.getProject("prj-cv-666666");
    expect(project?.previewBundleId).toBeNull();
    expect(project?.previewVersion).toBe(0);
    expect(project?.appSpecJson).toContain("test-task-app");
  });

  it("迁移：旧 localStorage 数据导入默认对话并写入草稿", async () => {
    const freshCookie = "qubits_project=prj-cv-888888";
    const migrated = await json(
      await projectMigrate(
        req(
          "/api/projects/current",
          "POST",
          {
            appSpec: makeTaskSpec(),
            legacyConversation: [
              { type: "user", text: "创建一个任务管理器", status: null },
              { type: "system", text: "旧欢迎语", status: null },
              { type: "engineer", text: "旧工程师摘要", status: "success", artifact: { hello: "world" } },
            ],
          },
          freshCookie
        )
      )
    );
    expect(migrated.ok).toBe(true);
    expect((migrated.data as { migrated: boolean }).migrated).toBe(true);
    const convId = (migrated.data as { conversationId: string }).conversationId;
    const detail = await json(await convGet(req("/api/conversations/" + convId, "GET", null, freshCookie), convCtx(convId)));
    const messages = (detail.data as { messages: Array<{ role: string }> }).messages;
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(messages.filter((m) => m.role === "system")).toHaveLength(1);
    const project = await json(await projectGet(req("/api/projects/current", "GET", null, freshCookie)));
    expect((project.data as { appSpec: { id: string } }).appSpec.id).toBe("test-task-app");
  });
});

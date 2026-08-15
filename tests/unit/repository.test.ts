import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppRepository } from "@/lib/db/repository";

describe("AppRepository", () => {
  let dir: string;
  let repo: AppRepository;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "qubits-repo-"));
    repo = new AppRepository(path.join(dir, "test.db"));
  });

  afterEach(() => {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("会话 CRUD 与过期清理", () => {
    repo.ensureProject("prj-a");
    repo.createSession({
      id: "sess-1",
      projectId: "prj-a",
      appId: "app-1",
      appVersion: 1,
      collectionsJson: "[]",
      expiresAt: Date.now() + 1000,
    });
    expect(repo.getSession("sess-1")?.appId).toBe("app-1");
    expect(repo.deleteExpiredSessions(Date.now() + 2000)).toBe(1);
    expect(repo.getSession("sess-1")).toBeNull();
  });

  it("记录按 project/app/collection 作用域隔离", () => {
    repo.insertRecord({ id: "r1", projectId: "p1", appId: "a1", collection: "task", dataJson: "{}" });
    repo.insertRecord({ id: "r2", projectId: "p2", appId: "a1", collection: "task", dataJson: "{}" });
    repo.insertRecord({ id: "r3", projectId: "p1", appId: "a2", collection: "task", dataJson: "{}" });

    expect(repo.listRecords("p1", "a1", "task").map((r) => r.id)).toEqual(["r1"]);
    expect(repo.countRecords("p1", "a1", "task")).toBe(1);

    // update must match the scope.
    expect(repo.updateRecord({ id: "r2", projectId: "p1", appId: "a1", collection: "task", dataJson: "{}" })).toBe(false);
    expect(repo.updateRecord({ id: "r1", projectId: "p1", appId: "a1", collection: "task", dataJson: "{\"ok\":true}" })).toBe(true);
    expect(repo.deleteRecord({ id: "r2", projectId: "p1", appId: "a1", collection: "task" })).toBe(false);
    expect(repo.deleteRecord({ id: "r1", projectId: "p1", appId: "a1", collection: "task" })).toBe(true);
  });

  it("审批状态持久化且只允许一次决策", () => {
    repo.ensureProject("prj-a");
    const approval = repo.createApproval({
      id: "apv-test-0001",
      projectId: "prj-a",
      taskId: "task-a",
      runId: "run-a",
      toolCallId: "call-a",
      toolName: "fs_delete",
      reason: "删除工作区文件",
      expiresAt: Date.now() + 60_000,
    });
    expect(approval.status).toBe("pending");
    expect(approval.toolCallId).toBe("call-a");
    expect(repo.resolveApproval(approval.id, "granted", "user")?.status).toBe("granted");
    expect(repo.resolveApproval(approval.id, "denied", "user")).toBeNull();
    expect(repo.getLatestApproval("run-a", "fs_delete")?.status).toBe("granted");
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppRepository } from "@/lib/db/repository";
import { SandboxError } from "@/lib/db/sandbox-data";
import { resolveDeploymentSession } from "@/lib/deploy/public-session";

/**
 * Public deployment sessions authorize requests without a project cookie: the
 * deploymentId + sessionId pair must match a live, unexpired deployment row.
 */

const COLLECTIONS = [
  {
    name: "task",
    label: "任务",
    fields: [{ name: "title", label: "标题", type: "text" as const, required: true }],
    allowedOperations: ["list", "count", "create", "update", "delete"] as const,
  },
];

describe("resolveDeploymentSession", () => {
  let dir: string;
  let repo: AppRepository;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "qubits-deploy-session-"));
    repo = new AppRepository(path.join(dir, "test.db"));
  });

  afterEach(() => {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  });

  let seedCounter = 0;
  function seedDeployment(overrides: { status?: string; expiresAt?: number; sessionId?: string } = {}) {
    seedCounter += 1;
    const deploymentId = "dep-" + String(seedCounter).padStart(8, "0") + "abcdef";
    const sessionId = overrides.sessionId ?? "sess-" + String(seedCounter).padStart(8, "0") + "-89ab-cdef-0123-456789abcdef";
    repo.ensureProject("prj-a");
    repo.createDeployment({
      id: deploymentId,
      projectId: "prj-a",
      conversationId: "conv-00000000-0000-4000-8000-000000000000",
      status: (overrides.status ?? "live") as never,
      sessionId: sessionId,
      containerName: "qubits-deploy-" + deploymentId,
      port: 32100 + seedCounter,
      bundleArtifactId: "art-1",
      expiresAt: overrides.expiresAt ?? Date.now() + 3600_000,
    });
    repo.createSession({
      id: sessionId,
      projectId: "prj-a",
      appId: deploymentId,
      appVersion: 1,
      collectionsJson: JSON.stringify(COLLECTIONS),
      expiresAt: Date.now() + 3600_000,
    });
    return { deploymentId, sessionId };
  }

  it("live 部署 + 匹配的会话解析成功", () => {
    const { deploymentId, sessionId } = seedDeployment();
    const resolved = resolveDeploymentSession(repo, deploymentId, sessionId);
    expect(resolved.deployment.id).toBe(deploymentId);
    expect(resolved.session.id).toBe(sessionId);
    expect(resolved.collections[0].name).toBe("task");
  });

  it("部署不存在或已下线被拒绝", () => {
    const { sessionId } = seedDeployment();
    expect(() => resolveDeploymentSession(repo, "dep-notfound0000", sessionId)).toThrowError(SandboxError);
    const { deploymentId } = seedDeployment();
    repo.updateDeployment(deploymentId, { status: "stopped" });
    expect(() => resolveDeploymentSession(repo, deploymentId, sessionId)).toThrowError(/下线/);
  });

  it("过期部署被拒绝", () => {
    const { deploymentId, sessionId } = seedDeployment({ expiresAt: Date.now() - 1000 });
    expect(() => resolveDeploymentSession(repo, deploymentId, sessionId)).toThrowError(/到期/);
  });

  it("sessionId 不匹配被拒绝", () => {
    const { deploymentId, sessionId } = seedDeployment();
    expect(() => resolveDeploymentSession(repo, deploymentId, "sess-evil-00000000-0000-0000-0000-000000000000")).toThrowError(SandboxError);
    expect(() => resolveDeploymentSession(repo, deploymentId, sessionId)).not.toThrow();
  });

  it("跨项目会话被拒绝", () => {
    const { deploymentId } = seedDeployment();
    repo.ensureProject("prj-b");
    repo.createSession({
      id: "sess-foreign-00000000-0000-0000-0000-000000000000",
      projectId: "prj-b",
      appId: deploymentId,
      appVersion: 1,
      collectionsJson: JSON.stringify(COLLECTIONS),
      expiresAt: Date.now() + 3600_000,
    });
    repo.updateDeployment(deploymentId, { sessionId: "sess-foreign-00000000-0000-0000-0000-000000000000" });
    expect(() =>
      resolveDeploymentSession(repo, deploymentId, "sess-foreign-00000000-0000-0000-0000-000000000000")
    ).toThrowError(/失效/);
  });
});

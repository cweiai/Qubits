import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { initWorkspace } from "@/lib/workspace/workspace-manager";
import { createCodeSnapshot, restoreCodeSnapshot, snapshotDirFor } from "@/lib/workspace/snapshot";

/**
 * Immutable code snapshots: creation copies the workspace (symlink-free, locked),
 * restore brings files back, and a promoted snapshot can seed a new task's workspace.
 */
const projectId = "prj-snapshot-0001";
const dirs: string[] = [];
function makeWorkspace(): string {
  const dir = path.join(process.cwd(), "data", "workspaces", "test-snap-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6));
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  try {
    rmSync(path.join(process.cwd(), "data", "snapshots", projectId), { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("代码快照", () => {
  it("create → 不可变目录 + 文件哈希清单；restore 恢复文件", async () => {
    const ws = makeWorkspace();
    initWorkspace(ws, { taskId: "task-snap-00000001" });
    // No template seeds the manifest anymore: the agent writes it before snapshotting.
    writeFileSync(
      path.join(ws, "qubits.manifest.json"),
      JSON.stringify({ schemaVersion: 1, name: "快照应用", description: "x", main: "src/main.tsx", collections: [], dependencies: [] })
    );
    writeFileSync(path.join(ws, "src", "custom.tsx"), "export const marker = 1;\n");

    const snapshot = await createCodeSnapshot(projectId, ws);
    expect(snapshot.files.some((f) => f.path === "src/custom.tsx")).toBe(true);
    expect(snapshot.files.some((f) => f.path === "qubits.manifest.json")).toBe(true);
    expect(snapshotDirFor(projectId, snapshot.snapshotId)).toContain(snapshot.snapshotId);

    // Creating the same snapshot id again is rejected (immutable).
    await expect(createCodeSnapshot(projectId, ws, snapshot.snapshotId)).rejects.toThrowError(/不可变/);

    // Restore into a fresh workspace.
    const ws2 = makeWorkspace();
    const restored = await restoreCodeSnapshot(snapshot.snapshotId, projectId, ws2);
    expect(restored).toBeGreaterThan(0);
    expect(readFileSync(path.join(ws2, "src", "custom.tsx"), "utf8")).toContain("marker");
  });

  it("不存在的快照恢复报 SNAPSHOT_NOT_FOUND", async () => {
    const ws = makeWorkspace();
    await expect(restoreCodeSnapshot("snap-missing-00000001", projectId, ws)).rejects.toThrowError(/快照不存在/);
  });

  it("快照可作为新任务工作区的种子来源", async () => {
    const ws = makeWorkspace();
    initWorkspace(ws, { taskId: "task-snap-00000002" });
    writeFileSync(path.join(ws, "src", "App.tsx"), "export function App() { return null; }\n");
    const snapshot = await createCodeSnapshot(projectId, ws);

    const ws2 = makeWorkspace();
    const info = initWorkspace(ws2, { taskId: "task-snap-00000003", sourceDir: snapshot.dir });
    expect(info.seededFrom).toBe("snapshot");
    expect(readFileSync(path.join(ws2, "src", "App.tsx"), "utf8")).toContain("return null");
  });

  it("workspace 含符号链接时快照失败关闭（SECURITY_BLOCKED）", async () => {
    const ws = makeWorkspace();
    initWorkspace(ws, { taskId: "task-snap-00000004" });
    const outside = makeWorkspace();
    writeFileSync(path.join(outside, "secret.txt"), "external-marker");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "escape"));
    await expect(createCodeSnapshot(projectId, ws)).rejects.toThrowError(/SECURITY_BLOCKED|符号链接/);
    // The block persists: the next attempt fails closed from the blocked state alone.
    await expect(createCodeSnapshot(projectId, ws)).rejects.toThrowError(/SECURITY_BLOCKED|安全阻断/);
  });
});

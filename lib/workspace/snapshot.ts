import "server-only";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, lstatSync, copyFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { WorkspaceError } from "./errors";
import { hashFile, listSourceFiles, requireWorkspace } from "./workspace-manager";

/**
 * Immutable code snapshots: one directory per snapshot under
 * data/snapshots/<projectId>/<snapshotId>/. Snapshots are created only after a run
 * passes build + tests + review, are never written again after creation, and are the
 * source for seeding new task workspaces and the read-only Code tab.
 */

export const SNAPSHOTS_ROOT = () => path.join(process.cwd(), "data", "snapshots");

export interface SnapshotFile {
  path: string;
  hash: string;
  size: number;
}

export interface CodeSnapshot {
  snapshotId: string;
  dir: string;
  files: SnapshotFile[];
  createdAt: number;
}

export function snapshotDirFor(projectId: string, snapshotId: string): string {
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(projectId)) {
    throw new WorkspaceError("PATH_ESCAPE", "非法 projectId", false);
  }
  if (!/^snap-[a-zA-Z0-9-]{8,64}$/.test(snapshotId)) {
    throw new WorkspaceError("PATH_ESCAPE", "非法 snapshotId", false);
  }
  return path.join(SNAPSHOTS_ROOT(), projectId, snapshotId);
}

/** Copy the workspace into a fresh immutable snapshot directory. */
export function createCodeSnapshot(projectId: string, workspaceDir: string, snapshotId?: string): CodeSnapshot {
  requireWorkspace(workspaceDir);
  const id = snapshotId ?? "snap-" + crypto.randomUUID();
  const dir = snapshotDirFor(projectId, id);
  if (existsSync(dir)) {
    throw new WorkspaceError("WORKSPACE_ERROR", "快照目录已存在（快照不可变）", false);
  }
  mkdirSync(dir, { recursive: true });
  const files = listSourceFiles(workspaceDir);
  for (const file of files) {
    const target = path.join(dir, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(file.abs, target);
  }
  const manifest = files.map((file) => ({
    path: file.path,
    hash: hashFile(path.join(dir, file.path)),
    size: lstatSync(path.join(dir, file.path)).size,
  }));
  return { snapshotId: id, dir, files: manifest, createdAt: Date.now() };
}

/** Restore a snapshot's files back into a workspace (system-owned files are identical). */
export function restoreCodeSnapshot(snapshotId: string, projectId: string, workspaceDir: string): number {
  const dir = snapshotDirFor(projectId, snapshotId);
  if (!existsSync(dir)) {
    throw new WorkspaceError("SNAPSHOT_NOT_FOUND", "快照不存在：" + snapshotId, false);
  }
  const restored: string[] = [];
  const walk = (current: string, rel: string): void => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      const relPath = rel ? rel + "/" + name : name;
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
        walk(full, relPath);
      } else if (stat.isFile()) {
        const target = path.join(workspaceDir, relPath);
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(full, target);
        restored.push(relPath);
      }
    }
  };
  walk(dir, "");
  return restored.length;
}

export function readSnapshotFile(projectId: string, snapshotId: string, relativePath: string): string {
  const dir = snapshotDirFor(projectId, snapshotId);
  if (!existsSync(dir)) {
    throw new WorkspaceError("SNAPSHOT_NOT_FOUND", "快照不存在", false);
  }
  const resolved = path.resolve(dir, relativePath);
  const relative = path.relative(dir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorkspaceError("PATH_ESCAPE", "拒绝快照目录外的路径", false);
  }
  if (!existsSync(resolved) || lstatSync(resolved).isDirectory()) {
    throw new WorkspaceError("NOT_FOUND", "文件不存在", false);
  }
  if (lstatSync(resolved).isSymbolicLink()) {
    throw new WorkspaceError("PATH_ESCAPE", "拒绝符号链接", false);
  }
  return readFileSync(resolved, "utf8");
}

export function removeSnapshotDir(projectId: string, snapshotId: string): void {
  const dir = snapshotDirFor(projectId, snapshotId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

export function writeSnapshotMarker(dir: string, meta: { projectId: string; taskId: string; version: number }): void {
  writeFileSync(path.join(dir, ".qubits-snapshot.json"), JSON.stringify({ ...meta, createdAt: Date.now() }, null, 2));
}

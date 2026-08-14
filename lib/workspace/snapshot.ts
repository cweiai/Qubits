import "server-only";
import { copyFileSync, existsSync, mkdirSync, lstatSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { WorkspaceError } from "./errors";
import { hashFile, requireWorkspace } from "./workspace-manager";
import {
  assertWorkspaceTreeSafe,
  clearWorkspaceBlock,
  readFileNofollow,
  resolveSnapshotPath,
  safeWalkWorkspace,
  safeWriteFile,
  withWorkspaceLock,
  writeFileNofollow,
} from "./paths";

/**
 * Immutable code snapshots: one directory per snapshot under
 * data/snapshots/<projectId>/<snapshotId>/. Snapshots are created only after a run
 * passes build + tests + review, are never written again after creation, and are the
 * source for seeding new task workspaces and the read-only Code tab.
 *
 * Snapshot creation/restore serialize with agent file operations through the
 * per-workspace mutex and refuse to run when the workspace contains symlinks or
 * special files (assertWorkspaceTreeSafe) — symlink content can never be copied out
 * of the workspace.
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

/** Copy the workspace into a fresh immutable snapshot directory (symlink-free, locked). */
export async function createCodeSnapshot(projectId: string, workspaceDir: string, snapshotId?: string): Promise<CodeSnapshot> {
  requireWorkspace(workspaceDir);
  return withWorkspaceLock(workspaceDir, async () => {
    assertWorkspaceTreeSafe(workspaceDir);
    const id = snapshotId ?? "snap-" + crypto.randomUUID();
    const dir = snapshotDirFor(projectId, id);
    if (existsSync(dir)) {
      throw new WorkspaceError("WORKSPACE_ERROR", "快照目录已存在（快照不可变）", false);
    }
    mkdirSync(dir, { recursive: true });
    const files = safeWalkWorkspace(workspaceDir).filter((entry) => entry.type === "file" && !entry.path.startsWith("dist/"));
    for (const file of files) {
      const target = path.join(dir, file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(file.abs, target); // source verified regular + symlink-free under the mutex
    }
    const manifest = files.map((file) => ({
      path: file.path,
      hash: hashFile(path.join(dir, file.path)),
      size: lstatSync(path.join(dir, file.path)).size,
    }));
    return { snapshotId: id, dir, files: manifest, createdAt: Date.now() };
  });
}

/** Restore a snapshot's files back into a workspace (system-owned files are identical). */
export async function restoreCodeSnapshot(snapshotId: string, projectId: string, workspaceDir: string): Promise<number> {
  const dir = snapshotDirFor(projectId, snapshotId);
  if (!existsSync(dir)) {
    throw new WorkspaceError("SNAPSHOT_NOT_FOUND", "快照不存在：" + snapshotId, false);
  }
  return withWorkspaceLock(workspaceDir, async () => {
    let restored = 0;
    const walk = (current: string, rel: string): void => {
      for (const name of readdirSync(current)) {
        const full = path.join(current, name);
        const relPath = rel ? rel + "/" + name : name;
        const stat = lstatSync(full);
        if (stat.isSymbolicLink() || stat.isSocket() || stat.isFIFO()) continue; // snapshots are never written with these
        if (stat.isDirectory()) {
          walk(full, relPath);
        } else if (stat.isFile()) {
          // Write through the workspace jail so every target path is re-validated.
          safeWriteFile(workspaceDir, relPath, readFileNofollow(full).toString("utf8"));
          restored++;
        }
      }
    };
    walk(dir, "");
    clearWorkspaceBlock(workspaceDir);
    return restored;
  });
}

export function readSnapshotFile(projectId: string, snapshotId: string, relativePath: string): string {
  const dir = snapshotDirFor(projectId, snapshotId);
  if (!existsSync(dir)) {
    throw new WorkspaceError("SNAPSHOT_NOT_FOUND", "快照不存在", false);
  }
  const resolved = resolveSnapshotPath(dir, relativePath);
  return readFileNofollow(resolved).toString("utf8");
}

export function removeSnapshotDir(projectId: string, snapshotId: string): void {
  const dir = snapshotDirFor(projectId, snapshotId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

export function writeSnapshotMarker(dir: string, meta: { projectId: string; taskId: string; version: number }): void {
  writeFileNofollow(path.join(dir, ".qubits-snapshot.json"), JSON.stringify({ ...meta, createdAt: Date.now() }, null, 2));
}

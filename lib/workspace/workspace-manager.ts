import "server-only";
import { createHash } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, writeSync } from "node:fs";
import path from "node:path";
import { MANIFEST_FILE_NAME, parseManifestText, type QubitsManifest } from "@/lib/contracts/manifest";
import { WorkspaceError } from "./errors";
import {
  clearWorkspaceBlock,
  isSystemOwnedPath,
  readFileNofollow,
  safeResolveWorkspacePath,
  safeWalkWorkspace,
  safeWriteFile,
  SYSTEM_OWNED_PATTERNS,
} from "./paths";

/**
 * Workspace manager: the code workspace under data/workspaces/<taskId> is the single
 * source of truth for the generated app.
 *
 * - initWorkspace is idempotent: an existing workspace (marker file) is never re-seeded;
 * - a NEW workspace starts with ONLY the system skeleton (package.json / tsconfig.json /
 *   the SDK bridge src/lib/qubits.ts — all system-owned). There is no example-app
 *   template: the agent writes qubits.manifest.json, src/main.tsx and every other file
 *   itself. New tasks on an existing project seed from the project's last successful
 *   code snapshot instead;
 * - retries reuse the same workspace and never delete existing files;
 * - every walk is lstatSync-based through safeWalkWorkspace: symlinks/special files
 *   mark the workspace SECURITY_BLOCKED and every access fails closed.
 */

export const WORKSPACE_MARKER = ".qubits-workspace.json";
const SKELETON_DIR = path.join(process.cwd(), "lib", "workspace", "system-skeleton");
const SKIP_COPY = new Set(["node_modules", "dist", ".qubits-trash"]);

export interface WorkspaceInfo {
  taskId: string;
  createdAt: number;
  seededFrom: "skeleton" | "snapshot" | "existing";
  template?: string;
}

export interface FileEntry {
  path: string;
  type: "file" | "dir";
  size: number;
  systemOwned: boolean;
}

export function hashText(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Hash an already-validated absolute path without following a symlinked final component. */
export function hashFile(absPath: string): string {
  return createHash("sha256").update(readFileNofollow(absPath)).digest("hex");
}

/** Copy a trusted tree (skeleton/snapshot); never follows symlinks, rejects special files. */
function copyTree(fromDir: string, toDir: string): void {
  mkdirSync(toDir, { recursive: true });
  for (const name of readdirSync(fromDir)) {
    if (SKIP_COPY.has(name)) continue;
    const from = path.join(fromDir, name);
    const to = path.join(toDir, name);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) continue; // never copy symlink content outside
    if (stat.isSocket() || stat.isFIFO() || stat.isBlockDevice() || stat.isCharacterDevice()) {
      throw new WorkspaceError("SECURITY_BLOCKED", "骨架/快照包含特殊文件：" + name, false);
    }
    if (stat.isDirectory()) {
      copyTree(from, to);
    } else if (stat.isFile()) {
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
  }
}

function readMarker(workspaceDir: string): WorkspaceInfo | null {
  const markerPath = path.join(workspaceDir, WORKSPACE_MARKER);
  if (!existsSync(markerPath)) return null;
  try {
    const parsed = JSON.parse(readFileNofollow(markerPath).toString("utf8")) as Partial<WorkspaceInfo>;
    if (typeof parsed?.taskId === "string" && typeof parsed?.createdAt === "number") {
      return {
        taskId: parsed.taskId,
        createdAt: parsed.createdAt,
        // Legacy markers may still say "template"; treat them as skeleton-seeded.
        seededFrom: (String(parsed.seededFrom) === "template" ? "skeleton" : (parsed.seededFrom as WorkspaceInfo["seededFrom"])) ?? "existing",
        template: typeof parsed.template === "string" ? parsed.template : undefined,
      };
    }
  } catch {
    // corrupted marker: treat as uninitialized
  }
  return null;
}

/** Idempotent workspace initialization: skeleton (or snapshot) only, never an example app. */
export function initWorkspace(workspaceDir: string, input: { taskId: string; sourceDir?: string | null }): WorkspaceInfo {
  mkdirSync(workspaceDir, { recursive: true });
  const existing = readMarker(workspaceDir);
  if (existing) {
    // A restored/seeded workspace is trusted; a blocked one stays blocked.
    return { ...existing, seededFrom: "existing" };
  }
  if (input.sourceDir && existsSync(input.sourceDir)) {
    copyTree(input.sourceDir, workspaceDir);
  } else {
    if (!existsSync(SKELETON_DIR)) {
      throw new WorkspaceError("WORKSPACE_ERROR", "系统骨架缺失，无法初始化工作区", false);
    }
    copyTree(SKELETON_DIR, workspaceDir);
  }
  const info: WorkspaceInfo = {
    taskId: input.taskId,
    createdAt: Date.now(),
    seededFrom: input.sourceDir && existsSync(input.sourceDir) ? "snapshot" : "skeleton",
  };
  writeFileNofollowMarker(workspaceDir, info);
  clearWorkspaceBlock(workspaceDir);
  return info;
}

function writeFileNofollowMarker(workspaceDir: string, info: WorkspaceInfo): void {
  const markerPath = path.join(workspaceDir, WORKSPACE_MARKER);
  const nofollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(markerPath, (constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC) | nofollow, 0o644);
  try {
    const buffer = Buffer.from(JSON.stringify(info, null, 2), "utf8");
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
  } finally {
    closeSync(fd);
  }
}

export function getWorkspaceInfo(workspaceDir: string): WorkspaceInfo | null {
  if (!existsSync(workspaceDir)) return null;
  return readMarker(workspaceDir);
}

export function requireWorkspace(workspaceDir: string): WorkspaceInfo {
  const info = getWorkspaceInfo(workspaceDir);
  if (!info) throw new WorkspaceError("WORKSPACE_NOT_INITIALIZED", "工作区尚未初始化，请先调用 workspace_init", false);
  return info;
}

export function readWorkspaceManifest(workspaceDir: string): QubitsManifest {
  requireWorkspace(workspaceDir);
  const { resolved } = safeResolveWorkspacePath(workspaceDir, MANIFEST_FILE_NAME);
  if (!existsSync(resolved)) {
    throw new WorkspaceError("INVALID_MANIFEST", "qubits.manifest.json 缺失", false);
  }
  const parsed = parseManifestText(readFileNofollow(resolved).toString("utf8"));
  if (!parsed.ok) {
    throw new WorkspaceError("INVALID_MANIFEST", "manifest 校验失败：" + parsed.issues.slice(0, 4).join("；"), false);
  }
  return parsed.manifest;
}

/** System-only manifest write (used by dependency tools after allowlist validation). */
export function writeWorkspaceManifest(workspaceDir: string, manifest: QubitsManifest): void {
  requireWorkspace(workspaceDir);
  safeWriteFile(workspaceDir, MANIFEST_FILE_NAME, JSON.stringify(manifest, null, 2) + "\n");
}

export function listWorkspaceFiles(workspaceDir: string, maxEntries = 200): FileEntry[] {
  requireWorkspace(workspaceDir);
  // lstat-only walk; symlinks/special files fail closed (SECURITY_BLOCKED).
  const entries = safeWalkWorkspace(workspaceDir).slice(0, maxEntries);
  return entries.map((entry) => ({
    path: entry.path,
    type: entry.type,
    size: entry.size,
    systemOwned: isSystemOwnedPath(entry.path),
  }));
}

/** Files that participate in build/hash/snapshot (exclude dist + internal dirs). */
export function listSourceFiles(workspaceDir: string): Array<{ path: string; abs: string }> {
  requireWorkspace(workspaceDir);
  return safeWalkWorkspace(workspaceDir)
    .filter((entry) => entry.type === "file" && !entry.path.startsWith("dist/"))
    .map((entry) => ({ path: entry.path, abs: entry.abs }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function workspaceFileManifest(workspaceDir: string): Array<{ path: string; hash: string; size: number }> {
  return listSourceFiles(workspaceDir).map(({ path: rel, abs }) => ({
    path: rel,
    hash: hashFile(abs),
    size: lstatSync(abs).size,
  }));
}

export function systemOwnedNoteFor(raw: string): string | null {
  const normalized = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  const match = SYSTEM_OWNED_PATTERNS.find(({ pattern }) => pattern.test(normalized));
  return match ? match.note : null;
}

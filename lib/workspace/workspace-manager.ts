import "server-only";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MANIFEST_FILE_NAME, parseManifestText, type QubitsManifest } from "@/lib/contracts/manifest";
import { WorkspaceError } from "./errors";
import { isSystemOwnedPath, resolveWorkspacePath, SYSTEM_OWNED_PATTERNS } from "./paths";

/**
 * Workspace manager: the code workspace under data/workspaces/<taskId> is the single
 * source of truth for the generated app.
 *
 * - initWorkspace is idempotent: an existing workspace (marker file) is never re-seeded;
 * - new tasks seed from the project's last successful code snapshot, first generations
 *   from the trusted template;
 * - retries reuse the same workspace and never delete existing files.
 */

export const WORKSPACE_MARKER = ".qubits-workspace.json";
const TEMPLATE_DIR = path.join(process.cwd(), "lib", "workspace", "template");
const SKIP_COPY = new Set(["node_modules", "dist", ".qubits-trash"]);

export interface WorkspaceInfo {
  taskId: string;
  createdAt: number;
  seededFrom: "template" | "snapshot" | "existing";
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

export function hashFile(absPath: string): string {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

function copyTree(fromDir: string, toDir: string): void {
  mkdirSync(toDir, { recursive: true });
  for (const name of readdirSync(fromDir)) {
    if (SKIP_COPY.has(name)) continue;
    const from = path.join(fromDir, name);
    const to = path.join(toDir, name);
    const stat = lstatSync(from);
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
    const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<WorkspaceInfo>;
    if (typeof parsed?.taskId === "string" && typeof parsed?.createdAt === "number") {
      return {
        taskId: parsed.taskId,
        createdAt: parsed.createdAt,
        seededFrom: (parsed.seededFrom as WorkspaceInfo["seededFrom"]) ?? "existing",
        template: typeof parsed.template === "string" ? parsed.template : undefined,
      };
    }
  } catch {
    // corrupted marker: treat as uninitialized
  }
  return null;
}

/** Idempotent workspace initialization. sourceDir (a snapshot) wins over the template. */
export function initWorkspace(workspaceDir: string, input: { taskId: string; sourceDir?: string | null }): WorkspaceInfo {
  mkdirSync(workspaceDir, { recursive: true });
  const existing = readMarker(workspaceDir);
  if (existing) {
    return { ...existing, seededFrom: "existing" };
  }
  if (input.sourceDir && existsSync(input.sourceDir)) {
    copyTree(input.sourceDir, workspaceDir);
  } else {
    if (!existsSync(TEMPLATE_DIR)) {
      throw new WorkspaceError("WORKSPACE_ERROR", "可信模板缺失，无法初始化工作区", false);
    }
    copyTree(TEMPLATE_DIR, workspaceDir);
  }
  const info: WorkspaceInfo = {
    taskId: input.taskId,
    createdAt: Date.now(),
    seededFrom: input.sourceDir && existsSync(input.sourceDir) ? "snapshot" : "template",
  };
  writeFileSync(path.join(workspaceDir, WORKSPACE_MARKER), JSON.stringify(info, null, 2));
  return info;
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
  const manifestPath = resolveWorkspacePath(workspaceDir, MANIFEST_FILE_NAME);
  if (!existsSync(manifestPath)) {
    throw new WorkspaceError("INVALID_MANIFEST", "qubits.manifest.json 缺失", false);
  }
  const parsed = parseManifestText(readFileSync(manifestPath, "utf8"));
  if (!parsed.ok) {
    throw new WorkspaceError("INVALID_MANIFEST", "manifest 校验失败：" + parsed.issues.slice(0, 4).join("；"), false);
  }
  return parsed.manifest;
}

/** System-only manifest write (used by dependency tools after allowlist validation). */
export function writeWorkspaceManifest(workspaceDir: string, manifest: QubitsManifest): void {
  requireWorkspace(workspaceDir);
  const manifestPath = resolveWorkspacePath(workspaceDir, MANIFEST_FILE_NAME);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

export function listWorkspaceFiles(workspaceDir: string, maxEntries = 200): FileEntry[] {
  requireWorkspace(workspaceDir);
  const entries: FileEntry[] = [];
  const walk = (current: string, rel: string, depth: number): void => {
    if (entries.length >= maxEntries || depth > 8) return;
    for (const name of readdirSync(current).slice(0, maxEntries - entries.length)) {
      if (name === "node_modules" || name === ".qubits-trash") continue;
      const full = path.join(current, name);
      const relPath = rel ? rel + "/" + name : name;
      try {
        const stat = lstatSync(full);
        const systemOwned = isSystemOwnedPath(relPath);
        entries.push({ path: relPath, type: stat.isDirectory() ? "dir" : "file", size: stat.isFile() ? stat.size : 0, systemOwned });
        if (stat.isDirectory()) walk(full, relPath, depth + 1);
      } catch {
        // unreadable entries are skipped
      }
    }
  };
  walk(workspaceDir, "", 1);
  return entries;
}

/** Files that participate in build/hash/snapshot (exclude dist + internal dirs). */
export function listSourceFiles(workspaceDir: string): Array<{ path: string; abs: string }> {
  requireWorkspace(workspaceDir);
  const out: Array<{ path: string; abs: string }> = [];
  const walk = (current: string, rel: string, depth: number): void => {
    if (depth > 8) return;
    for (const name of readdirSync(current)) {
      if (SKIP_COPY.has(name)) continue;
      const full = path.join(current, name);
      const relPath = rel ? rel + "/" + name : name;
      try {
        const stat = lstatSync(full);
        if (stat.isDirectory()) walk(full, relPath, depth + 1);
        else if (stat.isFile()) out.push({ path: relPath, abs: full });
      } catch {
        // skip unreadable
      }
    }
  };
  walk(workspaceDir, "", 1);
  return out.sort((a, b) => a.path.localeCompare(b.path));
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

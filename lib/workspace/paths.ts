import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  writeSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { WorkspaceError } from "./errors";

/**
 * Unified workspace path jail + TOCTOU guard. Every agent-facing file access MUST go
 * through the helpers in this module; direct fs calls on agent-controlled paths are
 * forbidden elsewhere.
 *
 * Hardening model:
 * - `safeResolveWorkspacePath` canonicalizes the workspace root via realpathSync and
 *   walks EVERY path segment with lstatSync: any symlink component (intermediate or
 *   final), special file (socket/FIFO/device) or `..`/absolute/Windows-style segment
 *   is rejected with PATH_ESCAPE.
 * - `withWorkspaceLock` is a per-workspace async mutex (re-entrant through
 *   AsyncLocalStorage) that serializes agent file operations, container exec and
 *   build/snapshot/format — the container process can never race a host-side file
 *   operation.
 * - `assertWorkspaceTreeSafe` scans the whole tree with lstatSync (never following
 *   links). Any symlink/special file found marks the workspace SECURITY_BLOCKED:
 *   all further reads, builds, previews and snapshots fail closed until the workspace
 *   is restored from a checkpoint or re-initialized.
 * - Reads/writes open with O_NOFOLLOW so the final path component can never be a
 *   symlink at open time; the mutex closes the intermediate-directory TOCTOU window.
 */

export const SENSITIVE_FILE = /(\.env|\.pem|\.key$|\.p12$|id_rsa|id_ed25519|\.ssh\/|\.git\/config|\.npmrc$)/i;

/** System-owned files: AI tools must never write/delete these (launcher, SDK bridge, configs, dist). */
export const SYSTEM_OWNED_PATTERNS: Array<{ pattern: RegExp; note: string }> = [
  { pattern: /^package\.json$/, note: "package.json 由系统维护" },
  { pattern: /^tsconfig\.json$/, note: "tsconfig.json 由系统维护" },
  { pattern: /^src\/lib\/qubits\.ts$/, note: "SDK bridge 由系统维护" },
  { pattern: /(^|\/)(vite|vitest|eslint|tailwind|postcss)\.config\.[a-z]+$/, note: "构建配置由系统维护" },
  { pattern: /^dist\//, note: "构建产物由系统维护" },
  { pattern: /^node_modules\//, note: "依赖目录由系统维护" },
  { pattern: /^\.qubits(-trash)?\//, note: "系统内部目录" },
  { pattern: /^index\.html$/, note: "预览入口由系统维护" },
];

export function isSystemOwnedPath(raw: string): boolean {
  const normalized = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  return SYSTEM_OWNED_PATTERNS.some(({ pattern }) => pattern.test(normalized));
}

/** Directories never copied/scanned recursively: containers may create legit symlinks in node_modules. */
const SKIP_SCAN_DIRS = new Set(["node_modules", ".qubits-trash"]);

const O_NOFOLLOW: number = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

export interface ResolvedWorkspacePath {
  /** Absolute host path (inside the canonical workspace root). */
  resolved: string;
  /** Normalized workspace-relative path ("" = workspace root). */
  relative: string;
}

/** Normalize and validate a workspace-relative raw path. Throws PATH_ESCAPE otherwise. */
export function normalizeWorkspaceRelative(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 400) {
    throw new WorkspaceError("PATH_ESCAPE", "路径不合法（为空或过长）", false);
  }
  if (raw.includes("\0")) throw new WorkspaceError("PATH_ESCAPE", "路径包含非法字符（NUL）", false);
  if (raw.includes("\\")) {
    throw new WorkspaceError("PATH_ESCAPE", "拒绝 Windows 风格或混合分隔符路径（只接受 / 分隔的相对路径）", false);
  }
  if (path.isAbsolute(raw)) {
    throw new WorkspaceError("PATH_ESCAPE", "拒绝绝对路径（只接受工作区内相对路径，例如 src/app.tsx）", false);
  }
  const stripped = raw.replace(/^\.\/+/, "");
  const segments = stripped.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new WorkspaceError("PATH_ESCAPE", "拒绝包含 .. 的路径段", false);
  }
  if (segments.some((segment) => segment === "")) {
    throw new WorkspaceError("PATH_ESCAPE", "路径包含空路径段（如 a//b 或结尾 /）", false);
  }
  const normalized = segments.filter((segment) => segment !== ".").join("/");
  if (SENSITIVE_FILE.test(normalized)) {
    throw new WorkspaceError("PATH_ESCAPE", "拒绝访问敏感文件（如 .env / 密钥 / .npmrc / .git/config）", false);
  }
  return normalized;
}

/** Canonical (realpath) workspace root; rejects symlinked or missing workspace dirs. */
export function canonicalWorkspaceRoot(workspaceDir: string): string {
  let real: string;
  try {
    real = realpathSync(workspaceDir);
  } catch {
    throw new WorkspaceError("PATH_ESCAPE", "workspace 目录不存在或不可访问", false);
  }
  // lstat detects the dir ITSELF being a symlink (realpath equality would also trip on
  // macOS /var → /private/var and /tmp → /private/tmp prefix links).
  try {
    if (lstatSync(workspaceDir).isSymbolicLink()) {
      throw new WorkspaceError("PATH_ESCAPE", "workspace 目录本身是符号链接，拒绝访问", false);
    }
  } catch {
    // missing already handled above
  }
  return real;
}

function isSpecialStat(stat: Stats): boolean {
  return stat.isSocket() || stat.isFIFO() || stat.isBlockDevice() || stat.isCharacterDevice();
}

/**
 * Resolve a workspace-relative path strictly inside the canonical workspace root.
 * Walks every existing segment with lstatSync: intermediate or final symlinks, special
 * files and out-of-root components all throw PATH_ESCAPE. For not-yet-existing targets
 * every existing ancestor has already been verified symlink-free.
 */
export function safeResolveWorkspacePath(workspaceDir: string, raw: string): ResolvedWorkspacePath {
  const relative = normalizeWorkspaceRelative(raw);
  const root = canonicalWorkspaceRoot(workspaceDir);
  const candidate = path.resolve(root, relative);
  const relCheck = path.relative(root, candidate);
  if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
    throw new WorkspaceError("PATH_ESCAPE", "拒绝工作区外的路径", false);
  }
  const segments = relative.split("/").filter((segment) => segment.length > 0);
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    if (!existsSync(current)) break; // remaining part does not exist yet
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new WorkspaceError("PATH_ESCAPE", "拒绝符号链接（含中间目录）：" + segments.slice(0, index + 1).join("/"), false);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new WorkspaceError("PATH_ESCAPE", "路径的中间组件不是目录：" + segments.slice(0, index + 1).join("/"), false);
    }
    if (isSpecialStat(stat)) {
      throw new WorkspaceError("PATH_ESCAPE", "拒绝特殊文件（socket/设备/FIFO）：" + segments.slice(0, index + 1).join("/"), false);
    }
  }
  return { resolved: candidate, relative };
}

/** Resolve a snapshot-relative path inside a snapshot dir (read-only viewer). */
export function resolveSnapshotPath(snapshotDir: string, raw: string): string {
  const { resolved } = safeResolveWorkspacePath(snapshotDir, raw);
  if (!existsSync(resolved) || lstatSync(resolved).isDirectory()) {
    throw new WorkspaceError("NOT_FOUND", "文件不存在", false);
  }
  return resolved;
}

// ── Per-workspace security state (SECURITY_BLOCKED) and async mutex ──

const blockedWorkspaces = new Map<string, string>(); // canonical root → reason
const lockChains = new Map<string, Promise<void>>();
const lockStore = new AsyncLocalStorage<Set<string>>();

function lockKey(workspaceDir: string): string {
  try {
    return realpathSync(workspaceDir);
  } catch {
    return path.resolve(workspaceDir);
  }
}

/** Re-entrant per-workspace async mutex: serializes agent fs ops, container exec and build/snapshot/format. */
export async function withWorkspaceLock<T>(workspaceDir: string, fn: () => Promise<T>): Promise<T> {
  const key = lockKey(workspaceDir);
  const held = lockStore.getStore();
  if (held?.has(key)) return fn();
  const previous = lockChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => gate);
  lockChains.set(key, next);
  await previous.catch(() => undefined);
  const store = new Set(held ?? []);
  store.add(key);
  try {
    return await lockStore.run(store, fn);
  } finally {
    release();
    if (lockChains.get(key) === next) lockChains.delete(key);
  }
}

export function markWorkspaceBlocked(workspaceDir: string, reason: string): void {
  blockedWorkspaces.set(lockKey(workspaceDir), reason.slice(0, 300));
}

export function clearWorkspaceBlock(workspaceDir: string): void {
  blockedWorkspaces.delete(lockKey(workspaceDir));
}

export function workspaceBlockReason(workspaceDir: string): string | null {
  return blockedWorkspaces.get(lockKey(workspaceDir)) ?? null;
}

/** Fail closed on every workspace access once a symlink/special file has been detected. */
export function assertWorkspaceUsable(workspaceDir: string): void {
  const reason = workspaceBlockReason(workspaceDir);
  if (reason) {
    throw new WorkspaceError("SECURITY_BLOCKED", "工作区已被安全阻断：" + reason + "。请 restore_checkpoint 恢复或重新初始化工作区。", false);
  }
}

/**
 * lstatSync-based tree scan (never follows symlinks). Any symlink or special file
 * (socket/FIFO/device) marks the workspace SECURITY_BLOCKED and throws.
 * node_modules and .qubits-trash are skipped (containers may legitimately create
 * symlinks inside node_modules; trash is host-managed).
 */
export function assertWorkspaceTreeSafe(workspaceDir: string): void {
  assertWorkspaceUsable(workspaceDir);
  const root = canonicalWorkspaceRoot(workspaceDir);
  const problems: string[] = [];
  const walk = (current: string, rel: string, depth: number): void => {
    if (depth > 12 || problems.length >= 5) return;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP_SCAN_DIRS.has(name)) continue;
      const full = path.join(current, name);
      const relPath = rel ? rel + "/" + name : name;
      let stat: Stats;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        problems.push(relPath + "（符号链接）");
        continue;
      }
      if (isSpecialStat(stat)) {
        problems.push(relPath + "（特殊文件）");
        continue;
      }
      if (stat.isDirectory()) walk(full, relPath, depth + 1);
    }
  };
  walk(root, "", 0);
  if (problems.length > 0) {
    const message = "工作区检测到符号链接/特殊文件：" + problems.join("、");
    markWorkspaceBlocked(workspaceDir, message);
    throw new WorkspaceError("SECURITY_BLOCKED", message, false);
  }
}

/** Open flags helper: O_NOFOLLOW refuses a symlinked final component at open time. */
function nofollowFlags(base: number): number {
  return O_NOFOLLOW ? base | O_NOFOLLOW : base;
}

function wrapOpenError(error: unknown, label: string): never {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ELOOP") throw new WorkspaceError("PATH_ESCAPE", label + " 是符号链接，拒绝访问", false);
  if (code === "EISDIR") throw new WorkspaceError("PATH_ESCAPE", label + " 是目录，拒绝按文件访问", false);
  if (code === "ENOENT") throw new WorkspaceError("NOT_FOUND", label + " 不存在", false);
  throw error;
}

/**
 * Safe read of a workspace file. Caller must hold the workspace lock (tools and
 * runner/exec do); the open itself uses O_NOFOLLOW so a symlinked final component can
 * never be followed.
 */
export function safeReadFile(workspaceDir: string, raw: string, maxBytes = 128 * 1024): { content: string; truncated: boolean } {
  assertWorkspaceUsable(workspaceDir);
  const { resolved, relative } = safeResolveWorkspacePath(workspaceDir, raw);
  let fd: number;
  try {
    fd = openSync(resolved, nofollowFlags(constants.O_RDONLY));
  } catch (error) {
    wrapOpenError(error, relative || "文件");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new WorkspaceError("NOT_FOUND", "不是普通文件：" + relative, false);
    const size = stat.size;
    const buffer = Buffer.alloc(Math.min(size, maxBytes + 1));
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    return { content, truncated: size > maxBytes || content.length > maxBytes };
  } finally {
    closeSync(fd);
  }
}

/**
 * Safe write of a workspace file (create/truncate). Parent dirs are created only after
 * the symlink-free walk; the open uses O_NOFOLLOW, so writing through a symlinked final
 * component is impossible.
 */
export function safeWriteFile(workspaceDir: string, raw: string, content: string): void {
  assertWorkspaceUsable(workspaceDir);
  const { resolved, relative } = safeResolveWorkspacePath(workspaceDir, raw);
  try {
    // Symlink-free walk already verified every existing ancestor; create missing dirs.
    mkdirParents(path.dirname(resolved));
    const fd = openSync(resolved, nofollowFlags(constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC), 0o644);
    try {
      const buffer = Buffer.from(content, "utf8");
      let offset = 0;
      while (offset < buffer.length) {
        offset += writeSync(fd, buffer, offset, buffer.length - offset);
      }
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    wrapOpenError(error, relative || "文件");
  }
}

function mkdirParents(dir: string): void {
  if (dir === "." || existsSync(dir)) return;
  mkdirParents(path.dirname(dir));
  mkdirSync(dir);
}

/** lstatSync metadata for a workspace path (no follow; symlinks rejected by resolve). */
export function safeStat(workspaceDir: string, raw: string): Stats {
  assertWorkspaceUsable(workspaceDir);
  const { resolved } = safeResolveWorkspacePath(workspaceDir, raw);
  if (!existsSync(resolved)) throw new WorkspaceError("NOT_FOUND", "路径不存在", false);
  return lstatSync(resolved);
}

/** Read an already-validated absolute path without following a symlinked final component. */
export function readFileNofollow(absPath: string): Buffer {
  const fd = openSync(absPath, nofollowFlags(constants.O_RDONLY));
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Write an already-validated absolute path without following a symlinked final component. */
export function writeFileNofollow(absPath: string, content: string | Buffer): void {
  const fd = openSync(absPath, nofollowFlags(constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC), 0o644);
  try {
    const buffer = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    let offset = 0;
    while (offset < buffer.length) {
      offset += writeSync(fd, buffer, offset, buffer.length - offset);
    }
  } finally {
    closeSync(fd);
  }
}

export interface SafeWalkEntry {
  /** Absolute host path. */
  abs: string;
  /** Workspace-relative path (posix separators). */
  path: string;
  type: "file" | "dir";
  size: number;
}

/**
 * lstatSync-based recursive walk of a workspace. Never follows symlinks; any symlink
 * or special file marks the workspace SECURITY_BLOCKED and throws (fail closed).
 */
export function safeWalkWorkspace(workspaceDir: string, skipDirs: Set<string> = SKIP_SCAN_DIRS): SafeWalkEntry[] {
  assertWorkspaceUsable(workspaceDir);
  const root = canonicalWorkspaceRoot(workspaceDir);
  const out: SafeWalkEntry[] = [];
  const walk = (current: string, rel: string, depth: number): void => {
    if (depth > 12) return;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
      if (skipDirs.has(name)) continue;
      const full = path.join(current, name);
      const relPath = rel ? rel + "/" + name : name;
      let stat: Stats;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink() || isSpecialStat(stat)) {
        const message = "工作区检测到符号链接/特殊文件：" + relPath;
        markWorkspaceBlocked(workspaceDir, message);
        throw new WorkspaceError("SECURITY_BLOCKED", message, false);
      }
      if (stat.isDirectory()) {
        out.push({ abs: full, path: relPath, type: "dir", size: 0 });
        walk(full, relPath, depth + 1);
      } else if (stat.isFile()) {
        out.push({ abs: full, path: relPath, type: "file", size: stat.size });
      }
    }
  };
  walk(root, "", 0);
  return out;
}

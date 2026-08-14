import "server-only";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { WorkspaceError } from "./errors";

/**
 * Shared workspace path jail: every fs/build/runner tool resolves paths through here.
 * Absolute paths, `..`, symlink escapes, NUL bytes, over-long paths and sensitive files
 * are rejected with PATH_ESCAPE / SENSITIVE_FILE before any read/write happens.
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

/** Resolve a workspace-relative path strictly inside workspaceDir. */
export function resolveWorkspacePath(workspaceDir: string, raw: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 400) {
    throw new WorkspaceError("PATH_ESCAPE", "路径不合法（为空或过长）", false);
  }
  if (raw.includes("\0")) throw new WorkspaceError("PATH_ESCAPE", "路径包含非法字符", false);
  if (path.isAbsolute(raw)) {
    throw new WorkspaceError("PATH_ESCAPE", "拒绝绝对路径（只接受工作区内相对路径，例如 src/app.tsx）", false);
  }
  const root = realpathSync(workspaceDir);
  const candidate = path.resolve(root, raw);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorkspaceError("PATH_ESCAPE", "拒绝工作区外的路径（禁止 ../ 与符号链接逃逸）", false);
  }
  if (SENSITIVE_FILE.test(raw) || SENSITIVE_FILE.test(relative)) {
    throw new WorkspaceError("PATH_ESCAPE", "拒绝访问敏感文件（如 .env / 密钥文件）", false);
  }
  if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) {
    throw new WorkspaceError("PATH_ESCAPE", "拒绝符号链接", false);
  }
  return candidate;
}

/** Resolve a snapshot-relative path strictly inside a snapshot dir (read-only viewer). */
export function resolveSnapshotPath(snapshotDir: string, raw: string): string {
  const resolved = resolveWorkspacePath(snapshotDir, raw);
  if (!existsSync(resolved) || lstatSync(resolved).isDirectory()) {
    throw new WorkspaceError("NOT_FOUND", "文件不存在", false);
  }
  return resolved;
}

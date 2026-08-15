import "server-only";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, copyFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { ServerToolDefinition, ToolExecutionContext } from "./types";
import { invalidateQualityGates, ToolExecutionError } from "./types";
import { assertApproved } from "./approval";
import {
  fsCopyArgsSchema, fsCopyResultSchema, fsCreateDirArgsSchema, fsCreateDirResultSchema,
  fsDeleteArgsSchema, fsDeleteResultSchema, fsListArgsSchema, fsListResultSchema,
  fsMoveArgsSchema, fsMoveResultSchema, fsPatchArgsSchema, fsPatchResultSchema,
  fsReadArgsSchema, fsReadResultSchema,
  fsStatArgsSchema, fsStatResultSchema, fsWriteArgsSchema, fsWriteResultSchema,
} from "./schemas";
import { WorkspaceError } from "@/lib/workspace/errors";
import {
  assertWorkspaceTreeSafe,
  safeReadFile,
  safeResolveWorkspacePath,
  safeStat,
  safeWriteFile,
  withWorkspaceLock,
} from "@/lib/workspace/paths";
import { systemOwnedNoteFor } from "@/lib/workspace/workspace-manager";
import { MANIFEST_FILE_NAME, parseManifestText } from "@/lib/contracts/manifest";

/**
 * Filesystem tools: every path goes through the unified workspace jail
 * (safeResolveWorkspacePath + O_NOFOLLOW opens + per-workspace mutex). Absolute,
 * Windows-style, `..`, symlinked (final OR intermediate) and special-file paths are
 * rejected with PATH_ESCAPE; a workspace that ever contained symlinks stays
 * SECURITY_BLOCKED. System-owned files (package.json / tsconfig / SDK bridge / build
 * configs / dist) can be read but never written or deleted by AI.
 * qubits.manifest.json is editable but every write is validated against the manifest
 * schema.
 */

const MAX_FILE_BYTES = 128 * 1024;

function validateManifestWrite(raw: string, content: string): void {
  const normalized = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized !== MANIFEST_FILE_NAME) return;
  const parsed = parseManifestText(content);
  if (!parsed.ok) {
    throw new ToolExecutionError("INVALID_MANIFEST", "qubits.manifest.json 校验失败：" + parsed.issues.slice(0, 3).join("；"), false);
  }
}

function jail(context: ToolExecutionContext, raw: string): { resolved: string; relative: string } {
  if (!context.workspaceReady) {
    throw new WorkspaceError("WORKSPACE_NOT_INITIALIZED", "工作区尚未初始化，请先调用 workspace_init", false);
  }
  try {
    return safeResolveWorkspacePath(context.workspaceDir, raw);
  } catch (error) {
    if (error instanceof WorkspaceError) {
      throw new ToolExecutionError(error.code, error.message, false);
    }
    throw error;
  }
}

function assertWritable(raw: string): void {
  const note = systemOwnedNoteFor(raw);
  if (note) {
    throw new ToolExecutionError("SYSTEM_OWNED_FILE", "拒绝修改系统维护文件（" + note + "）", false);
  }
}

function diffSummary(oldText: string, newText: string): string {
  if (oldText === newText) return "无变化";
  const oldLines = oldText.split("\n").length;
  const newLines = newText.split("\n").length;
  return "行数 " + oldLines + " → " + newLines + "（+" + Math.max(0, newLines - oldLines) + "/-" + Math.max(0, oldLines - newLines) + "）";
}

/** Create missing parent dirs bottom-up with lstat verification (mutex-held). */
function mkdirParentsVerified(workspaceDir: string, target: string): void {
  const root = safeResolveWorkspacePath(workspaceDir, ".").resolved;
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ToolExecutionError("PATH_ESCAPE", "目标在 workspace 外", false);
  }
  const segments = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new ToolExecutionError("PATH_ESCAPE", "父目录包含符号链接", false);
      if (!stat.isDirectory()) throw new ToolExecutionError("PATH_ESCAPE", "父路径组件不是目录", false);
    } else {
      mkdirSync(current);
    }
  }
}

export const fsListTool: ServerToolDefinition<{ path: string; maxDepth: number; maxEntries: number }, { entries: Array<{ path: string; type: "file" | "dir"; size: number }> }> = {
  name: "fs_list",
  description: "列出 workspace 内目录（限制深度与条目数）。path 必须是工作区内相对路径（禁止绝对路径、.. 与符号链接）。",
  argsSchema: fsListArgsSchema,
  resultSchema: fsListResultSchema,
  allowedRoles: ["engineer"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    return withWorkspaceLock(context.workspaceDir, async () => {
      const { resolved } = jail(context, args.path || ".");
      if (!existsSync(resolved)) return { entries: [] };
      // Fail closed: any symlink/special file anywhere in the workspace blocks listing.
      assertWorkspaceTreeSafe(context.workspaceDir);
      const entries: Array<{ path: string; type: "file" | "dir"; size: number }> = [];
      const walk = (current: string, depth: number) => {
        if (entries.length >= args.maxEntries || depth > args.maxDepth) return;
        for (const name of readdirSync(current).slice(0, args.maxEntries - entries.length)) {
          if (name === "node_modules" || name === ".qubits-trash") continue;
          const full = path.join(current, name);
          const rel = path.relative(context.workspaceDir, full);
          try {
            const stat = lstatSync(full);
            entries.push({ path: rel.split(path.sep).join("/"), type: stat.isDirectory() ? "dir" : "file", size: stat.size });
            if (stat.isDirectory()) walk(full, depth + 1);
          } catch {
            // ignore unreadable entries
          }
        }
      };
      walk(resolved, 1);
      return { entries };
    });
  },
};

export const fsReadTool: ServerToolDefinition<{ path: string; maxBytes: number }, { path: string; content: string; truncated: boolean }> = {
  name: "fs_read",
  description: "读取 workspace 内文件（限制大小；路径必须安全且不含符号链接）。",
  argsSchema: fsReadArgsSchema,
  resultSchema: fsReadResultSchema,
  allowedRoles: ["engineer"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    return withWorkspaceLock(context.workspaceDir, async () => {
      const { relative } = jail(context, args.path);
      try {
        const { content, truncated } = safeReadFile(context.workspaceDir, args.path, MAX_FILE_BYTES);
        return { path: relative, content: truncated ? content.slice(0, args.maxBytes) : content, truncated };
      } catch (error) {
        if (error instanceof WorkspaceError && error.code === "NOT_FOUND") {
          throw new ToolExecutionError("NOT_FOUND", "文件不存在", false);
        }
        throw error;
      }
    });
  },
};

export const fsWriteTool: ServerToolDefinition<{ path: string; content: string }, { path: string; bytesWritten: number; diffSummary: string }> = {
  name: "fs_write",
  description: "在 workspace 内创建/覆写文件（系统维护文件与构建配置不可写；路径必须安全）。",
  argsSchema: fsWriteArgsSchema,
  resultSchema: fsWriteResultSchema,
  allowedRoles: ["engineer"],
  risk: "medium",
  requiresApproval: false,
  async execute(args, context) {
    assertWritable(args.path);
    validateManifestWrite(args.path, args.content);
    if (Buffer.byteLength(args.content) > MAX_FILE_BYTES) throw new ToolExecutionError("FILE_TOO_LARGE", "内容超过大小上限", false);
    return withWorkspaceLock(context.workspaceDir, async () => {
      const { resolved, relative } = jail(context, args.path);
      const before = existsSync(resolved) ? safeReadFile(context.workspaceDir, relative, MAX_FILE_BYTES).content : "";
      mkdirParentsVerified(context.workspaceDir, path.dirname(resolved));
      try {
        safeWriteFile(context.workspaceDir, relative, args.content);
      } catch (error) {
        if (error instanceof WorkspaceError) throw new ToolExecutionError(error.code, error.message, false);
        throw error;
      }
      invalidateQualityGates(context);
      return { path: relative, bytesWritten: Buffer.byteLength(args.content), diffSummary: diffSummary(before, args.content) };
    });
  },
};

export const fsPatchTool: ServerToolDefinition<{ path: string; oldText: string; newText: string; replaceAll: boolean }, { path: string; replaced: number; diffSummary: string }> = {
  name: "fs_patch",
  description: "对 workspace 内文件做局部替换；未命中时不修改原文件（系统维护文件不可改）。",
  argsSchema: fsPatchArgsSchema,
  resultSchema: fsPatchResultSchema,
  allowedRoles: ["engineer"],
  risk: "medium",
  requiresApproval: false,
  async execute(args, context) {
    assertWritable(args.path);
    return withWorkspaceLock(context.workspaceDir, async () => {
      const { relative } = jail(context, args.path);
      let before: { content: string };
      try {
        before = safeReadFile(context.workspaceDir, args.path, MAX_FILE_BYTES);
      } catch (error) {
        if (error instanceof WorkspaceError && error.code === "NOT_FOUND") {
          throw new ToolExecutionError("NOT_FOUND", "文件不存在", false);
        }
        throw error;
      }
      if (!before.content.includes(args.oldText)) {
        throw new ToolExecutionError("PATCH_NO_MATCH", "未找到要替换的文本，原文件未修改", false);
      }
      const after = args.replaceAll ? before.content.split(args.oldText).join(args.newText) : before.content.replace(args.oldText, args.newText);
      validateManifestWrite(args.path, after);
      safeWriteFile(context.workspaceDir, relative, after);
      invalidateQualityGates(context);
      const replaced = args.replaceAll ? before.content.split(args.oldText).length - 1 : 1;
      return { path: relative, replaced, diffSummary: diffSummary(before.content, after) };
    });
  },
};

export const fsStatTool: ServerToolDefinition<{ path: string }, { path: string; type: "file" | "dir"; size: number; modifiedAt: number }> = {
  name: "fs_stat",
  description: "返回文件/目录元信息（lstat，不跟随符号链接）。",
  argsSchema: fsStatArgsSchema,
  resultSchema: fsStatResultSchema,
  allowedRoles: ["engineer"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    return withWorkspaceLock(context.workspaceDir, async () => {
      const { relative } = jail(context, args.path);
      let stat;
      try {
        stat = safeStat(context.workspaceDir, relative);
      } catch (error) {
        if (error instanceof WorkspaceError && error.code === "NOT_FOUND") {
          throw new ToolExecutionError("NOT_FOUND", "路径不存在", false);
        }
        throw error;
      }
      return { path: relative, type: stat.isDirectory() ? "dir" : "file", size: stat.size, modifiedAt: Math.floor(stat.mtimeMs) };
    });
  },
};

export const fsDeleteTool: ServerToolDefinition<{ path: string; soft: boolean }, { path: string; soft: boolean }> = {
  name: "fs_delete",
  description: "删除 workspace 内文件/目录（默认软删除，需要审批；系统维护文件不可删；不跟随符号链接）。",
  argsSchema: fsDeleteArgsSchema,
  resultSchema: fsDeleteResultSchema,
  allowedRoles: ["engineer"],
  risk: "high",
  requiresApproval: true,
  async execute(args, context) {
    assertApproved(context, "fs_delete");
    assertWritable(args.path);
    return withWorkspaceLock(context.workspaceDir, async () => {
      const { resolved, relative } = jail(context, args.path);
      if (!existsSync(resolved)) throw new ToolExecutionError("NOT_FOUND", "路径不存在", false);
      if (args.soft) {
        const trash = path.join(context.workspaceDir, ".qubits-trash", Date.now() + "-" + path.basename(resolved));
        mkdirSync(path.dirname(trash), { recursive: true });
        renameSync(resolved, trash); // rename moves the entry itself, never follows links
      } else {
        rmSync(resolved, { recursive: true, force: true }); // rm deletes entries, never follows links
      }
      invalidateQualityGates(context);
      return { path: relative, soft: args.soft };
    });
  },
};

export const fsCreateDirTool: ServerToolDefinition<{ path: string }, { path: string }> = {
  name: "fs_create_dir",
  description: "在 workspace 内创建目录（系统维护路径不可创建；逐级校验，不跟随符号链接）。",
  argsSchema: fsCreateDirArgsSchema,
  resultSchema: fsCreateDirResultSchema,
  allowedRoles: ["engineer"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    assertWritable(args.path);
    return withWorkspaceLock(context.workspaceDir, async () => {
      const { resolved, relative } = jail(context, args.path);
      mkdirParentsVerified(context.workspaceDir, resolved);
      invalidateQualityGates(context);
      return { path: relative };
    });
  },
};

export const fsCopyTool: ServerToolDefinition<{ from: string; to: string }, { from: string; to: string }> = {
  name: "fs_copy",
  description: "复制文件（源/目标都必须位于 workspace 内且无符号链接；系统维护路径不可写）。",
  argsSchema: fsCopyArgsSchema,
  resultSchema: fsCopyResultSchema,
  allowedRoles: ["engineer"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    assertWritable(args.to);
    return withWorkspaceLock(context.workspaceDir, async () => {
      const from = jail(context, args.from);
      const to = jail(context, args.to);
      if (!existsSync(from.resolved)) throw new ToolExecutionError("NOT_FOUND", "源路径不存在", false);
      if (lstatSync(from.resolved).isDirectory()) throw new ToolExecutionError("PATH_ESCAPE", "源路径是目录，请使用文件路径", false);
      mkdirParentsVerified(context.workspaceDir, path.dirname(to.resolved));
      copyFileSync(from.resolved, to.resolved);
      invalidateQualityGates(context);
      return { from: from.relative, to: to.relative };
    });
  },
};

export const fsMoveTool: ServerToolDefinition<{ from: string; to: string }, { from: string; to: string }> = {
  name: "fs_move",
  description: "workspace 内移动文件/目录（不跟随符号链接；系统维护路径不可移动）。",
  argsSchema: fsMoveArgsSchema,
  resultSchema: fsMoveResultSchema,
  allowedRoles: ["engineer"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    assertWritable(args.from);
    assertWritable(args.to);
    return withWorkspaceLock(context.workspaceDir, async () => {
      const from = jail(context, args.from);
      const to = jail(context, args.to);
      if (!existsSync(from.resolved)) throw new ToolExecutionError("NOT_FOUND", "源路径不存在", false);
      mkdirParentsVerified(context.workspaceDir, path.dirname(to.resolved));
      renameSync(from.resolved, to.resolved);
      invalidateQualityGates(context);
      return { from: from.relative, to: to.relative };
    });
  },
};

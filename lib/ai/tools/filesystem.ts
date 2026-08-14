import "server-only";
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { ServerToolDefinition, ToolExecutionContext } from "./types";
import { ToolExecutionError } from "./types";
import { assertApproved } from "./approval";
import {
  fsCopyArgsSchema, fsCopyResultSchema, fsCreateDirArgsSchema, fsCreateDirResultSchema,
  fsDeleteArgsSchema, fsDeleteResultSchema, fsListArgsSchema, fsListResultSchema,
  fsMoveArgsSchema, fsMoveResultSchema, fsPatchArgsSchema, fsPatchResultSchema,
  fsReadArgsSchema, fsReadResultSchema,
  fsStatArgsSchema, fsStatResultSchema, fsWriteArgsSchema, fsWriteResultSchema,
} from "./schemas";
import { WorkspaceError } from "@/lib/workspace/errors";
import { resolveWorkspacePath } from "@/lib/workspace/paths";
import { systemOwnedNoteFor } from "@/lib/workspace/workspace-manager";
import { MANIFEST_FILE_NAME, parseManifestText } from "@/lib/contracts/manifest";

/**
 * Filesystem tools: every path is confined to data/workspaces/<taskId> through the
 * shared realpath jail (rejects ../, absolute paths, symlink escapes and sensitive
 * files). System-owned files (package.json / tsconfig / SDK bridge / build configs /
 * dist) can be read but never written or deleted by AI. qubits.manifest.json is
 * editable but every write is validated against the manifest schema (the build entry
 * is pinned and dependency versions are re-checked at build time).
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

function jail(context: ToolExecutionContext, raw: string): string {
  if (!context.workspaceReady) {
    throw new WorkspaceError("WORKSPACE_NOT_INITIALIZED", "工作区尚未初始化，请先调用 workspace_init", false);
  }
  try {
    return resolveWorkspacePath(context.workspaceDir, raw);
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

export const fsListTool: ServerToolDefinition<{ path: string; maxDepth: number; maxEntries: number }, { entries: Array<{ path: string; type: "file" | "dir"; size: number }> }> = {
  name: "fs_list",
  description: "列出 workspace 内目录（限制深度与条目数）。path 必须是工作区内相对路径（禁止绝对路径与 ../）。",
  argsSchema: fsListArgsSchema,
  resultSchema: fsListResultSchema,
  allowedRoles: ["engineer", "reviewer", "team_leader", "architect"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const dir = jail(context, args.path || ".");
    if (!existsSync(dir)) return { entries: [] };
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
    walk(dir, 1);
    return { entries };
  },
};

export const fsReadTool: ServerToolDefinition<{ path: string; maxBytes: number }, { path: string; content: string; truncated: boolean }> = {
  name: "fs_read",
  description: "读取 workspace 内文件（限制大小与编码）。path 必须是工作区内相对路径（禁止绝对路径与 ../）。",
  argsSchema: fsReadArgsSchema,
  resultSchema: fsReadResultSchema,
  allowedRoles: ["product_manager", "architect", "engineer", "reviewer", "team_leader", "data_scientist", "security_reviewer"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const full = jail(context, args.path);
    if (!existsSync(full) || !lstatSync(full).isFile()) throw new ToolExecutionError("NOT_FOUND", "文件不存在", false);
    const stat = statSync(full);
    if (stat.size > MAX_FILE_BYTES) throw new ToolExecutionError("FILE_TOO_LARGE", "文件超过大小上限", false);
    const content = readFileSync(full, "utf8");
    const truncated = Buffer.byteLength(content) > args.maxBytes;
    return { path: args.path, content: truncated ? content.slice(0, args.maxBytes) : content, truncated };
  },
};

export const fsWriteTool: ServerToolDefinition<{ path: string; content: string }, { path: string; bytesWritten: number; diffSummary: string }> = {
  name: "fs_write",
  description: "在 workspace 内创建/覆写文件（写入前记录差异；系统维护文件与构建配置不可写）。path 必须是工作区内相对路径。",
  argsSchema: fsWriteArgsSchema,
  resultSchema: fsWriteResultSchema,
  allowedRoles: ["engineer"],
  risk: "medium",
  requiresApproval: false,
  async execute(args, context) {
    assertWritable(args.path);
    validateManifestWrite(args.path, args.content);
    const full = jail(context, args.path);
    if (Buffer.byteLength(args.content) > MAX_FILE_BYTES) throw new ToolExecutionError("FILE_TOO_LARGE", "内容超过大小上限", false);
    const before = existsSync(full) ? readFileSync(full, "utf8") : "";
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, args.content, "utf8");
    return { path: args.path, bytesWritten: Buffer.byteLength(args.content), diffSummary: diffSummary(before, args.content) };
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
    const full = jail(context, args.path);
    if (!existsSync(full)) throw new ToolExecutionError("NOT_FOUND", "文件不存在", false);
    const before = readFileSync(full, "utf8");
    if (!before.includes(args.oldText)) throw new ToolExecutionError("PATCH_NO_MATCH", "未找到要替换的文本，原文件未修改", false);
    const after = args.replaceAll ? before.split(args.oldText).join(args.newText) : before.replace(args.oldText, args.newText);
    validateManifestWrite(args.path, after);
    writeFileSync(full, after, "utf8");
    const replaced = args.replaceAll ? before.split(args.oldText).length - 1 : 1;
    return { path: args.path, replaced, diffSummary: diffSummary(before, after) };
  },
};

export const fsStatTool: ServerToolDefinition<{ path: string }, { path: string; type: "file" | "dir"; size: number; modifiedAt: number }> = {
  name: "fs_stat",
  description: "返回文件/目录元信息。path 必须是工作区内相对路径（禁止绝对路径与 ../）。",
  argsSchema: fsStatArgsSchema,
  resultSchema: fsStatResultSchema,
  allowedRoles: ["engineer", "architect", "reviewer", "team_leader"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const full = jail(context, args.path);
    if (!existsSync(full)) throw new ToolExecutionError("NOT_FOUND", "路径不存在", false);
    const stat = lstatSync(full);
    return { path: args.path, type: stat.isDirectory() ? "dir" : "file", size: stat.size, modifiedAt: Math.floor(stat.mtimeMs) };
  },
};

export const fsDeleteTool: ServerToolDefinition<{ path: string; soft: boolean }, { path: string; soft: boolean }> = {
  name: "fs_delete",
  description: "删除 workspace 内文件/目录（默认软删除，需要审批；系统维护文件不可删）。",
  argsSchema: fsDeleteArgsSchema,
  resultSchema: fsDeleteResultSchema,
  allowedRoles: ["engineer"],
  risk: "high",
  requiresApproval: true,
  async execute(args, context) {
    assertApproved(context, "fs_delete");
    assertWritable(args.path);
    const full = jail(context, args.path);
    if (!existsSync(full)) throw new ToolExecutionError("NOT_FOUND", "路径不存在", false);
    if (args.soft) {
      const trash = path.join(context.workspaceDir, ".qubits-trash", Date.now() + "-" + path.basename(full));
      mkdirSync(path.dirname(trash), { recursive: true });
      renameSync(full, trash);
    } else {
      rmSync(full, { recursive: true, force: true });
    }
    return { path: args.path, soft: args.soft };
  },
};

export const fsCreateDirTool: ServerToolDefinition<{ path: string }, { path: string }> = {
  name: "fs_create_dir",
  description: "在 workspace 内创建目录（系统维护路径不可创建）。path 必须是工作区内相对路径。",
  argsSchema: fsCreateDirArgsSchema,
  resultSchema: fsCreateDirResultSchema,
  allowedRoles: ["engineer"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    assertWritable(args.path);
    const full = jail(context, args.path);
    mkdirSync(full, { recursive: true });
    return { path: args.path };
  },
};

export const fsCopyTool: ServerToolDefinition<{ from: string; to: string }, { from: string; to: string }> = {
  name: "fs_copy",
  description: "复制文件（禁止复制到 workspace 外，系统维护路径不可写）。from/to 必须是工作区内相对路径。",
  argsSchema: fsCopyArgsSchema,
  resultSchema: fsCopyResultSchema,
  allowedRoles: ["engineer"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    assertWritable(args.to);
    const from = jail(context, args.from);
    const to = jail(context, args.to);
    if (!existsSync(from)) throw new ToolExecutionError("NOT_FOUND", "源路径不存在", false);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    return { from: args.from, to: args.to };
  },
};

export const fsMoveTool: ServerToolDefinition<{ from: string; to: string }, { from: string; to: string }> = {
  name: "fs_move",
  description: "workspace 内移动文件/目录（系统维护路径不可移动）。from/to 必须是工作区内相对路径。",
  argsSchema: fsMoveArgsSchema,
  resultSchema: fsMoveResultSchema,
  allowedRoles: ["engineer"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    assertWritable(args.from);
    assertWritable(args.to);
    const from = jail(context, args.from);
    const to = jail(context, args.to);
    if (!existsSync(from)) throw new ToolExecutionError("NOT_FOUND", "源路径不存在", false);
    mkdirSync(path.dirname(to), { recursive: true });
    renameSync(from, to);
    return { from: args.from, to: args.to };
  },
};

import "server-only";
import { existsSync } from "node:fs";
import { z } from "zod";
import { transform as esbuildTransform } from "esbuild";
import { getManifestIssues, MANIFEST_FILE_NAME } from "@/lib/contracts/manifest";
import type { ServerToolDefinition, ToolExecutionContext } from "./types";
import {
  createCodeSnapshotArgsSchema,
  createCodeSnapshotResultSchema,
  dependencyAddArgsSchema,
  dependencyAddResultSchema,
  dependencyListArgsSchema,
  dependencyListResultSchema,
  dependencyRemoveArgsSchema,
  dependencyRemoveResultSchema,
  restoreCodeSnapshotArgsSchema,
  restoreCodeSnapshotResultSchema,
  runFormatArgsSchema,
  runFormatResultSchema,
  securityScanArgsSchema,
  securityScanResultSchema,
  workspaceGetManifestArgsSchema,
  workspaceGetManifestResultSchema,
  workspaceInitArgsSchema,
  workspaceInitResultSchema,
  workspaceListFilesArgsSchema,
  workspaceListFilesResultSchema,
} from "./schemas";
import {
  getWorkspaceInfo,
  initWorkspace,
  listWorkspaceFiles,
  readWorkspaceManifest,
  writeWorkspaceManifest,
  requireWorkspace,
  workspaceFileManifest,
} from "@/lib/workspace/workspace-manager";
import { DEPENDENCY_ALLOWLIST, assertDependencyAvailable, getDependencyVersion } from "@/lib/workspace/dependency-policy";
import { scanWorkspace } from "@/lib/workspace/security-scan";
import { createCodeSnapshot as createSnapshot, restoreCodeSnapshot as restoreSnapshot } from "@/lib/workspace/snapshot";
import { WorkspaceError, redactHostText } from "@/lib/workspace/errors";
import { assertWorkspaceTreeSafe, safeReadFile, safeResolveWorkspacePath, safeWriteFile, withWorkspaceLock } from "@/lib/workspace/paths";

/**
 * Workspace tools: the only way AI creates/modifies real application code.
 * Every tool operates strictly inside data/workspaces/<taskId>; manifests and
 * dependencies are validated against server allowlists.
 */

function requireInitializedWorkspace(context: ToolExecutionContext): string {
  if (!context.workspaceReady) {
    throw new WorkspaceError("WORKSPACE_NOT_INITIALIZED", "工作区尚未初始化，请先调用 workspace_init", false);
  }
  requireWorkspace(context.workspaceDir);
  return context.workspaceDir;
}

export const workspaceInitTool: ServerToolDefinition<z.infer<typeof workspaceInitArgsSchema>, z.infer<typeof workspaceInitResultSchema>> = {
  name: "workspace_init",
  description: "幂等地初始化当前任务的代码工作区：只写入系统骨架文件（package.json/tsconfig.json/SDK bridge，均为系统维护，AI 不可写），不含示例应用模板——qubits.manifest.json、src/main.tsx 与其余代码需自行创建。任务重试时保留已有文件，绝不删除。",
  argsSchema: workspaceInitArgsSchema,
  resultSchema: workspaceInitResultSchema,
  allowedRoles: ["engineer"],
  risk: "low",
  requiresApproval: false,
  async execute(_args, context) {
    const existing = getWorkspaceInfo(context.workspaceDir);
    const info = initWorkspace(context.workspaceDir, { taskId: context.runId });
    context.workspaceReady = true;
    return {
      initialized: existing === null,
      seededFrom: info.seededFrom,
      fileCount: listWorkspaceFiles(context.workspaceDir).length,
    };
  },
};

export const workspaceGetManifestTool: ServerToolDefinition<z.infer<typeof workspaceGetManifestArgsSchema>, z.infer<typeof workspaceGetManifestResultSchema>> = {
  name: "workspace_get_manifest",
  description: "读取并校验当前工作区的 qubits.manifest.json。新工作区尚未创建 manifest 属正常：返回 { exists: false }，而不是错误（构建/评审阶段才强制要求 manifest 存在且有效）。",
  argsSchema: workspaceGetManifestArgsSchema,
  resultSchema: workspaceGetManifestResultSchema,
  allowedRoles: ["engineer", "reviewer", "security_reviewer"],
  risk: "low",
  requiresApproval: false,
  async execute(_args, context) {
    const workspaceDir = requireInitializedWorkspace(context);
    const manifestPath = safeResolveWorkspacePath(workspaceDir, MANIFEST_FILE_NAME).resolved;
    if (!existsSync(manifestPath)) {
      // Normal initial state for a fresh skeleton workspace — NOT an error.
      return { exists: false };
    }
    const manifest = readWorkspaceManifest(workspaceDir);
    const issues = getManifestIssues(manifest);
    if (issues.length > 0) {
      throw new WorkspaceError("INVALID_MANIFEST", "manifest 语义校验失败：" + issues.slice(0, 3).join("；"), false);
    }
    return {
      exists: true,
      name: manifest.name,
      description: manifest.description,
      main: manifest.main,
      collections: manifest.collections.map((collection) => ({
        name: collection.name,
        label: collection.label,
        allowedOperations: collection.allowedOperations,
        fieldCount: collection.fields.length,
      })),
      dependencies: manifest.dependencies,
    };
  },
};

export const workspaceListFilesTool: ServerToolDefinition<z.infer<typeof workspaceListFilesArgsSchema>, z.infer<typeof workspaceListFilesResultSchema>> = {
  name: "workspace_list_files",
  description: "列出工作区文件树（标记系统维护文件；只返回工作区相对路径）。",
  argsSchema: workspaceListFilesArgsSchema,
  resultSchema: workspaceListFilesResultSchema,
  allowedRoles: ["engineer", "reviewer"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const workspaceDir = requireInitializedWorkspace(context);
    const entries = listWorkspaceFiles(workspaceDir, args.maxEntries);
    return { entries, truncated: entries.length >= args.maxEntries };
  },
};

function requireEditableManifest(context: ToolExecutionContext) {
  const workspaceDir = requireInitializedWorkspace(context);
  return readWorkspaceManifest(workspaceDir);
}

export const dependencyListTool: ServerToolDefinition<z.infer<typeof dependencyListArgsSchema>, z.infer<typeof dependencyListResultSchema>> = {
  name: "dependency_list",
  description: "列出工作区已声明依赖与服务器依赖 allowlist（固定版本）。",
  argsSchema: dependencyListArgsSchema,
  resultSchema: dependencyListResultSchema,
  allowedRoles: ["engineer", "reviewer"],
  risk: "low",
  requiresApproval: false,
  async execute(_args, context) {
    const manifest = requireEditableManifest(context);
    return {
      dependencies: manifest.dependencies,
      allowlist: Object.values(DEPENDENCY_ALLOWLIST),
    };
  },
};

export const dependencyAddTool: ServerToolDefinition<z.infer<typeof dependencyAddArgsSchema>, z.infer<typeof dependencyAddResultSchema>> = {
  name: "dependency_add",
  description: "从服务端 allowlist 添加固定版本依赖（禁止任意包名、URL、Git 依赖与安装脚本；react/react-dom 始终可用）。",
  argsSchema: dependencyAddArgsSchema,
  resultSchema: dependencyAddResultSchema,
  allowedRoles: ["engineer"],
  risk: "medium",
  requiresApproval: false,
  async execute(args, context) {
    const workspaceDir = requireInitializedWorkspace(context);
    const manifest = readWorkspaceManifest(workspaceDir);
    if (manifest.dependencies.some((dep) => dep.name === args.name)) {
      throw new WorkspaceError("INVALID_DEPENDENCY", "依赖已声明：" + args.name, false);
    }
    assertDependencyAvailable(args.name);
    const pinned = getDependencyVersion(args.name);
    if (!pinned) {
      throw new WorkspaceError("INVALID_DEPENDENCY", "依赖不在服务端 allowlist 中：" + args.name, false);
    }
    if (args.version && args.version !== pinned) {
      throw new WorkspaceError("INVALID_DEPENDENCY", "版本必须使用服务端固定版本：" + args.name + "@" + pinned, false);
    }
    const next = {
      ...manifest,
      dependencies: [...manifest.dependencies, { name: args.name, version: pinned }],
    };
    writeWorkspaceManifest(workspaceDir, next);
    return { added: true, name: args.name, version: pinned, dependencies: next.dependencies };
  },
};

export const dependencyRemoveTool: ServerToolDefinition<z.infer<typeof dependencyRemoveArgsSchema>, z.infer<typeof dependencyRemoveResultSchema>> = {
  name: "dependency_remove",
  description: "从工作区 manifest 移除已声明依赖（移除后必须通过 build 验证）。",
  argsSchema: dependencyRemoveArgsSchema,
  resultSchema: dependencyRemoveResultSchema,
  allowedRoles: ["engineer"],
  risk: "medium",
  requiresApproval: false,
  async execute(args, context) {
    const workspaceDir = requireInitializedWorkspace(context);
    const manifest = readWorkspaceManifest(workspaceDir);
    const dependencies = manifest.dependencies.filter((dep) => dep.name !== args.name);
    if (dependencies.length === manifest.dependencies.length) {
      return { removed: false, dependencies };
    }
    writeWorkspaceManifest(workspaceDir, { ...manifest, dependencies });
    return { removed: true, dependencies };
  },
};

export const securityScanTool: ServerToolDefinition<z.infer<typeof securityScanArgsSchema>, z.infer<typeof securityScanResultSchema>> = {
  name: "security_scan",
  description: "对工作区代码执行确定性静态安全扫描（eval/new Function/child_process/网络/存储/密钥/任意文件访问等）。",
  argsSchema: securityScanArgsSchema,
  resultSchema: securityScanResultSchema,
  allowedRoles: ["engineer", "reviewer", "security_reviewer"],
  risk: "low",
  requiresApproval: false,
  async execute(_args, context) {
    const workspaceDir = requireInitializedWorkspace(context);
    const report = scanWorkspace(workspaceDir);
    return { status: report.status, findings: report.findings, filesScanned: report.filesScanned };
  },
};

export const createCodeSnapshotTool: ServerToolDefinition<z.infer<typeof createCodeSnapshotArgsSchema>, z.infer<typeof createCodeSnapshotResultSchema>> = {
  name: "create_code_snapshot",
  description: "为当前工作区创建不可变代码快照（文件清单 + 内容哈希），并存入产物。",
  argsSchema: createCodeSnapshotArgsSchema,
  resultSchema: createCodeSnapshotResultSchema,
  allowedRoles: ["engineer"],
  risk: "medium",
  requiresApproval: false,
  async execute(_args, context) {
    const workspaceDir = requireInitializedWorkspace(context);
    const snapshot = await createSnapshot(context.currentAppId || "project", workspaceDir);
    const artifactId = context.artifacts.put({
      kind: "code_workspace",
      createdBy: context.roleId,
      parentAgentRunId: context.parentAgentRunId,
      value: { snapshotId: snapshot.snapshotId, files: snapshot.files, createdAt: snapshot.createdAt },
    }).id;
    return { snapshotId: snapshot.snapshotId, artifactId, files: snapshot.files };
  },
};

export const restoreCodeSnapshotTool: ServerToolDefinition<z.infer<typeof restoreCodeSnapshotArgsSchema>, z.infer<typeof restoreCodeSnapshotResultSchema>> = {
  name: "restore_code_snapshot",
  description: "把不可变代码快照恢复到当前工作区（只覆盖工作区文件，不动系统配置）。",
  argsSchema: restoreCodeSnapshotArgsSchema,
  resultSchema: restoreCodeSnapshotResultSchema,
  allowedRoles: ["engineer"],
  risk: "medium",
  requiresApproval: false,
  async execute(args, context) {
    const workspaceDir = requireInitializedWorkspace(context);
    const restored = await restoreSnapshot(args.snapshotId, context.currentAppId || "project", workspaceDir);
    return { restored, snapshotId: args.snapshotId };
  },
};

/** run_format: real formatting via the esbuild printer (deterministic, offline). */
export const runFormatTool: ServerToolDefinition<z.infer<typeof runFormatArgsSchema>, z.infer<typeof runFormatResultSchema>> = {
  name: "run_format",
  description: "用系统格式化器（esbuild printer）格式化工作区 TS/TSX 源码，返回实际改写结果。",
  argsSchema: runFormatArgsSchema,
  resultSchema: runFormatResultSchema,
  allowedRoles: ["engineer"],
  risk: "low",
  requiresApproval: false,
  async execute(_args, context) {
    const workspaceDir = requireInitializedWorkspace(context);
    return withWorkspaceLock(workspaceDir, async () => {
      assertWorkspaceTreeSafe(workspaceDir);
      const files = workspaceFileManifest(workspaceDir).filter((file) => /\.(ts|tsx)$/.test(file.path) && !file.path.endsWith(".test.ts") && file.path !== "src/lib/qubits.ts");
      let formatted = 0;
      let changed = 0;
      for (const file of files) {
        const { content: before } = safeReadFile(workspaceDir, file.path, 256 * 1024);
        try {
          const result = await esbuildTransform(before, { loader: file.path.endsWith(".tsx") ? "tsx" : "ts", format: "esm", target: "es2020", jsx: "automatic", logLevel: "silent" });
          formatted += 1;
          if (result.code !== before) {
            safeWriteFile(workspaceDir, file.path, result.code);
            changed += 1;
          }
        } catch (error) {
          throw new WorkspaceError("FORMAT_FAILED", "格式化失败：" + redactHostText(error instanceof Error ? error.message : "未知错误", workspaceDir).slice(0, 300), false);
        }
      }
      return { formatted, changed, summary: "已检查 " + formatted + " 个文件，改写 " + changed + " 个。" };
    });
  },
};


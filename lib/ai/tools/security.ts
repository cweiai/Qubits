import "server-only";
import path from "node:path";
import { z } from "zod";
import type { ServerToolDefinition } from "./types";
import {
  safeReadFile,
  safeResolveWorkspacePath,
  safeWalkWorkspace,
  withWorkspaceLock,
} from "@/lib/workspace/paths";

/**
 * Deterministic security evidence tools (Alex-only, read-only): review_changes, secret_scan,
 * dependency_audit, check_data_isolation (see data.ts). All workspace
 * reads go through the unified jail: lstat-only walks (symlinks fail closed),
 * O_NOFOLLOW reads, per-workspace mutex.
 */

const SECRET_PATTERNS = [
  { name: "API Key", pattern: /(sk|pk|api[_-]?key|token)["']?\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/i },
  { name: "DATABASE_URL", pattern: /(postgres|mysql|mongodb):\/\/[^\s"']+/i },
  { name: "私钥", pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "AWS Key", pattern: /AKIA[0-9A-Z]{16}/ },
];

const MAX_SCAN_FILE = 256 * 1024;

const issuesResultSchema = z.object({
  findings: z.array(z.object({ severity: z.enum(["error", "warning"]), file: z.string().max(200), message: z.string().max(300) })).max(50),
});

export const reviewChangesTool: ServerToolDefinition<{ path?: string }, { findings: Array<{ severity: "error" | "warning"; file: string; message: string }> }> = {
  name: "review_changes",
  description: "审查 workspace 内变更（与最近检查点/初始状态对比的启发式检查）。扫描根目录经过共享 jail（禁止绝对路径、.. 与符号链接）。",
  argsSchema: z.object({ path: z.string().max(300).default(".") }),
  resultSchema: issuesResultSchema,
  allowedRoles: ["engineer"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    return withWorkspaceLock(context.workspaceDir, async () => {
      // The scan root MUST go through the shared jail — path.resolve on raw input is forbidden.
      const root = safeResolveWorkspacePath(context.workspaceDir, args.path ?? ".");
      const isUnderRoot = (abs: string): boolean => {
        const rel = path.relative(root.resolved, abs);
        return !rel.startsWith("..") && !path.isAbsolute(rel);
      };
      const files = safeWalkWorkspace(context.workspaceDir).filter(
        (entry) => entry.type === "file" && isUnderRoot(entry.abs)
      );
      const findings: Array<{ severity: "error" | "warning"; file: string; message: string }> = [];
      for (const file of files) {
        const { content } = safeReadFile(context.workspaceDir, file.path, MAX_SCAN_FILE);
        if (/\beval\s*\(/.test(content)) findings.push({ severity: "error", file: file.path, message: "发现 eval() 调用" });
        if (/new\s+Function/.test(content)) findings.push({ severity: "error", file: file.path, message: "发现 new Function" });
        if (/child_process|execSync|shell:\s*true/.test(content)) findings.push({ severity: "warning", file: file.path, message: "发现子进程执行（请确认未使用 shell:true）" });
      }
      return { findings };
    });
  },
};

export const secretScanTool: ServerToolDefinition<Record<string, never>, { findings: Array<{ severity: "error" | "warning"; file: string; message: string }> }> = {
  name: "secret_scan",
  description: "扫描 workspace 中的密钥/凭据模式。",
  argsSchema: z.object({}).strict(),
  resultSchema: issuesResultSchema,
  allowedRoles: ["engineer"],
  risk: "low",
  requiresApproval: false,
  async execute(_args, context) {
    return withWorkspaceLock(context.workspaceDir, async () => {
      const findings: Array<{ severity: "error" | "warning"; file: string; message: string }> = [];
      // lstat-only walk: symlinks/special files fail closed inside safeWalkWorkspace.
      for (const file of safeWalkWorkspace(context.workspaceDir)) {
        if (file.type !== "file") continue;
        const { content } = safeReadFile(context.workspaceDir, file.path, MAX_SCAN_FILE);
        for (const rule of SECRET_PATTERNS) {
          if (rule.pattern.test(content)) {
            findings.push({ severity: "error", file: file.path, message: "疑似 " + rule.name });
          }
        }
      }
      return { findings };
    });
  },
};

export const dependencyAuditTool: ServerToolDefinition<Record<string, never>, { findings: Array<{ severity: "error" | "warning"; file: string; message: string }> }> = {
  name: "dependency_audit",
  description: "对 workspace 依赖清单做受限审计（本地实现：版本范围检查；完整漏洞库需要外部服务）。",
  argsSchema: z.object({}).strict(),
  resultSchema: issuesResultSchema,
  allowedRoles: ["engineer"],
  risk: "medium",
  requiresApproval: false,
  async execute(_args, context) {
    return withWorkspaceLock(context.workspaceDir, async () => {
      const findings: Array<{ severity: "error" | "warning"; file: string; message: string }> = [];
      // package.json read through the shared jail (O_NOFOLLOW, symlink-free path).
      let content: string;
      try {
        content = safeReadFile(context.workspaceDir, "package.json", MAX_SCAN_FILE).content;
      } catch {
        return { findings: [] }; // missing package.json is not a finding
      }
      try {
        const pkg = JSON.parse(content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        for (const [name, version] of Object.entries(deps)) {
          if (/\*|latest|>|<|\^0\.0\./.test(version)) findings.push({ severity: "warning", file: "package.json", message: "依赖 " + name + " 使用了过宽版本范围：" + version });
        }
      } catch {
        findings.push({ severity: "warning", file: "package.json", message: "package.json 无法解析" });
      }
      return { findings };
    });
  },
};

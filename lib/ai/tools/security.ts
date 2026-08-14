import "server-only";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ServerToolDefinition } from "./types";
import { ToolExecutionError } from "./types";
import { z } from "zod";
import { appSpecSchema, getAppSpecIssues } from "@/lib/contracts/app-spec";
import { scanAppSpecForSecurityIssues } from "@/lib/app-spec/security";

/**
 * Review/security tools (Reviewer-only, read-only): review_changes, security_review,
 * secret_scan, dependency_audit, check_data_isolation (see data.ts).
 */

const SECRET_PATTERNS = [
  { name: "API Key", pattern: /(sk|pk|api[_-]?key|token)["']?\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/i },
  { name: "DATABASE_URL", pattern: /(postgres|mysql|mongodb):\/\/[^\s"']+/i },
  { name: "私钥", pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "AWS Key", pattern: /AKIA[0-9A-Z]{16}/ },
];

const MAX_SCAN_FILE = 256 * 1024;

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) walkFiles(full, out);
      else if (stat.isFile() && stat.size <= MAX_SCAN_FILE && !/\.(png|jpg|ico|woff2?|map)$/i.test(name)) out.push(full);
    } catch {
      // ignore
    }
  }
  return out;
}

const issuesResultSchema = z.object({
  findings: z.array(z.object({ severity: z.enum(["error", "warning"]), file: z.string().max(200), message: z.string().max(300) })).max(50),
});

export const reviewChangesTool: ServerToolDefinition<{ path?: string }, { findings: Array<{ severity: "error" | "warning"; file: string; message: string }> }> = {
  name: "review_changes",
  description: "审查 workspace 内变更（与最近检查点/初始状态对比的启发式检查）。",
  argsSchema: z.object({ path: z.string().max(300).default(".") }),
  resultSchema: issuesResultSchema,
  allowedRoles: ["reviewer", "security_reviewer"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const findings: Array<{ severity: "error" | "warning"; file: string; message: string }> = [];
    for (const file of walkFiles(path.resolve(context.workspaceDir, args.path ?? "."))) {
      const content = readFileSync(file, "utf8");
      if (/\beval\s*\(/.test(content)) findings.push({ severity: "error", file: path.relative(context.workspaceDir, file), message: "发现 eval() 调用" });
      if (/new\s+Function/.test(content)) findings.push({ severity: "error", file: path.relative(context.workspaceDir, file), message: "发现 new Function" });
      if (/child_process|execSync|shell:\s*true/.test(content)) findings.push({ severity: "warning", file: path.relative(context.workspaceDir, file), message: "发现子进程执行（请确认未使用 shell:true）" });
    }
    return { findings };
  },
};

export const securityReviewTool: ServerToolDefinition<{ artifactId: string }, { approved: boolean; summary: string; issues: Array<{ code: string; severity: "error" | "warning"; path: string; message: string; repairHint: string }> }> = {
  name: "security_review",
  description: "对 AppSpec artifact 做结构/语义/安全审查（服务端校验为准）。",
  argsSchema: z.object({ artifactId: z.string().min(8).max(64) }),
  resultSchema: z.object({
    approved: z.boolean(),
    summary: z.string().max(300),
    issues: z.array(z.object({ code: z.string(), severity: z.enum(["error", "warning"]), path: z.string(), message: z.string(), repairHint: z.string() })).max(20),
  }),
  allowedRoles: ["reviewer", "security_reviewer"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const raw = context.artifacts.get(args.artifactId);
    if (raw == null) throw new ToolExecutionError("ARTIFACT_NOT_FOUND", "artifact 不存在", false);
    const parsed = appSpecSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        approved: false,
        summary: "AppSpec 结构校验失败",
        issues: parsed.error.issues.slice(0, 20).map((issue) => ({ code: "INVALID_SCHEMA", severity: "error" as const, path: issue.path.join("."), message: issue.message, repairHint: "修正 schema 结构" })),
      };
    }
    const issues = [
      ...getAppSpecIssues(parsed.data).map((message) => ({ code: "SEMANTIC_ISSUE", severity: "error" as const, path: "appSpec", message, repairHint: "按提示修正" })),
      ...scanAppSpecForSecurityIssues(parsed.data).map((issue) => ({ code: issue.code, severity: issue.severity, path: issue.path, message: issue.message, repairHint: issue.repairHint })),
    ];
    return { approved: issues.length === 0, summary: issues.length === 0 ? "审查通过" : "发现 " + issues.length + " 个问题", issues: issues.slice(0, 20) };
  },
};

export const secretScanTool: ServerToolDefinition<Record<string, never>, { findings: Array<{ severity: "error" | "warning"; file: string; message: string }> }> = {
  name: "secret_scan",
  description: "扫描 workspace 中的密钥/凭据模式。",
  argsSchema: z.object({}).strict(),
  resultSchema: issuesResultSchema,
  allowedRoles: ["reviewer", "security_reviewer"],
  risk: "low",
  requiresApproval: false,
  async execute(_args, context) {
    const findings: Array<{ severity: "error" | "warning"; file: string; message: string }> = [];
    for (const file of walkFiles(context.workspaceDir)) {
      const content = readFileSync(file, "utf8");
      for (const rule of SECRET_PATTERNS) {
        if (rule.pattern.test(content)) {
          findings.push({ severity: "error", file: path.relative(context.workspaceDir, file), message: "疑似 " + rule.name });
        }
      }
    }
    return { findings };
  },
};

export const dependencyAuditTool: ServerToolDefinition<Record<string, never>, { findings: Array<{ severity: "error" | "warning"; file: string; message: string }> }> = {
  name: "dependency_audit",
  description: "对 workspace 依赖清单做受限审计（本地实现：版本范围检查；完整漏洞库需要外部服务）。",
  argsSchema: z.object({}).strict(),
  resultSchema: issuesResultSchema,
  allowedRoles: ["reviewer", "security_reviewer"],
  risk: "medium",
  requiresApproval: false,
  async execute(_args, context) {
    const packageJsonPath = path.join(context.workspaceDir, "package.json");
    if (!existsSync(packageJsonPath)) return { findings: [] };
    const findings: Array<{ severity: "error" | "warning"; file: string; message: string }> = [];
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      for (const [name, version] of Object.entries(deps)) {
        if (/\*|latest|>|<|\^0\.0\./.test(version)) findings.push({ severity: "warning", file: "package.json", message: "依赖 " + name + " 使用了过宽版本范围：" + version });
      }
    } catch {
      findings.push({ severity: "warning", file: "package.json", message: "package.json 无法解析" });
    }
    return { findings };
  },
};

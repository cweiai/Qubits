import type { AppSpec } from "@/lib/contracts/app-spec";

/**
 * Deterministic security scan (local fallback, double-layered with the AI Reviewer):
 * scans all string values in the AppSpec for dangerous patterns plus structural safety constraints.
 * It does not rely on model compliance; any hit blocks publishing and enters the repair loop.
 */

interface SecurityIssue {
  code: string;
  severity: "error" | "warning";
  path: string;
  message: string;
  repairHint: string;
}

interface ForbiddenRule {
  pattern: RegExp;
  code: string;
  message: string;
  repairHint: string;
}

const FORBIDDEN_RULES: ForbiddenRule[] = [
  {
    pattern: /\beval\s*\(/i,
    code: "EVAL_USAGE",
    message: "AppSpec 中不允许出现 eval 调用",
    repairHint: "移除 eval 相关内容；应用只能通过 Qubits Runtime API 实现交互",
  },
  {
    pattern: /new\s+Function/i,
    code: "DYNAMIC_FUNCTION",
    message: "AppSpec 中不允许出现 new Function",
    repairHint: "移除动态函数构造；使用声明式组件与受限操作",
  },
  {
    pattern: /\bimport\s*\(/i,
    code: "DYNAMIC_IMPORT",
    message: "AppSpec 中不允许出现动态 import",
    repairHint: "移除 import() 表达式",
  },
  {
    pattern: /SELECT\s+[\s\S]{0,80}?\s+FROM\s/i,
    code: "SQL_STATEMENT",
    message: "AppSpec 中不允许出现 SQL 语句",
    repairHint: "应用只能访问声明的集合，由后端负责数据读写，不要写任何 SQL",
  },
  {
    pattern: /DATABASE_URL/i,
    code: "DB_CREDENTIAL",
    message: "AppSpec 中不允许出现数据库连接串或凭据",
    repairHint: "删除 DATABASE_URL 等任何凭据信息",
  },
  {
    pattern: /(api[_-]?key|bearer\s+[a-z0-9]|secret|password)\s*[:=]/i,
    code: "SECRET_LEAK",
    message: "AppSpec 中不允许出现 API Key、密码等密钥",
    repairHint: "删除密钥相关内容",
  },
  {
    pattern: /\bfetch\s*\(/i,
    code: "EXTERNAL_FETCH",
    message: "AppSpec 中不允许出现外部 fetch 调用",
    repairHint: "沙盒禁止外部网络，请使用 Qubits Runtime API",
  },
  {
    pattern: /https?:\/\//i,
    code: "EXTERNAL_URL",
    message: "AppSpec 文本中不允许出现外部 URL",
    repairHint: "移除 URL 文案",
  },
  {
    pattern: /window\.parent/i,
    code: "PARENT_ACCESS",
    message: "AppSpec 中不允许访问父页面",
    repairHint: "沙盒与宿主只能通过 MessageChannel 通信",
  },
  {
    pattern: /localStorage|sessionStorage/i,
    code: "BROWSER_STORAGE",
    message: "AppSpec 中不允许使用浏览器存储",
    repairHint: "持久化数据必须通过 Qubits.data 写入后端",
  },
  {
    pattern: /document\.cookie/i,
    code: "COOKIE_ACCESS",
    message: "AppSpec 中不允许访问 cookie",
    repairHint: "移除 cookie 访问",
  },
];

function walk(value: unknown, path: string, issues: SecurityIssue[]): void {
  if (typeof value === "string") {
    for (const rule of FORBIDDEN_RULES) {
      if (rule.pattern.test(value)) {
        issues.push({
          code: rule.code,
          severity: "error",
          path: path || "appSpec",
          message: rule.message,
          repairHint: rule.repairHint,
        });
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, issues));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walk(child, path ? `${path}.${key}` : key, issues);
    }
  }
}

export function scanAppSpecForSecurityIssues(spec: AppSpec): SecurityIssue[] {
  const issues: SecurityIssue[] = [];
  walk(spec, "appSpec", issues);

  // Structural checks: collections/operations must be within the allowlist (Zod already guards; here we give friendlier hints).
  const collections = spec.collections ?? [];
  const names = new Set<string>();
  for (const collection of collections) {
    if (names.has(collection.name)) {
      issues.push({
        code: "DUPLICATE_COLLECTION",
        severity: "error",
        path: `appSpec.collections[${collection.name}]`,
        message: `集合「${collection.name}」重复声明`,
        repairHint: "每个集合只声明一次",
      });
    }
    names.add(collection.name);
  }
  return issues;
}

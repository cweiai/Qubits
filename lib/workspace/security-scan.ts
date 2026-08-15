import "server-only";
import { listSourceFiles } from "./workspace-manager";
import { readFileNofollow } from "./paths";

/**
 * Deterministic static scan over the generated code. It blocks at least:
 * eval / new Function / child_process / dynamic imports / unauthorized network /
 * storage & cookie access / parent-frame access / secret-reading patterns and
 * arbitrary filesystem access. The system-owned SDK bridge (src/lib/qubits.ts)
 * is the only file exempt (it cannot be edited by AI tools).
 */

export interface SecurityFinding {
  path: string;
  line: number;
  rule: string;
  message: string;
}

export interface SecurityScanReport {
  status: "pass" | "blocked";
  findings: SecurityFinding[];
  filesScanned: number;
}

interface ScanRule {
  name: string;
  pattern: RegExp;
  message: string;
}

const RULES: ScanRule[] = [
  { name: "NO_EVAL", pattern: /\beval\s*\(/, message: "禁止 eval()" },
  { name: "NO_NEW_FUNCTION", pattern: /new\s+Function\s*\(/, message: "禁止 new Function()" },
  { name: "NO_CHILD_PROCESS", pattern: /\bchild_process\b/, message: "禁止 child_process" },
  { name: "NO_DYNAMIC_IMPORT", pattern: /\bimport\s*\(/, message: "禁止动态 import()" },
  { name: "NO_NODE_API", pattern: /\brequire\s*\(/, message: "禁止 CommonJS require()（Node API 不可用）" },
  { name: "NO_NETWORK", pattern: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\s*\(|\bEventSource\s*\(|navigator\.sendBeacon/, message: "禁止网络请求（沙盒无网络能力）" },
  { name: "NO_STORAGE", pattern: /\blocalStorage\b|\bsessionStorage\b|\bdocument\.cookie\b|\bindexedDB\b/, message: "禁止访问存储与 Cookie" },
  { name: "NO_PARENT_ACCESS", pattern: /\bwindow\.parent\b|\bwindow\.top\b|\.parent\b/, message: "禁止访问父页面/宿主 DOM" },
  { name: "NO_PARENT_MESSAGING", pattern: /\b(?:parent|top)\.postMessage\s*\(/, message: "禁止直接向父页面/top 发送 postMessage（数据通道请使用 Qubits SDK）" },
  { name: "NO_PROCESS_ENV", pattern: /\bprocess\.env\b/, message: "禁止读取环境变量" },
  { name: "NO_CREDENTIALS", pattern: /(api[_-]?key|secret|password|authorization)\s*[:=]\s*["'`][^"'`]{4,}/i, message: "禁止硬编码凭据" },
  { name: "NO_SECRET_VALUE", pattern: /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/, message: "禁止密钥/令牌字面量" },
  { name: "NO_FS_IMPORT", pattern: /from\s+["'](?:node:)?fs(?:\/promises)?["']/, message: "禁止导入文件系统模块" },
  { name: "NO_OS_IMPORT", pattern: /from\s+["'](?:node:)?(?:os|net|tls|http2?|https|vm|worker_threads|dgram|dns)["']/, message: "禁止导入服务端内置模块" },
];

/** SDK bridge + launcher are trusted system skeleton files maintained by the system. */
const TRUSTED_TEMPLATE_FILES = new Set(["src/lib/qubits.ts"]);

const MAX_FILE_BYTES = 512 * 1024;

export function scanWorkspace(workspaceDir: string): SecurityScanReport {
  const findings: SecurityFinding[] = [];
  const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
  const files = listSourceFiles(workspaceDir).filter(
    (file) => !TRUSTED_TEMPLATE_FILES.has(file.path) && CODE_EXTENSIONS.some((ext) => file.path.endsWith(ext))
  );
  for (const file of files) {
    let content = "";
    try {
      content = readFileNofollow(file.abs).toString("utf8");
    } catch {
      continue;
    }
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
      findings.push({ path: file.path, line: 0, rule: "FILE_TOO_LARGE", message: "文件超过扫描大小上限" });
      continue;
    }
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      for (const rule of RULES) {
        if (rule.pattern.test(line)) {
          findings.push({ path: file.path, line: index + 1, rule: rule.name, message: rule.message });
          if (findings.length >= 40) {
            return { status: "blocked", findings, filesScanned: files.length };
          }
          break; // one finding per line is enough
        }
      }
    }
  }
  return { status: findings.length === 0 ? "pass" : "blocked", findings, filesScanned: files.length };
}



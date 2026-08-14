import "server-only";
import path from "node:path";
import type { SandboxProvider } from "@/lib/ai/tools/sandbox-provider";
import { WorkspaceError, redactHostText, type WorkspaceErrorCode } from "./errors";
import { requireWorkspace } from "./workspace-manager";

/**
 * Workspace check runner: lint / typecheck / tests execute through the SandboxProvider
 * (spawn with shell:false, allowlisted commands, timeouts and output caps) using
 * SYSTEM-maintained configs and host-installed tools. Generated code cannot change
 * these configs (protected paths) or run package scripts (none exist).
 */

export interface CheckResult {
  status: "passed" | "failed" | "timeout";
  exitCode: number;
  summary: string;
  log: string;
  durationMs: number;
}

const HOST = process.cwd();
// "node" must stay on the provider command allowlist (full binary paths are rejected).
const NODE = "node";
const TSC_BIN = path.join(HOST, "node_modules", "typescript", "bin", "tsc");
const ESLINT_BIN = path.join(HOST, "node_modules", "eslint", "bin", "eslint.js");
const VITEST_BIN = path.join(HOST, "node_modules", "vitest", "vitest.mjs");
const ESLINT_CONFIG = path.join(HOST, "lib", "workspace", "system-configs", "app-eslint.config.mjs");
const VITEST_CONFIG = path.join(HOST, "lib", "workspace", "system-configs", "app-vitest.config.mjs");

const CHECK_TIMEOUT_MS = 180_000;

async function runCheck(input: {
  sandbox: SandboxProvider | null;
  workspaceDir: string;
  command: string;
  args: string[];
  label: string;
  errorCode: WorkspaceErrorCode;
}): Promise<CheckResult> {
  const { sandbox, workspaceDir, command, args, label, errorCode } = input;
  requireWorkspace(workspaceDir);
  if (!sandbox) {
    throw new WorkspaceError("PROVIDER_UNAVAILABLE", "未配置沙盒 provider，无法执行" + label, false);
  }
  const result = await sandbox.exec({
    command,
    args,
    cwd: workspaceDir,
    timeoutMs: CHECK_TIMEOUT_MS,
    // ESLint 8 only validates flat-config-only flags (--no-config-lookup) when flat mode is active;
    // the workspace has no eslint.config, so force flat mode explicitly.
    extraEnv: { ESLINT_USE_FLAT_CONFIG: "true" },
  });
  const log = redactHostText([result.stdout.slice(-2400), result.stderr.slice(-1200)].filter(Boolean).join("\n"), workspaceDir);
  const status = result.timedOut ? "timeout" : result.exitCode === 0 ? "passed" : "failed";
  const summary =
    label + "：" + (status === "passed" ? "通过" : status === "timeout" ? "超时" : "失败（exitCode=" + result.exitCode + "）") +
    (log ? "\n" + log.slice(-1200) : "");
  if (status === "failed") {
    throw new WorkspaceError(errorCode, summary.slice(0, 400), true);
  }
  return { status, exitCode: result.exitCode, summary: summary.slice(0, 2000), log, durationMs: result.durationMs };
}

export async function runWorkspaceTypecheck(sandbox: SandboxProvider | null, workspaceDir: string): Promise<CheckResult> {
  return runCheck({
    sandbox,
    workspaceDir,
    command: NODE,
    args: [TSC_BIN, "--noEmit", "-p", "tsconfig.json"],
    label: "TypeScript 类型检查",
    errorCode: "TYPECHECK_FAILED",
  });
}

export async function runWorkspaceLint(sandbox: SandboxProvider | null, workspaceDir: string): Promise<CheckResult> {
  return runCheck({
    sandbox,
    workspaceDir,
    command: NODE,
    args: [ESLINT_BIN, "--no-config-lookup", "--config", ESLINT_CONFIG, "src"],
    label: "ESLint 检查",
    errorCode: "LINT_FAILED",
  });
}

export async function runWorkspaceTests(sandbox: SandboxProvider | null, workspaceDir: string): Promise<CheckResult> {
  return runCheck({
    sandbox,
    workspaceDir,
    command: NODE,
    args: [VITEST_BIN, "run", "--root", workspaceDir, "--config", VITEST_CONFIG],
    label: "单元测试",
    errorCode: "TEST_FAILED",
  });
}

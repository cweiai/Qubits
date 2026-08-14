import "server-only";
import path from "node:path";
import type { SandboxProvider } from "@/lib/ai/tools/sandbox-provider";
import { WorkspaceError, redactHostText, type WorkspaceErrorCode } from "./errors";
import { requireWorkspace } from "./workspace-manager";
import { assertWorkspaceTreeSafe, withWorkspaceLock } from "./paths";

/**
 * Workspace check runner: lint / typecheck / tests execute ONLY inside the Docker
 * ContainerSandbox. The system toolchain (typescript/eslint/vitest and the
 * system-maintained configs) is mounted read-only at /usr/tools; generated code can
 * never change these configs (protected paths) or run package scripts (none exist).
 * Runs serialize with agent file operations via the per-workspace mutex, and the tree
 * is re-scanned for symlinks/special files after every container execution.
 */

export interface CheckResult {
  status: "passed" | "failed" | "timeout";
  exitCode: number;
  summary: string;
  log: string;
  durationMs: number;
}

const HOST = process.cwd();
const NODE = "node";
// Toolchain layout inside the container:
// - qubits-toolchain image provides /qubits-tools/node_modules (linux-native binaries:
//   vitest/vite/rollup/esbuild), so vitest runs in the container.
// - host node_modules is mounted read-only at /workspace/node_modules so tsc/eslint
//   and the generated code resolve types/modules (pure-JS parts only).
// - host system-configs is mounted read-only at /qubits-tools/configs; config imports
//   resolve by walking up to /qubits-tools/node_modules.
const TSC_BIN = "/workspace/node_modules/typescript/bin/tsc";
const ESLINT_BIN = "/workspace/node_modules/eslint/bin/eslint.js";
const VITEST_BIN = "/qubits-tools/node_modules/vitest/vitest.mjs";
const ESLINT_CONFIG = "/qubits-tools/configs/app-eslint.config.mjs";
const VITEST_CONFIG = "/qubits-tools/configs/app-vitest.config.mjs";
// Workspace mount point inside the container.
const WORKSPACE_IN_CONTAINER = "/workspace";

const TOOLCHAIN_MOUNTS = [
  { hostPath: path.join(HOST, "node_modules"), containerPath: "/workspace/node_modules" },
  { hostPath: path.join(HOST, "lib", "workspace", "system-configs"), containerPath: "/qubits-tools/configs" },
];

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
  return withWorkspaceLock(workspaceDir, async () => {
    // Fail closed before running if the tree already contains symlinks/special files.
    assertWorkspaceTreeSafe(workspaceDir);
    const result = await sandbox.exec({
      command,
      args,
      cwd: workspaceDir,
      timeoutMs: CHECK_TIMEOUT_MS,
      extraEnv: { ESLINT_USE_FLAT_CONFIG: "true" },
      extraMounts: TOOLCHAIN_MOUNTS,
    });
    // Fail closed after running: a check could have planted symlinks via test code.
    try {
      assertWorkspaceTreeSafe(workspaceDir);
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === "SECURITY_BLOCKED") throw error;
    }
    const log = redactHostText(
      [result.stdout.slice(-2400), result.stderr.slice(-1200)].filter(Boolean).join("\n"),
      workspaceDir
    );
    const status = result.timedOut ? "timeout" : result.exitCode === 0 ? "passed" : "failed";
    const summary =
      label + "：" + (status === "passed" ? "通过" : status === "timeout" ? "超时" : "失败（exitCode=" + result.exitCode + "）") +
      (log ? "\n" + log.slice(-1200) : "");
    if (status === "failed") {
      throw new WorkspaceError(errorCode, summary.slice(0, 400), true);
    }
    return { status, exitCode: result.exitCode, summary: summary.slice(0, 2000), log, durationMs: result.durationMs };
  });
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
    args: [VITEST_BIN, "run", "--root", WORKSPACE_IN_CONTAINER, "--config", VITEST_CONFIG],
    label: "单元测试",
    errorCode: "TEST_FAILED",
  });
}

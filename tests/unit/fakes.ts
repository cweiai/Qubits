import { execFileSync } from "node:child_process";
import type { ExecResult, ExecSandboxInput, SandboxInfo, SandboxProvider } from "@/lib/ai/tools/sandbox-provider";

/**
 * In-memory FakeSandboxProvider for unit tests that only need a sandbox-shaped
 * context (permission/registry/fs-jail tests). It NEVER executes anything on the
 * host; exec returns scripted results. Tests that need real execution use the real
 * ContainerSandboxProvider (skipped when Docker is unavailable).
 */
export class FakeSandboxProvider implements SandboxProvider {
  readonly kind = "fake";
  readonly isProductionSecurityBoundary = true;
  readonly securityBoundaryNote = "FakeSandboxProvider：内存测试桩，不执行任何宿主命令。";
  readonly calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  results: Array<ExecResult> = [];
  defaultResult: ExecResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 };

  async create(workspaceDir: string): Promise<SandboxInfo> {
    return {
      sandboxId: "fake-" + Math.random().toString(36).slice(2, 8),
      provider: this.kind,
      workspaceDir,
      demoMode: true,
      isProductionSecurityBoundary: true,
    };
  }

  async exec(input: ExecSandboxInput): Promise<ExecResult> {
    this.calls.push({ command: input.command, args: input.args, cwd: input.cwd });
    return this.results.shift() ?? { ...this.defaultResult };
  }

  async kill(): Promise<boolean> {
    return true;
  }

  isAlive(): boolean {
    return false;
  }

  async reset(): Promise<void> {
    this.calls.length = 0;
  }

  isAvailable(): boolean {
    return true;
  }
}

/** One-time check so suites can skip Docker-dependent tests without a daemon. */
export function dockerAvailable(): boolean {
  try {
    const out = execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 5000, stdio: "pipe" }).toString();
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

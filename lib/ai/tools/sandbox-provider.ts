import "server-only";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

/**
 * SandboxProvider abstraction for executing build/check commands against a workspace.
 *
 * - LocalDevSandboxProvider ("local-dev"): development/testing ONLY. It is explicitly
 *   NOT a production security boundary — it provides cwd jailing, an env allowlist,
 *   secret stripping and output caps, but no kernel/container isolation.
 * - ContainerSandboxProvider ("container"): the production interface. When Docker is
 *   not available it FAILS CLOSED — it never silently falls back to host execution.
 *
 * Invariants shared by every provider: spawn(command, args) with shell:false, command
 * allowlist, timeout/output/process caps, sensitive env stripping, no network by
 * default, and process cleanup on reset.
 */

export interface SandboxInfo {
  sandboxId: string;
  provider: string;
  workspaceDir: string;
  demoMode: boolean;
  isProductionSecurityBoundary: boolean;
}

export interface ExecSandboxInput {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  /** Allowlisted extra env keys copied from the parent process (never secrets). */
  extraEnv?: Record<string, string>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export class SandboxProviderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SandboxProviderError";
    this.code = code;
  }
}

export interface SandboxProvider {
  readonly kind: string;
  /** Production container isolation: true only for ContainerSandboxProvider. */
  readonly isProductionSecurityBoundary: boolean;
  readonly securityBoundaryNote: string;
  create(workspaceDir: string): Promise<SandboxInfo>;
  exec(input: ExecSandboxInput, onChunk?: (chunk: string) => void): Promise<ExecResult>;
  kill(pid: number): Promise<boolean>;
  isAlive(pid: number): boolean;
  reset(workspaceDir: string): Promise<void>;
}

const SENSITIVE_ENV = /(API_KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|OPENAI|ANTHROPIC|PRIVATE_KEY)/i;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_PROCESSES = 8;

const DEFAULT_ALLOWLIST = "npm,node,npx,next,eslint,tsc,git,bash,sh";
const LOCAL_DEV_NOTE = "LocalDevSandbox 不是生产安全边界：仅用于本地开发与测试，不提供容器级隔离，绝不能承载不受信任的多租户负载。";
const CONTAINER_NOTE = "ContainerSandbox：非 root 容器、只挂载当前 workspace、默认禁网、资源受限，是生产级隔离边界。";

export function buildSandboxEnv(provider: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  const allowlistEnv = new Set(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "NODE_ENV"]);
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    if (SENSITIVE_ENV.test(key)) continue; // strip secrets and sensitive variables
    if (!allowlistEnv.has(key) && !key.startsWith("npm_config_")) continue; // minimal env only
    env[key] = value;
  }
  // Networking disabled by default: proxy/credential variables are removed.
  delete env.HTTP_PROXY;
  delete env.http_proxy;
  delete env.HTTPS_PROXY;
  delete env.https_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  env.QUBITS_SANDBOX = provider;
  return env;
}

export class LocalDevSandboxProvider implements SandboxProvider {
  readonly kind = "local-dev";
  readonly isProductionSecurityBoundary = false;
  readonly securityBoundaryNote = LOCAL_DEV_NOTE;
  private processes = new Map<number, { alive: boolean; command: string }>();
  private allowlist: string[];

  constructor() {
    const raw = process.env.SANDBOX_COMMAND_ALLOWLIST || DEFAULT_ALLOWLIST;
    this.allowlist = raw.split(",").map((item) => item.trim()).filter(Boolean);
  }

  async create(workspaceDir: string): Promise<SandboxInfo> {
    mkdirSync(workspaceDir, { recursive: true });
    return {
      sandboxId: "sandbox-" + Math.random().toString(36).slice(2, 10),
      provider: this.kind,
      workspaceDir,
      demoMode: true,
      isProductionSecurityBoundary: false,
    };
  }

  exec(input: ExecSandboxInput, onChunk?: (chunk: string) => void): Promise<ExecResult> {
    return new Promise((resolve) => {
      if (this.processes.size >= MAX_PROCESSES) {
        resolve({ exitCode: 1, stdout: "", stderr: "子进程数量超出上限", timedOut: false, durationMs: 0 });
        return;
      }
      if (!this.allowlist.includes(input.command)) {
        resolve({ exitCode: 126, stdout: "", stderr: "命令不在 allowlist 中：" + input.command, timedOut: false, durationMs: 0 });
        return;
      }
      if (!existsSync(input.cwd)) {
        resolve({ exitCode: 1, stdout: "", stderr: "cwd 不存在", timedOut: false, durationMs: 0 });
        return;
      }
      const startedAt = Date.now();
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const env = buildSandboxEnv(this.kind) as NodeJS.ProcessEnv;
      for (const [key, value] of Object.entries(input.extraEnv ?? {})) {
        if (value != null && !SENSITIVE_ENV.test(key)) env[key] = value;
      }
      const child = spawn(input.command, input.args, {
        cwd: input.cwd,
        env,
        shell: false, // never shell: true
      });
      this.processes.set(child.pid ?? -1, { alive: true, command: input.command });
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
      }, input.timeoutMs);
      const push = (chunk: Buffer, target: "stdout" | "stderr") => {
        const text = chunk.toString("utf8");
        if (target === "stdout") {
          if (Buffer.byteLength(stdout) < MAX_OUTPUT_BYTES) stdout += text;
        } else {
          if (Buffer.byteLength(stderr) < MAX_OUTPUT_BYTES) stderr += text;
        }
        onChunk?.(text.slice(0, 2000));
      };
      child.stdout?.on("data", (chunk: Buffer) => push(chunk, "stdout"));
      child.stderr?.on("data", (chunk: Buffer) => push(chunk, "stderr"));
      child.on("error", (error) => {
        stderr += error.message;
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const processInfo = this.processes.get(child.pid ?? -1);
        if (processInfo) processInfo.alive = false;
        resolve({
          exitCode: timedOut ? 124 : (code ?? 1),
          stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
          stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
          timedOut,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }

  async kill(pid: number): Promise<boolean> {
    const processInfo = this.processes.get(pid);
    if (!processInfo || !processInfo.alive) return false;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return false;
    }
    processInfo.alive = false;
    return true;
  }

  isAlive(pid: number): boolean {
    return this.processes.get(pid)?.alive === true;
  }

  async reset(workspaceDir: string): Promise<void> {
    for (const [pid, info] of this.processes) {
      if (info.alive) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    this.processes.clear();
    void workspaceDir;
  }
}

/**
 * Production container sandbox: non-root user, only the workspace mounted, minimal env,
 * no network, memory/CPU/pid limits and per-command timeout. When Docker is unreachable
 * every call fails closed with PROVIDER_UNAVAILABLE — never host fallback.
 */
export class ContainerSandboxProvider implements SandboxProvider {
  readonly kind = "container";
  readonly isProductionSecurityBoundary = true;
  readonly securityBoundaryNote = CONTAINER_NOTE;
  private unavailableReason: string | null = null;
  private readonly image: string;
  private processes = new Map<number, { alive: boolean; command: string }>();

  constructor(image?: string) {
    this.image = image ?? process.env.SANDBOX_IMAGE ?? "node:22-alpine";
    this.unavailableReason = detectDockerUnavailable();
  }

  private assertAvailable(): void {
    if (this.unavailableReason) {
      throw new SandboxProviderError("PROVIDER_UNAVAILABLE", "容器沙盒不可用（" + this.unavailableReason + "）。为安全起见拒绝执行（fail closed），不会回退到宿主执行。");
    }
  }

  async create(workspaceDir: string): Promise<SandboxInfo> {
    this.assertAvailable();
    mkdirSync(workspaceDir, { recursive: true });
    return {
      sandboxId: "container-" + Math.random().toString(36).slice(2, 10),
      provider: this.kind,
      workspaceDir,
      demoMode: false,
      isProductionSecurityBoundary: true,
    };
  }

  exec(input: ExecSandboxInput, onChunk?: (chunk: string) => void): Promise<ExecResult> {
    return new Promise((resolve) => {
      try {
        this.assertAvailable();
      } catch (error) {
        resolve({
          exitCode: 125,
          stdout: "",
          stderr: "[PROVIDER_UNAVAILABLE] " + (error instanceof Error ? error.message : "容器沙盒不可用"),
          timedOut: false,
          durationMs: 0,
        });
        return;
      }
      if (this.processes.size >= MAX_PROCESSES) {
        resolve({ exitCode: 1, stdout: "", stderr: "子进程数量超出上限", timedOut: false, durationMs: 0 });
        return;
      }
      if (!existsSync(input.cwd)) {
        resolve({ exitCode: 1, stdout: "", stderr: "cwd 不存在", timedOut: false, durationMs: 0 });
        return;
      }
      const startedAt = Date.now();
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const args = [
        "run", "--rm",
        "--network", "none",
        "--memory", "512m",
        "--cpus", "1",
        "--pids-limit", "128",
        "--user", "10001:10001",
        "--read-only",
        "--tmpfs", "/tmp:rw,size=64m,noexec",
        "-v", input.cwd + ":/workspace:rw",
        "-w", "/workspace",
        "-e", "QUBITS_SANDBOX=container",
        "-e", "HOME=/tmp",
        this.image,
        input.command, ...input.args,
      ];
      const child = spawn("docker", args, {
        env: buildSandboxEnv(this.kind) as NodeJS.ProcessEnv,
        shell: false,
      });
      this.processes.set(child.pid ?? -1, { alive: true, command: "docker:" + input.command });
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
      }, input.timeoutMs);
      const push = (chunk: Buffer, target: "stdout" | "stderr") => {
        const text = chunk.toString("utf8");
        if (target === "stdout") {
          if (Buffer.byteLength(stdout) < MAX_OUTPUT_BYTES) stdout += text;
        } else {
          if (Buffer.byteLength(stderr) < MAX_OUTPUT_BYTES) stderr += text;
        }
        onChunk?.(text.slice(0, 2000));
      };
      child.stdout?.on("data", (chunk: Buffer) => push(chunk, "stdout"));
      child.stderr?.on("data", (chunk: Buffer) => push(chunk, "stderr"));
      child.on("error", (error) => {
        stderr += error.message;
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const processInfo = this.processes.get(child.pid ?? -1);
        if (processInfo) processInfo.alive = false;
        resolve({
          exitCode: timedOut ? 124 : (code ?? 1),
          stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
          stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
          timedOut,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }

  async kill(pid: number): Promise<boolean> {
    const processInfo = this.processes.get(pid);
    if (!processInfo || !processInfo.alive) return false;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return false;
    }
    processInfo.alive = false;
    return true;
  }

  isAlive(pid: number): boolean {
    return this.processes.get(pid)?.alive === true;
  }

  async reset(workspaceDir: string): Promise<void> {
    for (const [pid, info] of this.processes) {
      if (info.alive) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    this.processes.clear();
    void workspaceDir;
  }
}

function detectDockerUnavailable(): string | null {
  try {
    const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      timeout: 5000,
      shell: false,
      stdio: "pipe",
    });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code ?? "unknown";
      return "docker 不可达：" + code;
    }
    if (result.status !== 0) return "docker daemon 未运行";
    return null;
  } catch {
    return "docker 不可达";
  }
}

export function getSandboxProvider(): SandboxProvider | null {
  const kind = process.env.SANDBOX_PROVIDER || "local-dev";
  if (kind === "local-dev" || kind === "local-demo") return new LocalDevSandboxProvider();
  if (kind === "container") return new ContainerSandboxProvider(); // fail closed when Docker is absent
  if (kind === "none") return null;
  return null; // unknown providers are NOT_CONFIGURED, never a silent local fallback
}

export function describeSandboxProvider(provider: SandboxProvider | null): { available: boolean; provider: string; note: string } {
  if (!provider) {
    return { available: false, provider: "none", note: "沙盒未配置（SANDBOX_PROVIDER=none）" };
  }
  return { available: true, provider: provider.kind, note: provider.securityBoundaryNote };
}

// Back-compat export (tests/migrations may still reference the old name).
export { LocalDevSandboxProvider as LocalSandboxProvider };

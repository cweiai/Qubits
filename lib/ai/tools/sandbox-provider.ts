import "server-only";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { withWorkspaceLock } from "@/lib/workspace/paths";

/**
 * SandboxProvider: the ONLY provider is the Docker ContainerSandbox. Physical
 * isolation: non-root user, only the (canonicalized, symlink-free) workspace mounted,
 * read-only root, no network, no extra capabilities, no privilege escalation,
 * resource limits and per-command timeouts. When Docker or the image is unavailable
 * every call FAILS CLOSED with a clear error — there is no host-execution fallback,
 * and there is no local provider to fall back to.
 *
 * - getSandboxProvider() ALWAYS returns ContainerSandboxProvider.
 * - SANDBOX_PROVIDER, if set, must be exactly "container"; any other value throws
 *   at startup (never silently ignored).
 * - exec() validates command (allowlist), args (no NUL, length caps) and cwd (must
 *   exist, be a directory, and be its own realpath — symlinked cwd is rejected), and
 *   runs under the same per-workspace mutex as host-side file operations, so the
 *   container can never race a host file access (TOCTOU guard).
 */

export interface SandboxInfo {
  sandboxId: string;
  provider: string;
  workspaceDir: string;
  isProductionSecurityBoundary: boolean;
}

/** Extra read-only mount (system-supplied toolchain paths only, never agent input). */
export interface ReadOnlyMount {
  hostPath: string;
  containerPath: string;
}

export interface ExecSandboxInput {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  /** Allowlisted extra env keys copied from the parent process (never secrets). */
  extraEnv?: Record<string, string>;
  /** System-supplied read-only mounts (e.g. the toolchain). Validated strictly. */
  extraMounts?: ReadOnlyMount[];
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
  readonly isProductionSecurityBoundary: boolean;
  readonly securityBoundaryNote: string;
  create(workspaceDir: string): Promise<SandboxInfo>;
  exec(input: ExecSandboxInput, onChunk?: (chunk: string) => void): Promise<ExecResult>;
  kill(pid: number): Promise<boolean>;
  isAlive(pid: number): boolean;
  reset(workspaceDir: string): Promise<void>;
  /** Fresh availability check (Docker daemon reachable). */
  isAvailable(): boolean;
}

const SENSITIVE_ENV = /(API_KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|OPENAI|ANTHROPIC|PRIVATE_KEY|AWS_|AZURE_|GCP_|GOOGLE_|GITHUB_|GITLAB_|SSH_|NPM_TOKEN|DOCKER_)/i;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_PROCESSES = 8;
const MAX_ARGS = 30;
const MAX_ARG_BYTES = 400;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 300_000;

const DEFAULT_ALLOWLIST = "npm,node,npx,next,eslint,tsc,git,bash,sh";
const CONTAINER_NOTE = "ContainerSandbox 容器：非 root、cap-drop=ALL、no-new-privileges、只挂载当前 workspace（canonicalize 后）、只读根、禁网、资源受限，是唯一的生产级隔离边界。";

/** Host env for the docker CLI process itself: minimal, secrets and proxies stripped. */
function buildSandboxEnv(provider: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  const allowlistEnv = new Set(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"]);
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    if (SENSITIVE_ENV.test(key)) continue; // strip secrets and sensitive variables
    if (!allowlistEnv.has(key) && !key.startsWith("npm_config_")) continue; // minimal env only
    env[key] = value;
  }
  // Networking disabled: proxy/credential variables are removed from the CLI env.
  delete env.HTTP_PROXY;
  delete env.http_proxy;
  delete env.HTTPS_PROXY;
  delete env.https_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  env.QUBITS_SANDBOX = provider;
  return env;
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

/**
 * The only sandbox provider: Docker container, physical isolation, fail closed.
 * Non-root user, only the canonicalized workspace mounted, read-only root, no network,
 * cap-drop=ALL, no-new-privileges, memory/CPU/pid limits and per-command timeout.
 */
export class ContainerSandboxProvider implements SandboxProvider {
  readonly kind = "container";
  readonly isProductionSecurityBoundary = true;
  readonly securityBoundaryNote = CONTAINER_NOTE;
  private unavailableReason: string | null = null;
  private readonly image: string;
  private allowlist: string[];
  private processes = new Map<number, { alive: boolean; command: string }>();

  constructor(image?: string) {
    // Default: the qubits-toolchain image (node + pinned toolchain with linux-native
    // binaries). Build it with scripts/build-toolchain-image.sh.
    this.image = image ?? process.env.SANDBOX_IMAGE ?? "qubits-toolchain:latest";
    const raw = process.env.SANDBOX_COMMAND_ALLOWLIST || DEFAULT_ALLOWLIST;
    this.allowlist = raw.split(",").map((item) => item.trim()).filter(Boolean);
    this.unavailableReason = detectDockerUnavailable();
  }

  isAvailable(): boolean {
    if (this.unavailableReason) return false;
    return detectDockerUnavailable() === null;
  }

  private assertAvailable(): void {
    if (this.unavailableReason) {
      throw new SandboxProviderError("PROVIDER_UNAVAILABLE", "容器沙盒不可用（" + this.unavailableReason + "）。为安全起见拒绝执行（fail closed），绝不回退到宿主执行。");
    }
  }

  /** Validate the cwd: must exist, be a directory and not itself be a symlink. */
  private validateCwd(cwd: string): string {
    if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > 500 || cwd.includes("\0")) {
      throw new SandboxProviderError("INVALID_CWD", "cwd 不合法");
    }
    if (!existsSync(cwd) || !lstatSync(cwd).isDirectory()) {
      throw new SandboxProviderError("INVALID_CWD", "cwd 不存在或不是目录");
    }
    if (lstatSync(cwd).isSymbolicLink()) {
      throw new SandboxProviderError("INVALID_CWD", "cwd 是符号链接，拒绝执行");
    }
    // Mount the canonical path (lstat above already rejected a symlinked cwd itself).
    return realpathSync(cwd);
  }

  /** Validate command + args strictly; the allowlist gates the entry binary only. */
  private validateCommand(command: string, args: string[]): void {
    if (typeof command !== "string" || command.length === 0 || command.length > 100 || command.includes("\0")) {
      throw new SandboxProviderError("INVALID_COMMAND", "command 不合法");
    }
    if (command.includes("/") || command.includes("\\")) {
      throw new SandboxProviderError("INVALID_COMMAND", "command 必须是纯二进制名（禁止路径）");
    }
    if (!this.allowlist.includes(command)) {
      throw new SandboxProviderError("INVALID_COMMAND", "命令不在 allowlist 中：" + command);
    }
    if (!Array.isArray(args) || args.length > MAX_ARGS) {
      throw new SandboxProviderError("INVALID_ARGS", "args 数量超出上限");
    }
    for (const arg of args) {
      if (typeof arg !== "string" || arg.length > MAX_ARG_BYTES || arg.includes("\0")) {
        throw new SandboxProviderError("INVALID_ARGS", "args 包含非法参数");
      }
    }
  }

  private validateMounts(mounts: ReadOnlyMount[]): Array<{ host: string; container: string }> {
    const out: Array<{ host: string; container: string }> = [];
    for (const mount of mounts) {
      if (typeof mount.hostPath !== "string" || typeof mount.containerPath !== "string") {
        throw new SandboxProviderError("INVALID_MOUNT", "挂载配置不合法");
      }
      if (!path.isAbsolute(mount.containerPath) || mount.containerPath.includes("..") || mount.containerPath.includes("\0")) {
        throw new SandboxProviderError("INVALID_MOUNT", "容器挂载路径不合法：" + mount.containerPath);
      }
      if (!existsSync(mount.hostPath) || lstatSync(mount.hostPath).isSymbolicLink()) {
        throw new SandboxProviderError("INVALID_MOUNT", "宿主挂载路径不存在或是符号链接：" + mount.hostPath);
      }
      out.push({ host: realpathSync(mount.hostPath), container: mount.containerPath });
    }
    return out;
  }

  async create(workspaceDir: string): Promise<SandboxInfo> {
    this.assertAvailable();
    mkdirSync(workspaceDir, { recursive: true });
    return {
      sandboxId: "container-" + Math.random().toString(36).slice(2, 10),
      provider: this.kind,
      workspaceDir,
      isProductionSecurityBoundary: true,
    };
  }

  exec(input: ExecSandboxInput, onChunk?: (chunk: string) => void): Promise<ExecResult> {
    return withWorkspaceLock(input.cwd, () => this.execLocked(input, onChunk));
  }

  private execLocked(input: ExecSandboxInput, onChunk?: (chunk: string) => void): Promise<ExecResult> {
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
      let mounts: Array<{ host: string; container: string }> = [];
      let workspaceReal: string;
      try {
        workspaceReal = this.validateCwd(input.cwd);
        this.validateCommand(input.command, input.args);
        mounts = this.validateMounts(input.extraMounts ?? []);
      } catch (error) {
        resolve({
          exitCode: 126,
          stdout: "",
          stderr: error instanceof Error ? error.message : "参数校验失败",
          timedOut: false,
          durationMs: 0,
        });
        return;
      }
      const timeoutMs = Math.min(Math.max(input.timeoutMs, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
      const startedAt = Date.now();
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const args = [
        "run", "--rm",
        "--network", "none",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--memory", "512m",
        "--cpus", "1",
        "--pids-limit", "128",
        "--user", "10001:10001",
        "--read-only",
        "--tmpfs", "/tmp:rw,size=64m,noexec",
        // Vite's config loader writes a temp dir next to its node_modules (read-only
        // image layer); give it a small writable tmpfs.
        "--tmpfs", "/qubits-tools/node_modules/.vite-temp:rw,size=16m,noexec",
        "-v", workspaceReal + ":/workspace:rw",
        "-w", "/workspace",
        "-e", "QUBITS_SANDBOX=container",
        "-e", "HOME=/tmp",
      ];
      for (const mount of mounts) {
        args.push("-v", mount.host + ":" + mount.container + ":ro");
      }
      for (const [key, value] of Object.entries(input.extraEnv ?? {})) {
        if (value != null && !SENSITIVE_ENV.test(key) && typeof value === "string") {
          args.push("-e", key + "=" + value);
        }
      }
      args.push(this.image, input.command, ...input.args);
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
      }, timeoutMs);
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
        // The cap is for concurrent children, not lifetime executions.
        this.processes.delete(child.pid ?? -1);
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
 * The sandbox is ALWAYS the Docker container. If SANDBOX_PROVIDER is set it must be
 * exactly "container"; any other value (legacy local modes, none, unknown) throws —
 * startup fails instead of silently running without physical isolation.
 */
export function getSandboxProvider(): SandboxProvider {
  const kind = (process.env.SANDBOX_PROVIDER ?? "container").trim();
  if (kind !== "container") {
    throw new Error("SANDBOX_PROVIDER 只允许 container（物理隔离）。当前值 \"" + kind + "\" 不受支持，拒绝启动。");
  }
  return new ContainerSandboxProvider(); // fail closed when Docker is absent
}

/** Accurate runtime status: available is true only when the Docker daemon is reachable right now. */
export function describeSandboxProvider(provider: SandboxProvider): { available: boolean; provider: string; note: string } {
  if (!provider) {
    return { available: false, provider: "none", note: "沙盒未配置（无 provider）" };
  }
  const available = provider.kind === "container" && provider.isAvailable();
  return {
    available,
    provider: provider.kind,
    note: available ? provider.securityBoundaryNote : provider.securityBoundaryNote + "（当前 Docker 不可用，执行将失败关闭）",
  };
}

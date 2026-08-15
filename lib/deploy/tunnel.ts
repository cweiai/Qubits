/**
 * Public tunnel manager: Cloudflare Quick Tunnel (trycloudflare.com).
 *
 * A quick tunnel needs no account and no token — cloudflared assigns a random
 * `https://<random>.trycloudflare.com` hostname that forwards to the deploy router.
 * The binary is looked up in PATH / DEPLOY_TUNNEL_BINARY, or provisioned on first use
 * by downloading the official release binary into <project>/bin/.
 *
 * The hostname is ephemeral by design: it changes whenever cloudflared (re)connects,
 * and dies with the Qubits server process. Deployments store only their path
 * (`/d/<id>/`), so the public URL is always assembled from the current base.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DeployError } from "./errors";

const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;
const MAX_RESTART_ATTEMPTS = 8;

interface TunnelAsset {
  name: string;
  /** macOS assets are .tgz archives; linux assets are bare binaries. */
  extract: boolean;
}

function tunnelAsset(): TunnelAsset | null {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "darwin" && arch === "arm64") return { name: "cloudflared-darwin-arm64.tgz", extract: true };
  if (platform === "darwin" && arch === "x64") return { name: "cloudflared-darwin-amd64.tgz", extract: true };
  if (platform === "linux" && arch === "x64") return { name: "cloudflared-linux-amd64", extract: false };
  if (platform === "linux" && arch === "arm64") return { name: "cloudflared-linux-arm64", extract: false };
  return null;
}

function findInPath(binary: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveCloudflaredBinary(): string | null {
  const explicit = process.env.DEPLOY_TUNNEL_BINARY;
  if (explicit && existsSync(explicit)) return explicit;
  return findInPath("cloudflared") ?? (existsSync(path.join(process.cwd(), "bin", "cloudflared")) ? path.join(process.cwd(), "bin", "cloudflared") : null);
}

/** Download the official cloudflared release binary into <project>/bin/ when missing. */
export function provisionCloudflared(): string {
  const existing = resolveCloudflaredBinary();
  if (existing) return existing;
  const asset = tunnelAsset();
  if (!asset) {
    throw new DeployError("DEPLOY_TUNNEL_UNSUPPORTED_PLATFORM", "当前平台不支持自动下载 cloudflared，请手动安装后重试。");
  }
  const targetDir = path.join(process.cwd(), "bin");
  const target = path.join(targetDir, "cloudflared");
  mkdirSync(targetDir, { recursive: true });
  const url = "https://github.com/cloudflare/cloudflared/releases/latest/download/" + asset.name;
  const tmpArchive = path.join(targetDir, asset.name + ".download");

  const download = spawnSync("curl", ["-fL", "--max-time", "180", "-o", tmpArchive, url], {
    timeout: 200_000,
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
  });
  if (download.status !== 0 || !existsSync(tmpArchive)) {
    const detail = ((download.stderr ?? "").split("\n").slice(-3).join(" ") || "下载失败").slice(0, 300);
    throw new DeployError("DEPLOY_TUNNEL_DOWNLOAD_FAILED", "cloudflared 下载失败（" + detail + "）。也可用 brew install cloudflared 手动安装。");
  }
  try {
    if (asset.extract) {
      const extract = spawnSync("tar", ["-xzf", tmpArchive, "-C", targetDir, "cloudflared"], {
        timeout: 60_000,
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
        encoding: "utf8",
      });
      if (extract.status !== 0 || !existsSync(target)) {
        throw new DeployError("DEPLOY_TUNNEL_EXTRACT_FAILED", "cloudflared 解压失败，请删除 bin/ 后重试或手动安装。");
      }
    } else {
      const move = spawnSync("mv", ["-f", tmpArchive, target], { timeout: 30_000, shell: false });
      if (move.status !== 0 || !existsSync(target)) {
        throw new DeployError("DEPLOY_TUNNEL_DOWNLOAD_FAILED", "cloudflared 落盘失败，请重试。");
      }
    }
    chmodSync(target, 0o755);
  } finally {
    rmSync(tmpArchive, { force: true });
  }
  const verify = spawnSync(target, ["--version"], { timeout: 15000, shell: false, stdio: "pipe" });
  if (verify.status !== 0) {
    throw new DeployError("DEPLOY_TUNNEL_BINARY_INVALID", "下载的 cloudflared 无法执行，请删除 bin/cloudflared 后重试或手动安装。");
  }
  return target;
}

export interface TunnelStatus {
  state: "disabled" | "starting" | "ready" | "error";
  publicBaseUrl: string | null;
  error: string | null;
  restartAttempts: number;
}

/**
 * Owns the cloudflared child process: spawns it, extracts the assigned hostname,
 * reports the URL, and restarts with backoff when the connection drops.
 */
export class TunnelProcessManager {
  private child: ChildProcess | null = null;
  private status: TunnelStatus = { state: "starting", publicBaseUrl: null, error: null, restartAttempts: 0 };
  private stopped = true;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly logPath: string;

  constructor(
    private readonly originPort: number,
    private readonly onStatusChange: (status: TunnelStatus) => void
  ) {
    const logDir = path.join(process.cwd(), "data", "deploy");
    mkdirSync(logDir, { recursive: true });
    this.logPath = path.join(logDir, "cloudflared.log");
  }

  getStatus(): TunnelStatus {
    return { ...this.status };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.spawnTunnel();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // already exited
      }
      this.child = null;
    }
  }

  private spawnTunnel(): void {
    if (this.stopped) return;
    let binary: string;
    try {
      binary = provisionCloudflared();
    } catch (error) {
      this.setStatus({ state: "error", publicBaseUrl: null, error: error instanceof Error ? error.message : "cloudflared 不可用", restartAttempts: this.status.restartAttempts });
      this.stopped = true;
      return;
    }
    const args = [
      "tunnel",
      "--url", "http://127.0.0.1:" + this.originPort,
      "--no-autoupdate",
      "--logfile", this.logPath,
      "--loglevel", "info",
    ];
    let child: ChildProcess;
    try {
      child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"], shell: false });
    } catch (error) {
      this.setStatus({ state: "error", publicBaseUrl: null, error: "无法启动 cloudflared：" + (error instanceof Error ? error.message : "未知错误"), restartAttempts: this.status.restartAttempts });
      this.stopped = true;
      return;
    }
    this.child = child;

    const scanText = (text: string): void => {
      if (this.stopped || this.status.publicBaseUrl) return;
      const match = text.match(TUNNEL_URL_PATTERN);
      if (match && match[0]) {
        this.setStatus({ state: "ready", publicBaseUrl: match[0].replace(/\/$/, ""), error: null, restartAttempts: this.status.restartAttempts });
      }
    };
    child.stderr?.on("data", (chunk: Buffer) => scanText(chunk.toString("utf8")));

    child.on("error", () => {
      // spawn failures land here; the close handler schedules the retry.
    });
    child.on("close", () => {
      if (this.child === child) this.child = null;
      // A tunnel that restarts gets a NEW random hostname: drop the stale URL so the
      // UI never shows a dead link.
      if (this.status.publicBaseUrl) {
        this.setStatus({ state: "starting", publicBaseUrl: null, error: null, restartAttempts: this.status.restartAttempts });
      }
      if (this.stopped) return;
      const attempts = this.status.restartAttempts + 1;
      if (attempts > MAX_RESTART_ATTEMPTS) {
        this.setStatus({ state: "error", publicBaseUrl: null, error: "公网隧道反复断开，已停止重试。请检查网络后重启服务。", restartAttempts: attempts });
        this.stopped = true;
        return;
      }
      const delayMs = Math.min(30_000, 2_000 * Math.pow(2, attempts - 1));
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.spawnTunnel();
      }, delayMs);
    });
  }

  private setStatus(next: TunnelStatus): void {
    this.status = { ...next };
    try {
      this.onStatusChange(this.getStatus());
    } catch {
      // listener errors must not break the tunnel loop
    }
  }
}

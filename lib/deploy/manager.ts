/**
 * Deploy manager: the server-side orchestrator for one-click deployments.
 *
 * A lazily-initialized singleton runtime (kept on globalThis so dev-mode route-bundle
 * recompilation never forks it) owns:
 *   - the deploy router (127.0.0.1 HTTP server, path + subdomain routing),
 *   - the cloudflared quick tunnel (public base URL, auto-restart),
 *   - a periodic sweeper (TTL expiry, orphan cleanup on startup).
 *
 * deployConversationApp() runs the whole pipeline synchronously for the caller:
 * bundle → public session → deploy bundle rewrite → container create/copy/start →
 * router registration. Every deployment is its own hardened container with its own
 * public dataset (records scoped by a deployment-specific appId).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getRepository } from "@/lib/db";
import type { DeploymentRow } from "@/lib/db/repository";
import type { QubitsManifest } from "@/lib/contracts/manifest";
import { buildDeployBundle, extractBundleHtml } from "./bundle";
import {
  allocateLoopbackPort,
  createDeploymentContainer,
  ensureDeployImage,
  listOrphanDeploymentContainers,
  removeContainer,
  startContainer,
  DEPLOY_CONTAINER_PREFIX,
} from "./docker";
import { DeployError } from "./errors";
import { createDeployRegistry, DEPLOY_DATA_API_PATH, DEPLOY_PATH_PREFIX, startDeployRouter, type DeployRegistry } from "./router";
import { TunnelProcessManager, type TunnelStatus } from "./tunnel";

// ── Config ──

export interface DeployConfig {
  enabled: boolean;
  publicTunnel: boolean;
  routerPort: number;
  ttlMs: number;
  maxDeployments: number;
  originPort: number;
  sweepIntervalMs: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readDeployConfig(): DeployConfig {
  const ttlHours = Number.parseFloat(process.env.DEPLOY_TTL_HOURS ?? "");
  return {
    enabled: (process.env.DEPLOY_ENABLED ?? "1") !== "0",
    publicTunnel: (process.env.DEPLOY_PUBLIC_TUNNEL ?? "1") !== "0",
    routerPort: parsePositiveInt(process.env.DEPLOY_ROUTER_PORT, 3100),
    ttlMs: Number.isFinite(ttlHours) && ttlHours > 0 ? Math.round(ttlHours * 3600_000) : 12 * 3600_000,
    maxDeployments: parsePositiveInt(process.env.DEPLOY_MAX_DEPLOYMENTS, 20),
    originPort: parsePositiveInt(process.env.DEPLOY_ORIGIN_PORT ?? process.env.PORT, 3000),
    sweepIntervalMs: 60_000,
  };
}

// ── Runtime singleton ──

export interface DeployRuntimeStatus {
  state: "stopped" | "starting" | "ready" | "error";
  initError: string | null;
  routerPort: number | null;
  publicBaseUrl: string | null;
  localBaseUrl: string | null;
  tunnel: TunnelStatus | null;
  liveDeploymentIds: string[];
}

interface DeployRuntime {
  state: "stopped" | "starting" | "ready" | "error";
  initError: string | null;
  registry: DeployRegistry;
  routerPort: number | null;
  tunnel: TunnelProcessManager | null;
  tunnelStatus: TunnelStatus | null;
  sweeper: ReturnType<typeof setInterval> | null;
  initPromise: Promise<DeployRuntime> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __QUBITS_DEPLOY_RUNTIME__: DeployRuntime | undefined;
}

function runtime(): DeployRuntime {
  if (!globalThis.__QUBITS_DEPLOY_RUNTIME__) {
    globalThis.__QUBITS_DEPLOY_RUNTIME__ = {
      state: "stopped",
      initError: null,
      registry: createDeployRegistry(),
      routerPort: null,
      tunnel: null,
      tunnelStatus: null,
      sweeper: null,
      initPromise: null,
    };
  }
  return globalThis.__QUBITS_DEPLOY_RUNTIME__;
}

export function getDeployRuntimeStatus(): DeployRuntimeStatus {
  const rt = runtime();
  const localBase = rt.routerPort ? "http://127.0.0.1:" + rt.routerPort : null;
  return {
    state: rt.state,
    initError: rt.initError,
    routerPort: rt.routerPort,
    publicBaseUrl: rt.tunnelStatus?.publicBaseUrl ?? null,
    localBaseUrl: localBase,
    tunnel: rt.tunnelStatus,
    liveDeploymentIds: Array.from(rt.registry.routes.keys()),
  };
}

export function deploymentPublicUrl(deploymentId: string): string | null {
  const status = getDeployRuntimeStatus();
  if (!status.routerPort) return null;
  const base = status.publicBaseUrl ?? status.localBaseUrl;
  return base ? base + DEPLOY_PATH_PREFIX + deploymentId + "/" : null;
}

function publicTunnelDisabled(): boolean {
  return (process.env.DEPLOY_PUBLIC_TUNNEL ?? "1") === "0";
}

/**
 * Startup sweep: previous server sessions left containers behind (and their tunnel
 * hostname is dead), so every still-live deployment row is expired and every leftover
 * container is removed. Deployments are session-scoped by design.
 */
function cleanupStaleDeployments(): void {
  const repo = getRepository();
  const now = Date.now();
  for (const row of repo.listDeploymentsByStatus("live")) {
    repo.updateDeployment(row.id, { status: "expired", stoppedAt: now, errorMessage: null, errorCode: null });
    if (row.containerName) removeContainer(row.containerName);
  }
  for (const row of repo.listDeploymentsByStatus("starting")) {
    repo.updateDeployment(row.id, { status: "failed", stoppedAt: now, errorCode: "DEPLOY_INTERRUPTED", errorMessage: "服务重启中断了部署，请重新上线" });
    if (row.containerName) removeContainer(row.containerName);
  }
  for (const containerId of listOrphanDeploymentContainers()) {
    removeContainer(containerId);
  }
}

/** TTL sweeper: stop expired live deployments; fail stuck starting ones; prune sessions. */
export function sweepDeployments(): void {
  const repo = getRepository();
  const now = Date.now();
  for (const row of repo.listDeploymentsByStatus("live")) {
    if (row.expiresAt <= now) {
      runtime().registry.routes.delete(row.id);
      if (row.containerName) removeContainer(row.containerName);
      if (row.sessionId) repo.deleteSession(row.sessionId);
      repo.updateDeployment(row.id, { status: "expired", stoppedAt: now });
    }
  }
  for (const row of repo.listDeploymentsByStatus("starting")) {
    if (row.createdAt <= now - 10 * 60_000) {
      if (row.containerName) removeContainer(row.containerName);
      repo.updateDeployment(row.id, { status: "failed", stoppedAt: now, errorCode: "DEPLOY_TIMEOUT", errorMessage: "部署启动超时" });
    }
  }
  repo.deleteExpiredSessions(now);
}

/** Ensure the deploy runtime (router + tunnel + sweeper) is up; idempotent across calls. */
export function ensureDeployRuntime(): Promise<DeployRuntime> {
  const rt = runtime();
  const config = readDeployConfig();
  if (!config.enabled) {
    throw new DeployError("DEPLOY_DISABLED", "一键上线功能已关闭（DEPLOY_ENABLED=0）");
  }
  if (rt.state === "ready" || rt.state === "starting") return rt.initPromise ?? Promise.resolve(rt);
  rt.state = "starting";
  rt.initError = null;
  rt.initPromise = (async () => {
    try {
      cleanupStaleDeployments();
      const handle = await startDeployRouter({
        port: config.routerPort,
        registry: rt.registry,
        originPort: config.originPort,
        getPublicBase: () => rt.tunnelStatus?.publicBaseUrl ?? null,
      });
      rt.routerPort = handle.port;
      if (!publicTunnelDisabled()) {
        rt.tunnel = new TunnelProcessManager(handle.port, (status) => {
          rt.tunnelStatus = status;
        });
        rt.tunnelStatus = rt.tunnel.getStatus();
        rt.tunnel.start();
      } else {
        rt.tunnelStatus = { state: "disabled", publicBaseUrl: null, error: null, restartAttempts: 0 };
      }
      rt.sweeper = setInterval(() => sweepDeployments(), config.sweepIntervalMs);
      rt.sweeper.unref?.();
      process.once("exit", () => {
        try {
          rt.tunnel?.stop();
        } catch {
          // best-effort shutdown
        }
      });
      rt.state = "ready";
      return rt;
    } catch (error) {
      rt.state = "error";
      rt.initError = error instanceof Error ? error.message : "部署运行时启动失败";
      rt.initPromise = null;
      throw error;
    }
  })();
  return rt.initPromise;
}

/** Wait for the tunnel to settle (ready / disabled / error) within timeoutMs. */
async function waitForTunnel(timeoutMs: number): Promise<TunnelStatus> {
  const started = Date.now();
  for (;;) {
    const status = runtime().tunnelStatus;
    if (status && (status.state === "ready" || status.state === "disabled" || status.state === "error")) {
      return status;
    }
    if (Date.now() - started >= timeoutMs) {
      return { state: "starting", publicBaseUrl: null, error: "公网隧道仍在启动中", restartAttempts: 0 };
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

// ── Deploy / stop ──

export interface DeployAppInput {
  projectId: string;
  conversationId: string;
  manifest: QubitsManifest;
  previewBundleArtifactId: string;
}

export interface DeployResult {
  deployment: DeploymentRow;
  url: string;
}

function deploymentBundleDir(deploymentId: string): string {
  return path.join(process.cwd(), "data", "deployments", deploymentId);
}

/** If a previous tunnel attempt failed (e.g. transient download error), retry once per deploy. */
function ensureTunnelRunning(rt: DeployRuntime): void {
  const config = readDeployConfig();
  if (!config.publicTunnel || !rt.tunnel) return;
  const status = rt.tunnel.getStatus();
  if (status.state === "error") {
    rt.tunnel.start();
  }
}

/** One-click deploy: bundle → session → container → router. Blocks until ready. */
export async function deployConversationApp(input: DeployAppInput): Promise<DeployResult> {
  const config = readDeployConfig();
  const rt = await ensureDeployRuntime();
  ensureTunnelRunning(rt);
  const repo = getRepository();

  if (repo.countLiveDeployments() >= config.maxDeployments) {
    throw new DeployError("DEPLOY_LIMIT_REACHED", "在线部署数量已达上限（" + config.maxDeployments + "），请先下线部分应用。");
  }

  const artifact = repo.getArtifact(input.previewBundleArtifactId);
  if (!artifact || artifact.projectId !== input.projectId || artifact.kind !== "preview_bundle") {
    throw new DeployError("DEPLOY_NO_BUNDLE", "当前对话还没有可上线的应用，请先生成一版。");
  }
  const html = extractBundleHtml(artifact.content);
  if (!html) {
    throw new DeployError("DEPLOY_NO_BUNDLE", "预览产物内容缺失或已损坏，请重新生成。");
  }

  const deploymentId = "dep-" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const containerName = DEPLOY_CONTAINER_PREFIX + deploymentId;
  const expiresAt = Date.now() + config.ttlMs;

  repo.createDeployment({
    id: deploymentId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    status: "starting",
    sessionId: null,
    containerName: null,
    port: null,
    bundleArtifactId: artifact.id,
    expiresAt,
  });

  let port: number | null = null;
  try {
    // Public sandbox session: visitors share one dataset scoped to this deployment.
    const sessionId = "sess-" + crypto.randomUUID();
    const session = repo.createSession({
      id: sessionId,
      projectId: input.projectId,
      appId: deploymentId,
      appVersion: 1,
      collectionsJson: JSON.stringify(input.manifest.collections),
      expiresAt,
    });

    // Rewrite the preview bundle for public serving (deploy CSP + embedded host bridge).
    const deployHtml = buildDeployBundle(html, {
      deploymentId,
      sessionId: session.id,
      apiBase: DEPLOY_DATA_API_PATH,
      appName: input.manifest.name,
      appVersion: 1,
    });
    const bundleDir = deploymentBundleDir(deploymentId);
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(path.join(bundleDir, "index.html"), deployHtml, "utf8");

    // Container: create (hardened, bundle dir bind-mounted read-only into /srv/www) → start.
    ensureDeployImage();
    port = await allocateLoopbackPort();
    createDeploymentContainer(deploymentId, containerName, port, bundleDir);
    startContainer(containerName);

    // Register with the router and flip to live.
    rt.registry.routes.set(deploymentId, { deploymentId, containerPort: port, name: input.manifest.name });
    repo.updateDeployment(deploymentId, { status: "live", sessionId: session.id, containerName, port });

    // One conversation keeps at most one live deployment: stop the previous ones.
    for (const other of repo.listDeploymentsByConversation(input.conversationId)) {
      if (other.id !== deploymentId && other.status === "live") {
        rt.registry.routes.delete(other.id);
        if (other.containerName) removeContainer(other.containerName);
        repo.updateDeployment(other.id, { status: "stopped", stoppedAt: Date.now() });
      }
    }

    const tunnel = config.publicTunnel ? await waitForTunnel(90_000) : { state: "disabled" as const };
    if (tunnel.state === "error") {
      throw new DeployError("DEPLOY_TUNNEL_ERROR", "公网隧道不可用：" + (tunnel.error ?? "未知错误"));
    }
    if (tunnel.state === "starting") {
      throw new DeployError("DEPLOY_TUNNEL_TIMEOUT", "公网隧道启动超时，请稍后重试。");
    }

    const url = deploymentPublicUrl(deploymentId);
    if (!url) {
      throw new DeployError("DEPLOY_ROUTER_UNAVAILABLE", "部署路由不可用，请稍后重试。");
    }
    const row = repo.getDeployment(deploymentId);
    if (!row) throw new DeployError("DEPLOY_FAILED", "部署状态丢失，请重试。");
    return { deployment: row, url };
  } catch (error) {
    // Fail closed: remove the container and mark the row failed.
    removeContainer(containerName);
    rt.registry.routes.delete(deploymentId);
    const message = error instanceof Error ? error.message : "部署失败";
    const code = error instanceof DeployError ? error.code : "DEPLOY_FAILED";
    repo.updateDeployment(deploymentId, {
      status: "failed",
      stoppedAt: Date.now(),
      errorCode: code,
      errorMessage: message.slice(0, 500),
    });
    throw error instanceof DeployError ? error : new DeployError(code, message.slice(0, 500));
  }
}

/** Take a deployment down (manual stop or expiry). Idempotent. */
export function stopDeployment(deploymentId: string): void {
  const repo = getRepository();
  const row = repo.getDeployment(deploymentId);
  if (!row) {
    throw new DeployError("DEPLOYMENT_NOT_FOUND", "部署不存在或已删除");
  }
  const rt = runtime();
  rt.registry.routes.delete(deploymentId);
  if (row.containerName) removeContainer(row.containerName);
  if (row.status === "live" || row.status === "starting") {
    repo.updateDeployment(deploymentId, { status: "stopped", stoppedAt: Date.now() });
  }
}

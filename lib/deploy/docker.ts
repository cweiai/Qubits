/**
 * Deployment container manager: every deployed app runs inside its own Docker
 * container serving a single static HTML document.
 *
 * Image: `qubits-deploy-web:latest`, built once from a pinned node alpine base plus a
 * tiny (~40 line) dependency-free static file server (no npm install, no network
 * needed by the container). The deployment's bundle directory is bind-mounted
 * read-only into /srv/www.
 *
 * Hardening matches the workspace sandbox philosophy: cap-drop ALL,
 * no-new-privileges, read-only root, non-root user, memory/cpu/pid limits, and the
 * port is published on 127.0.0.1 only (the deploy router is the only way in).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DeployError } from "./errors";

export const DEPLOY_IMAGE = "qubits-deploy-web:latest";
export const DEPLOY_CONTAINER_PREFIX = "qubits-deploy-";

const DOCKER_TIMEOUT_MS = 60_000;
const MAX_DOCKER_OUTPUT = 4000;

/** Tiny dependency-free static server baked into the deploy image (ES5-safe). */
const STATIC_SERVER_JS = `"use strict";
var http = require("http");
var fs = require("fs");
var path = require("path");
var ROOT = "/srv/www";
var PORT = 8080;
var TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2"
};
var COMMON_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
function sendIndex(res, status) {
  fs.readFile(path.join(ROOT, "index.html"), function (err, data) {
    if (err) { res.writeHead(status === 200 ? 404 : status, COMMON_HEADERS); res.end("not found"); return; }
    res.writeHead(status, Object.assign({ "Content-Type": TYPES[".html"] }, COMMON_HEADERS));
    res.end(data);
  });
}
var server = http.createServer(function (req, res) {
  var urlPath;
  try {
    urlPath = decodeURIComponent((req.url || "/").split("?")[0].split("#")[0]);
  } catch (e) {
    res.writeHead(400, COMMON_HEADERS); res.end("bad request"); return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, COMMON_HEADERS); res.end("method not allowed"); return;
  }
  if (urlPath === "/") { sendIndex(res, 200); return; }
  var filePath = path.normalize(path.join(ROOT, urlPath));
  if (filePath.slice(0, ROOT.length) !== ROOT) {
    res.writeHead(403, COMMON_HEADERS); res.end("forbidden"); return;
  }
  fs.stat(filePath, function (err, stat) {
    if (err || !stat.isFile()) { sendIndex(res, 200); return; } // SPA fallback
    fs.readFile(filePath, function (readErr, data) {
      if (readErr) { res.writeHead(500, COMMON_HEADERS); res.end("read error"); return; }
      var ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, Object.assign({ "Content-Type": TYPES[ext] || "application/octet-stream" }, COMMON_HEADERS));
      res.end(data);
    });
  });
});
server.listen(PORT, "0.0.0.0");
`;

const IMAGE_DOCKERFILE = `FROM {BASE_IMAGE}
COPY server.js /srv/server.js
EXPOSE 8080
CMD ["node", "/srv/server.js"]
`;

/** Prefer a locally available node alpine tag (offline-friendly); fall back to pinned. */
function resolveBaseImage(): string {
  for (const tag of ["node:24-alpine", "node:22-alpine", "node:alpine"]) {
    const inspect = runDocker(["image", "inspect", tag], 15000);
    if (inspect.ok) return tag;
  }
  return "node:24-alpine";
}

function buildImageDockerfile(): string {
  return IMAGE_DOCKERFILE.replace("{BASE_IMAGE}", resolveBaseImage());
}

interface DockerResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  spawnError: string | null;
}

function runDocker(args: string[], timeoutMs = DOCKER_TIMEOUT_MS): DockerResult {
  const result = spawnSync("docker", args, {
    timeout: timeoutMs,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return {
    ok: result.status === 0 && result.error === undefined,
    stdout: (result.stdout ?? "").slice(-MAX_DOCKER_OUTPUT),
    stderr: (result.stderr ?? "").slice(-MAX_DOCKER_OUTPUT),
    exitCode: result.status,
    spawnError: result.error ? String(result.error.message ?? result.error) : null,
  };
}

/** Fresh availability check: the Docker daemon must be reachable right now. */
export function dockerDaemonAvailable(): boolean {
  const result = runDocker(["version", "--format", "{{.Server.Version}}"], 8000);
  return result.ok;
}

function dockerUnavailableError(): DeployError {
  return new DeployError("DEPLOY_DOCKER_UNAVAILABLE", "Docker 不可用：部署应用需要本机 Docker 守护进程（容器隔离，无宿主回退）。");
}

/** Build the deployment image once if it does not exist yet. */
export function ensureDeployImage(): void {
  if (!dockerDaemonAvailable()) throw dockerUnavailableError();
  const inspect = runDocker(["image", "inspect", DEPLOY_IMAGE], 15000);
  if (inspect.ok) return;

  const contextDir = mkdtempSync(path.join(os.tmpdir(), "qubits-deploy-image-"));
  try {
    writeFileSync(path.join(contextDir, "Dockerfile"), buildImageDockerfile(), "utf8");
    writeFileSync(path.join(contextDir, "server.js"), STATIC_SERVER_JS, "utf8");
    const build = runDocker(["build", "-t", DEPLOY_IMAGE, contextDir], 120_000);
    if (!build.ok) {
      const detail = (build.stderr || build.stdout || build.spawnError || "").split("\n").slice(-8).join("\n");
      throw new DeployError(
        "DEPLOY_IMAGE_BUILD_FAILED",
        "部署镜像构建失败（如 Docker Hub 不可达，可先执行 docker pull docker.m.daocloud.io/library/node:24-alpine && docker tag docker.m.daocloud.io/library/node:24-alpine node:24-alpine）：" +
          detail.slice(0, 500)
      );
    }
  } finally {
    rmSync(contextDir, { recursive: true, force: true });
  }
}

/** Allocate a free loopback port for a deployment container. */
export async function allocateLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => reject(error));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new DeployError("DEPLOY_PORT_ALLOC_FAILED", "无法分配部署端口")));
      }
    });
  });
}

/** Create (not start) a hardened container for one deployment. */
export function createDeploymentContainer(deploymentId: string, containerName: string, port: number, bundleDir: string): void {
  if (!dockerDaemonAvailable()) throw dockerUnavailableError();
  const create = runDocker(
    [
      "create",
      "--name", containerName,
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--read-only",
      "--memory", "64m",
      "--cpus", "0.5",
      "--pids-limit", "64",
      "--user", "10001:10001",
      "--tmpfs", "/tmp:rw,size=8m,noexec",
      "--mount", "type=bind,src=" + bundleDir + ",dst=/srv/www,readonly",
      "--publish", "127.0.0.1:" + port + ":8080",
      "--label", "qubits.deployment=" + deploymentId,
      DEPLOY_IMAGE,
    ],
    30000
  );
  if (!create.ok) {
    const detail = (create.stderr || create.stdout || create.spawnError || "").split("\n").slice(-5).join("\n");
    throw new DeployError("DEPLOY_CONTAINER_CREATE_FAILED", "部署容器创建失败：" + detail.slice(0, 600));
  }
}

export function startContainer(containerName: string): void {
  const start = runDocker(["start", containerName], 30000);
  if (!start.ok) {
    const detail = (start.stderr || start.stdout || start.spawnError || "").split("\n").slice(-5).join("\n");
    throw new DeployError("DEPLOY_CONTAINER_START_FAILED", "部署容器启动失败：" + detail.slice(0, 600));
  }
}

/** Force-remove a deployment container (running or stopped). Never throws on absence. */
export function removeContainer(containerName: string): void {
  runDocker(["rm", "-f", containerName], 30000);
}

/** List container ids of leftover deployments (e.g. from a crashed previous run). */
export function listOrphanDeploymentContainers(): string[] {
  if (!dockerDaemonAvailable()) return [];
  const result = runDocker(["ps", "-aq", "--filter", "name=" + DEPLOY_CONTAINER_PREFIX], 15000);
  if (!result.ok) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

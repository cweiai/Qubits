/**
 * Deploy router: the single HTTP entry point behind the public tunnel.
 *
 * Routing (in order):
 *   Host `<deploymentId>.<anything>`        → that deployment's container (opportunistic
 *                                             subdomain routing, works with quick tunnels)
 *   `GET /`                                → landing page listing live deployments
 *   `GET /d/<deploymentId>/...`            → that deployment's container (path routing,
 *                                             the guaranteed form used by shared links)
 *   `POST /api/deploy/data`                → forwarded to the Qubits origin server
 *                                             (public deployment data API)
 *
 * The router binds 127.0.0.1 only; the public internet reaches it exclusively through
 * the cloudflared quick tunnel. Deployment containers publish their ports on 127.0.0.1
 * as well, so the router is the only way in.
 */

import http from "node:http";
import { DeployError } from "./errors";

export const DEPLOY_PATH_PREFIX = "/d/";
export const DEPLOY_DATA_API_PATH = "/api/deploy/data";
export const DEPLOYMENT_ID_PATTERN = /^dep-[a-z0-9-]{8,64}$/;

export interface DeployRoute {
  deploymentId: string;
  containerPort: number;
  name: string;
}

export interface DeployRegistry {
  routes: Map<string, DeployRoute>;
}

export function createDeployRegistry(): DeployRegistry {
  return { routes: new Map() };
}

export type RouteDecision =
  | { kind: "deployment"; deploymentId: string; restPath: string }
  | { kind: "deploy-data-api" }
  | { kind: "landing" }
  | { kind: "not-found" };

/** Pure routing decision — unit-testable without any socket. */
export function decideRoute(pathname: string, knownDeploymentIds: Set<string>): RouteDecision {
  if (pathname === "/" || pathname === "/index.html") return { kind: "landing" };
  if (pathname === DEPLOY_DATA_API_PATH) return { kind: "deploy-data-api" };
  if (pathname.startsWith(DEPLOY_PATH_PREFIX)) {
    const rest = pathname.slice(DEPLOY_PATH_PREFIX.length);
    const slash = rest.indexOf("/");
    const id = slash === -1 ? rest : rest.slice(0, slash);
    if (DEPLOYMENT_ID_PATTERN.test(id) && knownDeploymentIds.has(id)) {
      return { kind: "deployment", deploymentId: id, restPath: slash === -1 ? "/" : rest.slice(slash) };
    }
  }
  return { kind: "not-found" };
}

/** Subdomain host routing: `dep-xxx.trycloudflare.com` → deployment `dep-xxx`. */
export function deploymentIdFromHost(hostname: string): string | null {
  const match = /^dep-[a-z0-9-]{8,64}\./.exec(hostname);
  if (!match) return null;
  return match[0].slice(0, -1);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sendText(res: http.ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
  res.end(body);
}

/** Streaming HTTP proxy to a loopback target, with security headers for deployments. */
function proxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targetPort: number,
  targetPath: string,
  deploymentResponse: boolean
): void {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (key === "host" || key === "connection" || key === "keep-alive" || key === "upgrade" || key === "transfer-encoding") continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  if (deploymentResponse) {
    headers["X-Frame-Options"] = "DENY";
    headers["Content-Security-Policy"] = "frame-ancestors 'none'";
    headers["X-Content-Type-Options"] = "nosniff";
    headers["Referrer-Policy"] = "no-referrer";
  }
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: targetPort,
      path: targetPath,
      method: req.method ?? "GET",
      headers,
    },
    (upstreamRes) => {
      const responseHeaders: Record<string, string | number> = { "Cache-Control": "no-store" };
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value == null || key === "connection" || key === "keep-alive" || key === "transfer-encoding") continue;
        responseHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      upstreamRes.pipe(res);
    }
  );
  upstream.on("error", () => {
    if (!res.headersSent) {
      sendText(res, 502, "text/plain; charset=utf-8", "deployment upstream unavailable");
    } else {
      res.destroy();
    }
  });
  req.pipe(upstream);
}

export interface DeployRouterHandle {
  server: http.Server;
  port: number;
}

/**
 * Start the deploy router. `registry` is shared by reference with the deploy manager,
 * `originPort` is the Qubits Next server port (for the public data API forward), and
 * `getPublicBase` supplies the current tunnel base for the landing page.
 */
export function startDeployRouter(options: {
  port: number;
  registry: DeployRegistry;
  originPort: number;
  getPublicBase: () => string | null;
}): Promise<DeployRouterHandle> {
  const { registry, originPort, getPublicBase } = options;

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = url.pathname;

      // 1) Subdomain host routing (opportunistic).
      const hostname = (req.headers.host ?? "").split(":")[0]?.toLowerCase() ?? "";
      const hostDeploymentId = deploymentIdFromHost(hostname);
      if (hostDeploymentId && registry.routes.has(hostDeploymentId)) {
        proxyRequest(req, res, registry.routes.get(hostDeploymentId)!.containerPort, pathname === "" ? "/" : pathname, true);
        return;
      }

      // 2) Path routing.
      const decision = decideRoute(pathname, new Set(registry.routes.keys()));
      switch (decision.kind) {
        case "deployment": {
          const route = registry.routes.get(decision.deploymentId);
          if (!route) {
            sendText(res, 404, "text/plain; charset=utf-8", "deployment not found");
            return;
          }
          proxyRequest(req, res, route.containerPort, decision.restPath, true);
          return;
        }
        case "deploy-data-api": {
          if (req.method !== "POST") {
            sendText(res, 405, "text/plain; charset=utf-8", "method not allowed");
            return;
          }
          proxyRequest(req, res, originPort, DEPLOY_DATA_API_PATH, false);
          return;
        }
        case "landing": {
          const publicBase = getPublicBase();
          const entries = Array.from(registry.routes.values());
          const rows = entries
            .map((route) => {
              const pathUrl = publicBase ? publicBase + DEPLOY_PATH_PREFIX + route.deploymentId + "/" : "http://127.0.0.1:" + options.port + DEPLOY_PATH_PREFIX + route.deploymentId + "/";
              return '<li><a href="' + escapeHtml(pathUrl) + '">' + escapeHtml(route.name || route.deploymentId) + "</a></li>";
            })
            .join("");
          const html =
            "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Qubits Deployments</title></head><body style=\"font-family:system-ui,sans-serif;padding:24px\"><h1>Qubits 部署</h1>" +
            (rows
              ? "<ul>" + rows + "</ul>"
              : "<p>暂无在线部署。</p>") +
            "</body></html>";
          sendText(res, 200, "text/html; charset=utf-8", html);
          return;
        }
        case "not-found":
          sendText(res, 404, "text/plain; charset=utf-8", "not found");
          return;
      }
    } catch {
      if (!res.headersSent) sendText(res, 500, "text/plain; charset=utf-8", "internal error");
      else res.destroy();
    }
  });

  return new Promise<DeployRouterHandle>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(new DeployError("DEPLOY_ROUTER_BIND_FAILED", "部署路由启动失败：" + error.message));
    };
    const onListening = () => {
      server.removeListener("error", onError);
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : options.port;
      resolve({ server, port });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, "127.0.0.1");
  });
}

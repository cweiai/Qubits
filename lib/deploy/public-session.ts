import type { AppRepository, DeploymentRow, SessionRow } from "@/lib/db/repository";
import { parseSessionCollections, SandboxError } from "@/lib/db/sandbox-data";
import type { CollectionSpec } from "@/lib/contracts/app-spec";

/**
 * Public deployment sessions: visitors of a deployed app carry no project cookie, so
 * the normal cookie-scoped `resolveSession` cannot authorize them. Instead the session
 * is bound to a live deployment row: the client must present the deploymentId AND the
 * opaque sessionId that were baked into its bundle, and both must match a live,
 * unexpired deployment. Everything else (collections, operations, queries, payloads)
 * is re-validated by the shared sandbox-data handlers exactly like preview requests.
 */

export interface ResolvedDeploymentSession {
  deployment: DeploymentRow;
  session: SessionRow;
  collections: CollectionSpec[];
}

export function resolveDeploymentSession(
  repo: AppRepository,
  deploymentId: string,
  sessionId: string
): ResolvedDeploymentSession {
  const deployment = repo.getDeployment(deploymentId);
  if (!deployment || deployment.status !== "live") {
    throw new SandboxError("SESSION_NOT_FOUND", "部署不存在或已下线", 404);
  }
  if (deployment.expiresAt <= Date.now()) {
    throw new SandboxError("SESSION_EXPIRED", "部署已到期，链接已失效", 401);
  }
  if (!deployment.sessionId || deployment.sessionId !== sessionId) {
    throw new SandboxError("SESSION_NOT_FOUND", "部署会话不存在或已失效", 404);
  }
  const session = repo.getSession(sessionId);
  if (!session || session.projectId !== deployment.projectId) {
    throw new SandboxError("SESSION_NOT_FOUND", "部署会话不存在或已失效", 404);
  }
  const collections = parseSessionCollections(session);
  return { deployment, session, collections };
}

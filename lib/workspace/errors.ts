import "server-only";

/**
 * Stable workspace/build error codes. The most specific code wins: a build failure is
 * never masked by a generic aborted/interrupted message, and tool errors never leak
 * stacks, host paths, or credentials.
 */

export type WorkspaceErrorCode =
  | "WORKSPACE_NOT_INITIALIZED"
  | "WORKSPACE_EXISTS"
  | "INVALID_MANIFEST"
  | "INVALID_DEPENDENCY"
  | "DEPENDENCY_UNAVAILABLE"
  | "BUILD_FAILED"
  | "TYPECHECK_FAILED"
  | "LINT_FAILED"
  | "TEST_FAILED"
  | "FORMAT_FAILED"
  | "SECURITY_BLOCKED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "CLIENT_ABORTED"
  | "USER_ABORTED"
  | "PREVIEW_FAILED"
  | "PREVIEW_NOT_AVAILABLE"
  | "SNAPSHOT_NOT_FOUND"
  | "PATH_ESCAPE"
  | "NOT_FOUND"
  | "WORKSPACE_ERROR";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly retryable: boolean;
  constructor(code: WorkspaceErrorCode, message: string, retryable = true) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** Redact host paths and credential-looking values from tool/log output. */
const SECRET_VALUE = /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}|api[_-]?key[=:]\s*[^\s"']{6,})/gi;

export function redactHostText(text: string, workspaceDir?: string, extraSecrets: string[] = []): string {
  let out = text;
  const cwd = process.cwd();
  if (workspaceDir) out = out.split(workspaceDir).join("<workspace>");
  out = out.split(cwd).join("<host>");
  // Absolute POSIX paths that are neither workspace nor host root.
  out = out.replace(/(?:\/Users\/[^\s"'`<>]*)/g, "<path>");
  out = out.replace(/(?:[A-Za-z]:\\[^\s"'`<>]*)/g, "<path>");
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join("***");
  }
  out = out.replace(SECRET_VALUE, "***");
  return out;
}

export function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));
}

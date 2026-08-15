/**
 * Deploy infrastructure error: stable { code, message } surfaced to the UI as-is.
 * Infrastructure modules throw DeployError; the API routes translate it to ApiError.
 */

export class DeployError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DeployError";
    this.code = code;
  }
}

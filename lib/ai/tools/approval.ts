import "server-only";
import type { ToolExecutionContext } from "./types";
import { ToolExecutionError } from "./types";
import { getRepository } from "@/lib/db";

/**
 * Approval: high-risk tools (filesystem deletion and destructive data operations)
 * must first be authorized by a durable user decision. Pending requests are stored in
 * SQLite and polled by the active Agent; missing, denied, expired, or aborted decisions
 * all fail closed.
 */
const APPROVAL_TTL_MS = 5 * 60 * 1000;

export function createApproval(runId: string, toolName: string, options: { projectId?: string | null; taskId?: string | null; toolCallId?: string | null; reason?: string } = {}): string {
  const approvalId = "apv-" + crypto.randomUUID();
  getRepository().createApproval({
    id: approvalId,
    projectId: options.projectId ?? null,
    taskId: options.taskId ?? null,
    toolCallId: options.toolCallId ?? null,
    runId,
    toolName,
    reason: (options.reason ?? "高风险工具需要用户明确批准").slice(0, 400),
    expiresAt: Date.now() + APPROVAL_TTL_MS,
  });
  return approvalId;
}

export function grantApproval(approvalId: string): ReturnType<ReturnType<typeof getRepository>["resolveApproval"]> {
  return getRepository().resolveApproval(approvalId, "granted", "user");
}

export function denyApproval(approvalId: string): ReturnType<ReturnType<typeof getRepository>["resolveApproval"]> {
  return getRepository().resolveApproval(approvalId, "denied", "user");
}

export function resetApprovalsForTests(): void {
  getRepository().clearApprovalsForTests();
}

export function isApproved(runId: string, toolName: string): boolean {
  return getRepository().getLatestApproval(runId, toolName)?.status === "granted";
}

export async function waitForApproval(approvalId: string, signal: AbortSignal, timeoutMs = APPROVAL_TTL_MS): Promise<"granted"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) {
      const error = new Error("审批等待已取消");
      error.name = "AbortError";
      throw error;
    }
    const approval = getRepository().getApproval(approvalId);
    if (!approval) throw new ToolExecutionError("APPROVAL_NOT_FOUND", "审批请求不存在", false);
    if (approval.status === "granted") return "granted";
    if (approval.status === "denied") throw new ToolExecutionError("APPROVAL_DENIED", "用户拒绝了该高风险操作", false);
    if (approval.status === "expired") throw new ToolExecutionError("APPROVAL_EXPIRED", "审批已过期，操作被拒绝", false);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  throw new ToolExecutionError("APPROVAL_EXPIRED", "审批等待超时，操作被拒绝", false);
}

export function assertApproved(context: ToolExecutionContext, toolName: string): void {
  if (context.approvedTools.has(toolName) || isApproved(context.runId, toolName)) return;
  throw new ToolExecutionError("APPROVAL_REQUIRED", "工具 " + toolName + " 需要用户审批", true);
}

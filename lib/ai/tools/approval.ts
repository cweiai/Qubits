import "server-only";
import type { ServerToolDefinition, ToolExecutionContext } from "./types";
import { ToolExecutionError } from "./types";
import { requestApprovalArgsSchema, requestApprovalResultSchema } from "./schemas";

/**
 * Approval: high-risk tools (fs_delete/delete_record/run_migration etc.)
 * must first be authorized via request_user_approval or execution returns APPROVAL_REQUIRED.
 * Grants are isolated per runId in a server-side in-memory ApprovalStore.
 */

interface ApprovalGrant {
  approvalId: string;
  runId: string;
  toolName: string;
  grantedAt: number;
}

const grants = new Map<string, ApprovalGrant>();

export function createApproval(runId: string, toolName: string): string {
  const approvalId = "apv-" + crypto.randomUUID();
  grants.set(approvalId, { approvalId, runId, toolName, grantedAt: 0 });
  return approvalId;
}

export function grantApproval(approvalId: string): ApprovalGrant | null {
  const grant = grants.get(approvalId);
  if (!grant) return null;
  const updated = { ...grant, grantedAt: Date.now() };
  grants.set(approvalId, updated);
  return updated;
}

export function isApproved(runId: string, toolName: string): boolean {
  for (const grant of grants.values()) {
    if (grant.runId === runId && grant.toolName === toolName && grant.grantedAt > 0) return true;
  }
  return false;
}

export function resetApprovalsForTests(): void {
  grants.clear();
}

export const requestUserApprovalTool: ServerToolDefinition<{ toolName: string; reason: string }, { approvalId: string; toolName: string; status: "pending" | "granted" }> = {
  name: "request_user_approval",
  description: "为高风险工具申请用户审批（返回 approvalId，UI 展示审批对话框）。",
  argsSchema: requestApprovalArgsSchema,
  resultSchema: requestApprovalResultSchema,
  allowedRoles: ["team_leader", "engineer"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const approvalId = createApproval(context.runId, args.toolName);
    context.emit({
      type: "approval_requested",
      approvalId,
      toolCallId: "tc-approval",
      toolName: args.toolName,
      reason: args.reason.slice(0, 400),
    });
    const granted = isApproved(context.runId, args.toolName);
    return { approvalId, toolName: args.toolName, status: granted ? "granted" : "pending" };
  },
};

export function assertApproved(context: ToolExecutionContext, toolName: string): void {
  if (context.approvedTools.has(toolName) || isApproved(context.runId, toolName)) return;
  throw new ToolExecutionError("APPROVAL_REQUIRED", "工具 " + toolName + " 需要用户审批（请先调用 request_user_approval）", true);
}

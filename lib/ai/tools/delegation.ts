import "server-only";
import { z } from "zod";
import type { ArtifactKind, ServerToolDefinition } from "./types";
import { delegateToAgentArgsSchema, delegateToAgentResultSchema } from "./schemas";
import { SearchProviderError } from "./search-provider";

const DELEGATABLE_ROLES = ["product_manager", "researcher", "architect", "engineer", "data_scientist", "reviewer"] as const;

/** Server-enforced targetRole ↔ expectedOutput correspondence. */
const ROLE_OUTPUT_MAP: Record<string, string> = {
  product_manager: "product_brief",
  researcher: "research_report",
  architect: "app_blueprint",
  engineer: "code_workspace",
  data_scientist: "data_report",
  reviewer: "review_report",
};

/**
 * delegate_to_agent: the core tool for Mike to hand off to and assign child agents.
 * Only team_leader may call it (allowedRoles + executor double check); it runs a real
 * child-agent model call and returns the structured result as a tool message.
 */
export const delegateToAgentTool: ServerToolDefinition<z.infer<typeof delegateToAgentArgsSchema>, z.infer<typeof delegateToAgentResultSchema>> = {
  name: "delegate_to_agent",
  description:
    "把任务分配给子 Agent（艾玛/鲍勃/亚历克斯/大卫/艾瑞斯/评审员）并等待其真实完成。子 Agent 通过自己的系统提示词与工具集合执行，结果以结构化产物返回。只有迈克可以调用。",
  argsSchema: delegateToAgentArgsSchema,
  resultSchema: delegateToAgentResultSchema,
  allowedRoles: ["team_leader"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    if (context.roleId !== "team_leader") {
      throw new SearchProviderError("FORBIDDEN_ROLE", "只有团队领队（迈克）可以委派子 Agent");
    }
    if (!DELEGATABLE_ROLES.includes(args.targetRole)) {
      throw new SearchProviderError("INVALID_ARGS", "目标角色不在委派 allowlist 中");
    }
    if (ROLE_OUTPUT_MAP[args.targetRole] !== args.expectedOutput) {
      throw new SearchProviderError(
        "INVALID_ARGS",
        "targetRole 与 expectedOutput 不匹配：" + args.targetRole + " 只能产出 " + ROLE_OUTPUT_MAP[args.targetRole] + "（收到 " + args.expectedOutput + "）"
      );
    }
    if (context.counters.childAgents >= 8) {
      throw new SearchProviderError("TOOL_BUDGET_EXCEEDED", "子 Agent 数量超出预算（8）");
    }
    if (context.depth >= 1) {
      throw new SearchProviderError("TOOL_BUDGET_EXCEEDED", "子 Agent 层级超过限制（depth=1）");
    }

    // resolve Mike's artifact references (untrusted ids: missing = error, never silently skipped)
    const inputArtifacts: Array<{ id: string; kind: ArtifactKind }> = [];
    for (const id of args.inputArtifactIds) {
      const ref = context.artifacts.getRef(id);
      if (!ref) {
        throw new SearchProviderError("ARTIFACT_NOT_FOUND", "输入 artifact 不存在：" + id);
      }
      inputArtifacts.push({ id: ref.id, kind: ref.kind });
    }

    const childAgentRunId = "agent-" + crypto.randomUUID();
    const delegationId = "dlg-" + crypto.randomUUID();
    context.counters.childAgents += 1;
    context.emit({
      type: "agent_delegated",
      delegationId,
      parentAgentRunId: context.parentAgentRunId!,
      childAgentRunId,
      targetRole: args.targetRole,
      taskSummary: args.task.slice(0, 300),
    });

    const result = await context.childAgentRunner({
      roleId: args.targetRole,
      task: args.task,
      expectedOutput: args.expectedOutput,
      inputArtifacts,
    });

    if (result.status === "completed") {
      context.emit({
        type: "agent_completed",
        agentRunId: childAgentRunId,
        roleId: args.targetRole,
        summary: result.summary.slice(0, 300),
        artifactId: result.artifactId ?? undefined,
      });
    } else {
      context.emit({
        type: "agent_failed",
        agentRunId: childAgentRunId,
        roleId: args.targetRole,
        message: result.summary.slice(0, 300),
      });
    }

    // Expose the real run artifacts (build/test/preview) produced during this child run,
    // so Mike can reference them for render_preview — ids come from the ArtifactStore, never prose.
    const relatedArtifacts: Array<{ kind: string; artifactId: string }> = [];
    for (const kind of ["build_report", "preview_bundle", "test_report", "review_report"] as const) {
      const ref = context.artifacts.findLatest(kind);
      if (ref) relatedArtifacts.push({ kind, artifactId: ref.id });
    }

    return {
      delegationId,
      childAgentRunId,
      targetRole: args.targetRole,
      status: result.status,
      artifactId: result.artifactId,
      summary: result.summary.slice(0, 300),
      issues: result.issues.slice(0, 10),
      relatedArtifacts,
    };
  },
};

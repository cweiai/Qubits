import "server-only";
import { z } from "zod";
import type { ServerToolDefinition } from "./types";
import { ToolExecutionError } from "./types";
import {
  compareArtifactsArgsSchema, compareArtifactsResultSchema, createArtifactArgsSchema,
  createArtifactResultSchema, getArtifactArgsSchema, getArtifactResultSchema,
} from "./schemas";

/**
 * Artifact tools. FINAL deliverables (product_brief / research_report / app_blueprint /
 * code_workspace / build_report / test_report / review_report / preview_bundle /
 * data_report) are NEVER saved through create_artifact — the orchestrator persists
 * them exactly once after the child agent's finalSchema-validated structured output.
 * create_artifact exists only for intermediate "file" attachments and is Mike-only.
 */

export const createArtifactTool: ServerToolDefinition<z.infer<typeof createArtifactArgsSchema>, z.infer<typeof createArtifactResultSchema>> = {
  name: "create_artifact",
  description:
    "仅用于保存中间附件（kind 只能是 file，内容为纯文本）。最终交付物（product_brief/app_blueprint/code_workspace/review_report 等）由系统在子 Agent 输出通过校验后自动保存，严禁用本工具保存它们。",
  argsSchema: createArtifactArgsSchema,
  resultSchema: createArtifactResultSchema,
  allowedRoles: ["team_leader"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const ref = context.artifacts.put({
      kind: args.kind,
      createdBy: context.roleId,
      parentAgentRunId: context.parentAgentRunId,
      value: { name: args.name, content: args.content },
    });
    return { artifactId: ref.id };
  },
};

export const getArtifactTool: ServerToolDefinition<z.infer<typeof getArtifactArgsSchema>, z.infer<typeof getArtifactResultSchema>> = {
  name: "get_artifact",
  description: "读取当前 run 的 artifact 摘要（不返回完整内部内容）。",
  argsSchema: getArtifactArgsSchema,
  resultSchema: getArtifactResultSchema,
  allowedRoles: ["team_leader"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const ref = context.artifacts.getRef(args.artifactId);
    if (!ref) throw new ToolExecutionError("ARTIFACT_NOT_FOUND", "artifact 不存在或不属于当前 run", false);
    const value = context.artifacts.get(args.artifactId);
    let summary = "";
    try {
      summary = JSON.stringify(value).slice(0, 500);
    } catch {
      summary = "[不可序列化]";
    }
    return { artifactId: ref.id, kind: ref.kind, summary };
  },
};

export const compareArtifactsTool: ServerToolDefinition<z.infer<typeof compareArtifactsArgsSchema>, z.infer<typeof compareArtifactsResultSchema>> = {
  name: "compare_artifacts",
  description: "比较两个 artifact 的顶层差异。",
  argsSchema: compareArtifactsArgsSchema,
  resultSchema: compareArtifactsResultSchema,
  allowedRoles: ["team_leader"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const aRef = context.artifacts.getRef(args.aArtifactId);
    const bRef = context.artifacts.getRef(args.bArtifactId);
    if (!aRef || !bRef) throw new ToolExecutionError("ARTIFACT_NOT_FOUND", "artifact 不存在", false);
    const a = context.artifacts.get(args.aArtifactId);
    const b = context.artifacts.get(args.bArtifactId);
    const changedKeys: string[] = [];
    if (a && b && typeof a === "object" && typeof b === "object") {
      const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
      for (const key of keys) {
        const av = (a as Record<string, unknown>)[key];
        const bv = (b as Record<string, unknown>)[key];
        if (JSON.stringify(av) !== JSON.stringify(bv)) changedKeys.push(key.slice(0, 120));
      }
    }
    return { sameKind: aRef.kind === bRef.kind, changedKeys: changedKeys.slice(0, 30) };
  },
};

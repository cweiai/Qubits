import "server-only";
import type { ArtifactKind, ServerToolDefinition } from "./types";
import { ToolExecutionError } from "./types";
import {
  compareArtifactsArgsSchema, compareArtifactsResultSchema, createArtifactArgsSchema,
  createArtifactResultSchema, getArtifactArgsSchema, getArtifactResultSchema,
} from "./schemas";

export const createArtifactTool: ServerToolDefinition<{ kind: ArtifactKind; name: string; content?: unknown }, { artifactId: string }> = {
  name: "create_artifact",
  description: "把结构化内容保存为当前 run 的 artifact。",
  argsSchema: createArtifactArgsSchema,
  resultSchema: createArtifactResultSchema,
  allowedRoles: ["team_leader", "architect", "engineer", "data_scientist"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const ref = context.artifacts.put({ kind: args.kind, createdBy: context.roleId, parentAgentRunId: context.parentAgentRunId, value: args.content ?? null });
    return { artifactId: ref.id };
  },
};

export const getArtifactTool: ServerToolDefinition<{ artifactId: string }, { artifactId: string; kind: string; summary: string }> = {
  name: "get_artifact",
  description: "读取当前 run 的 artifact 摘要（不返回完整内部内容）。",
  argsSchema: getArtifactArgsSchema,
  resultSchema: getArtifactResultSchema,
  allowedRoles: ["team_leader", "product_manager", "architect", "engineer", "data_scientist", "reviewer"],
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

export const compareArtifactsTool: ServerToolDefinition<{ aArtifactId: string; bArtifactId: string }, { sameKind: boolean; changedKeys: string[] }> = {
  name: "compare_artifacts",
  description: "比较两个 artifact 的顶层差异。",
  argsSchema: compareArtifactsArgsSchema,
  resultSchema: compareArtifactsResultSchema,
  allowedRoles: ["team_leader", "engineer", "reviewer"],
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

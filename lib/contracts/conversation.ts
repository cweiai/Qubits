import { z } from "zod";
import { roleIdSchema } from "./agent-events";

export const roleStatusSchema = z.enum(["pending", "running", "success", "error"]);
export type RoleStatus = z.infer<typeof roleStatusSchema>;

const messageTypeSchema = z.enum([
  "user",
  "team_leader",
  "product_manager",
  "researcher",
  "architect",
  "engineer",
  "data_scientist",
  "reviewer",
  "security_reviewer",
  "system",
  "error",
]);
export const conversationMessageSchema = z.object({
  id: z.string(),
  type: messageTypeSchema,
  runId: z.string().nullable().default(null),
  roleId: roleIdSchema.nullable().default(null),
  text: z.string(),
  artifact: z.unknown().nullable().default(null),
  status: roleStatusSchema.nullable().default(null),
  timestamp: z.number(),
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const roleStateSchema = z.object({
  status: roleStatusSchema,
  summary: z.string().nullable().default(null),
  startedAt: z.number().nullable().default(null),
  completedAt: z.number().nullable().default(null),
});
export type RoleState = z.infer<typeof roleStateSchema>;

export const pipelineStageSchema = z.enum([
  "idle",
  "planning",
  "architecting",
  "coding",
  "validating",
  "reviewing",
  "previewing",
  "ready",
  "failed",
]);
export type PipelineStage = z.infer<typeof pipelineStageSchema>;

export const STAGE_LABELS: Record<PipelineStage, string> = {
  idle: "空闲",
  planning: "规划中",
  architecting: "架构设计中",
  coding: "编写代码中",
  validating: "构建验证中",
  reviewing: "安全审校中",
  previewing: "预览提交中",
  ready: "就绪",
  failed: "失败",
};

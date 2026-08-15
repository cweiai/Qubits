import "server-only";
import { z } from "zod";
import type { ServerToolDefinition } from "./types";
import { ToolExecutionError } from "./types";
import { migrationPlanResultSchema, notConfiguredResultSchema, publishResultSchema } from "./schemas";

/**
 * P2 release/migration/share tools: NOT_CONFIGURED implementations.
 * Never fake success when no real migration service, deploy platform, or git credentials are configured.
 */

export const createMigrationPlanTool: ServerToolDefinition<Record<string, never>, { available: false; provider: string; reason: string }> = {
  name: "create_migration_plan",
  description: "生成数据库迁移计划（未配置迁移服务时 NOT_CONFIGURED）。",
  argsSchema: z.object({}).strict(),
  resultSchema: migrationPlanResultSchema,
  allowedRoles: [],
  risk: "high",
  requiresApproval: false,
  async execute(_args, _context) {
    void _args;
    void _context;
    throw new ToolExecutionError("MIGRATION_NOT_CONFIGURED", "未配置迁移服务（MIGRATION_ADAPTER）", false);
  },
};

export const runMigrationTool: ServerToolDefinition<{ planId: string }, { available: false; provider: string; reason: string }> = {
  name: "run_migration",
  description: "执行已批准的迁移计划（需要审批；未配置时 NOT_CONFIGURED）。",
  argsSchema: z.object({ planId: z.string().min(1).max(64) }),
  resultSchema: migrationPlanResultSchema,
  allowedRoles: [],
  risk: "critical",
  requiresApproval: true,
  async execute(_args, _context) {
    void _args;
    void _context;
    throw new ToolExecutionError("MIGRATION_NOT_CONFIGURED", "未配置迁移服务（MIGRATION_ADAPTER）", false);
  },
};

export const publishPreviewTool: ServerToolDefinition<Record<string, never>, { available: false; provider: string; reason: string }> = {
  name: "publish_preview",
  description: "发布预览（需要审批；未配置部署平台时 NOT_CONFIGURED）。",
  argsSchema: z.object({}).strict(),
  resultSchema: publishResultSchema,
  allowedRoles: [],
  risk: "critical",
  requiresApproval: true,
  async execute(_args, _context) {
    void _args;
    void _context;
    throw new ToolExecutionError("PUBLISH_NOT_CONFIGURED", "未配置部署平台（PUBLISH_ADAPTER）", false);
  },
};

export const createShareLinkTool: ServerToolDefinition<Record<string, never>, { available: false; provider: string; reason: string }> = {
  name: "create_share_link",
  description: "创建分享链接（未配置时 NOT_CONFIGURED）。",
  argsSchema: z.object({}).strict(),
  resultSchema: notConfiguredResultSchema,
  allowedRoles: [],
  risk: "low",
  requiresApproval: false,
  async execute() {
    throw new ToolExecutionError("SHARE_NOT_CONFIGURED", "未配置分享服务（SHARE_ADAPTER）", false);
  },
};

export const rollbackReleaseTool: ServerToolDefinition<Record<string, never>, { available: false; provider: string; reason: string }> = {
  name: "rollback_release",
  description: "回滚发布（需要审批；未配置时 NOT_CONFIGURED）。",
  argsSchema: z.object({}).strict(),
  resultSchema: publishResultSchema,
  allowedRoles: [],
  risk: "critical",
  requiresApproval: true,
  async execute() {
    throw new ToolExecutionError("PUBLISH_NOT_CONFIGURED", "未配置部署平台（PUBLISH_ADAPTER）", false);
  },
};


import "server-only";
import type { ServerToolDefinition, ToolExecutionContext } from "./types";
import { ToolExecutionError } from "./types";
import {
  dataAggregateArgsSchema, dataAggregateResultSchema, dataCountArgsSchema, dataCountResultSchema,
  dataQueryArgsSchema, dataQueryResultSchema, recordCreateArgsSchema, recordCreateResultSchema,
  recordUpdateArgsSchema, recordUpdateResultSchema, recordDeleteArgsSchema, recordDeleteResultSchema,
  dataSchemaResultSchema, dataAccessResultSchema,
  analyzeProjectDataArgsSchema, analyzeProjectDataResultSchema,
} from "./schemas";
import { validateRecordInput } from "@/lib/db/sandbox-data";

/**
 * Data tools: only access collections/fields declared by the current manifest; no arbitrary SQL;
 * mutate tools run through dataAdapter (repository project/app scope).
 */

function requireCollection(context: ToolExecutionContext, name: string) {
  const manifest = context.currentManifest;
  if (!manifest) throw new ToolExecutionError("NO_APP", "当前项目还没有应用", false);
  const collection = manifest.collections.find((c) => c.name === name);
  if (!collection) throw new ToolExecutionError("COLLECTION_NOT_DECLARED", "集合未声明：" + name, false);
  return collection;
}

function applyFilter(rows: Array<Record<string, unknown>>, filter?: Record<string, string | number | boolean>): Array<Record<string, unknown>> {
  if (!filter) return rows;
  return rows.filter((row) => Object.entries(filter).every(([key, value]) => String(row[key] ?? "") === String(value)));
}

export const inspectDataSchemaTool: ServerToolDefinition<Record<string, never>, { collections: Array<{ name: string; fields: Array<{ name: string; type: string; required: boolean }> }> }> = {
  name: "inspect_data_schema",
  description: "返回当前 manifest 声明的集合与字段 schema。",
  argsSchema: z.object({}).strict(),
  resultSchema: dataSchemaResultSchema,
  allowedRoles: ["product_manager", "engineer"],
  risk: "low",
  requiresApproval: false,
  async execute(_args, context) {
    const manifest = context.currentManifest;
    if (!manifest) throw new ToolExecutionError("NO_APP", "当前项目还没有应用", false);
    const collections = manifest.collections;
    return {
      collections: collections.map((c) => ({
        name: c.name,
        fields: c.fields.map((f) => ({ name: f.name, type: f.type, required: f.required ?? false })),
      })),
    };
  },
};

export const queryRecordsTool: ServerToolDefinition<{ collection: string; filter?: Record<string, string | number | boolean>; limit: number }, { collection: string; records: Array<Record<string, unknown>>; truncated: boolean }> = {
  name: "query_records",
  description: "按当前 manifest allowlist 查询已授权记录。",
  argsSchema: dataQueryArgsSchema,
  resultSchema: dataQueryResultSchema,
  allowedRoles: ["product_manager"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const collection = requireCollection(context, args.collection);
    const adapter = context.dataAdapter;
    const rows = adapter ? adapter.list(collection.name) : (context.projectRecords ?? []);
    const filtered = applyFilter(rows, args.filter);
    return { collection: collection.name, records: filtered.slice(0, args.limit).map((r) => ({ ...r })), truncated: filtered.length > args.limit };
  },
};

export const countRecordsTool: ServerToolDefinition<{ collection: string; filter?: Record<string, string | number | boolean> }, { collection: string; count: number }> = {
  name: "count_records",
  description: "统计记录数量。",
  argsSchema: dataCountArgsSchema,
  resultSchema: dataCountResultSchema,
  allowedRoles: ["product_manager", "engineer"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const collection = requireCollection(context, args.collection);
    const adapter = context.dataAdapter;
    const rows = adapter ? adapter.list(collection.name) : (context.projectRecords ?? []);
    return { collection: collection.name, count: applyFilter(rows, args.filter).length };
  },
};

export const aggregateRecordsTool: ServerToolDefinition<{ collection: string; fieldId: string; metric: "count" | "sum" | "average"; filter?: Record<string, string | number | boolean> }, { collection: string; metric: string; value: number }> = {
  name: "aggregate_records",
  description: "对已授权数字字段做 count/sum/average 聚合。",
  argsSchema: dataAggregateArgsSchema,
  resultSchema: dataAggregateResultSchema,
  allowedRoles: ["product_manager"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const collection = requireCollection(context, args.collection);
    const field = collection.fields.find((f) => f.name === args.fieldId);
    if (!field) throw new ToolExecutionError("INVALID_ARGS", "字段未声明", false);
    const adapter = context.dataAdapter;
    const rows = applyFilter(adapter ? adapter.list(collection.name) : (context.projectRecords ?? []), args.filter);
    if (args.metric === "count") return { collection: collection.name, metric: "count", value: rows.length };
    if (field.type !== "number") throw new ToolExecutionError("INVALID_ARGS", "聚合只支持 number 字段", false);
    const nums = rows.map((r) => Number(r[args.fieldId])).filter(Number.isFinite);
    if (args.metric === "sum") return { collection: collection.name, metric: "sum", value: nums.reduce((a, b) => a + b, 0) };
    return { collection: collection.name, metric: "average", value: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0 };
  },
};

export const createRecordTool: ServerToolDefinition<{ collection: string; input: Record<string, unknown> }, { record: Record<string, unknown> }> = {
  name: "create_record",
  description: "在已声明集合中创建记录（服务端字段级校验）。",
  argsSchema: recordCreateArgsSchema,
  resultSchema: recordCreateResultSchema,
  allowedRoles: ["engineer"],
  risk: "medium",
  requiresApproval: false,
  async execute(args, context) {
    const collection = requireCollection(context, args.collection);
    if (!collection.allowedOperations.includes("create")) throw new ToolExecutionError("OPERATION_NOT_ALLOWED", "集合未声明 create", false);
    if (!context.dataAdapter) throw new ToolExecutionError("DATA_NOT_CONFIGURED", "数据写入未配置", false);
    const cleaned = validateRecordInput(collection as never, args.input, "create");
    const record = context.dataAdapter.insert(collection.name, cleaned);
    return { record };
  },
};

export const updateRecordTool: ServerToolDefinition<{ collection: string; id: string; patch: Record<string, unknown> }, { updated: boolean }> = {
  name: "update_record",
  description: "更新已声明集合中的记录（scope 校验）。",
  argsSchema: recordUpdateArgsSchema,
  resultSchema: recordUpdateResultSchema,
  allowedRoles: ["engineer"],
  risk: "medium",
  requiresApproval: false,
  async execute(args, context) {
    const collection = requireCollection(context, args.collection);
    if (!collection.allowedOperations.includes("update")) throw new ToolExecutionError("OPERATION_NOT_ALLOWED", "集合未声明 update", false);
    if (!context.dataAdapter) throw new ToolExecutionError("DATA_NOT_CONFIGURED", "数据写入未配置", false);
    validateRecordInput(collection as never, args.patch, "patch");
    return { updated: context.dataAdapter.update(collection.name, args.id, args.patch) };
  },
};

export const deleteRecordTool: ServerToolDefinition<{ collection: string; id: string }, { deleted: boolean }> = {
  name: "delete_record",
  description: "删除记录（高风险，需要审批）。",
  argsSchema: recordDeleteArgsSchema,
  resultSchema: recordDeleteResultSchema,
  allowedRoles: ["engineer"],
  risk: "high",
  requiresApproval: true,
  async execute(args, context) {
    const collection = requireCollection(context, args.collection);
    if (!collection.allowedOperations.includes("delete")) throw new ToolExecutionError("OPERATION_NOT_ALLOWED", "集合未声明 delete", false);
    if (!context.dataAdapter) throw new ToolExecutionError("DATA_NOT_CONFIGURED", "数据写入未配置", false);
    return { deleted: context.dataAdapter.remove(collection.name, args.id) };
  },
};

export const analyzeProjectDataTool: ServerToolDefinition<{ metric: "count" | "countWhere" | "sum" | "average" | "trend"; fieldId: string | null; filter?: Record<string, string | number | boolean> }, { metric: string; fieldId: string | null; value: number | string; note: string; timeRange: string }> = {
  name: "analyze_project_data",
  description: "对已授权记录做受控聚合分析（脱敏数值）。",
  argsSchema: analyzeProjectDataArgsSchema,
  resultSchema: analyzeProjectDataResultSchema,
  allowedRoles: ["product_manager"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const manifest = context.currentManifest;
    const rows = applyFilter(context.projectRecords ?? [], args.filter);
    const nums = args.fieldId ? rows.map((r) => Number(r[args.fieldId!])).filter(Number.isFinite) : [];
    let value: number | string;
    switch (args.metric) {
      case "count":
      case "countWhere":
        value = rows.length;
        break;
      case "sum":
        value = nums.reduce((a, b) => a + b, 0);
        break;
      case "average":
        value = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
        break;
      case "trend":
        value = nums.length >= 2 ? nums[nums.length - 1] - nums[0] : 0;
        break;
    }
    return { metric: args.metric, fieldId: args.fieldId, value: typeof value === "number" ? Math.round(value * 100) / 100 : String(value), note: manifest ? "当前应用已授权记录" : "无应用数据", timeRange: "全部已授权记录" };
  },
};

export const validateDataAccessTool: ServerToolDefinition<{ collection: string; operation: string }, { valid: boolean; issues: string[] }> = {
  name: "validate_data_access",
  description: "校验集合/操作是否在当前 manifest allowlist 内。",
  argsSchema: z.object({ collection: z.string().min(1).max(64), operation: z.string().min(1).max(40) }).strict() as never,
  resultSchema: dataAccessResultSchema,
  allowedRoles: ["product_manager", "engineer"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    try {
      const collection = requireCollection(context, args.collection);
      if (!collection.allowedOperations.includes(args.operation as never)) {
        return { valid: false, issues: ["集合未声明操作：" + args.operation] };
      }
      return { valid: true, issues: [] };
    } catch (error) {
      return { valid: false, issues: [error instanceof Error ? error.message : "校验失败"] };
    }
  },
};

export const checkDataIsolationTool: ServerToolDefinition<Record<string, never>, { valid: boolean; issues: string[] }> = {
  name: "check_data_isolation",
  description: "校验数据适配器只访问当前项目/app scope。",
  argsSchema: z.object({}).strict() as never,
  resultSchema: dataAccessResultSchema,
  allowedRoles: ["engineer"],
  risk: "low",
  requiresApproval: false,
  async execute(_args, context) {
    const issues: string[] = [];
    if (!context.currentManifest) issues.push("当前没有应用");
    if (context.projectRecords == null && context.dataAdapter == null) issues.push("没有可用的授权数据源");
    return { valid: issues.length === 0, issues };
  },
};

import { z } from "zod";

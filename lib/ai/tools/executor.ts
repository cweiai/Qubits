import "server-only";
import { z } from "zod";
import type { ServerToolDefinition } from "./types";
import {
  analyzeProjectDataArgsSchema,
  analyzeProjectDataResultSchema,
  inspectCurrentAppArgsSchema,
  inspectCurrentAppResultSchema,
} from "./schemas";
import { SearchProviderError } from "./search-provider";

/** inspect_current_app: controlled read of the current app summary (no credentials/full business data). */
export const inspectCurrentAppTool: ServerToolDefinition<z.infer<typeof inspectCurrentAppArgsSchema>, z.infer<typeof inspectCurrentAppResultSchema>> = {
  name: "inspect_current_app",
  description: "读取当前应用经过校验的 manifest 摘要（可选包含记录计数），不返回凭据、代码或完整数据。",
  argsSchema: inspectCurrentAppArgsSchema,
  resultSchema: inspectCurrentAppResultSchema,
  allowedRoles: ["team_leader", "product_manager", "architect", "engineer", "data_scientist", "reviewer"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const manifest = context.currentManifest;
    if (!manifest) {
      return { hasApp: false, appSummary: "当前项目还没有可用的应用", schemaSummary: "" };
    }
    const schemaSummary = args.includeSchema
      ? [
          "collections: " + manifest.collections.map((c) => c.name + "[" + c.allowedOperations.join(",") + "]").join(", "),
          "fields: " + manifest.collections.map((c) => c.name + "(" + c.fields.map((f) => f.name + ":" + f.type).join(",") + ")").join("；"),
        ].join("；")
      : "";
    const recordCounts: Record<string, number> = {};
    if (args.includeRecords && context.projectRecords) {
      const primary = manifest.collections[0]?.name;
      if (primary) recordCounts[primary] = context.projectRecords.length;
    }
    return {
      hasApp: true,
      appSummary: "「" + manifest.name + "」v" + context.currentVersion + "：" + manifest.description.slice(0, 200),
      schemaSummary: schemaSummary.slice(0, 2000),
      recordCounts: args.includeRecords ? recordCounts : undefined,
    };
  },
};

/** analyze_project_data: only fields/aggregations declared by the manifest; returns redacted numbers. */
export const analyzeProjectDataTool: ServerToolDefinition<z.infer<typeof analyzeProjectDataArgsSchema>, z.infer<typeof analyzeProjectDataResultSchema>> = {
  name: "analyze_project_data",
  description: "分析当前应用已授权的结构化记录（count/countWhere/sum/average/trend），只返回脱敏数值与说明。",
  argsSchema: analyzeProjectDataArgsSchema,
  resultSchema: analyzeProjectDataResultSchema,
  allowedRoles: ["data_scientist"],
  risk: "low",
  requiresApproval: false,
  async execute(args, context) {
    const manifest = context.currentManifest;
    if (!manifest) throw new SearchProviderError("NO_DATA", "当前项目还没有应用数据");
    const records = context.projectRecords ?? [];
    const collection = manifest.collections[0];
    const field = collection && args.fieldId ? collection.fields.find((f) => f.name === args.fieldId) : null;
    if (args.fieldId && !field) {
      throw new SearchProviderError("INVALID_ARGS", "字段未在 manifest 中声明");
    }
    const applyFilter = (rows: Array<Record<string, unknown>>) => {
      if (!args.filter) return rows;
      return rows.filter((row) => Object.entries(args.filter!).every(([key, value]) => String(row[key] ?? "") === String(value)));
    };
    const rows = applyFilter(records);
    const numValues = args.fieldId ? rows.map((r) => Number(r[args.fieldId!])).filter(Number.isFinite) : [];
    let value: number | string;
    let note = "";
    switch (args.metric) {
      case "count":
        value = rows.length;
        note = "记录数量（已应用筛选）";
        break;
      case "countWhere":
        value = rows.length;
        note = "满足筛选条件的记录数量";
        break;
      case "sum": {
        if (!field || field.type !== "number") throw new SearchProviderError("INVALID_ARGS", "sum 只能作用于 number 字段");
        value = numValues.reduce((acc, n) => acc + n, 0);
        note = "字段「" + field.label + "」求和";
        break;
      }
      case "average": {
        if (!field || field.type !== "number") throw new SearchProviderError("INVALID_ARGS", "average 只能作用于 number 字段");
        value = numValues.length ? numValues.reduce((a, b) => a + b, 0) / numValues.length : 0;
        note = "字段「" + field.label + "」平均值";
        break;
      }
      case "trend": {
        if (!field || field.type !== "number") throw new SearchProviderError("INVALID_ARGS", "trend 只能作用于 number 字段");
        value = numValues.length >= 2 ? numValues[numValues.length - 1] - numValues[0] : 0;
        note = "字段「" + field.label + "」首尾差值（按当前排序）";
        break;
      }
    }
    return {
      metric: args.metric,
      fieldId: args.fieldId,
      value: typeof value === "number" ? Math.round(value * 100) / 100 : String(value).slice(0, 80),
      note,
      timeRange: "当前应用已授权记录",
    };
  },
};

import { z } from "zod";

/**
 * Legacy AppSpec compatibility contract. New generations produce real TypeScript/React
 * workspaces and a Qubits manifest; this schema only validates old persisted projects
 * during one-time migration.
 *
 * Data capability: apps only read/write collections declared via the Qubits Runtime API;
 * the backend validates field-by-field against CollectionSpec, so neither the sandbox nor the
 * API ever executes arbitrary SQL or code.
 */

const FIELD_TYPES = ["text", "number", "select", "date", "boolean"] as const;
export const fieldTypeSchema = z.enum(FIELD_TYPES);

/** Collection/field identifiers: restricted allowlist naming to prevent SQL/table/identifier injection. */
export const IDENTIFIER = /^[a-z][a-z0-9_]{0,31}$/;
export const FIELD_IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export const fieldSpecSchema = z.object({
  id: z.string().min(1).regex(FIELD_IDENTIFIER, "字段 id 必须是合法标识符"),
  label: z.string().min(1),
  type: fieldTypeSchema,
  required: z.boolean().default(false),
  placeholder: z.string().optional(),
  options: z.array(z.string().min(1)).min(1).optional(),
  maxLength: z.number().int().positive().max(4000).optional(),
  defaultValue: z.unknown().optional(),
});
export type FieldSpec = z.infer<typeof fieldSpecSchema>;

const themeSchema = z.object({
  primary: z.string().regex(/^#[0-9a-fA-F]{6}$/, "primary 必须是 #RRGGBB 十六进制色"),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/, "background 必须是 #RRGGBB 十六进制色"),
  foreground: z.string().regex(/^#[0-9a-fA-F]{6}$/, "foreground 必须是 #RRGGBB 十六进制色"),
  radius: z.enum(["sm", "md"]).default("md"),
});

const filterConfigSchema = z.object({
  fieldId: z.string().min(1),
  label: z.string().min(1),
});

const ACTION_TYPES = ["toggle-boolean", "update-record", "delete-record"] as const;
const actionsSchema = z.array(z.enum(ACTION_TYPES)).max(3).optional();

export const statSpecSchema = z.discriminatedUnion("aggregate", [
  z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    aggregate: z.literal("count"),
  }),
  z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    aggregate: z.literal("countWhere"),
    where: z.object({
      fieldId: z.string().min(1),
      equals: z.union([z.string(), z.number(), z.boolean()]),
    }),
  }),
  z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    aggregate: z.literal("sum"),
    fieldId: z.string().min(1),
  }),
]);
export type StatSpec = z.infer<typeof statSpecSchema>;

const SECTION_TYPES = [
  "header",
  "hero",
  "stats",
  "record-form",
  "record-list",
  "record-table",
  "empty-state",
] as const;
export const sectionTypeSchema = z.enum(SECTION_TYPES);

export const sectionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("header"),
    title: z.string().min(1),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("hero"),
    title: z.string().min(1),
    description: z.string().optional(),
    ctaLabel: z.string().optional(),
  }),
  z.object({
    type: z.literal("stats"),
    stats: z.array(statSpecSchema).min(1).max(6),
  }),
  z.object({
    type: z.literal("record-form"),
    title: z.string().optional(),
    submitLabel: z.string().optional(),
  }),
  z.object({
    type: z.literal("record-list"),
    title: z.string().optional(),
    showSearch: z.boolean().optional(),
    showFilters: z.boolean().optional(),
    filters: z.array(filterConfigSchema).max(3).optional(),
    displayFields: z.array(z.string().min(1)).optional(),
    actions: actionsSchema,
  }),
  z.object({
    type: z.literal("record-table"),
    title: z.string().optional(),
    showSearch: z.boolean().optional(),
    showFilters: z.boolean().optional(),
    filters: z.array(filterConfigSchema).max(3).optional(),
    columns: z.array(z.string().min(1)).optional(),
    actions: actionsSchema,
  }),
  z.object({
    type: z.literal("empty-state"),
    title: z.string().min(1),
    description: z.string().optional(),
  }),
]);
export type SectionSpec = z.infer<typeof sectionSchema>;

export const entitySchema = z.object({
  id: z.string().min(1).regex(IDENTIFIER, "entity.id 必须是小写受限标识符（作为数据集合名）"),
  name: z.string().min(1),
  primaryField: z.string().min(1),
  fields: z.array(fieldSpecSchema).min(1).max(12),
  initialRecords: z.array(z.record(z.unknown())).default([]),
});
export type AppEntity = z.infer<typeof entitySchema>;

// ── Data collection contract (server-side validation for the sandbox Runtime API) ──

export const COLLECTION_OPERATIONS = ["list", "count", "create", "update", "delete"] as const;
export const collectionOperationSchema = z.enum(COLLECTION_OPERATIONS);
export type CollectionOperation = z.infer<typeof collectionOperationSchema>;

const collectionFieldSchema = z.object({
  name: z.string().regex(FIELD_IDENTIFIER, "字段名必须是合法标识符"),
  label: z.string().min(1),
  type: fieldTypeSchema,
  required: z.boolean().default(false),
  options: z.array(z.string().min(1)).min(1).optional(),
  maxLength: z.number().int().positive().max(4000).optional(),
});

export const collectionSpecSchema = z.object({
  name: z.string().regex(IDENTIFIER, "集合名必须是小写受限标识符"),
  label: z.string().min(1),
  fields: z.array(collectionFieldSchema).min(1).max(12),
  allowedOperations: z.array(collectionOperationSchema).min(1).max(5),
});
export type CollectionSpec = z.infer<typeof collectionSpecSchema>;

export const appSpecSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  /** App version: increments on each change; scopes sandbox sessions (appId + version). */
  version: z.number().int().positive().default(1),
  name: z.string().min(1),
  description: z.string(),
  theme: themeSchema,
  entity: entitySchema,
  /** Data collection declarations; when omitted, a single collection is derived from the entity (legacy AppSpec compatibility). */
  collections: z.array(collectionSpecSchema).max(8).optional(),
  sections: z.array(sectionSchema).min(1).max(10),
});
export type AppSpec = z.infer<typeof appSpecSchema>;

/** Semantic validation reused across modules: beyond structural validity, references must resolve. */
export function getAppSpecIssues(spec: AppSpec): string[] {
  const issues: string[] = [];
  const fieldMap = new Map(spec.entity.fields.map((f) => [f.id, f]));

  if (!fieldMap.has(spec.entity.primaryField)) {
    issues.push(`entity.primaryField「${spec.entity.primaryField}」不存在于字段列表`);
  } else if (fieldMap.get(spec.entity.primaryField)?.type !== "text") {
    issues.push(`entity.primaryField「${spec.entity.primaryField}」必须是 text 类型`);
  }
  if (new Set(spec.entity.fields.map((f) => f.id)).size !== spec.entity.fields.length) {
    issues.push("字段 id 存在重复");
  }
  for (const field of spec.entity.fields) {
    if (field.type === "select" && (!field.options || field.options.length === 0)) {
      issues.push(`select 字段「${field.label}」必须提供 options`);
    }
  }

  // Collections must stay consistent with the entity: if declared, they must include one named entity.id
  if (spec.collections && spec.collections.length > 0) {
    if (!spec.collections.some((c) => c.name === spec.entity.id)) {
      issues.push(`collections 必须包含名为「${spec.entity.id}」的集合（对应 entity）`);
    }
    for (const collection of spec.collections) {
      if (new Set(collection.fields.map((f) => f.name)).size !== collection.fields.length) {
        issues.push(`集合「${collection.name}」的字段名存在重复`);
      }
      for (const field of collection.fields) {
        if (field.type === "select" && (!field.options || field.options.length === 0)) {
          issues.push(`集合「${collection.name}」的 select 字段「${field.label}」必须提供 options`);
        }
      }
    }
  }

  for (const section of spec.sections) {
    if (section.type === "stats") {
      for (const stat of section.stats) {
        if (stat.aggregate === "sum") {
          const field = fieldMap.get(stat.fieldId);
          if (!field) issues.push(`统计「${stat.label}」引用了不存在的字段「${stat.fieldId}」`);
          else if (field.type !== "number") issues.push(`统计「${stat.label}」的 sum 只能作用于 number 字段`);
        }
        if (stat.aggregate === "countWhere" && !fieldMap.has(stat.where.fieldId)) {
          issues.push(`统计「${stat.label}」的筛选字段「${stat.where.fieldId}」不存在`);
        }
      }
    }
    if (section.type === "record-list" || section.type === "record-table") {
      const refs = [
        ...(section.filters ?? []).map((f) => f.fieldId),
        ...("columns" in section && section.columns ? section.columns : []),
        ...("displayFields" in section && section.displayFields ? section.displayFields : []),
      ];
      for (const fieldId of refs) {
        if (!fieldMap.has(fieldId)) issues.push(`区块引用了不存在的字段「${fieldId}」`);
      }
    }
  }

  const interactive = spec.sections.filter(
    (s) => s.type === "record-form" || s.type === "record-list" || s.type === "record-table"
  ).length;
  if (interactive === 0) {
    issues.push("至少需要一个可交互区块（record-form / record-list / record-table）");
  }
  return issues;
}

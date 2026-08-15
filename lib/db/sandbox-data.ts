import { z } from "zod";
import {
  collectionSpecSchema,
  FIELD_IDENTIFIER,
  type CollectionSpec,
} from "@/lib/contracts/app-spec";
import { newId } from "@/lib/app/records";
import { AppRepository, type RecordRow, type SessionRow } from "./repository";

/**
 * Sandbox data service: all cross-boundary data (session / collection / operation / query / payload)
 * is re-validated server-side; the manifest and payload from the sandbox are never trusted.
 */

// ── Limits ──

const MAX_RECORD_BYTES = 16 * 1024;
const MAX_LIST_LIMIT = 200;
const MAX_SEED_RECORDS = 50;
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 200;

// ── Business errors ──

type SandboxErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "SESSION_NOT_FOUND"
  | "SESSION_EXPIRED"
  | "SCOPE_MISMATCH"
  | "COLLECTION_NOT_DECLARED"
  | "OPERATION_NOT_ALLOWED"
  | "INVALID_QUERY"
  | "INVALID_INPUT"
  | "RECORD_NOT_FOUND"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "DB_ERROR";

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly status: number;
  constructor(code: SandboxErrorCode, message: string, status = 400) {
    super(message);
    this.name = "SandboxError";
    this.code = code;
    this.status = status;
  }
}

// ── Query validation (only explicit safe structures; no SQL / regex / arbitrary expressions) ──

type QueryOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in";

interface SafeQuery {
  filter?: Record<string, Partial<Record<QueryOperator, unknown>>>;
  search?: string;
  sort?: { field: string; dir: "asc" | "desc" };
  limit?: number;
  offset?: number;
}

const querySchema = z
  .object({
    filter: z
      .record(
        z.string().regex(FIELD_IDENTIFIER),
        z.record(
          z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in"]),
          z.union([
            z.string().max(500),
            z.number().finite(),
            z.boolean(),
            z.array(z.union([z.string().max(500), z.number().finite()])).max(50),
          ])
        )
      )
      .optional(),
    search: z.string().max(200).optional(),
    sort: z
      .object({ field: z.string().regex(FIELD_IDENTIFIER), dir: z.enum(["asc", "desc"]) })
      .optional(),
    limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
    offset: z.number().int().min(0).max(10000).optional(),
  })
  .strict();

export function validateQuery(collection: CollectionSpec, raw: unknown): SafeQuery {
  const parsed = querySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new SandboxError("INVALID_QUERY", "查询结构不合法：只支持 filter/search/sort/limit/offset", 400);
  }
  const query = parsed.data;
  const fieldNames = new Set(collection.fields.map((f) => f.name));
  if (query.filter) {
    for (const fieldName of Object.keys(query.filter)) {
      if (!fieldNames.has(fieldName)) {
        throw new SandboxError("INVALID_QUERY", `筛选字段「${fieldName}」未在集合中声明`, 400);
      }
    }
  }
  if (query.sort && !fieldNames.has(query.sort.field)) {
    throw new SandboxError("INVALID_QUERY", `排序字段「${query.sort.field}」未在集合中声明`, 400);
  }
  return query;
}

function fieldTypeOf(collection: CollectionSpec, name: string): string {
  return collection.fields.find((f) => f.name === name)?.type ?? "text";
}

function compareValues(recordValue: unknown, expected: unknown, operator: string): boolean {
  switch (operator) {
    case "eq":
      return String(recordValue ?? "") === String(expected);
    case "neq":
      return String(recordValue ?? "") !== String(expected);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = Number(recordValue);
      const b = Number(expected);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      if (operator === "gt") return a > b;
      if (operator === "gte") return a >= b;
      if (operator === "lt") return a < b;
      return a <= b;
    }
    case "in":
      return Array.isArray(expected) && expected.some((item) => String(recordValue ?? "") === String(item));
    default:
      return false;
  }
}

export function applyQuery(
  rows: Array<{ id: string; data: Record<string, unknown> }>,
  query: SafeQuery,
  collection: CollectionSpec
): Array<{ id: string; data: Record<string, unknown> }> {
  let out = rows;
  if (query.filter) {
    for (const [fieldName, operators] of Object.entries(query.filter)) {
      for (const [operator, expected] of Object.entries(operators)) {
        out = out.filter((row) => compareValues(row.data[fieldName], expected, operator));
      }
    }
  }
  if (query.search) {
    const needle = query.search.trim().toLowerCase();
    if (needle) {
      out = out.filter((row) =>
        collection.fields
          .filter((f) => f.type !== "boolean")
          .some((f) => String(row.data[f.name] ?? "").toLowerCase().includes(needle))
      );
    }
  }
  if (query.sort) {
    const dir = query.sort.dir === "asc" ? 1 : -1;
    const fieldType = fieldTypeOf(collection, query.sort.field);
    out = [...out].sort((a, b) => {
      const av = a.data[query.sort!.field];
      const bv = b.data[query.sort!.field];
      if (fieldType === "number") return (Number(av) - Number(bv)) * dir;
      if (fieldType === "date") return (String(av ?? "").localeCompare(String(bv ?? ""))) * dir;
      return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
    });
  }
  const offset = query.offset ?? 0;
  const limit = query.limit ?? MAX_LIST_LIMIT;
  return out.slice(offset, offset + limit);
}

// ── Record input validation (field-level validation and filtering against CollectionSpec) ──

export function validateRecordInput(
  collection: CollectionSpec,
  raw: unknown,
  mode: "create" | "patch"
): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SandboxError("INVALID_INPUT", "记录内容必须是对象", 400);
  }
  let serialized = "";
  try {
    serialized = JSON.stringify(raw);
  } catch {
    throw new SandboxError("INVALID_INPUT", "记录内容无法序列化", 400);
  }
  if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) {
    throw new SandboxError("PAYLOAD_TOO_LARGE", "记录内容过大", 400);
  }

  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of collection.fields) {
    const present = Object.prototype.hasOwnProperty.call(input, field.name);
    const value = input[field.name];
    if (!present || value === null || value === undefined || value === "") {
      if (mode === "create" && field.required) {
        throw new SandboxError("INVALID_INPUT", `字段「${field.label}」必填`, 400);
      }
      continue; // Optional field missing or empty: not stored (field-level filtering).
    }
    switch (field.type) {
      case "text": {
        if (typeof value !== "string") {
          throw new SandboxError("INVALID_INPUT", `字段「${field.label}」必须是文本`, 400);
        }
        const max = field.maxLength ?? 2000;
        if (value.length > max) {
          throw new SandboxError("INVALID_INPUT", `字段「${field.label}」超过最大长度 ${max}`, 400);
        }
        out[field.name] = value;
        break;
      }
      case "number": {
        const num = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(num)) {
          throw new SandboxError("INVALID_INPUT", `字段「${field.label}」必须是有效数字`, 400);
        }
        out[field.name] = num;
        break;
      }
      case "boolean": {
        if (typeof value !== "boolean") {
          throw new SandboxError("INVALID_INPUT", `字段「${field.label}」必须是布尔值`, 400);
        }
        out[field.name] = value;
        break;
      }
      case "date": {
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          throw new SandboxError("INVALID_INPUT", `字段「${field.label}」必须是 YYYY-MM-DD 日期`, 400);
        }
        out[field.name] = value;
        break;
      }
      case "select": {
        if (typeof value !== "string" || !(field.options ?? []).includes(value)) {
          throw new SandboxError("INVALID_INPUT", `字段「${field.label}」的值不在允许选项中`, 400);
        }
        out[field.name] = value;
        break;
      }
    }
  }
  return out; // Undeclared keys are silently dropped, never passed through.
}

// ── Session and collection resolution ──

export function resolveSession(repo: AppRepository, projectId: string | null, sessionId: string): SessionRow {
  if (!projectId) {
    throw new SandboxError("UNAUTHORIZED", "缺少项目会话，请刷新页面后重试", 401);
  }
  const session = repo.getSession(sessionId);
  if (!session) {
    throw new SandboxError("SESSION_NOT_FOUND", "沙盒会话不存在或已失效，请刷新预览", 404);
  }
  if (session.projectId !== projectId) {
    throw new SandboxError("SCOPE_MISMATCH", "沙盒会话不属于当前项目", 403);
  }
  if (session.expiresAt <= Date.now()) {
    throw new SandboxError("SESSION_EXPIRED", "沙盒会话已过期，请刷新预览", 401);
  }
  return session;
}

export function parseSessionCollections(session: SessionRow): CollectionSpec[] {
  let raw: unknown;
  try {
    raw = JSON.parse(session.collectionsJson);
  } catch {
    throw new SandboxError("SESSION_NOT_FOUND", "会话集合契约损坏，请刷新预览", 500);
  }
  const parsed = z.array(collectionSpecSchema).safeParse(raw);
  if (!parsed.success) {
    throw new SandboxError("SESSION_NOT_FOUND", "会话集合契约校验失败，请刷新预览", 500);
  }
  return parsed.data;
}

export function requireCollection(collections: CollectionSpec[], name: string): CollectionSpec {
  const collection = collections.find((c) => c.name === name);
  if (!collection) {
    throw new SandboxError("COLLECTION_NOT_DECLARED", `集合「${name}」未在当前应用中声明`, 403);
  }
  return collection;
}

export function requireOperation(collection: CollectionSpec, operation: string): void {
  if (!collection.allowedOperations.includes(operation as CollectionSpec["allowedOperations"][number])) {
    throw new SandboxError("OPERATION_NOT_ALLOWED", `集合「${collection.name}」未声明 ${operation} 操作`, 403);
  }
}

export function parseRecordRow(row: RecordRow): { id: string; data: Record<string, unknown> } {
  let data: unknown = {};
  try {
    data = JSON.parse(row.dataJson);
  } catch {
    // Corrupted records are treated as empty objects and returned with a visible id.
    data = {};
  }
  return { id: row.id, data: data as Record<string, unknown> };
}

// ── Initial record seed (written only when the collection is empty; never overwrites user data) ──

export function seedInitialRecords(
  repo: AppRepository,
  input: {
    projectId: string;
    appId: string;
    collection: CollectionSpec;
    initialRecords: unknown[];
  }
): number {
  if (repo.countRecords(input.projectId, input.appId, input.collection.name) > 0) return 0;
  let inserted = 0;
  for (const raw of input.initialRecords.slice(0, MAX_SEED_RECORDS)) {
    try {
      const cleaned = validateRecordInput(input.collection, raw, "create");
      repo.insertRecord({
        id: newId("rec"),
        projectId: input.projectId,
        appId: input.appId,
        collection: input.collection.name,
        dataJson: JSON.stringify(cleaned),
      });
      inserted += 1;
    } catch {
      // Skip invalid seed data without blocking session creation.
    }
  }
  return inserted;
}

// ── Shared operation handlers ──
// Used by both the sandbox data routes (cookie-scoped preview sessions) and the public
// deployment data route (deployment-scoped sessions, no project cookie). All validation
// happens here; callers only resolve the session and pass validated ids/operations.

export function performListOperation(
  repo: AppRepository,
  session: SessionRow,
  input: { operation: "list" | "count"; collection: string; query: unknown }
): { ok: true; data: unknown } {
  const collections = parseSessionCollections(session);
  const collection = requireCollection(collections, input.collection);
  requireOperation(collection, input.operation);
  checkRateLimit(session.id);

  const query = validateQuery(collection, input.query);
  const rows = repo
    .listRecords(session.projectId, session.appId, collection.name)
    .map(parseRecordRow)
    .map((row) => ({ id: row.id, ...row.data }));
  const filtered = applyQuery(
    rows.map((row) => ({ id: row.id, data: row })),
    query,
    collection
  ).map((row) => row.data);

  if (input.operation === "count") {
    return { ok: true, data: { count: filtered.length } };
  }
  return { ok: true, data: { records: filtered } };
}

export function performMutateOperation(
  repo: AppRepository,
  session: SessionRow,
  input: {
    operation: "create" | "update" | "delete";
    collection: string;
    id?: string;
    recordInput?: unknown;
    patch?: unknown;
  }
): { ok: true; data: unknown } {
  const collections = parseSessionCollections(session);
  const collection = requireCollection(collections, input.collection);
  requireOperation(collection, input.operation);
  checkRateLimit(session.id);

  const scope = { projectId: session.projectId, appId: session.appId, collection: collection.name };

  if (input.operation === "create") {
    const cleaned = validateRecordInput(collection, input.recordInput, "create");
    const record = { id: newId("rec"), ...cleaned };
    repo.insertRecord({ ...scope, id: record.id, dataJson: JSON.stringify(cleaned) });
    return { ok: true, data: { record } };
  }

  const id = input.id;
  if (!id) {
    throw new SandboxError("INVALID_REQUEST", "update/delete 必须提供记录 id", 400);
  }

  if (input.operation === "update") {
    const existing = repo.getRecordById(id);
    if (!existing || existing.projectId !== scope.projectId || existing.appId !== scope.appId || existing.collection !== scope.collection) {
      throw new SandboxError("RECORD_NOT_FOUND", "记录不存在或不属于当前应用", 404);
    }
    const patch = validateRecordInput(collection, input.patch, "patch");
    const merged = { ...parseRecordRow(existing).data, ...patch };
    const updated = repo.updateRecord({ ...scope, id, dataJson: JSON.stringify(merged) });
    if (!updated) {
      throw new SandboxError("RECORD_NOT_FOUND", "记录不存在或不属于当前应用", 404);
    }
    return { ok: true, data: { record: { id, ...merged } } };
  }

  // delete
  const deleted = repo.deleteRecord({ ...scope, id });
  if (!deleted) {
    throw new SandboxError("RECORD_NOT_FOUND", "记录不存在或不属于当前应用", 404);
  }
  return { ok: true, data: { id } };
}

// ── Session-level rate limiting ──

const rateBuckets = new Map<string, number[]>();

export function checkRateLimit(sessionId: string): void {
  const now = Date.now();
  const recent = (rateBuckets.get(sessionId) ?? []).filter((t) => t > now - RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(sessionId, recent);
    throw new SandboxError("RATE_LIMITED", "请求过于频繁，请稍后再试", 429);
  }
  recent.push(now);
  rateBuckets.set(sessionId, recent);
}

export function resetRateLimitsForTests(): void {
  rateBuckets.clear();
}

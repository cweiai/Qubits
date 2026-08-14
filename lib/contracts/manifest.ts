import { z } from "zod";
import { collectionSpecSchema } from "./app-spec";

/**
 * qubits.manifest.json: the minimal trusted manifest for a code-generated app.
 * It only describes app identity, data collections, permissions and the build entry —
 * the UI itself is the generated React/TypeScript code in the workspace.
 *
 * The `main` entry and the dependency versions are system-controlled: the manifest
 * schema pins `main` to the trusted launcher, and `dependencies` can only hold names
 * that the server dependency allowlist provides (enforced by dependency_add).
 */

export const MANIFEST_FILE_NAME = "qubits.manifest.json";
export const MANIFEST_MAIN = "src/main.tsx";

export const manifestDependencySchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9@/._-]+$/i, "依赖名必须是合法的 npm 包名"),
  /** Fixed version pinned by the server allowlist (the client cannot choose arbitrary versions). */
  version: z.string().min(1).max(32),
});

export const qubitsManifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).default(""),
  /** Build entry — system-fixed; anything else is rejected. */
  main: z.literal(MANIFEST_MAIN),
  /** Optional data scope id; when omitted the project id is used (stable across versions). */
  appId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]{1,64}$/, "appId 必须是受限标识符")
    .optional(),
  /** Declared data collections + allowed operations (server re-validates every request). */
  collections: z.array(collectionSpecSchema).max(8).default([]),
  /** Extra dependencies chosen from the server allowlist (react/react-dom are always available). */
  dependencies: z.array(manifestDependencySchema).max(12).default([]),
});
export type QubitsManifest = z.infer<typeof qubitsManifestSchema>;

/** Semantic validation for manifests (beyond structural validity). */
export function getManifestIssues(manifest: QubitsManifest): string[] {
  const issues: string[] = [];
  const names = new Set<string>();
  for (const collection of manifest.collections) {
    if (names.has(collection.name)) {
      issues.push(`集合名「${collection.name}」重复`);
    }
    names.add(collection.name);
    const fieldNames = new Set<string>();
    for (const field of collection.fields) {
      if (fieldNames.has(field.name)) {
        issues.push(`集合「${collection.name}」的字段「${field.name}」重复`);
      }
      fieldNames.add(field.name);
      if (field.type === "select" && (!field.options || field.options.length === 0)) {
        issues.push(`集合「${collection.name}」的 select 字段「${field.label}」必须提供 options`);
      }
    }
    if (collection.allowedOperations.length === 0) {
      issues.push(`集合「${collection.name}」必须声明至少一个 allowedOperation`);
    }
  }
  const depNames = new Set<string>();
  for (const dep of manifest.dependencies) {
    if (depNames.has(dep.name)) {
      issues.push(`依赖「${dep.name}」重复声明`);
    }
    depNames.add(dep.name);
  }
  return issues;
}

/** Parse a qubits.manifest.json file's raw text; returns issues instead of throwing. */
export function parseManifestText(raw: string): { ok: true; manifest: QubitsManifest } | { ok: false; issues: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, issues: ["qubits.manifest.json 不是合法 JSON"] };
  }
  const result = qubitsManifestSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.slice(0, 12).map((issue) => (issue.path.join(".") || "(root)") + ": " + issue.message),
    };
  }
  const semantic = getManifestIssues(result.data);
  if (semantic.length > 0) return { ok: false, issues: semantic };
  return { ok: true, manifest: result.data };
}

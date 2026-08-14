import type { AppSpec, CollectionOperation, CollectionSpec } from "@/lib/contracts/app-spec";
import { COLLECTION_OPERATIONS } from "@/lib/contracts/app-spec";

/**
 * Collection contract resolution: when AppSpec.collections is missing (legacy AppSpec),
 * a single collection is derived from the entity and sections so the renderer and backend
 * validation share the same contract.
 */

const OPERATION_ORDER: CollectionOperation[] = [...COLLECTION_OPERATIONS];

function deriveCollectionFromEntity(spec: AppSpec): CollectionSpec {
  const entity = spec.entity;
  const operations = new Set<CollectionOperation>(["list"]);
  if (spec.sections.some((s) => s.type === "stats")) operations.add("count");
  if (spec.sections.some((s) => s.type === "record-form")) operations.add("create");
  for (const section of spec.sections) {
    if (section.type === "record-list" || section.type === "record-table") {
      const actions = section.actions ?? [];
      if (actions.includes("update-record") || actions.includes("toggle-boolean")) {
        operations.add("update");
      }
      if (actions.includes("delete-record")) operations.add("delete");
    }
  }
  return {
    name: entity.id,
    label: entity.name,
    fields: entity.fields.map((f) => ({
      name: f.id,
      label: f.label,
      type: f.type,
      required: f.required,
      options: f.options,
      maxLength: f.maxLength,
    })),
    allowedOperations: OPERATION_ORDER.filter((op) => operations.has(op)),
  };
}

export function resolveCollections(spec: AppSpec): CollectionSpec[] {
  if (spec.collections && spec.collections.length > 0) return spec.collections;
  return [deriveCollectionFromEntity(spec)];
}

export function getCollection(spec: AppSpec, name: string): CollectionSpec | null {
  return resolveCollections(spec).find((c) => c.name === name) ?? null;
}

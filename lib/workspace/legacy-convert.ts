import "server-only";
import { appSpecSchema, type AppSpec } from "@/lib/contracts/app-spec";
import { MANIFEST_MAIN, type QubitsManifest } from "@/lib/contracts/manifest";
import { resolveCollections } from "@/lib/app-spec/collections";

/**
 * One-time trusted conversion from legacy AppSpec projects to the code workspace model.
 * The legacy app_spec_json is NEVER deleted — the converted manifest is stored in the
 * new manifest_json column and, from then on, the code workspace/manifest is the only
 * source of truth. Records keep working because the converted manifest carries the old
 * appId (the legacy spec id) so data scoping is unchanged.
 */

export function convertAppSpecToManifest(spec: AppSpec): QubitsManifest {
  const collections = resolveCollections(spec);
  return {
    schemaVersion: 1,
    name: spec.name,
    description: spec.description ?? "",
    main: MANIFEST_MAIN,
    appId: spec.id, // keep legacy data scope so existing records remain reachable
    collections,
    dependencies: [],
  };
}

/** Parse + convert an app_spec_json blob; null when missing or invalid (data untouched). */
export function legacyManifestFromJson(appSpecJson: string | null): QubitsManifest | null {
  if (!appSpecJson) return null;
  try {
    const parsed = appSpecSchema.safeParse(JSON.parse(appSpecJson));
    if (!parsed.success) return null;
    return convertAppSpecToManifest(parsed.data);
  } catch {
    return null;
  }
}

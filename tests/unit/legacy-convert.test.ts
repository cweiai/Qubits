import { describe, expect, it } from "vitest";
import { legacyManifestFromJson, convertAppSpecToManifest } from "@/lib/workspace/legacy-convert";
import { makeTaskSpec, makeLegacySpec } from "./fixtures";

/**
 * Legacy AppSpec read-only compatibility: conversion to the manifest model is a
 * one-time trusted step that NEVER deletes app_spec_json or records; the converted
 * manifest keeps the legacy appId so existing records stay reachable.
 */
describe("旧 AppSpec 一次性可信转换", () => {
  it("显式 collections 的 AppSpec → manifest（appId 保留旧 id，数据 scope 不变）", () => {
    const spec = makeTaskSpec();
    const manifest = convertAppSpecToManifest(spec);
    expect(manifest.name).toBe(spec.name);
    expect(manifest.main).toBe("src/main.tsx");
    expect(manifest.appId).toBe(spec.id); // legacy records keep working
    expect(manifest.collections).toHaveLength(1);
    expect(manifest.collections[0].name).toBe("task");
    expect(manifest.collections[0].allowedOperations).toEqual(["list", "count", "create", "update", "delete"]);
  });

  it("旧 AppSpec（无 collections）自动推导单一集合", () => {
    const spec = makeLegacySpec();
    const manifest = legacyManifestFromJson(JSON.stringify(spec));
    expect(manifest).not.toBeNull();
    expect(manifest!.collections).toHaveLength(1);
    expect(manifest!.collections[0].name).toBe("task");
  });

  it("无效 AppSpec 返回 null（数据不动，转换可重试）", () => {
    expect(legacyManifestFromJson("{ not json }")).toBeNull();
    expect(legacyManifestFromJson(null)).toBeNull();
    expect(legacyManifestFromJson(JSON.stringify({ name: "broken" }))).toBeNull();
  });
});

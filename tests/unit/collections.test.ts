import { describe, expect, it } from "vitest";
import { getCollection, resolveCollections } from "@/lib/app-spec/collections";
import { makeLegacySpec, makeTaskSpec } from "./fixtures";

describe("resolveCollections", () => {
  it("显式声明 collections 时直接使用", () => {
    const spec = makeTaskSpec();
    const collections = resolveCollections(spec);
    expect(collections).toHaveLength(1);
    expect(collections[0].name).toBe("task");
    expect(collections[0].allowedOperations).toEqual(["list", "count", "create", "update", "delete"]);
  });

  it("旧版 AppSpec（无 collections）从 entity 推导唯一集合", () => {
    const spec = makeLegacySpec();
    const collections = resolveCollections(spec);
    expect(collections).toHaveLength(1);
    const collection = collections[0];
    expect(collection.name).toBe(spec.entity.id);
    expect(collection.fields.map((f) => f.name)).toEqual(spec.entity.fields.map((f) => f.id));
    // form/list/stats present → create/update/delete/count/list are all derived.
    expect(collection.allowedOperations).toEqual(["list", "count", "create", "update", "delete"]);
  });

  it("getCollection 只返回声明的集合", () => {
    const spec = makeTaskSpec();
    expect(getCollection(spec, "task")?.name).toBe("task");
    expect(getCollection(spec, "undeclared")).toBeNull();
  });
});

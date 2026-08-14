import { describe, expect, it } from "vitest";
import {
  applyQuery,
  SandboxError,
  validateQuery,
  validateRecordInput,
} from "@/lib/db/sandbox-data";
import type { CollectionSpec } from "@/lib/contracts/app-spec";

const COLLECTION: CollectionSpec = {
  name: "task",
  label: "任务",
  fields: [
    { name: "title", label: "标题", type: "text", required: true, maxLength: 20 },
    { name: "priority", label: "优先级", type: "select", required: true, options: ["高", "中", "低"] },
    { name: "amount", label: "金额", type: "number", required: false },
    { name: "completed", label: "已完成", type: "boolean", required: false },
  ],
  allowedOperations: ["list", "count", "create", "update", "delete"],
};

describe("validateRecordInput", () => {
  it("缺少必填字段被拒绝", () => {
    expect(() => validateRecordInput(COLLECTION, { priority: "高" }, "create")).toThrowError(SandboxError);
  });

  it("类型错误被拒绝", () => {
    expect(() =>
      validateRecordInput(COLLECTION, { title: "x", priority: "高", amount: "不是数字" }, "create")
    ).toThrowError(/有效数字/);
  });

  it("超长文本被拒绝", () => {
    expect(() =>
      validateRecordInput(COLLECTION, { title: "x".repeat(21), priority: "高" }, "create")
    ).toThrowError(/最大长度/);
  });

  it("枚举越界被拒绝", () => {
    expect(() =>
      validateRecordInput(COLLECTION, { title: "x", priority: "紧急" }, "create")
    ).toThrowError(/允许选项/);
  });

  it("未声明字段被静默过滤", () => {
    const out = validateRecordInput(
      COLLECTION,
      { title: "x", priority: "高", __proto__x: "evil", admin: true },
      "create"
    );
    expect(out).toEqual({ title: "x", priority: "高" });
  });

  it("patch 模式允许部分字段", () => {
    const out = validateRecordInput(COLLECTION, { completed: true }, "patch");
    expect(out).toEqual({ completed: true });
  });
});

describe("validateQuery", () => {
  it("未声明字段被拒绝", () => {
    expect(() => validateQuery(COLLECTION, { filter: { evil: { eq: "x" } } })).toThrowError(/未在集合中声明/);
  });

  it("非法操作符/结构被拒绝", () => {
    expect(() => validateQuery(COLLECTION, { filter: { title: { sql: "x" } } })).toThrowError(SandboxError);
    expect(() => validateQuery(COLLECTION, { sql: "SELECT 1" })).toThrowError(SandboxError);
  });

  it("合法查询通过", () => {
    const query = validateQuery(COLLECTION, {
      filter: { completed: { eq: true }, amount: { gte: 10 } },
      search: "周报",
      sort: { field: "amount", dir: "desc" },
      limit: 10,
      offset: 0,
    });
    expect(query.limit).toBe(10);
  });
});

describe("applyQuery", () => {
  const rows = [
    { id: "1", data: { title: "写周报", priority: "高", amount: 100, completed: false } },
    { id: "2", data: { title: "整理桌面", priority: "低", amount: 5, completed: true } },
  ];
  it("filter + search + sort + limit", () => {
    const out = applyQuery(
      rows,
      { filter: { completed: { eq: true } }, search: "桌面", sort: { field: "amount", dir: "desc" }, limit: 1 },
      COLLECTION
    );
    expect(out.map((r) => r.id)).toEqual(["2"]);
  });
});

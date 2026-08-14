import { describe, expect, it } from "vitest";
import { scanAppSpecForSecurityIssues } from "@/lib/app-spec/security";
import { securityReviewSchema } from "@/lib/contracts/review";
import { makeTaskSpec } from "./fixtures";

describe("scanAppSpecForSecurityIssues", () => {
  it("合法 AppSpec 无安全问题", () => {
    const issues = scanAppSpecForSecurityIssues(makeTaskSpec());
    expect(issues).toEqual([]);
  });

  it("拒绝 eval / SQL / 密钥 / 外部 URL / 浏览器存储", () => {
    const spec = makeTaskSpec({
      description: "使用 eval() 执行脚本",
      entity: {
        ...makeTaskSpec().entity,
        initialRecords: [{ id: "r1", title: "SELECT * FROM users", priority: "高", completed: false }],
      },
    });
    const codes = scanAppSpecForSecurityIssues(spec).map((i) => i.code);
    expect(codes).toContain("EVAL_USAGE");
    expect(codes).toContain("SQL_STATEMENT");
  });

  it("拒绝 DATABASE_URL 与 apiKey 凭据", () => {
    const spec = makeTaskSpec({
      description: "DATABASE_URL=postgres://x 与 apiKey: sk-xxx",
    });
    const codes = scanAppSpecForSecurityIssues(spec).map((i) => i.code);
    expect(codes).toContain("DB_CREDENTIAL");
    expect(codes).toContain("SECRET_LEAK");
  });

  it("拒绝外部 URL 与 fetch", () => {
    const spec = makeTaskSpec({
      description: "调用 fetch(https://evil.example.com) 获取数据",
    });
    const codes = scanAppSpecForSecurityIssues(spec).map((i) => i.code);
    expect(codes).toContain("EXTERNAL_FETCH");
    expect(codes).toContain("EXTERNAL_URL");
  });
});

describe("securityReviewSchema", () => {
  it("通过时 issues 必须为空", () => {
    expect(
      securityReviewSchema.safeParse({ approved: true, summary: "通过", issues: [] }).success
    ).toBe(true);
    expect(
      securityReviewSchema.safeParse({
        approved: true,
        summary: "通过",
        issues: [{ code: "X", severity: "error", path: "a", message: "m", repairHint: "h" }],
      }).success
    ).toBe(false);
  });

  it("拒绝时必须有结构化 issues", () => {
    const parsed = securityReviewSchema.safeParse({
      approved: false,
      summary: "拒绝",
      issues: [{ code: "UNDECLARED_COLLECTION", severity: "error", path: "appSpec.collections", message: "未声明", repairHint: "声明集合" }],
    });
    expect(parsed.success).toBe(true);
    expect(
      securityReviewSchema.safeParse({ approved: false, summary: "拒绝", issues: [] }).success
    ).toBe(false);
  });
});

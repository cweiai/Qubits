import { describe, expect, it } from "vitest";
import { decideRoute, deploymentIdFromHost, DEPLOY_DATA_API_PATH, DEPLOY_PATH_PREFIX } from "@/lib/deploy/router";

const KNOWN = new Set(["dep-abc123def456", "dep-000000000000"]);

describe("decideRoute", () => {
  it("根路径与 index.html 返回 landing", () => {
    expect(decideRoute("/", KNOWN)).toEqual({ kind: "landing" });
    expect(decideRoute("/index.html", KNOWN)).toEqual({ kind: "landing" });
  });

  it("公开数据 API 路径", () => {
    expect(decideRoute(DEPLOY_DATA_API_PATH, KNOWN)).toEqual({ kind: "deploy-data-api" });
  });

  it("已注册部署的路径路由", () => {
    expect(decideRoute(DEPLOY_PATH_PREFIX + "dep-abc123def456", KNOWN)).toEqual({
      kind: "deployment",
      deploymentId: "dep-abc123def456",
      restPath: "/",
    });
    expect(decideRoute(DEPLOY_PATH_PREFIX + "dep-abc123def456/", KNOWN)).toEqual({
      kind: "deployment",
      deploymentId: "dep-abc123def456",
      restPath: "/",
    });
    expect(decideRoute(DEPLOY_PATH_PREFIX + "dep-abc123def456/sub/page?x=1", KNOWN)).toEqual({
      kind: "deployment",
      deploymentId: "dep-abc123def456",
      restPath: "/sub/page?x=1",
    });
  });

  it("未知或非法部署 id 返回 not-found", () => {
    expect(decideRoute(DEPLOY_PATH_PREFIX + "dep-notregistered", KNOWN)).toEqual({ kind: "not-found" });
    expect(decideRoute(DEPLOY_PATH_PREFIX + "admin/../../etc", KNOWN)).toEqual({ kind: "not-found" });
    expect(decideRoute(DEPLOY_PATH_PREFIX + "DEP-ABC", KNOWN)).toEqual({ kind: "not-found" });
    expect(decideRoute("/d/", KNOWN)).toEqual({ kind: "not-found" });
    expect(decideRoute("/other", KNOWN)).toEqual({ kind: "not-found" });
  });

  it("不把查询串当作部署 id 的一部分", () => {
    // decideRoute receives pathname only; query strings live in URL.search — assert
    // that a "?" inside the id segment is rejected as an invalid id.
    expect(decideRoute(DEPLOY_PATH_PREFIX + "dep-abc123def456?x=1", KNOWN)).toEqual({ kind: "not-found" });
  });
});

describe("deploymentIdFromHost", () => {
  it("提取子域部署 id", () => {
    expect(deploymentIdFromHost("dep-abc123def456.random.trycloudflare.com")).toBe("dep-abc123def456");
    expect(deploymentIdFromHost("DEP-ABC123DEF456.random.trycloudflare.com")).toBeNull();
  });

  it("无部署前缀返回 null", () => {
    expect(deploymentIdFromHost("random.trycloudflare.com")).toBeNull();
    expect(deploymentIdFromHost("")).toBeNull();
    expect(deploymentIdFromHost("xdep-abc123def456.example.com")).toBeNull();
  });
});

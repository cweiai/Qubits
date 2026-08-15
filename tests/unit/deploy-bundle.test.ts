import { describe, expect, it } from "vitest";
import {
  buildDeployBundle,
  buildEmbeddedHostBridge,
  DEPLOY_CSP,
  extractBundleHtml,
  swapCspMeta,
  type DeployBridgeConfig,
} from "@/lib/deploy/bundle";

const SAMPLE_HTML = [
  "<!doctype html>",
  '<html lang="zh-CN">',
  "<head>",
  '<meta charset="utf-8">',
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; connect-src \'none\'">',
  "<title>任务清单</title>",
  "<style>body{}</style>",
  "</head>",
  "<body>",
  '<div id="qubits-root"></div><div id="root"></div>',
  "<script>console.log('app')</script>",
  "</body>",
  "</html>",
].join("");

const CONFIG: DeployBridgeConfig = {
  deploymentId: "dep-abc123def456",
  sessionId: "sess-01234567-89ab-cdef-0123-456789abcdef",
  apiBase: "/api/deploy/data",
  appName: "任务清单",
  appVersion: 1,
};

describe("extractBundleHtml", () => {
  it("解析持久化的 JSON 产物", () => {
    expect(extractBundleHtml(JSON.stringify({ html: "<html>x</html>", bytes: 1, builtAt: 1 }))).toBe("<html>x</html>");
  });

  it("兼容原始 HTML 文本", () => {
    expect(extractBundleHtml("  <html>x</html>  ")).toBe("<html>x</html>");
  });

  it("空内容与非法 JSON 返回 null", () => {
    expect(extractBundleHtml("")).toBeNull();
    expect(extractBundleHtml("   ")).toBeNull();
    expect(extractBundleHtml("{not json")).toBeNull();
    expect(extractBundleHtml("{}")).toBeNull();
  });
});

describe("swapCspMeta", () => {
  it("替换已有 CSP meta 为部署 CSP", () => {
    const out = swapCspMeta(SAMPLE_HTML);
    expect(out).toContain("connect-src 'self' https:");
    expect(out).toContain(DEPLOY_CSP);
    expect(out).not.toContain("connect-src 'none'");
    expect(out.toLowerCase().split("content-security-policy").length - 1).toBe(1);
  });

  it("没有 CSP meta 时插入一个", () => {
    const html = "<!doctype html><html><head><title>x</title></head><body></body></html>";
    const out = swapCspMeta(html);
    expect(out).toContain(DEPLOY_CSP);
    expect(out.indexOf(DEPLOY_CSP)).toBeLessThan(out.indexOf("<title>"));
  });
});

describe("buildEmbeddedHostBridge", () => {
  it("内嵌配置与握手协议", () => {
    const script = buildEmbeddedHostBridge(CONFIG);
    expect(script).toContain("__QUBITS_DEPLOY_HOST__");
    expect(script).toContain(CONFIG.deploymentId);
    expect(script).toContain(CONFIG.sessionId);
    expect(script).toContain("QUBITS_INIT");
    expect(script).toContain("QUBITS_HANDSHAKE");
    expect(script).toContain("QUBITS_DATA_REQUEST");
    expect(script).toContain("QUBITS_DATA_RESPONSE");
  });

  it("应用名中的 </script> 被转义，不会提前闭合脚本标签", () => {
    const script = buildEmbeddedHostBridge({ ...CONFIG, appName: "</script><script>alert(1)</script>" });
    expect(script).not.toContain("</script><script>");
    expect(script).toContain("\\u003c/script>");
  });
});

describe("buildDeployBundle", () => {
  it("注入 guard + 桥且位于应用脚本之前", () => {
    const out = buildDeployBundle(SAMPLE_HTML, CONFIG);
    expect(out).toContain("__QUBITS_POST_MESSAGE_GUARD__");
    expect(out).toContain("__QUBITS_DEPLOY_HOST__");
    const bridgeIndex = out.indexOf("__QUBITS_DEPLOY_HOST__");
    const appIndex = out.indexOf("console.log('app')");
    expect(bridgeIndex).toBeGreaterThan(-1);
    expect(appIndex).toBeGreaterThan(bridgeIndex);
  });

  it("幂等：重复构建不会重复注入", () => {
    const once = buildDeployBundle(SAMPLE_HTML, CONFIG);
    const twice = buildDeployBundle(once, CONFIG);
    expect(twice).toBe(once);
  });
});

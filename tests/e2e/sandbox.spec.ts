import { test, expect, type Page } from "@playwright/test";
import { FRAME, openFixture } from "./fixture";

/**
 * Sandbox e2e exercises the deployed runtime with a persisted application build:
 * the iframe loads the persisted preview bundle, stays isolated, and the Code/Logs
 * tabs expose the same snapshot and reports used by the production workspace.
 */

/** Evaluate a script inside the sandbox iframe (isolation assertions). */
async function evaluateInFrame<T>(page: Page, fn: () => T): Promise<T> {
  const handle = await page.locator(FRAME).elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error("sandbox iframe 不可用");
  return frame.evaluate(fn);
}

test("端到端：持久化构建产物 → 沙盒预览 → 刷新恢复", async ({ page }) => {
  await page.context().clearCookies();
  await openFixture(page);

  // Sandbox attributes: scripts only, no same-origin.
  const iframe = page.locator(FRAME);
  expect(await iframe.getAttribute("sandbox")).toBe("allow-scripts");
  expect(await iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
  // Loads the real built artifact URL, not an AppSpec srcDoc.
  expect(await iframe.getAttribute("src")).toContain("/api/projects/current/preview");

  // The host page renders no app DOM.
  await expect(page.getByTestId("sandbox-iframe")).toBeVisible();
  await expect(page.frameLocator(FRAME).locator("body > *").first()).toBeVisible();
});

test("预览产物在预览刷新与宿主刷新后保持可用", async ({ page }) => {
  await page.context().clearCookies();
  await openFixture(page);
  const frame = page.frameLocator(FRAME);

  const initialText = await frame.locator("body").innerText();
  expect(initialText.trim().length).toBeGreaterThan(0);

  // Preview refresh (rebuilds the session and iframe).
  await page.getByTestId("preview-refresh").click();
  await expect(page.frameLocator(FRAME).locator("body > *").first()).toBeVisible({ timeout: 60_000 });

  // Host refresh.
  await page.reload();
  await expect(page.frameLocator(FRAME).locator("body > *").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.frameLocator(FRAME).locator("body")).not.toBeEmpty();
});

test("Code Tab：真实快照文件树与只读源码；Logs Tab：真实构建/安全报告", async ({ page }) => {
  await page.context().clearCookies();
  await openFixture(page);

  await page.getByTestId("preview-tab-code").click();
  const tree = page.getByTestId("code-tree");
  await expect(tree).toBeVisible();
  await expect(tree.getByText("qubits.manifest.json")).toBeVisible();
  await expect(tree.getByText("App.tsx")).toBeVisible();
  // Open a source file (read-only).
  await tree.getByText("App.tsx").click();
  const content = page.getByTestId("code-content");
  await expect(content).toContainText("export function App");

  await page.getByTestId("preview-tab-logs").click();
  await expect(page.getByTestId("log-build_report")).toBeVisible();
  await expect(page.getByTestId("log-build_report")).toContainText("security_scan");
  await expect(page.getByTestId("log-security_report")).toBeVisible();

  // Back to preview; the app still works.
  await page.getByTestId("preview-tab-preview").click();
  await expect(page.frameLocator(FRAME).locator("body > *").first()).toBeVisible();
});

test("iframe 隔离：无法访问 localStorage / parent / 网络 / Cookie", async ({ page }) => {
  await page.context().clearCookies();
  await openFixture(page);

  // localStorage access denied (opaque origin).
  const localStorageError = await evaluateInFrame(page, () => {
    try {
      window.localStorage.setItem("probe", "1");
      return "allowed";
    } catch {
      return "denied";
    }
  });
  expect(localStorageError).toBe("denied");

  // Parent access denied (no allow-same-origin / allow-top-navigation).
  const parentAccess = await evaluateInFrame(page, () => {
    try {
      const probe = (window.parent as unknown as { document?: unknown }).document;
      return probe ? "allowed" : "denied";
    } catch {
      return "denied";
    }
  });
  expect(parentAccess).toBe("denied");

  // Network blocked by CSP (connect-src 'none').
  const networkBlocked = await evaluateInFrame(page, async () => {
    try {
      await fetch("https://example.com/probe");
      return "allowed";
    } catch {
      return "denied";
    }
  });
  expect(networkBlocked).toBe("denied");

  // Cookies unreadable.
  const cookieValue = await evaluateInFrame(page, () => {
    try {
      return document.cookie;
    } catch {
      return "";
    }
  });
  expect(cookieValue).toBe("");
});

test("密钥与凭据不出现在宿主页面与预览产物中", async ({ page }) => {
  await page.context().clearCookies();
  await openFixture(page);

  const hostHtml = await page.evaluate(() => document.documentElement.outerHTML);
  expect(hostHtml).not.toContain("DATABASE_URL");
  expect(hostHtml).not.toContain("OPENAI_API_KEY");

  // Preview is conversation-scoped: request the artifact via the iframe's actual src.
  const previewSrc = (await page.locator(FRAME).getAttribute("src")) ?? "";
  expect(previewSrc).toContain("/api/projects/current/preview");
  const bundle = await page.request.get(previewSrc);
  expect(bundle.ok()).toBeTruthy();
  const bundleText = await bundle.text();
  expect(bundleText).not.toContain("DATABASE_URL");
  expect(bundleText).not.toContain("OPENAI_API_KEY");
  expect(bundleText).not.toMatch(/eval\s*\(/);
  expect(bundleText).toContain("Content-Security-Policy");
  expect(bundleText).toContain("connect-src 'none'");
});

test("跨项目隔离：不同浏览器上下文拥有独立会话与预览", async ({ browser }) => {
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  await openFixture(pageA, 0);
  const conversationA = new URL(pageA.url()).searchParams.get("conversationId");
  expect(conversationA).toMatch(/^conv-/);
  await contextA.close();

  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await openFixture(pageB, 1);
  const conversationB = new URL(pageB.url()).searchParams.get("conversationId");
  expect(conversationB).toMatch(/^conv-/);
  expect(conversationB).not.toBe(conversationA);
  await expect(pageB.frameLocator(FRAME).locator("body > *").first()).toBeVisible();
  await contextB.close();
});

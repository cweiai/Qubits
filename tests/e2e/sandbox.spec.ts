import { test, expect, type Page } from "@playwright/test";

/**
 * Real code-generation e2e (no real LLM — QUIBITS_MOCK_PROVIDER drives the real tool
 * chain): agents write code via real tool calls, run typecheck/tests/build, the system
 * esbuild produces the preview_bundle, the iframe loads it and does CRUD over
 * MessageChannel; Code/Logs tabs show real snapshots and reports.
 */

const FRAME = 'iframe[data-testid="sandbox-iframe"]';

/** Submit a prompt and wait until the preview iframe is ready (real build done). */
async function generateApp(page: Page, prompt: string): Promise<void> {
  await page.getByTestId("prompt-input").fill(prompt);
  await page.getByTestId("prompt-send").click();
  await expect(page.locator(FRAME)).toBeVisible({ timeout: 180_000 });
  await expect(page.frameLocator(FRAME).getByTestId("template-app")).toBeVisible({ timeout: 180_000 });
}

/** Evaluate a script inside the sandbox iframe (isolation assertions). */
async function evaluateInFrame<T>(page: Page, fn: () => T): Promise<T> {
  const handle = await page.locator(FRAME).elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error("sandbox iframe 不可用");
  return frame.evaluate(fn);
}

test("端到端：真实代码生成 → 沙盒预览 → CRUD → 刷新持久化", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/");
  await generateApp(page, "创建一个个人任务管理器");

  // Sandbox attributes: scripts only, no same-origin.
  const iframe = page.locator(FRAME);
  expect(await iframe.getAttribute("sandbox")).toBe("allow-scripts");
  expect(await iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
  // Loads the real built artifact URL, not an AppSpec srcDoc.
  expect(await iframe.getAttribute("src")).toContain("/api/projects/current/preview");

  // The host page renders no app DOM.
  await expect(page.getByTestId("template-app")).toHaveCount(0);

  const frame = page.frameLocator(FRAME);
  await expect(frame.getByTestId("stat-total")).toHaveText("0");

  // Create
  await frame.getByTestId("todo-input").fill("编写测试计划");
  await frame.getByTestId("todo-priority").selectOption("高");
  await frame.getByTestId("todo-add").click();
  await expect(frame.getByTestId("stat-total")).toHaveText("1");
  await expect(frame.getByTestId("todo-item").filter({ hasText: "编写测试计划" })).toHaveCount(1);

  // Toggle → completed stats (controlled checkbox needs a server round-trip: click + assert)
  const row = frame.getByTestId("todo-item").filter({ hasText: "编写测试计划" });
  await row.getByTestId("todo-toggle").click();
  await expect(row.getByTestId("todo-toggle")).toBeChecked();
  await expect(frame.getByTestId("stat-completed")).toHaveText("1");
  await expect(frame.getByTestId("stat-active")).toHaveText("0");

  // Filter active → item hidden
  await frame.getByTestId("filter-active").click();
  await expect(frame.getByTestId("todo-item")).toHaveCount(0);
  await frame.getByTestId("filter-all").click();
  await expect(frame.getByTestId("todo-item")).toHaveCount(1);

  // Delete
  await frame.getByTestId("todo-item").getByTestId("todo-delete").click();
  await expect(frame.getByTestId("stat-total")).toHaveText("0");
  await expect(frame.getByTestId("todo-empty")).toBeVisible();
});

test("数据经 MessageChannel 持久化：预览刷新与宿主刷新后记录仍在", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/");
  await generateApp(page, "创建一个客户记录面板");
  const frame = page.frameLocator(FRAME);

  await frame.getByTestId("todo-input").fill("刷新后仍在");
  await frame.getByTestId("todo-add").click();
  await expect(frame.getByTestId("stat-total")).toHaveText("1");

  // Preview refresh (rebuilds the session and iframe).
  await page.getByTestId("preview-refresh").click();
  await expect(page.frameLocator(FRAME).getByTestId("stat-total")).toHaveText("1", { timeout: 60_000 });

  // Host refresh.
  await page.reload();
  await expect(page.frameLocator(FRAME).getByTestId("stat-total")).toHaveText("1", { timeout: 60_000 });
  await expect(page.frameLocator(FRAME).getByTestId("todo-item").filter({ hasText: "刷新后仍在" })).toHaveCount(1);
});

test("Code Tab：真实快照文件树与只读源码；Logs Tab：真实构建/评审报告", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/");
  await generateApp(page, "创建一个支出记录面板");

  await page.getByTestId("preview-tab-code").click();
  const tree = page.getByTestId("code-tree");
  await expect(tree).toBeVisible();
  await expect(tree.getByText("qubits.manifest.json")).toBeVisible();
  await expect(tree.getByText("App.tsx")).toBeVisible();
  // Open a source file (read-only).
  await tree.getByText("App.tsx").click();
  const content = page.getByTestId("code-content");
  await expect(content).toContainText("export function App");
  await expect(content).toContainText("todo-input");

  await page.getByTestId("preview-tab-logs").click();
  await expect(page.getByTestId("log-build_report")).toBeVisible();
  await expect(page.getByTestId("log-build_report")).toContainText("security_scan");
  await expect(page.getByTestId("log-review_report")).toBeVisible();

  // Back to preview; the app still works.
  await page.getByTestId("preview-tab-preview").click();
  await expect(page.frameLocator(FRAME).getByTestId("template-app")).toBeVisible();
});

test("iframe 隔离：无法访问 localStorage / parent / 网络 / Cookie", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/");
  await generateApp(page, "创建一个隔离性测试应用");

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
  await page.goto("/");
  await generateApp(page, "创建一个密钥检查应用");

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

test("跨项目隔离：不同浏览器上下文（不同项目 cookie）互相看不到记录", async ({ browser }) => {
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  await pageA.goto("/");
  await generateApp(pageA, "创建跨项目测试应用 A");
  const frameA = pageA.frameLocator(FRAME);
  await frameA.getByTestId("todo-input").fill("项目 A 的记录");
  await frameA.getByTestId("todo-add").click();
  await expect(frameA.getByTestId("stat-total")).toHaveText("1");
  await contextA.close();

  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await pageB.goto("/");
  await generateApp(pageB, "创建跨项目测试应用 B");
  const frameB = pageB.frameLocator(FRAME);
  await expect(frameB.getByTestId("stat-total")).toHaveText("0");
  await expect(frameB.getByTestId("todo-item").filter({ hasText: "项目 A 的记录" })).toHaveCount(0);
  await contextB.close();
});

test("构建失败保留上一个成功版本（错误清晰可重试）", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/");
  await generateApp(page, "创建一个版本保留测试应用");
  const frame = page.frameLocator(FRAME);
  await frame.getByTestId("todo-input").fill("v1 的珍贵记录");
  await frame.getByTestId("todo-add").click();
  await expect(frame.getByTestId("stat-total")).toHaveText("1");

  // Inject an illegal dependency → build fails → task fails; preview stays v1.
  await page.getByTestId("prompt-input").fill("修改应用【注入非法依赖】");
  await page.getByTestId("prompt-send").click();
  await expect(page.getByTestId("error-message").first()).toBeVisible({ timeout: 180_000 });

  // The iframe still shows the last successful version with its data.
  await expect(page.frameLocator(FRAME).getByTestId("stat-total")).toHaveText("1");
  await expect(page.frameLocator(FRAME).getByTestId("todo-item").filter({ hasText: "v1 的珍贵记录" })).toHaveCount(1);

  // The Logs tab shows the real failed build report.
  await page.getByTestId("preview-tab-logs").click();
  await expect(page.getByTestId("log-build_report").first()).toContainText("INVALID_DEPENDENCY");
});

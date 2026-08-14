import { test, expect, type Page } from "@playwright/test";

/**
 * Multi-conversation and collapsible workspace e2e (mock provider drives the real build):
 * sidebar collapse/expand, Preview collapse keeps the iframe mounted, preference restore,
 * new/switch conversation, URL restore, mobile drawer.
 */

const FRAME = 'iframe[data-testid="sandbox-iframe"]';
const MOBILE_FRAME = '[data-testid="mobile-preview-section"] iframe[data-testid="sandbox-iframe"]';

async function generateApp(page: Page, prompt: string, mode: "desktop" | "mobile" = "desktop"): Promise<void> {
  await page.getByTestId("prompt-input").fill(prompt);
  await page.getByTestId("prompt-send").click();
  if (mode === "desktop") {
    await expect(page.locator(FRAME)).toBeVisible({ timeout: 180_000 });
    await expect(page.frameLocator(FRAME).getByTestId("template-app")).toBeVisible({ timeout: 180_000 });
  } else {
    // On mobile the initial tab is chat; wait only for attachment, not visibility.
    await expect(page.locator(FRAME)).toBeAttached({ timeout: 180_000 });
    await expect(page.frameLocator(FRAME).getByTestId("template-app")).toBeAttached({ timeout: 180_000 });
  }
}

async function seed(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/");
  await generateApp(page, "创建一个布局测试任务清单");
  await page.frameLocator(FRAME).getByTestId("todo-input").fill("布局记录");
  await page.frameLocator(FRAME).getByTestId("todo-add").click();
  await expect(page.frameLocator(FRAME).getByTestId("stat-total")).toHaveText("1");
}

test("左侧对话栏可折叠/展开；右侧 Preview 折叠后 iframe 保持挂载；偏好刷新后恢复", async ({ page }) => {
  await seed(page);
  const frame = page.frameLocator(FRAME);
  await expect(frame.getByTestId("stat-total")).toHaveText("1");

  // Collapse left: the expand button inside the rail must be actually clickable (the list returns after clicking).
  await page.getByLabel("折叠对话侧栏").click();
  await expect(page.getByLabel("展开对话侧栏")).toBeVisible();
  await expect(page.getByTestId("conversation-list")).toHaveCount(0);
  await page.getByLabel("展开对话侧栏").click();
  await expect(page.getByTestId("conversation-list")).toBeVisible();
  await page.getByLabel("折叠对话侧栏").click();
  await expect(page.getByTestId("conversation-list")).toHaveCount(0);
  // Collapse right: verify via the preference-restore path (UI collapse and auto-expand policy are covered by preview-policy unit tests);
  // while collapsed the iframe stays mounted, and clicking "view preview" restores expansion without losing content.
  await page.evaluate(() =>
    localStorage.setItem(
      "qubits.prefs.v1",
      JSON.stringify({ leftSidebar: "collapsed", rightPreview: "collapsed", previewDevice: "desktop" })
    )
  );
  await page.reload();
  await expect(page.frameLocator(FRAME).getByTestId("stat-total")).toHaveText("1", { timeout: 60_000 });
  await expect(page.getByLabel("展开对话侧栏")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("expand-preview").first()).toBeVisible({ timeout: 15_000 });
  expect(await page.locator(FRAME).count()).toBe(1);

  // User explicitly requests "view preview" → expand.
  await page.getByTestId("expand-preview").first().click();
  await expect(page.getByTestId("collapse-preview").first()).toBeVisible();
  await expect(page.frameLocator(FRAME).getByTestId("stat-total")).toHaveText("1");
});

test("新建对话：焦点到输入框、切换线程消息隔离、URL 恢复", async ({ page }) => {
  await seed(page);
  // Remember the first conversation's URL (it has an app).
  const urlA = page.url();
  await page.getByTestId("new-conversation").click();
  await expect(page).toHaveURL(/conversationId=conv-/);
  // New conversation shows the empty-state hint and focuses the input.
  await expect(page.getByText("这是新的对话线程。")).toBeVisible();
  await expect(page.getByTestId("prompt-input")).toBeFocused();

  // One conversation one app: a new conversation has no app yet.
  await expect(page.getByText("还没有应用")).toBeVisible({ timeout: 15_000 });

  // Create another one.
  await page.getByTestId("new-conversation").click();
  await expect(page).not.toHaveURL(urlA);
  // Restore the first thread via URL → its app/preview come back.
  await page.goto(urlA);
  await expect(page.getByTestId("prompt-input")).toBeVisible();
  await expect(page).toHaveURL(urlA);
  await expect(page.frameLocator(FRAME).getByTestId("stat-total")).toHaveText("1", { timeout: 60_000 });
});

test("390px 移动端：抽屉可新建/切换对话，无横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().clearCookies();
  await page.goto("/");
  await generateApp(page, "创建一个布局测试任务清单", "mobile");

  // Switch to the preview tab (mobile segmented nav).
  await page.getByTestId("tab-preview").click();
  await expect(page.getByTestId("mobile-preview-section")).toBeVisible({ timeout: 15_000 });
  const frame = page.frameLocator(MOBILE_FRAME);
  await expect(frame.getByTestId("template-app")).toBeVisible({ timeout: 60_000 });
  await frame.getByTestId("todo-input").fill("布局记录");
  await frame.getByTestId("todo-add").click();
  await expect(frame.getByTestId("stat-total")).toHaveText("1");

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page.getByLabel("打开对话列表").click();
  const drawer = page.getByTestId("conversation-drawer");
  await expect(drawer.getByTestId("conversation-list")).toBeVisible();
  await drawer.getByTestId("new-conversation").click();
  await expect(page).toHaveURL(/conversationId=conv-/);
  // After creating a conversation from the drawer, the preview tab shows the empty state.
  await page.getByTestId("tab-preview").click();
  await expect(page.getByTestId("mobile-preview-section")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("mobile-preview-section").getByText("还没有应用")).toBeVisible({ timeout: 15_000 });
  const overflowAfter = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflowAfter).toBeLessThanOrEqual(0);
});

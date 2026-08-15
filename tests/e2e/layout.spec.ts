import { test, expect, type Page } from "@playwright/test";
import { FRAME, openFixture } from "./fixture";

/**
 * Multi-conversation and collapsible workspace e2e: sidebar collapse/expand, Preview
 * collapse keeps the iframe mounted, preference restore, new/switch conversation, URL
 * restore, and mobile drawer. Assertions are app-shape agnostic.
 */

const MOBILE_FRAME = '[data-testid="mobile-preview-section"] iframe[data-testid="sandbox-iframe"]';

async function seed(page: Page): Promise<void> {
  await page.context().clearCookies();
  await openFixture(page);
}

test("左侧对话栏可折叠/展开；右侧 Preview 折叠后 iframe 保持挂载；偏好刷新后恢复", async ({ page }) => {
  await seed(page);
  const frame = page.frameLocator(FRAME);
  await expect(frame.locator("body .app-shell")).toBeVisible();

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
  await expect(page.frameLocator(FRAME).locator("body .app-shell")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel("展开对话侧栏")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("expand-preview").first()).toBeVisible({ timeout: 15_000 });
  expect(await page.locator(FRAME).count()).toBe(1);

  // User explicitly requests "view preview" → expand.
  await page.getByTestId("expand-preview").first().click();
  await expect(page.getByTestId("collapse-preview").first()).toBeVisible();
  await expect(page.frameLocator(FRAME).locator("body .app-shell")).toBeVisible();
});

test("右侧预览栏可通过左侧把手拖拽调整宽度并持久化", async ({ page }) => {
  await seed(page);
  const aside = page.locator('aside[aria-label="应用预览"]');
  const handle = page.getByTestId("preview-resize-handle");
  await expect(handle).toBeVisible();

  const readWidth = () =>
    aside.evaluate((el) => Math.round(el.getBoundingClientRect().width));

  const startWidth = await readWidth();
  expect(startWidth).toBeGreaterThan(300);

  const box = await handle.boundingBox();
  if (!box) throw new Error("resize handle missing");
  const y = box.y + box.height / 2;
  const x = box.x + box.width / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 140, y, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => readWidth()).toBeGreaterThan(startWidth + 100);
  await page.waitForTimeout(300); // let the width transition finish before snapshotting
  const resized = await readWidth();

  // Preference survives a full reload.
  await page.reload();
  await expect(page.frameLocator(FRAME).locator("body .app-shell")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("preview-resize-handle")).toBeVisible({ timeout: 15_000 });
  expect(await readWidth()).toBe(resized);

  // Double-click restores the default width.
  await page.getByTestId("preview-resize-handle").dblclick();
  await expect.poll(() => readWidth()).toBe(420);
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
  await expect(page.frameLocator(FRAME).locator("body .app-shell")).toBeVisible({ timeout: 60_000 });
});

test("390px 移动端：抽屉可新建/切换对话，无横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.context().clearCookies();
  await openFixture(page, 0, "attached");

  // Switch to the preview tab (mobile segmented nav).
  await page.getByTestId("tab-preview").click();
  await expect(page.getByTestId("mobile-preview-section")).toBeVisible({ timeout: 15_000 });
  const frame = page.frameLocator(MOBILE_FRAME);
  await expect(frame.locator("body .app-shell")).toBeVisible({ timeout: 60_000 });

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

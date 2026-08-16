import { test, expect, type Page } from "@playwright/test";
import { openFixture } from "./fixture";

const LONG_PUBLIC_URL =
  "https://long-generated-preview-domain-for-layout-testing.trycloudflare.com/d/dep-layout-00000001/";

async function mockLiveDeployment(page: Page): Promise<void> {
  await page.route("**/api/deployments?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          deployments: [
            {
              id: "dep-layout-00000001",
              conversationId: "conv-e2e-00000001",
              status: "live",
              url: LONG_PUBLIC_URL,
              createdAt: Date.now(),
              expiresAt: Date.now() + 60 * 60 * 1000,
              stoppedAt: null,
              errorCode: null,
              errorMessage: null,
            },
          ],
          runtime: {
            state: "ready",
            publicBaseUrl: "https://long-generated-preview-domain-for-layout-testing.trycloudflare.com",
            localBaseUrl: "http://127.0.0.1:4321",
            initError: null,
            tunnel: { state: "ready", url: LONG_PUBLIC_URL, error: null },
          },
        },
      }),
    });
  });
}

async function expectDialogFits(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const metrics = await dialog.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    left: element.getBoundingClientRect().left,
    right: element.getBoundingClientRect().right,
    viewportWidth: window.innerWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(metrics.left).toBeGreaterThanOrEqual(0);
  expect(metrics.right).toBeLessThanOrEqual(metrics.viewportWidth);
  await expect(page.getByTestId("deploy-url")).toBeVisible();
  await expect(page.getByRole("button", { name: "复制链接" })).toBeVisible();
  await expect(page.getByRole("button", { name: "打开发布链接" })).toBeVisible();
  await expect(page.getByTestId("deploy-stop")).toBeVisible();
  await expect(page.getByTestId("deploy-button")).toBeVisible();
}

test("发布弹窗在桌面端不横向溢出", async ({ page }) => {
  await mockLiveDeployment(page);
  await openFixture(page);
  await page.getByTestId("deploy-open").click();
  await expectDialogFits(page);
});

test("发布弹窗在移动端保留边距且操作完整可见", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockLiveDeployment(page);
  await openFixture(page, 0, "attached");
  await page.getByTestId("tab-preview").click();
  await page.getByTestId("mobile-preview-section").getByTestId("deploy-open").click();
  await expectDialogFits(page);
});

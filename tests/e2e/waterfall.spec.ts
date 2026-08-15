import { test, expect } from "@playwright/test";
import { openFixture } from "./fixture";

test("瀑布流：工具卡片按阶段折叠为块，展开后可见全部真实工具调用", async ({ page }) => {
  await page.context().clearCookies();
  await openFixture(page);

  // Stage blocks appear (delegations + Alex's real file/build calls grouped by stage).
  await expect(page.getByTestId("tool-stage-group").first()).toBeVisible({ timeout: 30000 });

  // After the run: all blocks collapsed by default.
  await expect(page.getByTestId("workspace-status")).toContainText("就绪", { timeout: 180_000 });
  await expect(page.getByTestId("tool-call-card")).toHaveCount(0);

  // Expand each block: every persisted call is visible and successful.
  const groups = page.getByTestId("tool-stage-group");
  const groupCount = await groups.count();
  expect(groupCount).toBeGreaterThan(0);
  for (let i = 0; i < groupCount; i++) {
    await groups.nth(i).getByTestId("stage-toggle").click();
  }
  expect(await page.getByTestId("tool-call-card").count()).toBeGreaterThan(0);
  const failed = page.getByTestId("tool-call-card").locator('[data-status="failed"]');
  await expect(failed).toHaveCount(0);

  // Clicking again collapses back to the default state.
  for (let i = 0; i < groupCount; i++) {
    await groups.nth(i).getByTestId("stage-toggle").click();
  }
  await expect(page.getByTestId("tool-call-card")).toHaveCount(0);

  // Completion and user messages remain on the timeline.
  await expect(page.getByTestId("user-message").first()).toBeVisible();
  // The preview comes from the real build.
  await expect(page.locator('iframe[data-testid="sandbox-iframe"]')).toBeVisible({ timeout: 180_000 });
});

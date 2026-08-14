import { test, expect } from "@playwright/test";

test("瀑布流：工具卡片按阶段折叠为块，展开后可见全部真实工具调用", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/");
  await page.getByTestId("prompt-input").fill("创建一个个人任务管理器");
  await page.getByTestId("prompt-send").click();

  // Stage blocks appear (delegations + Alex's real file/build calls grouped by stage).
  await expect(page.getByTestId("tool-stage-group").first()).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("tool-stage-group")).toHaveCount(4, { timeout: 180_000 });

  // After the run: all blocks collapsed by default.
  await expect(page.getByText("应用已生成并通过构建、评审与预览").first()).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId("tool-call-card")).toHaveCount(0);

  // Expand each block: all 15 cards visible and successful.
  const groups = page.getByTestId("tool-stage-group");
  for (let i = 0; i < (await groups.count()); i++) {
    await groups.nth(i).getByTestId("stage-toggle").click();
  }
  // Mike: delegate ×4 + render_preview + complete_run；Alex: workspace_init/fs_write×5(manifest/main/App/styles/test)/run_typecheck/run_tests/run_build。
  await expect(page.getByTestId("tool-call-card")).toHaveCount(15);
  const failed = page.getByTestId("tool-call-card").locator('[data-status="failed"]');
  await expect(failed).toHaveCount(0);

  // Clicking again collapses back to the default state.
  for (let i = 0; i < (await groups.count()); i++) {
    await groups.nth(i).getByTestId("stage-toggle").click();
  }
  await expect(page.getByTestId("tool-call-card")).toHaveCount(0);

  // Completion and user messages remain on the timeline.
  await expect(page.getByTestId("user-message").first()).toBeVisible();
  // The preview comes from the real build.
  await expect(page.locator('iframe[data-testid="sandbox-iframe"]')).toBeVisible({ timeout: 180_000 });
});

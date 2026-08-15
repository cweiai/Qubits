import { test, expect } from "@playwright/test";
import { openFixture } from "./fixture";

test("阶段进度：不再展示工具调用，只按阶段展示思维链摘要", async ({ page }) => {
  await page.context().clearCookies();
  await openFixture(page);

  // The phase progress panel is visible and derives its text from staged reasoning summaries.
  await expect(page.getByTestId("stage-progress")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("stage-progress-planning")).toContainText("产品需求与分工已确认");
  await expect(page.getByTestId("stage-progress-coding")).toContainText("应用代码已写入工作区");
  await expect(page.getByTestId("stage-progress-validating")).toContainText("均已通过");
  await expect(page.getByTestId("stage-progress-previewing")).toContainText("预览已通过门禁并提交完成");

  // After the run all four phases are completed.
  await expect(page.getByTestId("workspace-status")).toContainText("就绪", { timeout: 180_000 });
  await expect(page.getByTestId("stage-progress-planning")).toHaveAttribute("data-status", "completed");
  await expect(page.getByTestId("stage-progress-coding")).toHaveAttribute("data-status", "completed");
  await expect(page.getByTestId("stage-progress-validating")).toHaveAttribute("data-status", "completed");
  await expect(page.getByTestId("stage-progress-previewing")).toHaveAttribute("data-status", "completed");

  // Concrete tool calls are no longer rendered anywhere in the timeline.
  await expect(page.getByTestId("tool-call-card")).toHaveCount(0);
  await expect(page.getByTestId("tool-stage-group")).toHaveCount(0);

  // Completion and user messages remain on the timeline.
  await expect(page.getByTestId("user-message").first()).toBeVisible();
  // The preview comes from the real build.
  await expect(page.locator('iframe[data-testid="sandbox-iframe"]')).toBeVisible({ timeout: 180_000 });
});

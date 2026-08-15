import { expect, type Page } from "@playwright/test";

export const E2E_PROJECT_IDS = ["prj-e2e-00000001", "prj-e2e-00000002"] as const;
export const E2E_CONVERSATION_IDS = ["conv-e2e-00000001", "conv-e2e-00000002"] as const;
export const FRAME = 'iframe[data-testid="sandbox-iframe"]';

export async function openFixture(page: Page, index = 0, mode: "visible" | "attached" = "visible"): Promise<void> {
  await page.context().addCookies([
    {
      name: "qubits_project",
      value: E2E_PROJECT_IDS[index],
      url: "http://127.0.0.1:3206",
    },
  ]);
  await page.goto("/?conversationId=" + E2E_CONVERSATION_IDS[index]);
  if (mode === "visible") {
    await expect(page.locator(FRAME)).toBeVisible({ timeout: 60_000 });
    await expect(page.frameLocator(FRAME).locator("body > *").first()).toBeVisible({ timeout: 60_000 });
  } else {
    await expect(page.locator(FRAME)).toBeAttached({ timeout: 60_000 });
    await expect(page.frameLocator(FRAME).locator("body > *").first()).toBeAttached({ timeout: 60_000 });
  }
}

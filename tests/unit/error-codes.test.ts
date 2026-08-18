import { describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import path from "node:path";
import { runMikeOrchestrator } from "@/lib/ai/mike-orchestrator";
import type { AgentEvent } from "@/lib/contracts/agent-events";
import type { AIProvider } from "@/lib/ai/provider";

/**
 * Provider timeout vs user abort must produce DIFFERENT stable error codes:
 * PROVIDER_TIMEOUT comes from the provider itself; USER_ABORTED from the task
 * signal. Neither may surface as a generic "This operation was aborted".
 */

function abortableController(): AbortController {
  return new AbortController();
}

describe("Provider 超时与用户取消", () => {
  it("provider 超时 → PROVIDER_TIMEOUT（不伪装成客户端取消）", async () => {
    const events: AgentEvent[] = [];
    const provider: AIProvider = {
      kind: "mock",
      async generateWithTools() {
        const error = new Error("模型服务请求超时（90 秒），请稍后重试。") as Error & { code?: string };
        error.name = "ProviderError";
        error.code = "PROVIDER_TIMEOUT";
        throw error;
      },
    };
    const result = await runMikeOrchestrator({
      prompt: "超时测试",
      currentManifest: null,
      currentAppId: "test-app-0001",
      currentVersion: 0,
      projectRecords: null,
      emit: (event) => events.push(event),
      providerOverride: provider,
    });
    expect(result.status).toBe("failed");
    const errorEvent = events.find((e) => e.type === "error") as { code?: string; message: string } | undefined;
    expect(errorEvent?.code).toBe("PROVIDER_TIMEOUT");
    expect(errorEvent?.message).not.toMatch(/abort/i);
  });

  it("用户取消 → USER_ABORTED（区别于 PROVIDER_TIMEOUT）", async () => {
    const controller = abortableController();
    const events: AgentEvent[] = [];
    const provider: AIProvider = {
      kind: "mock",
      async generateWithTools(input) {
        input.signal?.addEventListener("abort", () => undefined);
        // Abort mid-flight: reject with an AbortError like a cancelled fetch.
        controller.abort();
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        throw error;
      },
    };
    const result = await runMikeOrchestrator({
      prompt: "取消测试",
      currentManifest: null,
      currentAppId: "test-app-0001",
      currentVersion: 0,
      projectRecords: null,
      emit: (event) => events.push(event),
      signal: controller.signal,
      providerOverride: provider,
    });
    expect(result.status).toBe("failed");
    const errorEvent = events.find((e) => e.type === "error") as { code?: string; message: string } | undefined;
    expect(errorEvent?.code).toBe("USER_ABORTED");
    expect(errorEvent?.message).toContain("USER_ABORTED");
  });

  it("取消后的工作区文件保留（重试不会删除已有文件）", async () => {
    const ws = path.join(process.cwd(), "data", "workspaces", "test-abort-" + Date.now());
    const { initWorkspace } = await import("@/lib/workspace/workspace-manager");
    initWorkspace(ws, { taskId: "task-abort-00000001" });
    try {
      const controller = abortableController();
      const provider: AIProvider = {
        kind: "mock",
        async generateWithTools() {
          controller.abort();
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        },      };
      await runMikeOrchestrator({
        prompt: "取消测试",
        currentManifest: null,
        currentAppId: "test-app-0001",
        currentVersion: 0,
        projectRecords: null,
        emit: () => undefined,
        workspaceDir: ws,
        signal: controller.signal,
        providerOverride: provider,
      });
      // Retries reuse the same workspace: init is idempotent, files remain.
      const { initWorkspace: initAgain } = await import("@/lib/workspace/workspace-manager");
      const info = initAgain(ws, { taskId: "task-abort-00000001" });
      expect(info.seededFrom).toBe("existing");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

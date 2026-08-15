import { afterEach, describe, expect, it } from "vitest";
import { openaiProvider, ProviderError, readMaxOutputTokens, readProviderTimeoutMs, ToolMessageProtocolError } from "@/lib/ai/openai-provider";
import type { GenerateWithToolsInput } from "@/lib/ai/provider";

/**
 * Provider error contract tests — fetch is stubbed globally, NO real model API is
 * called. Covers: network TypeError + ECONNRESET → PROVIDER_NETWORK_ERROR (with
 * sanitized cause code), 429/5xx retried at most twice with backoff, 400/401 never
 * retried, user abort never retried, hard timeout → one bounded retry, and secret
 * sanitization in error messages.
 */

const REAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.QUIBITS_PROVIDER_TIMEOUT_MS;
  delete process.env.QUIBITS_PROVIDER_MAX_TOKENS;
});

function makeInput(overrides: Partial<GenerateWithToolsInput> = {}): GenerateWithToolsInput {
  return {
    system: "sys",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    roleId: "team_leader",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function turnResponse(): Record<string, unknown> {
  return { choices: [{ message: { content: "ok", tool_calls: [] } }] };
}

describe("Provider 错误映射（stub fetch，不调用真实模型）", () => {
  it("按角色分配输出 token，并拒绝越界覆盖值", () => {
    expect(readMaxOutputTokens("engineer")).toBe(16_384);
    expect(readMaxOutputTokens("product_manager")).toBe(4096);
    expect(readMaxOutputTokens("team_leader")).toBe(4096);
    process.env.QUIBITS_PROVIDER_MAX_TOKENS = "16384";
    expect(readMaxOutputTokens("team_leader")).toBe(16_384);
    process.env.QUIBITS_PROVIDER_MAX_TOKENS = "999999";
    expect(readMaxOutputTokens("engineer")).toBe(16_384);
  });

  it("按角色分配 provider 超时，并允许显式全局覆盖", () => {
    expect(readProviderTimeoutMs("engineer")).toBe(300_000);
    expect(readProviderTimeoutMs("product_manager")).toBe(120_000);
    expect(readProviderTimeoutMs("team_leader")).toBe(180_000);
    expect(readProviderTimeoutMs("product_manager")).toBe(120_000);
    process.env.QUIBITS_PROVIDER_TIMEOUT_MS = "45000";
    expect(readProviderTimeoutMs("engineer")).toBe(45_000);
  });

  it("fetch TypeError + ECONNRESET → PROVIDER_NETWORK_ERROR，重试 2 次后抛出并携带脱敏 causeCode", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key-000000000000000000";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      const error = new TypeError("fetch failed");
      (error as NodeJS.ErrnoException).code = "ECONNRESET";
      throw error;
    }) as unknown as typeof fetch;
    await expect(openaiProvider.generateWithTools(makeInput())).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ProviderError);
      const providerError = error as ProviderError;
      expect(providerError.code).toBe("PROVIDER_NETWORK_ERROR");
      expect(providerError.causeCode).toBe("ECONNRESET");
      expect(providerError.message).toContain("ECONNRESET");
      expect(providerError.message).not.toContain("sk-test-key");
      return true;
    });
    expect(calls).toBe(3); // 1 + 2 retries
  });

  it("429 → 有限重试后成功（指数退避 + jitter 路径）", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key-000000000000000000";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls <= 2) return jsonResponse({ error: { message: "rate limited" } }, 429);
      return jsonResponse(turnResponse());
    }) as unknown as typeof fetch;
    const result = await openaiProvider.generateWithTools(makeInput());
    expect(result.content).toBe("ok");
    expect(calls).toBe(3);
  });

  it("503 → PROVIDER_SERVER_ERROR，重试上限内仍失败则抛出稳定错误码", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key-000000000000000000";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({ error: { message: "internal" } }, 503);
    }) as unknown as typeof fetch;
    await expect(openaiProvider.generateWithTools(makeInput())).rejects.toSatisfy((error: unknown) => {
      expect((error as ProviderError).code).toBe("PROVIDER_SERVER_ERROR");
      return true;
    });
    expect(calls).toBe(3);
  });

  it("400 / 401 / 403 不重试，且鉴权错误不带密钥", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key-000000000000000000";
    for (const [status, expectedCode] of [
      [400, "PROVIDER_BAD_REQUEST"],
      [401, "PROVIDER_AUTH_ERROR"],
      [403, "PROVIDER_AUTH_ERROR"],
    ] as const) {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        return jsonResponse({ error: { message: "Authorization: Bearer sk-test-key-000000000000000000 rejected" } }, status);
      }) as unknown as typeof fetch;
      await expect(openaiProvider.generateWithTools(makeInput())).rejects.toSatisfy((error: unknown) => {
        expect((error as ProviderError).code).toBe(expectedCode);
        expect((error as ProviderError).message).not.toContain("sk-test-key");
        return true;
      });
      expect(calls).toBe(1);
    }
  });

  it("402 余额不足映射为计费错误且不重试", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key-000000000000000000";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({ error: { message: "Insufficient Balance" } }, 402);
    }) as unknown as typeof fetch;
    await expect(openaiProvider.generateWithTools(makeInput())).rejects.toSatisfy((error: unknown) => {
      expect((error as ProviderError).code).toBe("PROVIDER_BILLING_ERROR");
      expect((error as ProviderError).message).toContain("余额不足");
      return true;
    });
    expect(calls).toBe(1);
  });

  it("用户 AbortSignal 不重试：AbortError 原样向上传播（CLIENT_ABORTED）", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key-000000000000000000";
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    await expect(openaiProvider.generateWithTools(makeInput({ signal: controller.signal }))).rejects.toSatisfy((error: unknown) => {
      expect((error as Error).name).toBe("AbortError");
      return true;
    });
    expect(calls).toBe(1);
  });

  it("Provider 忽略 AbortSignal 时仍按硬截止时间超时，并只重试一次", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key-000000000000000000";
    process.env.QUIBITS_PROVIDER_TIMEOUT_MS = "80";
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch;
    const startedAt = Date.now();
    await expect(openaiProvider.generateWithTools(makeInput())).rejects.toSatisfy((error: unknown) => {
      expect((error as ProviderError).code).toBe("PROVIDER_TIMEOUT");
      return true;
    });
    expect(calls).toBe(2);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it("非法 tool message 序列在发送前即失败（协议错误，不重试）", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key-000000000000000000";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse(turnResponse());
    }) as unknown as typeof fetch;
    const input = makeInput({
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "tc-1", name: "x", rawArguments: "{}" }] },
        { role: "tool", tool_call_id: "tc-wrong", content: "{}" },
      ],
    });
    await expect(openaiProvider.generateWithTools(input)).rejects.toBeInstanceOf(ToolMessageProtocolError);
    expect(calls).toBe(0);
  });
});

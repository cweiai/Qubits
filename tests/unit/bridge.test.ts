import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxHostBridge } from "@/lib/sandbox/runtime-bridge";
import { makeTaskManifest } from "./fixtures";

/**
 * Host bridge unit tests: handshake, nonce validation, source validation, collection/operation allowlist,
 * duplicate requestId, request forwarding, and timeout.
 */

type MessageListener = (event: MessageEvent) => void;

class FakeHost {
  listeners = new Set<MessageListener>();
  addEventListener(type: "message", listener: MessageListener): void {
    if (type === "message") this.listeners.add(listener);
  }
  removeEventListener(type: "message", listener: MessageListener): void {
    if (type === "message") this.listeners.delete(listener);
  }
  dispatch(event: MessageEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function makeFakeContentWindow(): { postMessage: ReturnType<typeof vi.fn>; window: unknown } {
  return { postMessage: vi.fn(), window: {} };
}

const manifest = makeTaskManifest();

function setup(): {
  host: FakeHost;
  bridge: SandboxHostBridge;
  contentWindow: { postMessage: ReturnType<typeof vi.fn> };
  iframe: unknown;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const host = new FakeHost();
  const contentWindow = makeFakeContentWindow();
  const iframe = { contentWindow } as unknown as HTMLIFrameElement;
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const bridge = new SandboxHostBridge(iframe, {
    nonce: "nonce-12345678",
    appId: "test-app-0001",
    appVersion: 1,
    manifestName: manifest.name,
    sessionId: "sess-test-0001",
    collections: manifest.collections,
  }, host as unknown as Window);
  return { host, bridge, contentWindow, iframe, fetchMock };
}

function handshakeEvent(host: FakeHost, contentWindow: unknown): void {
  const event = new MessageEvent("message", { data: { type: "QUBITS_HANDSHAKE" } });
  // Node's MessageEvent constructor does not accept a custom source; inject it as an own property.
  Object.defineProperty(event, "source", { value: contentWindow });
  host.dispatch(event);
}

function getTransferredPort(contentWindow: { postMessage: ReturnType<typeof vi.fn> }): MessagePort {
  const call = contentWindow.postMessage.mock.calls.find((c) => (c[0] as { type?: string })?.type === "QUBITS_INIT");
  expect(call).toBeDefined();
  const ports = call?.[2] as MessagePort[] | undefined;
  expect(ports).toHaveLength(1);
  return ports![0];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("SandboxHostBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("握手 → 转移 port → QUBITS_READY 后下发 SPEC", async () => {
    const { host, bridge, contentWindow } = setup();
    bridge.attach();
    handshakeEvent(host, contentWindow);
    const port = getTransferredPort(contentWindow);

    const specPromise = new Promise<{ type: string; name?: unknown; collections?: unknown }>((resolve) => {
      port.onmessage = (event: MessageEvent) => resolve(event.data as { type: string; name?: unknown; collections?: unknown });
    });
    port.start();
    port.postMessage({ type: "QUBITS_READY", nonce: "nonce-12345678" });
    const message = await specPromise;
    expect(message.type).toBe("QUBITS_SPEC");
    expect(message.name).toBe(manifest.name);
    expect(Array.isArray(message.collections)).toBe(true);
    bridge.detach();
  });

  it("错误 nonce 被忽略", async () => {
    const { host, bridge, contentWindow, fetchMock } = setup();
    bridge.attach();
    handshakeEvent(host, contentWindow);
    const port = getTransferredPort(contentWindow);
    port.start();
    port.postMessage({ type: "QUBITS_READY", nonce: "wrong-nonce" });
    // No SPEC is sent back (no onmessage listener, so it's silent); a data request with a wrong nonce is also ignored.
    port.postMessage({ type: "QUBITS_DATA_REQUEST", nonce: "wrong-nonce", requestId: "r1", operation: "list", collection: "task" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).not.toHaveBeenCalled();
    bridge.detach();
  });

  it("错误 iframe source 的握手被忽略", async () => {
    const { host, bridge, contentWindow } = setup();
    bridge.attach();
    const otherWindow = makeFakeContentWindow();
    handshakeEvent(host, otherWindow);
    expect(contentWindow.postMessage).not.toHaveBeenCalled();
    bridge.detach();
  });

  it("未声明集合 / 未声明操作在宿主侧被拒绝（不发网络请求）", async () => {
    const { host, bridge, contentWindow, fetchMock } = setup();
    bridge.attach();
    handshakeEvent(host, contentWindow);
    const port = getTransferredPort(contentWindow);
    port.start();

    const responses: Array<{ requestId: string; ok: boolean; error?: { code?: string } }> = [];
    port.onmessage = (event: MessageEvent) => {
      const data = event.data as { type: string; requestId: string; ok: boolean; error?: { code?: string } };
      if (data.type === "QUBITS_DATA_RESPONSE") responses.push(data);
    };

    port.postMessage({ type: "QUBITS_DATA_REQUEST", nonce: "nonce-12345678", requestId: "r1", operation: "list", collection: "undeclared" });
    port.postMessage({ type: "QUBITS_DATA_REQUEST", nonce: "nonce-12345678", requestId: "r2", operation: "drop_table", collection: "task" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(responses).toHaveLength(2);
    expect(responses.find((r) => r.requestId === "r1")?.error?.code).toBe("COLLECTION_NOT_DECLARED");
    expect(responses.find((r) => r.requestId === "r2")?.error?.code).toBe("INVALID_REQUEST");
    bridge.detach();
  });

  it("数据请求转发到后端并回传响应", async () => {
    const { host, bridge, contentWindow, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, data: { records: [{ id: "rec-1", title: "写周报" }] } }), { status: 200 })
    );
    bridge.attach();
    handshakeEvent(host, contentWindow);
    const port = getTransferredPort(contentWindow);
    port.start();

    const responsePromise = new Promise<{ ok: boolean; data?: unknown }>((resolve) => {
      port.onmessage = (event: MessageEvent) => {
        const data = event.data as { type: string; ok: boolean; data?: unknown };
        if (data.type === "QUBITS_DATA_RESPONSE") resolve(data);
      };
    });
    port.postMessage({ type: "QUBITS_DATA_REQUEST", nonce: "nonce-12345678", requestId: "r1", operation: "list", collection: "task" });
    const response = await responsePromise;
    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sandbox/data/list",
      expect.objectContaining({ method: "POST" })
    );
    bridge.detach();
  });

  it("重复 requestId 被拒绝", async () => {
    const { host, bridge, contentWindow, fetchMock } = setup();
    // Keep the first request in flight to create a duplicate window.
    let release!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      })
    );
    bridge.attach();
    handshakeEvent(host, contentWindow);
    const port = getTransferredPort(contentWindow);
    port.start();

    const responses: Array<{ requestId: string; error?: { code?: string } }> = [];
    port.onmessage = (event: MessageEvent) => {
      const data = event.data as { type: string; requestId: string; error?: { code?: string } };
      if (data.type === "QUBITS_DATA_RESPONSE") responses.push(data);
    };
    port.postMessage({ type: "QUBITS_DATA_REQUEST", nonce: "nonce-12345678", requestId: "dup", operation: "list", collection: "task" });
    port.postMessage({ type: "QUBITS_DATA_REQUEST", nonce: "nonce-12345678", requestId: "dup", operation: "list", collection: "task" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(responses.some((r) => r.requestId === "dup" && r.error?.code === "DUPLICATE_REQUEST")).toBe(true);
    release(new Response(JSON.stringify({ ok: true, data: { records: [] } }), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(responses.filter((r) => r.requestId === "dup")).toHaveLength(2);
    bridge.detach();
  });

  it("请求超时返回 TIMEOUT", async () => {
    vi.useFakeTimers();
    const { host, bridge, contentWindow, fetchMock } = setup();
    fetchMock.mockImplementationOnce(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })
    );
    bridge.attach();
    handshakeEvent(host, contentWindow);
    const port = getTransferredPort(contentWindow);
    port.start();

    const responsePromise = new Promise<{ ok: boolean; error?: { code?: string } }>((resolve) => {
      port.onmessage = (event: MessageEvent) => {
        const data = event.data as { type: string; ok: boolean; error?: { code?: string } };
        if (data.type === "QUBITS_DATA_RESPONSE") resolve(data);
      };
    });
    port.postMessage({ type: "QUBITS_DATA_REQUEST", nonce: "nonce-12345678", requestId: "t1", operation: "list", collection: "task" });
    await vi.advanceTimersByTimeAsync(13_000);
    const response = await responsePromise;
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("TIMEOUT");
    bridge.detach();
  });
});

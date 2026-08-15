import {
  SANDBOX_MAX_MESSAGE_BYTES,
  sandboxHandshakeSchema,
  sandboxMessageSchema,
  type SandboxDataRequest,
  type SandboxDataResponse,
} from "./protocol";
import type { CollectionSpec } from "@/lib/contracts/app-spec";

/**
 * Host-side sandbox bridge: manages handshake, MessagePort, request forwarding, and validation.
 * Only accepts handshakes from iframe.contentWindow; every request is validated for nonce / collection / operation,
 * requestIds are deduplicated, timeouts and error responses are handled; on unload the port is closed and pending requests cancelled.
 */

type SandboxConnectionStatus = "connecting" | "ready" | "error";

interface BridgeHost {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

const REQUEST_TIMEOUT_MS = 12_000;
const HANDSHAKE_TIMEOUT_MS = 8_000;

export class SandboxHostBridge {
  private port: MessagePort | null = null;
  private pending = new Map<string, { timer: ReturnType<typeof setTimeout>; controller: AbortController }>();
  private disposed = false;
  private initiated = false;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private iframe: HTMLIFrameElement,
    private options: {
      nonce: string;
      appId: string;
      appVersion: number;
      manifestName: string;
      sessionId: string;
      collections: CollectionSpec[];
      onNotify?: (level: "info" | "error", message: string) => void;
      onStatusChange?: (status: SandboxConnectionStatus, detail?: string) => void;
    },
    private host: BridgeHost = window
  ) {}

  attach(): void {
    this.options.onStatusChange?.("connecting");
    this.host.addEventListener("message", this.onWindowMessage);
  }

  detach(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.host.removeEventListener("message", this.onWindowMessage);
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.controller.abort();
    }
    this.pending.clear();
    try {
      this.port?.close();
    } catch {
      // port may already be closed
    }
    this.port = null;
  }

  /** Host-initiated handshake (fallback after iframe load; mutually exclusive with the iframe handshake, first wins). */
  initiate(): void {
    if (this.disposed || this.initiated) return;
    this.initiated = true;
    this.openChannel();
  }

  private onWindowMessage = (event: MessageEvent): void => {
    // Only accept handshake messages from this iframe.
    if (event.source !== this.iframe.contentWindow) return;
    const message = sandboxHandshakeSchema.safeParse(event.data);
    if (!message.success) return;
    if (this.initiated) return; // Already initiated by the host
    this.initiated = true;
    this.openChannel();
  };

  private openChannel(): void {
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = this.onPortMessage;
    try {
      this.iframe.contentWindow?.postMessage(
        {
          type: "QUBITS_INIT",
          nonce: this.options.nonce,
          appId: this.options.appId,
          appVersion: this.options.appVersion,
        },
        // The sandbox iframe is an opaque origin, so no concrete targetOrigin can be given; source validation relies on event.source.
        "*",
        [channel.port2]
      );
      this.handshakeTimer = setTimeout(() => {
        this.handshakeTimer = null;
        if (this.disposed || this.port === null) return;
        this.options.onStatusChange?.("error", "沙盒数据通道握手超时，请重试");
      }, HANDSHAKE_TIMEOUT_MS);
    } catch {
      this.options.onStatusChange?.("error", "沙盒 iframe 不可用，请重试");
    }
  }

  private onPortMessage = (event: MessageEvent): void => {
    if (this.disposed) return;
    const parsed = sandboxMessageSchema.safeParse(event.data);
    if (!parsed.success) {
      // Structurally invalid data requests must still get a stable response (never silently swallowed).
      const raw = event.data as { type?: unknown; nonce?: unknown; requestId?: unknown } | null;
      if (
        raw &&
        raw.type === "QUBITS_DATA_REQUEST" &&
        typeof raw.requestId === "string" &&
        raw.nonce === this.options.nonce
      ) {
        this.respond(raw.requestId, {
          ok: false,
          error: { code: "INVALID_REQUEST", message: "数据请求结构不合法" },
        });
      }
      return;
    }
    const message = parsed.data;
    // HANDSHAKE/INIT carry no nonce (they only occur at window-level handshake); all other port messages must carry the correct nonce.
    if (message.type !== "QUBITS_HANDSHAKE" && message.type !== "QUBITS_INIT" && message.nonce !== this.options.nonce) {
      return;
    }

    switch (message.type) {
      case "QUBITS_READY": {
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
        this.options.onStatusChange?.("ready");
        this.sendToPort({
          type: "QUBITS_SPEC",
          nonce: this.options.nonce,
          name: this.options.manifestName,
          sessionId: this.options.sessionId,
          collections: this.options.collections,
        });
        break;
      }
      case "QUBITS_DATA_REQUEST":
        void this.handleDataRequest(message);
        break;
      case "QUBITS_NOTIFY":
        this.options.onNotify?.(message.level, message.message);
        break;
      case "QUBITS_HANDSHAKE":
      case "QUBITS_INIT":
      case "QUBITS_SPEC":
      case "QUBITS_DATA_RESPONSE":
        // Host does not expect messages in these directions; ignore.
        break;
    }
  };

  private respond(requestId: string, payload: Omit<SandboxDataResponse, "type" | "nonce" | "requestId">): void {
    if (this.disposed) return;
    try {
      this.port?.postMessage({
        type: "QUBITS_DATA_RESPONSE",
        nonce: this.options.nonce,
        requestId,
        ...payload,
      });
    } catch {
      // port already closed
    }
  }

  private async handleDataRequest(message: SandboxDataRequest): Promise<void> {
    const { requestId, operation, collection, id, query, input, patch } = message;

    // Duplicate requestId: reject immediately.
    if (this.pending.has(requestId)) {
      this.respond(requestId, {
        ok: false,
        error: { code: "DUPLICATE_REQUEST", message: "重复的请求 id，已忽略" },
      });
      return;
    }

    // Collection and operation must be within the current session contract.
    const collectionSpec = this.options.collections.find((c) => c.name === collection);
    if (!collectionSpec) {
      this.respond(requestId, {
        ok: false,
        error: { code: "COLLECTION_NOT_DECLARED", message: `集合「${collection}」未声明` },
      });
      return;
    }
    if (!collectionSpec.allowedOperations.includes(operation)) {
      this.respond(requestId, {
        ok: false,
        error: { code: "OPERATION_NOT_ALLOWED", message: `操作「${operation}」未声明` },
      });
      return;
    }

    // Message size limit
    let size = 0;
    try {
      size = new TextEncoder().encode(JSON.stringify(message)).length;
    } catch {
      size = SANDBOX_MAX_MESSAGE_BYTES + 1;
    }
    if (size > SANDBOX_MAX_MESSAGE_BYTES) {
      this.respond(requestId, {
        ok: false,
        error: { code: "PAYLOAD_TOO_LARGE", message: "请求数据过大" },
      });
      return;
    }

    const endpoint = operation === "list" || operation === "count"
      ? "/api/sandbox/data/list"
      : "/api/sandbox/data/mutate";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    this.pending.set(requestId, { timer, controller });

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: this.options.sessionId,
          operation,
          collection,
          id,
          query,
          input,
          patch,
          requestId,
        }),
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      const body = payload as { ok?: boolean; data?: unknown; error?: { code: string; message: string; requestId?: string } } | null;
      if (response.ok && body?.ok) {
        this.respond(requestId, { ok: true, data: body.data });
      } else {
        this.respond(requestId, {
          ok: false,
          error: body?.error ?? { code: "DB_ERROR", message: "数据服务暂时不可用，请稍后重试。" },
        });
      }
    } catch {
      if (!this.disposed) {
        this.respond(requestId, {
          ok: false,
          error: { code: "TIMEOUT", message: "数据请求超时，请重试。" },
        });
      }
    } finally {
      clearTimeout(timer);
      this.pending.delete(requestId);
    }
  }

  private sendToPort(message: unknown): void {
    try {
      this.port?.postMessage(message);
    } catch {
      // port already closed
    }
  }
}

/**
 * Qubits SDK bridge (trusted template code, maintained by the system — never edited by AI).
 *
 * The generated app runs inside an opaque-origin iframe with no network, no same-origin
 * privileges, and no access to the host page. All data operations go through the
 * MessageChannel handshake below to the host, which re-validates every request server-side:
 *
 *   iframe  → QUBITS_HANDSHAKE (window.postMessage, host validates event.source)
 *   host    → QUBITS_INIT (nonce + transferred MessagePort)
 *   iframe  → QUBITS_READY (over the port)
 *   host    → QUBITS_SPEC (app name + session info)
 *   iframe  ⇄ QUBITS_DATA_REQUEST / QUBITS_DATA_RESPONSE (over the port, requestId-matched)
 */

type DataOperation = "list" | "count" | "create" | "update" | "delete";

export interface QubitsError {
  code: string;
  message: string;
  requestId?: string;
}

export interface QubitsAppContext {
  appId: string;
  appVersion: number;
  name: string;
}

export interface QubitsDataApi {
  list(collection: string, query?: unknown): Promise<unknown[]>;
  count(collection: string, query?: unknown): Promise<number>;
  create(collection: string, input: unknown): Promise<unknown>;
  update(collection: string, id: string, patch: unknown): Promise<unknown>;
  delete(collection: string, id: string): Promise<unknown>;
}

export interface QubitsApi {
  data: QubitsDataApi;
  app: { getContext(): QubitsAppContext };
}

const MAX_MESSAGE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

let port: MessagePort | null = null;
let nonce = "";
let appContext: QubitsAppContext = { appId: "", appVersion: 0, name: "" };

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: QubitsError) => void;
  timer: number;
}

const pending = new Map<string, PendingEntry>();

// The host initiates the handshake right after the iframe's load event, while the app
// may render and issue its first data request before QUBITS_INIT arrives. Requests wait
// for readiness instead of failing immediately (with a hard timeout as the fallback).
let readyResolve: (() => void) | null = null;
const readyPromise = new Promise<void>((resolve) => {
  readyResolve = resolve;
});

function notifyReady(): void {
  if (readyResolve) {
    readyResolve();
    readyResolve = null;
  }
}

function waitForReady(timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject({ code: "NOT_CONNECTED", message: "沙盒数据通道尚未连接，请稍后重试" } as QubitsError);
    }, timeoutMs);
    void readyPromise.then(() => {
      window.clearTimeout(timer);
      resolve();
    });
  });
}

function randomRequestId(): string {
  const prefix = "rq-";
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return prefix + crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  return prefix + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

type GuardedWindow = Window & {
  __QUBITS_POST_MESSAGE_GUARD__?: boolean;
  __QUBITS_REAL_PARENT__?: Window;
  __QUBITS_REAL_TOP__?: Window;
};

/**
 * The route may have already installed a guard for legacy bundles; when it has, it
 * also stores the real (non-proxied) parent/top WindowProxy references here so the
 * SDK can keep validating event.source and handshakes against the real objects.
 */
const realParentWindow: Window = (window as GuardedWindow).__QUBITS_REAL_PARENT__ ?? window.parent;
const realTopWindow: Window = (window as GuardedWindow).__QUBITS_REAL_TOP__ ?? window.top ?? window;

function normalizedPostMessage(
  target: Window,
  message: unknown,
  targetOriginOrOptions?: string | WindowPostMessageOptions,
  transfer?: Transferable[]
): void {
  if (typeof targetOriginOrOptions === "object" && targetOriginOrOptions !== null) {
    const options: WindowPostMessageOptions = {
      ...targetOriginOrOptions,
      targetOrigin: normalizeTargetOrigin(targetOriginOrOptions.targetOrigin),
    };
    target.postMessage(message, options);
    return;
  }
  const targetOrigin = normalizeTargetOrigin(targetOriginOrOptions);
  target.postMessage(message, targetOrigin, transfer);
}

function normalizeTargetOrigin(value: unknown): string {
  if (value === "*") return "*";
  if (typeof value !== "string" || value.length === 0) return "*";
  try {
    const url = new URL(value);
    return url.origin === value ? value : "*";
  } catch {
    return "*";
  }
}

/**
 * WebKit throws `SyntaxError: The string did not match the expected pattern.` when
 * `postMessage` is called without a valid targetOrigin. Normalize missing/empty
 * origins to "*" for `window.postMessage` and, via a WindowProxy proxy, also for
 * `parent.postMessage` / `top.postMessage`. App code therefore cannot crash the
 * preview through a one-argument postMessage call.
 */
function installPostMessageGuard(): void {
  const guardedWindow = window as GuardedWindow;
  try {
    if (guardedWindow.__QUBITS_POST_MESSAGE_GUARD__) return;
    guardedWindow.__QUBITS_POST_MESSAGE_GUARD__ = true;
    guardedWindow.__QUBITS_REAL_PARENT__ = realParentWindow;
    guardedWindow.__QUBITS_REAL_TOP__ = realTopWindow;

    const originalPostMessage = window.postMessage.bind(window);
    const guardedWindowPost = function (
      message: unknown,
      targetOriginOrOptions?: string | WindowPostMessageOptions,
      transfer?: Transferable[]
    ): void {
      if (typeof targetOriginOrOptions === "object" && targetOriginOrOptions !== null) {
        const options: WindowPostMessageOptions = {
          ...targetOriginOrOptions,
          targetOrigin: normalizeTargetOrigin(targetOriginOrOptions.targetOrigin),
        };
        originalPostMessage(message, options);
        return;
      }
      const targetOrigin = normalizeTargetOrigin(targetOriginOrOptions);
      originalPostMessage(message, targetOrigin, transfer);
    };
    window.postMessage = guardedWindowPost as typeof window.postMessage;

    const proxyWindow = (real: Window): Window =>
      new Proxy(real, {
        get(target, property) {
          if (property === "postMessage") {
            return function (
              message: unknown,
              targetOriginOrOptions?: string | WindowPostMessageOptions,
              transfer?: Transferable[]
            ): void {
              normalizedPostMessage(target, message, targetOriginOrOptions, transfer);
            };
          }
          try {
            const value = (target as unknown as Record<string | symbol, unknown>)[property];
            return typeof value === "function"
              ? (value as (...args: unknown[]) => unknown).bind(target)
              : value;
          } catch {
            return undefined;
          }
        },
      }) as Window;

    try {
      Object.defineProperty(guardedWindow, "parent", {
        configurable: true,
        get: () => proxyWindow(realParentWindow),
      });
    } catch {
      // parent already shadowed or read-only; window.postMessage guard still applies.
    }
    try {
      Object.defineProperty(guardedWindow, "top", {
        configurable: true,
        get: () => proxyWindow(realTopWindow),
      });
    } catch {
      // top already shadowed or read-only; window.postMessage guard still applies.
    }
  } catch {
    // A read-only postMessage is unusual; the SDK path below still works.
  }
}

function sendWindow(message: unknown): void {
  try {
    realParentWindow.postMessage(message, "*");
  } catch {
    // parent unavailable
  }
}

function sendPort(message: unknown): void {
  try {
    port?.postMessage(message);
  } catch {
    // port closed
  }
}

function makeError(error?: QubitsError | null): QubitsError {
  if (error && typeof error.code === "string" && typeof error.message === "string") {
    return { code: error.code.slice(0, 60), message: error.message.slice(0, 300), requestId: error.requestId };
  }
  return { code: "DATA_ERROR", message: "数据服务返回异常，请重试" };
}

function onPortMessage(event: MessageEvent): void {
  const message = (event.data ?? {}) as {
    type?: string;
    nonce?: string;
    name?: string;
    sessionId?: string;
    requestId?: string;
    ok?: boolean;
    data?: unknown;
    error?: QubitsError | null;
  };
  if (!message || typeof message !== "object" || message.nonce !== nonce) return;
  switch (message.type) {
    case "QUBITS_SPEC": {
      if (typeof message.name === "string") {
        appContext = { ...appContext, name: message.name };
      }
      return;
    }
    case "QUBITS_DATA_RESPONSE": {
      if (typeof message.requestId !== "string") return;
      const entry = pending.get(message.requestId);
      if (!entry) return;
      pending.delete(message.requestId);
      window.clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.data);
      else entry.reject(makeError(message.error));
      return;
    }
    default:
      return;
  }
}

function onWindowMessage(event: MessageEvent): void {
  if (event.source !== realParentWindow) return; // only accept messages from the host page
  const data = (event.data ?? {}) as { type?: string; nonce?: string; appId?: string; appVersion?: number };
  if (!data || data.type !== "QUBITS_INIT") return;
  if (typeof data.nonce !== "string" || data.nonce.length < 8) return;
  nonce = data.nonce;
  appContext = {
    appId: typeof data.appId === "string" ? data.appId.slice(0, 128) : "",
    appVersion: typeof data.appVersion === "number" && data.appVersion > 0 ? data.appVersion : 0,
    name: appContext.name,
  };
  const transferred = (event as MessageEvent).ports?.[0];
  if (!transferred) return;
  port = transferred;
  port.onmessage = onPortMessage;
  notifyReady();
  sendPort({ type: "QUBITS_READY", nonce });
}

async function request(operation: DataOperation, collection: string, payload: Record<string, unknown>): Promise<unknown> {
  if (!port) {
    try {
      await waitForReady(REQUEST_TIMEOUT_MS);
    } catch (error) {
      return Promise.reject(error as QubitsError);
    }
  }
  if (!port) {
    return Promise.reject({ code: "NOT_CONNECTED", message: "沙盒数据通道尚未连接，请稍后重试" } as QubitsError);
  }
  const requestId = randomRequestId();
  const message = { type: "QUBITS_DATA_REQUEST", nonce, requestId, operation, collection, ...payload };
  let size = 0;
  try {
    size = new TextEncoder().encode(JSON.stringify(message)).length;
  } catch {
    size = MAX_MESSAGE_BYTES + 1;
  }
  if (size > MAX_MESSAGE_BYTES) {
    return Promise.reject({ code: "PAYLOAD_TOO_LARGE", message: "请求数据过大", requestId } as QubitsError);
  }
  return new Promise<unknown>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(requestId);
      reject({ code: "TIMEOUT", message: "数据请求超时，请重试", requestId } as QubitsError);
    }, REQUEST_TIMEOUT_MS);
    pending.set(requestId, { resolve, reject, timer });
    sendPort(message);
  });
}

function unwrapList(value: unknown): unknown[] {
  if (typeof value === "object" && value !== null && Array.isArray((value as { records?: unknown }).records)) {
    return (value as { records: unknown[] }).records;
  }
  return [];
}

function unwrapRecord(value: unknown): unknown {
  if (typeof value === "object" && value !== null && (value as { record?: unknown }).record) {
    return (value as { record: unknown }).record;
  }
  return value;
}

function unwrapCount(value: unknown): number {
  const record = value as { count?: unknown };
  const num = Number(record?.count);
  return Number.isFinite(num) ? num : 0;
}

const qubitsData: QubitsDataApi = {
  list: (collection, query) => request("list", collection, { query }).then(unwrapList),
  count: (collection, query) => request("count", collection, { query }).then(unwrapCount),
  create: (collection, input) => request("create", collection, { input }).then(unwrapRecord),
  update: (collection, id, patch) => request("update", collection, { id, patch }).then(unwrapRecord),
  delete: (collection, id) => request("delete", collection, { id }),
};

const qubits: QubitsApi = {
  data: qubitsData,
  app: { getContext: () => ({ ...appContext }) },
};

declare global {
  interface Window {
    Qubits: QubitsApi;
  }
}

installPostMessageGuard();
window.Qubits = qubits;
window.addEventListener("message", onWindowMessage);

// Retry the window-level handshake a few times in case the host missed the first one
// (opaque-origin iframe load races are common in production).
let handshakeAttempts = 0;
const MAX_HANDSHAKE_ATTEMPTS = 5;
const HANDSHAKE_RETRY_MS = 600;
function sendHandshake(): void {
  if (port || handshakeAttempts >= MAX_HANDSHAKE_ATTEMPTS) return;
  handshakeAttempts++;
  sendWindow({ type: "QUBITS_HANDSHAKE" });
  window.setTimeout(sendHandshake, HANDSHAKE_RETRY_MS);
}
sendHandshake();

export default qubits;

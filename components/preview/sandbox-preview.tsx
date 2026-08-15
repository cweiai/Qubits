"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import type { QubitsManifest } from "@/lib/contracts/manifest";
import type { CollectionSpec } from "@/lib/contracts/app-spec";
import { SandboxHostBridge } from "@/lib/sandbox/runtime-bridge";
import { cn } from "@/lib/utils";

/**
 * Renders the REAL built preview bundle inside a sandboxed iframe
 * (sandbox="allow-scripts", no allow-same-origin): the iframe loads
 * /api/projects/current/preview (the persisted preview_bundle artifact) and the
 * manifest contract + session info travel over a MessageChannel — never inlined.
 */

type SandboxUiPhase = "idle" | "session" | "connecting" | "ready" | "error";

interface SandboxUiStatus {
  phase: SandboxUiPhase;
  message?: string | null;
  notice?: { level: "info" | "error"; message: string } | null;
}

interface SandboxSessionInfo {
  sessionId: string;
  appId: string;
  appVersion: number;
  collections: CollectionSpec[];
}

export function SandboxPreview({
  manifest,
  previewVersion,
  conversationId,
  device,
  refreshTick,
  onStatusChange,
}: {
  manifest: QubitsManifest;
  previewVersion: number;
  /** Conversation scope for the session and the preview artifact. */
  conversationId: string;
  device: "desktop" | "mobile";
  refreshTick: number;
  onStatusChange?: (status: SandboxUiStatus) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<SandboxHostBridge | null>(null);
  const nonceRef = useRef("");
  const [session, setSession] = useState<SandboxSessionInfo | null>(null);
  const [phase, setPhase] = useState<SandboxUiPhase>("idle");
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ level: "info" | "error"; message: string } | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  const report = useCallback(
    (next: SandboxUiStatus) => {
      setPhase(next.phase);
      if (next.message !== undefined) setSessionError(next.message);
      if (next.notice !== undefined) setNotice(next.notice);
      onStatusChange?.(next);
    },
    [onStatusChange]
  );

  // Rebuild the sandbox session when the manifest version or manual refresh changes
  useEffect(() => {
    let cancelled = false;
    setSession(null);
    setNotice(null);
    report({ phase: "session", message: null, notice: null });
    void (async () => {
      try {
        const response = await fetch("/api/sandbox/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ manifest, conversationId }),
        });
        const payload: unknown = await response.json().catch(() => null);
        const body = payload as
          | { ok?: boolean; data?: SandboxSessionInfo & { expiresAt?: number }; error?: { message?: string } }
          | null;
        if (!response.ok || !body?.ok || !body.data) {
          if (!cancelled) {
            report({
              phase: "error",
              message: body?.error?.message ?? "无法创建沙盒会话，请稍后重试",
              notice: null,
            });
          }
          return;
        }
        if (cancelled) return;
        nonceRef.current = crypto.randomUUID();
        setSession({
          sessionId: body.data.sessionId,
          appId: body.data.appId,
          appVersion: body.data.appVersion,
          collections: body.data.collections,
        });
        report({ phase: "connecting", message: null, notice: null });
      } catch {
        if (!cancelled) {
          report({ phase: "error", message: "无法连接数据服务，请检查服务端后重试", notice: null });
        }
      }
    })();
    return () => {
      cancelled = true;
      bridgeRef.current?.detach();
      bridgeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest.name, previewVersion, conversationId, refreshTick, retryTick, report]);

  const onIframeLoad = useCallback(() => {
    bridgeRef.current?.detach();
    const iframe = iframeRef.current;
    if (!iframe || !session || !nonceRef.current) return;
    const bridge = new SandboxHostBridge(iframe, {
      nonce: nonceRef.current,
      appId: session.appId,
      appVersion: session.appVersion,
      manifestName: manifest.name,
      sessionId: session.sessionId,
      collections: session.collections,
      onNotify: (level, message) => {
        report({ phase: "ready", notice: { level, message } });
      },
      onStatusChange: (status, detail) => {
        report({
          phase: status === "ready" ? "ready" : status === "error" ? "error" : "connecting",
          message: status === "error" ? detail ?? "沙盒数据通道握手失败，请重试" : null,
          notice: null,
        });
      },
    });
    bridgeRef.current = bridge;
    bridge.attach();
    bridge.initiate();
  }, [session, manifest.name, report]);

  return (
    <div className="overflow-hidden rounded-lg border bg-white" data-testid="sandbox-preview">
      <div className="flex items-center gap-2 border-b bg-zinc-50 px-3 py-1.5 text-[11px] text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
        <span className="hidden sm:inline">真实构建产物 · 受限沙盒 · 无同源权限 · 无网络 · 数据经受控 API 写入后端</span>
        <span className="sm:hidden">受限沙盒</span>
        <span className="ml-auto flex items-center gap-1.5" data-testid="sandbox-phase">
          <PhaseBadge phase={phase} />
          {notice ? (
            <span className={cn("max-w-[220px] truncate", notice.level === "error" ? "text-red-600" : "text-emerald-700")}>
              {notice.message}
            </span>
          ) : null}
        </span>
      </div>
      {sessionError ? (
        <div className="m-3 rounded-md border border-red-200 bg-red-50 p-3 text-center text-xs text-red-700" data-testid="sandbox-session-error">
          <p>{sessionError}</p>
          <button
            type="button"
            onClick={() => setRetryTick((tick) => tick + 1)}
            className="mt-2 rounded-md border border-red-300 bg-white px-3 py-1 font-medium hover:bg-red-100"
          >
            重试
          </button>
        </div>
      ) : null}
      {session ? (
        <iframe
          ref={iframeRef}
          key={`${session.sessionId}-${previewVersion}-${refreshTick}`}
          title={manifest.name}
          sandbox="allow-scripts"
          src={`/api/projects/current/preview?conversationId=${encodeURIComponent(conversationId)}&v=${previewVersion}&t=${refreshTick}`}
          referrerPolicy="no-referrer"
          onLoad={onIframeLoad}
          data-testid="sandbox-iframe"
          aria-label="应用预览沙盒"
          className={cn(
            "block w-full border-0 bg-white",
            device === "mobile" ? "mx-auto h-[640px] max-w-[390px]" : "h-[calc(100vh-260px)] min-h-[480px]"
          )}
        />
      ) : phase === "error" ? null : (
        <div className="flex h-48 flex-col items-center justify-center gap-2">
          <Loader2 className="h-5 w-5 animate-spin text-sky-600" />
          <p className="text-xs text-muted-foreground">正在创建沙盒会话…</p>
        </div>
      )}
    </div>
  );
}

function PhaseBadge({ phase }: { phase: SandboxUiPhase }) {
  const tone: Record<SandboxUiPhase, string> = {
    idle: "border-zinc-200 bg-zinc-50 text-zinc-500",
    session: "border-amber-200 bg-amber-50 text-amber-700",
    connecting: "border-amber-200 bg-amber-50 text-amber-700",
    ready: "border-emerald-200 bg-emerald-50 text-emerald-700",
    error: "border-red-200 bg-red-50 text-red-700",
  };
  const label: Record<SandboxUiPhase, string> = {
    idle: "未连接",
    session: "创建会话中",
    connecting: "连接中",
    ready: "沙盒已连接",
    error: "沙盒错误",
  };
  return (
    <span className={cn("rounded-md border px-1.5 py-0.5 font-medium", tone[phase])}>{label[phase]}</span>
  );
}

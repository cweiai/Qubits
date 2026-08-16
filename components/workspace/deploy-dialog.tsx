"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Globe, Loader2, Rocket, Square, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, friendlyError, type DeployListData, type DeploymentJson } from "@/lib/workspace/api";
import { cn } from "@/lib/utils";

/**
 * 一键上线 dialog: deploys the conversation's current built bundle to a hardened
 * Docker container and exposes it through the deploy router / Cloudflare quick tunnel.
 * Shows the live public URL with copy/open, expiry countdown, manual takedown and
 * deployment history.
 */

const STATUS_META: Record<DeploymentJson["status"], { label: string; tone: string }> = {
  starting: { label: "启动中", tone: "border-amber-200 bg-amber-50 text-amber-700" },
  live: { label: "在线", tone: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  stopped: { label: "已下线", tone: "border-zinc-200 bg-zinc-50 text-zinc-500" },
  expired: { label: "已到期", tone: "border-zinc-200 bg-zinc-50 text-zinc-500" },
  failed: { label: "失败", tone: "border-red-200 bg-red-50 text-red-700" },
};

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  if (hours > 0) return hours + ":" + pad(minutes) + ":" + pad(seconds);
  return pad(minutes) + ":" + pad(seconds);
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function TunnelBanner({ data }: { data: DeployListData | null }) {
  const tunnel = data?.runtime.tunnel ?? null;
  if (!data) {
    return (
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        <span>正在读取发布状态…</span>
      </div>
    );
  }
  if (!tunnel || data.runtime.state === "stopped") {
    return (
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-muted-foreground">
        <WifiOff className="h-3.5 w-3.5 shrink-0" />
        <span>公网通道未启动，发布时将自动建立。</span>
      </div>
    );
  }
  if (tunnel.state === "ready" && data.runtime.publicBaseUrl) {
    return (
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
        <Globe className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">公网通道已就绪 · {data.runtime.publicBaseUrl.replace(/^https:\/\//, "")}</span>
      </div>
    );
  }
  if (tunnel.state === "disabled") {
    return (
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        <WifiOff className="h-3.5 w-3.5 shrink-0" />
        <span>公网隧道已关闭（DEPLOY_PUBLIC_TUNNEL=0），仅提供本地链接。</span>
      </div>
    );
  }
  if (tunnel.state === "error") {
    return (
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
        <WifiOff className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 break-words">{tunnel.error ?? "公网通道不可用"}</span>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      <span>公网通道建立中…</span>
    </div>
  );
}

export function DeployDialog({
  open,
  onOpenChange,
  conversationId,
  hasPreview,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string | null;
  hasPreview: boolean;
}) {
  const [data, setData] = useState<DeployListData | null>(null);
  const [busy, setBusy] = useState<"idle" | "deploying" | "stopping">("idle");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    if (!conversationId) return;
    try {
      setData(await api.listDeployments(conversationId));
      setError(null);
    } catch (err) {
      setError(friendlyError(err));
    }
  }, [conversationId]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => void refresh(), 8000);
    return () => {
      clearInterval(clock);
      clearInterval(poll);
    };
  }, [open, refresh]);

  const live = data?.deployments.find((d) => d.status === "live") ?? null;
  const past = data?.deployments.filter((d) => d.status !== "live") ?? [];

  const deploy = useCallback(async () => {
    if (!conversationId || busy !== "idle") return;
    setBusy("deploying");
    setError(null);
    try {
      const result = await api.deployConversation(conversationId);
      setData((prev) => ({
        deployments: [
          result.deployment,
          ...(prev?.deployments.filter((d) => d.id !== result.deployment.id) ?? []),
        ],
        runtime: result.runtime,
      }));
    } catch (err) {
      setError(friendlyError(err));
      void refresh();
    } finally {
      setBusy("idle");
    }
  }, [conversationId, busy, refresh]);

  const stop = useCallback(
    async (deploymentId: string) => {
      if (busy !== "idle") return;
      setBusy("stopping");
      setError(null);
      try {
        await api.stopDeployment(deploymentId);
        setData((prev) =>
          prev
            ? {
                ...prev,
                deployments: prev.deployments.map((d) =>
                  d.id === deploymentId ? { ...d, status: "stopped" as const, stoppedAt: Date.now(), url: null } : d
                ),
              }
            : prev
        );
      } catch (err) {
        setError(friendlyError(err));
        void refresh();
      } finally {
        setBusy("idle");
      }
    },
    [busy, refresh]
  );

  const copyUrl = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("复制失败，请手动选择链接复制");
    }
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-w-xl grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-4 py-4 pr-12 sm:px-5">
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="h-4 w-4 text-sky-600" />
            发布应用
          </DialogTitle>
          <DialogDescription className="text-xs leading-5 sm:text-sm">
            将当前版本发布为可分享的临时链接。
          </DialogDescription>
        </DialogHeader>

        <div className="qubits-scroll min-h-0 min-w-0 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
          <TunnelBanner data={data} />

          {live ? (
            <section className="min-w-0 rounded-md border border-emerald-200 bg-white p-3" data-testid="deploy-live-card">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className={cn("shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-medium", STATUS_META.live.tone)}>
                  在线
                </span>
                <span className="min-w-0 text-xs leading-5 text-muted-foreground">
                  剩余 {formatRemaining(live.expiresAt - now)} · {formatTime(live.expiresAt)} 自动下线
                </span>
              </div>
              <div className="mt-3 grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] gap-2">
                <code
                  className="min-w-0 select-all truncate rounded-md border bg-zinc-50 px-2.5 py-2 font-mono text-xs"
                  data-testid="deploy-url"
                  title={live.url ?? undefined}
                >
                  {live.url ?? "—"}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => live.url && void copyUrl(live.url)}
                  disabled={!live.url}
                  aria-label={copied ? "已复制链接" : "复制链接"}
                  title={copied ? "已复制" : "复制链接"}
                >
                  {copied ? <Check className="text-emerald-600" /> : <Copy />}
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  disabled={!live.url}
                  aria-label="打开发布链接"
                  title="在新窗口打开"
                  onClick={() => {
                    if (live.url) window.open(live.url, "_blank", "noopener");
                  }}
                >
                  <ExternalLink />
                </Button>
              </div>
              <div className="mt-3 flex flex-col gap-3 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="min-w-0 text-[11px] leading-4 text-muted-foreground">访问者共享当前应用的数据。</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800 sm:self-auto"
                  onClick={() => void stop(live.id)}
                  disabled={busy !== "idle"}
                  data-testid="deploy-stop"
                >
                  <Square />
                  下线
                </Button>
              </div>
            </section>
          ) : null}

          {error ? (
            <div className="break-words rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700" data-testid="deploy-error">
              {error}
            </div>
          ) : null}

          {past.length > 0 ? (
            <section className="min-w-0 border-t pt-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">历史发布</p>
              <ul className="divide-y rounded-md border bg-white px-3">
                {past.map((d) => (
                  <li key={d.id} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 py-2 text-xs text-muted-foreground">
                    <span className={cn("shrink-0 rounded border px-1 py-0.5 text-[10px] font-medium", STATUS_META[d.status].tone)}>
                      {STATUS_META[d.status].label}
                    </span>
                    <span className="min-w-0 truncate font-mono">{d.id}</span>
                    <span className="col-span-2 break-words text-[11px] leading-4">
                      {formatTime(d.createdAt)} 发布{d.errorMessage ? " · " + d.errorMessage : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <div className="min-w-0 border-t bg-zinc-50 px-4 py-4 sm:px-5">
          <Button onClick={() => void deploy()} disabled={!hasPreview || busy !== "idle"} className="w-full" data-testid="deploy-button">
            {busy === "deploying" ? (
              <>
                <Loader2 className="animate-spin" />
                正在发布…
              </>
            ) : busy === "stopping" ? (
              <>
                <Loader2 className="animate-spin" />
                正在下线…
              </>
            ) : (
              <>
                <Rocket />
                {live ? "发布新版本" : "发布当前版本"}
              </>
            )}
          </Button>
          <p className="mt-2 text-center text-[11px] leading-4 text-muted-foreground">
            {hasPreview ? "临时链接在本机 Qubits 运行期间有效。" : "当前对话还没有可发布的应用。"}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

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
  if (!data || !tunnel || data.runtime.state === "stopped") {
    return (
      <div className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-muted-foreground">
        <WifiOff className="h-3.5 w-3.5 shrink-0" />
        <span>公网通道未启动，点击「上线」时自动建立。</span>
      </div>
    );
  }
  if (tunnel.state === "ready" && data.runtime.publicBaseUrl) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
        <Globe className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">公网通道已就绪 · {data.runtime.publicBaseUrl.replace(/^https:\/\//, "")}</span>
      </div>
    );
  }
  if (tunnel.state === "disabled") {
    return (
      <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        <WifiOff className="h-3.5 w-3.5 shrink-0" />
        <span>公网隧道已关闭（DEPLOY_PUBLIC_TUNNEL=0），仅提供本地链接。</span>
      </div>
    );
  }
  if (tunnel.state === "error") {
    return (
      <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
        <WifiOff className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 break-words">{tunnel.error ?? "公网通道不可用"}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
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
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="h-4 w-4 text-sky-600" />
            一键上线
          </DialogTitle>
          <DialogDescription>
            把当前应用部署到独立 Docker 容器，并分配一个可分享的公网临时链接。
          </DialogDescription>
        </DialogHeader>

        <TunnelBanner data={data} />

        {live ? (
          <div className="rounded-md border border-emerald-200 bg-white p-3" data-testid="deploy-live-card">
            <div className="flex items-center gap-2">
              <span className={cn("rounded-md border px-1.5 py-0.5 text-[11px] font-medium", STATUS_META.live.tone)}>
                在线
              </span>
              <span className="text-xs text-muted-foreground">
                到期自动下线 · 剩余 {formatRemaining(live.expiresAt - now)}（{formatTime(live.expiresAt)}）
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <code className="qubits-scroll min-w-0 flex-1 truncate rounded-md border bg-zinc-50 px-2 py-1.5 font-mono text-xs" data-testid="deploy-url">
                {live.url ?? "—"}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => live.url && void copyUrl(live.url)}
                disabled={!live.url}
                title="复制链接"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                复制
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!live.url}
                title="在新窗口打开"
                onClick={() => {
                  if (live.url) window.open(live.url, "_blank", "noopener");
                }}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                打开
              </Button>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <p className="text-[11px] text-muted-foreground">所有打开链接的人共享同一份数据（写入后端数据库）。</p>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void stop(live.id)}
                disabled={busy !== "idle"}
                data-testid="deploy-stop"
              >
                <Square className="h-3.5 w-3.5" />
                下线
              </Button>
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" data-testid="deploy-error">
            {error}
          </div>
        ) : null}

        <Button onClick={() => void deploy()} disabled={!hasPreview || busy !== "idle"} className="w-full" data-testid="deploy-button">
          {busy === "deploying" ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              正在构建容器并建立公网通道…
            </>
          ) : busy === "stopping" ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              正在下线…
            </>
          ) : (
            <>
              <Rocket className="h-4 w-4" />
              {live ? "上线新版本（替换当前链接）" : "上线当前版本"}
            </>
          )}
        </Button>
        {!hasPreview ? (
          <p className="text-center text-xs text-muted-foreground">当前对话还没有可上线的应用，先在左侧让 AI 生成一版。</p>
        ) : null}

        {past.length > 0 ? (
          <div className="border-t pt-2">
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">历史部署</p>
            <ul className="space-y-1">
              {past.map((d) => (
                <li key={d.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className={cn("rounded border px-1 py-0.5 text-[10px] font-medium", STATUS_META[d.status].tone)}>
                    {STATUS_META[d.status].label}
                  </span>
                  <span className="truncate font-mono">{d.id}</span>
                  <span className="ml-auto shrink-0">
                    {formatTime(d.createdAt)}上线
                    {d.errorMessage ? " · " + d.errorMessage : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          临时链接说明：随机公网域名，仅在本机 Qubits 服务运行期间有效；服务重启后链接自动失效，需重新上线。部署应用运行在独立
          Docker 容器中（只读、非 root、资源受限、仅回环端口）。
        </p>
      </DialogContent>
    </Dialog>
  );
}

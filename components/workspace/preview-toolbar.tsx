"use client";

import { Monitor, RotateCw, Smartphone } from "lucide-react";
import { useWorkspace } from "@/lib/state/workspace-provider";
import { cn } from "@/lib/utils";

export function PreviewToolbar() {
  const { state, parsedManifest, setPreviewDevice, refreshPreview } = useWorkspace();
  const device = state.prefs.previewDevice;

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b bg-white px-3">
      <div className="min-w-0 flex-1">
        <span className="truncate text-sm font-medium" data-testid="preview-title">
          {parsedManifest?.ok ? parsedManifest.manifest.name : "暂无应用"}
        </span>
        {parsedManifest?.ok ? (
          <span className="ml-2 hidden text-xs text-muted-foreground sm:inline">
            v{state.previewVersion} · 真实构建产物 · 数据入库
          </span>
        ) : null}
        {parsedManifest && !parsedManifest.ok ? (
          <span className="ml-2 text-xs text-red-600">manifest 校验失败</span>
        ) : null}
      </div>
      <div className="flex items-center gap-1 rounded-md border p-0.5">
        <button
          type="button"
          aria-label="桌面视图"
          title="桌面视图"
          data-testid="device-desktop"
          onClick={() => setPreviewDevice("desktop")}
          className={cn(
            "flex h-7 w-8 items-center justify-center rounded-sm transition-colors",
            device === "desktop" ? "bg-zinc-200 text-zinc-900" : "text-muted-foreground hover:text-foreground"
          )}
        >
          <Monitor className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="手机视图"
          title="手机视图"
          data-testid="device-mobile"
          onClick={() => setPreviewDevice("mobile")}
          className={cn(
            "flex h-7 w-8 items-center justify-center rounded-sm transition-colors",
            device === "mobile" ? "bg-zinc-200 text-zinc-900" : "text-muted-foreground hover:text-foreground"
          )}
        >
          <Smartphone className="h-4 w-4" />
        </button>
      </div>
      <button
        type="button"
        aria-label="重新读取当前 AppSpec"
        title="刷新预览（重建沙盒会话并重新读取数据库，不重新调用 AI）"
        data-testid="preview-refresh"
        onClick={refreshPreview}
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <RotateCw className="h-4 w-4" />
      </button>
    </div>
  );
}

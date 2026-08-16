"use client";

import { useState } from "react";
import { AlertTriangle, Blocks, Code2, Eye, Loader2, ScrollText } from "lucide-react";
import { STAGE_LABELS } from "@/lib/contracts/conversation";
import { useWorkspace } from "@/lib/state/workspace-provider";
import { SandboxPreview } from "@/components/preview/sandbox-preview";
import { CodeViewer } from "@/components/preview/code-viewer";
import { LogsViewer } from "@/components/preview/logs-viewer";
import { PreviewToolbar } from "./preview-toolbar";
import { cn } from "@/lib/utils";

type PreviewTab = "preview" | "code" | "logs";

const TABS: Array<{ id: PreviewTab; label: string; icon: typeof Eye }> = [
  { id: "preview", label: "预览", icon: Eye },
  { id: "code", label: "代码", icon: Code2 },
  { id: "logs", label: "日志", icon: ScrollText },
];

export function PreviewPanel() {
  const { state, parsedManifest, isRunning, currentStage, latestError } = useWorkspace();
  const [tab, setTab] = useState<PreviewTab>("preview");
  const hasPreview = state.previewBundleId != null && parsedManifest?.ok === true;
  const device = state.prefs.previewDevice;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-zinc-100">
      <PreviewToolbar />
      <div className="flex items-center gap-1 border-b bg-white px-2 py-1" data-testid="preview-tabs">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            data-testid={"preview-tab-" + id}
            onClick={() => setTab(id)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium",
              tab === id ? "bg-zinc-900 text-white" : "text-muted-foreground hover:bg-zinc-100"
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>
      <div className="qubits-scroll min-h-0 flex-1 overflow-y-auto p-2 sm:p-4">
        {tab === "code" ? (
          <CodeViewer refreshTick={state.refreshTick} />
        ) : tab === "logs" ? (
          <LogsViewer refreshTick={state.refreshTick} />
        ) : (
          <PreviewTabContent hasPreview={hasPreview} isRunning={isRunning} stage={currentStage} latestError={latestError} device={device} />
        )}
      </div>
    </div>
  );
}

function PreviewTabContent({
  hasPreview,
  isRunning,
  stage,
  latestError,
  device,
}: {
  hasPreview: boolean;
  isRunning: boolean;
  stage: string;
  latestError: { roleId: string; message: string } | null;
  device: "desktop" | "mobile";
}) {
  const { state, parsedManifest, parsedSpec } = useWorkspace();
  if (!hasPreview && !isRunning) {
    // Legacy AppSpec projects: data converted to a read-only manifest without code/preview.
    if (parsedManifest?.ok && parsedSpec?.ok && !state.currentSnapshotId) {
      return (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4" data-testid="legacy-app-notice">
          <p className="text-sm font-medium text-amber-800">旧版应用（AppSpec）已转换为只读清单</p>
          <p className="mt-1.5 text-xs leading-relaxed text-amber-700">
            旧数据已完整保留（包括业务记录），但旧版应用没有代码产物。重新生成一次应用后，右侧将展示真实构建的代码预览。
          </p>
        </div>
      );
    }
    return <EmptyPreview />;
  }
  if (!hasPreview && isRunning) return <GeneratingPreview stage={stage} />;
  if (hasPreview && parsedManifest?.ok) {
    return (
      <div className="flex flex-col gap-2">
        {isRunning ? <UpdateBanner stage={stage} /> : null}
        {latestError ? <ErrorBanner message={latestError.message} /> : null}
        <div className={cn(device === "mobile" ? "mx-auto w-full max-w-[390px]" : "w-full")}>
          <SandboxPreview
            manifest={parsedManifest.manifest}
            previewVersion={state.previewVersion}
            conversationId={state.currentConversationId ?? ""}
            device={device}
            refreshTick={state.refreshTick}
          />
        </div>
      </div>
    );
  }
  return <ManifestError issues={parsedManifest && !parsedManifest.ok ? parsedManifest.issues : ""} />;
}

function EmptyPreview() {
  return (
    <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-md border bg-white">
        <Blocks className="h-6 w-6 text-zinc-400" />
      </div>
      <div>
        <p className="text-sm font-medium">还没有应用</p>
        <p className="mt-1 max-w-[280px] text-xs leading-relaxed text-muted-foreground">
          在左侧描述你的需求，Mike 会协调 Emma 和 Alex：真实编写 React/TypeScript 代码，在隔离沙盒中构建、测试、安全扫描并预览。
        </p>
      </div>
    </div>
  );
}

function GeneratingPreview({ stage }: { stage: string }) {
  return (
    <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 text-center">
      <Loader2 className="h-6 w-6 animate-spin text-sky-600" />
      <div>
        <p className="text-sm font-medium">正在生成应用</p>
        <p className="mt-1 text-xs text-muted-foreground">{STAGE_LABELS[stage as keyof typeof STAGE_LABELS] ?? "生成中"}…</p>
      </div>
    </div>
  );
}

function UpdateBanner({ stage }: { stage: string }) {
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
      data-testid="update-banner"
    >
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      <span className="truncate">
        正在根据新需求更新应用（{STAGE_LABELS[stage as keyof typeof STAGE_LABELS] ?? "生成中"}），旧版本仍可继续使用。
      </span>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
      data-testid="preview-error-banner"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">
        上次修改失败，已保留上一个成功版本。可在左侧对话中重试。{message}
      </span>
    </div>
  );
}

function ManifestError({ issues }: { issues: string }) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 p-4" data-testid="manifest-error-preview">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-red-600" />
        <p className="text-sm font-medium text-red-700">manifest 校验失败</p>
      </div>
      <p className="mt-1.5 text-xs text-red-600">
        当前存储的应用清单无法通过校验，预览已停用。点击右上角“重置项目”可重新开始。
      </p>
      <pre className="qubits-scroll mt-3 max-h-48 overflow-auto rounded-md border border-red-200 bg-white p-3 text-[11px] leading-relaxed text-red-700 whitespace-pre-wrap break-all">
        {issues}
      </pre>
    </div>
  );
}

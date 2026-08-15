"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Boxes, Menu, PanelRightClose, PanelRightOpen, RotateCcw } from "lucide-react";
import { WorkspaceProvider, useWorkspace } from "@/lib/state/workspace-provider";
import { ConversationPanel } from "./conversation-panel";
import { ConversationSidebar } from "./conversation-sidebar";
import { PreviewPanel } from "./preview-panel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePreviewPanelPolicy } from "@/hooks/use-preview-panel-policy";
import { cn } from "@/lib/utils";
import {
  PREVIEW_DEFAULT_WIDTH,
  PREVIEW_MAX_WIDTH,
  PREVIEW_MIN_WIDTH,
} from "@/lib/storage/project-storage";

type StatusTone = "green" | "amber" | "red" | "gray";
type MobileTab = "conversation" | "preview";

const SIDEBAR_WIDTH = 280;
const SIDEBAR_RAIL_WIDTH = 56;
const PREVIEW_RAIL_WIDTH = 48;

function clampPreviewWidth(value: number): number {
  return Math.min(PREVIEW_MAX_WIDTH, Math.max(PREVIEW_MIN_WIDTH, Math.round(value)));
}

export function WorkspaceShell() {
  return (
    <WorkspaceProvider>
      <WorkspaceInner />
    </WorkspaceProvider>
  );
}

function WorkspaceInner() {
  const workspace = useWorkspace();
  const { state, isRunning, currentRoleName } = workspace;
  const [tab, setTab] = useState<MobileTab>("conversation");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  const leftExpanded = state.prefs.leftSidebar === "expanded";
  const rightExpanded = state.prefs.rightPreview === "expanded";

  const policy = usePreviewPanelPolicy(state.prefs.rightPreview);
  const currentTaskId = state.runningTask?.taskId ?? null;
  const [previewWidth, setPreviewWidth] = useState(state.prefs.previewWidth);
  const resizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  // Keep the draft in sync with restored/updated preferences (e.g. another tab or reset).
  useEffect(() => {
    setPreviewWidth(state.prefs.previewWidth);
  }, [state.prefs.previewWidth]);

  const savePreviewWidth = (width: number) => {
    const next = clampPreviewWidth(width);
    setPreviewWidth(next);
    workspace.setPreferences({ ...state.prefs, previewWidth: next });
  };

  const startPreviewResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!rightExpanded) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: previewWidth };
  };

  const movePreviewResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPreviewWidth(clampPreviewWidth(drag.startWidth + (drag.startX - event.clientX)));
  };

  const finishPreviewResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    savePreviewWidth(drag.startWidth + (drag.startX - event.clientX));
  };

  const resetPreviewWidth = () => savePreviewWidth(PREVIEW_DEFAULT_WIDTH);

  // A committed preview bundle is the only signal that an app exists.
  const hasPreviewNow = state.previewBundleId != null;
  // Seed from the first-frame real state so a refresh does not mistake an existing
  // preview for a fresh build success and wrongly auto-expand Preview, overriding
  // the user's saved collapse preference
  const prevRef = useRef({
    hasPreview: false,
    runningTaskId: null as string | null,
    restored: false,
    baselineReady: false,
  });

  // Restore preferences once after the project loads so an existing preview is not
  // mistaken for a new build success that would auto-expand Preview.
  useEffect(() => {
    if (state.phase === "ready" && !prevRef.current.restored) {
      prevRef.current = {
        hasPreview: hasPreviewNow,
        runningTaskId: currentTaskId,
        restored: true,
        baselineReady: true,
      };
      policy.notify({
        type: "restore_prefs",
        saved: state.prefs.rightPreview,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  // Build events drive the auto-expand policy (dispatched centrally; plain re-renders emit nothing)
  useEffect(() => {
    if (!prevRef.current.baselineReady) return; // Initial load not done: emit no build events
    const hasPreview = hasPreviewNow;
    const prev = prevRef.current;
    if (currentTaskId && currentTaskId !== prev.runningTaskId) {
      policy.notify({ type: "build_started", taskId: currentTaskId, firstGeneration: !prev.hasPreview && !hasPreview });
    }
    // Auto-expand only when a real build finishes while a task is running;
    // conversation switches and page restores never auto-expand.
    if (!prev.hasPreview && hasPreview && state.runningTask != null) {
      policy.notify({ type: "build_succeeded", taskId: prev.runningTaskId ?? "restored" });
    }
    prevRef.current = { ...prev, hasPreview, runningTaskId: currentTaskId };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTaskId, state.previewBundleId, state.runningTask, policy]);

  // Persist the policy-derived preference
  useEffect(() => {
    if (state.prefs.rightPreview !== policy.mode) {
      workspace.setPreferences({ ...state.prefs, rightPreview: policy.mode });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policy.mode]);

  const toggleLeft = () => {
    workspace.setPreferences({ ...state.prefs, leftSidebar: leftExpanded ? "collapsed" : "expanded" });
  };
  const collapseRight = () => policy.collapse(currentTaskId);
  const expandRight = () => policy.expandByUser();

  const latestRun = state.tasks[0];
  const status: { tone: StatusTone; text: string } = isRunning
    ? { tone: "amber", text: "生成中 · " + (currentRoleName ?? "") }
    : latestRun?.status === "failed"
      ? { tone: "red", text: "生成失败" }
      : hasPreviewNow
        ? { tone: "green", text: "就绪" }
        : { tone: "gray", text: "空闲" };

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-white px-3">
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent md:hidden"
          aria-label="打开对话列表"
          onClick={() => setDrawerOpen(true)}
        >
          <Menu className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-sky-600 text-white">
            <Boxes className="h-4 w-4" />
          </div>
          <div className="leading-tight">
            <p className="text-sm font-semibold">Qubits</p>
            <p className="hidden text-[11px] text-muted-foreground sm:block">对话式应用生成器</p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <StatusBadge tone={status.tone} text={status.text} />
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="重置项目"
            title="重置项目（清除所有数据）"
            onClick={() => setResetOpen(true)}
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {state.workspaceError ? <WorkspaceErrorBanner /> : null}

      <main className="flex min-h-0 flex-1">
        {/* Desktop left conversation sidebar (collapsible; mobile uses a drawer) */}
        <aside
          className="hidden shrink-0 overflow-hidden border-r bg-white transition-[width] duration-200 md:block"
          style={{ width: leftExpanded ? SIDEBAR_WIDTH : SIDEBAR_RAIL_WIDTH }}
          aria-label="对话侧栏"
        >
          {/* When collapsed the inner container must track the rail width, otherwise the centered buttons get clipped outside the viewport */}
          <div className="h-full w-full" style={{ width: leftExpanded ? SIDEBAR_WIDTH : SIDEBAR_RAIL_WIDTH }}>
            <ConversationSidebar collapsed={!leftExpanded} onToggle={toggleLeft} />
          </div>
        </aside>

        {/* Middle conversation area */}
        <section
          aria-label="对话区"
          className={cn("min-w-0 flex-1 flex-col", tab === "conversation" ? "flex" : "hidden md:flex")}
        >
          <ConversationPanel />
        </section>

        {/* Desktop right preview (collapsible; iframe stays mounted while collapsed) */}
        <aside
          className="relative hidden shrink-0 overflow-hidden border-l bg-zinc-100 transition-[width] duration-200 md:block"
          style={{ width: rightExpanded ? previewWidth : PREVIEW_RAIL_WIDTH }}
          aria-label="应用预览"
        >
          {rightExpanded ? (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整预览面板宽度"
              aria-valuemin={PREVIEW_MIN_WIDTH}
              aria-valuemax={PREVIEW_MAX_WIDTH}
              aria-valuenow={previewWidth}
              tabIndex={0}
              data-testid="preview-resize-handle"
              title="拖拽调整宽度 · 双击恢复默认"
              className="group absolute inset-y-0 left-0 z-20 w-1.5 cursor-ew-resize touch-none outline-none"
              onPointerDown={startPreviewResize}
              onPointerMove={movePreviewResize}
              onPointerUp={finishPreviewResize}
              onPointerCancel={finishPreviewResize}
              onDoubleClick={resetPreviewWidth}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") savePreviewWidth(previewWidth - 16);
                if (event.key === "ArrowRight") savePreviewWidth(previewWidth + 16);
              }}
            >
              <span className="absolute left-1/2 top-1/2 h-8 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-300 transition-colors group-hover:bg-sky-500" />
            </div>
          ) : null}
          <div
            className={cn("absolute inset-y-0 right-12 left-0", rightExpanded ? "" : "pointer-events-none opacity-0")}
            aria-hidden={!rightExpanded}
            style={{ width: previewWidth - PREVIEW_RAIL_WIDTH }}
          >
            <PreviewPanel />
          </div>
          <div className="absolute inset-y-0 right-0 flex w-12 flex-col items-center gap-2 border-l bg-white py-3">
            {rightExpanded ? (
              <button
                type="button"
                className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
                aria-label="折叠预览面板"
                aria-expanded={true}
                aria-controls="preview-panel"
                title="折叠预览"
                onClick={collapseRight}
                data-testid="collapse-preview"
              >
                <PanelRightClose className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
                aria-label="展开预览面板（查看预览）"
                aria-expanded={false}
                aria-controls="preview-panel"
                title="查看预览"
                onClick={expandRight}
                data-testid="expand-preview"
              >
                <PanelRightOpen className="h-4 w-4" />
              </button>
            )}
            {isRunning ? <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" aria-label="生成中" title="生成中" /> : null}
            {latestRun?.status === "failed" ? <span className="h-2 w-2 rounded-full bg-red-500" aria-label="生成失败" title="生成失败" /> : null}
            {hasPreviewNow ? <span className="h-2 w-2 rounded-full bg-emerald-500" aria-label="预览就绪" title="预览就绪" /> : null}
          </div>
        </aside>
      </main>

      {/* Mobile: conversation / preview segmented nav */}
      <div className="flex h-10 shrink-0 items-center border-t bg-white px-2 md:hidden">
        <MobileTabButton active={tab === "conversation"} onClick={() => setTab("conversation")} label="对话" testId="tab-conversation" />
        <MobileTabButton
          active={tab === "preview"}
          onClick={() => {
            setTab("preview");
            policy.expand("user_requested");
          }}
          label="预览"
          testId="tab-preview"
        />
      </div>
      {tab === "preview" ? (
        <section aria-label="应用预览" data-testid="mobile-preview-section" className="flex min-h-0 flex-1 flex-col bg-zinc-100 md:hidden">
          <PreviewPanel />
        </section>
      ) : null}

      {/* Mobile conversation drawer */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-40 md:hidden" data-testid="conversation-drawer">
          <button
            type="button"
            className="absolute inset-0 bg-black/50"
            aria-label="关闭对话列表"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-[280px] flex-col bg-white shadow-lg">
            <div className="min-h-0 flex-1">
              <ConversationSidebar
                collapsed={false}
                onToggle={() => setDrawerOpen(false)}
                onNavigate={() => setDrawerOpen(false)}
              />
            </div>
          </div>
        </div>
      ) : null}

      <ResetDialog open={resetOpen} onOpenChange={setResetOpen} />
    </div>
  );
}

function WorkspaceErrorBanner() {
  const { state, clearError } = useWorkspace();
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" data-testid="workspace-error">
      <span className="min-w-0 flex-1 break-words">{state.workspaceError}</span>
      <button
        type="button"
        className="shrink-0 rounded-md border border-red-200 bg-white px-2 py-1 font-medium hover:bg-red-100"
        onClick={clearError}
      >
        关闭
      </button>
    </div>
  );
}

function MobileTabButton({
  active,
  onClick,
  label,
  testId,
}: {
  active: boolean;
  onClick(): void;
  label: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "flex h-full flex-1 items-center justify-center border-b-2 text-sm transition-colors",
        active ? "border-sky-600 font-medium text-sky-700" : "border-transparent text-muted-foreground"
      )}
    >
      {label}
    </button>
  );
}

function StatusBadge({ tone, text }: { tone: StatusTone; text: string }) {
  const toneClasses: Record<StatusTone, string> = {
    green: "border-emerald-200 bg-emerald-50 text-emerald-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    red: "border-red-200 bg-red-50 text-red-700",
    gray: "border-zinc-200 bg-zinc-50 text-zinc-600",
  };
  const dotClasses: Record<StatusTone, string> = {
    green: "bg-emerald-500",
    amber: "bg-amber-500 animate-pulse",
    red: "bg-red-500",
    gray: "bg-zinc-400",
  };
  return (
    <span
      data-testid="workspace-status"
      className={cn("hidden items-center gap-1.5 rounded-md border px-2 py-1 text-xs sm:inline-flex", toneClasses[tone])}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", dotClasses[tone])} />
      {text}
    </span>
  );
}

function ResetDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const { resetProject } = useWorkspace();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>重置项目？</DialogTitle>
          <DialogDescription>
            将清除所有对话、消息、代码快照、构建记录与全部应用数据，且无法恢复。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onOpenChange(false);
              void resetProject();
            }}
          >
            确认重置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

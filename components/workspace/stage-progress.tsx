"use client";

import { AlertTriangle, Check, CircleDashed, Loader2 } from "lucide-react";
import { useMemo } from "react";
import { ROLE_META } from "@/lib/contracts/agent-events";
import { useWorkspace } from "@/lib/state/workspace-provider";
import {
  buildStageProgress,
  TOOL_STAGE_LABELS,
  type StageProgressStatus,
  type StageProgressView,
  type ToolStage,
} from "@/lib/workspace/message-view";
import { cn } from "@/lib/utils";

/**
 * Pipeline phase progress rendered from the staged chain-of-thought summaries.
 * Tool calls are intentionally never displayed here: they only contribute to the
 * hidden status aggregation (running/completed/failed per phase).
 */
export function StageProgress() {
  const { state } = useWorkspace();
  const task =
    state.tasks.find((t) => t.status === "running" || t.status === "pending") ??
    state.tasks.find((t) => t.status === "failed") ??
    state.tasks.find((t) => t.status === "ready") ??
    null;
  const rows = useMemo(() => (task ? buildStageProgress(task) : []), [task]);
  if (!task) return null;
  const errorMessage = task.error?.message ?? null;

  return (
    <div className="rounded-md border bg-white p-3" data-testid="stage-progress">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        阶段进度
      </p>
      <ol className="mt-2 space-y-1.5">
        {rows.map((row) => (
          <StageProgressRow key={row.stage} row={row} errorMessage={errorMessage} />
        ))}
      </ol>
    </div>
  );
}

function StageProgressRow({ row, errorMessage }: { row: StageProgressView; errorMessage: string | null }) {
  const summary = row.summary ?? fallbackSummary(row.stage, row.status, errorMessage);
  const latest = row.entries[row.entries.length - 1];
  const roleName = latest ? ROLE_META[latest.roleId]?.name ?? latest.roleId : "";

  return (
    <li
      className="flex items-start gap-2.5"
      data-testid={"stage-progress-" + row.stage}
      data-stage={row.stage}
      data-status={row.status}
    >
      <StageStatusIcon status={row.status} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">{TOOL_STAGE_LABELS[row.stage]}</span>
          <span className={cn("text-[11px]", STATUS_TONE[row.status])}>{STATUS_LABELS[row.status]}</span>
          {latest ? (
            <span className="truncate text-[11px] text-muted-foreground">
              {roleName} · {formatTime(latest.timestamp)}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{summary}</p>
      </div>
    </li>
  );
}

function StageStatusIcon({ status }: { status: StageProgressStatus }) {
  const className = cn(
    "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
    status === "completed" && "bg-emerald-100 text-emerald-700",
    status === "running" && "bg-sky-100 text-sky-700",
    status === "failed" && "bg-red-100 text-red-700",
    status === "pending" && "bg-zinc-100 text-zinc-400"
  );
  if (status === "running") return <span className={className}><Loader2 className="h-3 w-3 animate-spin" aria-hidden /></span>;
  if (status === "completed") return <span className={className}><Check className="h-3 w-3" aria-hidden /></span>;
  if (status === "failed") return <span className={className}><AlertTriangle className="h-3 w-3" aria-hidden /></span>;
  return <span className={className}><CircleDashed className="h-3 w-3" aria-hidden /></span>;
}

function fallbackSummary(stage: ToolStage, status: StageProgressStatus, errorMessage: string | null): string {
  if (status === "failed" && errorMessage) return errorMessage;
  if (status === "completed") return COMPLETED_SUMMARIES[stage];
  if (status === "running") return RUNNING_SUMMARIES[stage];
  return PENDING_SUMMARIES[stage];
}

function formatTime(timestamp: number): string {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

const STATUS_LABELS: Record<StageProgressStatus, string> = {
  pending: "待开始",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
};

const STATUS_TONE: Record<StageProgressStatus, string> = {
  pending: "text-zinc-400",
  running: "text-sky-700",
  completed: "text-emerald-700",
  failed: "text-red-600",
};

const PENDING_SUMMARIES: Record<ToolStage, string> = {
  planning: "等待 Mike 完成需求理解与团队分工。",
  coding: "等待 Alex 将产品简报落成真实代码。",
  validating: "等待 Lint、类型检查、测试、构建与安全扫描。",
  previewing: "等待通过门禁的构建产物提交预览。",
};

const RUNNING_SUMMARIES: Record<ToolStage, string> = {
  planning: "Mike 正在理解需求并安排最少必要的团队协作。",
  coding: "Alex 正在把产品简报拆成真实的工作区文件，并逐步实现交互。",
  validating: "Alex 正在对最新工作区运行 Lint、类型检查、测试、构建和安全扫描。",
  previewing: "Mike 正在提交已通过工程门禁的预览并准备完成本轮运行。",
};

const COMPLETED_SUMMARIES: Record<ToolStage, string> = {
  planning: "需求理解与团队分工已完成。",
  coding: "应用代码已写入工作区。",
  validating: "Lint、类型检查、测试、构建与安全扫描均已通过。",
  previewing: "预览已提交，本轮运行完成。",
};

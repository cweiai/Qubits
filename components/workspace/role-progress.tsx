"use client";

import { AlertTriangle, Check, Circle, Loader2, RotateCw } from "lucide-react";
import { ROLE_META } from "@/lib/contracts/agent-events";
import { STAGE_LABELS } from "@/lib/contracts/conversation";
import { roleName, type AgentRunView, type TaskView } from "@/lib/workspace/message-view";
import { useWorkspace } from "@/lib/state/workspace-provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Live agent-event-driven status list:
 * - each role keeps only its latest run, status updates in place
 *   (pending → running → completed/failed), never appending duplicate rows;
 * - all role statuses align left.
 */
export function RoleProgress() {
  const { state, retryTask } = useWorkspace();
  const task =
    state.tasks.find((t) => t.status === "running" || t.status === "pending") ??
    state.tasks.find((t) => t.status === "failed") ??
    null;
  if (!task || task.status === "ready") return null;

  // Deduplicate by role: keep only the latest run per role (e.g. Alex re-running a fix)
  const latestByRole = new Map<string, AgentRunView>();
  for (const run of task.agentRuns) latestByRole.set(run.roleId, run);
  const rows = [...latestByRole.values()].sort((a, b) => a.timestamp - b.timestamp);
  const hasLeader = rows.some((r) => r.roleId === "team_leader");
  const activeSummary = rows.find((run) => run.status === "running")?.summary ?? null;
  const phaseSummary = activeSummary || PHASE_SUMMARIES[task.stage] || PHASE_SUMMARIES.planning;

  return (
    <div className="rounded-md border bg-white p-3" data-testid="role-progress">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            本轮任务 · {STAGE_LABELS[task.stage]}
          </p>
          <p className="truncate text-sm font-medium">{task.prompt}</p>
        </div>
        {task.status === "failed" ? (
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => retryTask(task.id)}>
            <RotateCw className="h-3.5 w-3.5" />
            重试
          </Button>
        ) : null}
      </div>
      {task.status === "running" || task.status === "pending" ? (
        <div className="mb-2 flex items-start gap-2 rounded-md bg-sky-50 px-2.5 py-2 text-xs text-sky-800" data-testid="phase-summary" aria-live="polite">
          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-sky-600" aria-hidden />
          <span>{phaseSummary}</span>
        </div>
      ) : null}
      {rows.length > 0 ? (
        <ul className="space-y-1">
          {rows.map((run) => (
            <AgentRow key={run.roleId} run={run} leader={run.roleId === "team_leader"} />
          ))}
          {!hasLeader ? <AgentRowFallback task={task} /> : null}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">等待迈克启动…</p>
      )}
      {task.error ? (
        <p className="mt-2 truncate border-t pt-2 text-xs text-red-600" title={task.error.message}>
          {task.error.message}
        </p>
      ) : null}
    </div>
  );
}

const PHASE_SUMMARIES: Record<string, string> = {
  planning: "Mike 正在理解需求并安排最少必要的团队协作；下一步会先由 Emma 整理产品简报。",
  coding: "Alex 正在把产品简报拆成真实的 React/TypeScript 工作区文件，并逐步实现交互。",
  validating: "Alex 正在对同一份最新工作区运行格式化、Lint、类型检查、测试、构建和安全扫描。",
  previewing: "Mike 正在提交已通过工程门禁的预览，并准备完成本次运行。",
  awaiting_approval: "工作区操作需要你的审批；审批结果会直接反馈给当前 Agent。",
};

function AgentRowFallback({ task }: { task: TaskView }) {
  void task;
  return null;
}

function AgentRow({ run, leader }: { run: AgentRunView; leader: boolean }) {
  const meta = ROLE_META[run.roleId];
  return (
    <li
      className="flex items-center gap-2 text-sm"
      data-testid={"agent-row-" + run.roleId}
      data-status={run.status}
    >
      <RunStatusIcon status={run.status} />
      <span className="shrink-0 font-medium">{meta?.name ?? roleName(run.roleId)}</span>
      <span className="min-w-0 truncate text-xs text-muted-foreground" title={run.summary ?? meta?.title}>
        {run.summary ?? meta?.title}
      </span>
      <span
        className={cn(
          "shrink-0 text-xs",
          run.status === "failed" ? "text-red-600" : run.status === "running" ? "text-amber-700" : "text-muted-foreground"
        )}
      >
        {runStatusLabel(run.status)}
      </span>
      {leader ? <span className="truncate text-xs text-muted-foreground">· {run.taskSummary.slice(0, 40)}</span> : null}
    </li>
  );
}

function runStatusLabel(status: AgentRunView["status"]): string {
  switch (status) {
    case "pending":
      return "已分配";
    case "running":
      return "运行中";
    case "completed":
      return "完成";
    case "failed":
      return "失败";
  }
}

function RunStatusIcon({ status }: { status: AgentRunView["status"] }) {
  switch (status) {
    case "pending":
      return <Circle className="h-4 w-4 shrink-0 text-zinc-300" aria-hidden />;
    case "running":
      return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-sky-600" aria-hidden />;
    case "completed":
      return <Check className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden />;
    case "failed":
      return <AlertTriangle className="h-4 w-4 shrink-0 text-red-600" aria-hidden />;
  }
}

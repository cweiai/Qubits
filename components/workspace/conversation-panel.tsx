"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, RotateCw, ShieldAlert, X } from "lucide-react";
import { ROLE_META } from "@/lib/contracts/agent-events";
import { type ConversationMessage } from "@/lib/contracts/conversation";
import { useWorkspace } from "@/lib/state/workspace-provider";
import type { ApprovalRequestView } from "@/lib/state/workspace-reducer";
import { StageProgress } from "./stage-progress";
import { RoleMessage } from "./role-message";
import { PromptComposer } from "./prompt-composer";
import { Button } from "@/components/ui/button";

/**
 * Conversation waterfall: user/role/system messages on a shared timeline.
 * Tool calls are never rendered; phase progress is shown by StageProgress, whose
 * text comes from the staged chain-of-thought summaries.
 */

export function ConversationPanel() {
  const { state } = useWorkspace();
  const scrollRef = useRef<HTMLDivElement>(null);

  const activityKey = useMemo(
    () => state.messages.map((message) => message.id + ":" + (message.status ?? "")).join("|"),
    [state.messages]
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activityKey]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="qubits-scroll min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3 sm:px-4">
        {state.messagesLoading ? (
          <div className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在加载消息…
          </div>
        ) : null}
        <StageProgress />
        {state.pendingApprovals.map((approval) => (
          <ApprovalCard key={approval.approvalId} approval={approval} />
        ))}
        {state.messages.map((message) => (
          <MessageRow key={message.id} message={message} />
        ))}
        {!state.messagesLoading && state.messages.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            这是新的对话线程。描述你想要的应用，迈克会协调艾玛和亚历克斯完成生成。
          </p>
        ) : null}
      </div>
      <PromptComposer />
    </div>
  );
}

function approvalLabel(toolName: string): string {
  const labels: Record<string, string> = {
    fs_delete: "删除文件/目录",
    delete_record: "删除数据记录",
    restore_checkpoint: "回滚工作区",
  };
  return labels[toolName] ?? "高风险操作";
}

function ApprovalCard({ approval }: { approval: ApprovalRequestView }) {
  const { resolveApproval } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const decide = async (decision: "grant" | "deny") => {
    if (busy) return;
    setBusy(true);
    await resolveApproval(approval.approvalId, decision);
  };
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3" data-testid="approval-request">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-amber-900">
            需要审批：{approvalLabel(approval.toolName)}
            <span className="ml-1.5 font-normal text-amber-700/70">（{approval.toolName}）</span>
          </p>
          <p className="mt-1 text-xs leading-relaxed whitespace-pre-wrap text-amber-800">{approval.reason}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={busy} onClick={() => void decide("grant")} className="inline-flex h-7 items-center gap-1 rounded-md bg-amber-700 px-2.5 text-xs font-medium text-white disabled:opacity-50">
              <Check className="h-3 w-3" />允许一次
            </button>
            <button type="button" disabled={busy} onClick={() => void decide("deny")} className="inline-flex h-7 items-center gap-1 rounded-md border border-amber-300 bg-white px-2.5 text-xs font-medium text-amber-900 disabled:opacity-50">
              <X className="h-3 w-3" />拒绝
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageRow({ message }: { message: ConversationMessage }) {
  const { retryTask } = useWorkspace();

  if (message.type === "user") {
    return (
      <div className="flex justify-end">
        <div
          className="max-w-[85%] rounded-md rounded-br-sm bg-sky-600 px-3 py-2 text-sm text-white"
          data-testid="user-message"
        >
          <p className="whitespace-pre-wrap break-words">{message.text}</p>
        </div>
      </div>
    );
  }

  if (message.type === "error") {
    return (
      <div
        className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3"
        data-testid="error-message"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-red-700">
            {message.roleId ? <span className="font-medium">{ROLE_META[message.roleId].name} 失败：</span> : null}
            {message.text}
          </p>
          {message.runId ? (
            <Button size="sm" variant="outline" className="mt-2 h-7" onClick={() => retryTask(message.runId!)}>
              <RotateCw className="h-3 w-3" />
              重试
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (message.type === "system") {
    return (
      <div className="flex justify-center">
        <p className="max-w-[92%] rounded-md border bg-zinc-100 px-3 py-1.5 text-center text-xs leading-relaxed text-muted-foreground">
          {message.text}
        </p>
      </div>
    );
  }

  return <RoleMessage message={message} />;
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, RotateCw } from "lucide-react";
import { ROLE_META } from "@/lib/contracts/agent-events";
import { type ConversationMessage } from "@/lib/contracts/conversation";
import { useWorkspace } from "@/lib/state/workspace-provider";
import { RoleProgress } from "./role-progress";
import { ToolStageGroup } from "./tool-stage-group";
import { RoleMessage } from "./role-message";
import { PromptComposer } from "./prompt-composer";
import { Button } from "@/components/ui/button";
import { activeToolStage, groupToolEvents, type ToolStageGroupView } from "@/lib/workspace/message-view";

/**
 * Conversation waterfall: user/role/system messages + tool-call cards on a shared
 * timeline. Tool cards are grouped into collapsible pipeline-stage blocks (collapsed
 * by default, the running stage auto-expands); cards update live (running → success/failed).
 */

type StreamItem =
  | { kind: "message"; key: string; time: number; message: ConversationMessage }
  | { kind: "stage"; key: string; time: number; group: ToolStageGroupView };

export function ConversationPanel() {
  const { state } = useWorkspace();
  const scrollRef = useRef<HTMLDivElement>(null);
  const latestTask = state.tasks[0] ?? null;

  const toolGroups = useMemo(() => groupToolEvents(latestTask?.toolEvents ?? []), [latestTask]);

  const stream = useMemo<StreamItem[]>(() => {
    const items: StreamItem[] = state.messages.map((message) => ({
      kind: "message",
      key: message.id,
      time: message.timestamp,
      message,
    }));
    for (const group of toolGroups) {
      const times = group.events.map((event) => event.timestamp || Number.MAX_SAFE_INTEGER);
      const time = times.length > 0 ? Math.min(...times) : Number.MAX_SAFE_INTEGER;
      items.push({ kind: "stage", key: "stage:" + latestTask?.id + ":" + group.stage, time, group });
    }
    return [...items].sort((a, b) => a.time - b.time);
  }, [state.messages, toolGroups, latestTask?.id]);

  const activityKey = useMemo(
    () =>
      stream
        .map((item) =>
          item.kind === "message"
            ? item.message.id + ":" + (item.message.status ?? "")
            : item.key + ":" + item.group.events.map((e) => e.status).join(",")
        )
        .join("|"),
    [stream]
  );

  // Collapse state: all collapsed by default; the running stage auto-expands (manually toggled blocks are left alone).
  const [expandedStages, setExpandedStages] = useState<Set<string>>(new Set());
  const manualRef = useRef<Set<string>>(new Set());
  const autoRef = useRef<Set<string>>(new Set());
  const isRunning = latestTask?.status === "running" || latestTask?.status === "pending";
  const activeStage = isRunning && latestTask ? activeToolStage(latestTask.stage) : null;
  const activeKey = activeStage && latestTask ? "stage:" + latestTask.id + ":" + activeStage : null;

  useEffect(() => {
    setExpandedStages((prev) => {
      const next = new Set(prev);
      // Stage switch / run finished: collapse previously auto-expanded blocks.
      for (const key of autoRef.current) next.delete(key);
      autoRef.current = new Set();
      if (activeKey && !manualRef.current.has(activeKey)) {
        next.add(activeKey);
        autoRef.current.add(activeKey);
      }
      return next;
    });
  }, [activeKey]);

  const toggleStage = (key: string) => {
    manualRef.current.add(key);
    autoRef.current.delete(key);
    setExpandedStages((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

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
        <RoleProgress />
        {stream.map((item) =>
          item.kind === "message" ? (
            <MessageRow key={item.key} message={item.message} />
          ) : (
            <ToolStageGroup
              key={item.key}
              group={item.group}
              expanded={expandedStages.has(item.key)}
              onToggle={() => toggleStage(item.key)}
            />
          )
        )}
        {!state.messagesLoading && state.messages.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            这是新的对话线程。描述你想要的应用，迈克、艾玛、鲍勃、亚历克斯、大卫、艾瑞斯会依次协作生成。
          </p>
        ) : null}
      </div>
      <PromptComposer />
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

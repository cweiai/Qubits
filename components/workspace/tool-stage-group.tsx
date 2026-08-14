"use client";

import { Check, ChevronDown, ChevronRight, Layers, Loader2, X } from "lucide-react";
import { stageGroupStatus, TOOL_STAGE_LABELS, type ToolStageGroupView } from "@/lib/workspace/message-view";
import { ToolCallCard } from "./tool-call-card";
import { cn } from "@/lib/utils";

/**
 * Collapsible block holding the tool cards of one pipeline stage. Collapsed by default;
 * the running stage auto-expands; manually toggled blocks are left alone.
 */
export function ToolStageGroup({
  group,
  active,
  expanded,
  onToggle,
}: {
  group: ToolStageGroupView;
  /** True while this block is the currently running pipeline stage. */
  active: boolean;
  expanded: boolean;
  onToggle(): void;
}) {
  const status = stageGroupStatus(group.events, active);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border bg-white",
        status === "failed" ? "border-red-200" : "border-zinc-200"
      )}
      data-testid="tool-stage-group"
      data-stage={group.stage}
      data-status={status}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        data-testid="stage-toggle"
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-zinc-50"
      >
        <span
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
            status === "failed"
              ? "bg-red-50 text-red-600"
              : status === "running"
                ? "bg-amber-50 text-amber-600"
                : "bg-emerald-50 text-emerald-700"
          )}
        >
          {status === "running" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : status === "failed" ? (
            <X className="h-3.5 w-3.5" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
        </span>
        <span className="text-xs font-medium">{TOOL_STAGE_LABELS[group.stage]}</span>
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Layers className="h-3 w-3" />
          {group.events.length} 个工具调用
        </span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
      </button>
      {expanded ? (
        <div className="flex flex-col gap-1.5 border-t bg-zinc-50/60 px-2.5 py-2">
          {group.events.map((event, index) => (
            <ToolCallCard key={event.toolCallId + "-" + index} event={event} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

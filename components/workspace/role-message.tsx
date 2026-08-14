"use client";

import { useState } from "react";
import { Braces, ChartColumn, ChevronDown, ChevronRight, Compass, Globe, Lightbulb, ShieldCheck, UserRound, type LucideIcon } from "lucide-react";
import { ROLE_META, type RoleId } from "@/lib/contracts/agent-events";
import { type ConversationMessage, type RoleStatus } from "@/lib/contracts/conversation";
import { cn } from "@/lib/utils";

const ROLE_ICONS: Record<RoleId, LucideIcon> = {
  team_leader: UserRound,
  product_manager: Lightbulb,
  researcher: Globe,
  architect: Compass,
  engineer: Braces,
  data_scientist: ChartColumn,
  reviewer: ShieldCheck,
  security_reviewer: ShieldCheck,
};

export function RoleMessage({ message }: { message: ConversationMessage }) {
  const [expanded, setExpanded] = useState(false);
  const roleId = message.roleId;
  if (!roleId) return null;
  const meta = ROLE_META[roleId];
  const Icon = ROLE_ICONS[roleId];

  return (
    <div className="rounded-md border bg-white p-3" data-testid={`role-message-${roleId}`}>
      <div className="flex items-start gap-2.5">
        <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white", meta.accent)}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-sm font-medium">{meta.name}</span>
            <span className="text-xs text-muted-foreground">
              {meta.title} · {meta.responsibility}
            </span>
            <span className="ml-auto text-[11px] text-muted-foreground">
              {formatTime(message.timestamp)}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <MessageStatusBadge status={message.status} />
            {message.status === "running" ? (
              <span className="truncate text-xs text-muted-foreground">{message.text}</span>
            ) : null}
          </div>
          {message.status === "success" ? (
            <p className="mt-1.5 text-sm leading-relaxed text-foreground/90">{message.text}</p>
          ) : null}
          {message.status === "error" ? (
            <p className="mt-1.5 text-sm text-red-600">{message.text}</p>
          ) : null}
          {message.artifact != null && message.status === "success" ? (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 hover:underline"
              >
                {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                {expanded ? "收起结构化产物" : "查看结构化产物"}
              </button>
              {expanded ? (
                <pre className="qubits-scroll mt-2 max-h-72 overflow-auto rounded-md border bg-zinc-50 p-3 text-[11px] leading-relaxed text-zinc-700 whitespace-pre-wrap break-all">
                  {safeStringify(message.artifact)}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function MessageStatusBadge({ status }: { status: RoleStatus | null }) {
  if (!status) return null;
  const tone: Record<RoleStatus, string> = {
    pending: "border-zinc-200 bg-zinc-50 text-zinc-500",
    running: "border-amber-200 bg-amber-50 text-amber-700",
    success: "border-emerald-200 bg-emerald-50 text-emerald-700",
    error: "border-red-200 bg-red-50 text-red-700",
  };
  const label: Record<RoleStatus, string> = {
    pending: "等待中",
    running: "运行中",
    success: "完成",
    error: "失败",
  };
  return (
    <span className={cn("inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium", tone[status])}>
      {label[status]}
    </span>
  );
}

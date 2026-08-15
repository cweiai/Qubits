"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, ScrollText, ShieldAlert } from "lucide-react";
import { api, type LogSection } from "@/lib/workspace/api";
import { useWorkspace } from "@/lib/state/workspace-provider";
import { cn } from "@/lib/utils";

/**
 * Logs tab: sanitized + truncated build/test/security records of the current promoted
 * version. Everything shown comes from persisted artifacts — never timers or fakes.
 */

export function LogsViewer({ refreshTick }: { refreshTick: number }) {
  const { state } = useWorkspace();
  const conversationId = state.currentConversationId ?? "";
  const [sections, setSections] = useState<LogSection[]>([]);
  const [version, setVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getLogs(conversationId);
      setSections(result.sections);
      setVersion(result.version);
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法加载日志");
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load, refreshTick, conversationId]);

  return (
    <div className="flex h-full min-h-[320px] flex-col" data-testid="logs-viewer">
      <div className="flex items-center gap-2 border-b bg-zinc-50 px-3 py-1.5 text-[11px] text-muted-foreground">
        <ScrollText className="h-3.5 w-3.5 shrink-0" />
        <span>构建 / 测试 / 安全记录{version != null ? "（v" + version + "）" : ""} · 已脱敏与截断</span>
      </div>
      <div className="qubits-scroll min-h-0 flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            加载日志…
          </div>
        ) : error ? (
          <p className="text-xs text-red-600">{error}</p>
        ) : sections.length === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground" data-testid="logs-empty">
            还没有构建 / 测试 / 安全记录。完成一次应用生成后，这里会展示真实报告。
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {sections.map((section) => (
              <div key={section.kind} className="rounded-md border bg-white" data-testid={"log-" + section.kind}>
                <div className="flex items-center gap-2 border-b px-3 py-1.5 text-[11px]">
                  <span className="font-medium">{section.title}</span>
                  {section.status ? (
                    <span
                      className={cn(
                        "rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
                        section.status === "approved" || section.status === "success" || section.status === "passed"
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : section.status === "blocked" || section.status === "failed"
                            ? "border-red-200 bg-red-50 text-red-700"
                            : "border-zinc-200 bg-zinc-50 text-zinc-500"
                      )}
                    >
                      {section.status}
                    </span>
                  ) : null}
                  {section.kind === "security_report" ? <ShieldAlert className="ml-auto h-3.5 w-3.5 text-rose-500" /> : null}
                </div>
                <pre className="qubits-scroll m-0 max-h-56 overflow-auto whitespace-pre-wrap break-all p-3 text-[11px] leading-relaxed text-zinc-700">
                  {section.content || "（无内容）"}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

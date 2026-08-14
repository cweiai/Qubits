"use client";

import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { useWorkspace } from "@/lib/state/workspace-provider";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function PromptComposer() {
  const { isRunning, submitPrompt, state } = useWorkspace();
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const busy = isRunning || submitting;
  const canSubmit = value.trim().length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    // Clear the input only after the message actually persists (keep it on failure to retry)
    const persisted = await submitPrompt(value);
    if (persisted) setValue("");
    setSubmitting(false);
  };

  return (
    <div className="shrink-0 border-t bg-white px-3 pb-3 pt-2.5 sm:px-4">
      <div className="flex items-end gap-2">
        <Textarea
          key={state.currentConversationId ?? "none"}
          data-testid="prompt-input"
          aria-label="需求输入框"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          rows={2}
          autoFocus
          placeholder={busy ? "生成任务进行中，请稍候…" : "描述你想要的应用，或继续修改当前应用…"}
          className="min-h-[52px] max-h-[120px] flex-1 resize-none"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <Button
          data-testid="prompt-send"
          onClick={() => void submit()}
          disabled={!canSubmit}
          size="icon"
          className="h-[52px] w-10 shrink-0"
          aria-label="发送需求"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">Enter 发送 · Shift+Enter 换行。</p>
    </div>
  );
}

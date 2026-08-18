import { agentEventSchema, type AgentEvent } from "@/lib/contracts/agent-events";

/**
 * NDJSON streaming read of a build task: POST /api/build-tasks/:taskId/run,
 * parsed line-by-line into validated AgentEvents; the server persists results to conversation/task/draft concurrently.
 */
export async function streamTaskRun(
  taskId: string,
  signal: AbortSignal,
  onEvent: (event: AgentEvent) => void
): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/build-tasks/" + taskId + "/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal,
    });
  } catch {
    return;
  }
  if (!response.ok || !response.body) {
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let json: unknown = null;
        try {
          json = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const event = agentEventSchema.safeParse(json);
        if (event.success) {
          onEvent(event.data);
        } else {
          // Log unparseable live events instead of silently dropping them.
          const type = typeof json === "object" && json !== null ? String((json as { type?: unknown }).type ?? "unknown") : "unknown";
          console.warn("[stream] 丢弃无法解析的实时事件", type, JSON.stringify(event.error.issues?.[0] ?? event.error));
        }
      }
    }
  } catch {
    return;
  }
}

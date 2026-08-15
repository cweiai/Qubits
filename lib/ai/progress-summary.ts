import "server-only";

/** Raw reasoning stays server-side; only sanitized summaries may cross the event boundary. */
export function redactProgressText(text: string): string {
  return text
    .replace(/\b(?:sk|sess|api)[-_][A-Za-z0-9_-]{8,}\b/gi, "[credential]")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{8,}\b/gi, "Bearer [credential]")
    .replace(/(^|[^A-Za-z0-9:/])\/(?:[^/\s'"`，。；;]+\/)*[^\s'"`，。；;]*/g, "$1[path]")
    .replace(/[A-Za-z]:\\[^\s'"`，。；;]*/g, "[path]");
}

export function sanitizeProgressSummary(value: unknown): string | null {
  let text = typeof value === "string" ? value : "";
  text = text.trim();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { summary?: unknown }).summary === "string") {
      text = (parsed as { summary: string }).summary.trim();
    }
  } catch {
    // Providers are asked for plain text; malformed JSON is still handled as text below.
  }
  if (/chain\s*of\s*thought|reasoning(?:_content)?|思维链|原始思考|系统提示词|system\s*prompt|api[_ -]?key|密钥|token/i.test(text)) {
    return null;
  }
  const redacted = redactProgressText(text)
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!redacted) return null;
  return redacted.slice(0, 240).trim() || null;
}

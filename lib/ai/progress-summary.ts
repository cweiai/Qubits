import "server-only";

/** Raw reasoning stays server-side; only sanitized summaries may cross the event boundary. */
export function redactProgressText(text: string): string {
  return text
    .replace(/\b(?:sk|sess|api)[-_][A-Za-z0-9_-]{8,}\b/gi, "[credential]")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{8,}\b/gi, "Bearer [credential]")
    .replace(/(^|[^A-Za-z0-9:/])\/(?:[^/\s'"`，。；;]+\/)*[^\s'"`，。；;]*/g, "$1[path]")
    .replace(/[A-Za-z]:\\[^\s'"`，。；;]*/g, "[path]");
}

/** Extract a complete JSON string field even when the surrounding object is truncated. */
function extractJsonStringField(text: string, field: string): string | null {
  const match = text.match(new RegExp('"' + field + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"'));
  if (!match) return null;
  try {
    const value = JSON.parse('"' + match[1] + '"') as unknown;
    return typeof value === "string" ? value.trim() : null;
  } catch {
    return null;
  }
}

export function sanitizeProgressSummary(value: unknown): string | null {
  let text = typeof value === "string" ? value : "";
  text = text.trim();
  if (!text) return null;

  const trimmedStart = text.trimStart();
  // A raw JSON array can never be user-facing stage progress.
  if (trimmedStart.startsWith("[")) return null;
  if (trimmedStart.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
      const summary = (parsed as { summary?: unknown }).summary;
      if (typeof summary !== "string") return null;
      text = summary.trim();
    } catch {
      // Truncated JSON from a small max_tokens summary request is common; salvage the
      // `summary` field instead of leaking the raw object into the UI.
      const extracted = extractJsonStringField(text, "summary");
      if (!extracted) return null;
      text = extracted;
    }
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
  // Defense in depth: never let structured JSON cross the event boundary.
  if (/^[\[{]/.test(redacted)) return null;
  return redacted.slice(0, 240).trim() || null;
}

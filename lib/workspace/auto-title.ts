/** Generate a short title from the user prompt (deterministic truncation; keeps "New Conversation" on failure, never blocks sending). */
export function autoTitle(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return "新对话";
  const title = normalized.length > 24 ? normalized.slice(0, 24) + "…" : normalized;
  return title.slice(0, 60);
}

import "server-only";
import type { ProgressPhase, RoleId } from "@/lib/contracts/agent-events";
import { openaiProvider } from "./openai-provider";

/**
 * Model provider abstraction for the real tool-calling protocol.
 * API keys are read only in server-side modules and never reach the client.
 */

/** Real tool-calling protocol messages (aligned with OpenAI-compatible chat/completions). */
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
      /** Reasoning-model reasoning_content: echoed back to the API only, never displayed or persisted */
      reasoning_content?: string | null;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolCall {
  id: string;
  name: string;
  rawArguments: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Controller tool choice per round:
 * - auto: the provider may call any exposed tool or return text;
 * - none (force_final): no tools are exposed — the model must emit the final output;
 * - function (force_next_tool): only the named tool is exposed and forced.
 */
export type ToolChoiceSpec =
  | { mode: "auto" }
  | { mode: "none" }
  | { mode: "function"; name: string };

export interface GenerateWithToolsInput {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  roleId: RoleId;
  signal?: AbortSignal;
  /** Controller directive for this round (defaults to auto). */
  toolChoice?: ToolChoiceSpec;
  /** Ephemeral server-only stream hook; callers must never persist or forward raw reasoning. */
  onReasoningDelta?: (delta: string) => void;
}

export interface AgentTurnResponse {
  content: string | null;
  toolCalls: ToolCall[];
  reasoningContent: string | null;
}

export interface ProgressSummaryInput {
  roleId: RoleId;
  phase: ProgressPhase;
  reasoningContent: string;
  signal?: AbortSignal;
}

export interface AIProvider {
  /** Provider identifier is diagnostic only; production getProvider returns openai. */
  readonly kind: string;
  generateWithTools(input: GenerateWithToolsInput): Promise<AgentTurnResponse>;
  /** Optional side-channel summarizer. Failure must never affect the main agent loop. */
  summarizeProgress?(input: ProgressSummaryInput): Promise<string | null>;
}

/** Production always uses the configured model service; tests inject a provider explicitly. */
export function getProvider(): AIProvider {
  return openaiProvider;
}

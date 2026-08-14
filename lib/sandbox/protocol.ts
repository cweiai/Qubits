import { z } from "zod";
import {
  collectionOperationSchema,
  collectionSpecSchema,
  IDENTIFIER,
} from "@/lib/contracts/app-spec";

/**
 * Sandbox MessageChannel protocol (client-safe, shared by host and sandbox).
 * Every message is Zod-validated; data requests travel only over the MessagePort,
 * so the sandbox never touches the database, the host DOM, or credentials.
 * QUBITS_SPEC carries the validated manifest (name + collection contract) — never AppSpec.
 */

export const SANDBOX_MAX_MESSAGE_BYTES = 64 * 1024;

/** iframe → host (window.postMessage): loaded, awaiting init. */
export const sandboxHandshakeSchema = z.object({
  type: z.literal("QUBITS_HANDSHAKE"),
});

/** Host → iframe (window.postMessage, with a transferred MessagePort). */
const sandboxInitMessageSchema = z.object({
  type: z.literal("QUBITS_INIT"),
  nonce: z.string().min(8).max(128),
  appId: z.string().min(1).max(128),
  appVersion: z.number().int().positive(),
});

/** iframe → host (port): confirms handshake complete. */
const sandboxReadySchema = z.object({
  type: z.literal("QUBITS_READY"),
  nonce: z.string(),
});

/** Host → iframe (port): delivers the validated manifest name + session info (no credentials). */
const sandboxSpecMessageSchema = z.object({
  type: z.literal("QUBITS_SPEC"),
  nonce: z.string(),
  name: z.string().min(1).max(120),
  sessionId: z.string().min(8).max(128),
  collections: z.array(collectionSpecSchema),
});

/** iframe → host (port): restricted data request. */
export const sandboxDataRequestSchema = z
  .object({
    type: z.literal("QUBITS_DATA_REQUEST"),
    nonce: z.string(),
    requestId: z.string().min(1).max(64),
    operation: collectionOperationSchema,
    collection: z.string().regex(IDENTIFIER),
    id: z.string().max(64).optional(),
    query: z.unknown().optional(),
    input: z.unknown().optional(),
    patch: z.unknown().optional(),
  })
  .strict();

/** Host → iframe (port): data request result. */
export const sandboxDataResponseSchema = z.object({
  type: z.literal("QUBITS_DATA_RESPONSE"),
  nonce: z.string(),
  requestId: z.string(),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      requestId: z.string().optional(),
    })
    .optional(),
});

/** iframe → host (port): status notification (save success / data error, etc.). */
const sandboxNotifySchema = z.object({
  type: z.literal("QUBITS_NOTIFY"),
  nonce: z.string(),
  level: z.enum(["info", "error"]),
  message: z.string().max(300),
});

export const sandboxMessageSchema = z.discriminatedUnion("type", [
  sandboxHandshakeSchema,
  sandboxInitMessageSchema,
  sandboxReadySchema,
  sandboxSpecMessageSchema,
  sandboxDataRequestSchema,
  sandboxDataResponseSchema,
  sandboxNotifySchema,
]);

export type SandboxDataRequest = z.infer<typeof sandboxDataRequestSchema>;
export type SandboxDataResponse = z.infer<typeof sandboxDataResponseSchema>;

/** Sandbox-side data surface of the Runtime API (the window.Qubits.data contract). */
export interface SandboxDataApi {
  list(collection: string, query?: unknown): Promise<unknown[]>;
  count(collection: string, query?: unknown): Promise<number>;
  create(collection: string, input: unknown): Promise<unknown>;
  update(collection: string, id: string, patch: unknown): Promise<unknown>;
  delete(collection: string, id: string): Promise<unknown>;
}

export interface SandboxDataError {
  code: string;
  message: string;
  requestId?: string;
}


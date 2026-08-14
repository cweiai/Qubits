import { z } from "zod";

/** Zod schemas for conversation, message, and build-task API boundaries (length, id format, pagination, status). */

const conversationIdSchema = z.string().regex(/^conv-[a-zA-Z0-9-]{8,64}$/);
const requestIdSchema = z.string().min(8).max(64);

const titleSchema = z
  .string()
  .min(1, "标题不能为空")
  .max(60, "标题最长 60 个字符")
  .transform((value) => value.trim().slice(0, 60))
  .refine((value) => value.length > 0, "标题不能为空");

const conversationStatusSchema = z.enum(["active", "archived"]);

export const createConversationBodySchema = z
  .object({
    // The id is an idempotency key: generated once per "new" intent; double-clicks and retries reuse it.
    id: conversationIdSchema,
    title: titleSchema.optional(),
  })
  .strict();

export const patchConversationBodySchema = z
  .object({
    title: z.string().min(1).max(60).optional(),
    status: conversationStatusSchema.optional(),
  })
  .strict()
  .refine((value) => value.title !== undefined || value.status !== undefined, {
    message: "至少提供 title 或 status",
  });

export const listMessagesQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const sendMessageBodySchema = z
  .object({
    content: z.string().min(1, "消息不能为空").max(4000, "消息过长（最多 4000 字）"),
    requestId: requestIdSchema,
  })
  .strict();

/** Migration body for legacy localStorage data (v2 workspace state). */
export const migrateBodySchema = z
  .object({
    appSpec: z.unknown().optional(),
    productBrief: z.unknown().optional(),
    appBlueprint: z.unknown().optional(),
    legacyConversation: z.array(z.unknown()).max(500).optional(),
  })
  .strict();

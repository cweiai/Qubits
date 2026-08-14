import { z } from "zod";

/**
 * Structured output of the QA/Security Reviewer:
 * either approved (issues must be empty) or rejected (must provide fixable structured issues).
 */

const reviewIssueSchema = z.object({
  code: z.string().min(1).max(60),
  severity: z.enum(["error", "warning"]),
  path: z.string().min(1).max(120),
  message: z.string().min(1).max(300),
  repairHint: z.string().min(1).max(300),
});

export const securityReviewSchema = z
  .object({
    approved: z.boolean(),
    summary: z.string().min(1).max(240),
    issues: z.array(reviewIssueSchema).max(20),
  })
  .superRefine((value, ctx) => {
    if (value.approved && value.issues.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "approved 为 true 时 issues 必须为空",
        path: ["issues"],
      });
    }
    if (!value.approved && value.issues.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "拒绝时必须给出结构化 issues（code/severity/path/message/repairHint）",
        path: ["issues"],
      });
    }
  });

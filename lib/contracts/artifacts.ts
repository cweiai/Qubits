import { z } from "zod";
import { collectionOperationSchema, collectionSpecSchema, fieldTypeSchema } from "./app-spec";

/**
 * Product Brief / App Blueprint artifacts.
 * The *WithSummary variants attach a user-facing summary field, stripped after display.
 * Bob's blueprint describes pages/components/state/data model and the technical approach —
 * it never contains final code (that is Alex's job through real workspace tools).
 */

export const productBriefSchema = z.object({
  appName: z.string().min(1),
  targetUser: z.string().min(1),
  problem: z.string().min(1),
  coreFeatures: z.array(z.string().min(1)).min(1).max(8),
  primaryEntity: z.string().min(1),
  assumptions: z.array(z.string()).max(6),
  outOfScope: z.array(z.string()).max(8),
});
export type ProductBrief = z.infer<typeof productBriefSchema>;

export const productBriefWithSummarySchema = productBriefSchema.extend({
  summary: z.string().min(1).max(240),
});

const blueprintCollectionSchema = z.object({
  name: z.string().min(1).regex(/^[a-z][a-z0-9_]{0,31}$/, "集合名必须是小写受限标识符"),
  label: z.string().min(1),
  fields: z
    .array(
      z.object({
        name: z.string().min(1).regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/, "字段名必须是合法标识符"),
        label: z.string().min(1),
        type: fieldTypeSchema,
        required: z.boolean().default(false),
        options: z.array(z.string().min(1)).min(1).optional(),
        maxLength: z.number().int().positive().max(4000).optional(),
      })
    )
    .min(1)
    .max(12),
  allowedOperations: z.array(collectionOperationSchema).min(1).max(5).default(["list", "count", "create", "update", "delete"]),
});

const blueprintSectionKindSchema = z.enum(["header", "form", "list", "table", "stats", "chart", "empty-state", "custom"]);

export const appBlueprintSchema = z.object({
  appType: z.string().min(1).max(80),
  dataModel: z.object({
    primaryCollection: z.string().min(1),
    collections: z.array(blueprintCollectionSchema).min(1).max(8),
  }),
  pages: z
    .array(
      z.object({
        id: z.string().min(1).max(60),
        title: z.string().min(1).max(120),
        purpose: z.string().min(1).max(400),
        sections: z
          .array(
            z.object({
              id: z.string().min(1).max(60),
              kind: blueprintSectionKindSchema,
              title: z.string().min(1).max(120),
              description: z.string().max(400).default(""),
              data: z
                .object({
                  collection: z.string().min(1).max(64).optional(),
                  fields: z.array(z.string().min(1).max(80)).max(12).optional(),
                })
                .optional(),
            })
          )
          .min(1)
          .max(10),
      })
    )
    .min(1)
    .max(6),
  components: z
    .array(
      z.object({
        id: z.string().min(1).max(60),
        name: z.string().min(1).max(120),
        purpose: z.string().max(400),
        props: z.array(z.string().min(1).max(80)).max(12).default([]),
      })
    )
    .max(16)
    .default([]),
  state: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        description: z.string().max(300),
        scope: z.enum(["local", "page", "app"]).default("local"),
      })
    )
    .max(12)
    .default([]),
  technicalApproach: z.object({
    styling: z.string().min(1).max(300),
    dataFlow: z.string().min(1).max(300),
    build: z.string().min(1).max(300),
    testing: z.string().min(1).max(300),
  }),
  validationRules: z.array(z.string().max(200)).max(10),
  visualDirection: z.string().min(1).max(200),
});
export type AppBlueprint = z.infer<typeof appBlueprintSchema>;

export const appBlueprintWithSummarySchema = appBlueprintSchema.extend({
  summary: z.string().min(1).max(240),
});

/** Iris (researcher) structured research artifact: must carry sources. */
export const researchReportSchema = z.object({
  summary: z.string().min(1).max(240),
  findings: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        url: z.string().max(500),
        domain: z.string().max(120),
        snippet: z.string().max(600),
        relevance: z.string().max(240),
      })
    )
    .max(8)
    .default([]),
  recommendations: z.array(z.string().max(240)).max(5).default([]),
});

/** David (data_scientist) data analysis artifact. */
export const dataReportSchema = z.object({
  summary: z.string().min(1).max(240),
  metrics: z
    .array(
      z.object({
        metric: z.string().max(40),
        fieldId: z.string().max(80).nullable(),
        value: z.number().or(z.string().max(80)),
        note: z.string().max(240),
      })
    )
    .max(10)
    .default([]),
  timeRange: z.string().max(80).default(""),
  recommendations: z.array(z.string().max(240)).max(5).default([]),
});

/**
 * Alex (engineer) final structured output: the code workspace summary.
 * Every file/hash/build status must come from real workspace tools — the final text
 * can never replace fs_write / run_build tool results.
 */
export const codeWorkspaceSchema = z.object({
  summary: z.string().min(1).max(240),
  files: z.array(z.object({ path: z.string().min(1).max(300), hash: z.string().min(1).max(64) })).max(80),
  manifest: z.object({
    name: z.string().min(1).max(120),
    collections: z.array(collectionSpecSchema).max(8),
  }),
  buildStatus: z.enum(["success", "failed", "not_run"]),
  buildArtifactId: z.string().max(64).nullable(),
  notes: z.array(z.string().max(240)).max(6).default([]),
});
export type CodeWorkspace = z.infer<typeof codeWorkspaceSchema>;

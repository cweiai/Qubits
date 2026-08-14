import { z } from "zod";

/** Zod arg/result schemas for each tool (used by the Tool Registry). */

export const delegateToAgentArgsSchema = z.object({
  targetRole: z.enum(["product_manager", "researcher", "architect", "engineer", "data_scientist", "reviewer"]),
  task: z.string().min(1).max(2400),
  expectedOutput: z.enum(["product_brief", "research_report", "app_blueprint", "code_workspace", "data_report", "review_report"]),
  inputArtifactIds: z.array(z.string().min(8).max(64)).max(12).default([]),
});
export const delegateToAgentResultSchema = z.object({
  delegationId: z.string(),
  childAgentRunId: z.string(),
  targetRole: z.string(),
  status: z.enum(["completed", "failed"]),
  artifactId: z.string().nullable(),
  summary: z.string().max(300),
  issues: z.array(z.string().max(200)).default([]),
  /** Real artifacts produced during this child run (build_report / preview_bundle / test_report ids). */
  relatedArtifacts: z.array(z.object({ kind: z.string().max(40), artifactId: z.string().max(64) })).max(6).default([]),
});

export const searchReferencesArgsSchema = z.object({
  query: z.string().min(2).max(400),
  intent: z.enum(["product", "ui", "technical", "competitor"]).default("ui"),
  maxResults: z.number().int().min(1).max(8).default(5),
  recencyDays: z.number().int().min(0).max(3650).nullable().default(null),
});
export const referenceSearchResultSchema = z.object({
  resultId: z.string(),
  title: z.string().max(200),
  url: z.string().max(500),
  domain: z.string().max(120),
  snippet: z.string().max(600),
  source: z.string().max(40),
  publishedAt: z.string().nullable(),
});
export const searchReferencesResultSchema = z.object({
  results: z.array(referenceSearchResultSchema).max(8),
  artifactId: z.string(),
});

export const openReferenceArgsSchema = z.object({
  resultId: z.string().min(1).max(64),
  maxChars: z.number().int().min(500).max(12000).default(6000),
});
export const openReferenceResultSchema = z.object({
  resultId: z.string(),
  title: z.string().max(200),
  url: z.string().max(500),
  untrustedContent: z.string().max(14000),
  charCount: z.number().int(),
});

export const inspectCurrentAppArgsSchema = z.object({
  includeRecords: z.boolean().default(false),
  includeSchema: z.boolean().default(true),
});
export const inspectCurrentAppResultSchema = z.object({
  hasApp: z.boolean(),
  appSummary: z.string().max(400).default(""),
  schemaSummary: z.string().max(2000).default(""),
  recordCounts: z.record(z.string(), z.number()).optional(),
});

export const analyzeProjectDataArgsSchema = z.object({
  metric: z.enum(["count", "countWhere", "sum", "average", "trend"]),
  fieldId: z.string().max(80).nullable().default(null),
  filter: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export const analyzeProjectDataResultSchema = z.object({
  metric: z.string(),
  fieldId: z.string().nullable(),
  value: z.number().or(z.string().max(80)),
  note: z.string().max(240),
  timeRange: z.string().max(80),
});

export const validateAppSpecArgsSchema = z.object({
  artifactId: z.string().min(8).max(64),
});
export const validateAppSpecResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(
    z.object({ code: z.string().max(60), path: z.string().max(120), severity: z.enum(["error", "warning"]), message: z.string().max(300) })
  ).max(20),
});

export const renderPreviewArgsSchema = z.object({
  artifactId: z.string().min(8).max(64),
  reason: z.enum(["initial_generation", "user_revision", "repair"]),
  deviceHint: z.enum(["desktop", "mobile"]).nullable().default(null),
});
export const renderPreviewResultSchema = z.object({
  previewArtifactId: z.string(),
  version: z.number().int().positive(),
  appName: z.string().max(120),
});

export const completeRunArgsSchema = z.object({
  summary: z.string().min(1).max(300),
  nextSuggestions: z.array(z.string().max(160)).max(3).default([]),
});
export const completeRunResultSchema = z.object({
  ok: z.literal(true),
  summary: z.string().max(300),
});

// ── filesystem ──
export const fsListArgsSchema = z.object({ path: z.string().max(400).default("."), maxDepth: z.number().int().min(1).max(6).default(2), maxEntries: z.number().int().min(1).max(200).default(50) });
export const fsListResultSchema = z.object({ entries: z.array(z.object({ path: z.string(), type: z.enum(["file", "dir"]), size: z.number() }) ).max(200) });
export const fsReadArgsSchema = z.object({ path: z.string().min(1).max(400), maxBytes: z.number().int().min(1).max(65536).default(16384) });
export const fsReadResultSchema = z.object({ path: z.string(), content: z.string().max(70000), truncated: z.boolean() });
export const fsWriteArgsSchema = z.object({ path: z.string().min(1).max(400), content: z.string().max(120000) });
export const fsWriteResultSchema = z.object({ path: z.string(), bytesWritten: z.number(), diffSummary: z.string().max(400) });
export const fsPatchArgsSchema = z.object({ path: z.string().min(1).max(400), oldText: z.string().max(20000), newText: z.string().max(20000), replaceAll: z.boolean().default(false) });
export const fsPatchResultSchema = z.object({ path: z.string(), replaced: z.number().int(), diffSummary: z.string().max(400) });
export const fsStatArgsSchema = z.object({ path: z.string().min(1).max(400) });
export const fsStatResultSchema = z.object({ path: z.string(), type: z.enum(["file", "dir"]), size: z.number(), modifiedAt: z.number() });
export const fsDeleteArgsSchema = z.object({ path: z.string().min(1).max(400), soft: z.boolean().default(true) });
export const fsDeleteResultSchema = z.object({ path: z.string(), soft: z.boolean() });
export const fsCreateDirArgsSchema = z.object({ path: z.string().min(1).max(400) });
export const fsCreateDirResultSchema = z.object({ path: z.string() });
export const fsCopyArgsSchema = z.object({ from: z.string().min(1).max(400), to: z.string().min(1).max(400) });
export const fsCopyResultSchema = z.object({ from: z.string(), to: z.string() });
export const fsMoveArgsSchema = z.object({ from: z.string().min(1).max(400), to: z.string().min(1).max(400) });
export const fsMoveResultSchema = z.object({ from: z.string(), to: z.string() });

// ── bash ──
export const bashArgsSchema = z.object({ command: z.string().min(1).max(2000), timeoutMs: z.number().int().min(1000).max(120000).default(60000) });
export const bashResultSchema = z.object({ exitCode: z.number().int(), stdout: z.string().max(30000), stderr: z.string().max(10000), timedOut: z.boolean(), durationMs: z.number().int() });

// ── build checks ──
export const runCommandArgsSchema = z.object({ cwd: z.string().max(300).default(""), timeoutMs: z.number().int().min(1000).max(300000).default(120000) });
export const runCommandResultSchema = z.object({ exitCode: z.number().int(), status: z.enum(["passed", "failed", "timeout"]), summary: z.string().max(2000) });

// ── data ──
export const dataQueryArgsSchema = z.object({ collection: z.string().min(1).max(64), filter: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(), limit: z.number().int().min(1).max(100).default(50) });
export const dataQueryResultSchema = z.object({ collection: z.string(), records: z.array(z.record(z.unknown())).max(100), truncated: z.boolean() });
export const dataCountArgsSchema = z.object({ collection: z.string().min(1).max(64), filter: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional() });
export const dataCountResultSchema = z.object({ collection: z.string(), count: z.number().int() });
export const dataAggregateArgsSchema = z.object({ collection: z.string().min(1).max(64), fieldId: z.string().min(1).max(80), metric: z.enum(["count", "sum", "average"]), filter: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional() });
export const dataAggregateResultSchema = z.object({ collection: z.string(), metric: z.string(), value: z.number() });
export const recordCreateArgsSchema = z.object({ collection: z.string().min(1).max(64), input: z.record(z.unknown()) });
export const recordCreateResultSchema = z.object({ record: z.record(z.unknown()) });
export const recordUpdateArgsSchema = z.object({ collection: z.string().min(1).max(64), id: z.string().min(1).max(64), patch: z.record(z.unknown()) });
export const recordUpdateResultSchema = z.object({ updated: z.boolean() });
export const recordDeleteArgsSchema = z.object({ collection: z.string().min(1).max(64), id: z.string().min(1).max(64) });
export const recordDeleteResultSchema = z.object({ deleted: z.boolean() });
export const seedDemoDataArgsSchema = z.object({ collection: z.string().min(1).max(64), count: z.number().int().min(1).max(20).default(5) });
export const seedDemoDataResultSchema = z.object({ seeded: z.number().int() });
export const dataSchemaResultSchema = z.object({ collections: z.array(z.object({ name: z.string(), fields: z.array(z.object({ name: z.string(), type: z.string(), required: z.boolean() })) })).max(8) });
export const dataAccessResultSchema = z.object({ valid: z.boolean(), issues: z.array(z.string().max(300)).max(10) });

// ── artifacts/approval/release ──
export const createArtifactArgsSchema = z.object({ kind: z.enum(["product_brief", "research_report", "app_blueprint", "code_workspace", "build_report", "test_report", "review_report", "preview_bundle", "data_report", "file"]), name: z.string().min(1).max(120), content: z.unknown() });
export const createArtifactResultSchema = z.object({ artifactId: z.string() });
export const getArtifactArgsSchema = z.object({ artifactId: z.string().min(8).max(64) });
export const getArtifactResultSchema = z.object({ artifactId: z.string(), kind: z.string(), summary: z.string().max(500) });
export const compareArtifactsArgsSchema = z.object({ aArtifactId: z.string().min(8).max(64), bArtifactId: z.string().min(8).max(64) });
export const compareArtifactsResultSchema = z.object({ sameKind: z.boolean(), changedKeys: z.array(z.string().max(120)).max(30) });
export const requestApprovalArgsSchema = z.object({ toolName: z.string().min(1).max(60), reason: z.string().min(1).max(400) });
export const requestApprovalResultSchema = z.object({ approvalId: z.string(), toolName: z.string(), status: z.enum(["pending", "granted"]) });
export const notConfiguredResultSchema = z.object({ available: z.literal(false), provider: z.string(), reason: z.string().max(300) });
export const migrationPlanResultSchema = z.object({ available: z.literal(false), provider: z.string(), reason: z.string().max(300) });
export const publishResultSchema = z.object({ available: z.literal(false), provider: z.string(), reason: z.string().max(300) });

// ── workspace tools ──
export const workspaceInitArgsSchema = z.object({}).strict();
export const workspaceInitResultSchema = z.object({
  initialized: z.boolean(),
  seededFrom: z.enum(["template", "snapshot", "existing"]),
  fileCount: z.number().int(),
});
export const workspaceGetManifestArgsSchema = z.object({}).strict();
export const workspaceGetManifestResultSchema = z.object({
  name: z.string().max(120),
  description: z.string().max(1000),
  main: z.string(),
  collections: z.array(z.object({ name: z.string(), label: z.string(), allowedOperations: z.array(z.string()).max(5), fieldCount: z.number().int() })).max(8),
  dependencies: z.array(z.object({ name: z.string(), version: z.string() })).max(12),
});
export const workspaceListFilesArgsSchema = z.object({ maxEntries: z.number().int().min(1).max(300).default(100) });
export const workspaceListFilesResultSchema = z.object({
  entries: z.array(z.object({ path: z.string().max(300), type: z.enum(["file", "dir"]), size: z.number().int(), systemOwned: z.boolean() })).max(300),
  truncated: z.boolean(),
});

// ── dependency tools ──
export const dependencyListArgsSchema = z.object({}).strict();
export const dependencyListResultSchema = z.object({
  dependencies: z.array(z.object({ name: z.string(), version: z.string() })).max(12),
  allowlist: z.array(z.object({ name: z.string(), version: z.string() })).max(20),
});
export const dependencyAddArgsSchema = z.object({ name: z.string().min(1).max(64), version: z.string().min(1).max(32).optional() });
export const dependencyAddResultSchema = z.object({ added: z.literal(true), name: z.string(), version: z.string(), dependencies: z.array(z.object({ name: z.string(), version: z.string() })).max(12) });
export const dependencyRemoveArgsSchema = z.object({ name: z.string().min(1).max(64) });
export const dependencyRemoveResultSchema = z.object({ removed: z.boolean(), dependencies: z.array(z.object({ name: z.string(), version: z.string() })).max(12) });

// ── checks (new runner/builder based) ──
export const workspaceCheckArgsSchema = z.object({ timeoutMs: z.number().int().min(1000).max(300000).default(180000) });
export const workspaceCheckResultSchema = z.object({
  status: z.enum(["passed", "failed", "timeout"]),
  exitCode: z.number().int(),
  summary: z.string().max(3000),
});
export const runBuildArgsSchema = z.object({}).strict();
export const runBuildResultSchema = z.object({
  status: z.enum(["success", "failed"]),
  errorCode: z.string().max(60).nullable(),
  message: z.string().max(500).nullable(),
  log: z.string().max(3000),
  outputBytes: z.number().int(),
  durationMs: z.number().int(),
  buildArtifactId: z.string().nullable(),
  previewArtifactId: z.string().nullable(),
  files: z.array(z.object({ path: z.string().max(300), hash: z.string().max(64) })).max(80),
});
export const getBuildErrorsResultSchema = z.object({
  hasReport: z.boolean(),
  status: z.enum(["success", "failed", "none"]),
  errorCode: z.string().max(60).nullable(),
  message: z.string().max(500).nullable(),
  log: z.string().max(3000),
});
export const getTestFailuresResultSchema = z.object({
  hasReport: z.boolean(),
  status: z.enum(["passed", "failed", "none"]),
  summary: z.string().max(3000),
});
export const runFormatArgsSchema = z.object({}).strict();
export const runFormatResultSchema = z.object({ formatted: z.number().int(), changed: z.number().int(), summary: z.string().max(2000) });

// ── security scan / snapshots ──
export const securityScanArgsSchema = z.object({}).strict();
export const securityScanResultSchema = z.object({
  status: z.enum(["pass", "blocked"]),
  findings: z.array(z.object({ path: z.string().max(300), line: z.number().int(), rule: z.string().max(60), message: z.string().max(300) })).max(40),
  filesScanned: z.number().int(),
});
export const createCodeSnapshotArgsSchema = z.object({}).strict();
export const createCodeSnapshotResultSchema = z.object({ snapshotId: z.string(), artifactId: z.string(), files: z.array(z.object({ path: z.string().max(300), hash: z.string().max(64), size: z.number().int() })).max(80) });
export const restoreCodeSnapshotArgsSchema = z.object({ snapshotId: z.string().min(8).max(64) });
export const restoreCodeSnapshotResultSchema = z.object({ restored: z.number().int(), snapshotId: z.string() });

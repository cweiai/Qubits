import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { runMikeOrchestrator } from "@/lib/ai/mike-orchestrator";
import type { StoredArtifactEntry } from "@/lib/ai/artifact-store";
import {
  productBriefWithSummarySchema,
  codeWorkspaceSchema,
} from "@/lib/contracts/artifacts";
import { parseManifestText } from "@/lib/contracts/manifest";
import type { AgentEvent, RoleId } from "@/lib/contracts/agent-events";
import { getSandboxProvider } from "@/lib/ai/tools/sandbox-provider";
import { listSourceFiles } from "@/lib/workspace/workspace-manager";
import { openaiProvider } from "@/lib/ai/openai-provider";
import type { AIProvider, GenerateWithToolsInput } from "@/lib/ai/provider";

/**
 * Opt-in real-model evaluation. Domains are test data only: every case traverses the
 * same production orchestrator, role prompts, tools, schemas, and build gates.
 */

interface EvaluationCase {
  id: string;
  prompt: string;
  semanticTerms: RegExp;
}

interface EvaluationResult {
  appName: string;
  sourceDigest: string;
}

const CASES: EvaluationCase[] = [
  {
    id: "focus-timer",
    prompt:
      "创建一个精致的番茄钟网页应用，支持专注/休息倒计时、开始暂停重置、轮次统计和专注记录，移动端也要好用。",
    semanticTerms: /番茄|专注|计时|倒计时|pomodoro|focus|timer/i,
  },
  {
    id: "restaurant-ordering",
    prompt:
      "创建一个移动端点餐网页应用，展示分类菜单和菜品详情，支持购物车数量调整、备注、金额汇总和提交订单。",
    semanticTerms: /点餐|菜单|菜品|购物车|订单|restaurant|menu|cart|order/i,
  },
  {
    id: "sales-dashboard",
    prompt:
      "创建一个销售分析仪表盘，包含关键指标、收入趋势、渠道对比、日期筛选和可浏览的交易明细。",
    semanticTerms:
      /销售|收入|渠道|交易|仪表盘|sales|revenue|channel|dashboard/i,
  },
  {
    id: "designer-portfolio",
    prompt:
      "创建一个视觉设计师作品集网页应用，包含个人介绍、项目画廊、案例详情、技能与联系信息，并支持维护项目内容。",
    semanticTerms:
      /设计师|作品集|项目|案例|画廊|portfolio|project|gallery|case study/i,
  },
];

function selectCases(): EvaluationCase[] {
  const raw = process.env.QUBITS_EVAL_CASES?.trim();
  if (!raw) return CASES;
  const requested = new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const selected = CASES.filter((evaluation) => requested.has(evaluation.id));
  const unknown = [...requested].filter(
    (id) => !CASES.some((evaluation) => evaluation.id === id),
  );
  if (unknown.length > 0)
    throw new Error("Unknown QUBITS_EVAL_CASES: " + unknown.join(", "));
  if (selected.length === 0)
    throw new Error("QUBITS_EVAL_CASES selected no cases");
  return selected;
}

const REQUIRED_ROLES: RoleId[] = [
  "product_manager",
  "engineer",
];
const selectedCases = selectCases();
const originalEnvironment = {
  searchProvider: process.env.REFERENCE_SEARCH_PROVIDER,
  sandboxProvider: process.env.SANDBOX_PROVIDER,
};
const results = new Map<string, EvaluationResult>();
let rootDir = "";

function restoreEnvironment(name: keyof typeof originalEnvironment, envName: string): void {
  const value = originalEnvironment[name];
  if (value == null) delete process.env[envName];
  else process.env[envName] = value;
}

function oneArtifact(
  entries: StoredArtifactEntry[],
  kind: StoredArtifactEntry["ref"]["kind"],
): StoredArtifactEntry {
  const matches = entries.filter((entry) => entry.ref.kind === kind);
  expect(matches, `expected one ${kind} artifact`).toHaveLength(1);
  return matches[0];
}

function latestArtifact(
  entries: StoredArtifactEntry[],
  kind: StoredArtifactEntry["ref"]["kind"],
): StoredArtifactEntry {
  const matches = entries.filter((entry) => entry.ref.kind === kind);
  expect(
    matches.length,
    `expected at least one ${kind} artifact`,
  ).toBeGreaterThan(0);
  return matches[matches.length - 1];
}

function sourceCorpus(workspaceDir: string): string {
  return listSourceFiles(workspaceDir)
    .filter((file) => file.path !== "src/lib/qubits.ts")
    .map((file) => readFileSync(file.abs, "utf8"))
    .join("\n");
}

function appendTrace(file: string, entry: unknown): void {
  appendFileSync(
    file,
    JSON.stringify({ at: new Date().toISOString(), ...(entry as object) }) +
      "\n",
    "utf8",
  );
}

function tracedProvider(traceFile: string): AIProvider {
  return {
    kind: "openai",
    async generateWithTools(input: GenerateWithToolsInput) {
      const startedAt = Date.now();
      try {
        const response = await openaiProvider.generateWithTools(input);
        appendTrace(traceFile, {
          kind: "provider_turn",
          roleId: input.roleId,
          durationMs: Date.now() - startedAt,
          toolChoice: input.toolChoice ?? { mode: "auto" },
          exposedTools: input.tools.map((tool) => tool.name),
          content: response.content?.slice(0, 12_000) ?? null,
          reasoningLength: response.reasoningContent?.length ?? 0,
          toolCalls: response.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            rawArguments: call.rawArguments.slice(0, 20_000),
          })),
        });
        return response;
      } catch (error) {
        appendTrace(traceFile, {
          kind: "provider_error",
          roleId: input.roleId,
          durationMs: Date.now() - startedAt,
          code:
            error && typeof error === "object" && "code" in error
              ? String(error.code)
              : null,
          message:
            error instanceof Error
              ? error.message.slice(0, 1000)
              : String(error).slice(0, 1000),
        });
        throw error;
      }
    },
  };
}

beforeAll(() => {
  expect(
    process.env.OPENAI_API_KEY,
    "OPENAI_API_KEY is required for npm run eval:real",
  ).toBeTruthy();
  process.env.SANDBOX_PROVIDER = "container";
  const sandbox = getSandboxProvider();
  expect(
    sandbox.isAvailable(),
    "Docker is required for npm run eval:real",
  ).toBe(true);
  const outputDir = path.join(process.cwd(), "test-results", "real-generation");
  mkdirSync(outputDir, { recursive: true });
  rootDir = mkdtempSync(path.join(outputDir, "run-"));
  console.info("Real-generation traces: " + rootDir);
});

afterAll(() => {
  restoreEnvironment("searchProvider", "REFERENCE_SEARCH_PROVIDER");
  restoreEnvironment("sandboxProvider", "SANDBOX_PROVIDER");
});

describe.sequential("real-model domain-agnostic application generation", () => {
  for (const evaluation of selectedCases) {
    it(`generates and validates ${evaluation.id}`, async () => {
      const caseDir = path.join(rootDir, evaluation.id);
      const workspaceDir = path.join(caseDir, "workspace");
      const traceFile = path.join(caseDir, "trace.jsonl");
      mkdirSync(caseDir, { recursive: true });
      const events: AgentEvent[] = [];
      let artifacts: StoredArtifactEntry[] = [];

      const result = await runMikeOrchestrator({
        prompt: evaluation.prompt,
        currentManifest: null,
        currentAppId: "eval-" + evaluation.id,
        currentVersion: 0,
        projectRecords: null,
        workspaceDir,
        persistArtifacts: (entries) => { artifacts = entries; },
        providerOverride: tracedProvider(traceFile),
        emit: (event) => {
          events.push(event);
          appendTrace(traceFile, { kind: "agent_event", event });
          if (
            event.type === "agent_started" ||
            event.type === "agent_completed" ||
            event.type === "agent_failed" ||
            event.type === "error"
          ) {
            console.info(
              evaluation.id +
                ": " +
                event.type +
                " " +
                ("roleId" in event ? (event.roleId ?? "") : ""),
            );
          }
        },
      });

      expect(result, result.summary).toMatchObject({ status: "completed" });
      expect(events[0]).toMatchObject({
        type: "agent_started",
        roleId: "team_leader",
      });
      expect(events.some((event) => event.type === "preview_ready")).toBe(true);
      expect(events.some((event) => event.type === "run_completed")).toBe(true);
      expect(events.some((event) => event.type === "error")).toBe(false);

      const delegatedRoles = events
        .filter((event) => event.type === "agent_delegated")
        .map((event) => event.targetRole);
      let previousIndex = -1;
      for (const role of REQUIRED_ROLES) {
        const index = delegatedRoles.indexOf(role);
        expect(index, `${role} was not delegated in order`).toBeGreaterThan(
          previousIndex,
        );
        previousIndex = index;
      }

      const brief = oneArtifact(artifacts, "product_brief");
      // Repairs legitimately create multiple versions; only the latest is promotable.
      const codeWorkspace = latestArtifact(artifacts, "code_workspace");
      const security = latestArtifact(artifacts, "security_report");
      const tests = latestArtifact(artifacts, "test_report");
      const build = latestArtifact(artifacts, "build_report");
      const preview = latestArtifact(artifacts, "preview_bundle");

      expect(productBriefWithSummarySchema.safeParse(brief.value).success).toBe(
        true,
      );
      const parsedCodeWorkspace = codeWorkspaceSchema.parse(
        codeWorkspace.value,
      );
      expect(parsedCodeWorkspace.buildStatus).toBe("success");
      const referencedBuild = artifacts.find(
        (entry) => entry.ref.id === parsedCodeWorkspace.buildArtifactId,
      );
      expect(referencedBuild?.ref.kind).toBe("build_report");
      expect(referencedBuild?.value).toMatchObject({
        status: "success",
        errorCode: null,
      });
      expect(security?.value).toMatchObject({ status: "pass", findings: [] });
      expect(tests?.value).toMatchObject({ status: "passed" });
      expect(build?.value).toMatchObject({
        status: "success",
        errorCode: null,
      });
      expect(preview?.value).toMatchObject({ bytes: expect.any(Number) });

      const manifestRaw = readFileSync(
        path.join(workspaceDir, "qubits.manifest.json"),
        "utf8",
      );
      const manifest = parseManifestText(manifestRaw);
      expect(manifest.ok).toBe(true);
      if (!manifest.ok) throw new Error(manifest.issues.join("; "));
      expect(manifest.manifest.collections.length).toBeGreaterThan(0);

      const corpus = [
        JSON.stringify(brief.value),
        manifestRaw,
        sourceCorpus(workspaceDir),
      ].join("\n");
      expect(corpus).toMatch(evaluation.semanticTerms);
      expect(corpus).not.toContain("Mock 任务管理器");
      expect(
        listSourceFiles(workspaceDir).some((file) =>
          /\.test\.(ts|tsx)$/.test(file.path),
        ),
      ).toBe(true);

      results.set(evaluation.id, {
        appName: manifest.manifest.name,
        sourceDigest: createHash("sha256")
          .update(sourceCorpus(workspaceDir))
          .digest("hex"),
      });
    });
  }

  it.skipIf(selectedCases.length < 2)(
    "produces distinct applications across unrelated requests",
    () => {
      if (results.size !== selectedCases.length) return;
      expect(results.size).toBe(selectedCases.length);
      expect(
        new Set([...results.values()].map((result) => result.appName)).size,
      ).toBe(selectedCases.length);
      expect(
        new Set([...results.values()].map((result) => result.sourceDigest))
          .size,
      ).toBe(selectedCases.length);
    },
  );
});

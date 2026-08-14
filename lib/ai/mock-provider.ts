import "server-only";
import type { AIProvider, AgentTurnResponse, GenerateWithToolsInput } from "./provider";

/**
 * Test mock provider: only replaces the external model service (enabled when
 * QUIBITS_MOCK_PROVIDER=true); it does not replace tool-call logic — Mike's tool
 * calls, delegation, Alex's REAL fs_write / run_typecheck / run_tests / run_build,
 * the Reviewer and preview/complete all run the real execution path.
 */

const MIKE_SEQUENCE: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: "delegate_to_agent", args: { targetRole: "product_manager", task: "分析用户需求并产出产品简报", expectedOutput: "product_brief", inputArtifactIds: [] } },
  { name: "delegate_to_agent", args: { targetRole: "architect", task: "基于产品简报设计应用蓝图", expectedOutput: "app_blueprint", inputArtifactIds: ["$product_brief"] } },
  { name: "delegate_to_agent", args: { targetRole: "engineer", task: "基于简报与蓝图编写真实 React 代码并构建", expectedOutput: "code_workspace", inputArtifactIds: ["$product_brief", "$app_blueprint"] } },
  { name: "delegate_to_agent", args: { targetRole: "reviewer", task: "读取代码与构建报告并执行安全审校", expectedOutput: "review_report", inputArtifactIds: ["$code_workspace"] } },
  { name: "render_preview", args: { artifactId: "$preview_bundle", reason: "initial_generation", deviceHint: null } },
  { name: "complete_run", args: { summary: "应用已生成并通过构建、评审与预览", nextSuggestions: ["继续对话修改应用"] } },
];

const MOCK_MANIFEST_JSON = JSON.stringify(
  {
    schemaVersion: 1,
    name: "Mock 任务管理器",
    description: "Mock 生成的任务管理应用：新增、完成、删除、筛选与统计，数据经 Qubits SDK 持久化。",
    main: "src/main.tsx",
    collections: [
      {
        name: "tasks",
        label: "任务",
        fields: [
          { name: "title", label: "任务标题", type: "text", required: true, maxLength: 120 },
          { name: "priority", label: "优先级", type: "select", required: true, options: ["高", "中", "低"] },
          { name: "completed", label: "已完成", type: "boolean", required: false },
        ],
        allowedOperations: ["list", "count", "create", "update", "delete"],
      },
    ],
    dependencies: [],
  },
  null,
  2
);

const MOCK_APP_TSX = `import { useCallback, useEffect, useMemo, useState } from "react";

interface Task {
  id: string;
  title: string;
  priority: "高" | "中" | "低";
  completed: boolean;
}

type Filter = "all" | "active" | "completed";

function toTask(record: Record<string, unknown>): Task {
  const priority = record.priority === "高" || record.priority === "中" || record.priority === "低" ? record.priority : "中";
  return {
    id: typeof record.id === "string" ? record.id : "",
    title: typeof record.title === "string" ? record.title : "",
    priority,
    completed: record.completed === true,
  };
}

export function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<"高" | "中" | "低">("中");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const records = (await window.Qubits.data.list("tasks")) as unknown[];
      setTasks(
        records
          .filter((record): record is Record<string, unknown> => typeof record === "object" && record !== null)
          .map(toTask)
      );
      setError(null);
    } catch (err) {
      const record = err as { message?: string };
      setError(typeof record?.message === "string" ? record.message : "数据服务暂时不可用");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return tasks.filter((task) => {
      if (filter === "active" && task.completed) return false;
      if (filter === "completed" && !task.completed) return false;
      if (needle && !task.title.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [tasks, filter, search]);

  const addTask = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      await window.Qubits.data.create("tasks", { title: trimmed, priority, completed: false });
      setTitle("");
      await reload();
    } catch (err) {
      const record = err as { message?: string };
      setError(typeof record?.message === "string" ? record.message : "新增失败");
    }
  }, [title, priority, reload]);

  const toggleTask = useCallback(
    async (task: Task) => {
      try {
        await window.Qubits.data.update("tasks", task.id, { completed: !task.completed });
        await reload();
      } catch (err) {
        const record = err as { message?: string };
        setError(typeof record?.message === "string" ? record.message : "更新失败");
      }
    },
    [reload]
  );

  const deleteTask = useCallback(
    async (task: Task) => {
      try {
        await window.Qubits.data.delete("tasks", task.id);
        await reload();
      } catch (err) {
        const record = err as { message?: string };
        setError(typeof record?.message === "string" ? record.message : "删除失败");
      }
    },
    [reload]
  );

  const context = window.Qubits.app.getContext();
  const total = tasks.length;
  const active = tasks.filter((t) => !t.completed).length;
  const completed = total - active;

  return (
    <div className="mock-app" data-testid="template-app">
      <header className="mock-header">
        <h1 data-testid="app-title">{context.name || "任务管理器"}</h1>
        <p>数据保存在后端数据库 · 刷新后依然存在</p>
      </header>
      <section className="mock-panel">
        <h2>新增任务</h2>
        <div className="mock-form">
          <input
            data-testid="todo-input"
            placeholder="任务标题"
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addTask();
            }}
          />
          <select data-testid="todo-priority" value={priority} onChange={(e) => setPriority(e.target.value as "高" | "中" | "低")}>
            <option value="高">高</option>
            <option value="中">中</option>
            <option value="低">低</option>
          </select>
          <button data-testid="todo-add" disabled={title.trim().length === 0} onClick={() => void addTask()}>
            添加
          </button>
        </div>
      </section>
      <section className="mock-stats" data-testid="task-stats">
        <div className="mock-stat">
          <span data-testid="stat-total">{total}</span>
          <span>全部</span>
        </div>
        <div className="mock-stat">
          <span data-testid="stat-active">{active}</span>
          <span>进行中</span>
        </div>
        <div className="mock-stat">
          <span data-testid="stat-completed">{completed}</span>
          <span>已完成</span>
        </div>
      </section>
      <section className="mock-panel">
        <div className="mock-toolbar">
          <h2>任务列表</h2>
          <div data-testid="todo-filters">
            {(["all", "active", "completed"] as const).map((value) => (
              <button
                key={value}
                type="button"
                data-testid={"filter-" + value}
                className={filter === value ? "mock-filter mock-filter-active" : "mock-filter"}
                onClick={() => setFilter(value)}
              >
                {value === "all" ? "全部" : value === "active" ? "进行中" : "已完成"}
              </button>
            ))}
          </div>
          <input data-testid="todo-search" placeholder="搜索任务" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {error ? <p className="mock-error" data-testid="todo-notice">{error}</p> : null}
        {loading ? (
          <p>正在加载任务…</p>
        ) : visible.length === 0 ? (
          <p className="mock-empty" data-testid="todo-empty">{tasks.length === 0 ? "还没有任务，先添加一个吧。" : "没有匹配的任务。"}</p>
        ) : (
          <ul data-testid="todo-list">
            {visible.map((task) => (
              <li key={task.id} className={"mock-item" + (task.completed ? " mock-item-done" : "")} data-testid="todo-item">
                <label>
                  <input type="checkbox" data-testid="todo-toggle" checked={task.completed} onChange={() => void toggleTask(task)} />
                  <span data-testid="todo-title">{task.title}</span>
                </label>
                <span className="mock-badge">{task.priority}</span>
                <button data-testid="todo-delete" aria-label="删除任务" onClick={() => void deleteTask(task)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
`;

const MOCK_STYLES_CSS = `body {
  margin: 0;
  font-family: system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
  background: #f4f6f8;
  color: #0f172a;
}
.mock-app {
  max-width: 640px;
  margin: 0 auto;
  padding: 20px 14px 40px;
}
.mock-header h1 {
  margin: 0;
  font-size: 22px;
  color: #0f766e;
}
.mock-header p {
  margin: 4px 0 0;
  font-size: 12px;
  color: #64748b;
}
.mock-panel {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 14px;
  margin-top: 14px;
}
.mock-panel h2 {
  margin: 0 0 10px;
  font-size: 14px;
}
.mock-form {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.mock-form input,
.mock-form select {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 8px;
  font-size: 14px;
}
.mock-form input {
  flex: 1 1 180px;
}
.mock-form button,
.mock-item button {
  border: none;
  border-radius: 8px;
  padding: 8px 14px;
  font-size: 13px;
  background: #0f766e;
  color: #ffffff;
  cursor: pointer;
}
.mock-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-top: 14px;
}
.mock-stat {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  font-size: 12px;
  color: #64748b;
}
.mock-stat span:first-child {
  font-size: 20px;
  font-weight: 700;
  color: #0f172a;
}
.mock-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.mock-toolbar h2 {
  margin: 0;
}
.mock-toolbar input {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 13px;
  flex: 0 1 140px;
}
.mock-filter {
  border: 1px solid #e2e8f0;
  background: #ffffff;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}
.mock-filter-active {
  background: #0f766e;
  color: #ffffff;
}
.mock-item {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 6px;
  list-style: none;
}
.mock-item label {
  flex: 1 1 auto;
  display: flex;
  gap: 8px;
  align-items: center;
}
.mock-item-done span {
  text-decoration: line-through;
  color: #94a3b8;
}
.mock-badge {
  font-size: 11px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 1px 6px;
  color: #475569;
}
.mock-empty,
.mock-error {
  font-size: 13px;
}
.mock-error {
  color: #b91c1c;
}
`;

const ENGINEER_SEQUENCE: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: "workspace_init", args: {} },
  { name: "fs_write", args: { path: "qubits.manifest.json", content: MOCK_MANIFEST_JSON } },
  { name: "fs_write", args: { path: "src/App.tsx", content: MOCK_APP_TSX } },
  { name: "fs_write", args: { path: "src/styles.css", content: MOCK_STYLES_CSS } },
  { name: "run_typecheck", args: { timeoutMs: 180000 } },
  { name: "run_tests", args: { timeoutMs: 180000 } },
  { name: "run_build", args: {} },
];

function finalJsonFor(roleId: string): { content: string; toolCalls: []; reasoningContent: null } {
  switch (roleId) {
    case "team_leader":
      return { content: JSON.stringify({ ok: true, summary: "完成" }), toolCalls: [], reasoningContent: null };
    case "product_manager":
      return {
        content: JSON.stringify({
          appName: "Mock 任务管理器",
          targetUser: "个人用户",
          problem: "管理日常任务",
          coreFeatures: ["新增任务", "标记完成", "统计"],
          primaryEntity: "任务",
          assumptions: ["mock"],
          outOfScope: [],
          summary: "Mock 产品简报",
        }),
        toolCalls: [],
        reasoningContent: null,
      };
    case "researcher":
      return {
        content: JSON.stringify({
          summary: "Mock 研究",
          findings: [{ title: "Mock 参考", url: "https://example.com/mock", domain: "example.com", snippet: "mock", relevance: "一般" }],
          recommendations: [],
        }),
        toolCalls: [],
        reasoningContent: null,
      };
    case "architect":
      return {
        content: JSON.stringify({
          appType: "任务管理",
          dataModel: {
            primaryCollection: "tasks",
            collections: [
              {
                name: "tasks",
                label: "任务",
                fields: [
                  { name: "title", label: "任务标题", type: "text", required: true },
                  { name: "priority", label: "优先级", type: "select", required: true, options: ["高", "中", "低"] },
                  { name: "completed", label: "已完成", type: "boolean", required: false },
                ],
                allowedOperations: ["list", "count", "create", "update", "delete"],
              },
            ],
          },
          pages: [
            {
              id: "home",
              title: "任务看板",
              purpose: "新增、完成、删除、筛选与统计任务",
              sections: [
                { id: "header", kind: "header", title: "任务管理器", description: "顶部标题" },
                { id: "form", kind: "form", title: "新增任务", description: "任务表单", data: { collection: "tasks", fields: ["title", "priority"] } },
                { id: "stats", kind: "stats", title: "统计", description: "计数卡片", data: { collection: "tasks" } },
                { id: "list", kind: "list", title: "任务列表", description: "筛选/搜索/操作", data: { collection: "tasks" } },
              ],
            },
          ],
          components: [{ id: "todo-item", name: "TodoItem", purpose: "单条任务行", props: ["task", "onToggle", "onDelete"] }],
          state: [{ name: "tasks", description: "任务列表（Qubits SDK 读取）", scope: "app" }],
          technicalApproach: {
            styling: "普通 CSS 类名",
            dataFlow: "window.Qubits.data CRUD + MessageChannel",
            build: "系统 esbuild/postcss 构建",
            testing: "vitest 逻辑测试",
          },
          validationRules: ["标题必填"],
          visualDirection: "浅中性背景 + teal 主色",
          summary: "Mock 蓝图",
        }),
        toolCalls: [],
        reasoningContent: null,
      };
    case "data_scientist":
      return {
        content: JSON.stringify({
          summary: "Mock 数据分析",
          metrics: [{ metric: "count", fieldId: null, value: 0, note: "mock" }],
          timeRange: "mock",
          recommendations: [],
        }),
        toolCalls: [],
        reasoningContent: null,
      };
    case "reviewer":
    case "security_reviewer":
      return {
        content: JSON.stringify({ approved: true, summary: "Mock 评审通过", issues: [] }),
        toolCalls: [],
        reasoningContent: null,
      };
    default:
      return { content: JSON.stringify({ summary: "Mock 完成", ok: true }), toolCalls: [], reasoningContent: null };
  }
}

/** Parse the last real run_build tool result to fill the engineer's final output truthfully. */
function engineerFinalFromMessages(messages: Array<{ role: string; content: string | null }>): { content: string; toolCalls: []; reasoningContent: null } {
  let buildStatus: "success" | "failed" | "not_run" = "not_run";
  let previewArtifactId: string | null = null;
  let files: Array<{ path: string; hash: string }> = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    try {
      const parsed = JSON.parse(message.content) as {
        status?: string;
        outputBytes?: number;
        previewArtifactId?: string | null;
        files?: Array<{ path: string; hash: string }>;
      };
      // only the run_build result carries outputBytes — skip other check results
      if (typeof parsed.outputBytes === "number" && (parsed.status === "success" || parsed.status === "failed")) {
        buildStatus = parsed.status;
        previewArtifactId = parsed.previewArtifactId ?? null;
        files = (parsed.files ?? []).slice(0, 30);
        break;
      }
    } catch {
      // ignore
    }
  }
  return {
    content: JSON.stringify({
      summary: "Mock 代码工作区（真实工具调用产物）",
      files,
      manifest: { name: "Mock 任务管理器", collections: JSON.parse(MOCK_MANIFEST_JSON).collections },
      buildStatus,
      buildArtifactId: previewArtifactId,
      notes: buildStatus === "success" ? ["构建成功"] : [],
    }),
    toolCalls: [],
    reasoningContent: null,
  };
}

function toolResultsCount(messages: Array<{ role: string }>): number {
  return messages.filter((m) => m.role === "tool").length;
}

/** e2e failure injection: the engineer writes an unallowed dependency when the marker is present. */
const BAD_DEPENDENCY_MARKER = "【注入非法依赖】";

function hasBadDependencyInjection(messages: Array<{ role: string; content: string | null }>): boolean {
  return messages.some(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.includes(BAD_DEPENDENCY_MARKER)
  );
}

const BAD_APP_TSX = `import leftPad from "left-pad";

export function App() {
  return <div className="bad-app">{leftPad("1", 4)}</div>;
}
`;

function engineerStepCall(step: number, bad: boolean): { name: string; args: Record<string, unknown> } {
  const next = ENGINEER_SEQUENCE[step];
  if (bad && next.name === "fs_write" && next.args.path === "src/App.tsx") {
    return { name: "fs_write", args: { path: "src/App.tsx", content: BAD_APP_TSX } };
  }
  return next;
}

export const mockProvider: AIProvider = {
  kind: "mock",
  async generateWithTools(input: GenerateWithToolsInput): Promise<AgentTurnResponse> {
    // Test hook: QUIBITS_MOCK_DELAY_MS delays each model turn to exercise NDJSON timing.
    const delayMs = Number.parseInt(process.env.QUIBITS_MOCK_DELAY_MS ?? "0", 10);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const messages = input.messages;
    const roleId = input.roleId;
    if (roleId === "engineer") {
      const step = Math.min(toolResultsCount(messages), ENGINEER_SEQUENCE.length);
      if (step < ENGINEER_SEQUENCE.length) {
        const next = engineerStepCall(step, hasBadDependencyInjection(messages));
        return {
          content: null,
          toolCalls: [{ id: "tc-eng-" + step + "-" + Math.random().toString(36).slice(2, 6), name: next.name, rawArguments: JSON.stringify(next.args) }],
          reasoningContent: null,
        };
      }
      return engineerFinalFromMessages(messages);
    }
    if (roleId !== "team_leader") {
      return finalJsonFor(roleId);
    }
    // Mike: advance the scripted sequence by the tool results already produced (real execution still happens)
    const step = Math.min(toolResultsCount(messages), MIKE_SEQUENCE.length);
    if (step < MIKE_SEQUENCE.length) {
      const next = MIKE_SEQUENCE[step];
      const args = { ...next.args };
      // replace placeholders with real artifact ids (extractable from tool results)
      if (Array.isArray(args.inputArtifactIds)) {
        const replaced: string[] = [];
        for (const id of args.inputArtifactIds as string[]) {
          if (typeof id !== "string" || !id.startsWith("$")) {
            replaced.push(id);
            continue;
          }
          const kind = id.slice(1);
          const found = findArtifactIdInResults(messages, kind);
          if (found) replaced.push(found);
        }
        args.inputArtifactIds = replaced;
      }
      if (next.name === "render_preview") {
        const found = findArtifactIdInResults(messages, "preview_bundle");
        if (found) (args as { artifactId: string }).artifactId = found;
      }
      // Failure-injection marker from the root user prompt must reach Alex's task.
      if (next.name === "delegate_to_agent" && args.targetRole === "engineer" && hasBadDependencyInjection(messages)) {
        args.task = String(args.task) + " " + BAD_DEPENDENCY_MARKER;
      }
      return {
        content: null,
        toolCalls: [{ id: "tc-mock-" + step + "-" + Math.random().toString(36).slice(2, 6), name: next.name, rawArguments: JSON.stringify(args) }],
        reasoningContent: null,
      };
    }
    return { content: JSON.stringify({ ok: true, summary: "Mock 完成" }), toolCalls: [], reasoningContent: null };
  },
};

function findArtifactIdInResults(messages: Array<{ role: string; content: string | null }>, kind: string): string | null {
  // Find the artifact id in completed delegate_to_agent tool results (or a preview bundle id).
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role: string; content: string | null };
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    try {
      const parsed = JSON.parse(message.content) as {
        targetRole?: string;
        artifactId?: string | null;
        previewArtifactId?: string | null;
        relatedArtifacts?: Array<{ kind?: string; artifactId?: string }>;
      };
      if (kind === "preview_bundle") {
        const related = Array.isArray(parsed.relatedArtifacts)
          ? parsed.relatedArtifacts.find((entry) => entry.kind === "preview_bundle")
          : null;
        if (related?.artifactId) return related.artifactId;
        if (typeof parsed.previewArtifactId === "string") return parsed.previewArtifactId;
        continue;
      }
      const expectedRole = kindRoleOf(kind);
      if (typeof parsed.artifactId === "string" && expectedRole && parsed.targetRole === expectedRole) return parsed.artifactId;
    } catch {
      // ignore
    }
  }
  return null;
}

function kindRoleOf(kind: string): string | null {
  switch (kind) {
    case "product_brief":
      return "product_manager";
    case "app_blueprint":
      return "architect";
    case "code_workspace":
      return "engineer";
    case "review_report":
      return "reviewer";
    case "research_report":
      return "researcher";
    case "data_report":
      return "data_scientist";
    default:
      return null;
  }
}

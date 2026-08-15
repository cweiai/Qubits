import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const dbPath = path.join(root, "data", "e2e.db");
const projects = ["prj-e2e-00000001", "prj-e2e-00000002"];

for (const suffix of ["", "-shm", "-wal"]) rmSync(dbPath + suffix, { force: true });
for (const projectId of projects) {
  rmSync(path.join(root, "data", "snapshots", projectId), { recursive: true, force: true });
}
mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec(readFileSync(path.join(root, "lib", "db", "schema.sql"), "utf8"));

const manifest = {
  schemaVersion: 1,
  name: "通用工作台",
  description: "用于验证 Qubits 生产预览、快照和隔离边界的通用构建产物。",
  main: "src/main.tsx",
  appId: "e2e-workspace",
  collections: [
    {
      name: "entries",
      label: "条目",
      fields: [{ name: "title", label: "标题", type: "text", required: true, maxLength: 120 }],
      allowedOperations: ["list", "count", "create", "update", "delete"],
    },
  ],
  dependencies: [],
};

const sourceFiles = {
  "qubits.manifest.json": JSON.stringify(manifest, null, 2),
  "src/main.tsx": 'import { createRoot } from "react-dom/client";\nimport { App } from "./App";\nimport "./styles.css";\n\ncreateRoot(document.getElementById("root")!).render(<App />);\n',
  "src/App.tsx": 'export function App() {\n  return (\n    <main className="app-shell">\n      <p className="eyebrow">Qubits workspace</p>\n      <h1>通用工作台</h1>\n      <p>预览、代码快照和安全边界已连接。</p>\n      <section aria-label="运行状态">\n        <strong>系统就绪</strong>\n        <span>可以继续生成任意类型的网页应用。</span>\n      </section>\n    </main>\n  );\n}\n',
  "src/styles.css": 'html { color-scheme: light; }\nbody { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #f4f7fb; color: #172033; }\n.app-shell { max-width: 720px; margin: 0 auto; padding: 64px 24px; }\n.eyebrow { color: #1769aa; font-weight: 700; }\nh1 { font-size: 40px; margin: 8px 0 12px; }\nsection { display: grid; gap: 8px; margin-top: 32px; padding: 20px; border: 1px solid #d8e0ea; border-radius: 8px; background: white; }\n',
};

const previewHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data: blob:; font-src data:" />
  <title>通用工作台</title>
  <style>${sourceFiles["src/styles.css"]}</style>
</head>
<body>
  <main class="app-shell"><p class="eyebrow">Qubits workspace</p><h1>通用工作台</h1><p>预览、代码快照和安全边界已连接。</p><section aria-label="运行状态"><strong>系统就绪</strong><span>可以继续生成任意类型的网页应用。</span></section></main>
</body>
</html>`;

const roles = {
  team_leader: { status: "success", summary: "已完成通用应用构建。", startedAt: 1, completedAt: 6 },
  product_manager: { status: "success", summary: "需求已确认。", startedAt: 1, completedAt: 2 },
  engineer: { status: "success", summary: "代码和构建已完成。", startedAt: 3, completedAt: 5 },
};

const agentRuns = [
  { agentRunId: "run-mike", roleId: "team_leader", parentAgentRunId: null, status: "completed", taskSummary: "协调构建", summary: "已完成", at: 1 },
  { agentRunId: "run-emma", roleId: "product_manager", parentAgentRunId: "run-mike", status: "completed", taskSummary: "整理需求", summary: "需求已确认", at: 2 },
  { agentRunId: "run-alex", roleId: "engineer", parentAgentRunId: "run-mike", status: "completed", taskSummary: "实现应用", summary: "代码已完成", at: 4 },
];

const toolEvents = [
  { toolCallId: "call-plan", agentRunId: "run-mike", roleId: "team_leader", toolName: "delegate_to_agent", status: "success", inputSummary: "分配产品任务", resultSummary: "完成", errorCode: null, at: 1 },
  { toolCallId: "call-write", agentRunId: "run-alex", roleId: "engineer", toolName: "fs_write", status: "success", inputSummary: "写入应用", resultSummary: "完成", errorCode: null, at: 3 },
  { toolCallId: "call-tests", agentRunId: "run-alex", roleId: "engineer", toolName: "run_tests", status: "success", inputSummary: "执行测试", resultSummary: "通过", errorCode: null, at: 4 },
  { toolCallId: "call-build", agentRunId: "run-alex", roleId: "engineer", toolName: "run_build", status: "success", inputSummary: "构建应用", resultSummary: "完成", errorCode: null, at: 4 },
  { toolCallId: "call-security", agentRunId: "run-alex", roleId: "engineer", toolName: "security_scan", status: "success", inputSummary: "安全扫描", resultSummary: "通过", errorCode: null, at: 5 },
  { toolCallId: "call-preview", agentRunId: "run-mike", roleId: "team_leader", toolName: "render_preview", status: "success", inputSummary: "提交预览", resultSummary: "完成", errorCode: null, at: 6 },
];

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

function seedProject(projectId, index) {
  const conversationId = `conv-e2e-0000000${index}`;
  const taskId = `task-e2e-0000000${index}`;
  const snapshotId = `snap-e2e-0000000${index}`;
  const previewId = `art-preview-0000000${index}`;
  const now = Date.now() + index;
  const snapshotDir = path.join(root, "data", "snapshots", projectId, snapshotId);
  mkdirSync(snapshotDir, { recursive: true });
  const files = Object.entries(sourceFiles).map(([relativePath, content]) => {
    const target = path.join(snapshotDir, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    return { path: relativePath, hash: digest(content), size: Buffer.byteLength(content) };
  });

  db.prepare("INSERT INTO projects (id, created_at, updated_at) VALUES (?, ?, ?)").run(projectId, now, now);
  db.prepare("INSERT INTO conversations (id, project_id, title, title_source, status, manifest_json, current_snapshot_id, preview_bundle_id, preview_version, created_at, updated_at, last_message_at) VALUES (?, ?, ?, 'user', 'active', ?, ?, ?, 1, ?, ?, ?)")
    .run(conversationId, projectId, "通用工作台", JSON.stringify(manifest), snapshotId, previewId, now, now, now);
  db.prepare("INSERT INTO conversation_messages (id, conversation_id, role, content, status, metadata_json, request_id, task_id, created_at, updated_at) VALUES (?, ?, 'user', ?, 'completed', '{}', ?, ?, ?, ?)")
    .run(`msg-user-0000000${index}`, conversationId, "创建一个通用工作台", `req-e2e-0000000${index}`, taskId, now, now);
  db.prepare("INSERT INTO conversation_messages (id, conversation_id, role, content, status, metadata_json, task_id, role_id, message_kind, created_at, updated_at) VALUES (?, ?, 'assistant', ?, 'completed', ?, ?, 'team_leader', 'role', ?, ?)")
    .run(`msg-role-0000000${index}`, conversationId, "应用已生成并通过构建、测试、安全扫描与预览。", JSON.stringify({ kind: "role", roleId: "team_leader", taskId }), taskId, now + 1, now + 1);
  db.prepare("INSERT INTO build_tasks (id, project_id, conversation_id, user_message_id, prompt, status, stage, roles_json, agent_runs_json, tool_events_json, request_id, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'ready', 'ready', ?, ?, ?, ?, 0, ?, ?)")
    .run(taskId, projectId, conversationId, `msg-user-0000000${index}`, "创建一个通用工作台", JSON.stringify(roles), JSON.stringify(agentRuns), JSON.stringify(toolEvents), `req-e2e-0000000${index}`, now, now + 2);
  db.prepare("INSERT INTO artifacts (id, project_id, task_id, kind, name, content, created_at) VALUES (?, ?, ?, 'preview_bundle', 'preview_bundle', ?, ?)")
    .run(previewId, projectId, taskId, previewHtml, now + 3);
  db.prepare("INSERT INTO artifacts (id, project_id, task_id, kind, name, content, created_at) VALUES (?, ?, ?, 'build_report', 'build_report', ?, ?)")
    .run(`art-build-0000000${index}`, projectId, taskId, JSON.stringify({ status: "success", log: "typecheck ok\ntests ok\nsecurity_scan ok\nbuild ok" }), now + 4);
  db.prepare("INSERT INTO artifacts (id, project_id, task_id, kind, name, content, created_at) VALUES (?, ?, ?, 'test_report', 'test_report', ?, ?)")
    .run(`art-tests-0000000${index}`, projectId, taskId, JSON.stringify({ status: "passed", summary: "测试通过。" }), now + 4.5);
  db.prepare("INSERT INTO artifacts (id, project_id, task_id, kind, name, content, created_at) VALUES (?, ?, ?, 'security_report', 'security_report', ?, ?)")
    .run(`art-security-0000000${index}`, projectId, taskId, JSON.stringify({ status: "pass", findings: [], filesScanned: 3 }), now + 5);
  db.prepare("INSERT INTO code_snapshots (id, project_id, task_id, version, manifest_json, files_json, deps_json, build_report_json, review_report_json, preview_bundle_id, created_at) VALUES (?, ?, ?, 1, ?, ?, '[]', ?, ?, ?, ?)")
    .run(snapshotId, projectId, taskId, JSON.stringify(manifest), JSON.stringify(files), JSON.stringify({ status: "success", log: "security_scan ok" }), JSON.stringify({ approved: true, summary: "通过", issues: [] }), previewId, now + 6);
}

projects.forEach((projectId, index) => seedProject(projectId, index + 1));
db.close();

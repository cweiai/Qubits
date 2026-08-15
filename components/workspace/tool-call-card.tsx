"use client";

import {
  Boxes,
  Braces,
  Check,
  ClipboardCheck,
  Database,
  Eye,
  FileCode2,
  FilePen,
  FilePlus2,
  FileText,
  FlaskConical,
  FolderPlus,
  FolderTree,
  GitBranch,
  Globe,
  Hammer,
  ListChecks,
  Loader2,
  PackagePlus,
  PackageMinus,
  Search,
  ShieldCheck,
  Terminal,
  UserPlus,
  Wrench,
  X,
} from "lucide-react";
import { ROLE_META } from "@/lib/contracts/agent-events";
import { roleName, type ToolEventView } from "@/lib/workspace/message-view";
import { cn } from "@/lib/utils";

/**
 * Inline tool-call card, event-driven (running → success/failed). Result summaries are
 * human-readable text; legacy raw-JSON summaries are flattened client-side.
 */
export function ToolCallCard({ event }: { event: ToolEventView }) {
  const Icon = TOOL_ICONS[event.toolName] ?? Wrench;
  const roleLabel = event.roleId ? (ROLE_META[event.roleId]?.name ?? roleName(event.roleId)) : "";
  const summary =
    event.status === "success" ? formatResultText(event.toolName, event.resultSummary) : event.resultSummary;

  return (
    <div
      className={cn(
        "rounded-md border bg-white p-2.5 transition-colors",
        event.status === "failed" ? "border-red-200 bg-red-50/50" : "border-zinc-200"
      )}
      data-testid="tool-call-card"
      data-status={event.status}
    >
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
            event.status === "failed"
              ? "bg-red-100 text-red-600"
              : event.status === "success"
                ? "bg-emerald-50 text-emerald-700"
                : "bg-amber-50 text-amber-600"
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <span className="truncate">{TOOL_LABELS[event.toolName] ?? event.toolName}</span>
            {roleLabel ? <span className="shrink-0 text-muted-foreground">· {roleLabel}</span> : null}
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {event.status === "running" ? <Loader2 className="h-3 w-3 animate-spin text-amber-600" /> : null}
              {event.status === "success" ? <Check className="h-3 w-3 text-emerald-600" /> : null}
              {event.status === "failed" ? <X className="h-3 w-3 text-red-600" /> : null}
            </span>
          </p>
          {event.status === "running" ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground" title={event.inputSummary}>
              {event.inputSummary}
            </p>
          ) : event.status === "failed" ? (
            <p className="mt-0.5 text-xs text-red-600" title={summary}>
              {summary}
              {event.errorCode ? (
                <span className="ml-1 shrink-0 text-red-400">
                  {CONTROLLER_ERROR_LABELS[event.errorCode] ? "（" + CONTROLLER_ERROR_LABELS[event.errorCode] + "）" : "(" + event.errorCode + ")"}
                </span>
              ) : null}
            </p>
          ) : (
            <p className="mt-0.5 truncate text-xs text-muted-foreground" title={summary}>
              {summary}
            </p>
          )}
          {event.reference ? (
            <a
              href={event.reference.url}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-1 block truncate text-xs text-sky-700 hover:underline"
            >
              <span className="font-medium">{event.reference.domain}</span> · {event.reference.title}
              <span className="ml-1 text-muted-foreground">（{event.reference.source}）</span>
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Flatten legacy raw-JSON summaries; plain text passes through unchanged. */
function formatResultText(toolName: string, summary: string): string {
  const text = (summary ?? "").trim();
  if (!text) return "";
  if (!text.startsWith("{") && !text.startsWith("[")) return text;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return text.length > 160 ? text.slice(0, 160) + "…" : text;
    }
    const record = parsed as Record<string, unknown>;
    const specialized = formatLegacyRecord(toolName, record);
    if (specialized) return specialized;
    const parts = Object.entries(record)
      .filter(([, value]) => value !== undefined && value !== null)
      .slice(0, 5)
      .map(([key, value]) => key + " " + compactValue(value));
    return parts.length > 0 ? parts.join(" · ") : text;
  } catch {
    return text;
  }
}

/** Structured one-liner for common legacy JSON summaries (mirrors server summarizeResult). */
function formatLegacyRecord(toolName: string, record: Record<string, unknown>): string | null {
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  const num = (value: unknown): number => (typeof value === "number" ? value : Number(value) || 0);
  const len = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
  switch (toolName) {
    case "fs_write":
      return "写入 " + str(record.path) + "（" + num(record.bytesWritten) + " 字节）· " + str(record.diffSummary);
    case "fs_patch":
      return "修改 " + str(record.path) + "（" + num(record.replaced) + " 处）· " + str(record.diffSummary);
    case "fs_read":
      return "读取 " + str(record.path) + (record.truncated ? "（已截断）" : "");
    case "fs_list":
      return "列出 " + len(record.entries) + " 项";
    case "fs_stat":
      return "stat " + str(record.path) + "（" + str(record.type) + " · " + num(record.size) + " 字节）";
    case "fs_delete":
      return "已删除 " + str(record.path) + (record.soft ? "（软删除）" : "");
    case "workspace_init":
      return "工作区就绪 · " + num(record.fileCount) + " 个文件";
    case "workspace_list_files":
      return "共 " + len(record.entries) + " 项";
    case "workspace_get_manifest":
      return "manifest：「" + str(record.name) + "」· " + len(record.collections) + " 个集合";
    case "dependency_add":
      return "添加依赖 " + str(record.name) + "@" + str(record.version);
    case "dependency_remove":
      return (record.removed ? "已移除依赖 " : "依赖未声明：") + str(record.name);
    case "dependency_list":
      return "已声明 " + len(record.dependencies) + " 个依赖";
    case "run_lint":
    case "run_typecheck":
    case "run_tests": {
      const label = toolName === "run_lint" ? "Lint" : toolName === "run_typecheck" ? "类型检查" : "测试";
      const status = str(record.status);
      if (status === "passed") return label + "通过";
      if (status === "timeout") return label + "超时";
      return label + "失败（exitCode=" + num(record.exitCode) + "）";
    }
    case "run_build":
      return record.status === "success" ? "构建成功 · preview_bundle 已产出" : "构建失败：" + (str(record.errorCode) || "BUILD_FAILED");
    case "security_scan":
      return record.status === "pass"
        ? "静态扫描通过（" + num(record.filesScanned) + " 个文件）"
        : "发现 " + len(record.findings) + " 项阻断问题";
    case "create_code_snapshot":
      return "快照 " + str(record.snapshotId).slice(0, 12) + "…（" + len(record.files) + " 个文件）";
    case "restore_code_snapshot":
      return "已恢复 " + num(record.restored) + " 个文件";
    case "run_format":
      return "已检查 " + num(record.formatted) + " 个文件，改写 " + num(record.changed) + " 个";
    case "render_preview":
      return "预览已就绪：" + str(record.appName) + " v" + num(record.version);
    case "bash":
      return "命令 exitCode=" + num(record.exitCode) + (record.timedOut ? "（超时）" : "") + " · 输出 " + str(record.stdout).length + " 字符";
    default:
      return null;
  }
}

function compactValue(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 48);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length + " 项";
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return text.length > 56 ? text.slice(0, 56) + "…" : text;
  }
  return String(value ?? "");
}

const TOOL_ICONS: Record<string, typeof Wrench> = {
  delegate_to_agent: UserPlus,
  search_references: Search,
  open_reference: Globe,
  render_preview: Eye,
  complete_run: ClipboardCheck,
  security_scan: ShieldCheck,
  inspect_current_app: Search,
  analyze_project_data: Database,
  workspace_init: FolderPlus,
  workspace_get_manifest: FileText,
  workspace_list_files: FolderTree,
  dependency_add: PackagePlus,
  dependency_remove: PackageMinus,
  dependency_list: Boxes,
  create_code_snapshot: GitBranch,
  restore_code_snapshot: GitBranch,
  run_format: FilePen,
  run_lint: ListChecks,
  run_typecheck: Braces,
  run_tests: FlaskConical,
  run_build: Hammer,
  get_build_errors: Hammer,
  get_test_failures: FlaskConical,
  fs_write: FilePlus2,
  fs_read: FileText,
  fs_patch: FilePen,
  fs_list: FolderTree,
  fs_stat: FileCode2,
  fs_delete: X,
  fs_create_dir: FolderPlus,
  fs_copy: FileCode2,
  fs_move: FileCode2,
  bash: Terminal,
  query_records: Database,
  count_records: Database,
  create_record: Database,
  update_record: Database,
  delete_record: Database,
};

/** Friendly labels for Controller-level tool error codes (no-progress semantics). */
const CONTROLLER_ERROR_LABELS: Record<string, string> = {
  REPEATED_FAILED_CALL: "重复失败调用",
  DUPLICATE_OBSERVATION: "重复观察",
  NO_PROGRESS: "无进展",
  CONTROLLER_DIRECTIVE: "控制器指令",
};

const TOOL_LABELS: Record<string, string> = {
  delegate_to_agent: "分配任务",
  search_references: "搜索参考资料",
  open_reference: "读取参考来源",
  render_preview: "提交预览",
  complete_run: "完成运行",
  inspect_current_app: "检查当前应用",
  analyze_project_data: "数据分析",
  bash: "执行命令",
  workspace_init: "初始化工作区",
  workspace_get_manifest: "读取 manifest",
  workspace_list_files: "列出文件",
  dependency_add: "添加依赖",
  dependency_remove: "移除依赖",
  dependency_list: "依赖列表",
  security_scan: "安全扫描",
  create_code_snapshot: "创建快照",
  restore_code_snapshot: "恢复快照",
  run_format: "格式化",
  run_lint: "Lint 检查",
  run_typecheck: "类型检查",
  run_tests: "运行测试",
  run_build: "构建",
  get_build_errors: "构建错误",
  get_test_failures: "测试失败",
  fs_write: "写入文件",
  fs_read: "读取文件",
  fs_patch: "修改文件",
  fs_list: "列出目录",
  fs_stat: "文件信息",
  fs_delete: "删除文件",
  fs_create_dir: "创建目录",
  fs_copy: "复制文件",
  fs_move: "移动文件",
  query_records: "查询记录",
  count_records: "统计记录",
  create_record: "创建记录",
  update_record: "更新记录",
  delete_record: "删除记录",
};

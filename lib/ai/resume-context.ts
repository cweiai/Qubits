import "server-only";

/**
 * Builds the retry context: compresses the previous attempt's failures and completed
 * work into a short resume brief so Mike continues from the failure point.
 */

export interface ResumeSource {
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  agentRuns: Array<{
    roleId?: string;
    status?: string;
    summary?: string;
    artifactId?: string | null;
    errorMessage?: string;
  }>;
  toolEvents: Array<{
    roleId?: string;
    toolName?: string;
    status?: string;
    errorCode?: string | null;
    resultSummary?: string;
  }>;
}

const MAX_LINES = 24;

export function buildResumeContext(source: ResumeSource): string | null {
  if (source.attempts <= 0) return null;
  const lines: string[] = [];
  lines.push("【续跑第 " + source.attempts + " 次：从失败的那一步继续，不要从头重做】");
  lines.push("这是对上次失败任务的续跑。请先检查工作区现状（fs_list）与已有产物（get_artifact_list），确认哪些步骤已完成，然后直接从失败的那一步继续；已完成且仍然有效的步骤不要重复执行。");
  if (source.errorCode || source.errorMessage) {
    lines.push("上次失败：" + (source.errorCode ? "[" + source.errorCode + "] " : "") + (source.errorMessage ?? "").slice(0, 400));
  }
  const completed = source.agentRuns.filter((r) => r.status === "completed" && (r.summary || r.artifactId));
  if (completed.length > 0) {
    lines.push("已完成的角色：");
    for (const run of completed.slice(0, 8)) {
      lines.push("- " + (run.roleId ?? "未知角色") + (run.artifactId ? "（产物 " + run.artifactId + "）" : "") + (run.summary ? "：" + run.summary.slice(0, 160) : ""));
    }
  }
  const failed = source.agentRuns.filter((r) => r.status === "failed" || r.errorMessage);
  if (failed.length > 0) {
    lines.push("失败的角色：");
    for (const run of failed.slice(0, 4)) {
      lines.push("- " + (run.roleId ?? "未知角色") + (run.errorMessage ? "：" + run.errorMessage.slice(0, 200) : ""));
    }
  }
  const failedTools = source.toolEvents.filter((t) => t.status === "failed");
  if (failedTools.length > 0) {
    lines.push("失败的步骤：");
    for (const t of failedTools.slice(0, 8)) {
      lines.push("- " + (t.toolName ?? "未知工具") + (t.errorCode ? "（错误码 " + t.errorCode + "）" : "") + (t.resultSummary ? "：" + t.resultSummary.slice(0, 200) : ""));
    }
  }
  lines.push("工作区文件与已保存的产物仍然保留。请修改导致失败的做法后重试，而不是重复整个流程。");
  return lines.slice(0, MAX_LINES).join("\n");
}

import "server-only";
import { build as esbuildBuild, type Plugin } from "esbuild";
import autoprefixer from "autoprefixer";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import { MANIFEST_FILE_NAME, MANIFEST_MAIN } from "@/lib/contracts/manifest";
import { WorkspaceError, redactHostText } from "./errors";
import { checkWorkspaceDependencies } from "./dependency-policy";
import { scanWorkspace } from "./security-scan";
import { readWorkspaceManifest, requireWorkspace, workspaceFileManifest } from "./workspace-manager";
import {
  assertWorkspaceTreeSafe,
  readFileNofollow,
  safeResolveWorkspacePath,
  withWorkspaceLock,
  writeFileNofollow,
} from "./paths";

/**
 * Server-controlled builder. The generated code never controls the Vite/esbuild
 * configuration, plugins or package scripts: this module owns the bundle pipeline
 * (esbuild JS API + postcss/tailwind in-process — no npm install, no lifecycle
 * scripts, no network), and AI can only influence it through source files and the
 * validated manifest.
 */

export const BUILD_REPORT_NAME = "build-report.json";
export const PREVIEW_HTML_NAME = "index.html";
export const PREVIEW_JS_NAME = "app.js";
export const PREVIEW_CSS_NAME = "app.css";

const MAX_PREVIEW_BUNDLE_BYTES = 2_500_000;
const MAX_JS_BYTES = 2_000_000;
const MAX_CSS_BYTES = 300_000;

export interface BuildReport {
  status: "success" | "failed";
  errorCode: string | null;
  message: string | null;
  log: string;
  entry: string;
  files: Array<{ path: string; hash: string; size: number }>;
  deps: string[];
  outputBytes: number;
  durationMs: number;
  builtAt: number;
}

export interface PreviewBundle {
  html: string;
  bytes: number;
  builtAt: number;
}

export interface BuildAppResult {
  report: BuildReport;
  bundle: PreviewBundle | null;
}

const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function logLines(messages: string[]): string {
  return messages.join("\n").slice(0, 4000);
}

/** esbuild plugin: CSS imports are collected and processed by the postcss pipeline. */
function makeCssCollector(): { plugin: Plugin; cssFiles: string[] } {
  const cssFiles: string[] = [];
  const plugin: Plugin = {
    name: "qubits-css-collector",
    setup(buildContext) {
      buildContext.onLoad({ filter: /\.css$/ }, (args) => {
        cssFiles.push(args.path);
        return { contents: "", loader: "js" };
      });
    },
  };
  return { plugin, cssFiles };
}

export async function buildApp(workspaceDir: string): Promise<BuildAppResult> {
  return withWorkspaceLock(workspaceDir, () => buildAppLocked(workspaceDir));
}

async function buildAppLocked(workspaceDir: string): Promise<BuildAppResult> {
  const startedAt = Date.now();
  requireWorkspace(workspaceDir);
  const distDir = path.join(workspaceDir, "dist");
  const log: string[] = [];
  let manifest: ReturnType<typeof readWorkspaceManifest> | null = null;

  const fail = (code: string, message: string): BuildAppResult => {
    log.push("error_code: " + code + " | " + redactHostText(message, workspaceDir).slice(0, 300));
    let files: Array<{ path: string; hash: string; size: number }> = [];
    try {
      // The block reason may already be set (fail closed): never let the file
      // manifest re-trigger the blocked check and mask the original error.
      files = workspaceFileManifest(workspaceDir);
    } catch {
      files = [];
    }
    const report: BuildReport = {
      status: "failed",
      errorCode: code,
      message: redactHostText(message, workspaceDir).slice(0, 500),
      log: logLines(log),
      entry: MANIFEST_MAIN,
      files,
      deps: (manifest?.dependencies ?? []).map((dep) => dep.name + "@" + dep.version),
      outputBytes: 0,
      durationMs: Date.now() - startedAt,
      builtAt: Date.now(),
    };
    mkdirSync(distDir, { recursive: true });
    writeFileNofollow(path.join(distDir, BUILD_REPORT_NAME), JSON.stringify(report, null, 2));
    return { report, bundle: null };
  };

  try {
    // Fail closed before bundling: symlinks/special files anywhere (incl. dist) block the build.
    assertWorkspaceTreeSafe(workspaceDir);
    manifest = readWorkspaceManifest(workspaceDir);
  } catch (error) {
    if (error instanceof WorkspaceError) return fail(error.code, error.message);
    throw error;
  }
  if (!manifest) return fail("INVALID_MANIFEST", "manifest 缺失");

  try {
    // 1) Deterministic static scan (blocked → SECURITY_BLOCKED before anything runs).
    const scan = scanWorkspace(workspaceDir);
    if (scan.status === "blocked") {
      log.push("security_scan: blocked (" + scan.findings.length + " findings)");
      for (const finding of scan.findings.slice(0, 10)) {
        log.push("  " + finding.path + ":" + finding.line + " [" + finding.rule + "] " + finding.message);
      }
      return fail("SECURITY_BLOCKED", "静态安全扫描阻断：" + scan.findings.slice(0, 3).map((f) => f.rule).join("、"));
    }
    log.push("security_scan: pass (" + scan.filesScanned + " files)");

    // 2) Dependency check against the server allowlist.
    const deps = checkWorkspaceDependencies(workspaceDir, manifest);
    if (!deps.valid) {
      for (const problem of deps.problems.slice(0, 5)) log.push("dependency_check: " + problem);
      return fail("INVALID_DEPENDENCY", deps.problems.slice(0, 2).join("；"));
    }
    log.push("dependency_check: pass");

    // 3) esbuild bundle (system config; generated code cannot override it).
    const entry = safeResolveWorkspacePath(workspaceDir, MANIFEST_MAIN);
    const entryAbs = entry.resolved;
    if (!existsSync(entryAbs) || !lstatSync(entryAbs).isFile()) {
      return fail("BUILD_FAILED", "构建入口缺失或不是普通文件：" + MANIFEST_MAIN);
    }
    const { plugin, cssFiles } = makeCssCollector();
    let bundle: { outputFiles: Array<{ text: string }> };
    try {
      bundle = await esbuildBuild({
        entryPoints: [entryAbs],
        bundle: true,
        minify: true,
        format: "iife",
        platform: "browser",
        target: ["es2020"],
        jsx: "automatic",
        write: false,
        logLevel: "silent",
        absWorkingDir: workspaceDir,
        nodePaths: [path.join(process.cwd(), "node_modules")],
        plugins: [plugin],
        define: { "process.env.NODE_ENV": '"production"' },
        legalComments: "none",
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : "构建失败";
      log.push("esbuild: " + redactHostText(text, workspaceDir).slice(0, 1500));
      return fail("BUILD_FAILED", "esbuild 打包失败：" + redactHostText(text.split("\n")[0] ?? "", workspaceDir).slice(0, 300));
    }
    let js = bundle.outputFiles[0]?.text ?? "";
    if (Buffer.byteLength(js) > MAX_JS_BYTES) {
      return fail("BUILD_FAILED", "打包产物超过大小上限");
    }
    js = js.replace(/<\/script/gi, "<\\/script");
    log.push("esbuild: bundled (" + Buffer.byteLength(js) + " bytes)");

    // 4) CSS: postcss + tailwindcss + autoprefixer over the collected CSS files.
    let css = "";
    if (cssFiles.length > 0) {
      const cssInput = cssFiles
        .map((file) => {
          try {
            return readFileNofollow(file).toString("utf8");
          } catch {
            return "";
          }
        })
        .join("\n");
      try {
        const result = await postcss([
          tailwindcss({ content: [path.join(workspaceDir, "src", "**", "*.{ts,tsx}")] }),
          autoprefixer(),
        ]).process(cssInput, { from: "src/styles.css" });
        css = result.css;
      } catch (error) {
        const text = error instanceof Error ? error.message : "CSS 处理失败";
        log.push("postcss: " + redactHostText(text, workspaceDir).slice(0, 1200));
        return fail("BUILD_FAILED", "CSS 处理失败：" + redactHostText(text.split("\n")[0] ?? "", workspaceDir).slice(0, 300));
      }
      if (Buffer.byteLength(css) > MAX_CSS_BYTES) {
        return fail("BUILD_FAILED", "样式产物超过大小上限");
      }
      log.push("postcss: processed (" + Buffer.byteLength(css) + " bytes)");
    }

    // 5) Single self-contained preview document (strict CSP, no external resources).
    const html = [
      "<!doctype html>",
      '<html lang="zh-CN">',
      "<head>",
      '<meta charset="utf-8">',
      `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`,
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      "<title>" + escapeHtml(manifest.name.slice(0, 120)) + "</title>",
      "<style>" + css + "</style>",
      "</head>",
      "<body>",
      '<div id="qubits-root"></div>',
      "<script>" + js + "</script>",
      "</body>",
      "</html>",
    ].join("");
    const bytes = Buffer.byteLength(html);
    if (bytes > MAX_PREVIEW_BUNDLE_BYTES) {
      return fail("BUILD_FAILED", "预览产物超过大小上限");
    }

    mkdirSync(distDir, { recursive: true });
    writeFileNofollow(path.join(distDir, PREVIEW_HTML_NAME), html);
    writeFileNofollow(path.join(distDir, PREVIEW_JS_NAME), js);
    if (css) writeFileNofollow(path.join(distDir, PREVIEW_CSS_NAME), css);
    log.push("preview_bundle: " + bytes + " bytes");

    const report: BuildReport = {
      status: "success",
      errorCode: null,
      message: null,
      log: logLines(log),
      entry: MANIFEST_MAIN,
      files: workspaceFileManifest(workspaceDir),
      deps: manifest.dependencies.map((dep) => dep.name + "@" + dep.version),
      outputBytes: bytes,
      durationMs: Date.now() - startedAt,
      builtAt: Date.now(),
    };
    writeFileNofollow(path.join(distDir, BUILD_REPORT_NAME), JSON.stringify(report, null, 2));
    return { report, bundle: { html, bytes, builtAt: report.builtAt } };
  } catch (error) {
    if (error instanceof WorkspaceError) {
      return fail(error.code, error.message);
    }
    const text = error instanceof Error ? error.message : "构建失败";
    return fail("BUILD_FAILED", redactHostText(text, workspaceDir).slice(0, 400));
  }
}

/**
 * Read the last persisted build report from a workspace's dist directory.
 * Synchronous on purpose: the run-route emit callback cannot await. Every path is
 * still jail-verified (symlink walk + O_NOFOLLOW), so a symlinked report can never
 * redirect the read outside the workspace.
 */
export function readBuildReport(workspaceDir: string): BuildReport | null {
  try {
    const { resolved } = safeResolveWorkspacePath(workspaceDir, "dist/" + BUILD_REPORT_NAME);
    if (!existsSync(resolved)) return null;
    return JSON.parse(readFileNofollow(resolved).toString("utf8")) as BuildReport;
  } catch {
    return null;
  }
}

/** Read the last preview bundle from a workspace's dist directory (jail-verified, sync). */
export function readPreviewBundle(workspaceDir: string): PreviewBundle | null {
  try {
    const { resolved } = safeResolveWorkspacePath(workspaceDir, "dist/" + PREVIEW_HTML_NAME);
    if (!existsSync(resolved)) return null;
    const html = readFileNofollow(resolved).toString("utf8");
    return { html, bytes: Buffer.byteLength(html), builtAt: 0 };
  } catch {
    return null;
  }
}



export function manifestFileName(): string {
  return MANIFEST_FILE_NAME;
}

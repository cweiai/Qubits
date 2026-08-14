import "server-only";
import { existsSync } from "node:fs";
import path from "node:path";
import type { QubitsManifest } from "@/lib/contracts/manifest";
import { WorkspaceError } from "./errors";
import { listSourceFiles } from "./workspace-manager";
import { readFileNofollow } from "./paths";

/**
 * Server-controlled dependency allowlist: dependency_add can only pick packages from
 * this fixed-version map (no URLs, git deps, tarballs or install scripts ever run —
 * dependencies are resolved from the host's own installed packages at build time).
 */

export interface AllowedDependency {
  name: string;
  version: string;
}

export const DEPENDENCY_ALLOWLIST: Record<string, AllowedDependency> = {
  "lucide-react": { name: "lucide-react", version: "0.469.0" },
  clsx: { name: "clsx", version: "2.1.1" },
  "tailwind-merge": { name: "tailwind-merge", version: "2.6.0" },
  "class-variance-authority": { name: "class-variance-authority", version: "0.7.1" },
};

/** Always resolvable (host-provided core framework + test runner). */
export const SYSTEM_PROVIDED = new Set([
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "vitest",
  "vitest/config",
]);

const IMPORT_SPECIFIER = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/g;

export function isAllowedDependency(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(DEPENDENCY_ALLOWLIST, name) || SYSTEM_PROVIDED.has(name);
}

export function getDependencyVersion(name: string): string | null {
  return DEPENDENCY_ALLOWLIST[name]?.version ?? null;
}

/** Collect bare import specifiers from all code files in the workspace. */
export function collectImportSpecifiers(workspaceDir: string): string[] {
  const specifiers = new Set<string>();
  for (const file of listSourceFiles(workspaceDir)) {
    if (!/\.(ts|tsx|js|jsx)$/.test(file.path)) continue;
    const content = (() => {
      try {
        return readFileNofollow(file.abs).toString("utf8");
      } catch {
        return "";
      }
    })();
    for (const match of content.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1];
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue; // relative imports
      specifiers.add(specifier);
    }
  }
  return [...specifiers].sort();
}

export interface DependencyCheckResult {
  valid: boolean;
  problems: string[];
}

/** Every bare import must be system-provided or declared in the manifest allowlist. */
export function checkWorkspaceDependencies(workspaceDir: string, manifest: QubitsManifest): DependencyCheckResult {
  const declared = new Set(manifest.dependencies.map((dep) => dep.name));
  const problems: string[] = [];
  for (const specifier of collectImportSpecifiers(workspaceDir)) {
    if (SYSTEM_PROVIDED.has(specifier)) continue;
    if (declared.has(specifier) && isAllowedDependency(specifier)) continue;
    problems.push(
      "未授权依赖：" + specifier + "（只能使用系统内置库或通过 dependency_add 添加的 allowlist 依赖）"
    );
  }
  return { valid: problems.length === 0, problems };
}

/** The allowlisted package must physically exist in the host's node_modules (no install scripts, no network). */
export function assertDependencyAvailable(name: string): void {
  if (SYSTEM_PROVIDED.has(name)) return;
  if (!isAllowedDependency(name)) {
    throw new WorkspaceError("INVALID_DEPENDENCY", "依赖不在服务端 allowlist 中：" + name, false);
  }
  const pkgPath = path.join(process.cwd(), "node_modules", name);
  if (!existsSync(pkgPath)) {
    throw new WorkspaceError("DEPENDENCY_UNAVAILABLE", "依赖在构建环境不可用：" + name, false);
  }
}

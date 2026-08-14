import { z } from "zod";

/**
 * Remaining responsibilities of browser local storage:
 * 1) one-time migration read of legacy (qubits.project.v2) workspace data;
 * 2) non-sensitive UI preferences (sidebar/preview collapse, preview device) — isolated by global namespace.
 * Conversations, messages, AppSpec, and business data all live in the server database, never localStorage.
 */

const LEGACY_STORAGE_KEY = "qubits.project.v2";
const PREFS_STORAGE_KEY = "qubits.prefs.v1";

export interface WorkspacePreferences {
  leftSidebar: "expanded" | "collapsed";
  rightPreview: "expanded" | "collapsed";
  previewDevice: "desktop" | "mobile";
}

const DEFAULT_PREFERENCES: WorkspacePreferences = {
  leftSidebar: "expanded",
  rightPreview: "expanded",
  previewDevice: "desktop",
};

const preferencesSchema = z.object({
  leftSidebar: z.enum(["expanded", "collapsed"]),
  rightPreview: z.enum(["expanded", "collapsed"]),
  previewDevice: z.enum(["desktop", "mobile"]),
});

export function loadPreferences(): WorkspacePreferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = preferencesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_PREFERENCES;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(prefs: WorkspacePreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Preference write failure must not break the workspace.
  }
}

interface LegacyProjectState {
  conversation: unknown[];
  appSpec: unknown;
  productBrief: unknown;
  appBlueprint: unknown;
}

export function loadLegacyProjectState(): LegacyProjectState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      conversation: Array.isArray(parsed.conversation) ? parsed.conversation : [],
      appSpec: parsed.appSpec ?? null,
      productBrief: parsed.productBrief ?? null,
      appBlueprint: parsed.appBlueprint ?? null,
    };
  } catch {
    return null;
  }
}

export function clearLegacyProjectState(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // ignore
  }
}

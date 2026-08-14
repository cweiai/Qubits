import "server-only";
import { randomUUID } from "node:crypto";
import { MAX_ARTIFACT_BYTES, type ArtifactKind, type ArtifactRef } from "./tools/types";
import type { RoleId } from "@/lib/contracts/agent-events";

/**
 * Per-run in-memory ArtifactStore: random ids, run-scoped isolation, and a size cap;
 * never shared across runs/projects, and never trusts client-supplied ids.
 * Retry support: seed restores previously persisted entries and persist is called
 * after every put, so completed artifacts survive task retries.
 */
export interface StoredArtifactEntry {
  ref: ArtifactRef;
  value: unknown;
}

export class ArtifactStore {
  private readonly entries = new Map<string, { ref: ArtifactRef; value: unknown }>();
  private readonly id: string;
  private readonly persist: ((entries: StoredArtifactEntry[]) => void) | null;

  constructor(runId: string, seed?: StoredArtifactEntry[], persist?: (entries: StoredArtifactEntry[]) => void) {
    this.id = runId;
    this.persist = persist ?? null;
    if (seed) {
      for (const entry of seed) {
        if (entry && entry.ref && typeof entry.ref.id === "string") {
          this.entries.set(entry.ref.id, { ref: entry.ref, value: entry.value });
        }
      }
    }
  }

  /** Export all entries (persisted across attempts). */
  exportEntries(): StoredArtifactEntry[] {
    return [...this.entries.values()].map((e) => ({ ref: e.ref, value: e.value }));
  }

  put(input: {
    kind: ArtifactKind;
    createdBy: RoleId;
    parentAgentRunId: string | null;
    value: unknown;
    schemaVersion?: number;
  }): ArtifactRef {
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(input.value));
    } catch {
      size = 0;
    }
    if (size > MAX_ARTIFACT_BYTES) {
      throw new ArtifactStoreError("ARTIFACT_TOO_LARGE", "产物超过大小上限");
    }
    const id = "art-" + randomUUID();
    const ref: ArtifactRef = {
      id,
      kind: input.kind,
      createdBy: input.createdBy,
      parentAgentRunId: input.parentAgentRunId,
      schemaVersion: input.schemaVersion ?? 1,
      size,
    };
    this.entries.set(id, { ref, value: input.value });
    try {
      this.persist?.(this.exportEntries());
    } catch {
      // Persistence failure must not fail the run
    }
    return ref;
  }

  get(id: string): unknown | null {
    const entry = this.entries.get(id);
    return entry ? entry.value : null;
  }

  getRef(id: string): ArtifactRef | null {
    const entry = this.entries.get(id);
    return entry ? entry.ref : null;
  }

  findLatest(kind: ArtifactKind): ArtifactRef | null {
    let latest: ArtifactRef | null = null;
    for (const entry of this.entries.values()) {
      if (entry.ref.kind !== kind) continue;
      if (!latest || entry.ref.id > latest.id) latest = entry.ref;
    }
    return latest;
  }

  list(kind: ArtifactKind): ArtifactRef[] {
    return [...this.entries.values()].filter((e) => e.ref.kind === kind).map((e) => e.ref);
  }

  get runId(): string {
    return this.id;
  }
}

export class ArtifactStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ArtifactStoreError";
    this.code = code;
  }
}

import { describe, expect, it } from "vitest";
import { ArtifactStore, type StoredArtifactEntry } from "@/lib/ai/artifact-store";

/**
 * ArtifactStore persistence across attempts: put triggers persist; a resume restores
 * the same artifact ids from the seed.
 */

describe("ArtifactStore 持久化与恢复", () => {
  it("put 后触发 persist，导出的条目可完整恢复原 id", () => {
    const persisted: StoredArtifactEntry[][] = [];
    const store = new ArtifactStore("run-a", undefined, (entries) => persisted.push(entries));
    const ref = store.put({
      kind: "code_workspace",
      createdBy: "engineer",
      parentAgentRunId: "agent-mike-000000000001",
      value: { appType: "web", name: "任务管理器" },
    });
    expect(persisted).toHaveLength(1);
    const entry = persisted[0][0];
    expect(entry.ref.id).toBe(ref.id);
    expect(entry.ref.kind).toBe("code_workspace");

    // Resume: seed a new store from the persisted entries; the original id stays readable.
    const resumed = new ArtifactStore("run-b", persisted[0]);
    expect(resumed.get(ref.id)).toEqual({ appType: "web", name: "任务管理器" });
    expect(resumed.getRef(ref.id)?.createdBy).toBe("engineer");
    expect(resumed.findLatest("code_workspace")?.id).toBe(ref.id);
  });

  it("无 seed 的新 store 不受其他 run 影响", () => {
    const store = new ArtifactStore("run-c");
    expect(store.findLatest("code_workspace")).toBeNull();
    expect(store.get("art-missing")).toBeNull();
  });

  it("seed 中的脏条目被忽略，不抛异常", () => {
    const store = new ArtifactStore("run-d", [
      null as unknown as StoredArtifactEntry,
      { ref: null as unknown as StoredArtifactEntry["ref"], value: 1 },
      { ref: { id: "art-ok", kind: "code_workspace", createdBy: "engineer", parentAgentRunId: null, schemaVersion: 1, size: 10 }, value: { x: 1 } },
    ]);
    expect(store.get("art-ok")).toEqual({ x: 1 });
    expect(store.exportEntries()).toHaveLength(1);
  });
});

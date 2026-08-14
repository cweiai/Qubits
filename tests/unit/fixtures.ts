import type { AppSpec } from "@/lib/contracts/app-spec";
import type { QubitsManifest } from "@/lib/contracts/manifest";

/** A valid AppSpec fixture shared by unit/API tests (explicit collections version). */
export function makeTaskSpec(overrides: Partial<AppSpec> = {}): AppSpec {
  const spec: AppSpec = {
    schemaVersion: 1,
    id: "test-task-app",
    version: 1,
    name: "测试任务管理器",
    description: "测试用任务管理器",
    theme: { primary: "#0f766e", background: "#f8fafc", foreground: "#0f172a", radius: "md" },
    entity: {
      id: "task",
      name: "任务",
      primaryField: "title",
      fields: [
        { id: "title", label: "任务标题", type: "text", required: true, placeholder: "标题", maxLength: 60, defaultValue: "" },
        { id: "priority", label: "优先级", type: "select", required: true, placeholder: "", options: ["高", "中", "低"], defaultValue: "中" },
        { id: "completed", label: "已完成", type: "boolean", required: false, placeholder: "", defaultValue: false },
      ],
      initialRecords: [
        { id: "rec-1", title: "写周报", priority: "高", completed: false },
        { id: "rec-2", title: "整理桌面", priority: "低", completed: true },
      ],
    },
    collections: [
      {
        name: "task",
        label: "任务",
        fields: [
          { name: "title", label: "任务标题", type: "text", required: true, maxLength: 60 },
          { name: "priority", label: "优先级", type: "select", required: true, options: ["高", "中", "低"] },
          { name: "completed", label: "已完成", type: "boolean", required: false },
        ],
        allowedOperations: ["list", "count", "create", "update", "delete"],
      },
    ],
    sections: [
      { type: "header", title: "测试任务", description: "测试用" },
      {
        type: "stats",
        stats: [
          { id: "total", label: "全部", aggregate: "count" },
          { id: "done", label: "已完成", aggregate: "countWhere", where: { fieldId: "completed", equals: true } },
        ],
      },
      { type: "record-form", title: "新增任务", submitLabel: "添加" },
      {
        type: "record-list",
        title: "任务列表",
        showSearch: true,
        showFilters: true,
        filters: [{ fieldId: "completed", label: "状态" }],
        actions: ["toggle-boolean", "update-record", "delete-record"],
      },
      { type: "empty-state", title: "还没有任务", description: "添加第一条任务" },
    ],
  };
  return { ...spec, ...overrides };
}

/** Legacy AppSpec without collections (used by the derivation path). */
export function makeLegacySpec(): AppSpec {
  const spec = makeTaskSpec();
  const { collections, ...rest } = spec;
  void collections;
  return rest;
}

/** A valid qubits.manifest.json fixture for the code-workspace model. */
export function makeTaskManifest(overrides: Partial<QubitsManifest> = {}): QubitsManifest {
  const manifest: QubitsManifest = {
    schemaVersion: 1,
    name: "测试任务管理器",
    description: "测试用任务管理器",
    main: "src/main.tsx",
    collections: [
      {
        name: "task",
        label: "任务",
        fields: [
          { name: "title", label: "任务标题", type: "text", required: true, maxLength: 60 },
          { name: "priority", label: "优先级", type: "select", required: true, options: ["高", "中", "低"] },
          { name: "completed", label: "已完成", type: "boolean", required: false },
        ],
        allowedOperations: ["list", "count", "create", "update", "delete"],
      },
    ],
    dependencies: [],
  };
  return { ...manifest, ...overrides };
}

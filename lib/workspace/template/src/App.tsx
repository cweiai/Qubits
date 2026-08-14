import { useCallback, useEffect, useMemo, useState } from "react";
import { TaskStats } from "./components/TaskStats";
import { filterTodos, toTodo, type Todo, type TodoFilter } from "./lib/app-data";

/**
 * Trusted template app: a persisted todo list built exclusively on the Qubits SDK.
 * Every read/write goes through window.Qubits.data (MessageChannel → server validation).
 * The generated app can freely replace this file — it is the code, not a schema.
 */

const COLLECTION = "tasks";

interface QubitsErrorLike {
  code?: string;
  message?: string;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const record = error as QubitsErrorLike;
    if (typeof record.message === "string" && record.message.length > 0) return record.message;
  }
  return "数据服务暂时不可用，请稍后重试";
}

export function App() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [filter, setFilter] = useState<TodoFilter>("all");
  const [search, setSearch] = useState("");
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<"高" | "中" | "低">("中");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      const records = (await window.Qubits.data.list(COLLECTION, { sort: { field: "title", dir: "asc" } })) as unknown[];
      const next = records
        .filter((record): record is Record<string, unknown> => typeof record === "object" && record !== null)
        .map(toTodo);
      setTodos(next);
      setNotice(null);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visible = useMemo(() => filterTodos(todos, filter, search), [todos, filter, search]);

  const addTodo = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await window.Qubits.data.create(COLLECTION, { title: trimmed, priority, completed: false });
      setTitle("");
      await reload();
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }, [title, priority, saving, reload]);

  const toggleTodo = useCallback(
    async (todo: Todo) => {
      try {
        await window.Qubits.data.update(COLLECTION, todo.id, { completed: !todo.completed });
        await reload();
      } catch (error) {
        setNotice(errorMessage(error));
      }
    },
    [reload]
  );

  const deleteTodo = useCallback(
    async (todo: Todo) => {
      try {
        await window.Qubits.data.delete(COLLECTION, todo.id);
        await reload();
      } catch (error) {
        setNotice(errorMessage(error));
      }
    },
    [reload]
  );

  const context = window.Qubits.app.getContext();

  return (
    <div className="app-shell" data-testid="template-app">
      <header className="app-header">
        <div>
          <h1 className="app-title" data-testid="app-title">
            {context.name || "任务清单"}
          </h1>
          <p className="app-subtitle">数据保存在后端数据库 · 刷新后依然存在</p>
        </div>
      </header>

      <main className="app-main">
        <section className="panel">
          <h2 className="panel-title">新增任务</h2>
          <div className="form-row">
            <input
              className="input"
              data-testid="todo-input"
              placeholder="任务标题"
              value={title}
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void addTodo();
              }}
            />
            <select
              className="select"
              data-testid="todo-priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value as "高" | "中" | "低")}
            >
              <option value="高">高</option>
              <option value="中">中</option>
              <option value="低">低</option>
            </select>
            <button
              className="button button-primary"
              data-testid="todo-add"
              disabled={saving || title.trim().length === 0}
              onClick={() => void addTodo()}
            >
              {saving ? "保存中…" : "添加"}
            </button>
          </div>
        </section>

        <TaskStats todos={todos} />

        <section className="panel">
          <div className="list-toolbar">
            <h2 className="panel-title">任务列表</h2>
            <div className="toolbar-right">
              <div className="filter-group" data-testid="todo-filters">
                {(["all", "active", "completed"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    data-testid={"filter-" + value}
                    className={"filter-button" + (filter === value ? " filter-button-active" : "")}
                    onClick={() => setFilter(value)}
                  >
                    {value === "all" ? "全部" : value === "active" ? "进行中" : "已完成"}
                  </button>
                ))}
              </div>
              <input
                className="input input-search"
                data-testid="todo-search"
                placeholder="搜索任务"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>

          {notice ? (
            <p className="notice" data-testid="todo-notice">
              {notice}
            </p>
          ) : null}

          {loading ? (
            <p className="hint">正在加载任务…</p>
          ) : visible.length === 0 ? (
            <div className="empty-state" data-testid="todo-empty">
              {todos.length === 0 ? "还没有任务，先添加一个吧。" : "没有匹配的任务。"}
            </div>
          ) : (
            <ul className="todo-list" data-testid="todo-list">
              {visible.map((todo) => (
                <li key={todo.id} className={"todo-item" + (todo.completed ? " todo-completed" : "")} data-testid="todo-item">
                  <label className="todo-check">
                    <input type="checkbox" checked={todo.completed} onChange={() => void toggleTodo(todo)} data-testid="todo-toggle" />
                    <span className="todo-title" data-testid="todo-title">
                      {todo.title}
                    </span>
                  </label>
                  <span className={"badge badge-" + (todo.priority === "高" ? "high" : todo.priority === "低" ? "low" : "mid")}>
                    {todo.priority}
                  </span>
                  <button className="icon-button" data-testid="todo-delete" onClick={() => void deleteTodo(todo)} aria-label="删除任务">
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

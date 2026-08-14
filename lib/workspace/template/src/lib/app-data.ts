/**
 * Pure data helpers for the template app (shared by the UI and the unit test).
 * Keeping this logic free of React makes it testable by the system's vitest run.
 */

export interface Todo {
  id: string;
  title: string;
  priority: "高" | "中" | "低";
  completed: boolean;
}

export type TodoFilter = "all" | "active" | "completed";

export function filterTodos(todos: Todo[], filter: TodoFilter, search: string): Todo[] {
  const needle = search.trim().toLowerCase();
  return todos.filter((todo) => {
    if (filter === "active" && todo.completed) return false;
    if (filter === "completed" && !todo.completed) return false;
    if (needle && !todo.title.toLowerCase().includes(needle)) return false;
    return true;
  });
}

export function countByState(todos: Todo[]): { total: number; active: number; completed: number } {
  return {
    total: todos.length,
    active: todos.filter((t) => !t.completed).length,
    completed: todos.filter((t) => t.completed).length,
  };
}

/** Normalize a record coming from the Qubits data API into a Todo. */
export function toTodo(record: Record<string, unknown>): Todo {
  const priority = record.priority === "高" || record.priority === "中" || record.priority === "低" ? record.priority : "中";
  return {
    id: typeof record.id === "string" ? record.id : "",
    title: typeof record.title === "string" ? record.title : "",
    priority,
    completed: record.completed === true,
  };
}

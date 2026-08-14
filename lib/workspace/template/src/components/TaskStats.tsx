import { countByState, type Todo } from "../lib/app-data";

/** Compact stat cards rendered from the todo list. */
export function TaskStats({ todos }: { todos: Todo[] }) {
  const stats = countByState(todos);
  return (
    <div className="stats-row" data-testid="task-stats">
      <div className="stat-card">
        <span className="stat-value" data-testid="stat-total">
          {stats.total}
        </span>
        <span className="stat-label">全部任务</span>
      </div>
      <div className="stat-card">
        <span className="stat-value stat-active" data-testid="stat-active">
          {stats.active}
        </span>
        <span className="stat-label">进行中</span>
      </div>
      <div className="stat-card">
        <span className="stat-value stat-done" data-testid="stat-completed">
          {stats.completed}
        </span>
        <span className="stat-label">已完成</span>
      </div>
    </div>
  );
}

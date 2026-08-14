import { describe, expect, it } from "vitest";
import { countByState, filterTodos, toTodo, type Todo } from "./app-data";

const todos: Todo[] = [
  { id: "1", title: "写周报", priority: "高", completed: false },
  { id: "2", title: "买牛奶", priority: "中", completed: true },
  { id: "3", title: "读书", priority: "低", completed: false },
];

describe("app-data", () => {
  it("filters by state", () => {
    expect(filterTodos(todos, "active", "").map((t) => t.id)).toEqual(["1", "3"]);
    expect(filterTodos(todos, "completed", "").map((t) => t.id)).toEqual(["2"]);
    expect(filterTodos(todos, "all", "").length).toBe(3);
  });

  it("searches by title substring", () => {
    expect(filterTodos(todos, "all", "牛奶").map((t) => t.id)).toEqual(["2"]);
  });

  it("counts states", () => {
    expect(countByState(todos)).toEqual({ total: 3, active: 2, completed: 1 });
  });

  it("normalizes records from the data API", () => {
    expect(toTodo({ id: "9", title: "任务", priority: "高", completed: false })).toEqual({
      id: "9",
      title: "任务",
      priority: "高",
      completed: false,
    });
    expect(toTodo({ id: "9", title: "任务", priority: "unknown", completed: false }).priority).toBe("中");
  });
});

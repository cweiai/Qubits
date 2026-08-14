import { afterEach, describe, expect, it } from "vitest";
import {
  composeAbortSignals,
  isRunActive,
  registerRun,
  resetRunRegistryForTests,
  terminateRun,
  unregisterRun,
} from "@/lib/ai/run-registry";

/**
 * Run registry: conversation deletion terminates the corresponding running
 * generation task first and waits for its loop to settle before deleting rows.
 */

afterEach(() => {
  resetRunRegistryForTests();
});

describe("run-registry", () => {
  it("registerRun → terminateRun abort 运行循环并等待 done 收尾", async () => {
    const handle = registerRun("task-run-00000001");
    expect(isRunActive("task-run-00000001")).toBe(true);
    let settled = false;
    void handle.done.then(() => {
      settled = true;
    });

    const termination = terminateRun("task-run-00000001");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(handle.controller.signal.aborted).toBe(true);
    expect(settled).toBe(false); // not settled until done resolves

    handle.markDone();
    expect(await termination).toBe(true);
    expect(settled).toBe(true);
  });

  it("未注册的任务返回 false（不是运行中的任务，无需终止）", async () => {
    expect(await terminateRun("task-missing-000001")).toBe(false);
    expect(isRunActive("task-missing-000001")).toBe(false);
  });

  it("composeAbortSignals：任一来源 abort 都会传导", () => {
    const a = new AbortController();
    const b = new AbortController();
    const composed = composeAbortSignals(a.signal, b.signal);
    expect(composed.aborted).toBe(false);
    b.abort();
    expect(composed.aborted).toBe(true);
  });

  it("composeAbortSignals：来源已 abort 时立即 abort；忽略空信号", () => {
    const aborted = new AbortController();
    aborted.abort();
    const composed = composeAbortSignals(null, undefined, aborted.signal, new AbortController().signal);
    expect(composed.aborted).toBe(true);
  });

  it("unregisterRun 后不再视为运行中", () => {
    const handle = registerRun("task-run-00000002");
    handle.markDone();
    unregisterRun("task-run-00000002");
    expect(isRunActive("task-run-00000002")).toBe(false);
  });
});

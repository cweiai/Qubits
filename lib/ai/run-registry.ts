import "server-only";

/**
 * In-process registry of running generation tasks. The run route registers its
 * AbortController at start and resolves `done` when the orchestrator loop has fully
 * wound down (all repo writes finished). Conversation deletion terminates the
 * corresponding running task first and waits for it to settle, so a deleted
 * conversation can never receive late writes (messages, snapshots, artifacts).
 */

export interface RunHandle {
  controller: AbortController;
  /** Resolves when the run loop has fully finished (route `finally`). */
  done: Promise<void>;
  markDone(): void;
}

const runs = new Map<string, RunHandle>();

export function registerRun(taskId: string): RunHandle {
  const controller = new AbortController();
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const handle: RunHandle = { controller, done, markDone: () => resolveDone() };
  runs.set(taskId, handle);
  return handle;
}

export function unregisterRun(taskId: string): void {
  runs.delete(taskId);
}

export function isRunActive(taskId: string): boolean {
  return runs.has(taskId);
}

/** Compose several abort signals into one (any abort wins). */
export function composeAbortSignals(...signals: Array<AbortSignal | null | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort();
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

/**
 * Terminate a running generation task and wait (bounded) for its loop to settle.
 * Returns false when the task is not registered as running.
 */
export async function terminateRun(taskId: string, timeoutMs = 10_000): Promise<boolean> {
  const handle = runs.get(taskId);
  if (!handle) return false;
  handle.controller.abort();
  await Promise.race([
    handle.done,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  return true;
}

/** Test helper: clear the registry. */
export function resetRunRegistryForTests(): void {
  runs.clear();
}

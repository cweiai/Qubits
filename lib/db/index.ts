import path from "node:path";
import { AppRepository } from "./repository";

/**
 * Repository singleton: opens the database from the DATABASE_URL env var (lazy init).
 * Defaults to file:./data/qubits.db (relative to the project root); can be swapped for a PostgreSQL URL later.
 */

let repository: AppRepository | null = null;

function resolveDbPath(url: string | undefined): string {
  const raw = url && url.trim() !== "" ? url : "file:./data/qubits.db";
  if (raw.startsWith("file:")) {
    return path.resolve(process.cwd(), raw.slice("file:".length));
  }
  return raw;
}

export function getRepository(): AppRepository {
  if (!repository) {
    repository = new AppRepository(resolveDbPath(process.env.DATABASE_URL));
  }
  return repository;
}

/** Test-only: closes the current connection so the next getRepository re-initializes. */
export function resetRepositoryForTests(): void {
  if (repository) {
    repository.close();
    repository = null;
  }
}

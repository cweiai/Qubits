import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Manually applies database migrations (npm run db:migrate).
 * The schema is idempotent and is also applied automatically on startup; this script exists for CI and a documented workflow.
 */

const root = path.resolve(import.meta.dirname, "..");
const url = process.env.DATABASE_URL || "file:./data/qubits.db";
const dbPath = url.startsWith("file:") ? path.resolve(root, url.slice("file:".length)) : url;
mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec(readFileSync(path.join(root, "lib", "db", "schema.sql"), "utf8"));
db.close();
console.log("数据库迁移完成:", dbPath);

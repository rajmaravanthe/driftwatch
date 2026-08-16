import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../data");
const DB_PATH =
  process.env.DRIFTWATCH_DB ?? path.join(DATA_DIR, "driftwatch.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

/**
 * Tiny versioned migration runner. `user_version` tracks the schema version.
 * Only migrations with a version newer than the current one are applied,
 * each inside its own transaction.
 */
const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE manifests (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        environment TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        resources   TEXT NOT NULL  -- JSON array of ResourceSpec
      );

      CREATE TABLE runs (
        id           TEXT PRIMARY KEY,
        manifest_id  TEXT NOT NULL REFERENCES manifests(id) ON DELETE CASCADE,
        status       TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        started_at   TEXT,
        finished_at  TEXT,
        steps        TEXT NOT NULL,  -- JSON array of RunStep
        error        TEXT,           -- JSON RunError or null
        fallback_used INTEGER NOT NULL DEFAULT 0,
        summary      TEXT,           -- JSON RunSummary or null
        drift        TEXT            -- JSON DriftReport or null
      );

      CREATE INDEX idx_runs_manifest ON runs(manifest_id, created_at DESC);

      CREATE TABLE run_logs (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id  TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        ts      TEXT NOT NULL,
        level   TEXT NOT NULL,
        step    TEXT NOT NULL,
        message TEXT NOT NULL
      );

      CREATE INDEX idx_run_logs_run ON run_logs(run_id, id);
    `,
  },
];

function migrate(): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    });
    apply();
    // eslint-disable-next-line no-console
    console.log(`[db] applied migration v${migration.version}`);
  }
}

migrate();

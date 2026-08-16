import { db } from "./db.js";
import type {
  DriftReport,
  Manifest,
  ManifestListItem,
  ResourceSpec,
  Run,
  RunError,
  RunLogEntry,
  RunStatus,
  RunStep,
  RunSummary,
} from "../shared/types.js";

// ---------- Row shapes ----------

interface ManifestRow {
  id: string;
  name: string;
  environment: string;
  created_at: string;
  resources: string;
}

interface RunRow {
  id: string;
  manifest_id: string;
  status: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  steps: string;
  error: string | null;
  fallback_used: number;
  summary: string | null;
  drift: string | null;
}

interface LogRow {
  id: number;
  run_id: string;
  ts: string;
  level: string;
  step: string;
  message: string;
}

// ---------- Mappers ----------

function rowToManifest(row: ManifestRow): Manifest {
  return {
    id: row.id,
    name: row.name,
    environment: row.environment,
    createdAt: row.created_at,
    resources: JSON.parse(row.resources) as ResourceSpec[],
  };
}

function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    manifestId: row.manifest_id,
    status: row.status as RunStatus,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    steps: JSON.parse(row.steps) as RunStep[],
    error: row.error ? (JSON.parse(row.error) as RunError) : null,
    fallbackUsed: row.fallback_used === 1,
    summary: row.summary ? (JSON.parse(row.summary) as RunSummary) : null,
    drift: row.drift ? (JSON.parse(row.drift) as DriftReport) : null,
  };
}

function rowToLog(row: LogRow): RunLogEntry {
  return {
    id: row.id,
    runId: row.run_id,
    ts: row.ts,
    level: row.level as RunLogEntry["level"],
    step: row.step as RunLogEntry["step"],
    message: row.message,
  };
}

// ---------- Manifests ----------

export interface CreateManifestInput {
  id: string;
  name: string;
  environment: string;
  resources: ResourceSpec[];
}

export const manifestRepository = {
  create(input: CreateManifestInput): Manifest {
    const manifest = {
      id: input.id,
      name: input.name,
      environment: input.environment,
      createdAt: new Date().toISOString(),
      resources: input.resources,
    };
    db.prepare(
      `INSERT INTO manifests (id, name, environment, created_at, resources)
       VALUES (@id, @name, @environment, @created_at, @resources)`,
    ).run({
      id: manifest.id,
      name: manifest.name,
      environment: manifest.environment,
      created_at: manifest.createdAt,
      resources: JSON.stringify(manifest.resources),
    });
    return manifest;
  },

  findById(id: string): Manifest | null {
    const row = db.prepare(`SELECT * FROM manifests WHERE id = ?`).get(id) as
      | ManifestRow
      | undefined;
    return row ? rowToManifest(row) : null;
  },

  list(): ManifestListItem[] {
    const rows = db
      .prepare(
        `SELECT
           m.*,
           COUNT(r.id) AS run_count,
           (SELECT r2.status FROM runs r2
             WHERE r2.manifest_id = m.id
             ORDER BY r2.created_at DESC LIMIT 1) AS last_status,
           (SELECT r3.created_at FROM runs r3
             WHERE r3.manifest_id = m.id
             ORDER BY r3.created_at DESC LIMIT 1) AS last_run_at
         FROM manifests m
         LEFT JOIN runs r ON r.manifest_id = m.id
         GROUP BY m.id
         ORDER BY m.created_at DESC`,
      )
      .all() as Array<
      ManifestRow & {
        run_count: number;
        last_status: string | null;
        last_run_at: string | null;
      }
    >;

    return rows.map((row) => ({
      ...rowToManifest(row),
      runCount: row.run_count,
      lastRunStatus: (row.last_status as RunStatus | null) ?? null,
      lastRunAt: row.last_run_at,
    }));
  },

  delete(id: string): void {
    db.prepare(`DELETE FROM manifests WHERE id = ?`).run(id);
  },
};

// ---------- Runs ----------

export interface CreateRunInput {
  id: string;
  manifestId: string;
  steps: RunStep[];
}

export const runRepository = {
  create(input: CreateRunInput): Run {
    const now = new Date().toISOString();
    const run: Run = {
      id: input.id,
      manifestId: input.manifestId,
      status: "pending",
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      steps: input.steps,
      error: null,
      fallbackUsed: false,
      summary: null,
      drift: null,
    };
    db.prepare(
      `INSERT INTO runs (id, manifest_id, status, created_at, steps)
       VALUES (@id, @manifest_id, @status, @created_at, @steps)`,
    ).run({
      id: run.id,
      manifest_id: run.manifestId,
      status: run.status,
      created_at: run.createdAt,
      steps: JSON.stringify(run.steps),
    });
    return run;
  },

  findById(id: string): Run | null {
    const row = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as
      | RunRow
      | undefined;
    return row ? rowToRun(row) : null;
  },

  listByManifest(manifestId: string): Run[] {
    const rows = db
      .prepare(
        `SELECT * FROM runs WHERE manifest_id = ? ORDER BY created_at DESC`,
      )
      .all(manifestId) as RunRow[];
    return rows.map(rowToRun);
  },

  update(run: Run): void {
    db.prepare(
      `UPDATE runs SET
         status = @status,
         started_at = @started_at,
         finished_at = @finished_at,
         steps = @steps,
         error = @error,
         fallback_used = @fallback_used,
         summary = @summary,
         drift = @drift
       WHERE id = @id`,
    ).run({
      id: run.id,
      status: run.status,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
      steps: JSON.stringify(run.steps),
      error: run.error ? JSON.stringify(run.error) : null,
      fallback_used: run.fallbackUsed ? 1 : 0,
      summary: run.summary ? JSON.stringify(run.summary) : null,
      drift: run.drift ? JSON.stringify(run.drift) : null,
    });
  },
};

// ---------- Logs ----------

export const logRepository = {
  append(input: Omit<RunLogEntry, "id" | "ts">): RunLogEntry {
    const ts = new Date().toISOString();
    const result = db
      .prepare(
        `INSERT INTO run_logs (run_id, ts, level, step, message)
         VALUES (@run_id, @ts, @level, @step, @message)`,
      )
      .run({
        run_id: input.runId,
        ts,
        level: input.level,
        step: input.step,
        message: input.message,
      });
    return {
      id: Number(result.lastInsertRowid),
      runId: input.runId,
      ts,
      level: input.level,
      step: input.step,
      message: input.message,
    };
  },

  listForRun(runId: string): RunLogEntry[] {
    const rows = db
      .prepare(`SELECT * FROM run_logs WHERE run_id = ? ORDER BY id ASC`)
      .all(runId) as LogRow[];
    return rows.map(rowToLog);
  },
};

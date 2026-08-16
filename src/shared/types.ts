/**
 * Shared domain types for DriftWatch.
 * These are used by both the server (Express + workflow engine)
 * and the web client (React), so they must stay framework-agnostic.
 */

// ---------- Manifests (declared expected state) ----------

export type ResourceKind = "server" | "database" | "loadBalancer";

export const RESOURCE_KINDS = [
  "server",
  "database",
  "loadBalancer",
] as const satisfies readonly ResourceKind[];

/**
 * What the platform should do when drift is detected on this resource.
 * - "notify":   report only — an operator must decide.
 * - "reconcile": automatically apply expected state (auto-heal).
 */
export type DriftStrategy = "notify" | "reconcile";

export interface ResourceSpec {
  name: string;
  kind: ResourceKind;
  strategy: DriftStrategy;
  config: Record<string, unknown>;
}

export interface Manifest {
  id: string;
  name: string;
  environment: string;
  createdAt: string;
  resources: ResourceSpec[];
}

export interface ManifestListItem extends Manifest {
  runCount: number;
  lastRunStatus: RunStatus | null;
  lastRunAt: string | null;
}

// ---------- Runs (workflow executions) ----------

export type RunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type StepName =
  | "validate"
  | "inventory"
  | "fetch-live-state"
  | "reconcile"
  | "compare"
  | "report";

export type StepStatus = "pending" | "running" | "succeeded" | "failed";

export interface RunStep {
  name: StepName;
  status: StepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  detail: string | null;
  attempt: number;
}

export interface RunError {
  message: string;
  step: StepName | "system";
}

export interface Run {
  id: string;
  manifestId: string;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  steps: RunStep[];
  error: RunError | null;
  /** True when the mock provider had to stand in for an unavailable target. */
  fallbackUsed: boolean;
  summary: RunSummary | null;
  drift: DriftReport | null;
}

// ---------- Drift & reporting ----------

export type DriftKind = "field-changed" | "missing" | "unexpected";

export type DriftSeverity = "low" | "medium" | "high" | "critical";

export interface FieldDrift {
  /** e.g. "config.cpu" */
  path: string;
  /** Human readable label, e.g. "CPU cores" */
  label: string;
  expected: unknown;
  actual: unknown;
  severity: DriftSeverity;
}

export interface ResourceDrift {
  resourceName: string;
  kind: ResourceKind;
  strategy: DriftStrategy;
  driftKind: DriftKind;
  status: "clean" | "drifted";
  fields: FieldDrift[];
}

export interface RunSummary {
  resourceCount: number;
  cleanCount: number;
  driftedCount: number;
  criticalCount: number;
  discoveredAt: string;
  durationMs: number;
}

export interface DriftReport {
  environment: string;
  generatedAt: string;
  resources: ResourceDrift[];
  summary: RunSummary;
}

// ---------- Logs ----------

export type LogLevel = "info" | "warn" | "error";

export interface RunLogEntry {
  id: number;
  runId: string;
  ts: string;
  level: LogLevel;
  step: StepName | "system";
  message: string;
}

// ---------- SSE event payloads (server -> UI) ----------

export type ServerSentEvent =
  | { type: "step"; runId: string; step: RunStep }
  | { type: "log"; runId: string; entry: RunLogEntry }
  | { type: "status"; runId: string; status: RunStatus }
  | { type: "report"; runId: string; drift: DriftReport; fallbackUsed: boolean }
  | { type: "complete"; runId: string; status: RunStatus };

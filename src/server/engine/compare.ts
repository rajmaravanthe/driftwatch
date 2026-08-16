import type {
  ResourceSpec,
  DriftReport,
  DriftSeverity,
} from "../../shared/types.js";
import type { LiveResource } from "./provider.js";

/**
 * Drift comparison logic — the heart of DriftWatch.
 *
 * Pure functions: expected manifests in, live provider state in,
 * a structured DriftReport out. Fully unit-testable without IO.
 */

const FIELD_META: Record<string, { label: string; severity: DriftSeverity }> = {
  "config.cpu": { label: "CPU cores", severity: "high" },
  "config.memory": { label: "Memory (MiB)", severity: "high" },
  "config.instanceType": { label: "Instance type", severity: "medium" },
  "config.instances": { label: "Instance count", severity: "high" },
  "config.storage": { label: "Storage (GiB)", severity: "low" },
  "config.tls": { label: "TLS enabled", severity: "critical" },
  "config.version": { label: "Engine version", severity: "critical" },
  "config.replicas": { label: "Replicas", severity: "high" },
  "config.skipDrift": { label: "Drift suppression", severity: "medium" },
  "config.reference": { label: "Failover reference", severity: "medium" },
  "config.region": { label: "Region", severity: "medium" },
  "config.maxConnections": { label: "Max connections", severity: "low" },
};

function fieldMeta(path: string): { label: string; severity: DriftSeverity } {
  return (
    FIELD_META[path] ?? {
      label: path.replace("config.", ""),
      severity: "low",
    }
  );
}

/**
 * Compare one resource's expected spec against live state.
 * Returns a ResourceDrift record; `status` is "clean" when no field
 * differs between expected and actual.
 */
export function compareResource(
  expected: ResourceSpec,
  live: LiveResource,
): DriftReport["resources"][number] {
  const diffs = new Map<
    string,
    { expected: unknown; actual: unknown; severity: DriftSeverity }
  >();

  // Pass 1: expected fields that differ or are absent in live state.
  for (const [key, expectedValue] of Object.entries(expected.config)) {
    const liveValue = live.config[key];
    const expectedJson = JSON.stringify(expectedValue ?? null);
    const liveJson = JSON.stringify(liveValue ?? null);
    if (expectedJson === liveJson) continue;

    const path = `config.${key}`;
    diffs.set(path, {
      expected: expectedValue,
      actual: liveValue,
      severity: fieldMeta(path).severity,
    });
  }

  // Pass 2: live fields with no expected counterpart => unexpected (untracked).
  for (const [key, liveValue] of Object.entries(live.config)) {
    if (key in expected.config) continue;
    const path = `config.${key}`;
    diffs.set(path, {
      expected: undefined,
      actual: liveValue,
      severity: fieldMeta(path).severity,
    });
  }

  return {
    resourceName: expected.name,
    kind: expected.kind,
    strategy: expected.strategy,
    driftKind: diffs.size > 0 ? "field-changed" : "missing",
    status: diffs.size > 0 ? "drifted" : "clean",
    fields: [...diffs.entries()].map(([path, diff]) => ({
      path,
      label: fieldMeta(path).label,
      expected: diff.expected,
      actual: diff.actual,
      severity: diff.severity,
    })),
  };
}

/** Compare a full manifest against live state and produce the report. */
export function buildReport(
  expected: ResourceSpec[],
  live: LiveResource[],
  environment: string,
): DriftReport {
  const liveByName = new Map(live.map((r) => [r.name, r]));

  const resources = expected.map((spec) => {
    const liveResource = liveByName.get(spec.name);
    if (!liveResource) {
      return {
        resourceName: spec.name,
        kind: spec.kind,
        strategy: spec.strategy,
        driftKind: "missing" as const,
        status: "drifted" as const,
        fields: [] as DriftReport["resources"][number]["fields"],
      };
    }
    return compareResource(spec, liveResource);
  });

  return {
    environment,
    generatedAt: new Date().toISOString(),
    resources,
    summary: {
      resourceCount: resources.length,
      cleanCount: resources.filter((r) => r.status === "clean").length,
      driftedCount: resources.filter((r) => r.status === "drifted").length,
      criticalCount: resources.filter((r) =>
        r.fields.some((f) => f.severity === "critical"),
      ).length,
      discoveredAt: new Date().toISOString(),
      durationMs: 0,
    },
  };
}

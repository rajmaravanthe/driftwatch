import { useEffect, useRef, useState } from "react";
import type {
  DriftReport,
  Run,
  RunLogEntry,
  ServerSentEvent,
} from "../../shared/types.js";
import { api, subscribeToRun } from "../lib/api.js";
import { formatClock, formatTime, SeverityBadge, StepDot } from "./Bits.js";

interface RunDetailProps {
  runId: string;
  onBack: () => void;
}

const STEP_LABELS: Record<string, string> = {
  validate: "Validate manifest",
  inventory: "Inventory platform",
  "fetch-live-state": "Fetch live state",
  reconcile: "Reconcile drift",
  compare: "Compare & score",
  report: "Persist report",
};

export function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "∅";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function RunDetail({ runId, onBack }: RunDetailProps) {
  const [run, setRun] = useState<Run | null>(null);
  const [logs, setLogs] = useState<RunLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    api
      .getRun(runId)
      .then((r) => {
        if (active) setRun(r);
      })
      .catch((err) => active && setError(err.message));
    api
      .getLogs(runId)
      .then((entries) => active && setLogs(entries))
      .catch(() => {});
    const unsubscribe = subscribeToRun(runId, handleEvent, (err) => {
      if (active) setError(err.message);
    });
    return () => {
      active = false;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  function handleEvent(event: ServerSentEvent) {
    if (event.type === "status") {
      setRun((prev) => (prev ? { ...prev, status: event.status } : prev));
    } else if (event.type === "step") {
      setRun((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          steps: prev.steps.map((s) =>
            s.name === event.step.name ? event.step : s,
          ),
        };
      });
    } else if (event.type === "log") {
      setLogs((prev) => [...prev, event.entry]);
    } else if (event.type === "report") {
      setRun((prev) =>
        prev
          ? { ...prev, drift: event.drift, fallbackUsed: event.fallbackUsed }
          : prev,
      );
    }
  }

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  if (error) return <div className='error-banner'>Error: {error}</div>;
  if (!run) return <div className='loading'>Loading run…</div>;

  const summary = run.summary;

  return (
    <div>
      <div className='breadcrumb'>
        <a onClick={onBack}>← Back to manifest</a>
      </div>

      <div className='manifest-header'>
        <h1>
          Run {run.id.slice(0, 8)}
          <span className={`status-pill status-pill--${run.status}`}>
            {run.status}
          </span>
        </h1>
        <div className='manifest-card__meta'>
          started {formatTime(run.startedAt)} ·{" "}
          {run.finishedAt
            ? `finished ${formatTime(run.finishedAt)}`
            : "in progress"}
        </div>
      </div>

      {run.fallbackUsed && (
        <div className='fallback-banner'>
          ⚠️ Some live state was read from the inventory snapshot because the
          platform API was unreachable for individual resources — results for
          those resources may be stale.
        </div>
      )}

      <div className='section-title'>Workflow</div>
      <div className='steps'>
        {run.steps.map((step) => (
          <div className='step' key={step.name}>
            <StepDot status={step.status} />
            <span className='step__name'>
              {STEP_LABELS[step.name] ?? step.name}
            </span>
            <span className='step__detail'>
              {step.status === "running"
                ? `running… (attempt ${step.attempt + 1})`
                : (step.detail ?? (step.status === "pending" ? "queued" : ""))}
            </span>
          </div>
        ))}
      </div>

      <div className='section-title'>Logs</div>
      <div className='logs'>
        {logs.length === 0 && (
          <div className='logs__line'>No log entries yet.</div>
        )}
        {logs.map((entry) => (
          <div className='logs__line' key={entry.id}>
            <span className='logs__time'>{formatTime(entry.ts)}</span>
            <span className='logs__step'>{entry.step}</span>
            <span className={`logs__message logs__level--${entry.level}`}>
              {entry.message}
            </span>
          </div>
        ))}
        <div ref={logEndRef} />
      </div>

      {run.drift && (
        <>
          <div className='section-title'>Drift report</div>
          <DriftReportView report={run.drift} />
        </>
      )}

      {summary && run.status === "succeeded" && (
        <div className='card'>
          Total workflow time:{" "}
          <strong>{formatClock(summary.durationMs)}</strong>
        </div>
      )}
    </div>
  );
}

export function DriftReportView({ report }: { report: DriftReport }) {
  const { summary } = report;
  return (
    <div>
      <div className='summary-grid'>
        <div className='brick brick--total'>
          <div className='brick__value'>{summary.resourceCount}</div>
          <div className='brick__label'>resources</div>
        </div>
        <div className='brick brick--clean'>
          <div className='brick__value'>{summary.cleanCount}</div>
          <div className='brick__label'>clean</div>
        </div>
        <div className='brick brick--drifted'>
          <div className='brick__value'>{summary.driftedCount}</div>
          <div className='brick__label'>drifted</div>
        </div>
        <div className='brick brick--critical'>
          <div className='brick__value'>{summary.criticalCount}</div>
          <div className='brick__label'>critical</div>
        </div>
      </div>

      {report.resources.map((resource) => {
        const drifted = resource.status === "drifted";
        return (
          <div className='resource-block' key={resource.resourceName}>
            <div
              className={`resource-block__head ${
                drifted
                  ? "resource-block__head--drifted"
                  : "resource-block__head--clean"
              }`}
            >
              <span className='resource-block__name'>
                {resource.resourceName}
              </span>
              <span className='kind-tag'>{resource.kind}</span>
              <span className='strategy-tag'>{resource.strategy}</span>
              <span
                className={`status-pill status-pill--${
                  drifted ? "failed" : "succeeded"
                }`}
              >
                {resource.status}
              </span>
            </div>
            {!drifted ? (
              <div className='clean-note'>
                ✓ Matches declared state — no drift.
              </div>
            ) : resource.fields.length === 0 ? (
              <div className='clean-note'>
                ✗ Resource is missing from the live platform (declared but
                absent).
              </div>
            ) : (
              <table className='field-table'>
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Expected</th>
                    <th>Live</th>
                    <th>Severity</th>
                  </tr>
                </thead>
                <tbody>
                  {resource.fields.map((field) => (
                    <tr key={field.path}>
                      <td>{field.label}</td>
                      <td>
                        <span className='expected'>
                          {formatScalar(field.expected)}
                        </span>
                      </td>
                      <td>
                        <span className='actual actual--diff'>
                          {formatScalar(field.actual)}
                        </span>
                      </td>
                      <td>
                        <SeverityBadge severity={field.severity} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}

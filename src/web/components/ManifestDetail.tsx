import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { ManifestListItem, Run } from "../../shared/types.js";
import { api } from "../lib/api.js";
import { formatTime, StatusPill } from "./Bits.js";

/**
 * Code-split the live workflow view: the RunDetail chunk (SSE handling,
 * log stream, drift report table) is only downloaded when the operator
 * actually opens a run. Keeps the manifest browsing experience lean.
 */
const LazyRunDetail = lazy(() =>
  import("./RunDetail.js").then((m) => ({ default: m.RunDetail })),
);

interface Props {
  manifestId: string;
  onBack: () => void;
}

export function ManifestDetail({ manifestId, onBack }: Props) {
  const [manifest, setManifest] = useState<ManifestListItem | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const loadRuns = useCallback(() => {
    api
      .listRuns(manifestId)
      .then(setRuns)
      .catch((err) => setError(err.message));
  }, [manifestId]);

  useEffect(() => {
    let active = true;
    api.listManifests().then((all) => {
      if (!active) return;
      const found = all.find((m) => m.id === manifestId) ?? null;
      setManifest(found);
    });
    loadRuns();
    const timer = setInterval(loadRuns, 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [manifestId, loadRuns]);

  async function startRun() {
    setStarting(true);
    setError(null);
    try {
      const run = await api.createRun(manifestId);
      setRuns((prev) => [run, ...prev]);
      setActiveRunId(run.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  if (activeRunId) {
    return (
      <Suspense
        fallback={<div className='loading'>Loading live workflow view…</div>}
      >
        <LazyRunDetail
          runId={activeRunId}
          onBack={() => {
            setActiveRunId(null);
            loadRuns();
          }}
        />
      </Suspense>
    );
  }

  return (
    <div>
      <div className='breadcrumb'>
        <a onClick={onBack}>← All manifests</a>
      </div>

      {error && <div className='error-banner'>{error}</div>}

      {manifest && (
        <div className='manifest-header'>
          <h1>
            {manifest.name}
            <span
              className={`status-pill status-pill--${manifest.lastRunStatus ?? "none"}`}
            >
              last: {manifest.lastRunStatus ?? "never"}
            </span>
          </h1>
          <div className='manifest-card__meta'>
            {manifest.environment} · {manifest.resources.length} resources ·
            created {new Date(manifest.createdAt).toLocaleDateString()}
          </div>
          <div style={{ marginTop: 14 }}>
            <button
              className='btn btn--green'
              onClick={startRun}
              disabled={starting}
            >
              {starting ? "Starting…" : "▶ Run drift detection"}
            </button>
          </div>
        </div>
      )}

      <div className='section-title'>Declared resources</div>
      <div className='card'>
        {manifest?.resources.map((res) => (
          <div
            key={res.name}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 0",
              borderBottom: "1px solid #eee6d3",
              fontSize: 13,
            }}
          >
            <span style={{ fontWeight: "bold" }}>{res.name}</span>
            <span className='kind-tag'>{res.kind}</span>
            <span className='strategy-tag'>{res.strategy}</span>
          </div>
        ))}
      </div>

      <div className='section-title'>Runs</div>
      {runs.length === 0 && (
        <div className='empty-state'>
          No runs yet. Hit "Run drift detection" to start one.
        </div>
      )}
      {runs.map((run) => (
        <div
          className='run-card'
          key={run.id}
          onClick={() => setActiveRunId(run.id)}
        >
          <div className='run-card__left'>
            <div className='run-card__title'>
              Run {run.id.slice(0, 8)}
              <StatusPill status={run.status} />
            </div>
            <div className='run-card__sub'>
              {formatTime(run.createdAt)} ·{" "}
              {run.summary
                ? `${run.summary.cleanCount} clean · ${run.summary.driftedCount} drifted`
                : "no report yet"}
            </div>
          </div>
          <span className='btn btn--ghost'>View →</span>
        </div>
      ))}
    </div>
  );
}

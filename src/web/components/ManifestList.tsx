import { useEffect, useState } from "react";
import type { ManifestListItem } from "../../shared/types.js";
import { api } from "../lib/api.js";
import { ResourceCount, StatusPill } from "./Bits.js";

interface Props {
  onOpen: (manifestId: string) => void;
  onCreate: () => void;
}

export function ManifestList({ onOpen, onCreate }: Props) {
  const [manifests, setManifests] = useState<ManifestListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .listManifests()
      .then((list) => {
        if (active) {
          setManifests(list);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err.message);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  if (loading) return <div className='loading'>Loading manifests…</div>;
  if (error) return <div className='error-banner'>{error}</div>;

  return (
    <div>
      <div className='page-head'>
        <h1>Manifests</h1>
        <button className='btn' onClick={onCreate}>
          + New manifest
        </button>
      </div>

      {manifests.length === 0 && (
        <div className='empty-state'>
          No manifests yet. Create one to declare expected infrastructure state,
          then run a drift detection.
        </div>
      )}

      {manifests.map((manifest) => (
        <div
          className='manifest-card'
          key={manifest.id}
          onClick={() => onOpen(manifest.id)}
        >
          <div className='manifest-card__main'>
            <div className='manifest-card__title'>
              {manifest.name}
              <ResourceCount count={manifest.resources.length} />
            </div>
            <div className='manifest-card__meta'>
              {manifest.environment} · {manifest.runCount} run
              {manifest.runCount === 1 ? "" : "s"}
              {manifest.lastRunAt
                ? ` · last ${new Date(manifest.lastRunAt).toLocaleString()}`
                : ""}
            </div>
          </div>
          <StatusPill status={manifest.lastRunStatus} />
        </div>
      ))}
    </div>
  );
}

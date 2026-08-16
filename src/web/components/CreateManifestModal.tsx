import { useState } from "react";
import type { ResourceSpec } from "../../shared/types.js";
import { api } from "../lib/api.js";

interface Props {
  onClose: () => void;
  onCreated: (id: string) => void;
}

const DEFAULT_JSON: ResourceSpec[] = [
  {
    name: "payments-api",
    kind: "server",
    strategy: "notify",
    config: { cpu: 2, memory: 4096, instances: 3 },
  },
  {
    name: "orders-db",
    kind: "database",
    strategy: "reconcile",
    config: {
      tls: true,
      version: "15.1",
      replicas: 2,
      storage: 100,
      maxConnections: 400,
    },
  },
];

export function CreateManifestModal({ onClose, onCreated }: Props) {
  const [name, setName] = useState("Production storefront");
  const [environment, setEnvironment] = useState("production");
  const [resourceJson, setResourceJson] = useState(
    JSON.stringify(DEFAULT_JSON, null, 2),
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setError(null);
    let resources: ResourceSpec[];
    try {
      resources = JSON.parse(resourceJson) as ResourceSpec[];
    } catch {
      setError("Resource JSON is not valid JSON.");
      return;
    }
    if (!Array.isArray(resources) || resources.length === 0) {
      setError("resources must be a non-empty array.");
      return;
    }
    setSubmitting(true);
    try {
      const manifest = await api.createManifest({
        name,
        environment,
        resources,
      });
      onCreated(manifest.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div className='modal-overlay' onClick={onClose}>
      <div className='modal' onClick={(e) => e.stopPropagation()}>
        <h2>New manifest</h2>

        {error && <div className='form-error'>{error}</div>}

        <div className='form-field'>
          <label htmlFor='mf-name'>Name</label>
          <input
            id='mf-name'
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='Production storefront'
          />
        </div>

        <div className='form-field'>
          <label htmlFor='mf-env'>Environment</label>
          <input
            id='mf-env'
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
            placeholder='production'
          />
        </div>

        <div className='form-field'>
          <label htmlFor='mf-res'>Resources (JSON)</label>
          <textarea
            id='mf-res'
            value={resourceJson}
            onChange={(e) => setResourceJson(e.target.value)}
            spellCheck={false}
          />
          <div className='hint'>
            Array of{" "}
            {
              "{ name, kind: server|database|loadBalancer, strategy: notify|reconcile, config: {...} }"
            }
          </div>
        </div>

        <div className='form-actions'>
          <button className='btn btn--ghost' onClick={onClose}>
            Cancel
          </button>
          <button
            className='btn btn--green'
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? "Creating…" : "Create manifest"}
          </button>
        </div>
      </div>
    </div>
  );
}

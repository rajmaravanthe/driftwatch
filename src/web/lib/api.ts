import type {
  Manifest,
  ManifestListItem,
  Run,
  RunLogEntry,
  ServerSentEvent,
} from "../../shared/types.js";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as {
        error?: string;
        details?: Array<{ field: string; message: string }>;
      };
      detail =
        body.details?.map((d) => `${d.field}: ${d.message}`).join("; ") ??
        body.error ??
        detail;
    } catch {
      // keep status fallback
    }
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  listManifests: () => request<ManifestListItem[]>("/manifests"),
  createManifest: (body: {
    name: string;
    environment: string;
    resources: Manifest["resources"];
  }) =>
    request<Manifest>("/manifests", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteManifest: (id: string) =>
    request<void>(`/manifests/${id}`, { method: "DELETE" }),
  listRuns: (manifestId: string) =>
    request<Run[]>(`/manifests/${manifestId}/runs`),
  createRun: (manifestId: string) =>
    request<Run>(`/manifests/${manifestId}/runs`, { method: "POST" }),
  getRun: (id: string) => request<Run>(`/runs/${id}`),
  getLogs: (runId: string) => request<RunLogEntry[]>(`/runs/${runId}/logs`),
  getMeta: () => request<{ platformLabel: string; note: string }>("/meta"),
};

/** Open an SSE stream and dispatch parsed events to a handler. */
export function subscribeToRun(
  runId: string,
  onEvent: (event: ServerSentEvent) => void,
  onError: (err: Error) => void,
): () => void {
  const source = new EventSource(`/api/runs/${runId}/events`);
  source.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as ServerSentEvent);
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  };
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) source.close();
  };
  return () => source.close();
}

import { useEffect, useState } from "react";
import { ManifestList } from "./components/ManifestList.js";
import { ManifestDetail } from "./components/ManifestDetail.js";
import { CreateManifestModal } from "./components/CreateManifestModal.js";
import { api } from "./lib/api.js";

type View =
  | { kind: "list" }
  | { kind: "manifest"; manifestId: string }
  | { kind: "create" };

export function App() {
  const [view, setView] = useState<View>({ kind: "list" });
  const [meta, setMeta] = useState<{
    platformLabel: string;
    note: string;
  } | null>(null);

  useEffect(() => {
    api
      .getMeta()
      .then(setMeta)
      .catch(() => {});
  }, []);

  return (
    <>
      <div className='topbar'>
        <div className='topbar__brand'>
          <span role='img' aria-label='radar'>
            📡
          </span>
          <span>DriftWatch</span>
          <span className='topbar__badge'>drift detection</span>
        </div>
        <div className='platform-chip'>
          {meta?.platformLabel ?? "connecting…"}
          <small>{meta?.note ?? " "}</small>
        </div>
      </div>

      {view.kind === "list" && (
        <ManifestList
          onOpen={(manifestId) => setView({ kind: "manifest", manifestId })}
          onCreate={() => setView({ kind: "create" })}
        />
      )}

      {view.kind === "manifest" && (
        <ManifestDetail
          manifestId={view.manifestId}
          onBack={() => setView({ kind: "list" })}
        />
      )}

      {view.kind === "create" && (
        <CreateManifestModal
          onClose={() => setView({ kind: "list" })}
          onCreated={(id) => setView({ kind: "manifest", manifestId: id })}
        />
      )}
    </>
  );
}

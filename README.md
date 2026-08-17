# DriftWatch — Infrastructure Drift Detection

A working platform-engineering tool for a real operational problem: **declared state vs. live infrastructure drift**. An operator declares expected infrastructure as a manifest, DriftWatch runs a live detection workflow against a (mock) platform, shows every step as it happens, and produces a per-field drift report.

Built for a 2–4 hour engineering assessment. TypeScript end-to-end, fully local, no cloud accounts or API keys.

## Highlights

- **Manifest-driven detection** — declare expected state per resource; per-resource `notify` or `reconcile` strategy.
- **Live workflow** — trigger a run; watch validate → inventory → fetch state → reconcile → compare → report execute step-by-step over SSE with a persisted log stream.
- **Realistic behavior** — transient provider failures are retried with exponential backoff; graceful fallback to inventory snapshot; reconcile actually mutates the (mock) world.
- **Persistent state** — SQLite stores manifests, runs, steps, drift reports, and logs. Runs survive restarts and are fully replayable via REST.
- **Clean API** — request validation with Zod, typed response shapes consumed by the UI.

## Quick start

Prerequisites: Node.js ≥ 18 (tested on 22), npm.

```bash
git clone <repo-url> driftwatch
cd driftwatch
npm install

# 1. Seed demo "live world" + a sample manifest
npm run seed

# 2. Start API (port 4000) and web UI (port 5173)
npm run dev
```

Open http://localhost:5173 → **Storefront (demo)** → **▶ Run drift detection** and watch the workflow run.

Demo world: `payments-api` (drifted: high instance count), `orders-db` (drifted: tls/version/replicas, auto-healed by `reconcile`), `web-lb` (drifted: region + failover reference), `auth-service` (clean).

### Verify manually

```bash
# list manifests
curl -s localhost:4000/api/manifests

# trigger a run
MANIFEST_ID=$(curl -s localhost:4000/api/manifests | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d)[0].id))")
RUN_ID=$(curl -s -X POST localhost:4000/api/manifests/$MANIFEST_ID/runs | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")

# poll for the report
curl -s localhost:4000/api/runs/$RUN_ID   # includes .drift, .steps, .summary
curl -s localhost:4000/api/runs/$RUN_ID/logs
```

### Exercise retries

```bash
node -e '
const fs=require("fs");const w=JSON.parse(fs.readFileSync("data/world.json","utf8"));
w.transientFailures={"payments-api":1};delete w.stats;fs.writeFileSync("data/world.json",JSON.stringify(w,null,2));'
# now run drift detection in the UI — watch a warn log: "fetch payments-api failed (attempt 1/3)… retrying"
```

### Run tests + typecheck

```bash
npm run test
npx tsc -p tsconfig.server.json --noEmit
npx tsc -p tsconfig.web.json --noEmit
```

## Use-case rationale

Platform people constantly fight **configuration drift** — the gap between what IaC says should exist and what actually does. Tools like Terraform plan exist, but drift is discovered reactively and buried in noisy apply logs. DriftWatch frames it as an operator-facing workflow: declare intent, run a detection pipeline, understand *what* drifted, *how severe* it is, and (optionally) let the system heal it. That is a real, everyday platform pain, scoped small and executed deeply.

## System design

```
┌────────────┐   REST + SSE    ┌────────────────────────────┐
│  React UI  │ ◄─────────────► │  Express API (src/server)  │
└────────────┘                 │                            │
                               │  routes/api.ts (Zod)       │
                               │  events.ts (SSE hub)       │
                               │  engine/runner.ts (steps)  │
                               │  engine/compare.ts (pure)  │
                               │  engine/provider.ts (mock) │
                               │  repository.ts (SQLite)    │
                               └──────────┬─────────────────┘
                                          │
                                  data/driftwatch.db
                                  data/world.json (mock "platform")
```

**Workflow run state machine** — every run walks a fixed pipeline; each transition is persisted to SQLite and broadcast to SSE subscribers, so the UI is always consistent with the server even after reconnect.

**Consumers of the engine** — `WorkflowRunner` is a pure driver independent of HTTP; the API router is just one caller. Unit-testing the comparison engine is trivial because `compare.ts` is pure.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/manifests` | List manifests with last-run status/run count |
| POST | `/api/manifests` | Create manifest (Zod-validated, 400 with field-level errors) |
| DELETE | `/api/manifests/:id` | Delete manifest (cascades runs) |
| GET | `/api/manifests/:id/runs` | List runs for a manifest |
| POST | `/api/manifests/:id/runs` | Start a drift-detection run (returns run, executes async) |
| GET | `/api/runs/:id` | Get run with steps/status/summary/drift report |
| GET | `/api/runs/:id/logs` | Get persisted log stream for a run |
| GET | `/api/runs/:id/events` | **SSE**: live `step`/`log`/`status`/`report`/`complete` events |
| GET | `/api/meta` | Provider metadata (platform label, mock note) |

## Design decisions

- **SQLite + better-sqlite3 instead of an ORM.** Small scope, synchronous transactions, migrate-on-boot via `PRAGMA user_version`. Zero config = zero friction for an evaluator.
- **JSON-file "world" as the mock provider.** Re-read on every call so out-of-band edits (like seeding after server start) are observed immediately — a real race in my first implementation that I caught during verification (see git history: "fix: provider re-reads world.json…").
- **Zod for request validation.** Consistent 400 shape: `{ error, details: [{ field, message }] }`.
- **In-process fire-and-forget execution.** A worker/queue is the documented next step — the run state machine already models all terminal states.
- **No hand-rolled state/ORM.** Everything is explicit functions over SQL — intent over cleverness.

## UI design choices

Deliberate **cartoon-brutalist** visual style: thick black borders, flat colors, chunky shadows. It makes status legible at a glance (green = clean, red = drifted, blue = running) without charting libraries and reads intentionally as an operator tool, not a marketing site.

## What to build next

1. **Scheduled runs** — cron-style drift checks with alerts (webhook/email).
2. **Real cloud provider adapters** — a `Provider` interface already isolates the mock; AWS/Terraform/kubernetes adapters slot in behind it.
3. **Diff snapshots over time** — WHO drifted when; trend line per resource.
4. **Run cancellation/dequeue** — finite-state machine already models terminal states; wire an operator "cancel" action.
5. **Secure multi-tenant UI** — auth (e.g., Auth.js), per-team manifests.
6. **Queue/worker for run execution** — today runs execute in-process fire-and-forget; a real deployment needs a worker process + job table for durability and horizontal scale.

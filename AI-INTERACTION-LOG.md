# AI Interaction Log — DriftWatch

**Scope:** Full assessment session (scaffold → persistence → engine → API → UI → verification → docs).
**How AI was used:** iterative engineering partner — pair-programming for initial implementation, verification via CLI + browser, course-correction on real bugs found during verification.
**Stack:** TypeScript (server + client), Express, SQLite (better-sqlite3), React + Vite, Zod, SSE.

## What the AI did vs. what I decided

| Step | AI role | My role |
| --- | --- | --- |
| Repo scaffold + toolchain | Generated tsconfig/vite/package files | Chose single-repo layout, `"type":"module"`, tsx, root references |
| Data model | Drafted shared types | Defined pipeline steps + run statuses; decided `steps` as an explicit JSON array (not a table) because a run's pipeline is fixed and replayed atomically |
| Mock provider | Implemented JSON-file world with latency + failure injection | Specified the contract: persistent across runs, `transientFailures` for deterministic retry testing, `ping/inventory/fetchResource/apply` |
| Drift engine | Wrote pure compare functions | Reviewed severity table (tls/version → critical), field-meta mapping, unexpected-field detection semantics |
| Workflow runner | Drafted retry loop + step state machine | Required: persist every transition; degrade to inventory snapshot (`fallbackUsed` flag) instead of aborting the whole run on exhausted retries |
| API layer | Generated Express routes + Zod schemas | Enforced: async fire-and-forget run execution via `startRun` guard; SSE heartbeat; consistent 400 shape |
| UI | Generated React components + CSS | Approved cartoon-brutalist design; made status colors/semantics explicit per resource strategy |
| Task docs | Drafted README/architecture/seed script | Filled in design rationale + next steps |

## Key course-corrections found by verification (the interesting part)

1. **Seed-after-start staleness.** The first provider loaded `world.json` once in the constructor. When I seeded *after* the dev server was already running, the provider never saw the new world → every resource reported `drifted (missing)`. This is exactly the kind of bug that only surfaces by running the real system, not by reviewing code. **Fix:** provider re-reads the world file on every call (documented trade-off for a small local file) — commit `3e0bfaa`.

2. **Clean-resource semantics.** BuildReport marked clean resources with `driftKind: "missing"` — misleading. **Fix:** added `"clean"` to `DriftKind`, updated type + test — commit `f1ec4e1`.

3. **One-shot transient failures.** The retry fixture `transientFailures: {x: 1}` would fail *every* attempt (probability 1). **Fix:** consume the failure on first hit (decay to 0) so the retry path could be demonstrated deterministically.

4. **Screenshot-based browser verification.** Initial run-button clicks "missed" during headless testing; the live-run-to-report flow ended up verified after re-targeting (proved by the final drift-report screenshot showing 2 clean / 2 drifted, matching the seeded world).

## Commands I ran to verify

```
npx tsc -p tsconfig.server.json --noEmit         # server typecheck
npx tsc -p tsconfig.web.json --noEmit            # web typecheck
npx tsx --test src/server/engine/compare.test.ts # 6/6 unit tests
npm run seed                                     # seed demo world + manifest
curl POST /api/manifests/:id/runs → poll /api/runs/:id → assert drift
curl POST /api/manifests (invalid kind) → 400 + field-level error
node /tmp/dw_retry_run.js                        # transient failure → retry → succeed
Puppeteer browser: list → detail → run → drift report (visual)
```

## Notable delegation decisions

- Delegated **everything** to the workspace loop rather than spawning sub-agents: the surface is ~25 focused files and a single coherent domain — parallel sub-agents would have cost more integration time than they saved.
- Kept the three engines (`compare`, `provider`, `runner`) as leaf modules with stable interfaces so each could be type-checked and reworked independently without rippling.

## Final state

- 8 commits, linear history, each phase atomic (scaffold → persistence+engine → runner → UI → fixes → docs).
- Verified: happy path, retry path, failure path, full browser UX.

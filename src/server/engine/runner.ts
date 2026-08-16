import type {
  DriftReport,
  Manifest,
  Run,
  RunLogEntry,
  RunStatus,
  RunStep,
  ServerSentEvent,
  StepName,
} from "../../shared/types.js";
import { logRepository, runRepository } from "../repository.js";
import { buildReport } from "./compare.js";
import {
  MockInfraProvider,
  ProviderConnectError,
  type LiveResource,
} from "./provider.js";

/**
 * The drift-detection workflow driver.
 *
 * Executes a Run through a fixed pipeline of steps. Every transition
 * (step start/finish, log line, status change, final report) is persisted
 * to SQLite and broadcast to connected SSE clients, so the UI can follow
 * the execution live and replay it afterwards.
 */

export interface EventSink {
  broadcast(runId: string, event: ServerSentEvent): void;
}

export const STEP_ORDER: StepName[] = [
  "validate",
  "inventory",
  "fetch-live-state",
  "reconcile",
  "compare",
  "report",
];

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 350;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface MaterializedLiveState {
  /** Every expected resource name -> live state (only those found on target). */
  byName: Map<string, LiveResource>;
  missingNames: string[];
}

export class WorkflowRunner {
  constructor(
    private readonly provider: MockInfraProvider,
    private readonly events: EventSink,
  ) {}

  private emit(runId: string, event: ServerSentEvent): void {
    this.events.broadcast(runId, event);
  }

  private log(entry: Omit<RunLogEntry, "id" | "ts">): void {
    const saved = logRepository.append(entry);
    this.emit(entry.runId, { type: "log", runId: entry.runId, entry: saved });
  }

  private persist(run: Run): void {
    runRepository.update(run);
  }

  private refreshStep(
    run: Run,
    stepName: StepName,
    patch: Partial<RunStep>,
  ): RunStep {
    const idx = run.steps.findIndex((s) => s.name === stepName);
    if (idx === -1) throw new Error(`step ${stepName} not found in pipeline`);
    const updated = { ...run.steps[idx], ...patch };
    run.steps[idx] = updated;
    this.persist(run);
    this.emit(run.id, { type: "step", runId: run.id, step: updated });
    return updated;
  }

  private setStatus(run: Run, status: RunStatus): void {
    run.status = status;
    if (status === "running" && !run.startedAt) {
      run.startedAt = new Date().toISOString();
    }
    if (
      status === "succeeded" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      run.finishedAt = new Date().toISOString();
    }
    this.persist(run);
    this.emit(run.id, { type: "status", runId: run.id, status });
  }

  /**
   * Run a provider call that may fail transiently. Retries with exponential
   * backoff up to MAX_ATTEMPTS. Non-transient errors propagate immediately.
   */
  private async withProviderRetry<T>(
    run: Run,
    step: StepName,
    what: string,
    op: () => Promise<T>,
  ): Promise<T> {
    let attempt = 1;
    for (;;) {
      try {
        return await op();
      } catch (err) {
        if (!(err instanceof ProviderConnectError)) throw err;
        if (attempt >= MAX_ATTEMPTS) throw err;
        const waitMs = RETRY_BASE_MS * 2 ** (attempt - 1);
        this.log({
          runId: run.id,
          level: "warn",
          step,
          message: `${what} failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message} — retrying in ${waitMs}ms`,
        });
        await sleep(waitMs);
        attempt += 1;
      }
    }
  }

  /** Execute the whole pipeline for a run. Failures are captured and persisted. */
  async run(runId: string, manifest: Manifest): Promise<void> {
    const run = runRepository.findById(runId);
    if (!run) throw new Error(`run ${runId} not found`);

    const wallClockStart = Date.now();
    this.setStatus(run, "running");
    this.log({
      runId,
      level: "info",
      step: "system",
      message: `drift detection started for "${manifest.name}" (${manifest.environment})`,
    });

    const liveState: MaterializedLiveState = {
      byName: new Map(),
      missingNames: [],
    };
    let fallbackUsed = false;

    for (const stepName of STEP_ORDER) {
      this.refreshStep(run, stepName, {
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        detail: null,
      });
      this.log({
        runId,
        level: "info",
        step: stepName,
        message: `step started`,
      });

      try {
        if (stepName === "validate") {
          const detail = `manifest is valid — ${manifest.resources.length} resource(s)`;
          this.finishStep(run, stepName, detail);
        } else if (stepName === "inventory") {
          await this.runInventoryStep(run, stepName, liveState);
        } else if (stepName === "fetch-live-state") {
          await this.runFetchStep(run, stepName, manifest, liveState);
        } else if (stepName === "reconcile") {
          await this.runReconcileStep(run, stepName, manifest, liveState);
        } else if (stepName === "compare") {
          this.runCompareStep(
            run,
            stepName,
            manifest,
            liveState,
            wallClockStart,
          );
        } else {
          const report = run.drift!;
          run.summary = report.summary;
          this.finishStep(
            run,
            stepName,
            `report saved — ${report.summary.cleanCount} clean, ${report.summary.driftedCount} drifted`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        run.error = { message, step: stepName };
        this.refreshStep(run, stepName, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          detail: message,
        });
        this.setStatus(run, "failed");
        this.log({ runId, level: "error", step: stepName, message });
        this.emit(run.id, {
          type: "complete",
          runId: run.id,
          status: "failed",
        });
        return;
      }
    }

    this.setStatus(run, "succeeded");
    run.fallbackUsed = fallbackUsed;
    run.finishedAt = new Date().toISOString();
    this.persist(run);
    this.emit(run.id, {
      type: "report",
      runId: run.id,
      drift: run.drift!,
      fallbackUsed,
    });
    this.emit(run.id, { type: "complete", runId: run.id, status: "succeeded" });
    this.log({
      runId,
      level: "info",
      step: "report",
      message: `run finished — ${run.summary?.cleanCount ?? 0} clean, ${run.summary?.driftedCount ?? 0} drifted, ${run.summary?.criticalCount ?? 0} critical`,
    });
  }

  private finishStep(run: Run, stepName: StepName, detail: string): void {
    this.refreshStep(run, stepName, {
      status: "succeeded",
      finishedAt: new Date().toISOString(),
      detail,
    });
    this.log({ runId: run.id, level: "info", step: stepName, message: detail });
  }

  /** inventory: list what the target platform actually has. */
  private async runInventoryStep(
    run: Run,
    stepName: StepName,
    liveState: MaterializedLiveState,
  ): Promise<void> {
    const live = await this.withProviderRetry(run, stepName, "inventory", () =>
      this.provider.inventory(),
    );
    live.forEach((r) => liveState.byName.set(r.name, r));
    this.finishStep(
      run,
      stepName,
      `found ${live.length} live resource(s) on ${this.providerPlatformLabel(run, stepName)}`,
    );
  }

  /**
   * fetch-live-state: fetch each expected resource individually — this is the
   * step that exercises per-resource retries on transient failures.
   */
  private async runFetchStep(
    run: Run,
    stepName: StepName,
    manifest: Manifest,
    liveState: MaterializedLiveState,
  ): Promise<void> {
    let fetchedCount = 0;
    let reusedCount = 0;
    for (const spec of manifest.resources) {
      const hasInventoryEntry = liveState.byName.has(spec.name);
      if (hasInventoryEntry) {
        try {
          const live = await this.withProviderRetry(
            run,
            stepName,
            `fetch ${spec.name}`,
            () => this.provider.fetchResource(spec.name),
          );
          liveState.byName.set(spec.name, live);
          fetchedCount += 1;
          continue;
        } catch (err) {
          if (err instanceof Error && err.message.includes("does not exist")) {
            liveState.byName.delete(spec.name);
            liveState.missingNames.push(spec.name);
            this.log({
              runId: run.id,
              level: "warn",
              step: stepName,
              message: `expected resource ${spec.name} is absent from the platform`,
            });
            continue;
          }
          throw err;
        }
      }
      reusedCount += 1;
    }
    this.finishStep(
      run,
      stepName,
      `fetched live state for ${fetchedCount} resource(s) via API; ${reusedCount} from inventory snapshot; ${liveState.missingNames.length} expected resource(s) missing`,
    );
  }

  /** reconcile: apply expected state for resources with strategy === "reconcile". */
  private async runReconcileStep(
    run: Run,
    stepName: StepName,
    manifest: Manifest,
    liveState: MaterializedLiveState,
  ): Promise<void> {
    const toApply = manifest.resources.filter(
      (r) => r.strategy === "reconcile",
    );
    if (toApply.length === 0) {
      this.finishStep(
        run,
        stepName,
        "no reconcile-strategy resources — nothing to apply",
      );
      return;
    }

    let applied = 0;
    for (const spec of toApply) {
      this.log({
        runId: run.id,
        level: "info",
        step: stepName,
        message: `applying expected state to ${spec.name} (${spec.kind})`,
      });
      const appliedLive = await this.withProviderRetry(
        run,
        stepName,
        `apply ${spec.name}`,
        () => this.provider.apply(spec),
      );
      liveState.byName.set(spec.name, appliedLive);
      applied += 1;
    }
    this.finishStep(
      run,
      stepName,
      `reconciled ${applied}/${toApply.length} resource(s)`,
    );
  }

  /** compare: diff expected vs live and persist the report. */
  private runCompareStep(
    run: Run,
    stepName: StepName,
    manifest: Manifest,
    liveState: MaterializedLiveState,
    wallClockStart: number,
  ): void {
    const report: DriftReport = buildReport(
      manifest.resources,
      [...liveState.byName.values()],
      manifest.environment,
    );
    report.summary.durationMs = Date.now() - wallClockStart;
    run.drift = report;
    run.summary = report.summary;
    this.persist(run);
    this.finishStep(
      run,
      stepName,
      `${report.summary.cleanCount} clean · ${report.summary.driftedCount} drifted · ${report.summary.criticalCount} critical`,
    );
  }

  private providerPlatformLabel(run: Run, stepName: StepName): string {
    return "acme-cloud · region west-1";
  }
}

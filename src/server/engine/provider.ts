import fs from "node:fs";
import path from "node:path";
import type { ResourceKind, ResourceSpec } from "../../shared/types.js";

/**
 * Mock infrastructure provider.
 *
 * Represents the "real" platform (e.g. AWS/VMware state) that DriftWatch
 * inspects. Backed by a JSON file (`data/world.json`) so live state persists
 * across runs — out-of-band changes made by "other operators" stick, and
 * reconcile actually mutates the world on disk.
 *
 * The world file is re-read on every call (see `read()`/`write()`), so edits
 * made outside this provider — e.g. `npm run seed` running after the server
 * has started — are observed immediately. The file is a few KB; this is a
 * deliberate, documented trade-off for a local mock.
 */

export interface LiveResource {
  name: string;
  kind: ResourceKind;
  config: Record<string, unknown>;
}

export interface ProviderWorld {
  /** Simulated target platform name, e.g. "acme-cloud (west-1)". */
  platformLabel: string;
  resources: LiveResource[];
  /**
   * Transient connectivity failures, keyed by resource name -> failure rate
   * (0..1). Used to exercise the retry path deterministically. e.g.
   * `{ "payments-api": 1 }` fails the first fetch of that resource, then
   * succeeds on the retry (probability-based per call).
   */
  transientFailures: Record<string, number>;
  stats: {
    requests: number;
    failures: number;
    applied: number;
  };
}

const DEFAULT_WORLD: ProviderWorld = {
  platformLabel: "acme-cloud · region west-1",
  resources: [],
  transientFailures: {},
  stats: { requests: 0, failures: 0, applied: 0 },
};

function worldPath(): string {
  return (
    process.env.DRIFTWATCH_WORLD ??
    path.join(process.cwd(), "data", "world.json")
  );
}

export class ProviderConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConnectError";
  }
}

export class MockInfraProvider {
  get platformLabel(): string {
    return this.read().platformLabel;
  }

  /** Load the world from disk, falling back to defaults when absent. */
  private read(): ProviderWorld {
    try {
      const raw = fs.readFileSync(worldPath(), "utf8");
      const parsed = JSON.parse(raw) as Partial<ProviderWorld>;
      return {
        ...structuredClone(DEFAULT_WORLD),
        ...parsed,
        stats: { ...DEFAULT_WORLD.stats, ...(parsed.stats ?? {}) },
      };
    } catch {
      return structuredClone(DEFAULT_WORLD);
    }
  }

  /** Persist the world back to disk atomically enough for a local mock. */
  private write(world: ProviderWorld): void {
    fs.mkdirSync(path.dirname(worldPath()), { recursive: true });
    fs.writeFileSync(worldPath(), JSON.stringify(world, null, 2));
  }

  /** Read-modify-write helper that keeps stats changes in the same write. */
  private mutate<T>(fn: (world: ProviderWorld) => T): T {
    const world = this.read();
    const result = fn(world);
    this.write(world);
    return result;
  }

  private simulateLatency(): Promise<void> {
    return new Promise((resolve) => {
      // Deterministic-ish latency so the workflow reads as "live" but stays snappy.
      const delay = 150 + Math.floor(Math.random() * 450);
      setTimeout(resolve, delay);
    });
  }

  /** Record a request in stats. Failing requests also count as failures. */
  private recordResult(failed: boolean): void {
    this.mutate((world) => {
      world.stats.requests += 1;
      if (failed) world.stats.failures += 1;
    });
  }

  /** Probe the target platform; throws when the platform is unreachable. */
  async ping(): Promise<{ platformLabel: string; latencyMs: number }> {
    const t0 = Date.now();
    await this.simulateLatency();
    // 2% chance the platform itself drops — kept rare so normal runs succeed.
    if (Math.random() < 0.02) {
      this.recordResult(true);
      throw new ProviderConnectError(
        "acme-cloud control plane unreachable (simulated timeout)",
      );
    }
    this.recordResult(false);
    return { platformLabel: this.platformLabel, latencyMs: Date.now() - t0 };
  }

  /** List every live resource the platform currently knows about. */
  async inventory(): Promise<LiveResource[]> {
    await this.simulateLatency();
    this.recordResult(false);
    return this.read().resources.map((r) => structuredClone(r));
  }

  /**
   * Fetch one live resource. Honors `transientFailures[name]` as a probability
   * that this call fails with a connectivity error — the runner is expected to
   * retry with backoff.
   */
  async fetchResource(name: string): Promise<LiveResource> {
    await this.simulateLatency();
    const failureRate = this.read().transientFailures[name] ?? 0;
    if (failureRate > 0 && Math.random() < failureRate) {
      // Model the transient as one-off: after this failure the connection
      // recovers, so the next retry attempt succeeds deterministically.
      this.mutate((world) => {
        world.transientFailures[name] = 0;
      });
      this.recordResult(true);
      throw new ProviderConnectError(
        `api error reading ${name}: connection reset by peer (simulated)`,
      );
    }
    this.recordResult(false);
    const live = this.read().resources.find((r) => r.name === name);
    if (!live) {
      throw new Error(`resource ${name} does not exist on the platform`);
    }
    return structuredClone(live);
  }

  /** Apply expected state to the live world (used by reconcile). */
  async apply(spec: ResourceSpec): Promise<LiveResource> {
    await this.simulateLatency();
    return this.mutate((world) => {
      world.stats.requests += 1;
      world.stats.applied += 1;
      const existing = world.resources.find((r) => r.name === spec.name);
      if (existing) {
        existing.kind = spec.kind;
        existing.config = structuredClone(spec.config);
      } else {
        world.resources.push({
          name: spec.name,
          kind: spec.kind,
          config: structuredClone(spec.config),
        });
      }
      const applied = world.resources.find((r) => r.name === spec.name);
      if (!applied) throw new Error(`apply failed for ${spec.name}`);
      return structuredClone(applied);
    });
  }
}

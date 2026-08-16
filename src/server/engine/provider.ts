import fs from "node:fs";
import path from "node:path";
import type { ResourceKind, ResourceSpec } from "../../shared/types.js";

/**
 * Mock infrastructure provider.
 *
 * Represents the "real" platform (e.g. AWS/VMware state) that DriftWatch
 * inspects. Backed by a JSON file (`data/world.json`) so live state persists
 * across runs — out-of-band changes made by "other operators" stick, and
 * reconcile actually mutates the world. No cloud account required.
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
   * `{ "payments-db": 1 }` fails the first fetch of that resource, then works.
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
  private world: ProviderWorld;

  constructor() {
    this.world = this.load();
  }

  get platformLabel(): string {
    return this.world.platformLabel;
  }

  private load(): ProviderWorld {
    try {
      const raw = fs.readFileSync(worldPath(), "utf8");
      return { ...DEFAULT_WORLD, ...(JSON.parse(raw) as ProviderWorld) };
    } catch {
      return structuredClone(DEFAULT_WORLD);
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(worldPath()), { recursive: true });
    fs.writeFileSync(worldPath(), JSON.stringify(this.world, null, 2));
  }

  private recordRequest(failed: boolean): void {
    this.world.stats.requests += 1;
    if (failed) this.world.stats.failures += 1;
    this.persist();
  }

  private simulateLatency(): Promise<void> {
    return new Promise((resolve) => {
      // Deterministic-ish latency so the workflow reads as "live" but stays snappy.
      const delay = 150 + Math.floor(Math.random() * 450);
      setTimeout(resolve, delay);
    });
  }

  /** Probe the target platform; throws when the platform is unreachable. */
  async ping(): Promise<{ platformLabel: string; latencyMs: number }> {
    const t0 = Date.now();
    await this.simulateLatency();
    // Once per N calls the platform itself drops — here 2% to keep it rare.
    if (Math.random() < 0.02) {
      this.recordRequest(true);
      throw new ProviderConnectError(
        "acme-cloud control plane unreachable (simulated timeout)",
      );
    }
    this.recordRequest(false);
    return {
      platformLabel: this.world.platformLabel,
      latencyMs: Date.now() - t0,
    };
  }

  /** List every live resource the platform currently knows about. */
  async inventory(): Promise<LiveResource[]> {
    await this.simulateLatency();
    this.recordRequest(false);
    return this.world.resources.map((r) => structuredClone(r));
  }

  /**
   * Fetch one live resource. Honors `transientFailures[name]` as a probability
   * that this call fails with a connectivity error — the runner is expected to
   * retry with backoff.
   */
  async fetchResource(name: string): Promise<LiveResource> {
    await this.simulateLatency();
    const failureRate = this.world.transientFailures[name] ?? 0;
    if (failureRate > 0 && Math.random() < failureRate) {
      this.recordRequest(true);
      throw new ProviderConnectError(
        `api error reading ${name}: connection reset by peer (simulated)`,
      );
    }
    this.recordRequest(false);
    const live = this.world.resources.find((r) => r.name === name);
    if (!live) {
      throw new Error(`resource ${name} does not exist on the platform`);
    }
    return structuredClone(live);
  }

  /** Apply expected state to the live world (used by reconcile). */
  async apply(spec: ResourceSpec): Promise<LiveResource> {
    await this.simulateLatency();
    this.recordRequest(false);
    this.world.stats.applied += 1;
    const existing = this.world.resources.find((r) => r.name === spec.name);
    if (existing) {
      existing.kind = spec.kind;
      existing.config = structuredClone(spec.config);
    } else {
      this.world.resources.push({
        name: spec.name,
        kind: spec.kind,
        config: structuredClone(spec.config),
      });
    }
    const applied = this.world.resources.find((r) => r.name === spec.name);
    if (!applied) throw new Error(`apply failed for ${spec.name}`);
    this.persist();
    return structuredClone(applied);
  }
}

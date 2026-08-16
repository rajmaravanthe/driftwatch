import fs from "node:fs";
import path from "node:path";
import { manifestRepository } from "../repository.js";
import type { ProviderWorld } from "../engine/provider.js";

/**
 * Seeds a demo "live world" and a matching manifest so the first run
 * produces a meaningful report:
 *
 *   payments-api  (server)       — cpu/memory/instances drifted (notify)
 *   orders-db     (database)     — tls/version/replicas drifted (reconcile, self-heals)
 *   web-lb        (loadBalancer) — region/reference drifted (notify)
 *   auth-service  (server)       — clean (matches expected)
 *
 * Run with `npm run seed`. Safe to re-run: the manifest is upserted by
 * a fixed id and the world is overwritten.
 */

const DEMO_MANIFEST_ID = "demo-staging-web";
const WORLD_PATH = path.join(process.cwd(), "data", "world.json");

const world: ProviderWorld = {
  platformLabel: "acme-cloud · region west-1",
  resources: [
    {
      name: "payments-api",
      kind: "server",
      config: { cpu: 2, memory: 4096, instances: 4 },
    },
    {
      name: "orders-db",
      kind: "database",
      config: {
        tls: false,
        version: "14.2",
        replicas: 1,
        storage: 100,
        maxConnections: 400,
      },
    },
    {
      name: "web-lb",
      kind: "loadBalancer",
      config: { region: "us-east-1", reference: "lb-old-8f3a" },
    },
    {
      name: "auth-service",
      kind: "server",
      config: { cpu: 1, memory: 2048, instances: 2, skipDrift: false },
    },
  ],
  transientFailures: {},
  stats: { requests: 0, failures: 0, applied: 0 },
};

fs.mkdirSync(path.dirname(WORLD_PATH), { recursive: true });
fs.writeFileSync(WORLD_PATH, JSON.stringify(world, null, 2));

const existing = manifestRepository.findById(DEMO_MANIFEST_ID);
if (existing) {
  manifestRepository.delete(DEMO_MANIFEST_ID);
}
manifestRepository.create({
  id: DEMO_MANIFEST_ID,
  name: "Storefront (demo)",
  environment: "staging",
  resources: [
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
    {
      name: "web-lb",
      kind: "loadBalancer",
      strategy: "notify",
      config: { region: "west-1", reference: "lb-prod-2a1c" },
    },
    {
      name: "auth-service",
      kind: "server",
      strategy: "notify",
      config: { cpu: 1, memory: 2048, instances: 2, skipDrift: false },
    },
  ],
});

// eslint-disable-next-line no-console
console.log("Seeded demo world + manifest:");
console.log("  manifest: Storefront (demo) @ staging");
console.log("  live world: 4 resources (3 drifted vs manifest, 1 clean)");
console.log("  run a detection: npm run dev, then trigger a run in the UI");

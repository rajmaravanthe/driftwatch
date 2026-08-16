import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RESOURCE_KINDS } from "../../shared/types.js";
import {
  logRepository,
  manifestRepository,
  runRepository,
} from "../repository.js";
import { sseHub } from "../events.js";
import { WorkflowRunner } from "../engine/runner.js";
import { MockInfraProvider } from "../engine/provider.js";

const resourceSpecSchema = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum([...RESOURCE_KINDS]),
  strategy: z.enum(["notify", "reconcile"]),
  config: z.record(z.string(), z.unknown()),
});

const createManifestSchema = z.object({
  name: z.string().min(1).max(100),
  environment: z.string().min(1).max(50),
  resources: z.array(resourceSpecSchema).min(1).max(50),
});

const PIPELINE_STEPS = [
  "validate",
  "inventory",
  "fetch-live-state",
  "reconcile",
  "compare",
  "report",
] as const;

/** Guard against double-scheduling the same run id. */
const activeRuns = new Set<string>();

export function createApiRouter(provider: MockInfraProvider): Router {
  const router = Router();
  const runner = new WorkflowRunner(provider, sseHub);

  const startRun = (runId: string): void => {
    if (activeRuns.has(runId)) return;
    const run = runRepository.findById(runId);
    if (!run) return;
    const manifest = manifestRepository.findById(run.manifestId);
    if (!manifest) return;
    activeRuns.add(runId);
    // Fire-and-forget: the runner persists every transition itself.
    void runner.run(runId, manifest).finally(() => activeRuns.delete(runId));
  };

  // ----- Manifests -----

  router.get("/manifests", (_req, res) => {
    res.json(manifestRepository.list());
  });

  router.post("/manifests", (req, res) => {
    const parsed = createManifestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid-manifest",
        details: parsed.error.issues.map((issue) => ({
          field: issue.path.join(".") || "(root)",
          message: issue.message,
        })),
      });
      return;
    }
    const { name, environment, resources } = parsed.data;
    const manifest = manifestRepository.create({
      id: randomUUID(),
      name,
      environment,
      resources,
    });
    res.status(201).json(manifest);
  });

  router.delete("/manifests/:id", (req, res) => {
    const existed = manifestRepository.findById(req.params.id);
    if (!existed) {
      res.status(404).json({ error: "not-found" });
      return;
    }
    manifestRepository.delete(req.params.id);
    res.status(204).end();
  });

  // ----- Runs -----

  router.get("/manifests/:id/runs", (req, res) => {
    const manifest = manifestRepository.findById(req.params.id);
    if (!manifest) {
      res.status(404).json({ error: "not-found" });
      return;
    }
    res.json(runRepository.listByManifest(manifest.id));
  });

  router.post("/manifests/:id/runs", (req, res) => {
    const manifest = manifestRepository.findById(req.params.id);
    if (!manifest) {
      res.status(404).json({ error: "not-found" });
      return;
    }
    const run = runRepository.create({
      id: randomUUID(),
      manifestId: manifest.id,
      steps: PIPELINE_STEPS.map((name) => ({
        name,
        status: "pending" as const,
        startedAt: null,
        finishedAt: null,
        detail: null,
        attempt: 0,
      })),
    });
    res.status(201).json(run);
    startRun(run.id);
  });

  router.get("/runs/:id", (req, res) => {
    const run = runRepository.findById(req.params.id);
    if (!run) {
      res.status(404).json({ error: "not-found" });
      return;
    }
    res.json(run);
  });

  router.get("/runs/:id/logs", (req, res) => {
    const run = runRepository.findById(req.params.id);
    if (!run) {
      res.status(404).json({ error: "not-found" });
      return;
    }
    res.json(logRepository.listForRun(run.id));
  });

  // ----- Live events (SSE) -----

  router.get("/runs/:id/events", (req, res) => {
    const run = runRepository.findById(req.params.id);
    if (!run) {
      res.status(404).json({ error: "not-found" });
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    sseHub.subscribe(run.id, res);
    res.write(
      `data: ${JSON.stringify({ type: "status", runId: run.id, status: run.status })}\n\n`,
    );

    const heartbeat = setInterval(() => res.write(`: ping\n\n`), 15000);
    res.on("close", () => clearInterval(heartbeat));
  });

  // ----- Meta -----

  router.get("/meta", (_req, res) => {
    res.json({
      platformLabel: provider.platformLabel,
      note: "Mock provider — no cloud account required",
    });
  });

  return router;
}

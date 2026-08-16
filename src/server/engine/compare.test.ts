import test from "node:test";
import assert from "node:assert/strict";
import type { ResourceSpec } from "../../shared/types.js";
import { buildReport, compareResource } from "./compare.js";
import type { LiveResource } from "./provider.js";

const serverSpec: ResourceSpec = {
  name: "payments-api",
  kind: "server",
  strategy: "notify",
  config: { cpu: 2, memory: 4096, instances: 3 },
};

const matchingLive: LiveResource = {
  name: "payments-api",
  kind: "server",
  config: { cpu: 2, memory: 4096, instances: 3 },
};

test("clean resource: no fields differ", () => {
  const result = compareResource(serverSpec, matchingLive);
  assert.equal(result.status, "clean");
  assert.equal(result.fields.length, 0);
  assert.equal(result.driftKind, "missing");
});

test("field-changed: detects changed scalar and severity", () => {
  const live: LiveResource = {
    name: "payments-api",
    kind: "server",
    config: { cpu: 4, memory: 4096, instances: 3 },
  };
  const result = compareResource(serverSpec, live);
  assert.equal(result.status, "drifted");
  assert.equal(result.driftKind, "field-changed");
  assert.equal(result.fields.length, 1);
  assert.equal(result.fields[0].path, "config.cpu");
  assert.equal(result.fields[0].expected, 2);
  assert.equal(result.fields[0].actual, 4);
  assert.equal(result.fields[0].severity, "high");
});

test("boolean false vs missing are real differences", () => {
  const spec: ResourceSpec = {
    name: "x",
    kind: "server",
    strategy: "notify",
    config: { tls: false },
  };
  const live: LiveResource = { name: "x", kind: "server", config: {} };
  const result = compareResource(spec, live);
  assert.equal(result.status, "drifted");
  assert.equal(result.fields[0].path, "config.tls");
  assert.equal(result.fields[0].actual, undefined);
});

test("unexpected live fields are flagged", () => {
  const live: LiveResource = {
    name: "payments-api",
    kind: "server",
    config: { cpu: 2, memory: 4096, instances: 3, untrackedTag: "v1" },
  };
  const result = compareResource(serverSpec, live);
  assert.equal(result.status, "drifted");
  assert.equal(result.fields[0].path, "config.untrackedTag");
});

test("buildReport: missing live resource is drifted", () => {
  const report = buildReport([serverSpec], [], "staging");
  assert.equal(report.summary.resourceCount, 1);
  assert.equal(report.summary.cleanCount, 0);
  assert.equal(report.summary.driftedCount, 1);
  assert.equal(report.resources[0].driftKind, "missing");
});

test("buildReport: full happy path with mixed state", () => {
  const cleanDb: ResourceSpec = {
    name: "orders-db",
    kind: "database",
    strategy: "reconcile",
    config: { tls: true, replicas: 2 },
  };
  const liveDb: LiveResource = {
    name: "orders-db",
    kind: "database",
    config: { tls: false, replicas: 1 },
  };
  const report = buildReport(
    [serverSpec, cleanDb],
    [matchingLive, liveDb],
    "production",
  );
  assert.equal(report.summary.cleanCount, 1);
  assert.equal(report.summary.driftedCount, 1);
  assert.equal(report.summary.criticalCount, 1, "tls drift should be critical");
});

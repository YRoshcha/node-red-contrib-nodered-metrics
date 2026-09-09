"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const packageJson = require("../package.json");

test("package declares its supported Node-RED version", () => {
  assert.equal(packageJson["node-red"].version, ">=3.0.0");
});

test("package provides an importable MongoDB duration example", () => {
  const examplePath = path.join(root, "examples", "mongo-query-duration.json");
  const nodes = JSON.parse(fs.readFileSync(examplePath, "utf8"));
  const metric = nodes.find((node) => node.type === "nodered-metric");
  const config = nodes.find((node) => node.type === "nodered-metric-config");
  assert.ok(metric);
  assert.equal(metric.operation, "observe");
  assert.equal(metric.durationType, "msg");
  assert.deepEqual(metric.labels, [
    { name: "collection", value: "collection", valueType: "msg" },
    { name: "operation", value: "operation", valueType: "msg" }
  ]);
  assert.ok(config);
  assert.match(config.metricName, /_seconds$/);
});

test("package provides a bounded Redis Streams consumer-group metrics flow", () => {
  const examplePath = path.join(root, "examples", "redis-stream-consumer-groups-metrics.json");
  const nodes = JSON.parse(fs.readFileSync(examplePath, "utf8"));
  const collector = nodes.find((node) => node.type === "yroshcha-redis-stream-metrics");
  const delay = nodes.find((node) => node.type === "delay");
  const normalizer = nodes.find((node) => node.id === "rsmetrics-normalize");
  const inventoryBuilder = nodes.find((node) => node.id === "rsmetrics-build-manual");
  const configs = nodes.filter((node) => node.type === "nodered-metric-config");

  assert.ok(collector);
  assert.equal(collector.streamKey, "__dynamic__");
  assert.equal(collector.group, "__dynamic__");
  assert.ok(delay);
  assert.equal(delay.pauseType, "rate");
  assert.equal(delay.drop, false);
  assert.equal(normalizer.outputs, 12);
  assert.ok(inventoryBuilder);
  assert.match(inventoryBuilder.func, /REDIS_STREAM_GROUPS_JSON/);
  assert.equal(configs.length, 13);
  assert.ok(configs.some((node) => node.metricName === "nodered_redis_stream_consumer_group_pending_messages"));
  assert.ok(configs.some((node) => node.metricName === "nodered_redis_stream_consumer_group_collection_errors_total"));
  assert.ok(configs.every((node) => node.labelNames === "redis_target,stream,consumer_group"));
});

test("package provides an importable Grafana Redis Streams dashboard", () => {
  const dashboardPath = path.join(root, "examples", "redis-stream-consumer-groups-grafana-dashboard.json");
  const dashboard = JSON.parse(fs.readFileSync(dashboardPath, "utf8"));
  const datasource = dashboard.templating.list.find((variable) => variable.name === "datasource");

  assert.equal(dashboard.title, "Node-RED | Redis Streams Consumer Groups");
  assert.equal(dashboard.refresh, "10m");
  assert.equal(datasource.current.value, "mimir");
  assert.ok(dashboard.panels.length >= 10);
  assert.ok(dashboard.panels.some((panel) => panel.title === "Group Health Matrix"));
  assert.ok(dashboard.panels.every((panel) => !panel.targets || panel.targets.every((target) => target.datasource.uid === "$datasource")));
});

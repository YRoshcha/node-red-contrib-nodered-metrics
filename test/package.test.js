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

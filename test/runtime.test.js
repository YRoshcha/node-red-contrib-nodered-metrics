"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const promClient = require("prom-client");
const registerRuntime = require("../nodes/nodered-metrics");

function createRed() {
  promClient.register.clear();
  const types = {}, instances = {}, routes = [];
  const RED = {
    nodes: {
      registerType(name, constructor) { types[name] = constructor; },
      createNode(node, config) {
        Object.assign(node, { id: config.id || Math.random().toString(16), z: config.z || "flow-1", name: config.name || "", warnings: [] });
        node.warn = (message) => node.warnings.push(message);
        node.error = () => {};
        node.on = (event, handler) => { node[`on_${event}`] = handler; };
        node.send = () => {};
      },
      getNode(id) { return instances[id] || (id === "flow-1" ? { label: "Test flow" } : null); }
    },
    util: { evaluateNodeProperty(value, type, _node, msg) { return type === "num" ? Number(value) : type === "msg" ? msg[value] : value; } },
    httpNode: { _router: { stack: routes }, get(path, handler) { routes.push({ route: { path, methods: { get: true }, stack: [{ handle: handler }] } }); } }
  };
  registerRuntime(RED);
  return { types, instances, routes };
}

function sendInput(node, msg) {
  const messages = [];
  let doneError;
  node.on_input(msg, (output) => messages.push(output), (error) => { doneError = error; });
  assert.equal(doneError, undefined);
  return messages;
}

test("counter writes labels, companion duration, and passes msg through", async () => {
  const { types, instances } = createRed();
  const config = new types["nodered-metric-config"]({ id: "requests", metricType: "counter", metricName: "nodered_requests_total", labelNames: "step,status,process", withDuration: true });
  instances.requests = config;
  const writer = new types["nodered-metric"]({ id: "writer", name: "HTTP request", metric: "requests", operation: "inc", autoStep: true, status: "success", statusType: "str", value: "2", valueType: "num" });
  const message = { payload: "unchanged" };
  assert.deepEqual(sendInput(writer, message), [message]);
  assert.deepEqual((await config.metric.get()).values, [{ value: 2, labels: { step: "HTTP request", status: "success", process: "Test flow" } }]);
  const durationWriter = new types["nodered-metric"]({ id: "duration", name: "HTTP request", metric: "requests", operation: "observe", autoStep: true, status: "success", statusType: "str", duration: "250", durationType: "num", durationUnit: "ms" });
  sendInput(durationWriter, {});
  assert.equal((await config.durationMetric.get()).values.find((value) => value.metricName.endsWith("_sum")).value, 0.25);
});

test("invalid label pattern warns once and skips the write", () => {
  const { types, instances } = createRed();
  const config = new types["nodered-metric-config"]({ id: "metric", metricType: "gauge", metricName: "nodered_queue_depth", labelNames: "required" });
  instances.metric = config;
  const writer = new types["nodered-metric"]({ id: "writer", metric: "metric", operation: "set", value: "1", valueType: "num", labels: [{ name: "unexpected", value: "x", valueType: "str" }] });
  sendInput(writer, {}); sendInput(writer, {});
  assert.equal(writer.warnings.length, 1);
  assert.match(writer.warnings[0], /ignored extra.*missing/);
});

test("label drift retains the registered metric and warns", async () => {
  const { types } = createRed();
  const first = new types["nodered-metric-config"]({ id: "first", metricType: "counter", metricName: "nodered_jobs_total", labelNames: "status" });
  const second = new types["nodered-metric-config"]({ id: "second", metricType: "counter", metricName: "nodered_jobs_total", labelNames: "result" });
  assert.equal(second.metric, first.metric);
  assert.equal(second.warnings.length, 1);
  assert.match(second.warnings[0], /restart Node-RED/);
  assert.equal((await second.metric.get()).name, "nodered_jobs_total");
});

test("metric type and histogram bucket drift retain the existing schema and warn", () => {
  const { types } = createRed();
  const counter = new types["nodered-metric-config"]({ id: "counter", metricType: "counter", metricName: "nodered_schema_total" });
  const gauge = new types["nodered-metric-config"]({ id: "gauge", metricType: "gauge", metricName: "nodered_schema_total" });
  assert.equal(gauge.metric, counter.metric);
  assert.match(gauge.warnings[0], /type counter, not gauge/);

  const histogram = new types["nodered-metric-config"]({ id: "histogram", metricType: "histogram", metricName: "nodered_duration_seconds", buckets: "0.1,1" });
  const changedHistogram = new types["nodered-metric-config"]({ id: "changed", metricType: "histogram", metricName: "nodered_duration_seconds", buckets: "0.5,5" });
  assert.equal(changedHistogram.metric, histogram.metric);
  assert.match(changedHistogram.warnings[0], /different buckets/);
});

test("invalid metric definitions warn without throwing during startup", () => {
  const { types } = createRed();
  const invalidName = new types["nodered-metric-config"]({ id: "invalid-name", metricType: "gauge", metricName: "9invalid" });
  const duplicateLabel = new types["nodered-metric-config"]({ id: "duplicate-label", metricType: "gauge", metricName: "nodered_valid_gauge", labelNames: "route,route" });
  assert.equal(invalidName.metric, null);
  assert.match(invalidName.warnings[0], /invalid Prometheus name/);
  assert.equal(duplicateLabel.metric, null);
  assert.match(duplicateLabel.warnings[0], /more than once/);
});

test("default metrics are restored when the Prometheus registry is recreated", () => {
  const prefix = "nodered_test_defaults_";
  let setup = createRed();
  new setup.types["nodered-metric-config"]({ id: "defaults-one", metricType: "default-metrics", prefix });
  assert.ok(promClient.register.getSingleMetric(`${prefix}process_cpu_user_seconds_total`));

  setup = createRed();
  new setup.types["nodered-metric-config"]({ id: "defaults-two", metricType: "default-metrics", prefix });
  assert.ok(promClient.register.getSingleMetric(`${prefix}process_cpu_user_seconds_total`));
});

test("exporter route is registered and removed on close", () => {
  const { types, routes } = createRed();
  const exporter = new types["nodered-metrics-exporter"]({ id: "exporter", path: "/nodeRedMetrics" });
  assert.equal(routes.length, 1);
  exporter.on_close(false, () => {});
  assert.equal(routes.length, 0);
});

test("exporter normalizes its path and prevents duplicate endpoints", () => {
  const { types, routes } = createRed();
  const first = new types["nodered-metrics-exporter"]({ id: "first", path: "nodeRedMetrics" });
  const duplicate = new types["nodered-metrics-exporter"]({ id: "duplicate", path: "/nodeRedMetrics" });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].route.path, "/nodeRedMetrics");
  assert.match(duplicate.warnings[0], /already configured/);
  first.on_close(false, () => {});
  const replacement = new types["nodered-metrics-exporter"]({ id: "replacement", path: "/nodeRedMetrics" });
  assert.equal(routes.length, 1);
  replacement.on_close(false, () => {});
});

test("metric writer accepts legacy prometheus exporter payloads", async () => {
  const { types, instances } = createRed();
  const config = new types["nodered-metric-config"]({ id: "legacy", metricType: "gauge", metricName: "nodered_legacy_gauge", labelNames: "event" });
  instances.legacy = config;
  const writer = new types["nodered-metric"]({ id: "legacy-writer", metric: "legacy" });
  const message = { payload: { op: "set", val: 7, labels: { event: "ok" } } };
  assert.deepEqual(sendInput(writer, message), [message]);
  assert.deepEqual((await config.metric.get()).values, [{ value: 7, labels: { event: "ok" } }]);
});

test("legacy observe payload records its payload value in seconds", async () => {
  const { types, instances } = createRed();
  const config = new types["nodered-metric-config"]({ id: "legacy-duration", metricType: "histogram", metricName: "nodered_legacy_duration_seconds" });
  instances["legacy-duration"] = config;
  const writer = new types["nodered-metric"]({ id: "legacy-duration-writer", metric: "legacy-duration", duration: "999", durationType: "num", durationUnit: "ms" });
  sendInput(writer, { payload: { op: "observe", val: 0.42 } });
  assert.equal((await config.metric.get()).values.find((entry) => entry.metricName.endsWith("_sum")).value, 0.42);
});

test("ordinary payload fields cannot override the configured write", async () => {
  const { types, instances } = createRed();
  const config = new types["nodered-metric-config"]({ id: "safe", metricType: "gauge", metricName: "nodered_safe_gauge", labelNames: "event" });
  instances.safe = config;
  const writer = new types["nodered-metric"]({
    id: "safe-writer", metric: "safe", operation: "set", value: "3", valueType: "num",
    labels: [{ name: "event", value: "configured", valueType: "str" }]
  });
  sendInput(writer, { payload: { op: "inc", labels: { event: "unexpected" } } });
  assert.deepEqual((await config.metric.get()).values, [{ value: 3, labels: { event: "configured" } }]);
});

test("writer resolves msg label values, rejects missing values, and always passes the message through", async () => {
  const { types, instances } = createRed();
  const config = new types["nodered-metric-config"]({ id: "mongo", metricType: "histogram", metricName: "nodered_mongo_duration_seconds", labelNames: "collection,operation" });
  instances.mongo = config;
  const writer = new types["nodered-metric"]({
    id: "mongo-writer", metric: "mongo", operation: "observe", duration: "duration", durationType: "msg", durationUnit: "ms",
    labels: [
      { name: "collection", value: "collection", valueType: "msg" },
      { name: "operation", value: "operation", valueType: "msg" }
    ]
  });
  const complete = { collection: "orders", operation: "find", duration: 125 };
  assert.deepEqual(sendInput(writer, complete), [complete]);
  assert.equal((await config.metric.get()).values.find((entry) => entry.metricName.endsWith("_sum")).value, 0.125);
  const incomplete = { collection: "orders", duration: 10 };
  assert.deepEqual(sendInput(writer, incomplete), [incomplete]);
  assert.match(writer.warnings.at(-1), /missing \[operation\]/);
});

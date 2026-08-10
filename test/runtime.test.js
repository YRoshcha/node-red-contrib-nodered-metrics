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

test("exporter route is registered and removed on close", () => {
  const { types, routes } = createRed();
  const exporter = new types["nodered-metrics-exporter"]({ id: "exporter", path: "/nodeRedMetrics" });
  assert.equal(routes.length, 1);
  exporter.on_close(false, () => {});
  assert.equal(routes.length, 0);
});

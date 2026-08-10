"use strict";

const promClient = require("prom-client");
const register = promClient.register;
const defaultMetricPrefixes = new Set();

function list(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function buckets(value) {
  return list(value).map(Number).filter(Number.isFinite);
}

function sameLabels(metric, names) {
  return JSON.stringify(metric.labelNames || []) === JSON.stringify(names);
}

function metricFromRegister(name) {
  return register.getSingleMetric(name);
}

function warnDrift(node, name, current, requested) {
  node.warn(
    `Metric \"${name}\" already exists with labels [${(current.labelNames || []).join(", ")}], ` +
    `not [${requested.join(", ")}]. The existing metric is retained; restart Node-RED to apply label changes.`
  );
}

function createMetric(node, kind, options) {
  const existing = metricFromRegister(options.name);
  if (existing) {
    if (!sameLabels(existing, options.labelNames)) warnDrift(node, options.name, existing, options.labelNames);
    return existing;
  }
  const Constructor = kind === "counter" ? promClient.Counter : kind === "histogram" ? promClient.Histogram : promClient.Gauge;
  return new Constructor({ ...options, registers: [register] });
}

function typedValue(RED, node, value, type, msg) {
  try {
    return RED.util.evaluateNodeProperty(value, type || "str", node, msg);
  } catch (error) {
    node.warn(`Could not evaluate metric value: ${error.message}`);
    return undefined;
  }
}

function removeRoute(RED, path, handler) {
  const router = RED.httpNode && (RED.httpNode._router || RED.httpNode.router);
  if (!router || !Array.isArray(router.stack)) return;
  for (let index = router.stack.length - 1; index >= 0; index -= 1) {
    const layer = router.stack[index];
    if (!layer.route || layer.route.path !== path || !layer.route.methods.get) continue;
    if (layer.route.stack.some((routeLayer) => routeLayer.handle === handler)) router.stack.splice(index, 1);
  }
}

module.exports = function (RED) {
  function MetricConfig(config) {
    RED.nodes.createNode(this, config);
    this.metricType = config.metricType;
    this.metricName = String(config.metricName || "").trim();
    this.labelNames = list(config.labelNames);
    this.metric = null;
    this.durationMetric = null;

    if (this.metricType === "default-metrics") {
      const prefix = config.prefix === undefined || config.prefix === "" ? "nodered_" : config.prefix;
      if (!defaultMetricPrefixes.has(prefix)) {
        promClient.collectDefaultMetrics({ register, prefix, labels: { host: process.env.HOSTNAME || "unknown" } });
        defaultMetricPrefixes.add(prefix);
      }
      return;
    }
    if (!this.metricName) {
      this.warn("Metric configuration has no metric name.");
      return;
    }
    const options = {
      name: this.metricName,
      help: String(config.help || this.metricName),
      labelNames: this.labelNames
    };
    if (this.metricType === "histogram") {
      const configuredBuckets = buckets(config.buckets);
      if (configuredBuckets.length) options.buckets = configuredBuckets;
    }
    this.metric = createMetric(this, this.metricType, options);
    if (this.metricType === "counter" && config.withDuration) {
      const durationName = `${this.metricName.replace(/_total$/, "")}_duration_seconds`;
      this.durationMetric = createMetric(this, "histogram", {
        name: durationName,
        help: `${options.help} duration in seconds`,
        labelNames: this.labelNames
      });
    }
  }
  RED.nodes.registerType("nodered-metric-config", MetricConfig);

  function MetricNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const warned = new Set();
    const autoStep = config.autoStep !== false;

    function warnOnce(key, message) {
      if (warned.has(key)) return;
      warned.add(key);
      node.warn(message);
    }
    function flowName() {
      const flow = RED.nodes.getNode(node.z);
      return (flow && (flow.label || flow.name)) || node.z || "unknown";
    }
    node.on("input", (msg, send, done) => {
      send = send || node.send.bind(node);
      try {
        const metricConfig = RED.nodes.getNode(config.metric);
        if (!metricConfig || !metricConfig.metric) {
          warnOnce(`unavailable:${config.metric}`, "Metric configuration is not ready; metric write was skipped.");
          send(msg); done(); return;
        }
        const expected = metricConfig.labelNames || [];
        const labels = {};
        if (expected.includes("step")) labels.step = autoStep ? (node.name || node.id) : typedValue(RED, node, config.step, config.stepType, msg);
        if (expected.includes("status")) labels.status = typedValue(RED, node, config.status || "success", config.statusType || "str", msg);
        if (expected.includes("process")) labels.process = flowName();
        for (const row of Array.isArray(config.labels) ? config.labels : []) {
          if (row && row.name) labels[row.name] = typedValue(RED, node, row.value, row.valueType || "str", msg);
        }
        const supplied = Object.keys(labels).filter((key) => labels[key] !== undefined);
        const extra = supplied.filter((key) => !expected.includes(key));
        const missing = expected.filter((key) => !supplied.includes(key));
        const signature = `${metricConfig.metricName}|${extra.sort().join(",")}|${missing.sort().join(",")}`;
        if (extra.length || missing.length) {
          warnOnce(signature, `Metric \"${metricConfig.metricName}\" labels do not match its configuration: ` +
            `${extra.length ? `ignored extra [${extra.join(", ")}]` : ""}${extra.length && missing.length ? "; " : ""}` +
            `${missing.length ? `missing [${missing.join(", ")}]` : ""}.`);
        }
        if (missing.length) { send(msg); done(); return; }
        const finalLabels = Object.fromEntries(expected.map((key) => [key, labels[key]]));
        const operation = config.operation || "inc";
        let target = metricConfig.metric;
        let value;
        if (operation === "observe") {
          target = metricConfig.metricType === "counter" ? metricConfig.durationMetric : metricConfig.metric;
          value = Number(typedValue(RED, node, config.duration, config.durationType || "num", msg));
          if (config.durationUnit === "ms") value /= 1000;
        } else {
          value = Number(typedValue(RED, node, config.value === undefined ? "1" : config.value, config.valueType || "num", msg));
        }
        if (!target || !Number.isFinite(value)) {
          warnOnce(`${metricConfig.metricName}:${operation}:invalid`, "Metric value or operation is invalid; metric write was skipped.");
        } else if (operation === "inc" && typeof target.inc === "function") target.inc(finalLabels, value);
        else if (operation === "set" && typeof target.set === "function") target.set(finalLabels, value);
        else if (operation === "observe" && typeof target.observe === "function") target.observe(finalLabels, value);
        else warnOnce(`${metricConfig.metricName}:${operation}:type`, `Operation \"${operation}\" is incompatible with metric \"${metricConfig.metricName}\".`);
        send(msg); done();
      } catch (error) {
        node.warn(`Metric write failed: ${error.message}`);
        send(msg); done();
      }
    });
  }
  RED.nodes.registerType("nodered-metric", MetricNode);

  function ExporterNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const path = String(config.path || "/nodeRedMetrics").trim();
    const handler = async (_req, res) => {
      try {
        res.set("Content-Type", register.contentType);
        res.send(await register.metrics());
      } catch (error) {
        node.error(`Could not export metrics: ${error.message}`);
        res.status(500).send("Could not export metrics");
      }
    };
    RED.httpNode.get(path, handler);
    node.on("close", (_removed, done) => { removeRoute(RED, path, handler); done(); });
  }
  RED.nodes.registerType("nodered-metrics-exporter", ExporterNode);
};

"use strict";

const promClient = require("prom-client");
const register = promClient.register;
const defaultMetricPrefixes = new Set();
const exporterPaths = new Map();
const METRIC_NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const METRIC_TYPES = new Set(["counter", "histogram", "gauge"]);
const OPERATIONS = new Set(["inc", "dec", "set", "observe"]);

function list(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function buckets(value) {
  return list(value).map(Number).filter(Number.isFinite);
}

function sameLabels(metric, names) {
  return JSON.stringify(metric.labelNames || []) === JSON.stringify(names);
}

function sameBuckets(metric, configuredBuckets) {
  if (!configuredBuckets || !configuredBuckets.length) return true;
  return JSON.stringify(metric.upperBounds || []) === JSON.stringify(configuredBuckets);
}

function metricFromRegister(name) {
  return register.getSingleMetric(name);
}

function warnDrift(node, name, current, kind, options) {
  const differences = [];
  if (current.type !== kind) differences.push(`type ${current.type}, not ${kind}`);
  if (!sameLabels(current, options.labelNames)) {
    differences.push(`labels [${(current.labelNames || []).join(", ")}], not [${options.labelNames.join(", ")}]`);
  }
  if (kind === "histogram" && !sameBuckets(current, options.buckets)) differences.push("different buckets");
  if (differences.length) {
    node.warn(
      `Metric \"${name}\" already exists with ${differences.join("; ")}. ` +
      "The existing metric is retained; restart Node-RED to apply its schema changes."
    );
  }
}

function createMetric(node, kind, options) {
  const existing = metricFromRegister(options.name);
  if (existing) {
    warnDrift(node, options.name, existing, kind, options);
    return existing;
  }
  const Constructor = kind === "counter" ? promClient.Counter : kind === "histogram" ? promClient.Histogram : promClient.Gauge;
  return new Constructor({ ...options, registers: [register] });
}

function configurationError(metricName, metricType, labelNames) {
  if (!METRIC_TYPES.has(metricType)) return `Unsupported metric type \"${metricType}\".`;
  if (!METRIC_NAME_PATTERN.test(metricName)) return `Metric \"${metricName}\" has an invalid Prometheus name.`;
  const invalid = labelNames.find((name) => !LABEL_NAME_PATTERN.test(name));
  if (invalid) return `Label \"${invalid}\" has an invalid Prometheus name.`;
  const duplicate = labelNames.find((name, index) => labelNames.indexOf(name) !== index);
  if (duplicate) return `Label \"${duplicate}\" is declared more than once.`;
  return null;
}

function legacyMetricPayload(msg) {
  const payload = msg && msg.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (typeof payload.op !== "string" || !Object.prototype.hasOwnProperty.call(payload, "val")) return null;
  return OPERATIONS.has(payload.op) ? payload : null;
}

function endpointPath(value) {
  const path = String(value || "/nodeRedMetrics").trim();
  return path.startsWith("/") ? path : `/${path}`;
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
      const sentinel = `${prefix}process_cpu_user_seconds_total`;
      if (!defaultMetricPrefixes.has(prefix) || !metricFromRegister(sentinel)) {
        try {
          promClient.collectDefaultMetrics({ register, prefix, labels: { host: process.env.HOSTNAME || "unknown" } });
          defaultMetricPrefixes.add(prefix);
        } catch (error) {
          this.warn(`Could not create default metrics: ${error.message}`);
        }
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
    const error = configurationError(this.metricName, this.metricType, this.labelNames);
    if (error) {
      this.warn(error);
      return;
    }
    if (this.metricType === "histogram") {
      const configuredBuckets = buckets(config.buckets);
      if (configuredBuckets.length) options.buckets = configuredBuckets;
    }
    try {
      this.metric = createMetric(this, this.metricType, options);
      if (this.metricType === "counter" && config.withDuration) {
        const durationName = `${this.metricName.replace(/_total$/, "")}_duration_seconds`;
        this.durationMetric = createMetric(this, "histogram", {
          name: durationName,
          help: `${options.help} duration in seconds`,
          labelNames: this.labelNames
        });
      }
    } catch (error) {
      this.metric = null;
      this.durationMetric = null;
      this.warn(`Could not create metric \"${this.metricName}\": ${error.message}`);
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
        // Keep compatibility with node-red-contrib-prometheus-exporter flows.
        // That palette sends { op, val, labels } in msg.payload to its output node.
        const legacyPayload = legacyMetricPayload(msg);
        const legacyLabels = legacyPayload && (legacyPayload.labels || legacyPayload.Labels);
        if (legacyLabels && typeof legacyLabels === "object" && !Array.isArray(legacyLabels)) {
          for (const [key, value] of Object.entries(legacyLabels)) labels[key] = value;
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
        const operation = legacyPayload
          ? legacyPayload.op
          : (config.operation || "inc");
        let target = metricConfig.metric;
        let value;
        if (operation === "observe") {
          target = metricConfig.metricType === "counter" ? metricConfig.durationMetric : metricConfig.metric;
          value = legacyPayload
            ? Number(legacyPayload.val)
            : Number(typedValue(RED, node, config.duration, config.durationType || "num", msg));
          if (!legacyPayload && config.durationUnit === "ms") value /= 1000;
        } else {
          value = legacyPayload && legacyPayload.val !== undefined
            ? Number(legacyPayload.val)
            : Number(typedValue(RED, node, config.value === undefined ? "1" : config.value, config.valueType || "num", msg));
        }
        if (!target || !Number.isFinite(value)) {
          warnOnce(`${metricConfig.metricName}:${operation}:invalid`, "Metric value or operation is invalid; metric write was skipped.");
        } else if (operation === "inc" && typeof target.inc === "function") target.inc(finalLabels, value);
        else if (operation === "dec" && typeof target.dec === "function") target.dec(finalLabels, value);
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
    const path = endpointPath(config.path);
    if (exporterPaths.has(path)) {
      node.warn(`Metrics endpoint \"${path}\" is already configured. This exporter was not started.`);
      return;
    }
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
    exporterPaths.set(path, handler);
    node.on("close", (_removed, done) => {
      removeRoute(RED, path, handler);
      exporterPaths.delete(path);
      done();
    });
  }
  RED.nodes.registerType("nodered-metrics-exporter", ExporterNode);
};

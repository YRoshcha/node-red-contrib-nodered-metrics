# node-red-contrib-nodered-metrics

Prometheus metrics for Node-RED. Metric config nodes are constructed before the flow nodes that write to them, eliminating the startup race caused by Function-node initialisation with `global.get('metrics')`.

Українська документація: [README.uk.md](README.uk.md).

## Installation

Install the package from the Node-RED user directory, then restart Node-RED:

```bash
npm install @yroshcha/node-red-contrib-nodered-metrics
```

The **metrics** palette category provides the **metric** and **metrics exporter** workspace nodes. Create metric configurations from the `metric` node's Metric selector.

## Quick start

1. Add a **metric** node between an `inject` and a `debug` node.
2. Click `+` beside **Metric** to create a configuration.
3. Choose **Counter**, set **Prometheus name** to `nodered_events_total`, and set **Label names** to `step,status,process`.
4. In the `metric` node, select **Increment counter**, enable **Use node name as step**, and give the node a name such as `Kafka consume`.
5. Add a **metrics exporter** node with path `/nodeRedMetrics` and Deploy.

After a few messages, `http://<host>:<port>/nodeRedMetrics` includes:

```prometheus
nodered_events_total{step="Kafka consume",status="success",process="Main flow"} 3
```

## Node reference

### Metric configuration

This is a config node; it is selected by writers and is not placed on the workspace.

| Field | Purpose |
|---|---|
| **Display name** | Editor-only name. |
| **Metric type** | `Counter`, `Histogram`, `Gauge`, or `Default metrics`. |
| **Prometheus name** | Published Prometheus name. Use the `nodered_` prefix. |
| **Description** | Prometheus help text; defaults to the metric name. |
| **Label names** | Comma-separated schema, e.g. `step,status,process`. |
| **Buckets** | Histogram thresholds in seconds, e.g. `0.1,0.5,1,5`. |

**Counter** is for monotonically increasing values such as processed messages and failures. Names should end in `_total`. Enable **Also track duration** to create a companion `<name>_duration_seconds` Histogram with the same labels.

**Histogram** is for durations and distributions. Use **Observe duration** to record values. Bucket thresholds are always seconds.

**Gauge** is for current values that can increase or decrease, for example queue depth, active jobs, or available balance. Use **Set gauge** to record it.

**Default metrics** collects Node.js process metrics (memory, CPU, event loop). It uses the `nodered_` prefix by default and adds a `host` label from `HOSTNAME`. Add it once per Node-RED process.

### Metric

The workspace writer node. It records a side effect then passes the original `msg` through unchanged. Its canvas label shows the selected metric, for example `metric [events_in_queue]`.

Use the copy button beside **Metric** to duplicate the selected configuration. The copy retains its labels, buckets, and options, while receiving a distinct metric name with a `_copy` suffix; edit it before deploying if needed.

| Action | Use with | Value |
|---|---|---|
| **Increment counter** | Counter | **Value**, default `1` |
| **Observe duration** | Histogram or a Counter's companion duration Histogram | **Duration**, seconds or milliseconds |
| **Set gauge** | Gauge | **Value** |

Value fields are standard Node-RED typed inputs: number, `msg`, `flow`, `global`, or environment variable. To record `msg.durationMs`, choose `msg`, enter `durationMs`, and select the `ms` unit.

#### Labels

Declare every label in **Label names** before writing it.

- `step` defaults to the node's **Node name** when declared. Disable auto mode to supply a typed value.
- `status` defaults to `success` when declared.
- `process` is populated with the name of the flow tab containing the writer.
- **Extra labels** are additional static or dynamic values, such as `source = msg.source`.

Unknown labels are dropped and warned about once. If a required label is missing, the write is skipped safely and warned about once. Repeated warning patterns are deduplicated for high-throughput flows.

### Metrics exporter

Provides an HTTP endpoint for the current process registry. The default path is `/nodeRedMetrics`, chosen to avoid a conflict with palettes that use `/metrics`. The exporter has no input or output.

```yaml
scrape_configs:
  - job_name: node-red
    metrics_path: /nodeRedMetrics
    static_configs:
      - targets: ["node-red:1880"]
```

Do not deploy multiple exporter nodes with the same path in one process. Routes are cleaned up when an exporter is removed or redeployed.

## Operations and safety

### Per-instance registries

Every Node-RED process has an isolated Prometheus registry. Metrics from a dashboard, gateway, and worker are not combined automatically. Deploy the relevant configuration and exporter to each process that Prometheus must scrape.

### Avoid high-cardinality labels

Never use raw `user_id`, `order_id`, UUIDs, timestamps, IP addresses, or other unbounded values as label values. They create an unbounded number of time series and can severely degrade Prometheus.

Use bounded dimensions instead: `status=success|failed`, `source=kafka|http`, or a stable template-like string such as `${order_id}` rather than a live ID.

### Deploy behaviour

Normal Deploy does not reset Counter, Histogram, or Gauge values. Changing an existing metric's **Label names** is deliberately not applied on Deploy: the old metric stays active and a warning is emitted. Fully restart Node-RED to apply a label schema change.

## Common patterns

| Scenario | Type | Name | Action |
|---|---|---|---|
| Kafka messages processed | Counter | `nodered_kafka_messages_total` | Increment counter |
| HTTP request duration | Histogram | `nodered_http_request_duration_seconds` | Observe duration |
| Active jobs | Gauge | `nodered_active_jobs` | Set gauge |
| Pipeline run count and duration | Counter + duration | `nodered_pipeline_runs_total` | Increment / Observe |

## Troubleshooting

- **Metric is missing:** select a configuration, Deploy, and ensure at least one message has passed through the writer.
- **Label warning:** compare configuration Label names with `step`, `status`, `process`, and Extra labels.
- **Metric stopped after changing labels:** fully restart Node-RED.
- **Endpoint returns 404:** check the path and verify the exporter is deployed on the queried Node-RED process.

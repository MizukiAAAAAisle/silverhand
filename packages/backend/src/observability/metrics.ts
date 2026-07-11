import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { BackendDeploymentMode } from '../context.js';
import type { BackendLogger } from '../context.js';

const HTTP_DURATION_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

const DB_DURATION_BUCKETS_SECONDS = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
];

export type DbStatementOperation = 'run' | 'get' | 'all' | 'iterate';
export type DbStatementOutcome = 'ok' | 'busy' | 'locked' | 'error';
export type DaemonCommandOutcome = 'ok' | 'timeout' | 'disconnected' | 'error';

export class BackendMetrics {
  readonly registry = new Registry();

  private readonly httpRequestDuration: Histogram<
    'method' | 'route' | 'status_class' | 'deployment_mode'
  >;
  private readonly dbStatementDuration: Histogram<
    'query_name' | 'operation' | 'outcome' | 'deployment_mode'
  >;
  private readonly dbReadinessProbeDuration: Histogram<'outcome' | 'deployment_mode'>;
  private readonly hostWsConnections: Counter<'stage' | 'outcome' | 'deployment_mode'>;
  private readonly hostWsConnectionsCurrent: Gauge<'state' | 'deployment_mode'>;
  private readonly hostWsCloses: Counter<'code' | 'reason' | 'deployment_mode'>;
  private readonly hostWsReadyConnectionsCurrent: Gauge<'protocol_version' | 'deployment_mode'>;
  private readonly hostWsProtocolMismatches: Counter<
    'actual_version' | 'supported_version' | 'deployment_mode'
  >;
  private readonly daemonCommandDuration: Histogram<'command' | 'outcome' | 'deployment_mode'>;

  constructor(readonly deploymentMode: BackendDeploymentMode) {
    const defaultLabels = { deployment_mode: deploymentMode };
    this.registry.setDefaultLabels(defaultLabels);
    collectDefaultMetrics({
      register: this.registry,
      labels: defaultLabels,
      eventLoopMonitoringPrecision: 20,
    });

    this.httpRequestDuration = new Histogram({
      name: 'silverhand_http_request_duration_seconds',
      help: 'End-to-end HTTP request duration by normalized route.',
      labelNames: ['method', 'route', 'status_class', 'deployment_mode'],
      buckets: HTTP_DURATION_BUCKETS_SECONDS,
      registers: [this.registry],
    });
    this.dbStatementDuration = new Histogram({
      name: 'silverhand_db_statement_duration_seconds',
      help: 'Named SQLite statement execution duration.',
      labelNames: ['query_name', 'operation', 'outcome', 'deployment_mode'],
      buckets: DB_DURATION_BUCKETS_SECONDS,
      registers: [this.registry],
    });
    this.dbReadinessProbeDuration = new Histogram({
      name: 'silverhand_db_readiness_probe_duration_seconds',
      help: 'Duration of the BEGIN IMMEDIATE readiness write probe.',
      labelNames: ['outcome', 'deployment_mode'],
      buckets: DB_DURATION_BUCKETS_SECONDS,
      registers: [this.registry],
    });
    this.hostWsConnections = new Counter({
      name: 'silverhand_host_ws_connections_total',
      help: 'Host websocket connection attempts and lifecycle gates.',
      labelNames: ['stage', 'outcome', 'deployment_mode'],
      registers: [this.registry],
    });
    this.hostWsConnectionsCurrent = new Gauge({
      name: 'silverhand_host_ws_connections_current',
      help: 'Current host websocket connections by lifecycle state.',
      labelNames: ['state', 'deployment_mode'],
      registers: [this.registry],
    });
    this.hostWsCloses = new Counter({
      name: 'silverhand_host_ws_closes_total',
      help: 'Host websocket closes with bounded close reason.',
      labelNames: ['code', 'reason', 'deployment_mode'],
      registers: [this.registry],
    });
    this.hostWsReadyConnectionsCurrent = new Gauge({
      name: 'silverhand_host_ws_ready_connections_current',
      help: 'Current ready host websocket connections by protocol version.',
      labelNames: ['protocol_version', 'deployment_mode'],
      registers: [this.registry],
    });
    this.hostWsProtocolMismatches = new Counter({
      name: 'silverhand_host_ws_protocol_mismatch_total',
      help: 'Host ready frames rejected because their protocol is unsupported.',
      labelNames: ['actual_version', 'supported_version', 'deployment_mode'],
      registers: [this.registry],
    });
    this.daemonCommandDuration = new Histogram({
      name: 'silverhand_daemon_command_duration_seconds',
      help: 'Server-to-daemon command duration by command kind and outcome.',
      labelNames: ['command', 'outcome', 'deployment_mode'],
      buckets: HTTP_DURATION_BUCKETS_SECONDS,
      registers: [this.registry],
    });

    let previousElu = performance.eventLoopUtilization();
    new Gauge({
      name: 'silverhand_nodejs_event_loop_utilization_ratio',
      help: 'Node.js event loop utilization since the previous scrape.',
      labelNames: ['deployment_mode'],
      registers: [this.registry],
      collect() {
        const current = performance.eventLoopUtilization();
        const delta = performance.eventLoopUtilization(current, previousElu);
        previousElu = current;
        this.set(defaultLabels, delta.utilization);
      },
    });
  }

  observeHttpRequest(input: {
    method: string;
    route: string;
    status: number;
    elapsedMs: number;
  }): void {
    this.httpRequestDuration.observe(
      {
        method: input.method.toUpperCase(),
        route: input.route,
        status_class: statusClass(input.status),
        deployment_mode: this.deploymentMode,
      },
      input.elapsedMs / 1000,
    );
  }

  observeDbStatement(input: {
    queryName: string;
    operation: DbStatementOperation;
    outcome: DbStatementOutcome;
    elapsedMs: number;
  }): void {
    this.dbStatementDuration.observe(
      {
        query_name: input.queryName,
        operation: input.operation,
        outcome: input.outcome,
        deployment_mode: this.deploymentMode,
      },
      input.elapsedMs / 1000,
    );
  }

  observeReadinessProbe(outcome: 'ok' | 'busy' | 'locked' | 'error', elapsedMs: number): void {
    this.dbReadinessProbeDuration.observe(
      { outcome, deployment_mode: this.deploymentMode },
      elapsedMs / 1000,
    );
  }

  observeHostWsConnection(stage: 'upgrade' | 'ready', outcome: string): void {
    this.hostWsConnections.inc({
      stage,
      outcome,
      deployment_mode: this.deploymentMode,
    });
  }

  changeHostWsConnections(state: 'websocket_open', delta: 1 | -1): void {
    this.hostWsConnectionsCurrent.inc({ state, deployment_mode: this.deploymentMode }, delta);
  }

  observeHostWsClose(code: number, reason: string): void {
    this.hostWsCloses.inc({
      code: boundedWebSocketCloseCode(code),
      reason,
      deployment_mode: this.deploymentMode,
    });
  }

  changeHostWsReadyConnections(protocolVersion: string, delta: 1 | -1): void {
    this.hostWsReadyConnectionsCurrent.inc(
      {
        protocol_version: protocolVersion,
        deployment_mode: this.deploymentMode,
      },
      delta,
    );
  }

  observeHostWsProtocolMismatch(actualVersion: string, supportedVersion: string): void {
    this.hostWsProtocolMismatches.inc({
      actual_version: actualVersion,
      supported_version: supportedVersion,
      deployment_mode: this.deploymentMode,
    });
  }

  observeDaemonCommand(command: string, outcome: DaemonCommandOutcome, elapsedMs: number): void {
    this.daemonCommandDuration.observe(
      { command, outcome, deployment_mode: this.deploymentMode },
      elapsedMs / 1000,
    );
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }

  close(): void {
    this.registry.clear();
  }
}

function statusClass(status: number): string {
  if (!Number.isInteger(status) || status < 100 || status > 599) return 'unknown';
  return `${Math.floor(status / 100)}xx`;
}

function boundedWebSocketCloseCode(code: number): string {
  switch (code) {
    case 1000:
    case 1001:
    case 1002:
    case 1006:
    case 1008:
    case 1011:
      return String(code);
    default:
      return 'other';
  }
}

const EVENT_LOOP_HEALTH_INTERVAL_MS = 30_000;
const EVENT_LOOP_DELAY_WARN_MS = 250;
const EVENT_LOOP_UTILIZATION_WARN = 0.8;

/**
 * Low-noise operator warning that remains active even when Prometheus is not
 * configured. Requiring both high delay and high utilization avoids treating
 * machine sleep/background suspension as server load.
 */
export function startEventLoopHealthMonitor(logger: BackendLogger): () => void {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  let previousElu = performance.eventLoopUtilization();
  delay.enable();
  const timer = setInterval(() => {
    const currentElu = performance.eventLoopUtilization();
    const elu = performance.eventLoopUtilization(currentElu, previousElu);
    previousElu = currentElu;
    const p99Ms = delay.percentile(99) / 1e6;
    delay.reset();
    if (
      p99Ms >= EVENT_LOOP_DELAY_WARN_MS &&
      elu.utilization >= EVENT_LOOP_UTILIZATION_WARN
    ) {
      logger.warn(
        {
          p99Ms: Math.round(p99Ms * 10) / 10,
          utilization: Math.round(elu.utilization * 1_000) / 1_000,
          intervalMs: EVENT_LOOP_HEALTH_INTERVAL_MS,
          delayThresholdMs: EVENT_LOOP_DELAY_WARN_MS,
          utilizationThreshold: EVENT_LOOP_UTILIZATION_WARN,
        },
        'backend: sustained event loop pressure detected',
      );
    }
  }, EVENT_LOOP_HEALTH_INTERVAL_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    delay.disable();
  };
}

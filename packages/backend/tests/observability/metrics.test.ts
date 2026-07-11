import { afterEach, describe, expect, it } from 'vitest';
import { BackendMetrics } from '../../src/observability/metrics.js';
import {
  startMetricsServer,
  type RunningMetricsServer,
} from '../../src/observability/metrics-server.js';
import type { BackendLogger } from '../../src/context.js';

const logger: BackendLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('backend Prometheus metrics', () => {
  let running: RunningMetricsServer | null = null;
  let metrics: BackendMetrics | null = null;

  afterEach(async () => {
    await running?.close();
    metrics?.close();
    running = null;
    metrics = null;
  });

  it('renders normalized HTTP, SQLite, and daemon metrics on a private listener', async () => {
    metrics = new BackendMetrics('standalone');
    metrics.observeHttpRequest({
      method: 'get',
      route: '/api/hosts/:id/status',
      status: 200,
      elapsedMs: 125,
    });
    metrics.observeDbStatement({
      queryName: 'hosts.get_by_id',
      operation: 'get',
      outcome: 'ok',
      elapsedMs: 2.5,
    });
    metrics.observeDaemonCommand('host_status', 'timeout', 30_000);
    metrics.changeHostWsReadyConnections('6', 1);
    metrics.observeHostWsProtocolMismatch('5', '6');

    running = await startMetricsServer(metrics, { hostname: '127.0.0.1', port: 0 }, logger);
    const response = await fetch(`${running.url}/metrics`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('silverhand_http_request_duration_seconds_bucket');
    expect(body).toContain('route="/api/hosts/:id/status"');
    expect(body).toContain('status_class="2xx"');
    expect(body).toContain('query_name="hosts.get_by_id"');
    expect(body).toContain('command="host_status"');
    expect(body).toContain('outcome="timeout"');
    expect(body).toContain('protocol_version="6"');
    expect(body).toContain('actual_version="5"');
    expect(body).toContain('supported_version="6"');
    expect(body).toContain('silverhand_nodejs_event_loop_utilization_ratio');

    const notFound = await fetch(`${running.url}/not-public`);
    expect(notFound.status).toBe(404);
  });

  it('refuses a non-loopback metrics bind', async () => {
    metrics = new BackendMetrics('standalone');
    await expect(
      startMetricsServer(metrics, { hostname: '0.0.0.0', port: 0 }, logger),
    ).rejects.toThrow('loopback');
  });
});

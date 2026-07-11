import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { classifyBindAddressScope } from '@silverhand/shared';
import type { BackendLogger } from '../context.js';
import type { BackendMetrics } from './metrics.js';

export interface MetricsListenOptions {
  hostname: string;
  port: number;
}

export interface RunningMetricsServer {
  url: string;
  close(): Promise<void>;
}

export async function startMetricsServer(
  metrics: BackendMetrics,
  listen: MetricsListenOptions,
  logger: BackendLogger,
): Promise<RunningMetricsServer> {
  if (classifyBindAddressScope(listen.hostname) !== 'loopback') {
    throw new Error('metrics listener must bind to a loopback address');
  }

  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found\n');
      return;
    }
    void metrics.render().then(
      body => {
        res.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': metrics.registry.contentType,
        });
        res.end(body);
      },
      err => {
        logger.error({ err }, 'metrics: render failed');
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('metrics render failed\n');
      },
    );
  });

  const address = await listenServer(server, listen);
  const url = urlForListenAddress(listen.hostname, address.port);
  logger.info({ url }, 'metrics: listening on loopback');
  return {
    url,
    close: () => closeServer(server),
  };
}

function listenServer(server: Server, listen: MetricsListenOptions): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(listen.port, listen.hostname, () => {
      server.off('error', onError);
      resolve(server.address() as AddressInfo);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(err => (err ? reject(err) : resolve()));
    server.closeAllConnections();
  });
}

function urlForListenAddress(hostname: string, port: number): string {
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  return `http://${host}:${port}`;
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  RuntimeKindSchema,
  type RuntimeKind,
} from '@silverhand/shared';
import type { DaemonLogger } from './logger.js';

export const DaemonProxyConfigSchema = z
  .object({
    proxy_url: z.string().nullable().default(null),
    proxy_runtimes: z.array(RuntimeKindSchema).default([]),
  });

export type DaemonProxyConfig = z.infer<typeof DaemonProxyConfigSchema>;

export const EMPTY_DAEMON_PROXY_CONFIG: DaemonProxyConfig = Object.freeze({
  proxy_url: null,
  proxy_runtimes: [],
});

export function normalizeDaemonProxyConfig(input: unknown): DaemonProxyConfig {
  const parsed = DaemonProxyConfigSchema.parse(input);
  const proxy_runtimes = uniqueRuntimes(parsed.proxy_runtimes);
  return { proxy_url: parsed.proxy_url, proxy_runtimes };
}

export function readDaemonProxyConfig(
  path: string | null | undefined,
  logger?: Pick<DaemonLogger, 'warn'>,
): DaemonProxyConfig {
  if (!path) return { ...EMPTY_DAEMON_PROXY_CONFIG };
  try {
    const raw = readFileSync(path, 'utf8');
    return normalizeDaemonProxyConfig(JSON.parse(raw));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ...EMPTY_DAEMON_PROXY_CONFIG };
    logger?.warn(
      { err: err instanceof Error ? err.message : String(err), path },
      'daemon proxy config read failed; falling back to empty config',
    );
    return { ...EMPTY_DAEMON_PROXY_CONFIG };
  }
}

export function writeDaemonProxyConfig(
  path: string,
  input: DaemonProxyConfig,
): DaemonProxyConfig {
  const config = normalizeDaemonProxyConfig(input);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(tmp, path);
  return config;
}

function uniqueRuntimes(values: RuntimeKind[]): RuntimeKind[] {
  const out: RuntimeKind[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

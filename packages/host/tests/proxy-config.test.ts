import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readDaemonProxyConfig,
  writeDaemonProxyConfig,
} from '../src/daemon/proxy-config.js';

describe('daemon proxy config', () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function tempPath(): string {
    dir = mkdtempSync(join(tmpdir(), 'silverhand-host-proxy-'));
    return join(dir, 'daemon', 'proxy-config.json');
  }

  it('defaults to an empty config when no local file exists', () => {
    expect(readDaemonProxyConfig(null)).toEqual({
      proxy_url: null,
      proxy_runtimes: [],
    });
    expect(readDaemonProxyConfig(tempPath())).toEqual({
      proxy_url: null,
      proxy_runtimes: [],
    });
  });

  it('normalizes and persists daemon-local proxy config', () => {
    const path = tempPath();

    const written = writeDaemonProxyConfig(path, {
      proxy_url: '  http://127.0.0.1:7890  ',
      proxy_runtimes: ['codex', 'codex', 'claude'],
    });

    expect(written).toEqual({
      proxy_url: 'http://127.0.0.1:7890',
      proxy_runtimes: ['codex', 'claude'],
    });
    expect(readDaemonProxyConfig(path)).toEqual(written);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(written);
  });

  it('logs corrupt local config and falls back without crashing', () => {
    const path = tempPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ not json', 'utf8');
    const warnings: Array<{ obj: unknown; msg?: string }> = [];

    const config = readDaemonProxyConfig(path, {
      warn: (obj, msg) => warnings.push({ obj, msg }),
    });

    expect(config).toEqual({ proxy_url: null, proxy_runtimes: [] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toBe(
      'daemon proxy config read failed; falling back to empty config',
    );
  });
});

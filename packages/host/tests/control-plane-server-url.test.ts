import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDaemon, type RunningDaemon } from '../src/daemon/index.js';
import { FakeSupervisor } from './_helpers/fake-supervisor.js';
import { HostClient } from '../src/client/index.js';
import { computerProxyConfigPath } from '../src/daemon/computer-profile.js';
import {
  readDaemonProxyConfig,
  writeDaemonProxyConfig,
} from '../src/daemon/proxy-config.js';
import { writeHostConfigAtomic } from '../src/daemon/outbound-client.js';

describe('daemon control-plane URL resolution', () => {
  const daemons: RunningDaemon[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    while (daemons.length) {
      await daemons.pop()!.stop('test_done').catch(() => undefined);
    }
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('prefers the daemon-local HTTP origin over the embedded registry sentinel', async () => {
    const dir = mkdtempSync('/tmp/sh-cpu-');
    dirs.push(dir);
    const controlPlaneServerUrlPath = join(dir, 'control-plane-server-url');
    writeFileSync(controlPlaneServerUrlPath, 'http://127.0.0.1:58128/path-is-ignored\n');

    let controlPlaneServerUrl: (() => string | null) | undefined;
    const daemon = await runDaemon({
      socketPath: join(dir, 'daemon.sock'),
      workspaceDataRootDir: join(dir, 'workspace-data'),
      pidFilePath: join(dir, 'daemon.pid'),
      logDir: join(dir, 'logs'),
      runtimePidRootDir: join(dir, 'runtime-pids'),
      localOutboundSocketPath: join(dir, 'daemon-outbound.sock'),
      controlPlaneServerUrlPath,
      installSignals: false,
      writeStdoutHandshake: false,
      alsoStderr: false,
      supervisorFactory: deps => {
        controlPlaneServerUrl = deps.controlPlaneServerUrl;
        return new FakeSupervisor({ emit: deps.emit });
      },
    });
    daemons.push(daemon);

    if (!controlPlaneServerUrl) throw new Error('supervisorFactory was not called');
    expect(controlPlaneServerUrl()).toBe('http://127.0.0.1:58128');
  });

  it('does not expose local-embedded as an HTTP control-plane URL', async () => {
    const dir = mkdtempSync('/tmp/sh-cpu-');
    dirs.push(dir);

    let controlPlaneServerUrl: (() => string | null) | undefined;
    const daemon = await runDaemon({
      socketPath: join(dir, 'daemon.sock'),
      workspaceDataRootDir: join(dir, 'workspace-data'),
      pidFilePath: join(dir, 'daemon.pid'),
      logDir: join(dir, 'logs'),
      runtimePidRootDir: join(dir, 'runtime-pids'),
      localOutboundSocketPath: join(dir, 'daemon-outbound.sock'),
      installSignals: false,
      writeStdoutHandshake: false,
      alsoStderr: false,
      supervisorFactory: deps => {
        controlPlaneServerUrl = deps.controlPlaneServerUrl;
        return new FakeSupervisor({ emit: deps.emit });
      },
    });
    daemons.push(daemon);

    if (!controlPlaneServerUrl) throw new Error('supervisorFactory was not called');
    expect(controlPlaneServerUrl()).toBeNull();
  });

  it('resolves embedded proxy config under the attached local host id profile', async () => {
    const dir = mkdtempSync('/tmp/sh-cpu-');
    dirs.push(dir);
    const controlPlaneServerUrlPath = join(dir, 'control-plane-server-url');
    writeFileSync(controlPlaneServerUrlPath, 'http://127.0.0.1:58128/path-is-ignored\n');
    const hostConfigPath = join(dir, 'daemon-config.json');
    writeHostConfigAtomic(hostConfigPath, {
      server_url: 'http://127.0.0.1:58128',
      host_id: 'local-host-1',
      host_token: 'token-1',
    });

    const daemon = await runDaemon({
      socketPath: join(dir, 'daemon.sock'),
      workspaceDataRootDir: join(dir, 'workspace-data'),
      pidFilePath: join(dir, 'daemon.pid'),
      logDir: join(dir, 'logs'),
      runtimePidRootDir: join(dir, 'daemon', 'runtime-pids'),
      localOutboundSocketPath: join(dir, 'daemon-outbound.sock'),
      controlPlaneServerUrlPath,
      installSignals: false,
      writeStdoutHandshake: false,
      alsoStderr: false,
      supervisorFactory: null,
    });
    daemons.push(daemon);

    const client = new HostClient({ socketPath: join(dir, 'daemon.sock') });
    await client.connect();
    let written: Awaited<ReturnType<typeof client.hostProxyConfigSet>>;
    try {
      const attached = await client.hostOutboundAttach({
        config_path: hostConfigPath,
      });
      expect(attached.attached).toBe(true);
      written = await client.hostProxyConfigSet({
        proxy_url: 'http://127.0.0.1:7890',
        proxy_runtimes: ['codex'],
      });
    } finally {
      await client.close();
    }

    const expectedPath = computerProxyConfigPath({ host_id: 'local-host-1' }, dir);
    expect(written.config).toEqual({
      proxy_url: 'http://127.0.0.1:7890',
      proxy_runtimes: ['codex'],
    });
    expect(readDaemonProxyConfig(expectedPath)).toEqual(written.config);
  });

  it('migrates the embedded local-placeholder proxy config to the attached local host id', async () => {
    const dir = mkdtempSync('/tmp/sh-cpu-');
    dirs.push(dir);
    const hostConfigPath = join(dir, 'daemon-config.json');
    writeHostConfigAtomic(hostConfigPath, {
      server_url: 'http://127.0.0.1:58128',
      host_id: 'local-host-2',
      host_token: 'token-2',
    });
    const placeholderPath = computerProxyConfigPath({ host_id: 'local' }, dir);
    writeDaemonProxyConfig(placeholderPath, {
      proxy_url: 'http://127.0.0.1:7897',
      proxy_runtimes: ['codex'],
    });

    const daemon = await runDaemon({
      socketPath: join(dir, 'daemon.sock'),
      workspaceDataRootDir: join(dir, 'workspace-data'),
      pidFilePath: join(dir, 'daemon.pid'),
      logDir: join(dir, 'logs'),
      runtimePidRootDir: join(dir, 'daemon', 'runtime-pids'),
      localOutboundSocketPath: join(dir, 'daemon-outbound.sock'),
      installSignals: false,
      writeStdoutHandshake: false,
      alsoStderr: false,
      supervisorFactory: null,
    });
    daemons.push(daemon);

    const client = new HostClient({ socketPath: join(dir, 'daemon.sock') });
    await client.connect();
    let read: Awaited<ReturnType<typeof client.hostProxyConfigGet>>;
    try {
      const attached = await client.hostOutboundAttach({
        config_path: hostConfigPath,
      });
      expect(attached.attached).toBe(true);
      read = await client.hostProxyConfigGet();
    } finally {
      await client.close();
    }

    const expectedPath = computerProxyConfigPath({ host_id: 'local-host-2' }, dir);
    expect(read.config).toEqual({
      proxy_url: 'http://127.0.0.1:7897',
      proxy_runtimes: ['codex'],
    });
    expect(readDaemonProxyConfig(expectedPath)).toEqual(read.config);
    expect(existsSync(placeholderPath)).toBe(false);
    expect(existsSync(`${placeholderPath}.migrated`)).toBe(true);
  });
});

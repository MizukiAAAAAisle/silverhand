import { describe, expect, it } from 'vitest';
import {
  computersRootDir,
  defaultAppRoot,
  homeAppRoot,
  resolveLegacyStandaloneDaemonPaths,
  resolveBackendDataPaths,
  resolveComputerDataPaths,
  resolveDesktopAppPaths,
  resolveServerDataPaths,
} from '../src/app-data-layout.js';

/**
 * #task:1598 — the app-data path authority. The `legacy-v1` table below is
 * the LOAD-BEARING compatibility contract: these strings must equal the
 * historical physical layout byte-for-byte, so pinning the resolver output
 * pins "dogfood on the real ~/.silverhand changes nothing". The v2 shape
 * pins the migration target (docs/app-data-layout-v2.md §2).
 */

const R = '/tmp/approot';

describe('root-resolution semantics matrix (compatibility floor — EXACT historical behavior per entry)', () => {
  // Historical desktop semantics: `process.env.SILVERHAND_DIR || default`.
  // Empty string falls through; whitespace is a truthy value and is used
  // VERBATIM (that was the pre-resolver behavior; changing it is a v2
  // decision, not a floor change).
  it('defaultAppRoot — desktop `||` semantics', () => {
    expect(defaultAppRoot({}, () => '/home/u')).toBe('/home/u/.silverhand');
    expect(defaultAppRoot({ SILVERHAND_DIR: '' }, () => '/home/u')).toBe(
      '/home/u/.silverhand',
    );
    expect(defaultAppRoot({ SILVERHAND_DIR: '  ' }, () => '/home/u')).toBe('  ');
    expect(defaultAppRoot({ SILVERHAND_DIR: '/x/y' }, () => '/home/u')).toBe('/x/y');
  });

  // Historical host-daemon defaults never consulted SILVERHAND_DIR at all
  // (standalone identity/runtime-pids, connect profile root, fallback
  // workspace-data, local outbound socket derive from the USER home only).
  it('homeAppRoot — env-independent', () => {
    expect(homeAppRoot('/home/u')).toBe('/home/u/.silverhand');
  });

  it('resolveLegacyStandaloneDaemonPaths — the historical ~/.silverhand/daemon facet', () => {
    const legacy = resolveLegacyStandaloneDaemonPaths('/home/u/.silverhand');
    expect(legacy.stateDir).toBe('/home/u/.silverhand/daemon');
    expect(legacy.identity).toBe('/home/u/.silverhand/daemon/identity.json');
    expect(legacy.runtimePids).toBe('/home/u/.silverhand/daemon/runtime-pids');
    expect(legacy.proxyConfig).toBe('/home/u/.silverhand/daemon/proxy-config.json');
  });

  it('computersRootDir — the per-computer profiles root', () => {
    expect(computersRootDir('/home/u/.silverhand')).toBe(
      '/home/u/.silverhand/computers',
    );
  });
});

describe('resolveDesktopAppPaths — legacy-v1 (byte-identical to the historical flat layout)', () => {
  const p = resolveDesktopAppPaths(R, 'legacy-v1');

  it('desktop facet', () => {
    expect(p.desktop.root).toBe(`${R}/desktop`);
    expect(p.desktop.electronUserData).toBe(`${R}/desktop/electron-user-data`);
    expect(p.desktop.serverProfile).toBe(`${R}/desktop/server-profile.bin`);
    expect(p.desktop.session).toBe(`${R}/desktop/session.bin`);
    expect(p.desktop.layoutMarker).toBe(`${R}/desktop/data-layout.json`);
  });

  it('local computer facet (flat on the app root)', () => {
    expect(p.localComputer.root).toBe(R);
    expect(p.localComputer.agents).toBe(`${R}/agents`);
    expect(p.localComputer.workspaceData).toBe(`${R}/workspace-data`);
    expect(p.localComputer.daemonConfig).toBe(`${R}/daemon-config.json`);
    expect(p.localComputer.legacyProxyConfig).toBe(`${R}/daemon/proxy-config.json`);
    expect(p.localComputer.run.root).toBe(`${R}/run`);
    expect(p.localComputer.run.socket).toBe(`${R}/run/daemon.sock`);
    expect(p.localComputer.run.outboundSocket).toBe(`${R}/run/daemon-outbound.sock`);
    expect(p.localComputer.run.pidFile).toBe(`${R}/run/daemon.pid`);
    expect(p.localComputer.run.identity).toBe(`${R}/run/identity.json`);
    expect(p.localComputer.run.runtimePids).toBe(`${R}/run/runtime-pids`);
    expect(p.localComputer.run.controlPlaneServerUrl).toBe(
      `${R}/run/control-plane-server-url`,
    );
  });

  it('embedded server facet (flat on the app root)', () => {
    expect(p.embeddedServer.root).toBe(R);
    expect(p.embeddedServer.database).toBe(`${R}/silverhand.db`);
    expect(p.embeddedServer.databaseWal).toBe(`${R}/silverhand.db-wal`);
    expect(p.embeddedServer.databaseShm).toBe(`${R}/silverhand.db-shm`);
    expect(p.embeddedServer.blobs).toBe(`${R}/blobs`);
    expect(p.embeddedServer.serverConfig).toBe(`${R}/server-config.json`);
    expect(p.embeddedServer.bootstrap).toBe(`${R}/embedded-bootstrap`);
  });

  it('shared roots', () => {
    expect(p.installationId).toBe(`${R}/installation_id`);
    expect(p.logs).toBe(`${R}/logs`);
    expect(p.attachmentsCache).toBe(`${R}/attachments-cache`);
    expect(p.legacyWorkspacesRoot).toBe(`${R}/workspaces`);
  });
});

describe('resolveDesktopAppPaths — v2 (migration target)', () => {
  const p = resolveDesktopAppPaths(R, 'v2');

  it('local computer facet under computers/local', () => {
    expect(p.localComputer.root).toBe(`${R}/computers/local`);
    expect(p.localComputer.agents).toBe(`${R}/computers/local/agents`);
    expect(p.localComputer.workspaceData).toBe(`${R}/computers/local/workspace-data`);
    expect(p.localComputer.daemonConfig).toBe(
      `${R}/computers/local/config/daemon-config.json`,
    );
    expect(p.localComputer.run.root).toBe(`${R}/computers/local/run`);
  });

  it('embedded server facet under embedded-server/', () => {
    expect(p.embeddedServer.root).toBe(`${R}/embedded-server`);
    expect(p.embeddedServer.database).toBe(`${R}/embedded-server/silverhand.db`);
    expect(p.embeddedServer.serverConfig).toBe(
      `${R}/embedded-server/config/server-config.json`,
    );
  });

  it('stable roots do not move between versions (logs / attachments-cache / installation_id)', () => {
    const legacy = resolveDesktopAppPaths(R, 'legacy-v1');
    expect(p.logs).toBe(legacy.logs);
    expect(p.attachmentsCache).toBe(legacy.attachmentsCache);
    expect(p.installationId).toBe(legacy.installationId);
    expect(p.desktop).toEqual(legacy.desktop);
  });
});

describe('resolveComputerDataPaths — explicit data roots (connect / custom)', () => {
  it('matches the historical connect layout (flat under the data root)', () => {
    const c = resolveComputerDataPaths('/data/root');
    expect(c.agents).toBe('/data/root/agents');
    expect(c.workspaceData).toBe('/data/root/workspace-data');
    expect(c.daemonConfig).toBe('/data/root/daemon-config.json');
    expect(c.proxyConfig).toBe('/data/root/proxy-config.json');
    expect(c.logs).toBe('/data/root/logs');
    expect(c.run.socket).toBe('/data/root/daemon.sock');
    expect(c.run.pidFile).toBe('/data/root/silverhand-daemon.pid');
    expect(c.run.runtimePids).toBe('/data/root/runtime-pids');
  });
});

describe('resolveServerDataPaths / resolveBackendDataPaths', () => {
  it('server facet matches the historical standalone layout', () => {
    const s = resolveServerDataPaths('/var/lib/silverhand');
    expect(s.database).toBe('/var/lib/silverhand/silverhand.db');
    expect(s.blobs).toBe('/var/lib/silverhand/blobs');
    expect(s.serverConfig).toBe('/var/lib/silverhand/server-config.json');
    expect(s.bootstrap).toBe('/var/lib/silverhand/embedded-bootstrap');
    expect(s.logs).toBe('/var/lib/silverhand/logs');
  });

  it('the startBackend bundle matches the retired silverhandDir derivations', () => {
    expect(resolveBackendDataPaths('/d')).toEqual({
      blobsRootDir: '/d/blobs',
      embeddedBootstrapPath: '/d/embedded-bootstrap',
      workspacesRootDir: '/d/workspaces',
    });
  });
});

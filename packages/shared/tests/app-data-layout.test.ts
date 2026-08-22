import { describe, expect, it } from 'vitest';
import {
  computersRootDir,
  defaultAppRoot,
  resolveComputerSlotPaths,
  resolveConnectProfilePaths,
  safeComputerDirId,
  resolveStandaloneDaemonPaths,
  resolveBackendDataPaths,
  resolveComputerDataPaths,
  resolveDesktopAppPaths,
  resolveServerDataPaths,
} from '../src/app-data-layout.js';

const R = '/tmp/approot';

describe('root-resolution semantics matrix (v2: ONE unified SILVERHAND_DIR contract; legacy facets byte-identical)', () => {
  // Unified v2 contract (shiki 2026-07-24): trim; blank after trim =
  // unset; anything else is the trimmed root.
  it('defaultAppRoot — the ONE unified SILVERHAND_DIR contract (trim; blank = unset)', () => {
    expect(defaultAppRoot({}, () => '/home/u')).toBe('/home/u/.silverhand');
    expect(defaultAppRoot({ SILVERHAND_DIR: '' }, () => '/home/u')).toBe(
      '/home/u/.silverhand',
    );
    expect(defaultAppRoot({ SILVERHAND_DIR: '  ' }, () => '/home/u')).toBe(
      '/home/u/.silverhand',
    );
    expect(defaultAppRoot({ SILVERHAND_DIR: ' /x/y ' }, () => '/home/u')).toBe('/x/y');
    expect(defaultAppRoot({ SILVERHAND_DIR: '/x/y' }, () => '/home/u')).toBe('/x/y');
  });

  // Path SHAPE of the historical daemon/ facet; the ROOT now comes from
  // the unified SILVERHAND_DIR contract like every other default
  // (#task:1603 — the host defaults matrix pins the env adoption).
  it('resolveStandaloneDaemonPaths — the ~/.silverhand/daemon facet', () => {
    const legacy = resolveStandaloneDaemonPaths('/home/u/.silverhand');
    expect(legacy.stateDir).toBe('/home/u/.silverhand/daemon');
    expect(legacy.identity).toBe('/home/u/.silverhand/daemon/identity.json');
    expect(legacy.runtimePids).toBe('/home/u/.silverhand/daemon/runtime-pids');
  });

  it('computersRootDir — the per-computer profiles root', () => {
    expect(computersRootDir('/home/u/.silverhand')).toBe(
      '/home/u/.silverhand/computers',
    );
  });
});

describe('resolveDesktopAppPaths — current desktop layout', () => {
  const p = resolveDesktopAppPaths(R);

  it('desktop facet', () => {
    expect(p.desktop.root).toBe(`${R}/desktop`);
    expect(p.desktop.electronUserData).toBe(`${R}/desktop/electron-user-data`);
    expect(p.desktop.serverProfile).toBe(`${R}/desktop/server-profile.bin`);
    expect(p.desktop.session).toBe(`${R}/desktop/session.bin`);
  });

  it('app-scoped run/', () => {
    expect(p.run.root).toBe(`${R}/run`);
    expect(p.run.socket).toBe(`${R}/run/daemon.sock`);
    expect(p.run.outboundSocket).toBe(`${R}/run/daemon-outbound.sock`);
    expect(p.run.pidFile).toBe(`${R}/run/daemon.pid`);
    expect(p.run.identity).toBe(`${R}/run/identity.json`);
    expect(p.run.runtimePids).toBe(`${R}/run/runtime-pids`);
    expect(p.run.controlPlaneServerUrl).toBe(`${R}/run/control-plane-server-url`);
  });

  it('embedded server facet', () => {
    expect(p.embeddedServer.root).toBe(`${R}/embedded-server`);
    expect(p.embeddedServer.database).toBe(`${R}/embedded-server/silverhand.db`);
    expect(p.embeddedServer.databaseWal).toBe(`${R}/embedded-server/silverhand.db-wal`);
    expect(p.embeddedServer.databaseShm).toBe(`${R}/embedded-server/silverhand.db-shm`);
    expect(p.embeddedServer.blobs).toBe(`${R}/embedded-server/blobs`);
    expect(p.embeddedServer.serverConfig).toBe(`${R}/embedded-server/config/server-config.json`);
    expect(p.embeddedServer.bootstrap).toBe(`${R}/embedded-server/embedded-bootstrap`);
  });

  it('shared roots', () => {
    expect(p.installationId).toBe(`${R}/installation_id`);
    expect(p.logs).toBe(`${R}/logs`);
    expect(p.attachmentsCache).toBe(`${R}/attachments-cache`);
  });

  it('there is no computers/local special case; slots key by computer id', () => {
    expect(p.computersRoot).toBe(`${R}/computers`);
    const slot = resolveComputerSlotPaths(R, 'Pj8F4THwMPAYyaPe');
    expect(slot.root).toBe(`${R}/computers/Pj8F4THwMPAYyaPe`);
    expect(slot.agents).toBe(`${R}/computers/Pj8F4THwMPAYyaPe/agents`);
    expect(slot.proxyConfig).toBe(`${R}/computers/Pj8F4THwMPAYyaPe/proxy-config.json`);
  });

  it('safeComputerDirId sanitizes hostile ids and never yields an empty segment', () => {
    // Same transform the connect profile key has always used: desktop and
    // connect slots are literally the same coordinates.
    expect(safeComputerDirId('a/b:c')).toBe('a_b_c');
    expect(safeComputerDirId('///')).toBe('_');
    expect(safeComputerDirId('')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('the desktop-owned computer binding lives under desktop/', () => {
    expect(p.desktop.computerBinding).toBe(`${R}/desktop/computer-binding.json`);
  });

});

describe('resolveComputerDataPaths — explicit data roots (connect / custom)', () => {
  it('matches the historical connect layout (flat under the data root)', () => {
    const c = resolveComputerDataPaths('/data/root');
    expect(c.agents).toBe('/data/root/agents');
    expect(c.daemonConfig).toBe('/data/root/daemon-config.json');
    expect(c.proxyConfig).toBe('/data/root/proxy-config.json');
    expect(c.logs).toBe('/data/root/logs');
    expect(c.run.socket).toBe('/data/root/daemon.sock');
    expect(c.run.pidFile).toBe('/data/root/silverhand-daemon.pid');
    expect(c.run.runtimePids).toBe('/data/root/runtime-pids');
  });
});

describe('resolveConnectProfilePaths — default connect profiles (#task:1608)', () => {
  it('slot holds ONLY durable state; transient and logs are app-scoped', () => {
    const p = resolveConnectProfilePaths(R, 'host/1');
    // Durable slot = the SAME coordinates as any computer slot.
    expect(p.slot).toEqual(resolveComputerSlotPaths(R, 'host/1'));
    expect(p.slot.root).toBe(`${R}/computers/host_1`);
    // Transient run family under the app-scoped run/ root, per profile.
    expect(p.run.root).toBe(`${R}/run/connect-host_1`);
    expect(p.run.socket).toBe(`${R}/run/connect-host_1/daemon.sock`);
    expect(p.run.pidFile).toBe(`${R}/run/connect-host_1/silverhand-daemon.pid`);
    expect(p.run.runtimePids).toBe(`${R}/run/connect-host_1/runtime-pids`);
    // Logs under the single support-bundle root.
    expect(p.logs).toBe(`${R}/logs/connect-host_1`);
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

  it('the startBackend bundle matches the retired silverhandDir derivations (no workspaces root — #task:1608 rev 3)', () => {
    expect(resolveBackendDataPaths('/d')).toEqual({
      blobsRootDir: '/d/blobs',
      embeddedBootstrapPath: '/d/embedded-bootstrap',
    });
  });
});

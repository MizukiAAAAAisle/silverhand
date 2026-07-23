/**
 * D5.a-4 — STANDALONE parity e2e.
 *
 * Boots the real standalone backend + a real in-process daemon over the
 * outbound WSS path (via the G2 harness) and runs the SAME shared
 * {@link registerParityPhases} contract the embedded file runs — proving
 * the two deployments share one `OutboundFrameAdapter` contract rather
 * than each carrying a bespoke success path (Cindy `8a5PMGwqiBIO8ccg` #1),
 * and that `agent_materialize` create goes route → adapter → real daemon
 * `materializeAgent` → DB flip active (#4).
 *
 * On top of the shared phases this file adds the deeper connection-id
 * replacement arm (Cindy #3): after a daemon bounce + reattach the host's
 * connectionId is replaced; a command pinned to the OLD connectionId must
 * reject (it can never be answered by the new connection), while the NEW
 * connection serves — i.e. an old connection's late traffic cannot pollute
 * the current one, and replacing the old connection did not break the new.
 */
import {
  resolveBackendDataPaths,
} from '@silverhand/shared/app-data-layout';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuntimeKind } from '@silverhand/shared';
import { AuthSessionService } from '../../../src/auth/session.js';
import {
  bootDaemonWithSupervisor,
  bootG2Harness,
  waitForAttachment,
  type DaemonWithSupervisorHandle,
  type G2Harness,
} from '../g2-harness.js';
import {
  makeParitySessionInitDriver,
  registerParityPhases,
  waitFor,
  type ParityRig,
} from './outbound-parity-contract.js';

interface StandaloneRigInternals extends ParityRig {
  harness: G2Harness;
  daemonRef: { current: DaemonWithSupervisorHandle };
  bootDaemon: () => Promise<DaemonWithSupervisorHandle>;
}

async function bootStandaloneRig(): Promise<StandaloneRigInternals> {
  const agentHomeDir = mkdtempSync(join(tmpdir(), 'silverhand-d5a4-std-home-'));
  const harness = await bootG2Harness();
  const expectedSessionId = `d5a4-std-session-${Date.now()}`;

  const bootDaemon = (): Promise<DaemonWithSupervisorHandle> =>
    bootDaemonWithSupervisor(harness, {
      driverFor: (_kind: RuntimeKind) => makeParitySessionInitDriver(expectedSessionId),
      testHooks: { agentMaterializeHomeDir: agentHomeDir },
    });

  const daemonRef = { current: await bootDaemon() };

  const controller = harness.backend.context.hostWsController?.();
  if (!controller) throw new Error('standalone backend has no host ws controller');
  await waitForAttachment(controller, harness.hostId);

  const { userToken: bearer } = new AuthSessionService(harness.backend.context.db).issueSession({
    userId: harness.userId,
  });

  const adapter = () => {
    const a = harness.backend.context.outboundFrameAdapter?.();
    if (!a) throw new Error('standalone backend has no outboundFrameAdapter');
    return a;
  };

  return {
    name: 'standalone',
    backend: harness.backend,
    baseUrl: harness.serverUrl,
    bearer,
    hostId: harness.hostId,
    userId: harness.userId,
    silverhandDir: harness.silverhandDir,
    expectedSessionId,
    agentHomeDir,
    adapter,
    harness,
    daemonRef,
    bootDaemon,
    shutdown: async () => {
      await daemonRef.current?.stop().catch(() => undefined);
      await harness.shutdown().catch(() => undefined);
      try {
        rmSync(agentHomeDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

describe('D5.a-4 standalone parity (real standalone backend + real in-process daemon over WSS)', () => {
  let rig: StandaloneRigInternals | null = null;

  beforeAll(async () => {
    rig = await bootStandaloneRig();
  }, 60_000);

  afterAll(async () => {
    await rig?.shutdown().catch(() => undefined);
    rig = null;
  });

  registerParityPhases(() => {
    if (!rig) throw new Error('standalone rig not booted');
    return rig;
  });

  it('Phase D3 (standalone) — daemon bounce replaces connectionId: old-id command rejects, new connection serves', async () => {
    if (!rig) throw new Error('standalone rig not booted');
    const adapter = rig.adapter();
    const oldConnectionId = adapter.connectionIdForHost(rig.hostId);
    expect(oldConnectionId).toBeTruthy();

    // Bounce: drop daemon1, attach daemon2 with the same host token. The
    // backend mints a fresh connectionId for the new socket.
    await rig.daemonRef.current.stop();
    rig.daemonRef.current = await rig.bootDaemon();
    const controller = rig.harness.backend.context.hostWsController?.();
    if (!controller) throw new Error('standalone backend has no host ws controller');
    await waitForAttachment(controller, rig.hostId);

    const newConnectionId = await waitFor(
      () => {
        const cid = adapter.connectionIdForHost(rig!.hostId);
        return cid && cid !== oldConnectionId ? cid : null;
      },
      { timeoutMs: 10_000, label: 'fresh connectionId after reattach' },
    );
    expect(newConnectionId).not.toBe(oldConnectionId);

    // A command bound to the OLD connectionId must reject — proving an old
    // connection's late/in-flight traffic can never be answered by (and so
    // cannot pollute) the new connection.
    await expect(
      adapter.sendCommand(
        rig.hostId,
        'runtime_status',
        {},
        { expectedConnectionId: oldConnectionId ?? undefined, timeoutMs: 5_000 },
      ),
    ).rejects.toMatchObject({ code: 'transport_disconnected' });

    // The NEW connection is healthy (replacing the old one didn't break it).
    const result = await adapter.sendCommand(
      rig.hostId,
      'runtime_status',
      {},
      { expectedConnectionId: newConnectionId, timeoutMs: 5_000 },
    );
    expect(Array.isArray((result as { runtimes: unknown[] }).runtimes)).toBe(true);
  }, 30_000);
});

/**
 * D4.e-1 3b-2 (+ 3b P1-2) — workspace registry backfiller.
 *
 * The backfiller re-binds the caller's passed regular workspaces into the
 * daemon registry by re-provisioning each with its stored `workspace_path` as
 * the `requested_path`. It is SCOPED to the rows the caller passes (the visible
 * regular workspaces) — never every regular row on the host (P1-2, Cindy).
 * Pins:
 *   1. happy path: every passed row dispatched with requested_path = its
 *      stored workspace_path; daemon ack caches bound_workspace_path; status ok.
 *   2. structured per-id result: provisioned vs alreadyBound split by the
 *      daemon's `provisioned` flag.
 *   3. daemon offline → status failed, every id in `failed` (retriable),
 *      NOT memoized (next call retries).
 *   4. mixed → status partial (some bound, one typed-failed), NOT memoized.
 *   5. no rows → noop, no dispatch.
 *   6. per-(host,id) in-flight guard: concurrent ensure() of the same row
 *      share ONE dispatch.
 *   7. memoize success for the stable registry namespace: transport reconnect
 *      does NOT re-provision; a new backfiller/backend process does.
 *   8. per-id scope: a caller asking only for its own row is unaffected by an
 *      unrelated row that would fail (P1-2 at the helper level).
 *   9. fail-closed never writes a workspace_path fallback (only daemon ack).
 */
import { describe, expect, it } from 'vitest';
import type {
  OutboundServerCommandKind,
  OutboundServerCommandParams,
  OutboundServerCommandResult,
} from '@silverhand/host';
import {
  HostWsCommandResponseError,
  HostWsCommandTransportError,
} from '../../src/ws/host-ws-server.js';
import type { OutboundFrameAdapter } from '../../src/runtime/outbound-frame-adapter.js';
import { WorkspaceRegistryBackfiller, summarizeMigrationAudit } from '../../src/runtime/workspace-registry-backfill.js';

type ProvisionCall = { workspace_id: string; requested_path?: string };

interface FakeProvisionBehavior {
  // by workspace_id → outcome
  [id: string]:
    | { ok: true; boundPath: string; provisioned: boolean }
    | { ok: false; error: Error };
}

function makeAdapter(opts: {
  connectionId: string | null;
  behavior?: FakeProvisionBehavior;
  defaultError?: Error;
}): { adapter: OutboundFrameAdapter; calls: ProvisionCall[] } {
  const calls: ProvisionCall[] = [];
  const adapter: OutboundFrameAdapter = {
    activeConnectionCount: () => (opts.connectionId ? 1 : 0),
    connectedHostIds: () => (opts.connectionId ? ['local'] : []),
    connectionIdForHost: () => opts.connectionId,
    getAttachment: () => null,
    async sendCommand<K extends OutboundServerCommandKind>(
      _hostId: string,
      kind: K,
      params: OutboundServerCommandParams<K>,
    ): Promise<OutboundServerCommandResult<K>> {
      expect(kind).toBe('workspace_provision');
      const p = params as { workspace_id: string; requested_path?: string };
      calls.push({ workspace_id: p.workspace_id, requested_path: p.requested_path });
      const b = opts.behavior?.[p.workspace_id];
      if (b && !b.ok) throw b.error;
      if (opts.defaultError) throw opts.defaultError;
      const boundPath = b && b.ok ? b.boundPath : `${p.requested_path}`;
      const provisioned = b && b.ok ? b.provisioned : true;
      return {
        ok: true,
        provisioned,
        bound_workspace_path: boundPath,
      } as OutboundServerCommandResult<K>;
    },
    async close() {},
  };
  return { adapter, calls };
}

function makeRepo() {
  const cacheWrites: { id: string; path: string }[] = [];
  return {
    repo: {
      updateWorkspacePathCache: (id: string, path: string) => {
        cacheWrites.push({ id, path });
        return null;
      },
    },
    cacheWrites,
  };
}

describe('WorkspaceRegistryBackfiller', () => {
  it('re-provisions every passed row with its stored path; caches daemon ack; status ok', async () => {
    const { repo, cacheWrites } = makeRepo();
    const rows = [
      { id: 'ws_a', workspace_path: '/Users/x/a' },
      { id: 'ws_b', workspace_path: '/managed/b' },
    ];
    const { adapter, calls } = makeAdapter({
      connectionId: 'conn-1',
      behavior: {
        ws_a: { ok: true, boundPath: '/Users/x/a', provisioned: true },
        ws_b: { ok: true, boundPath: '/managed/b', provisioned: false },
      },
    });
    const bf = new WorkspaceRegistryBackfiller({
      workspaces: repo,
      outboundFrameAdapter: () => adapter,
    });
    const res = await bf.ensure('local', rows);

    expect(res.status).toBe('ok');
    expect(res.provisioned).toEqual(['ws_a']);
    expect(res.alreadyBound).toEqual(['ws_b']);
    expect(res.failed).toEqual([]);
    // requested_path forwarded verbatim from the legacy column.
    expect(calls).toEqual([
      { workspace_id: 'ws_a', requested_path: '/Users/x/a' },
      { workspace_id: 'ws_b', requested_path: '/managed/b' },
    ]);
    // cache refreshed only from the daemon's bound_workspace_path ack.
    expect(cacheWrites).toEqual([
      { id: 'ws_a', path: '/Users/x/a' },
      { id: 'ws_b', path: '/managed/b' },
    ]);
  });

  it('no rows passed → noop, no dispatch', async () => {
    const { repo } = makeRepo();
    const { adapter, calls } = makeAdapter({ connectionId: 'conn-1' });
    const bf = new WorkspaceRegistryBackfiller({
      workspaces: repo,
      outboundFrameAdapter: () => adapter,
    });
    const res = await bf.ensure('local', []);
    expect(res.status).toBe('noop');
    expect(calls).toHaveLength(0);
  });

  it('daemon offline → status failed, all ids failed (retriable), NOT memoized', async () => {
    const { repo, cacheWrites } = makeRepo();
    const rows = [{ id: 'ws_a', workspace_path: '/Users/x/a' }];
    let adapterRef: OutboundFrameAdapter | null = null;
    const bf = new WorkspaceRegistryBackfiller({
      workspaces: repo,
      outboundFrameAdapter: () => adapterRef, // null = offline
    });
    const res = await bf.ensure('local', rows);
    expect(res.status).toBe('failed');
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]!.id).toBe('ws_a');
    expect(res.failed[0]!.code).toBe('host_attach_pending');
    expect(res.failed[0]!.retriable).toBe(true);
    // fail-closed: never wrote a workspace_path fallback.
    expect(cacheWrites).toEqual([]);

    // NOT memoized: once the daemon attaches, the next ensure() retries.
    const { adapter, calls } = makeAdapter({
      connectionId: 'conn-1',
      behavior: { ws_a: { ok: true, boundPath: '/Users/x/a', provisioned: true } },
    });
    adapterRef = adapter;
    const retry = await bf.ensure('local', rows);
    expect(retry.status).toBe('ok');
    expect(calls).toHaveLength(1);
  });

  it('mixed outcomes → status partial (NOT memoized)', async () => {
    const { repo } = makeRepo();
    const rows = [
      { id: 'ws_ok', workspace_path: '/Users/x/ok' },
      { id: 'ws_bad', workspace_path: 'relative/bad' },
    ];
    const { adapter } = makeAdapter({
      connectionId: 'conn-1',
      behavior: {
        ws_ok: { ok: true, boundPath: '/Users/x/ok', provisioned: true },
        ws_bad: {
          ok: false,
          error: new HostWsCommandResponseError(
            'invalid_path' as never,
            'must be absolute',
            { hostId: 'local', commandKind: 'workspace_provision', requestId: 'r' },
          ),
        },
      },
    });
    const bf = new WorkspaceRegistryBackfiller({
      workspaces: repo,
      outboundFrameAdapter: () => adapter,
    });
    const res = await bf.ensure('local', rows);
    expect(res.status).toBe('partial');
    expect(res.provisioned).toEqual(['ws_ok']);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]!.id).toBe('ws_bad');
    expect(res.failed[0]!.code).toBe('invalid_workspace_path');
  });

  it('per-(host,id) in-flight guard: concurrent ensure() of the same row share ONE dispatch', async () => {
    const { repo } = makeRepo();
    const rows = [{ id: 'ws_a', workspace_path: '/Users/x/a' }];
    let resolveSend: ((v: unknown) => void) | null = null;
    let sendCount = 0;
    const adapter: OutboundFrameAdapter = {
      activeConnectionCount: () => 1,
      connectedHostIds: () => ['local'],
      connectionIdForHost: () => 'conn-1',
      getAttachment: () => null,
      sendCommand: ((..._args: unknown[]) => {
        sendCount += 1;
        return new Promise<unknown>(resolve => {
          resolveSend = () =>
            resolve({
              ok: true,
              provisioned: true,
              bound_workspace_path: '/Users/x/a',
            });
        });
      }) as OutboundFrameAdapter['sendCommand'],
      async close() {},
    };
    const bf = new WorkspaceRegistryBackfiller({
      workspaces: repo,
      outboundFrameAdapter: () => adapter,
    });
    const p1 = bf.ensure('local', rows);
    const p2 = bf.ensure('local', rows);
    // both callers awaiting the same in-flight per-id run; only one dispatch.
    await new Promise(r => setTimeout(r, 0));
    expect(sendCount).toBe(1);
    resolveSend!(undefined);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe('ok');
    expect(r2.status).toBe('ok');
  });

  it('memoizes a fully-bound row: a second ensure() does NO dispatch', async () => {
    const { repo } = makeRepo();
    const rows = [{ id: 'ws_a', workspace_path: '/Users/x/a' }];
    const { adapter, calls } = makeAdapter({
      connectionId: 'conn-1',
      behavior: { ws_a: { ok: true, boundPath: '/Users/x/a', provisioned: true } },
    });
    const bf = new WorkspaceRegistryBackfiller({
      workspaces: repo,
      outboundFrameAdapter: () => adapter,
    });
    const first = await bf.ensure('local', rows);
    expect(first.status).toBe('ok');
    const second = await bf.ensure('local', rows);
    // second sees the (host,id) memoized → reported alreadyBound, no dispatch.
    expect(second.status).toBe('ok');
    expect(second.alreadyBound).toEqual(['ws_a']);
    expect(calls).toHaveLength(1);
  });

  it('keeps a settled row across transport reconnects to the same registry namespace', async () => {
    const { repo } = makeRepo();
    const rows = [{ id: 'ws_a', workspace_path: '/Users/x/a' }];
    let connectionId = 'conn-1';
    const calls: Array<{ connectionId: string; workspace_id: string }> = [];
    const adapter: OutboundFrameAdapter = {
      activeConnectionCount: () => 1,
      connectedHostIds: () => ['local'],
      connectionIdForHost: () => connectionId,
      getAttachment: () => null,
      async sendCommand<K extends OutboundServerCommandKind>(
        _hostId: string,
        kind: K,
        params: OutboundServerCommandParams<K>,
      ): Promise<OutboundServerCommandResult<K>> {
        expect(kind).toBe('workspace_provision');
        const p = params as { workspace_id: string; requested_path?: string };
        calls.push({ connectionId, workspace_id: p.workspace_id });
        return {
          ok: true,
          provisioned: calls.length === 1,
          bound_workspace_path: p.requested_path!,
        } as OutboundServerCommandResult<K>;
      },
      async close() {},
    };
    const bf = new WorkspaceRegistryBackfiller({
      workspaces: repo,
      outboundFrameAdapter: () => adapter,
    });

    await bf.ensure('local', rows);
    await bf.ensure('local', rows);
    expect(calls).toEqual([{ connectionId: 'conn-1', workspace_id: 'ws_a' }]);

    // A network reconnect changes transport custody, not the daemon's
    // persistent (server_origin, host_id) registry namespace.
    connectionId = 'conn-2';
    const afterReconnect = await bf.ensure('local', rows);
    expect(afterReconnect.status).toBe('ok');
    expect(afterReconnect.alreadyBound).toEqual(['ws_a']);
    expect(calls).toEqual([{ connectionId: 'conn-1', workspace_id: 'ws_a' }]);

    // A backend restart creates a fresh migration helper and safely repeats
    // the daemon's idempotent provision once.
    const afterBackendRestart = new WorkspaceRegistryBackfiller({
      workspaces: repo,
      outboundFrameAdapter: () => adapter,
    });
    await afterBackendRestart.ensure('local', rows);
    expect(calls).toEqual([
      { connectionId: 'conn-1', workspace_id: 'ws_a' },
      { connectionId: 'conn-2', workspace_id: 'ws_a' },
    ]);

    // The fresh helper now memoizes the same stable namespace.
    await afterBackendRestart.ensure('local', rows);
    await bf.ensure('local', rows);
    expect(calls).toHaveLength(2);
  });

  it('unrelated failing rows do not affect a separate row request (per-id scope)', async () => {
    // P1-2 (Cindy) regression at the helper level: a caller that asks to bind
    // only its OWN visible rows is unaffected by another row that would fail.
    const { repo } = makeRepo();
    const { adapter, calls } = makeAdapter({
      connectionId: 'conn-1',
      behavior: {
        ws_visible: { ok: true, boundPath: '/Users/x/v', provisioned: true },
        ws_bad: {
          ok: false,
          error: new HostWsCommandResponseError(
            'invalid_path' as never,
            'must be absolute',
            { hostId: 'local', commandKind: 'workspace_provision', requestId: 'r' },
          ),
        },
      },
    });
    const bf = new WorkspaceRegistryBackfiller({
      workspaces: repo,
      outboundFrameAdapter: () => adapter,
    });
    // Only the visible row is passed — the bad row is never enumerated here.
    const res = await bf.ensure('local', [
      { id: 'ws_visible', workspace_path: '/Users/x/v' },
    ]);
    expect(res.status).toBe('ok');
    expect(res.provisioned).toEqual(['ws_visible']);
    expect(calls.map(c => c.workspace_id)).toEqual(['ws_visible']);
  });

  it('transport timeout mid-run is recorded as a retriable per-id failure', async () => {
    const { repo } = makeRepo();
    const rows = [{ id: 'ws_a', workspace_path: '/Users/x/a' }];
    const { adapter } = makeAdapter({
      connectionId: 'conn-1',
      defaultError: new HostWsCommandTransportError('transport_timeout', 'slow', {
        hostId: 'local',
        commandKind: 'workspace_provision',
        requestId: 'r',
      }),
    });
    const bf = new WorkspaceRegistryBackfiller({
      workspaces: repo,
      outboundFrameAdapter: () => adapter,
    });
    const res = await bf.ensure('local', rows);
    expect(res.status).toBe('failed');
    expect(res.failed[0]!.code).toBe('daemon_timeout');
    expect(res.failed[0]!.retriable).toBe(true);
  });
});

describe('summarizeMigrationAudit (#1529 hydrate-time audit summary)', () => {
  it('maps a clean result to a complete, redacted summary (counts only)', () => {
    const summary = summarizeMigrationAudit({
      hostId: 'local',
      status: 'ok',
      provisioned: ['ws_a'],
      alreadyBound: ['ws_b', 'ws_c'],
      failed: [],
    });
    expect(summary).toEqual({
      workspace_count: 3,
      provisioned_count: 1,
      already_bound_count: 2,
      failed_count: 0,
      failure_codes: [],
      migration_complete: true,
    });
  });

  it('marks incomplete and dedups + sorts failure codes when a row failed', () => {
    const summary = summarizeMigrationAudit({
      hostId: 'local',
      status: 'partial',
      provisioned: ['ws_a'],
      alreadyBound: [],
      failed: [
        { id: 'ws_x', code: 'invalid_workspace_path', message: 'm', retriable: false },
        { id: 'ws_y', code: 'fs_unavailable', message: 'm', retriable: true },
        { id: 'ws_z', code: 'fs_unavailable', message: 'm', retriable: true },
      ],
    });
    expect(summary.workspace_count).toBe(4);
    expect(summary.provisioned_count).toBe(1);
    expect(summary.failed_count).toBe(3);
    // distinct + stably sorted for aggregation.
    expect(summary.failure_codes).toEqual([
      'fs_unavailable',
      'invalid_workspace_path',
    ]);
    expect(summary.migration_complete).toBe(false);
  });

  it('an empty host is trivially complete', () => {
    expect(
      summarizeMigrationAudit({
        hostId: 'local',
        status: 'noop',
        provisioned: [],
        alreadyBound: [],
        failed: [],
      }),
    ).toEqual({
      workspace_count: 0,
      provisioned_count: 0,
      already_bound_count: 0,
      failed_count: 0,
      failure_codes: [],
      migration_complete: true,
    });
  });
});

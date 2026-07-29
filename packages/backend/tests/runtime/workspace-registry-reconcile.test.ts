/**
 * #task:1719 — WorkspaceRegistryReconciler unit tests (fake adapter, no
 * real sockets). Each block pins one acceptance criterion of the
 * ready-generation reconcile:
 *
 *   - ghost removal happy path (home + guest legality, pinned generation)
 *   - no-capability PASS-THROUGH (zero dispatch, barrier resolves)
 *   - generation flip mid-reconcile abandons silently (no dispatch into
 *     the new generation; the new ready re-runs its own reconcile)
 *   - barrier awaits the in-flight run (single-flight per generation)
 *   - barrier re-kicks after failure and throws the typed error while the
 *     host keeps failing; the pull failure logs
 *     `workspace_registry_reconcile_failed`
 *   - ghost batches chunk by WORKSPACE_UNBIND_MAX_BATCH
 */
import { describe, expect, it } from 'vitest';
import { WORKSPACE_UNBIND_MAX_BATCH } from '@silverhand/host';
import type {
  OutboundServerCommandKind,
  OutboundServerCommandParams,
  OutboundServerCommandResult,
} from '@silverhand/host';
import type { BackendLogger } from '../../src/context.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import type { OutboundFrameAdapter } from '../../src/runtime/outbound-frame-adapter.js';
import {
  WorkspaceRegistryReconcilePendingError,
  WorkspaceRegistryReconciler,
} from '../../src/runtime/workspace-registry-reconcile.js';
import {
  HostWsCommandTransportError,
  type HostWsAttachment,
} from '../../src/ws/host-ws-server.js';
import { openTestDb } from '../utils/db.js';

const RECONCILE_CAPABILITY = 'workspace.registry_reconcile.v1';

interface RecordedCall {
  hostId: string;
  kind: OutboundServerCommandKind;
  params: unknown;
  expectedConnectionId: string | undefined;
}

/** Minimal controllable OutboundFrameAdapter: per-host connection ids,
 *  mutable capabilities, and per-kind scripted handlers. */
class FakeReconcileAdapter implements OutboundFrameAdapter {
  readonly connections = new Map<string, string>();
  capabilities: string[] = [RECONCILE_CAPABILITY];
  readonly calls: RecordedCall[] = [];
  handlers: Partial<
    Record<OutboundServerCommandKind, (params: unknown) => Promise<unknown>>
  > = {};

  activeConnectionCount(): number {
    return this.connections.size;
  }
  connectedHostIds(): string[] {
    return [...this.connections.keys()];
  }
  connectionIdForHost(hostId: string): string | null {
    return this.connections.get(hostId) ?? null;
  }
  getAttachment(hostId: string): HostWsAttachment | null {
    const connectionId = this.connectionIdForHost(hostId);
    if (!connectionId) return null;
    return {
      hostId,
      connectionId,
      attachedAt: 0,
      hostname: null,
      capabilities: this.capabilities,
    };
  }
  async sendCommand<K extends OutboundServerCommandKind>(
    hostId: string,
    kind: K,
    params: OutboundServerCommandParams<K>,
    opts?: { timeoutMs?: number; expectedConnectionId?: string },
  ): Promise<OutboundServerCommandResult<K>> {
    this.calls.push({
      hostId,
      kind,
      params,
      expectedConnectionId: opts?.expectedConnectionId,
    });
    const handler = this.handlers[kind];
    if (!handler) {
      throw new Error(`fake adapter: no handler scripted for ${kind}`);
    }
    return (await handler(params)) as OutboundServerCommandResult<K>;
  }
  async close(): Promise<void> {}
}

interface RecordedLog {
  level: 'info' | 'warn' | 'error';
  obj: Record<string, unknown>;
  msg?: string;
}

function recordingLogger(): { logger: BackendLogger; logs: RecordedLog[] } {
  const logs: RecordedLog[] = [];
  const push = (level: RecordedLog['level']) => (obj: unknown, msg?: string) =>
    logs.push({ level, obj: obj as Record<string, unknown>, msg });
  return {
    logger: { info: push('info'), warn: push('warn'), error: push('error') },
    logs,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function timeoutError(hostId: string): HostWsCommandTransportError {
  return new HostWsCommandTransportError(
    'transport_timeout',
    'daemon did not answer in time',
    { hostId },
  );
}

/** Fixture: a DB whose legal set for HOST is one HOME workspace + one GUEST
 *  workspace (member agent on HOST, home elsewhere). */
function buildFixture() {
  const { db } = openTestDb();
  const now = Date.now();
  const insertHost = db.prepare(
    `INSERT INTO hosts (id, name, kind, created_at) VALUES (?, ?, 'remote', ?)`,
  );
  insertHost.run('host-a', 'host-a', now);
  insertHost.run('host-b', 'host-b', now);
  const workspaces = new WorkspaceRepo(db);
  workspaces.insert({
    id: 'ws_home',
    name: 'home-ws',
    description: null,
    workspacePath: '/tmp/reconcile/home',
    workspaceHostId: 'host-a',
  });
  workspaces.insert({
    id: 'ws_guest',
    name: 'guest-ws',
    description: null,
    workspacePath: '/tmp/reconcile/guest',
    workspaceHostId: 'host-b',
  });
  db.prepare(
    `INSERT INTO agents (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
     VALUES (?, ?, 'claude', ?, 'local', ?, ?)`,
  ).run('agent-on-a', 'agent-on-a', 'host-a', now, now);
  workspaces.insertMembership('ws_guest', 'agent-on-a');
  return { db };
}

function buildReconciler(adapter: FakeReconcileAdapter) {
  const { db } = buildFixture();
  const { logger, logs } = recordingLogger();
  const reconciler = new WorkspaceRegistryReconciler({
    db,
    adapter: () => adapter,
    logger,
  });
  return { reconciler, logs };
}

describe('WorkspaceRegistryReconciler', () => {
  it('happy path: ghosts = reported − (home ∪ guest); unbind is generation-pinned; success log carries the counts', async () => {
    const adapter = new FakeReconcileAdapter();
    adapter.connections.set('host-a', 'conn-1');
    adapter.handlers.workspace_registry_ids = async () => ({
      ok: true,
      // home + guest are LEGAL; the other two are ghosts.
      workspace_ids: ['ws_home', 'ws_guest', 'ghost_1', 'ghost_2'],
    });
    const unbinds: string[][] = [];
    adapter.handlers.workspace_unbind = async params => {
      const ids = (params as { workspace_ids: string[] }).workspace_ids;
      unbinds.push(ids);
      return { ok: true, removed: ids, absent: [] };
    };
    const { reconciler, logs } = buildReconciler(adapter);

    reconciler.onHostReady('host-a');
    await reconciler.barrier('host-a');

    expect(unbinds).toEqual([['ghost_1', 'ghost_2']]);
    // Every dispatch is pinned to THIS generation.
    for (const call of adapter.calls) {
      expect(call.expectedConnectionId).toBe('conn-1');
    }
    expect(logs).toContainEqual({
      level: 'info',
      obj: {
        event: 'workspace_registry_reconcile',
        host_id: 'host-a',
        connection_id: 'conn-1',
        reported: 4,
        legal: 2,
        ghosts_removed: 2,
      },
      msg: 'workspace registry reconcile: daemon registry converged with DB',
    });
    // Second barrier is a memory read — no additional dispatch.
    const callCount = adapter.calls.length;
    await reconciler.barrier('host-a');
    expect(adapter.calls.length).toBe(callCount);
    reconciler.close();
  });

  it('no-capability generation is PASS-THROUGH: zero dispatch, barrier resolves immediately, info log', async () => {
    const adapter = new FakeReconcileAdapter();
    adapter.connections.set('host-a', 'conn-1');
    adapter.capabilities = []; // old daemon: token absent
    const { reconciler, logs } = buildReconciler(adapter);

    reconciler.onHostReady('host-a');
    await reconciler.barrier('host-a');

    expect(adapter.calls).toEqual([]);
    expect(
      logs.filter(
        l => l.obj.event === 'workspace_registry_reconcile_pass_through',
      ),
    ).toEqual([
      expect.objectContaining({
        level: 'info',
        obj: expect.objectContaining({
          host_id: 'host-a',
          connection_id: 'conn-1',
        }),
      }),
    ]);
    reconciler.close();
  });

  it('generation flip mid-reconcile abandons silently: no unbind into the new generation; the new ready runs its own reconcile', async () => {
    const adapter = new FakeReconcileAdapter();
    adapter.connections.set('host-a', 'conn-1');
    const firstPull = deferred<unknown>();
    let pulls = 0;
    adapter.handlers.workspace_registry_ids = async () => {
      pulls += 1;
      if (pulls === 1) return firstPull.promise;
      return { ok: true, workspace_ids: ['ws_home'] }; // new generation: clean
    };
    adapter.handlers.workspace_unbind = async () => {
      throw new Error('stale run must NOT dispatch unbind after a flip');
    };
    const { reconciler, logs } = buildReconciler(adapter);

    reconciler.onHostReady('host-a');
    const staleBarrier = reconciler.barrier('host-a');
    // The daemon reconnects while the pull is in flight → new generation.
    adapter.connections.set('host-a', 'conn-2');
    // The STALE pull now answers with ghosts; the run must abandon instead
    // of unbinding into conn-2.
    firstPull.resolve({ ok: true, workspace_ids: ['ghost_stale'] });
    await staleBarrier; // abandoned runs resolve their waiters silently

    expect(
      adapter.calls.filter(c => c.kind === 'workspace_unbind'),
    ).toEqual([]);
    // No success/failed log for the stale generation either.
    expect(
      logs.filter(l => l.obj.event === 'workspace_registry_reconcile'),
    ).toEqual([]);

    // The new generation's own ready re-runs and completes.
    reconciler.onHostReady('host-a');
    await reconciler.barrier('host-a');
    const secondPull = adapter.calls.filter(
      c => c.kind === 'workspace_registry_ids',
    )[1];
    expect(secondPull?.expectedConnectionId).toBe('conn-2');
    expect(
      logs.filter(l => l.obj.event === 'workspace_registry_reconcile'),
    ).toHaveLength(1);
    reconciler.close();
  });

  it('barrier awaits the in-flight run — never a second dispatch for the same generation', async () => {
    const adapter = new FakeReconcileAdapter();
    adapter.connections.set('host-a', 'conn-1');
    const pull = deferred<unknown>();
    adapter.handlers.workspace_registry_ids = async () => pull.promise;
    const { reconciler } = buildReconciler(adapter);

    reconciler.onHostReady('host-a');
    let settled = false;
    const gate = reconciler.barrier('host-a').then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false); // still awaiting the in-flight run
    pull.resolve({ ok: true, workspace_ids: [] });
    await gate;
    expect(settled).toBe(true);
    expect(
      adapter.calls.filter(c => c.kind === 'workspace_registry_ids'),
    ).toHaveLength(1);
    reconciler.close();
  });

  it('ids-pull failure logs workspace_registry_reconcile_failed; barrier throws typed and re-kicks single-flight on demand', async () => {
    const adapter = new FakeReconcileAdapter();
    adapter.connections.set('host-a', 'conn-1');
    adapter.handlers.workspace_registry_ids = async () => {
      throw timeoutError('host-a');
    };
    const { reconciler, logs } = buildReconciler(adapter);

    reconciler.onHostReady('host-a');
    // Barrier during/after the failing run rejects with the typed error…
    await expect(reconciler.barrier('host-a')).rejects.toBeInstanceOf(
      WorkspaceRegistryReconcilePendingError,
    );
    // …and a later barrier RE-KICKS the reconcile (retry-on-demand) instead
    // of caching the failure forever.
    await expect(reconciler.barrier('host-a')).rejects.toBeInstanceOf(
      WorkspaceRegistryReconcilePendingError,
    );
    expect(
      adapter.calls.filter(c => c.kind === 'workspace_registry_ids'),
    ).toHaveLength(2);
    const failedLogs = logs.filter(
      l => l.obj.event === 'workspace_registry_reconcile_failed',
    );
    expect(failedLogs).toHaveLength(2);
    expect(failedLogs[0]).toEqual(
      expect.objectContaining({
        level: 'warn',
        obj: expect.objectContaining({
          host_id: 'host-a',
          connection_id: 'conn-1',
          code: 'daemon_timeout',
        }),
      }),
    );
    reconciler.close();
  });

  it(`chunks a ghost sweep by WORKSPACE_UNBIND_MAX_BATCH (${WORKSPACE_UNBIND_MAX_BATCH})`, async () => {
    const adapter = new FakeReconcileAdapter();
    adapter.connections.set('host-a', 'conn-1');
    const ghostCount = WORKSPACE_UNBIND_MAX_BATCH + 50;
    const ghosts = Array.from({ length: ghostCount }, (_, i) => `ghost_${i}`);
    adapter.handlers.workspace_registry_ids = async () => ({
      ok: true,
      workspace_ids: ['ws_home', ...ghosts],
    });
    const unbinds: string[][] = [];
    adapter.handlers.workspace_unbind = async params => {
      const ids = (params as { workspace_ids: string[] }).workspace_ids;
      unbinds.push(ids);
      return { ok: true, removed: ids, absent: [] };
    };
    const { reconciler, logs } = buildReconciler(adapter);

    reconciler.onHostReady('host-a');
    await reconciler.barrier('host-a');

    expect(unbinds.map(chunk => chunk.length)).toEqual([
      WORKSPACE_UNBIND_MAX_BATCH,
      50,
    ]);
    expect(unbinds.flat()).toEqual(ghosts);
    expect(
      logs.find(l => l.obj.event === 'workspace_registry_reconcile')?.obj,
    ).toEqual(
      expect.objectContaining({ ghosts_removed: ghostCount }),
    );
    reconciler.close();
  });

  it('close() rejects an in-flight barrier with the typed error (shutdown mid-provision surfaces the retryable arm)', async () => {
    const adapter = new FakeReconcileAdapter();
    adapter.connections.set('host-a', 'conn-1');
    const pull = deferred<unknown>();
    adapter.handlers.workspace_registry_ids = async () => pull.promise;
    const { reconciler } = buildReconciler(adapter);

    reconciler.onHostReady('host-a');
    const gate = reconciler.barrier('host-a');
    reconciler.close();
    await expect(gate).rejects.toBeInstanceOf(
      WorkspaceRegistryReconcilePendingError,
    );
    // Late settle of the in-flight pull must be inert.
    pull.resolve({ ok: true, workspace_ids: ['ghost_after_close'] });
    await Promise.resolve();
    expect(
      adapter.calls.filter(c => c.kind === 'workspace_unbind'),
    ).toEqual([]);
  });
});

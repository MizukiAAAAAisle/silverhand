import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  OutboundServerCommandKind,
  OutboundServerCommandResult,
} from '@silverhand/host';
import { AgentDeletionResumer } from '../../src/application/agent-deletion-resumer.js';
import type {
  AgentDeletionAttempt,
  AgentDeletionLifecyclePort,
} from '../../src/application/agent-teardown-ports.js';
import type { OutboundFrameAdapter } from '../../src/runtime/outbound-frame-adapter.js';
import { HostWsCommandResponseError } from '../../src/ws/host-ws-server.js';

const attempt: AgentDeletionAttempt = {
  agentId: 'agent-1',
  hostId: 'host-1',
  deletionStartedAt: 123,
};

function fakeDeletion(initial: AgentDeletionAttempt[] = []) {
  const pending = new Map(initial.map(item => [item.agentId, item]));
  let completeCalls = 0;
  const port: AgentDeletionLifecyclePort = {
    begin: () => ({ kind: 'notFound' }),
    listPending: () => [...pending.values()],
    complete: item => {
      completeCalls += 1;
      pending.delete(item.agentId);
      return { kind: 'gone' };
    },
  };
  return {
    port,
    pending,
    completeCalls: () => completeCalls,
  };
}

function fakeAdapter(
  send: (call: number, now: number) => Promise<unknown> | unknown,
) {
  let connectionId: string | null = 'generation-1';
  let calls = 0;
  const callTimes: number[] = [];
  const adapter: OutboundFrameAdapter = {
    activeConnectionCount: () => (connectionId ? 1 : 0),
    connectedHostIds: () => (connectionId ? ['host-1'] : []),
    connectionIdForHost: hostId =>
      hostId === 'host-1' ? connectionId : null,
    getAttachment: () => null,
    sendCommand: async <K extends OutboundServerCommandKind>() => {
      calls += 1;
      callTimes.push(Date.now());
      return (await send(calls, Date.now())) as OutboundServerCommandResult<K>;
    },
    close: async () => {},
  };
  return {
    adapter,
    calls: () => calls,
    callTimes,
    setConnectionId: (value: string | null) => {
      connectionId = value;
    },
  };
}

const logger = { info: vi.fn(), warn: vi.fn() };

describe('AgentDeletionResumer', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('boot only discovers work; matching host ready performs the first daemon IO', async () => {
    const deletion = fakeDeletion([attempt]);
    const outbound = fakeAdapter(() => ({
      ok: true,
      purged_count: 1,
      quiesced_count: 2,
    }));
    const resumer = new AgentDeletionResumer({
      deletion: deletion.port,
      adapter: () => outbound.adapter,
      logger,
      onCommitted: vi.fn(),
    });

    expect(outbound.calls()).toBe(0);
    resumer.onHostReady('host-1', 'generation-1');
    await vi.waitFor(() => expect(deletion.completeCalls()).toBe(1));
    expect(outbound.calls()).toBe(1);
    expect(deletion.pending.size).toBe(0);
    resumer.close();
  });

  it('a later request failure owns the exact 1s/5s/30s retry chain without reconnect', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const deletion = fakeDeletion();
    const outbound = fakeAdapter(() => {
      throw new HostWsCommandResponseError(
        'partial_purge' as never,
        'purge remains partial',
        {
          hostId: 'host-1',
          commandKind: 'agent_files_purge',
          requestId: 'test',
        },
      );
    });
    const resumer = new AgentDeletionResumer({
      deletion: deletion.port,
      adapter: () => outbound.adapter,
      logger,
      onCommitted: vi.fn(),
    });

    // Host became ready while there was no boot work.
    resumer.onHostReady('host-1', 'generation-1');
    await Promise.resolve();
    expect(outbound.calls()).toBe(0);

    // Later DELETE persisted the marker, then handed the attempt to this same
    // scheduler without any reconnect event.
    deletion.pending.set(attempt.agentId, attempt);
    const first = await resumer.tryNow(attempt);
    expect(first.kind).toBe('pending');
    expect(outbound.callTimes).toEqual([0]);

    await vi.advanceTimersByTimeAsync(999);
    expect(outbound.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(outbound.callTimes).toEqual([0, 1_000]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(outbound.callTimes).toEqual([0, 1_000, 6_000]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(outbound.callTimes).toEqual([0, 1_000, 6_000, 36_000]);

    // Retry budget is capped for this connection generation. The durable
    // attempt remains discoverable and complete was never entered.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(outbound.calls()).toBe(4);
    expect(deletion.completeCalls()).toBe(0);
    expect(deletion.pending.size).toBe(1);
    resumer.close();
  });

  it('request and ready triggers join one per-agent in-flight purge', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    const deletion = fakeDeletion();
    const outbound = fakeAdapter(async () => {
      await blocked;
      return { ok: true, purged_count: 0, quiesced_count: 0 };
    });
    const resumer = new AgentDeletionResumer({
      deletion: deletion.port,
      adapter: () => outbound.adapter,
      logger,
      onCommitted: vi.fn(),
    });

    const request = resumer.tryNow(attempt);
    await vi.waitFor(() => expect(outbound.calls()).toBe(1));
    resumer.onHostReady('host-1', 'generation-1');
    expect((await resumer.tryNow(attempt)).kind).toBe('alreadyRunning');
    expect(outbound.calls()).toBe(1);
    release();
    await expect(request).resolves.toEqual({ kind: 'completed' });
    expect(deletion.completeCalls()).toBe(1);
    resumer.close();
  });

  it('normalizes an invariant exception to pending and retries successfully at 1s', async () => {
    vi.useFakeTimers();
    const deletion = fakeDeletion();
    deletion.pending.set(attempt.agentId, attempt);
    let completeCalls = 0;
    deletion.port.complete = item => {
      completeCalls += 1;
      if (completeCalls === 1) throw new Error('synthetic commit invariant');
      deletion.pending.delete(item.agentId);
      return { kind: 'gone' };
    };
    const outbound = fakeAdapter(() => ({
      ok: true,
      purged_count: 1,
      quiesced_count: 0,
    }));
    const warn = vi.fn();
    const resumer = new AgentDeletionResumer({
      deletion: deletion.port,
      adapter: () => outbound.adapter,
      logger: { info: vi.fn(), warn },
      onCommitted: vi.fn(),
    });

    const first = await resumer.tryNow(attempt);
    expect(first).toMatchObject({
      kind: 'pending',
      code: 'agent_deletion_attempt_failed',
      message: 'agent deletion could not be completed; retry later',
    });
    expect(JSON.stringify(first)).not.toContain('synthetic commit invariant');
    expect(deletion.pending.has(attempt.agentId)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('retaining durable marker'),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(completeCalls).toBe(2);
    expect(deletion.pending.has(attempt.agentId)).toBe(false);
    await resumer.close();
  });

  it('close rejects new work and drains admitted work before resolving', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    const deletion = fakeDeletion();
    const outbound = fakeAdapter(async () => {
      await blocked;
      return { ok: true, purged_count: 0, quiesced_count: 0 };
    });
    const resumer = new AgentDeletionResumer({
      deletion: deletion.port,
      adapter: () => outbound.adapter,
      logger,
      onCommitted: vi.fn(),
    });

    const admitted = resumer.tryNow(attempt);
    await vi.waitFor(() => expect(outbound.calls()).toBe(1));
    let closed = false;
    const closing = resumer.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(
      resumer.tryNow({ ...attempt, agentId: 'agent-after-close' }),
    ).resolves.toMatchObject({
      kind: 'pending',
      code: 'agent_deletion_worker_closed',
    });
    expect(outbound.calls()).toBe(1);

    release();
    await admitted;
    await closing;
    expect(deletion.completeCalls()).toBe(1);
    expect(outbound.calls()).toBe(1);
  });

  it('connection replacement cancels the old timer and owns a fresh full budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const deletion = fakeDeletion();
    deletion.pending.set(attempt.agentId, attempt);
    const outbound = fakeAdapter(() => {
      throw new HostWsCommandResponseError(
        'partial_purge' as never,
        'still partial',
        {
          hostId: 'host-1',
          commandKind: 'agent_files_purge',
          requestId: 'replace',
        },
      );
    });
    const resumer = new AgentDeletionResumer({
      deletion: deletion.port,
      adapter: () => outbound.adapter,
      logger,
      onCommitted: vi.fn(),
    });

    await resumer.tryNow(attempt); // old generation immediate + old 1s timer
    outbound.setConnectionId('generation-2');
    resumer.onHostReady('host-1', 'generation-2'); // new immediate, resets budget
    await Promise.resolve();
    expect(outbound.callTimes).toEqual([0, 0]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(outbound.callTimes).toEqual([0, 0, 1_000, 6_000, 36_000]);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(outbound.calls()).toBe(5);
    await resumer.close();
  });
});

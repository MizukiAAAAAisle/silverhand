import { describe, expect, it, vi } from 'vitest';
import type { AgentRunState } from '@silverhand/shared';
import {
  HostRuntimeDisabledError,
  OutboundAgentRuntimeHost,
  type OutboundAgentRuntimeProjection,
} from '../../src/runtime/outbound-agent-runtime-host.js';

const SILENT_LOGGER = { info() {}, warn() {}, error() {} };

/**
 * A spy projection that records every method call. Any method the host
 * forwards lands in `calls`; methods the host MUST NOT call (there is no
 * `setConversationLogDebug` on the projection at all) cannot appear by
 * construction — the absence is the point.
 */
function makeSpyProjection(): {
  projection: OutboundAgentRuntimeProjection;
  calls: string[];
} {
  const calls: string[] = [];
  const projection: OutboundAgentRuntimeProjection = {
    start: async (...a) => {
      calls.push(`start:${a.join(',')}`);
    },
    deliverPending: async (...a) => {
      calls.push(`deliverPending:${a.join(',')}`);
      return true;
    },
    stop: async (...a) => {
      calls.push(`stop:${a.join(',')}`);
    },
    clearSession: async (...a) => {
      calls.push(`clearSession:${JSON.stringify(a[0])},${a[1] ?? ''}`);
      return {
        prevCliSessionId: null,
        wasRunning: false,
        focusConversationId: null,
      };
    },
    deliverMessage: async (...a) => {
      calls.push(`deliverMessage:${a.join(',')}`);
    },
    getAgentRunStates: (): AgentRunState[] => {
      calls.push('getAgentRunStates');
      return [];
    },
    getAgentRuntimeFocus: () => null,
    resolveRun: (...a) => {
      calls.push(`resolveRun:${a.join(',')}`);
    },
    resolveConversationRuns: (...a) => {
      calls.push(`resolveConversationRuns:${a.join(',')}`);
    },
    stopAll: async () => {
      calls.push('stopAll');
    },
    reapIdleRuntimes: async opts => {
      calls.push(`reapIdleRuntimes:${opts.ttlMs},${opts.now ?? ''}`);
      return { considered: 0, eligible: 0, reaped: 0, skipped: 0, failed: 0 };
    },
    closeActivityLog: async () => {
      calls.push('closeActivityLog');
    },
  };
  return { projection, calls };
}

describe('OutboundAgentRuntimeHost', () => {
  // ── D5.a-3 Pin 2 (Cindy `Ixbm39eKMSQpZ-LW` #3) ──
  //
  // `setConversationLogDebug` is DELIBERATELY retired to a backend-only
  // no-op in D5.a — NOT a TODO gap. The outbound command set has no
  // `conversation_log_debug` intent (it only ever lived in the legacy
  // local IPC protocol). The route owns the source of truth by toggling
  // `ctx.logControl`; the host call must therefore succeed whether or not
  // a daemon is attached, and must never reach for the projection (which
  // has no log-debug method to begin with).
  it('setConversationLogDebug succeeds with NO projection attached (backend-only retire, never throws)', async () => {
    const host = new OutboundAgentRuntimeHost(SILENT_LOGGER, () => null);
    await expect(
      host.setConversationLogDebug('conv-1', true, Date.now() + 1000),
    ).resolves.toBeUndefined();
    await expect(
      host.setConversationLogDebug('conv-1', false, null),
    ).resolves.toBeUndefined();
  });

  it('setConversationLogDebug never dispatches to the projection even when one IS attached', async () => {
    const { projection, calls } = makeSpyProjection();
    const host = new OutboundAgentRuntimeHost(SILENT_LOGGER, () => projection);
    await host.setConversationLogDebug('conv-1', true, Date.now() + 1000);
    await host.setConversationLogDebug('conv-1', false, null);
    // No outbound conversation_log_debug intent exists; the host must not
    // touch the projection at all for log-debug.
    expect(calls).toEqual([]);
  });

  // ── D5.a-3 Pin 3 delegation (P1-4) ──
  //
  // stopAll / closeActivityLog delegate to the projection (which fans the
  // real outbound `runtime_stop_all` / `runtime_close_activity_log` out
  // per connected host — pinned at the fanout layer). Here we pin the host
  // forwards them and, critically, does NOT silently drop them.
  it('stopAll / closeActivityLog delegate to the projection', async () => {
    const { projection, calls } = makeSpyProjection();
    const host = new OutboundAgentRuntimeHost(SILENT_LOGGER, () => projection);
    await host.stopAll();
    await host.closeActivityLog();
    expect(calls).toEqual(['stopAll', 'closeActivityLog']);
  });

  it('stopAll / closeActivityLog are safe no-ops when no projection is attached', async () => {
    const host = new OutboundAgentRuntimeHost(SILENT_LOGGER, () => null);
    await expect(host.stopAll()).resolves.toBeUndefined();
    await expect(host.closeActivityLog()).resolves.toBeUndefined();
  });

  it('reapIdleRuntimes delegates to the projection and no-ops without one', async () => {
    const empty = new OutboundAgentRuntimeHost(SILENT_LOGGER, () => null);
    await expect(
      empty.reapIdleRuntimes({ ttlMs: 123, now: 456 }),
    ).resolves.toEqual({
      considered: 0,
      eligible: 0,
      reaped: 0,
      skipped: 0,
      failed: 0,
    });

    const { projection, calls } = makeSpyProjection();
    const host = new OutboundAgentRuntimeHost(SILENT_LOGGER, () => projection);
    await expect(
      host.reapIdleRuntimes({ ttlMs: 123, now: 456 }),
    ).resolves.toEqual({
      considered: 0,
      eligible: 0,
      reaped: 0,
      skipped: 0,
      failed: 0,
    });
    expect(calls).toContain('reapIdleRuntimes:123,456');
  });

  // ── Fail-loud surface for the runtime-bearing methods ──
  //
  // Unlike the retired log-debug + best-effort shutdown methods above,
  // start/stop/clearSession/deliverMessage MUST fail loud (typed) when no
  // daemon transport is attached — routes map `HostRuntimeDisabledError`
  // to 409/503. A silent success here would strand the caller.
  it('start throws HostRuntimeDisabledError when nothing is delivery-backed', async () => {
    const host = new OutboundAgentRuntimeHost(SILENT_LOGGER, () => null);
    await expect(host.start('conv-1', 'agent-1')).rejects.toBeInstanceOf(
      HostRuntimeDisabledError,
    );
  });

  it('stop / clearSession / deliverMessage throw HostRuntimeDisabledError with no projection', async () => {
    const host = new OutboundAgentRuntimeHost(SILENT_LOGGER, () => null);
    await expect(host.stop('conv-1', 'agent-1')).rejects.toBeInstanceOf(
      HostRuntimeDisabledError,
    );
    await expect(
      host.clearSession({
        kind: 'conversation',
        conversationId: 'conv-1',
        agentId: 'agent-1',
      }),
    ).rejects.toBeInstanceOf(HostRuntimeDisabledError);
    await expect(
      host.deliverMessage('conv-1', 'agent-1', 'msg-1'),
    ).rejects.toBeInstanceOf(HostRuntimeDisabledError);
  });

  it('start delegates to the projection', async () => {
    const { projection, calls } = makeSpyProjection();
    const host = new OutboundAgentRuntimeHost(SILENT_LOGGER, () => projection);
    await expect(host.start('conv-1', 'agent-1')).resolves.toBeUndefined();
    expect(calls).toContain('start:conv-1,agent-1');
  });

  it('start propagates projection failures', async () => {
    const calls: string[] = [];
    const projection = {
      ...makeSpyProjection().projection,
      start: async () => {
        calls.push('start');
        throw new Error('start failed');
      },
    } satisfies OutboundAgentRuntimeProjection;
    const host = new OutboundAgentRuntimeHost(SILENT_LOGGER, () => projection);
    await expect(host.start('conv-1', 'agent-1')).rejects.toThrow('start failed');
    expect(calls).toEqual(['start']);
  });

  it('reconcileOnBoot is a no-op and does not throw', () => {
    const host = new OutboundAgentRuntimeHost(SILENT_LOGGER, () => null);
    expect(() => host.reconcileOnBoot()).not.toThrow();
  });

  it('getAgentRunStates returns [] when no projection is attached', () => {
    const host = new OutboundAgentRuntimeHost(SILENT_LOGGER);
    expect(host.getAgentRunStates('conv-1')).toEqual([]);
  });

  it('passes a vi spy projection through for resolveRun delegation', () => {
    const projection = makeSpyProjection().projection;
    const spy = vi.spyOn(projection, 'resolveRun');
    const host = new OutboundAgentRuntimeHost(SILENT_LOGGER, () => projection);
    host.resolveRun('conv-1', 'agent-1', 'stopped', 'run-1');
    expect(spy).toHaveBeenCalledWith('conv-1', 'agent-1', 'stopped', 'run-1');
  });
});

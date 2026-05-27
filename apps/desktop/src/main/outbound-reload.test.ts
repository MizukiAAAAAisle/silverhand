/**
 * Stage D3.c Commit 3 — orchestrator tests for `performOutboundReload`.
 *
 * Coverage strategy: every dep is faked so the orchestration logic
 * is exercised without disk / WS / IPC. Tests focus on:
 *
 *   1. **Anchor 1 (raw input classify)** — `classify_rejected`
 *      surfaces all `ServerUrlRejectionReason` values verbatim;
 *      classify failure ALWAYS short-circuits BEFORE any write or
 *      IPC fire.
 *   2. **Anchor 2 (atomic write before reload)** — a write failure
 *      MUST NOT fire the reload IPC; a successful write happens
 *      BEFORE the snapshot's freshness lower bound is consumed by
 *      the watchdog.
 *   3. **Anchor 3 (reloaded ≠ connected)** — `action: 'reloaded'`
 *      goes through the watchdog using the same predicate as
 *      `outbound-attach`; `action: 'unchanged'` skips the watchdog.
 *   4. **Order pinning** — snapshot captured BEFORE write so the
 *      watchdog accepts attachments stamped between snapshot and
 *      IPC ack (mirrors the attach-side freshness contract).
 *   5. **Daemon reason pass-through** — every failure arm
 *      (`not_attached` / `config_unreadable` / `parse_failed` /
 *      `invalid_server_url`) reaches the renderer as-is.
 */
import { describe, expect, it, vi } from 'vitest';
import type { HostWsAttachment } from '@silverhand/backend';
import type {
  DaemonHostConfig,
  ServerUrlClassification,
} from '@silverhand/shared';
import type { HostOutboundReloadResult } from '@silverhand/host';
import type {
  AttachWatchdogOutcome,
  ExpectedAttachWindow,
  AttachWatchdogDeps,
} from './outbound-attach.js';
import {
  performOutboundReload,
  type PerformOutboundReloadDeps,
} from './outbound-reload.js';

interface FakeState {
  classifyCalls: string[];
  writeCalls: DaemonHostConfig[];
  reloadCalls: number;
  watchdogCalls: {
    window: ExpectedAttachWindow;
    deps: AttachWatchdogDeps;
  }[];
}

function makeAttachment(overrides?: Partial<HostWsAttachment>): HostWsAttachment {
  return {
    hostId: 'host-1',
    connectionId: 'conn-old',
    attachedAt: 1_700_000_000_000,
    ...overrides,
  };
}

interface FakeOptions {
  classify?: (input: string) => ServerUrlClassification;
  writeThrows?: Error;
  reloadResult?: HostOutboundReloadResult;
  reloadThrows?: Error;
  attachment?: HostWsAttachment | null;
  /** When provided, watchdog resolves with this outcome immediately. */
  watchdogOutcome?: AttachWatchdogOutcome;
  hostId?: string | null;
  hostToken?: string | null;
  /** Defaults to a fixed clock starting at 1_700_000_010_000. */
  now?: () => number;
}

function makeDeps(opts: FakeOptions = {}): {
  deps: PerformOutboundReloadDeps;
  state: FakeState;
} {
  const state: FakeState = {
    classifyCalls: [],
    writeCalls: [],
    reloadCalls: 0,
    watchdogCalls: [],
  };
  const defaultClassify = (input: string): ServerUrlClassification => {
    if (input === '__bad__') {
      return { ok: false, reason: 'malformed_url', message: 'Invalid URL' };
    }
    return { ok: true, kind: 'loopback', url: new URL(input) };
  };
  const reloadResult: HostOutboundReloadResult =
    opts.reloadResult ?? {
      reloaded: true,
      action: 'reloaded',
      config_path: '/fake/daemon-config.json',
      host_id: 'host-1',
    };
  const deps: PerformOutboundReloadDeps = {
    classifyServerUrl: input => {
      state.classifyCalls.push(input);
      return (opts.classify ?? defaultClassify)(input);
    },
    writeDaemonHostConfig: config => {
      if (opts.writeThrows) throw opts.writeThrows;
      state.writeCalls.push(config);
    },
    hostOutboundReload: async () => {
      state.reloadCalls += 1;
      if (opts.reloadThrows) throw opts.reloadThrows;
      return reloadResult;
    },
    getAttachment: _id => opts.attachment ?? null,
    currentLocalHostId: () =>
      opts.hostId === undefined ? 'host-1' : opts.hostId,
    currentHostToken: () =>
      opts.hostToken === undefined ? 'tok-1' : opts.hostToken,
    startWatchdog: (window, watchdogDeps) => {
      state.watchdogCalls.push({ window, deps: watchdogDeps });
      const outcome: AttachWatchdogOutcome =
        opts.watchdogOutcome ?? {
          ok: true,
          attachment: makeAttachment({ connectionId: 'conn-new', attachedAt: 1_700_000_011_000 }),
          elapsedMs: 30,
        };
      return {
        promise: Promise.resolve(outcome),
        abort: () => {},
      };
    },
    now: opts.now ?? (() => 1_700_000_010_000),
  };
  return { deps, state };
}

describe('performOutboundReload — anchor 1: raw input classify', () => {
  it('classify_rejected surfaces malformed_url verbatim and skips write + IPC', async () => {
    const { deps, state } = makeDeps();
    const out = await performOutboundReload({ serverUrl: '__bad__' }, deps);
    expect(out).toEqual({
      ok: false,
      kind: 'classify_rejected',
      reason: 'malformed_url',
      message: 'Invalid URL',
    });
    expect(state.writeCalls).toEqual([]);
    expect(state.reloadCalls).toBe(0);
    expect(state.watchdogCalls).toEqual([]);
  });

  it('classify_rejected with non_loopback_host short-circuits identically', async () => {
    const { deps, state } = makeDeps({
      classify: () => ({
        ok: false,
        reason: 'non_loopback_host',
        message: "Backend host 'example.com' is not a loopback address.",
      }),
    });
    const out = await performOutboundReload({ serverUrl: 'http://example.com' }, deps);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    if (out.kind !== 'classify_rejected') throw new Error('unreachable');
    expect(out.reason).toBe('non_loopback_host');
    expect(state.writeCalls).toEqual([]);
    expect(state.reloadCalls).toBe(0);
  });

  it('classify_rejected with unsupported_scheme short-circuits identically', async () => {
    const { deps, state } = makeDeps({
      classify: () => ({
        ok: false,
        reason: 'unsupported_scheme',
        message: "Unsupported scheme 'ws:'.",
      }),
    });
    const out = await performOutboundReload({ serverUrl: 'ws://127.0.0.1' }, deps);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    if (out.kind !== 'classify_rejected') throw new Error('unreachable');
    expect(out.reason).toBe('unsupported_scheme');
    expect(state.writeCalls).toEqual([]);
  });
});

describe('performOutboundReload — preconditions', () => {
  it('returns reload_rejected/not_attached when no current local host id (renderer never sees an IPC fire)', async () => {
    const { deps, state } = makeDeps({ hostId: null });
    const out = await performOutboundReload(
      { serverUrl: 'http://127.0.0.1:8765' },
      deps,
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    if (out.kind !== 'reload_rejected') throw new Error('unreachable');
    expect(out.reason).toBe('not_attached');
    expect(state.writeCalls).toEqual([]);
    expect(state.reloadCalls).toBe(0);
  });

  it('returns reload_rejected/not_attached when no in-memory host token', async () => {
    const { deps, state } = makeDeps({ hostToken: null });
    const out = await performOutboundReload(
      { serverUrl: 'http://127.0.0.1:8765' },
      deps,
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    if (out.kind !== 'reload_rejected') throw new Error('unreachable');
    expect(out.reason).toBe('not_attached');
    expect(state.writeCalls).toEqual([]);
    expect(state.reloadCalls).toBe(0);
  });
});

describe('performOutboundReload — anchor 2: atomic write before reload IPC', () => {
  it('config_write_failed surfaces the throw message and MUST NOT fire the reload IPC', async () => {
    const { deps, state } = makeDeps({
      writeThrows: new Error('EACCES /fake/daemon-config.json'),
    });
    const out = await performOutboundReload(
      { serverUrl: 'http://127.0.0.1:8765' },
      deps,
    );
    expect(out).toEqual({
      ok: false,
      kind: 'config_write_failed',
      message: 'EACCES /fake/daemon-config.json',
    });
    expect(state.reloadCalls).toBe(0);
    expect(state.watchdogCalls).toEqual([]);
  });

  it('writes normalized URL form (not raw input) — keeps on-disk config tidy across save cycles', async () => {
    const { deps, state } = makeDeps();
    // URL constructor strips default port 80 for http: and lowercases
    // scheme/host, so a trailing slash / mixed case input becomes a
    // canonical form on disk.
    await performOutboundReload(
      { serverUrl: 'HTTP://127.0.0.1:80/' },
      deps,
    );
    expect(state.writeCalls).toHaveLength(1);
    expect(state.writeCalls[0]!.server_url).toBe('http://127.0.0.1/');
  });

  it('write happens BEFORE reload IPC (sequence pin)', async () => {
    const { deps, state } = makeDeps();
    let writeIndex = -1;
    let reloadIndex = -1;
    let counter = 0;
    deps.writeDaemonHostConfig = config => {
      writeIndex = counter++;
      state.writeCalls.push(config);
    };
    deps.hostOutboundReload = async () => {
      reloadIndex = counter++;
      state.reloadCalls += 1;
      return {
        reloaded: true,
        action: 'unchanged',
        config_path: '/fake',
        host_id: 'host-1',
      };
    };
    await performOutboundReload(
      { serverUrl: 'http://127.0.0.1:8765' },
      deps,
    );
    expect(writeIndex).toBeGreaterThanOrEqual(0);
    expect(reloadIndex).toBeGreaterThanOrEqual(0);
    expect(writeIndex).toBeLessThan(reloadIndex);
  });
});

describe('performOutboundReload — daemon reason pass-through', () => {
  const reasons: ReadonlyArray<
    'not_attached' | 'config_unreadable' | 'parse_failed' | 'invalid_server_url'
  > = ['not_attached', 'config_unreadable', 'parse_failed', 'invalid_server_url'];

  for (const reason of reasons) {
    it(`reload reason=${reason} is surfaced verbatim as reload_rejected`, async () => {
      const { deps, state } = makeDeps({
        reloadResult: { reloaded: false, reason, message: `daemon said: ${reason}` },
      });
      const out = await performOutboundReload(
        { serverUrl: 'http://127.0.0.1:8765' },
        deps,
      );
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('unreachable');
      expect(out.kind).toBe('reload_rejected');
      if (out.kind !== 'reload_rejected') throw new Error('unreachable');
      expect(out.reason).toBe(reason);
      expect(out.message).toBe(`daemon said: ${reason}`);
      // Write happened (we sent the IPC with the new bytes), but
      // the watchdog DID NOT fire — daemon refused to swap, so
      // there's no fresh attachment to wait for.
      expect(state.writeCalls).toHaveLength(1);
      expect(state.watchdogCalls).toEqual([]);
    });
  }

  it('reload IPC transport failure maps to reload_rejected/not_attached with the throw message', async () => {
    const { deps, state } = makeDeps({
      reloadThrows: new Error('socket closed mid-call'),
    });
    const out = await performOutboundReload(
      { serverUrl: 'http://127.0.0.1:8765' },
      deps,
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.kind).toBe('reload_rejected');
    if (out.kind !== 'reload_rejected') throw new Error('unreachable');
    expect(out.reason).toBe('not_attached');
    expect(out.message).toBe('socket closed mid-call');
    expect(state.watchdogCalls).toEqual([]);
  });
});

describe('performOutboundReload — anchor 3: reloaded ≠ connected', () => {
  it('action=unchanged skips the watchdog and returns success directly (no WS bounce)', async () => {
    const { deps, state } = makeDeps({
      reloadResult: {
        reloaded: true,
        action: 'unchanged',
        config_path: '/fake',
        host_id: 'host-1',
      },
    });
    const out = await performOutboundReload(
      { serverUrl: 'http://127.0.0.1:8765' },
      deps,
    );
    expect(out).toEqual({ ok: true, kind: 'unchanged' });
    expect(state.watchdogCalls).toEqual([]);
  });

  it('action=unchanged succeeds even when getAttachment is null — no_attachment_controller MUST gate only the reloaded-watchdog path (Cindy `#task:634` review note 2)', async () => {
    // Concern: if the orchestrator gated `no_attachment_controller`
    // before the unchanged short-circuit, a save-with-no-byte-change
    // would surface as `no_attachment_controller` whenever the
    // backend mode lacks a HostWsController — even though there's
    // no swap and no reconnect to verify. The controller check
    // belongs strictly on the path that actually NEEDS a fresh
    // attachment.
    const { deps, state } = makeDeps({
      reloadResult: {
        reloaded: true,
        action: 'unchanged',
        config_path: '/fake',
        host_id: 'host-1',
      },
    });
    deps.getAttachment = null;
    const out = await performOutboundReload(
      { serverUrl: 'http://127.0.0.1:8765' },
      deps,
    );
    expect(out).toEqual({ ok: true, kind: 'unchanged' });
    expect(state.watchdogCalls).toEqual([]);
  });

  it('action=reloaded fires the watchdog with the pre-write snapshot', async () => {
    const prev = makeAttachment({ connectionId: 'conn-pre', attachedAt: 1_699_999_000_000 });
    const { deps, state } = makeDeps({ attachment: prev });
    const out = await performOutboundReload(
      { serverUrl: 'http://127.0.0.1:8765' },
      deps,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('unreachable');
    expect(out.kind).toBe('reloaded');
    expect(state.watchdogCalls).toHaveLength(1);
    const window = state.watchdogCalls[0]!.window;
    expect(window).toEqual({
      expectedHostId: 'host-1',
      previousConnectionId: 'conn-pre',
      expectAttachSince: 1_700_000_010_000,
    });
  });

  it('action=reloaded + watchdog success returns kind=reloaded with elapsedMs and attachedAt', async () => {
    const fresh = makeAttachment({ connectionId: 'conn-new', attachedAt: 1_700_000_011_000 });
    const { deps } = makeDeps({
      watchdogOutcome: { ok: true, attachment: fresh, elapsedMs: 42 },
    });
    const out = await performOutboundReload(
      { serverUrl: 'http://127.0.0.1:8765' },
      deps,
    );
    expect(out).toEqual({
      ok: true,
      kind: 'reloaded',
      elapsedMs: 42,
      attachedAt: 1_700_000_011_000,
    });
  });

  it('action=reloaded + watchdog timeout returns success-arm connectivity_unverified (NOT a failure)', async () => {
    // The user's CONFIG IS SAVED — the daemon acked `reloaded: true`.
    // Timeout means "we didn't observe the new WS within budget",
    // which most often means the backend is unreachable on the new
    // URL. Surfacing this as a failure would mislead the user into
    // thinking their save was lost. Mirrors the D3.a attach-side
    // policy where UI status stays `connecting` on timeout.
    const { deps } = makeDeps({
      watchdogOutcome: { ok: false, reason: 'timeout', elapsedMs: 10_000 },
    });
    const out = await performOutboundReload(
      { serverUrl: 'http://127.0.0.1:8765' },
      deps,
    );
    expect(out).toEqual({
      ok: true,
      kind: 'connectivity_unverified',
      elapsedMs: 10_000,
    });
  });

  it('action=reloaded + getAttachment null returns no_attachment_controller (caller saw daemon ack reload but cannot observe WS)', async () => {
    const { deps, state } = makeDeps();
    deps.getAttachment = null;
    const out = await performOutboundReload(
      { serverUrl: 'http://127.0.0.1:8765' },
      deps,
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.kind).toBe('no_attachment_controller');
    // Write happened (config IS updated on disk); just no controller.
    expect(state.writeCalls).toHaveLength(1);
    expect(state.watchdogCalls).toEqual([]);
  });
});

describe('performOutboundReload — anchor 3 freshness contract pin', () => {
  it('snapshot expectAttachSince is captured BEFORE writeDaemonHostConfig (not after, not after IPC ack)', async () => {
    // If the lower bound were captured AFTER the write or AFTER the
    // IPC, an attachment whose attachedAt got stamped between the
    // write and the snapshot would fail `attachedAt >=
    // expectAttachSince` and the watchdog would loop until the
    // connectionId branch caught it or the budget expired. We pin
    // the BEFORE-write order by making `now()` advance through the
    // call and asserting the snapshot equals the value sampled
    // BEFORE the write callback ran.
    const ticks: number[] = [];
    let counter = 1_700_000_010_000;
    const now = (): number => {
      counter += 1;
      ticks.push(counter);
      return counter;
    };
    const { deps, state } = makeDeps({ now });
    // Record the value `now` was at just before the write fired.
    let preWriteNow = -1;
    deps.writeDaemonHostConfig = config => {
      // The orchestrator must have already sampled now() into
      // expectAttachSince at this point — before the write call.
      preWriteNow = counter;
      state.writeCalls.push(config);
    };
    await performOutboundReload(
      { serverUrl: 'http://127.0.0.1:8765' },
      deps,
    );
    expect(state.watchdogCalls).toHaveLength(1);
    const expect_since = state.watchdogCalls[0]!.window.expectAttachSince;
    // expect_since was taken BEFORE write (i.e. <= preWriteNow,
    // since preWriteNow was sampled at write-call time AFTER
    // expectAttachSince was already set).
    expect(expect_since).toBeLessThanOrEqual(preWriteNow);
  });

  it('previousConnectionId is captured from the snapshot BEFORE write (not from a post-reload re-snapshot)', async () => {
    // Two get-attachment calls would be a regression: one for the
    // snapshot and one for the watchdog. The watchdog deps re-poll
    // independently, but the WINDOW (used by the predicate) must
    // freeze the pre-write connectionId so the predicate's
    // connection-id branch fires when the WS reconnects with a
    // NEW connection id.
    const prev = makeAttachment({ connectionId: 'conn-frozen-pre-write' });
    const { deps, state } = makeDeps({ attachment: prev });
    await performOutboundReload(
      { serverUrl: 'http://127.0.0.1:8765' },
      deps,
    );
    expect(state.watchdogCalls).toHaveLength(1);
    expect(state.watchdogCalls[0]!.window.previousConnectionId).toBe(
      'conn-frozen-pre-write',
    );
  });
});

describe('performOutboundReload — happy path end-to-end shape', () => {
  it('writes host_token from currentHostToken (not from input) so renderer NEVER provides token bytes', async () => {
    const { deps, state } = makeDeps({ hostToken: 'secret-from-main-memory' });
    await performOutboundReload(
      { serverUrl: 'http://127.0.0.1:8765' },
      deps,
    );
    expect(state.writeCalls[0]).toEqual({
      server_url: 'http://127.0.0.1:8765/',
      host_id: 'host-1',
      host_token: 'secret-from-main-memory',
    });
  });
});

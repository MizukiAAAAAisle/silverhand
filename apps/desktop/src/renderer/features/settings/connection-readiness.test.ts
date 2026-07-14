import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  desktopServerConnectionStatus,
  isDesktopServerReadyAfterSave,
} from './connection-readiness';

describe('isDesktopServerReadyAfterSave — falsifier: local IPC freshness alone is NOT reachability', () => {
  it('remote save succeeds but the renderer WS never (re)connects — banner may NOT dismiss', () => {
    // The save mutation resolved (URL bytes written), but the event WS
    // is still disconnected because the (new) server is unreachable.
    // A prior implementation that watched `backendInfoQuery.dataUpdatedAt`
    // would falsely dismiss here because the local `backend:info` IPC
    // resolves regardless of remote reachability.
    expect(
      isDesktopServerReadyAfterSave({
        mode: 'remote',
        attachedAt: null,
        localHostStatus: 'claimed',
        wsStatus: 'disconnected',
        wsConnectedAt: null,
        savedAt: 1_000,
      }),
    ).toBe(false);
  });

  it('embedded save succeeds but the daemon never re-attaches — banner may NOT dismiss', () => {
    // Same falsifier for embedded mode: `local_host_ws_attached_at`
    // stays NULL (or at its old value) while the daemon retries the
    // unreachable backend. IPC-freshness would lie; this predicate
    // returns false.
    expect(
      isDesktopServerReadyAfterSave({
        mode: 'embedded',
        attachedAt: null,
        localHostStatus: 'claimed',
        wsStatus: 'connected',
        wsConnectedAt: 500,
        savedAt: 1_000,
      }),
    ).toBe(false);
    // Old attachedAt (from the previous URL) does not count as proof
    // for this save either — the timestamp must move forward past savedAt.
    expect(
      isDesktopServerReadyAfterSave({
        mode: 'embedded',
        attachedAt: 500,
        localHostStatus: 'claimed',
        wsStatus: 'connected',
        wsConnectedAt: null,
        savedAt: 1_000,
      }),
    ).toBe(false);
  });
});

describe('isDesktopServerReadyAfterSave — embedded terminal / pre-claim gates', () => {
  it('embedded terminal state with a stale post-save attachedAt does NOT count as ready', () => {
    // Falsifier for "stale timestamp on a terminal row." A row moves to
    // `revoked` / `error` / `failed` while `attachedAt` still holds the
    // last observed attach. The timestamp math (attachedAt >= savedAt)
    // would pass on its own — the status gate is what stops it.
    for (const localHostStatus of ['revoked', 'error', 'failed'] as const) {
      expect(
        isDesktopServerReadyAfterSave({
          mode: 'embedded',
          attachedAt: 1_500,
          localHostStatus,
          wsStatus: 'idle',
          wsConnectedAt: null,
          savedAt: 1_000,
        }),
      ).toBe(false);
    }
  });

  it('embedded pre-claim (unclaimed) has no attach to wait for — not ready', () => {
    expect(
      isDesktopServerReadyAfterSave({
        mode: 'embedded',
        attachedAt: null,
        localHostStatus: 'unclaimed',
        wsStatus: 'idle',
        wsConnectedAt: null,
        savedAt: 1_000,
      }),
    ).toBe(false);
  });

  it('two-input proof of the polling contract: first poll null → next poll attaches → ready', () => {
    // Simulates what `pollWhileConnecting` buys us at the consumer edge.
    // A projection with no polling settles on the first (pre-attach)
    // input forever; this test locks that a subsequent input with a
    // post-save attachedAt DOES flip ready → true.
    const savedAt = 1_000;
    const first = isDesktopServerReadyAfterSave({
      mode: 'embedded',
      attachedAt: null,
      localHostStatus: 'claimed',
      wsStatus: 'idle',
      wsConnectedAt: null,
      savedAt,
    });
    const second = isDesktopServerReadyAfterSave({
      mode: 'embedded',
      attachedAt: 1_500,
      localHostStatus: 'claimed',
      wsStatus: 'idle',
      wsConnectedAt: null,
      savedAt,
    });
    expect(first).toBe(false);
    expect(second).toBe(true);
  });
});

describe('isDesktopServerReadyAfterSave — remote current-state gate', () => {
  it('post-save WS connected but subsequently dropped — historical wsConnectedAt is NOT enough', () => {
    // Falsifier for "was briefly connected then dropped": the WS
    // authenticated after save (wsConnectedAtRef moved past savedAt),
    // then the new server dropped the socket. A prior implementation
    // that only read wsConnectedAt >= savedAt would clear the banner
    // while the persistent pip is already back to Offline, which is
    // worse than not clearing at all.
    expect(
      isDesktopServerReadyAfterSave({
        mode: 'remote',
        attachedAt: null,
        localHostStatus: 'claimed',
        wsStatus: 'disconnected',
        wsConnectedAt: 1_500,
        savedAt: 1_000,
      }),
    ).toBe(false);
    // Also covers the intermediate re-authenticating state — historical
    // proof isn't enough while the current connection is unsettled.
    expect(
      isDesktopServerReadyAfterSave({
        mode: 'remote',
        attachedAt: null,
        localHostStatus: 'claimed',
        wsStatus: 'authenticating',
        wsConnectedAt: 1_500,
        savedAt: 1_000,
      }),
    ).toBe(false);
  });

  it('post-save WS connected AND still connected right now → ready', () => {
    expect(
      isDesktopServerReadyAfterSave({
        mode: 'remote',
        attachedAt: null,
        localHostStatus: 'claimed',
        wsStatus: 'connected',
        wsConnectedAt: 1_500,
        savedAt: 1_000,
      }),
    ).toBe(true);
  });
});

describe('isDesktopServerReadyAfterSave — real proof of reachability', () => {
  it('remote: renderer WS transitioned to connected AFTER save → ready', () => {
    expect(
      isDesktopServerReadyAfterSave({
        mode: 'remote',
        attachedAt: null,
        localHostStatus: 'claimed',
        wsStatus: 'connected',
        wsConnectedAt: 1_500,
        savedAt: 1_000,
      }),
    ).toBe(true);
  });

  it('embedded: daemon attach timestamp moved forward past save on a claimed row → ready', () => {
    expect(
      isDesktopServerReadyAfterSave({
        mode: 'embedded',
        attachedAt: 1_500,
        localHostStatus: 'claimed',
        wsStatus: 'idle',
        wsConnectedAt: null,
        savedAt: 1_000,
      }),
    ).toBe(true);
  });

  it('no save in progress → not ready (nothing to dismiss)', () => {
    expect(
      isDesktopServerReadyAfterSave({
        mode: 'remote',
        attachedAt: 5_000,
        localHostStatus: 'claimed',
        wsStatus: 'connected',
        wsConnectedAt: 5_000,
        savedAt: null,
      }),
    ).toBe(false);
  });

  it('remote WS connected but the transition predates the save → not ready (stale proof)', () => {
    expect(
      isDesktopServerReadyAfterSave({
        mode: 'remote',
        attachedAt: null,
        localHostStatus: 'claimed',
        wsStatus: 'connected',
        wsConnectedAt: 500,
        savedAt: 1_000,
      }),
    ).toBe(false);
  });
});

describe('desktopServerConnectionStatus — persistent status pip', () => {
  it('remote maps WS status directly to the three-tone connection view', () => {
    for (const [wsStatus, expected] of [
      ['idle', 'offline'],
      ['connecting', 'connecting'],
      ['authenticating', 'connecting'],
      ['connected', 'connected'],
      ['disconnected', 'offline'],
    ] as const) {
      expect(
        desktopServerConnectionStatus({
          mode: 'remote',
          attachedAt: 999,
          localHostStatus: 'claimed',
          wsStatus,
        }),
      ).toBe(expected);
    }
  });

  it('embedded: claimed + attachedAt → connected; claimed + null → connecting', () => {
    // The "connecting" mid-state is real (daemon-outbound-attach window)
    // — surfacing it truthfully is what stops the pip from lying about
    // reachability while the daemon is still dialing.
    expect(
      desktopServerConnectionStatus({
        mode: 'embedded',
        attachedAt: 1_000,
        localHostStatus: 'claimed',
        wsStatus: 'disconnected',
      }),
    ).toBe('connected');
    expect(
      desktopServerConnectionStatus({
        mode: 'embedded',
        attachedAt: null,
        localHostStatus: 'claimed',
        wsStatus: 'disconnected',
      }),
    ).toBe('connecting');
  });

  it('embedded: terminal state with stale attachedAt → offline (does NOT read as connected)', () => {
    // Regression guard — the earlier `attachedAt !== null` shortcut
    // would have called this Connected even after the row terminated.
    for (const localHostStatus of ['revoked', 'error', 'failed'] as const) {
      expect(
        desktopServerConnectionStatus({
          mode: 'embedded',
          attachedAt: 5_000,
          localHostStatus,
          wsStatus: 'connected',
        }),
      ).toBe('offline');
    }
  });

  it('embedded: pre-claim (unclaimed) → offline (no attach expected yet)', () => {
    expect(
      desktopServerConnectionStatus({
        mode: 'embedded',
        attachedAt: null,
        localHostStatus: 'unclaimed',
        wsStatus: 'connected',
      }),
    ).toBe('offline');
  });
});

describe('ConnectionPane consumer contract', () => {
  const CONNECTION_PANE_SRC = readFileSync(
    path.join(
      fileURLToPath(new URL('./ConnectionPane.tsx', import.meta.url)),
    ),
    'utf8',
  );

  // Strip comments so a docstring that names a removed API can't pass a
  // negative assertion (same discipline as SettingsPage.test.ts).
  const CONNECTION_PANE_CODE = CONNECTION_PANE_SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('opts into pollWhileConnecting so attachedAt / localHostStatus refresh during the connecting window', () => {
    // Without this option the readiness derivation is correct but frozen
    // — the projection settles on the pre-attach snapshot forever and
    // the banner never dismisses. Locked as a source fence because
    // React Query polling is invisible to pure unit tests.
    expect(CONNECTION_PANE_CODE).toMatch(
      /useBackendInfoSnapshot\(\{[\s\S]*?pollWhileConnecting:\s*true[\s\S]*?\}\)/,
    );
  });

  it('passes localHostStatus into both readiness projections', () => {
    // Guards against silently re-dropping the status gate on the pip
    // or the ready-after-save call.
    expect(CONNECTION_PANE_CODE).toMatch(
      /desktopServerConnectionStatus\(\{[\s\S]*?localHostStatus[\s\S]*?\}\)/,
    );
    expect(CONNECTION_PANE_CODE).toMatch(
      /isDesktopServerReadyAfterSave\(\{[\s\S]*?localHostStatus[\s\S]*?\}\)/,
    );
  });

  it('does not read backendInfoQuery.dataUpdatedAt as a reachability signal', () => {
    // The earlier bug was dismissing the banner on local IPC freshness;
    // this fence stops that regression path from re-opening.
    expect(CONNECTION_PANE_CODE).not.toMatch(/dataUpdatedAt/);
  });
});

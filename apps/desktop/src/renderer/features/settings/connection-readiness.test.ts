import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  desktopServerConnectionStatus,
  isDesktopServerReadyAfterSave,
  type DesktopServerObservation,
} from './connection-readiness';

/** Shorthand for the (attachment, localHostStatus) pair that always
 *  arrives together from one `BackendInfo` snapshot. */
function observed(
  observation: DesktopServerObservation,
): DesktopServerObservation {
  return observation;
}

describe('isDesktopServerReadyAfterSave — falsifier: local IPC freshness alone is NOT reachability', () => {
  it('remote save succeeds but the renderer WS never (re)connects — banner may NOT dismiss', () => {
    // The save mutation resolved (URL bytes written), but the event WS
    // is still disconnected because the (new) server is unreachable.
    // A prior implementation that watched `backendInfoQuery.dataUpdatedAt`
    // would falsely dismiss here because the local `backend:info` IPC
    // resolves regardless of remote reachability.
    expect(
      isDesktopServerReadyAfterSave({
        observation: observed({
          attachment: { observable: false },
          localHostStatus: 'claimed',
        }),
        wsStatus: 'disconnected',
        wsConnectedAt: null,
        savedAt: 1_000,
      }),
    ).toBe(false);
  });

  it('embedded save succeeds but the daemon never re-attaches — banner may NOT dismiss', () => {
    // Same falsifier on the observable arm: `attached_at` stays NULL (or
    // at its old value) while the daemon retries the unreachable
    // backend. IPC-freshness would lie; this predicate returns false.
    expect(
      isDesktopServerReadyAfterSave({
        observation: observed({
          attachment: { observable: true, attached_at: null },
          localHostStatus: 'claimed',
        }),
        wsStatus: 'connected',
        wsConnectedAt: 500,
        savedAt: 1_000,
      }),
    ).toBe(false);
    // Old attachedAt (from the previous URL) does not count as proof
    // for this save either — the timestamp must move forward past savedAt.
    expect(
      isDesktopServerReadyAfterSave({
        observation: observed({
          attachment: { observable: true, attached_at: 500 },
          localHostStatus: 'claimed',
        }),
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
          observation: observed({
            attachment: { observable: true, attached_at: 1_500 },
            localHostStatus,
          }),
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
        observation: observed({
          attachment: { observable: true, attached_at: null },
          localHostStatus: 'unclaimed',
        }),
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
      observation: observed({
        attachment: { observable: true, attached_at: null },
        localHostStatus: 'claimed',
      }),
      wsStatus: 'idle',
      wsConnectedAt: null,
      savedAt,
    });
    const second = isDesktopServerReadyAfterSave({
      observation: observed({
        attachment: { observable: true, attached_at: 1_500 },
        localHostStatus: 'claimed',
      }),
      wsStatus: 'idle',
      wsConnectedAt: null,
      savedAt,
    });
    expect(first).toBe(false);
    expect(second).toBe(true);
  });
});

describe('isDesktopServerReadyAfterSave — no snapshot observed yet (#task:1630 forward fix)', () => {
  it('a null observation is never proof, even with a post-save WS connect', () => {
    // The regression this closes: `ConnectionPane` used to default the
    // missing snapshot to `{ observable: false }` + `'unclaimed'`, which
    // routes the proof to the renderer WS. In an EMBEDDED deployment
    // that WS talks to local main and is `connected` almost immediately,
    // so a save whose new URL is unreachable would have its banner
    // dismissed by a purely local signal. "We have not looked yet" must
    // never satisfy a reachability proof.
    expect(
      isDesktopServerReadyAfterSave({
        observation: null,
        wsStatus: 'connected',
        wsConnectedAt: 1_500,
        savedAt: 1_000,
      }),
    ).toBe(false);
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
        observation: observed({
          attachment: { observable: false },
          localHostStatus: 'claimed',
        }),
        wsStatus: 'disconnected',
        wsConnectedAt: 1_500,
        savedAt: 1_000,
      }),
    ).toBe(false);
    // Also covers the intermediate re-authenticating state — historical
    // proof isn't enough while the current connection is unsettled.
    expect(
      isDesktopServerReadyAfterSave({
        observation: observed({
          attachment: { observable: false },
          localHostStatus: 'claimed',
        }),
        wsStatus: 'authenticating',
        wsConnectedAt: 1_500,
        savedAt: 1_000,
      }),
    ).toBe(false);
  });

  it('post-save WS connected AND still connected right now → ready', () => {
    expect(
      isDesktopServerReadyAfterSave({
        observation: observed({
          attachment: { observable: false },
          localHostStatus: 'claimed',
        }),
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
        observation: observed({
          attachment: { observable: false },
          localHostStatus: 'claimed',
        }),
        wsStatus: 'connected',
        wsConnectedAt: 1_500,
        savedAt: 1_000,
      }),
    ).toBe(true);
  });

  it('embedded: daemon attach timestamp moved forward past save on a claimed row → ready', () => {
    expect(
      isDesktopServerReadyAfterSave({
        observation: observed({
          attachment: { observable: true, attached_at: 1_500 },
          localHostStatus: 'claimed',
        }),
        wsStatus: 'idle',
        wsConnectedAt: null,
        savedAt: 1_000,
      }),
    ).toBe(true);
  });

  it('no save in progress → not ready (nothing to dismiss)', () => {
    expect(
      isDesktopServerReadyAfterSave({
        observation: observed({
          attachment: { observable: false },
          localHostStatus: 'claimed',
        }),
        wsStatus: 'connected',
        wsConnectedAt: 5_000,
        savedAt: null,
      }),
    ).toBe(false);
  });

  it('remote WS connected but the transition predates the save → not ready (stale proof)', () => {
    expect(
      isDesktopServerReadyAfterSave({
        observation: observed({
          attachment: { observable: false },
          localHostStatus: 'claimed',
        }),
        wsStatus: 'connected',
        wsConnectedAt: 500,
        savedAt: 1_000,
      }),
    ).toBe(false);
  });
});

describe('desktopServerConnectionStatus — persistent status pip', () => {
  it('unobservable attachment maps WS status directly to the three-tone connection view', () => {
    // `#task:1630`: the arm is selected by the attachment discriminant,
    // NOT by a `mode` field the caller has to remember to pass. The old
    // "remote + a non-null attachedAt" input is now unrepresentable, so
    // the previous runtime assertion ("remote ignores the timestamp")
    // has been promoted to a type error at every call site.
    for (const [wsStatus, expected] of [
      ['idle', 'offline'],
      ['connecting', 'connecting'],
      ['authenticating', 'connecting'],
      ['connected', 'connected'],
      ['disconnected', 'offline'],
    ] as const) {
      expect(
        desktopServerConnectionStatus({
          observation: observed({
            attachment: { observable: false },
            localHostStatus: 'claimed',
          }),
          wsStatus,
        }),
      ).toBe(expected);
    }
  });

  it('unobservable attachment does not fall through to the claim gate', () => {
    // `#task:1010` regression: reading the (unreadable) attach timestamp
    // here answered "connecting" forever. A terminal/pre-claim
    // `localHostStatus` must not override an observed live renderer WS
    // either — in a remote deployment that row's lifecycle is not the
    // Desktop→Server authority.
    for (const localHostStatus of [
      'unclaimed',
      'revoked',
      'error',
      'failed',
    ] as const) {
      expect(
        desktopServerConnectionStatus({
          observation: observed({
            attachment: { observable: false },
            localHostStatus,
          }),
          wsStatus: 'connected',
        }),
      ).toBe('connected');
    }
  });

  it('embedded: claimed + attachedAt → connected; claimed + null → connecting', () => {
    // The "connecting" mid-state is real (daemon-outbound-attach window)
    // — surfacing it truthfully is what stops the pip from lying about
    // reachability while the daemon is still dialing.
    expect(
      desktopServerConnectionStatus({
        observation: observed({
          attachment: { observable: true, attached_at: 1_000 },
          localHostStatus: 'claimed',
        }),
        wsStatus: 'disconnected',
      }),
    ).toBe('connected');
    expect(
      desktopServerConnectionStatus({
        observation: observed({
          attachment: { observable: true, attached_at: null },
          localHostStatus: 'claimed',
        }),
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
          observation: observed({
            attachment: { observable: true, attached_at: 5_000 },
            localHostStatus,
          }),
          wsStatus: 'connected',
        }),
      ).toBe('offline');
    }
  });

  it('embedded: pre-claim (unclaimed) → offline (no attach expected yet)', () => {
    expect(
      desktopServerConnectionStatus({
        observation: observed({
          attachment: { observable: true, attached_at: null },
          localHostStatus: 'unclaimed',
        }),
        wsStatus: 'connected',
      }),
    ).toBe('offline');
  });
});

describe('desktopServerConnectionStatus — no snapshot observed yet (#task:1630 forward fix)', () => {
  it('null observation answers `unknown` for every WS status, never a status word', () => {
    // Norman's review of `e82f8a23`: with a fabricated
    // `{ observable: false }` first frame, an EMBEDDED launch reads the
    // (local, immediately connected) renderer WS and paints
    // "Connected"; the real snapshot then arrives as
    // `claimed + attached_at === null` and the SAME pip walks backwards
    // to "Connecting…". Status words may only move forward, so the
    // pre-snapshot frame must claim nothing at all.
    for (const wsStatus of [
      'idle',
      'connecting',
      'authenticating',
      'connected',
      'disconnected',
    ] as const) {
      expect(
        desktopServerConnectionStatus({ observation: null, wsStatus }),
      ).toBe('unknown');
    }
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

  it('passes one observation into both readiness projections', () => {
    // Guards against silently re-dropping the status gate on the pip
    // or the ready-after-save call.
    expect(CONNECTION_PANE_CODE).toMatch(
      /desktopServerConnectionStatus\(\{[\s\S]*?observation[\s\S]*?\}\)/,
    );
    expect(CONNECTION_PANE_CODE).toMatch(
      /isDesktopServerReadyAfterSave\(\{[\s\S]*?observation[\s\S]*?\}\)/,
    );
  });

  it('never synthesises an observation for a missing snapshot (#task:1630)', () => {
    // The forward fix: the pane must read the pair off `data` or pass
    // NULL. A `?? { observable: false }` / `?? 'unclaimed'` default is
    // what handed the pip to a local WS and pinned the pane on a
    // transient pre-bootstrap `backend:info` null.
    expect(CONNECTION_PANE_CODE).not.toMatch(/observable:\s*false/);
    expect(CONNECTION_PANE_CODE).not.toMatch(/local_host_status\s*\?\?/);
  });

  it('never defaults an unobserved `mode`, and gates Save on the planned command (#task:1630)', () => {
    // The command twin of the pill bug (Cindy's review): defaulting
    // `mode` to `'embedded'` for the unknown window routed a REMOTE
    // app's Save into `settings:saveServerUrl` (daemon-config rewrite +
    // daemon reload) while its own profile stayed on the old origin.
    // `planServerUrlSave` owns that decision and answers null for an
    // unknown mode — see `server-url-save-command.test.ts` for the
    // executable "zero IPC calls" falsifier. Locked as source fences
    // because the pane itself is not unit-renderable here.
    expect(CONNECTION_PANE_CODE).not.toMatch(/\?\?\s*'embedded'/);
    expect(CONNECTION_PANE_CODE).not.toMatch(/mode\s*===\s*'remote'\s*\?\s*'remote'/);
    expect(CONNECTION_PANE_CODE).toMatch(
      /saveCommand\s*=\s*planServerUrlSave\(\{[\s\S]*?mode:\s*snapshot\?\.mode\s*\?\?\s*null/,
    );
    expect(CONNECTION_PANE_CODE).toMatch(
      /saveDisabled\s*=[\s\S]*?saveCommand\s*===\s*null/,
    );
    // The mutation receives the planned command, never a bare URL it
    // would have to route itself.
    expect(CONNECTION_PANE_CODE).toMatch(/save\.mutate\(saveCommand\)/);
  });

  it('keeps the address field editable while the snapshot is unknown', () => {
    // Norman's presentation call: the unknown window is sub-second and
    // self-heals, so it must not swallow what the user typed. Only an
    // in-flight save may disable the input.
    expect(CONNECTION_PANE_CODE).toMatch(
      /<Input[\s\S]*?disabled=\{save\.isPending\}/,
    );
  });

  it('does not read backendInfoQuery.dataUpdatedAt as a reachability signal', () => {
    // The earlier bug was dismissing the banner on local IPC freshness;
    // this fence stops that regression path from re-opening.
    expect(CONNECTION_PANE_CODE).not.toMatch(/dataUpdatedAt/);
  });
});

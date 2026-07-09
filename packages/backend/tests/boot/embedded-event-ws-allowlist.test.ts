/**
 * #task:1428 P1 regression (Cindy `fTrZ2HhhV70BRI2j`) — embedded event-WS
 * Origin allowlist must be EXACTLY this boot's finalized loopback origin,
 * never a merge with an inherited value.
 *
 * Embedded runs on an ephemeral loopback port. The desktop persists
 * `server-config.json`, so a previous boot's generated
 * `http://127.0.0.1:<oldPort>` could be fed back in as
 * `serverConfig.event_ws_allowed_origins`. If `startBackend` merged it, the
 * embedded backend would trust `[<oldPort>, <newPort>]` — stale generated
 * origins that no longer reach anything. The allowlist is a security control,
 * not a scratchpad: trust only the origin the desktop reaches this boot at.
 *
 * (Desktop-side Fix 2 stops persisting the generated value at all —
 * `PersistedServerConfigSchema` omits `event_ws_allowed_origins`. This test
 * pins the backend half: even if a stale value IS supplied, the boot drops
 * it.)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerConfig } from '@silverhand/shared';
import { startBackend, type RunningBackend } from '../../src/index.js';

function makeEmbeddedConfig(
  eventWsAllowedOrigins: string[],
): ServerConfig {
  return {
    mode: 'embedded',
    url: 'http://127.0.0.1:0', // placeholder; finalized at listen-time
    auth_token: 'e'.repeat(32),
    refresh_token: null,
    event_ws_allowed_origins: eventWsAllowedOrigins,
    child_sessions: {
      max_concurrent_per_parent: null,
      spawn_cooldown_seconds: null,
      max_depth: 1,
    },
  };
}

describe('startBackend — embedded event-WS allowlist is this boot only', () => {
  let running: RunningBackend | null = null;
  let tmp: string | null = null;

  afterEach(async () => {
    await running?.close().catch(() => undefined);
    running = null;
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = null;
    }
  });

  it('drops a stale inherited loopback origin and trusts only the finalized one', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'silverhand-embedded-allowlist-'));
    // A stale origin from a previous boot on a now-dead port.
    const staleOrigin = 'http://127.0.0.1:1111';

    running = await startBackend({
      mode: 'embedded',
      dbPath: join(tmp, 'silverhand.db'),
      silverhandDir: tmp,
      serverConfig: makeEmbeddedConfig([staleOrigin]),
      silverhandCliLauncher: { command: 'true', args: [] },
      logger: { info() {}, warn() {}, error() {} },
      outboundSocketPath: join(tmp, 'daemon-outbound.sock'),
    });

    // Sanity: the listen callback finalized the URL off the placeholder.
    expect(running.url).not.toContain(':0');
    const finalizedOrigin = new URL(running.url).origin;

    // The allowlist is EXACTLY the finalized origin — no merge, no stale.
    expect(running.context.serverConfig.event_ws_allowed_origins).toEqual([
      finalizedOrigin,
    ]);
    expect(
      running.context.serverConfig.event_ws_allowed_origins,
    ).not.toContain(staleOrigin);
  });
});

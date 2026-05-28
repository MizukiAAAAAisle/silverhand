/**
 * D4.c C8 (G3) — Standalone signup-toggle real restart e2e.
 *
 * **What this pins**: the `authConfig.signupEnabled` boundary in
 * `startBackend` is a **boot-time-frozen** input. Toggling it at
 * runtime is forbidden by design (see remote-backend-d4-design.md
 * §6.3). The contract is: change the flag → restart backend → new
 * boot picks up the new value. This test exercises that contract
 * end-to-end with a real listener and a real backend close+restart
 * pair, and pins three durability invariants across the toggle:
 *
 *   - **P1.a (old user_token bearer survives)**: the user-session
 *     bearer minted before the signup toggle still authenticates
 *     `GET /api/me` after the restart. `auth_sessions` rows live in
 *     the SQLite DB; the toggle changes the auth runtime config, NOT
 *     the session store.
 *   - **P1.b (host credential survives)**: the host_token issued via
 *     `POST /api/hosts/claim-or-create` before the toggle still
 *     resolves to its `(host_id, user_id, credential_id)` after the
 *     restart via `HostTokenService.verifyHostToken`, the host row
 *     itself is not revoked, and the underlying credential row is
 *     not consumed/revoked. The toggle changes signup acceptance,
 *     NOT host registration state.
 *   - **P2.a (toggle is reversible)**: a second restart with
 *     `signupEnabled: true` re-opens signup acceptance. The flag is
 *     genuinely a config knob, not a one-way trapdoor on the DB.
 *
 * **What this does NOT cover** (by design — out of scope for C8):
 *
 *   - Hot-toggle (no restart). The product contract is "change config →
 *     restart"; this test is the boundary, not the hot-path.
 *   - Env-var resolution (`SILVERHAND_DISABLE_SIGNUP=1`) — covered by
 *     `tests/auth/config.test.ts` at the `resolveAuthRuntimeConfig`
 *     unit level. C8 explicitly takes the `authConfig` programmatic
 *     path so the boot-time-frozen surface (the field on the
 *     `BackendContext`) is what's under test, not the env parsing.
 *
 * **R4 (this IPC is local supervisor/control, not server↔daemon
 * formal semantics)**: this test runs the backend with `mode:
 * 'standalone'` and never boots a daemon. It exercises only the HTTP
 * auth surface + the host-credential row in DB. No outbound WS, no
 * daemon-config, no IPC.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';
import {
  apiPaths,
  authPaths,
  type ServerConfig,
} from '@silverhand/shared';
import {
  startBackend,
  type RunningBackend,
} from '../../src/index.js';
import type { BackendLogger } from '../../src/context.js';
import { HostTokenService, hashHostToken } from '../../src/auth/host-token.js';

const silentBackendLogger: BackendLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface BackendOnlyHandle {
  backend: RunningBackend;
  dbPath: string;
  silverhandDir: string;
  tempDir: string;
}

/**
 * Boot a standalone backend with no daemon, no host-config write,
 * no pre-claimed host. Mirrors the boot half of `bootG2Harness` but
 * skips the daemon-side wiring — C8 only needs the HTTP auth surface
 * and the host-credential row in DB.
 */
async function bootBackendOnly(opts: {
  signupEnabled: boolean;
  reuse?: { dbPath: string; silverhandDir: string; tempDir: string };
}): Promise<BackendOnlyHandle> {
  const tempDir =
    opts.reuse?.tempDir ?? mkdtempSync(join(tmpdir(), 'silverhand-g3-c8-'));
  const dbPath = opts.reuse?.dbPath ?? join(tempDir, 'silverhand.db');
  const silverhandDir =
    opts.reuse?.silverhandDir ?? join(tempDir, '.silverhand');

  const serverConfig: ServerConfig = {
    mode: 'remote',
    url: 'http://127.0.0.1:0',
    auth_token: 'unused-in-c8',
    refresh_token: null,
    child_sessions: {
      max_concurrent_per_parent: null,
      spawn_cooldown_seconds: null,
      max_depth: 1,
    },
  };

  const backend = await startBackend({
    mode: 'standalone',
    dbPath,
    silverhandDir,
    serverConfig,
    listen: { hostname: '127.0.0.1', port: 0 },
    logger: silentBackendLogger,
    authConfig: {
      signupEnabled: opts.signupEnabled,
      // Use the production default TTL — the toggle is what's under
      // test, the session TTL is incidental.
      sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
    },
  });

  return { backend, dbPath, silverhandDir, tempDir };
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  return { status: res.status, body: parsed };
}

async function getJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const res = await fetch(url, { method: 'GET', headers });
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  return { status: res.status, body: parsed };
}

describe('Standalone G3 — signup-toggle real restart (D4.c C8)', () => {
  let active: BackendOnlyHandle | null = null;

  afterEach(async () => {
    if (active) {
      try {
        await active.backend.close();
      } catch {
        // best-effort
      }
      try {
        rmSync(active.tempDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      active = null;
    }
  });

  it(
    'phase1 (signup on) → claim host → phase2 (signup off, real restart) → ' +
      'old user_token + host_token still valid, new signup is 403; ' +
      'phase3 (signup on again, real restart) → new signup succeeds',
    async () => {
      // ─── Phase 1: boot with signup ENABLED ────────────────────────
      active = await bootBackendOnly({ signupEnabled: true });
      const phase1Url = active.backend.url;

      // /api/server/info reflects the boot-frozen flag.
      {
        const info = await getJson(`${phase1Url}${apiPaths.serverInfo}`);
        expect(info.status).toBe(200);
        expect(info.body.signup_enabled).toBe(true);
      }

      // POST /auth/signup → 200, returns user_token + user.
      const email = `c8-toggle-${Date.now()}@example.test`;
      const password = 'c8-test-password-1';
      const display_name = 'C8 Toggle';
      const signupRes = await postJson(`${phase1Url}${authPaths.signup}`, {
        email,
        password,
        display_name,
      });
      expect(signupRes.status).toBe(200);
      expect(typeof signupRes.body.user_token).toBe('string');
      const userToken = signupRes.body.user_token as string;
      const user = signupRes.body.user as { id: string };
      expect(typeof user?.id).toBe('string');
      const userId1 = user.id;

      // Use the user-session bearer to claim a local host. This is
      // the production desktop-main path: renderer logs in →
      // session bearer → main calls claim-or-create with
      // installation_id → backend mints the host row + host_token.
      const installationId = randomUUID();
      const claimRes = await postJson(
        `${phase1Url}${apiPaths.hostClaimOrCreate}`,
        { installation_id: installationId, label: 'c8-toggle-host' },
        { authorization: `Bearer ${userToken}` },
      );
      expect(claimRes.status).toBe(200);
      expect(typeof claimRes.body.host_id).toBe('string');
      expect(typeof claimRes.body.host_token).toBe('string');
      const hostId1 = claimRes.body.host_id as string;
      const hostToken = claimRes.body.host_token as string;

      // Cindy P1 (`T9pFj34JhTdg_01V`): snapshot the full
      // `host_credentials` rows for `hostId1` BEFORE the restart, so
      // phase 2 can deep-equal them. The previous "row count + state
      // fields" check could not distinguish "credential preserved"
      // from "credential silently rotated within the rotation grace
      // window" — a regression that minted a NEW row + revoked the
      // old one would still see `verifyHostToken` succeed (grace) and
      // a single state-clean latest row. Pinning byte-equal of every
      // column (including `id` and `token_hash`) closes that gap.
      type HostCredentialFullRow = {
        id: string;
        host_id: string;
        token_hash: string;
        kind: string;
        expires_at: number | null;
        consumed_at: number | null;
        revoked_at: number | null;
      };
      const dumpCredentials = (db: Db) =>
        db
          .prepare<[string], HostCredentialFullRow>(
            `SELECT id, host_id, token_hash, kind, expires_at,
                    consumed_at, revoked_at
               FROM host_credentials
              WHERE host_id = ?
              ORDER BY rowid ASC`,
          )
          .all(hostId1);
      const preCredentials = dumpCredentials(active.backend.context.db);
      // claim-or-create on a fresh host mints exactly one long_lived
      // credential. Pin the count explicitly so a future "issue extra
      // bootstrap on claim" regression surfaces here.
      expect(preCredentials).toHaveLength(1);
      const [preCredential] = preCredentials;
      // Sanity: the cleartext `hostToken` we received from the route
      // hashes to the row's `token_hash` (proves the snapshot truly
      // covers THE credential under test, not a sibling row).
      expect(preCredential!.token_hash).toBe(hashHostToken(hostToken));

      // ─── Phase 2: real close + restart with signup DISABLED ───────
      const phase1State = {
        dbPath: active.dbPath,
        silverhandDir: active.silverhandDir,
        tempDir: active.tempDir,
      };
      await active.backend.close();
      active = await bootBackendOnly({
        signupEnabled: false,
        reuse: phase1State,
      });
      const phase2Url = active.backend.url;

      // /api/server/info reflects the new boot-frozen value.
      {
        const info = await getJson(`${phase2Url}${apiPaths.serverInfo}`);
        expect(info.status).toBe(200);
        expect(info.body.signup_enabled).toBe(false);
      }

      // POST /auth/signup → 403 typed `signup_disabled`. The route
      // is **always mounted**; the typed body is the contract that
      // desktop + ops tooling read instead of a generic 404 (per
      // D4.a Commit 4).
      {
        const blocked = await postJson(`${phase2Url}${authPaths.signup}`, {
          email: `c8-toggle-blocked-${Date.now()}@example.test`,
          password: 'c8-test-password-2',
          display_name: 'C8 Blocked',
        });
        expect(blocked.status).toBe(403);
        expect(blocked.body.code).toBe('signup_disabled');
      }

      // P1.a — old user_token bearer + GET /api/me → 200 with the
      // SAME user.id. The signup toggle changed boot-time auth
      // config; it did NOT touch the `auth_sessions` row keyed by
      // `userToken`'s hash. Renderer carries this bearer across
      // the toggle and stays signed in.
      {
        const me = await getJson(`${phase2Url}${apiPaths.me}`, {
          authorization: `Bearer ${userToken}`,
        });
        expect(me.status).toBe(200);
        expect(me.body.id).toBe(userId1);
      }

      // P1.b — host credential survives the boot-config flip.
      // `verifyHostToken` is the same code path the WS host-token
      // middleware runs on the daemon's bearer; if it stays `ok:
      // true` after restart, the daemon would reattach without
      // re-claim/re-issue. We additionally inspect the underlying
      // rows so a regression that strips token state silently (e.g.
      // marks revoked_at on restart) would surface here, not later
      // at WS attach time.
      //
      // **Cindy P1 (`T9pFj34JhTdg_01V`)**: a `verifyHostToken: ok` +
      // "latest row clean" assertion is not enough — within the
      // rotation grace window, an erroneous restart-time
      // `rotateHostToken` would: (i) leave the old row valid (grace),
      // (ii) mint a new row that *also* looks clean. The rigorous
      // contract is "the credential row is byte-identical pre/post
      // restart, and the same row is the one `verifyHostToken`
      // resolves to". Pin both.
      {
        const tokens = new HostTokenService(active.backend.context.db);
        const verified = tokens.verifyHostToken(hostToken);
        expect(verified.ok).toBe(true);
        if (verified.ok) {
          expect(verified.hostId).toBe(hostId1);
          expect(verified.userId).toBe(userId1);
          // Same `credential_id` as pre-restart — the resolved row
          // is the very row we snapshotted, not a fresh rotation.
          expect(verified.credentialId).toBe(preCredential!.id);
        }

        // Underlying host row not revoked.
        const hostRow = active.backend.context.db
          .prepare<[string], { revoked_at: number | null; user_id: string | null }>(
            `SELECT revoked_at, user_id FROM hosts WHERE id = ?`,
          )
          .get(hostId1);
        expect(hostRow).toBeTruthy();
        expect(hostRow?.revoked_at).toBeNull();
        expect(hostRow?.user_id).toBe(userId1);

        // Cindy P1 deep-equal: every column of every host_credentials
        // row for this host is unchanged. Catches silent rotate /
        // reissue / extra-row mint scenarios that the pre-fix latest-
        // row-only assertion would have missed.
        const postCredentials = dumpCredentials(active.backend.context.db);
        expect(postCredentials).toHaveLength(1);
        expect(postCredentials).toEqual(preCredentials);
      }

      // ─── Phase 3 (P2.a, secondary): real close + restart with
      //                                signup RE-ENABLED ─────────────
      const phase2State = {
        dbPath: active.dbPath,
        silverhandDir: active.silverhandDir,
        tempDir: active.tempDir,
      };
      await active.backend.close();
      active = await bootBackendOnly({
        signupEnabled: true,
        reuse: phase2State,
      });
      const phase3Url = active.backend.url;

      // /api/server/info flipped back to `true` — the flag is a
      // genuine knob, not a one-way DB trapdoor.
      {
        const info = await getJson(`${phase3Url}${apiPaths.serverInfo}`);
        expect(info.status).toBe(200);
        expect(info.body.signup_enabled).toBe(true);
      }

      // A fresh signup attempt now succeeds with a different email.
      {
        const reopened = await postJson(`${phase3Url}${authPaths.signup}`, {
          email: `c8-toggle-reopen-${Date.now()}@example.test`,
          password: 'c8-test-password-3',
          display_name: 'C8 Reopen',
        });
        expect(reopened.status).toBe(200);
        expect(typeof reopened.body.user_token).toBe('string');
        const reopenedUser = reopened.body.user as { id: string };
        expect(typeof reopenedUser?.id).toBe('string');
        // New signup mints a distinct user; phase-1 user is untouched.
        expect(reopenedUser.id).not.toBe(userId1);
      }
    },
  );
});

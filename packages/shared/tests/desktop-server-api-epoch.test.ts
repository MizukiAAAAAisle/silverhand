import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyDesktopServerApiCompatibility,
  DESKTOP_API_EPOCH_EXEMPT_PATHS,
  DESKTOP_SERVER_API_EPOCH,
  isDesktopApiEpochExemptPath,
  MINIMUM_CLIENT_API_EPOCH,
  MINIMUM_SERVER_API_EPOCH,
  parseDesktopApiEpochHeader,
  UpgradeRequiredBodySchema,
  apiPaths,
} from '../src/index.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');

describe('desktop-server-api-epoch contract root', () => {
  it('classifies compatible / client_too_old / server_too_old, client arm wins', () => {
    expect(
      classifyDesktopServerApiCompatibility({
        clientEpoch: 1,
        minimumClientEpoch: 1,
        serverEpoch: 1,
        minimumServerEpoch: 1,
      }),
    ).toBe('compatible');
    expect(
      classifyDesktopServerApiCompatibility({
        clientEpoch: 0,
        minimumClientEpoch: 1,
        serverEpoch: 1,
        minimumServerEpoch: 0,
      }),
    ).toBe('client_too_old');
    expect(
      classifyDesktopServerApiCompatibility({
        clientEpoch: 1,
        minimumClientEpoch: 0,
        serverEpoch: 0,
        minimumServerEpoch: 1,
      }),
    ).toBe('server_too_old');
    // Both sides behind: the actionable remedy (upgrade the app) wins.
    expect(
      classifyDesktopServerApiCompatibility({
        clientEpoch: 0,
        minimumClientEpoch: 1,
        serverEpoch: 0,
        minimumServerEpoch: 1,
      }),
    ).toBe('client_too_old');
  });

  it('plan-A lockstep: minima equal the current epoch, except the NAMED epoch-1 bootstrap', () => {
    // Cindy round-2/3 P1: default plan A rejects incompatible pairs by
    // DEFINITION of "same generation". A minimum of 0 is legal ONLY while
    // the current epoch is still 1 — the named observation-bootstrap window
    // of the axis's first introduction, checked per field so the two minima
    // can exit their bridges independently. The moment the epoch is bumped
    // past 1, a leftover 0 minimum fails RED here (that leftover would
    // silently re-admit the incompatible pair plan A exists to reject).
    // A deliberate plan-B bridge must change this test together with its
    // adapter + §11 exit conditions.
    const inClientBootstrap =
      DESKTOP_SERVER_API_EPOCH === 1 && MINIMUM_CLIENT_API_EPOCH === 0;
    if (!inClientBootstrap) {
      expect(MINIMUM_CLIENT_API_EPOCH).toBe(DESKTOP_SERVER_API_EPOCH);
    }
    const inServerBootstrap =
      DESKTOP_SERVER_API_EPOCH === 1 && MINIMUM_SERVER_API_EPOCH === 0;
    if (!inServerBootstrap) {
      expect(MINIMUM_SERVER_API_EPOCH).toBe(DESKTOP_SERVER_API_EPOCH);
    }
  });

  it('parses the dedicated admission header: absent/malformed/repeated → 0, canonical decimal → value', () => {
    expect(parseDesktopApiEpochHeader(undefined)).toBe(0);
    expect(parseDesktopApiEpochHeader('')).toBe(0);
    expect(parseDesktopApiEpochHeader(' ')).toBe(0);
    expect(parseDesktopApiEpochHeader(['1', '2'])).toBe(0);
    expect(parseDesktopApiEpochHeader('abc')).toBe(0);
    expect(parseDesktopApiEpochHeader('-1')).toBe(0);
    expect(parseDesktopApiEpochHeader('1.5')).toBe(0);
    expect(parseDesktopApiEpochHeader('9999999999')).toBe(0); // over cap
    expect(parseDesktopApiEpochHeader('0')).toBe(0);
    expect(parseDesktopApiEpochHeader('1')).toBe(1);
    expect(parseDesktopApiEpochHeader(' 42 ')).toBe(42);
    expect(
      parseDesktopApiEpochHeader(String(DESKTOP_SERVER_API_EPOCH)),
    ).toBe(DESKTOP_SERVER_API_EPOCH);
  });

  it('bootstrap invariants: minimums admit the pre-epoch generation (0)', () => {
    // While either minimum is 0, absence (normalized to 0) must be admitted.
    // Raising these is the documented cutoff; when that lands this test is
    // updated in the same commit per the runbook.
    expect(MINIMUM_CLIENT_API_EPOCH).toBeLessThanOrEqual(
      DESKTOP_SERVER_API_EPOCH,
    );
    expect(MINIMUM_SERVER_API_EPOCH).toBeLessThanOrEqual(
      DESKTOP_SERVER_API_EPOCH,
    );
    expect(
      classifyDesktopServerApiCompatibility({
        clientEpoch: 0,
        minimumClientEpoch: MINIMUM_CLIENT_API_EPOCH,
        serverEpoch: DESKTOP_SERVER_API_EPOCH,
        minimumServerEpoch: MINIMUM_SERVER_API_EPOCH,
      }) === 'client_too_old',
    ).toBe(MINIMUM_CLIENT_API_EPOCH > 0);
  });

  it('exemption manifest covers exactly the discovery + non-desktop surfaces', () => {
    expect(DESKTOP_API_EPOCH_EXEMPT_PATHS).toEqual([
      apiPaths.health,
      apiPaths.serverInfo,
      apiPaths.hostConnectTokenResolve,
      apiPaths.hostConnect,
    ]);
    for (const path of DESKTOP_API_EPOCH_EXEMPT_PATHS) {
      expect(isDesktopApiEpochExemptPath(path)).toBe(true);
    }
    expect(isDesktopApiEpochExemptPath(apiPaths.me)).toBe(false);
    // Structural exemptions must stay OUTSIDE the /api/* mount — if one of
    // these ever moves under /api/, the middleware would start gating it and
    // this pin forces the exemption decision to be made explicitly.
    expect(apiPaths.eventWebSocket.startsWith('/api/')).toBe(true); // WS has its own gate
    for (const outside of ['/auth/login', '/auth/signup', '/readyz']) {
      expect(outside.startsWith('/api/')).toBe(false);
    }
  });

  it('426 body schema round-trips', () => {
    const body = {
      error: 'upgrade_required',
      reason: 'client_too_old',
      server_api_epoch: DESKTOP_SERVER_API_EPOCH,
      minimum_client_epoch: MINIMUM_CLIENT_API_EPOCH,
    };
    expect(UpgradeRequiredBodySchema.parse(body)).toEqual(body);
  });

  it('runbook exists and every build entry runs the fail-loud reminder', () => {
    const runbook = 'docs/desktop-server-api-epoch.md';
    expect(existsSync(join(REPO_ROOT, runbook))).toBe(true);
    // The shared reminder helper points at the real file and exits non-zero
    // when it is missing (dangling doc references die silently otherwise —
    // audit #8).
    const reminder = readFileSync(
      join(REPO_ROOT, 'scripts/epoch-runbook-reminder.mjs'),
      'utf8',
    );
    expect(reminder).toContain(runbook);
    expect(reminder).toContain('process.exit(1)');
    // Both real build entries invoke it: the desktop packaging script and
    // the standalone server bundle build.
    expect(
      readFileSync(join(REPO_ROOT, 'scripts/package.sh'), 'utf8'),
    ).toContain('epoch-runbook-reminder.mjs');
    expect(
      readFileSync(join(REPO_ROOT, 'packages/server/package.json'), 'utf8'),
    ).toContain('epoch-runbook-reminder.mjs');
  });
});

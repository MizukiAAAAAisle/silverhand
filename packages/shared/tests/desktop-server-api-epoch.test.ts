import {
  copyFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyDesktopServerApiCompatibility,
  DESKTOP_SERVER_API_EPOCH,
  MINIMUM_CLIENT_API_EPOCH,
  MINIMUM_SERVER_API_EPOCH,
  UpgradeRequiredBodySchema,
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

  it('plan-A lockstep: both minima equal the current epoch (the bootstrap window is closed)', () => {
    // Cindy round-2/3 P1: default plan A rejects incompatible pairs by
    // DEFINITION of "same generation". A minimum of 0 was legal ONLY during the
    // axis's first introduction — the named observation-bootstrap window. A
    // later atomic-triple bump (required workspace DTO fields and
    // `/api/workspaces/local-paths` removed) CLOSED that window for good: a
    // pre-epoch peer cannot decode this generation's workspace payloads, so
    // admitting it would only move the failure from admission into a deep parse.
    // From here on the invariant is unconditional — a leftover low minimum fails
    // RED here. A deliberate plan-B bridge must change this test together with
    // its adapter + §11 exit conditions.
    expect(MINIMUM_CLIENT_API_EPOCH).toBe(DESKTOP_SERVER_API_EPOCH);
    expect(MINIMUM_SERVER_API_EPOCH).toBe(DESKTOP_SERVER_API_EPOCH);
  });

  it('refuses deployed epoch 3 in both directions and accepts epoch 4 peers', () => {
    const classify = (clientEpoch: number, serverEpoch: number) =>
      classifyDesktopServerApiCompatibility({
        clientEpoch,
        serverEpoch,
        minimumClientEpoch: MINIMUM_CLIENT_API_EPOCH,
        minimumServerEpoch: MINIMUM_SERVER_API_EPOCH,
      });
    expect(classify(3, DESKTOP_SERVER_API_EPOCH)).toBe('client_too_old');
    expect(classify(DESKTOP_SERVER_API_EPOCH, 3)).toBe('server_too_old');
    expect(classify(4, 4)).toBe('compatible');
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
    const artifactRoot = join(REPO_ROOT, '.cache', 'test-artifacts', 'epoch-reminder');
    mkdirSync(artifactRoot, { recursive: true });
    const root = mkdtempSync(join(artifactRoot, 'case-'));
    try {
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, 'docs'));
      copyFileSync(
        join(REPO_ROOT, 'scripts/epoch-runbook-reminder.mjs'),
        join(root, 'scripts/epoch-runbook-reminder.mjs'),
      );
      writeFileSync(join(root, runbook), 'Release policy fixture');
      const run = () =>
        spawnSync(process.execPath, ['scripts/epoch-runbook-reminder.mjs'], {
          cwd: root,
          encoding: 'utf8',
          timeout: 5_000,
        });
      const present = run();
      expect(present.error).toBeUndefined();
      expect(present.status, present.stderr).toBe(0);
      expect(present.stdout).toContain(runbook);
      rmSync(join(root, runbook));
      const missing = run();
      expect(missing.error).toBeUndefined();
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain(runbook);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // The Desktop packaging entry invokes it.
    expect(readFileSync(join(REPO_ROOT, 'scripts/package.sh'), 'utf8')).toContain(
      'epoch-runbook-reminder.mjs',
    );
  });
});

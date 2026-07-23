/**
 * #task:1530 — desktop client-info telemetry header assembly.
 *
 * `desktopClientInfoHeaderValue` builds the release-identity header the main
 * process injects onto the event-WS upgrade. Pins:
 *   1. assembles a header that the server-side bounded parser accepts as `valid`
 *      with the expected release fields (deployment/app_version/platform/arch/
 *      installation_id).
 *   2. fail-open: if the version can't satisfy the bounded schema, it returns
 *      null (caller omits the header) instead of throwing — telemetry must never
 *      break the WS upgrade.
 *   3. memoized: build metadata is static per launch.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseClientInfoHeader } from '@silverhand/shared';

const mocked = vi.hoisted(() => ({ version: '0.1.0' }));
vi.mock('electron', () => ({ app: { getVersion: () => mocked.version } }));

import {
  desktopClientInfoHeaderValue,
  resetDesktopClientInfoHeaderCacheForTest,
} from './client-info.js';

describe('desktopClientInfoHeaderValue (#task:1530)', () => {
  let dir: string;

  beforeEach(() => {
    mocked.version = '0.1.0';
    resetDesktopClientInfoHeaderCacheForTest();
    dir = mkdtempSync(join(tmpdir(), 'silverhand-client-info-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetDesktopClientInfoHeaderCacheForTest();
  });

  it('assembles a header the server bounded-parser accepts as valid', () => {
    const header = desktopClientInfoHeaderValue(join(dir, 'installation_id'));
    expect(header).toBeTruthy();
    const parsed = parseClientInfoHeader(header!);
    expect(parsed.status).toBe('valid');
    if (parsed.status === 'valid') {
      expect(parsed.value).toMatchObject({
        client_surface: 'desktop',
        // build defines are absent in the test env → typeof-guard fallbacks
        deployment: 'embedded',
        app_version: '0.1.0',
        build_commit: 'dev',
        build_dirty: false,
        platform: process.platform,
        arch: process.arch,
      });
      expect(parsed.value.installation_id).toMatch(
        /^[0-9a-f-]{36}$/,
      );
    }
  });

  it('is fail-open: an unrepresentable version yields null, never throws', () => {
    mocked.version = 'has space (invalid)';
    resetDesktopClientInfoHeaderCacheForTest();
    const warn = vi.fn();
    expect(() => desktopClientInfoHeaderValue(join(dir, 'installation_id'), { warn })).not.toThrow();
    expect(desktopClientInfoHeaderValue(join(dir, 'installation_id'), { warn })).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('memoizes the assembled header across calls', () => {
    const first = desktopClientInfoHeaderValue(join(dir, 'installation_id'));
    const second = desktopClientInfoHeaderValue(join(dir, 'installation_id'));
    expect(first).toBe(second);
  });
});

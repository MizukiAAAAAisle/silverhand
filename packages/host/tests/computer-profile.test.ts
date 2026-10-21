import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computerProxyConfigPath, defaultConnectDataRoot } from '../src/daemon/computer-profile.js';

describe('computer profile paths', () => {
  it('uses a stable host-id-only default data root for connect launches', () => {
    const root = mkdtempSync(join(tmpdir(), 'silverhand-computer-profile-'));
    try {
      expect(defaultConnectDataRoot('host_1', root)).toBe(join(root, 'computers', 'host_1'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the same host-id-only profile for proxy config', () => {
    const root = mkdtempSync(join(tmpdir(), 'silverhand-computer-profile-'));
    try {
      expect(computerProxyConfigPath({ host_id: 'host_1' }, root)).toBe(
        join(root, 'computers', 'host_1', 'proxy-config.json'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

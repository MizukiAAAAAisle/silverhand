import { describe, expect, it, vi } from 'vitest';
import { ensureSystemCaTrusted } from '../src/system-ca.js';
import type { NodeSystemCaActivation } from '@silverhand/host/node-system-ca';

/**
 * The CLI is a separate spawned process (execPath + ELECTRON_RUN_AS_NODE=1) and
 * cannot inherit the main/daemon `setDefaultCACertificates()` call, so it must
 * run activation itself before any network I/O. These tests pin the seam: the
 * activation is invoked, and a failure never escapes to abort the command.
 */

describe('ensureSystemCaTrusted', () => {
  it('invokes the activation and returns its result', () => {
    const activation: NodeSystemCaActivation = {
      enabled: true,
      defaultCount: 120,
      systemCount: 14,
      mergedCount: 134,
    };
    const activate = vi.fn(() => activation);

    const result = ensureSystemCaTrusted(activate);

    expect(activate).toHaveBeenCalledTimes(1);
    expect(result).toBe(activation);
  });

  it('swallows activation failures so the CLI still runs on the bundled bundle', () => {
    const activate = vi.fn(() => {
      throw new Error('trust store unreadable');
    });

    expect(() => ensureSystemCaTrusted(activate)).not.toThrow();
    expect(ensureSystemCaTrusted(activate)).toBeUndefined();
  });
});

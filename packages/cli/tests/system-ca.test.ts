import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureSystemCaTrusted } from '../src/system-ca.js';
import type { NodeSystemCaActivation } from '@silverhand/host/node-system-ca';

const { activate } = vi.hoisted(() => ({ activate: vi.fn() }));
vi.mock('@silverhand/host/node-system-ca', () => ({ enableNodeSystemCa: activate }));
beforeEach(() => {
  activate.mockReset();
});

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
    activate.mockReturnValue(activation);

    const result = ensureSystemCaTrusted();

    expect(activate).toHaveBeenCalledTimes(1);
    expect(result).toBe(activation);
  });

  it('swallows activation failures so the CLI still runs on the bundled bundle', () => {
    activate.mockImplementation(() => {
      throw new Error('trust store unreadable');
    });

    let result: unknown;
    expect(() => {
      result = ensureSystemCaTrusted();
    }).not.toThrow();
    expect(result).toBeUndefined();
    expect(activate).toHaveBeenCalledTimes(1);
  });
});

/**
 * Entry wiring guard. The #1464 bug was "helper correct but a process never
 * called it", so the seam being invocable is not enough — the CLI entry must
 * actually run it, and run it in process bootstrap BEFORE `void main(...)` so it
 * precedes every network path (command requests AND the top-level rejection
 * handler's out-of-band `reportPreflightFailure()` fetch). A source-order guard
 * catches a regression that unit-testing the wrapper cannot (cli.ts self-runs on
 * import, so it can't be imported into a unit test). Same technique as the
 * repo's other structural fences.
 */
describe('cli entry activates system CA at bootstrap', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'utf8');

  it('imports the activation seam', () => {
    expect(source).toMatch(/import\s*\{\s*ensureSystemCaTrusted\s*\}\s*from\s*'\.\/system-ca\.js'/);
  });

  it('calls ensureSystemCaTrusted() before void main(...)', () => {
    const callIdx = source.indexOf('ensureSystemCaTrusted();');
    const mainIdx = source.indexOf('void main(process.argv');
    expect(callIdx).toBeGreaterThan(-1);
    expect(mainIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeLessThan(mainIdx);
  });
});

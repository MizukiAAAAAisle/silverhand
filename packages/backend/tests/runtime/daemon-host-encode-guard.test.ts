/**
 * Backend guard test for Option A v2 (Cindy `UMGu36zoTDVuKWXi`):
 * ensure `daemon-agent-runtime-host.ts` never re-introduces a
 * backend-side call to `driver.encodeStdinMessage` /
 * `driver.encodeInterruptControl`. Encoding must live in the daemon
 * with the in-process driver instance (whose state — codex
 * `threadId`, claude `cli_session_id`, etc — is authoritative).
 *
 * Why this matters: a stateless driver instance created backend-side
 * has no codex `threadId`, so `encodeStdinMessage` returns null and
 * silently kills every wake — the exact bug shiki hit during the
 * daemon-mode retry that motivated Option A v2. Once Option A v2 is
 * in, accidentally re-importing `driver.encodeStdinMessage` in the
 * backend is a regression that does NOT crash any single test path
 * but breaks codex live deliveries. This grep-style guard makes the
 * regression loud at PR time.
 *
 * Scope:
 *   - Allow occurrences inside `//` line comments and `/* … *\/`
 *     block comments (so doc comments that REFERENCE the now-removed
 *     call stay legal — see e.g. the `start()` doc comment that
 *     explains why oneShot vs streamed paths now differ).
 *   - Disallow occurrences in any executable line.
 *
 * This complements the daemon-side regression net
 * (`packages/host/tests/entry-supervisor-wiring.test.ts` log-key
 * grep + `real-supervisor.test.ts` Option A v2 arm coverage).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = resolve(
  __dirname,
  '..',
  '..',
  'src',
  'runtime',
  'daemon-agent-runtime-host.ts',
);

/** Strip `// …` line comments AND `/* … *\/` block comments. We do a
 *  pass-by-pass strip rather than a single regex so multi-line block
 *  comments collapse cleanly without dragging unrelated string content
 *  with them. The grep tokens we check for (`encodeStdinMessage(`,
 *  `encodeInterruptControl(`) never legitimately appear inside string
 *  literals in this file, so we don't bother sandboxing strings — if
 *  someone adds a literal containing those tokens, the test will
 *  alert them and they can update the guard. */
function stripComments(src: string): string {
  // 1. Block comments
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // 2. Line comments
  return noBlock
    .split('\n')
    .map(line => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

describe('daemon-agent-runtime-host.ts — Option A v2 encode-guard', () => {
  it('contains no live `driver.encodeStdinMessage(` call (encoding owned by daemon)', () => {
    const src = readFileSync(SOURCE, 'utf-8');
    const code = stripComments(src);
    expect(
      code.includes('encodeStdinMessage('),
      'daemon-agent-runtime-host.ts must not call encodeStdinMessage — ' +
        'Option A v2 (Cindy `UMGu36zoTDVuKWXi`) moved encoding into the ' +
        'daemon so the codex `threadId`-carrying driver instance does ' +
        'the encode. Re-introducing a backend-side call silently breaks ' +
        'every codex wake the moment the bridge ships pre-encoded bytes.',
    ).toBe(false);
  });

  it('contains no live `driver.encodeInterruptControl(` call (encoding owned by daemon)', () => {
    const src = readFileSync(SOURCE, 'utf-8');
    const code = stripComments(src);
    expect(
      code.includes('encodeInterruptControl('),
      'daemon-agent-runtime-host.ts must not call encodeInterruptControl — ' +
        'same reasoning as encodeStdinMessage: the daemon owns the in-process ' +
        'driver instance and its protocol state.',
    ).toBe(false);
  });
});

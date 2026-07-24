import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * #task:1596 round 3 (Cindy) — test-isolation wiring guard. A `runDaemon`
 * fixture that omits `workspaceDataRootDir` falls through to the daemon's
 * global default (`~/.silverhand/workspace-data`) and pollutes the REAL
 * user home (this exact leak previously accumulated 5151 localhost
 * registry namespaces under `~/.silverhand/daemon`). #task:1598 round 4
 * extends the same rule to `daemonIdentityPath`: with the sibling
 * derivation gone, an omitted identity coordinate falls back to
 * `~/.silverhand/daemon/identity.json`. The acceptance target is that
 * tests CANNOT address the real home — so this guard statically requires
 * every `runDaemon(`/`runDaemon({` call inside test sources (host AND
 * backend suites) to pass BOTH options explicitly in the same call
 * expression. New fixtures fail here immediately instead of leaking
 * silently.
 */

const TEST_ROOTS = [
  resolve(__dirname),
  resolve(__dirname, '../../backend/tests'),
];

/** The guard file itself mentions runDaemon in prose; skip it. */
const SELF = resolve(__dirname, 'workspace-data-isolation-guard.test.ts');

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules' || name === 'fixtures' || name === '_fixtures') {
        continue;
      }
      collectTsFiles(path, out);
    } else if (name.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out;
}

describe('daemon test fixtures cannot address the real ~/.silverhand', () => {
  it('every runDaemon( call in test sources passes an explicit durable root (workspaceDataRootDir OR computersRootDir) AND daemonIdentityPath', () => {
    // #task:1608 — `computersRootDir` sandboxes the durable computer slots
    // the same way an explicit `workspaceDataRootDir` does; either one
    // keeps the fixture off the real ~/.silverhand.
    const REQUIRED_OPTIONS: Array<string | readonly string[]> = [
      ['workspaceDataRootDir', 'computersRootDir'],
      'daemonIdentityPath',
    ];
    const violations: string[] = [];
    for (const root of TEST_ROOTS) {
      for (const file of collectTsFiles(root)) {
        if (file === SELF) continue;
        const source = readFileSync(file, 'utf-8');
        let idx = 0;
        for (;;) {
          const call = source.indexOf('runDaemon(', idx);
          if (call < 0) break;
          idx = call + 'runDaemon('.length;
          // Ignore imports / type positions / prose (no call body).
          const body = source.slice(call, call + 2000);
          if (!body.startsWith('runDaemon({')) continue;
          // The explicit options must appear within this call's opening
          // object literal (2000 chars is far beyond any current fixture's
          // option block; a false negative here just means a smaller slice
          // window, never a silent pass for a missing option — the option
          // text itself is what we look for).
          for (const option of REQUIRED_OPTIONS) {
            const alternatives = Array.isArray(option) ? option : [option];
            if (!alternatives.some(name => body.includes(name))) {
              const line = source.slice(0, call).split('\n').length;
              violations.push(
                `${relative(process.cwd(), file)}:${line} — runDaemon() without explicit ${alternatives.join(' | ')}`,
              );
            }
          }
        }
      }
    }
    expect(
      violations,
      `daemon fixtures must pass temp workspaceDataRootDir + daemonIdentityPath (or they write the real ~/.silverhand):\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});

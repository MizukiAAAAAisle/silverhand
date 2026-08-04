import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * #task:1596 round 3 (Cindy) — test-isolation wiring guard. The acceptance
 * target is that daemon fixtures CANNOT address the real `~/.silverhand`.
 *
 * relocation-v1 §7-4 re-derived the protected axis from what `runDaemon` can
 * actually write. `workspaceDataRootDir` is gone (the daemon owns no registry
 * and no workspace-data root), so requiring it would guard nothing. What the
 * daemon does root is the DURABLE AGENT TREE — agent L1 plus the per-agent L2
 * bundles under it: with no explicit coordinate, agent-file operations fall
 * through to the helpers' homedir default (`~/.silverhand/agents`). Three
 * distinct seams redirect that tree, and any ONE of them is sufficient:
 * `agentHomeRootDir` (direct override), `computersRootDir` (the binding-keyed
 * slot the frozen context derives the agents root from), and the
 * `agentMaterializeHomeDir` test hook (replaces the home the default layout is
 * derived from — used by fixtures that assert the default `<home>/.silverhand`
 * shape). #task:1598 round 4's rule still holds for `daemonIdentityPath`: with
 * the sibling derivation gone, an omitted identity coordinate falls back to
 * `~/.silverhand/daemon/identity.json`.
 *
 * So this guard statically requires every `runDaemon(`/`runDaemon({` call in
 * test sources (host AND backend suites) to pass an explicit durable agent
 * root AND an explicit identity coordinate in the same call expression. New
 * fixtures fail here immediately instead of leaking silently.
 */

const TEST_ROOTS = [
  resolve(__dirname),
  resolve(__dirname, '../../backend/tests'),
];

/** The guard file itself mentions runDaemon in prose; skip it. */
const SELF = resolve(__dirname, 'daemon-fixture-isolation-guard.test.ts');

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
  it('every runDaemon( call in test sources sandboxes the durable agent tree (agentHomeRootDir | computersRootDir | agentMaterializeHomeDir) AND passes daemonIdentityPath', () => {
    // #task:1608 — `computersRootDir` sandboxes the binding-keyed slot that
    // supplies the agents root, and `agentMaterializeHomeDir` replaces the home
    // the default layout hangs off; each protects the same bytes an explicit
    // `agentHomeRootDir` does, so any one keeps the fixture off the real
    // ~/.silverhand.
    const REQUIRED_OPTIONS: Array<string | readonly string[]> = [
      ['agentHomeRootDir', 'computersRootDir', 'agentMaterializeHomeDir'],
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
      `daemon fixtures must sandbox the agent tree (agentHomeRootDir | computersRootDir | agentMaterializeHomeDir) + pass daemonIdentityPath (or they write the real ~/.silverhand):\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});

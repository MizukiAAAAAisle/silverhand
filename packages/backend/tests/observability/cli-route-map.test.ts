/**
 * Drift guard for the CLI invoke route map.
 *
 * Two invariants we never want to lose:
 *
 *   1. Every entry in `CLI_INVOKE_ROUTES` maps to a `(noun, verb)` pair
 *      that actually exists in `COMMAND_GROUPS`. If we rename a CLI
 *      verb, the test points at the orphan immediately.
 *
 *   2. Every internal route defined in `internalPaths` (minus the
 *      observability-only `agentCliTrace`) has a `CLI_INVOKE_ROUTES`
 *      entry. Adding a new route without registering it would silently
 *      drop it from `cli-*.log`.
 *
 * Together they keep the `cli.invoke` aggregations honest as the
 * command surface evolves.
 */
import { describe, expect, it } from 'vitest';
import { COMMAND_GROUPS } from '@silverhand/cli';
import { internalPaths } from '@silverhand/shared';
import {
  CLI_INVOKE_ROUTES,
  lookupCliRoute,
} from '../../src/observability/cli-route-map.js';

const KNOWN_VERBS = new Set<string>();
for (const g of COMMAND_GROUPS) {
  for (const c of g.commands) KNOWN_VERBS.add(`${g.noun} ${c.verb}`);
}

/** Strip the literal `:cid` / `:aid` placeholders + the
 *  `/internal/conversations/.../agents/.../` prefix to produce the
 *  suffix the middleware actually compares against. */
function suffixOf(path: string): string {
  const m = path.match(
    /^\/internal\/conversations\/[^/]+\/agents\/[^/]+\/(.+)$/,
  );
  return m ? m[1]! : '';
}

describe('CLI invoke route map', () => {
  it('every entry maps to a (noun, verb) that exists in COMMAND_GROUPS', () => {
    for (const r of CLI_INVOKE_ROUTES) {
      const key = `${r.noun} ${r.verb}`;
      expect(KNOWN_VERBS, `route ${r.method} ${r.suffix} → unknown verb ${key}`)
        .toContain(key);
    }
  });

  it('covers every internal agent route exposed by internalPaths', () => {
    // Build the universe of suffixes from `internalPaths` (minus the
    // observability-only `agentCliTrace`, which is logged separately).
    const builders = Object.entries(internalPaths).filter(
      ([name]) => name !== 'agentCliTrace',
    );
    for (const [name, fn] of builders) {
      // Each helper is `(cid, aid, ...rest) => string`. Probe with
      // placeholder ids; collapse `:attachmentId` to `*` for the
      // locate route since the middleware matches by single segment.
      const probed =
        name === 'agentLocateAttachment'
          ? (fn as (...a: string[]) => string)(':cid', ':aid', 'ATT')
          : (fn as (...a: string[]) => string)(':cid', ':aid');
      const suffix = suffixOf(probed).replace('/ATT/', '/*/');
      // Try GET first, then POST — the map must answer one of them.
      const hit = lookupCliRoute('GET', suffix) ?? lookupCliRoute('POST', suffix);
      expect(hit, `internalPaths.${name} (${probed}) has no CLI_INVOKE_ROUTES entry`)
        .not.toBeNull();
    }
  });

  it('lookupCliRoute returns null for unrelated suffixes', () => {
    expect(lookupCliRoute('GET', 'cli-trace')).toBeNull();
    expect(lookupCliRoute('POST', 'cli-trace')).toBeNull();
    expect(lookupCliRoute('POST', 'completely-unknown')).toBeNull();
  });

  it('attachments locate suffix matches via single-segment wildcard', () => {
    expect(lookupCliRoute('GET', 'attachments/abc123/locate')).toEqual({
      noun: 'file',
      verb: 'view',
      routeSuffix: 'attachments/*/locate',
    });
    // The wildcard is single-segment — extra slashes do NOT match.
    expect(lookupCliRoute('GET', 'attachments/a/b/locate')).toBeNull();
  });

  it('rejects mismatched HTTP methods (POST tasks vs GET tasks)', () => {
    // GET /tasks → list; POST /tasks would be a typo on the route side.
    expect(lookupCliRoute('GET', 'tasks')).toEqual({
      noun: 'task',
      verb: 'list',
      routeSuffix: 'tasks',
    });
    expect(lookupCliRoute('POST', 'tasks')).toBeNull();
  });
});

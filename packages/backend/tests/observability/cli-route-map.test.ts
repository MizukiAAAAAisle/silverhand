/**
 * Drift guard for the CLI invoke route map.
 *
 * Three invariants we never want to lose:
 *
 *   1. Every entry in `CLI_INVOKE_ROUTES` maps to a `(noun, verb)` pair
 *      that exists in `COMMAND_GROUPS`, which is exhaustively bound from
 *      the shared command discovery manifest. If we rename a CLI verb,
 *      the test points at the orphan immediately.
 *
 *   2. Every internal route defined in `internalPaths` (minus the
 *      observability-only `agentCliTrace` and the profile-self avatar
 *      routes that are intentionally not CLI commands) has a
 *      `CLI_INVOKE_ROUTES` entry. Adding a new route without
 *      registering it would silently drop it from `cli-*.log`.
 *
 *   3. The HTTP method declared in `CLI_INVOKE_ROUTES` matches the
 *      method `routes.ts` actually registers each `internalPaths` helper
 *      under. A mismatch here is exactly what produced the
 *      `None.None` rows in `cli-*.log` for `silverhand schedule list`
 *      on 2026-05-14: the route was registered as POST but the map
 *      said GET, so the middleware looked up the wrong (method, suffix)
 *      tuple and returned null. We parse `routes.ts` to learn the
 *      ground truth, then compare each entry — so any future
 *      method drift fails the build instead of silently dropping
 *      observability for one endpoint.
 *
 * Together they keep the `cli.invoke` aggregations honest as the
 * command surface evolves.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND_GROUPS } from '@silverhand/cli';
import { internalPaths } from '@silverhand/shared';
import { internalAgentRoutePaths } from '../../src/routes/internal-agent/paths.js';
import {
  CLI_INVOKE_ROUTES,
  lookupCliRoute,
} from '../../src/observability/cli-route-map.js';

/**
 * Internal routes intentionally excluded from CLI invoke
 * accounting:
 *   - `agentCliTrace`: observability-only fire-and-forget endpoint;
 *     logged as `cli.preflight_failure` instead.
 *   - `agentUploadAvatar` / `agentDeleteAvatar`: profile-self avatar
 *     edit. Forward-compat for the `canEditAgent` agent-self branch
 *     — these are NOT exposed as `silverhand <noun> <verb>` commands
 *     in v1, so they have no CLI invoke surface to log against.
 */
const NON_CLI_INTERNAL_ROUTES = new Set([
  'agentCliTrace',
  'agentUploadAvatar',
  'agentDeleteAvatar',
]);

const KNOWN_VERBS = new Set<string>();
for (const g of COMMAND_GROUPS) {
  for (const c of g.commands) KNOWN_VERBS.add(`${g.noun} ${c.verb}`);
  // Faceted nouns (3-level: `silverhand <noun> <facet> <verb>`) expose
  // their CLI surface as the compound `<facet> <verb>` verb in the route
  // map (e.g. `profile` → `mcp get`), matching the cli-invoke tag.
  for (const f of g.facets ?? []) {
    for (const c of f.commands) KNOWN_VERBS.add(`${g.noun} ${f.facet} ${c.verb}`);
  }
}

/** Strip the literal `:aid` placeholder and agent-global prefix to produce the
 * suffix the middleware actually compares against. */
function suffixOf(path: string): string {
  const m = path.match(/^\/internal\/agents\/[^/]+\/(.+)$/);
  return m ? m[1]! : '';
}

/** Collapse the literal `ATT` attachment-id probe segment to the `*`
 *  wildcard the route map records — matches whether the id sits mid-path
 *  (`attachments/ATT/locate`) or as the trailing segment
 *  (`attachments/ATT` for the update route). */
function normalizeProbedSuffix(suffix: string): string {
  return suffix
    .split('/')
    .map(seg => (seg === 'ATT' ? '*' : seg))
    .join('/');
}

/**
 * Read the backend route source and build a map from `internalPaths`
 * helper name → registered HTTP method (`'GET'|'POST'`).
 *
 * Internal route registrations live in `routes.ts` AND in the extracted
 * per-context route modules under `src/routes/` (the #task:966/#967 context
 * split moved e.g. `agentAddConversationMember` into `routes/membership.ts`;
 * the #task:1293 facet split moved the internal-agent handlers into
 * `routes/internal-agent/*.ts`). We scan `routes/` recursively so the guard
 * follows handlers as they move out of the monolith, into sibling files or
 * nested facet directories.
 *
 * Uses a regex over the source rather than booting the app: cheaper,
 * deterministic, and the test wants to fail when the *source registers*
 * the wrong method, not when a runtime probe happens to 404.
 */
function collectRouteSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectRouteSources(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function buildRegistrationSet(): Set<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const srcDir = resolve(here, '../../src');
  const routesDir = resolve(srcDir, 'routes');
  const files = [
    resolve(srcDir, 'routes.ts'),
    ...collectRouteSources(routesDir),
  ];
  const re = /app\.(get|post|patch|delete)\(\s*internalAgentRoutePaths\.(\w+)/g;
  const registrations = new Set<string>();
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const method = m[1]!.toUpperCase();
      const name = m[2]! as keyof typeof internalAgentRoutePaths;
      const route = internalAgentRoutePaths[name];
      if (route === undefined) continue;
      const raw = typeof route === 'function' ? route('ATT') : route;
      registrations.add(`${method} ${normalizeProbedSuffix(raw.replace(/^\//, ''))}`);
    }
  }
  return registrations;
}

function isAttachmentWildcardRoute(name: string): boolean {
  return (
    name === 'agentLocateAttachment' ||
    name === 'agentDownloadAttachment' ||
    name === 'agentUpdateAttachment'
  );
}

describe('CLI invoke route map', () => {
  it('every entry maps to a (noun, verb) that exists in COMMAND_GROUPS', () => {
    for (const r of CLI_INVOKE_ROUTES) {
      const key = `${r.noun} ${r.verb}`;
      expect(KNOWN_VERBS, `route ${r.method} ${r.suffix} → unknown verb ${key}`)
        .toContain(key);
    }
  });

  it('covers every internal agent route exposed by internalPaths, with the registered HTTP method', () => {
    // Build the universe of suffixes from `internalPaths` (minus the
    // observability-only `agentCliTrace` and the avatar self-edit
    // routes that are intentionally not CLI commands).
    const builders = Object.entries(internalPaths).filter(
      ([name]) => !NON_CLI_INTERNAL_ROUTES.has(name),
    );
    const registered = buildRegistrationSet();
    for (const [name, fn] of builders) {
      // Each helper is `(aid, ...rest) => string`. Probe with a
      // placeholder id; collapse `:attachmentId` to `*` for the
      // attachment file-view routes since the middleware matches by
      // single segment.
      const probed =
        isAttachmentWildcardRoute(name)
          ? (fn as (...a: string[]) => string)(':aid', 'ATT')
          : (fn as (...a: string[]) => string)(':aid');
      const suffix = normalizeProbedSuffix(suffixOf(probed));
      const hit = CLI_INVOKE_ROUTES.find(route => route.suffix === suffix);
      expect(
        hit,
        `internalPaths.${name} (${probed}) has no CLI_INVOKE_ROUTES entry — middleware will log noun=null,verb=null`,
      ).toBeDefined();
      expect(
        registered,
        `internalPaths.${name} points to ${hit!.method} ${suffix}, which is absent from the shared handler graph`,
      ).toContain(`${hit!.method} ${suffix}`);
    }
  });

  it('every CLI_INVOKE_ROUTES entry method matches the backend route registration', () => {
    // Reverse direction: walk the route map, find the matching
    // internalPaths helper by (method, suffix), and assert it is
    // registered. Keyed by method+suffix — not suffix alone — because a
    // single resource can expose two methods on one suffix (e.g.
    // `profile/mcp` GET=get / POST=set), and a suffix-only map would
    // collapse them and mis-attribute the method.
    const registered = buildRegistrationSet();
    const builders = Object.entries(internalPaths).filter(
      ([name]) => !NON_CLI_INTERNAL_ROUTES.has(name),
    );
    const suffixToName = new Map<string, string>();
    for (const [name, fn] of builders) {
      const probed =
        isAttachmentWildcardRoute(name)
          ? (fn as (...a: string[]) => string)(':aid', 'ATT')
          : (fn as (...a: string[]) => string)(':aid');
      const suffix = normalizeProbedSuffix(suffixOf(probed));
      suffixToName.set(suffix, name);
    }
    for (const r of CLI_INVOKE_ROUTES) {
      const name = suffixToName.get(r.suffix);
      expect(
        name,
        `CLI_INVOKE_ROUTES entry ${r.method} ${r.suffix} has no internalPaths helper (the map will produce None.None in cli-*.log)`,
      ).toBeDefined();
      expect(
        registered,
        `CLI_INVOKE_ROUTES entry ${r.method} ${r.suffix} is absent from the shared handler graph`,
      ).toContain(`${r.method} ${r.suffix}`);
    }
  });

  it('maps both registered react-message methods to the same CLI surface', () => {
    expect(
      CLI_INVOKE_ROUTES
        .filter(route => route.suffix === 'react-message')
        .map(route => route.method)
        .sort(),
    ).toEqual(['DELETE', 'POST']);
    expect(lookupCliRoute('DELETE', 'react-message')).toEqual({
      noun: 'message',
      verb: 'react',
      routeSuffix: 'react-message',
    });
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
    expect(lookupCliRoute('GET', 'attachments/abc123/download')).toEqual({
      noun: 'file',
      verb: 'view',
      routeSuffix: 'attachments/*/download',
    });
    // The wildcard is single-segment — extra slashes do NOT match.
    expect(lookupCliRoute('GET', 'attachments/a/b/locate')).toBeNull();
    expect(lookupCliRoute('GET', 'attachments/a/b/download')).toBeNull();
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

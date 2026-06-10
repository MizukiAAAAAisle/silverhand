/**
 * Drift guard for the CLI invoke route map.
 *
 * Three invariants we never want to lose:
 *
 *   1. Every entry in `CLI_INVOKE_ROUTES` maps to a `(noun, verb)` pair
 *      that actually exists in `COMMAND_GROUPS`. If we rename a CLI
 *      verb, the test points at the orphan immediately.
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

/**
 * Read the backend route source and build a map from `internalPaths`
 * helper name → registered HTTP method (`'GET'|'POST'`).
 *
 * Internal route registrations live in `routes.ts` AND in the extracted
 * per-context route modules under `src/routes/` (the #task:966/#967 context
 * split moved e.g. `agentAddConversationMember` into `routes/membership.ts`).
 * We scan all of them so the guard follows handlers as they move out of the
 * monolith.
 *
 * Uses a regex over the source rather than booting the app: cheaper,
 * deterministic, and the test wants to fail when the *source registers*
 * the wrong method, not when a runtime probe happens to 404.
 */
function buildRegistrationMap(): Map<string, 'GET' | 'POST'> {
  const here = dirname(fileURLToPath(import.meta.url));
  const srcDir = resolve(here, '../../src');
  const routesDir = resolve(srcDir, 'routes');
  const files = [
    resolve(srcDir, 'routes.ts'),
    ...readdirSync(routesDir)
      .filter(f => f.endsWith('.ts'))
      .map(f => resolve(routesDir, f)),
  ];
  const re = /app\.(get|post)\(\s*internalPaths\.(\w+)\s*\(/g;
  const map = new Map<string, 'GET' | 'POST'>();
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const method = m[1]!.toUpperCase() as 'GET' | 'POST';
      const name = m[2]!;
      // First registration wins. There should never be duplicates; if a
      // name shows up twice we fail loudly below.
      if (map.has(name) && map.get(name) !== method) {
        throw new Error(
          `internalPaths.${name} registered with both ${map.get(name)} and ${method}`,
        );
      }
      map.set(name, method);
    }
  }
  return map;
}

function isAttachmentWildcardRoute(name: string): boolean {
  return name === 'agentLocateAttachment' || name === 'agentDownloadAttachment';
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
    const registered = buildRegistrationMap();
    for (const [name, fn] of builders) {
      // Each helper is `(cid, aid, ...rest) => string`. Probe with
      // placeholder ids; collapse `:attachmentId` to `*` for the
      // attachment file-view routes since the middleware matches by
      // single segment.
      const probed =
        isAttachmentWildcardRoute(name)
          ? (fn as (...a: string[]) => string)(':cid', ':aid', 'ATT')
          : (fn as (...a: string[]) => string)(':cid', ':aid');
      const suffix = suffixOf(probed).replace('/ATT/', '/*/');
      // Strict match: the test must know the exact registered method.
      // Without this the previous `GET ?? POST` fallback masked the
      // 5/14 `schedules/list` regression — the map said GET, the route
      // was POST, and the test still passed because POST happened to
      // hit. Now: ground-truth method must be registered AND must
      // match the route-map's declared method.
      const expectedMethod = registered.get(name);
      expect(
        expectedMethod,
        `internalPaths.${name} is not registered in any backend route source (no app.get/app.post call)`,
      ).toBeDefined();
      const hit = lookupCliRoute(expectedMethod!, suffix);
      expect(
        hit,
        `internalPaths.${name} (${expectedMethod} ${probed}) has no CLI_INVOKE_ROUTES entry — middleware will log noun=null,verb=null`,
      ).not.toBeNull();
    }
  });

  it('every CLI_INVOKE_ROUTES entry method matches the backend route registration', () => {
    // Reverse direction: walk the route map, find the matching
    // internalPaths helper by suffix, and assert the methods agree.
    // This catches the case where someone updates the map to a method
    // that isn't actually registered (the cli-invoke middleware would
    // then start logging None.None for that endpoint).
    const registered = buildRegistrationMap();
    const builders = Object.entries(internalPaths).filter(
      ([name]) => !NON_CLI_INTERNAL_ROUTES.has(name),
    );
    const suffixToName = new Map<string, string>();
    for (const [name, fn] of builders) {
      const probed =
        isAttachmentWildcardRoute(name)
          ? (fn as (...a: string[]) => string)(':cid', ':aid', 'ATT')
          : (fn as (...a: string[]) => string)(':cid', ':aid');
      const suffix = suffixOf(probed).replace('/ATT/', '/*/');
      suffixToName.set(suffix, name);
    }
    for (const r of CLI_INVOKE_ROUTES) {
      const name = suffixToName.get(r.suffix);
      expect(
        name,
        `CLI_INVOKE_ROUTES entry ${r.method} ${r.suffix} has no matching internalPaths helper`,
      ).toBeDefined();
      const actualMethod = registered.get(name!);
      expect(
        actualMethod,
        `CLI_INVOKE_ROUTES entry ${r.method} ${r.suffix} → internalPaths.${name} is not registered in any backend route source`,
      ).toBeDefined();
      expect(
        actualMethod,
        `CLI_INVOKE_ROUTES entry ${r.method} ${r.suffix} → backend route sources register ${actualMethod} for internalPaths.${name}; the map will produce None.None in cli-*.log`,
      ).toBe(r.method);
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

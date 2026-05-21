/**
 * `applyProxyEnv` — pure helper that overlays user-configured proxy
 * env (`http_proxy` / `https_proxy` / `all_proxy` + uppercase pairs)
 * onto a base env when the runtime is in the user-configured proxy
 * allowlist.
 *
 * Why this lives here (not as a private CM method anymore): the
 * silverhand-daemon refactor (PR-2) introduces `RuntimeBridge` as
 * backend's command-side seam to the daemon. Bridge must inject the
 * same proxy env into `runtime_start.options.env` so the daemon-spawned
 * runtime sees the same Settings-derived env CM has always assembled.
 * Cindy's commit 4/5 review blocker (`KzTBo4xxUmcx77yR` /
 * `QDF5xr23ehj1RhzY` / shiki `piIb3YZgFjA5qaaE`) explicitly requires:
 *
 *   - PRESERVE existing CM semantics — same `SettingsRepo.get(PROXY_URL)`
 *     + comma-separated `PROXY_RUNTIMES` allowlist + `expandProxyEnv()`
 *     parsing as today; do NOT redesign.
 *   - DAEMON STAYS DUMB — it never reads SettingsRepo / DB. backend is
 *     the only proxy-config reader; daemon just spreads `options.env`
 *     into the child env via `driver.applyEnv` and `spawn`.
 *   - SAME HELPER on BOTH sides — CM (today) and RuntimeBridge
 *     (post-flip) call the SAME function so the codex proxy
 *     allowlist behavior is provably identical across the cutover.
 *
 * Pure: no DB read, no logging, no side effects. Callers own the
 * settings read so this helper can be tested with literal values.
 */
import { expandProxyEnv } from '../proxy.js';

/**
 * Apply proxy env if the given runtime is in the user's allowlist.
 *
 * Semantics (1:1 with the prior CM `applyProxySetting` method):
 *   1. `proxyUrl` empty/null → no-op; return baseEnv unchanged.
 *   2. `allowlist` does not include `runtime` → no-op; return baseEnv.
 *   3. `expandProxyEnv(proxyUrl)` returns null (input parsed to
 *      nothing meaningful) → no-op; return baseEnv.
 *   4. Otherwise → `{ ...baseEnv, ...expanded }` (proxy keys override
 *      any caller-supplied placeholders).
 *
 * The `runtime` argument is typed `string` (not `RuntimeKind`) on
 * purpose: settings store the allowlist as a free-form
 * comma-separated string, so a typo there should silently miss every
 * runtime, not crash. Validation of the allowlist contents stays the
 * caller's responsibility (CM uses `parseRuntimeList`; the bridge
 * uses the same helper — see `parseProxyRuntimes` below).
 *
 * @param baseEnv      env produced by the upstream driver / process
 *                     env merge — proxy keys layer on top.
 * @param runtime      the agent's runtime kind (`'claude'`, `'codex'`,
 *                     `'cursor'`, `'gemini'`).
 * @param settings     `{proxyUrl, allowlist}` snapshot the caller
 *                     already read from `SettingsRepo`. Passing the
 *                     allowlist as a `Set<string>` (not the raw
 *                     comma-separated string) keeps the helper pure
 *                     and lets callers re-use the same parsed set
 *                     across multiple `applyProxyEnv` calls in a
 *                     spawn batch.
 */
export function applyProxyEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtime: string,
  settings: { proxyUrl: string | null; allowlist: Set<string> },
): NodeJS.ProcessEnv {
  if (!settings.proxyUrl) return baseEnv;
  if (!settings.allowlist.has(runtime)) return baseEnv;
  const expanded = expandProxyEnv(settings.proxyUrl);
  if (!expanded) return baseEnv;
  return { ...baseEnv, ...expanded };
}

/**
 * Parse a comma-separated `proxy_runtimes` settings value (CM's
 * historic format) into a Set, robust to whitespace and empty entries.
 *
 * Pulled out as a sibling helper so both CM and `RuntimeBridge` use
 * the exact same parsing — keeps the codex / claude allowlist behavior
 * stable across the commit-5 cutover. (Behavior matches CM's prior
 * private `parseRuntimeList` verbatim; we did not relax or tighten
 * any rule.)
 */
export function parseProxyRuntimes(raw: string | null): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0),
  );
}

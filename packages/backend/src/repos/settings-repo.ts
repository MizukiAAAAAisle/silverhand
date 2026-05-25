import type { Database as Db } from 'better-sqlite3';
import { RuntimeKindSchema, type RuntimeKind } from '@silverhand/shared';

/**
 * `app_settings` is a flat key/value store for host-wide preferences.
 * Currently used for:
 *
 *   - `proxy_url` — when non-empty, the runtime spawn env injects
 *     HTTP_PROXY / HTTPS_PROXY / ALL_PROXY (uppercase + lowercase) into
 *     every spawned agent process whose runtime is in the
 *     `proxy_runtimes` allowlist. Lets users with corporate firewalls /
 *     local proxies point per-runtime CLIs (e.g. just codex) at one URL
 *     without having to remember to `export http_proxy=...` before
 *     `pnpm dev`. The composition lives in `runtime/spawn-env.ts`
 *     (`applyProxyEnv`); `RuntimeBridge` reads these settings at wake
 *     time so the daemon never needs DB access.
 *   - `proxy_runtimes` — comma-separated runtime kinds (e.g. `codex,cursor`)
 *     that the proxy applies to. Empty/unset = no runtime gets the proxy
 *     even if `proxy_url` is set (explicit opt-in).
 *   - `viewer_user_id` — id of the registered viewer (V1 single user).
 *     Legacy WS bridge only after Stage A.4: HTTP no longer resolves
 *     principals from this setting, but event WS still uses it to
 *     canonicalize `viewer:self` until Stage C moves WS to session
 *     auth. Legacy `/api/register` writes it atomically with user
 *     creation; `/auth/signup` and `/auth/login` also update it as a
 *     transient bridge for desktop session users. Stage C deletes the
 *     read and these auth-route writes together.
 */
export class SettingsRepo {
  constructor(private readonly db: Db) {}

  get(key: string): string | null {
    const row = this.db
      .prepare<[string], { value: string }>(
        'SELECT value FROM app_settings WHERE key = ?',
      )
      .get(key);
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    if (value === '') {
      this.db
        .prepare('DELETE FROM app_settings WHERE key = ?')
        .run(key);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  all(): Record<string, string> {
    const rows = this.db
      .prepare<[], { key: string; value: string }>(
        'SELECT key, value FROM app_settings',
      )
      .all();
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  /** Read the proxy allowlist as a parsed array of runtime kinds.
   *  Stored as a comma-separated string. Unknown values (e.g. legacy
   *  agent ids left over from before the migration to runtime-scoped
   *  allowlists) are silently dropped — `RuntimeKindSchema` is the
   *  authoritative whitelist. */
  getProxyRuntimes(): RuntimeKind[] {
    const raw = this.get(SETTINGS_KEYS.PROXY_RUNTIMES);
    if (!raw) return [];
    const out: RuntimeKind[] = [];
    for (const part of raw.split(',').map(s => s.trim()).filter(Boolean)) {
      const parsed = RuntimeKindSchema.safeParse(part);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  /** Legacy WS viewer pointer (see class docstring). Returns null when
   *  the transient bridge has not been seeded; WS callers must reject
   *  null rather than guessing a viewer. */
  getViewerUserId(): string | null {
    return this.get(SETTINGS_KEYS.VIEWER_USER_ID);
  }
}

export const SETTINGS_KEYS = {
  /** Proxy URL applied as HTTP_PROXY/HTTPS_PROXY/ALL_PROXY (and lowercase
   *  variants) to spawned agent processes. Empty = no injection. */
  PROXY_URL: 'proxy_url',
  /** Comma-separated runtime kinds (claude/codex/cursor/gemini) that the
   *  proxy applies to. Empty (or unset) means **no runtime** gets the
   *  proxy even if `PROXY_URL` is set — explicit opt-in per runtime. */
  PROXY_RUNTIMES: 'proxy_runtimes',
  /** V1 viewer pointer (see class docstring). */
  VIEWER_USER_ID: 'viewer_user_id',
} as const;

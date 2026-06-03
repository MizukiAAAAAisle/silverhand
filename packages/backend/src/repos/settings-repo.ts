import type { Database as Db } from 'better-sqlite3';

/**
 * `app_settings` is a flat key/value store for legacy host-wide
 * preferences. Runtime proxy settings used to live here, but proxy is now
 * daemon-host local truth and is read/written through host IPC instead.
 *
 * `viewer_user_id` may still exist in old databases. C.5 stops treating
 * it as a current-viewer bridge; settings routes keep hiding/rejecting
 * the key until a later schema cleanup drops the row entirely.
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

}

export const SETTINGS_KEYS = {
  /** Deprecated persisted key retained only for hide/reject compatibility. */
  VIEWER_USER_ID: 'viewer_user_id',
} as const;

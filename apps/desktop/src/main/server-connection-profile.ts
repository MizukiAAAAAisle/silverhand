/**
 * D4.a Commit 2 — desktop main-process storage for the server
 * connection profile (per `docs/remote-backend-d4-design.md` §7.2).
 *
 * Contract:
 *   - File path: `<silverhandDir>/desktop/server-profile.bin`,
 *     mode 0600.
 *   - Contents: JSON-serialized {@link ServerConnectionProfile},
 *     encrypted with `safeStorage.encryptString` (the same primitive
 *     A.4 already uses for the user session bearer — see
 *     `loadPersistedUserSessionToken` in `main/index.ts`).
 *   - Writes are atomic: temp file → `writeFileSync({ mode: 0o600 })`
 *     → `fsync` → `rename` over the live path → `chmod` belt-and-
 *     braces. Crash anywhere before the rename leaves the old profile
 *     intact (per §7.5 phase-1 semantics).
 *
 * Scope discipline (Commit 2 only):
 *   - Read / write / clear primitives.
 *   - No daemon-config derivation here — that's Commit 5 (the
 *     additive `profile_version` field + phase-2 reload pipeline).
 *   - No `partial_apply_pending` state machine yet — Commit 2 only
 *     commits the profile; there is no phase 2 to fall partway out
 *     of.
 *   - No environment-variable bootstrap path; §7.7 calls that
 *     explicitly out of scope for D4.
 *
 * Failure mode for `safeStorage` unavailable:
 *   - macOS dev / packaged builds always have it. CI in headless Linux
 *     may not. We treat "unavailable" as a hard fail at write time
 *     (caller surfaces a typed error to the renderer) rather than
 *     silently persisting plaintext. At read time the same condition
 *     reports `{ ok: false, reason: 'storage_unavailable' }` so the
 *     caller can render an actionable diagnostic instead of "no
 *     profile".
 */
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync, openSync, fsyncSync, closeSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SERVER_CONNECTION_PROFILE_MIN_VERSION,
  redactServerConnectionProfile,
  safeParseServerConnectionProfile,
  type ServerConnectionProfile,
  type ServerConnectionProfileView,
} from '@silverhand/shared';

// NOTE: we deliberately do NOT `import { safeStorage } from 'electron'`
// here so vitest (`environment: 'node'`) can load this module without
// pulling in the Electron runtime. Callers in `main/index.ts` pass the
// real `safeStorage` via the `safe` option; unit tests pass a fake
// (see `server-connection-profile.test.ts`).

/**
 * The on-disk filename for the profile blob. Lives under the desktop
 * sub-directory inside the user's silverhand dir so it sits next to
 * the existing `session.bin` (see `desktopSessionPath` in `main/index.ts`).
 * Both files are managed by the same A.4 secret-handling pattern.
 */
export const SERVER_CONNECTION_PROFILE_FILENAME = 'server-profile.bin';

/**
 * Compute the absolute on-disk path for the profile blob given a
 * silverhand root directory (`~/.silverhand` by default, overridable
 * via `SILVERHAND_DIR` env at the main entrypoint).
 *
 * Pure path computation — does NOT verify existence or touch the
 * filesystem.
 */
export function serverConnectionProfilePath(silverhandRoot: string): string {
  return join(silverhandRoot, 'desktop', SERVER_CONNECTION_PROFILE_FILENAME);
}

/**
 * Minimal Electron `safeStorage` surface this module depends on.
 * Extracted so tests can inject a fake without standing up an Electron
 * runtime. Production callers pass the real `safeStorage` from
 * `electron`.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

/**
 * Logger seam — production callers pass the pino `FileLogger` instance;
 * tests pass a noop. Avoids importing the heavy server logger type into
 * this leaf module.
 */
export interface ProfileStorageLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
}

const noopLogger: ProfileStorageLogger = {
  warn: () => undefined,
  info: () => undefined,
};

/**
 * Options bag for the storage primitives. `silverhandRoot` is required
 * so the same module can be unit-tested against a temp dir without
 * monkey-patching `homedir()`. `safe` is required at the IPC layer
 * (callers in `main/index.ts` pass Electron's real `safeStorage`); for
 * unit tests, pass a fake (see `server-connection-profile.test.ts`).
 */
export interface ProfileStorageOptions {
  silverhandRoot: string;
  safe: SafeStorageLike;
  /** `Date.now`-style clock seam. Defaults to `Date.now`. */
  now?: () => number;
  logger?: ProfileStorageLogger;
}

function resolveSafe(opts: ProfileStorageOptions): SafeStorageLike {
  return opts.safe;
}

function resolveNow(opts: ProfileStorageOptions): () => number {
  return opts.now ?? (() => Date.now());
}

function resolveLogger(opts: ProfileStorageOptions): ProfileStorageLogger {
  return opts.logger ?? noopLogger;
}

/**
 * Read outcome:
 *   - `{ ok: true, profile }` — profile decoded and schema-validated.
 *   - `{ ok: false, reason: 'not_found' }` — no file on disk yet
 *     (pre-Wizard state). Callers render the "no profile yet" UX.
 *   - `{ ok: false, reason: 'storage_unavailable' }` — `safeStorage`
 *     reported encryption is not available on this platform; we
 *     refuse to read so a corrupt blob doesn't surface as garbage.
 *   - `{ ok: false, reason: 'decrypt_failed' }` — file exists but
 *     `safeStorage.decryptString` threw. Almost always means the OS
 *     keychain entry for Electron's safeStorage was rotated, or the
 *     file was tampered with. Caller policy: surface a typed error
 *     and offer the user a "clear and re-enter URL" affordance.
 *   - `{ ok: false, reason: 'parse_failed', detail }` — decrypted to
 *     non-JSON or to an object that doesn't match the schema. The
 *     `detail` carries the zod issue summary for the operator log.
 */
export type ReadProfileResult =
  | { ok: true; profile: ServerConnectionProfile }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'storage_unavailable' }
  | { ok: false; reason: 'decrypt_failed' }
  | { ok: false; reason: 'parse_failed'; detail: string };

/**
 * Read the persisted profile, if any.
 *
 * Returns a typed outcome union — never throws for "expected" missing /
 * decrypt-failed / parse-failed cases. Unexpected I/O errors (EACCES,
 * EIO, etc.) DO throw; they indicate a deeper system problem that the
 * caller should not silently swallow.
 */
export function readServerConnectionProfile(
  opts: ProfileStorageOptions,
): ReadProfileResult {
  const safe = resolveSafe(opts);
  const logger = resolveLogger(opts);
  const path = serverConnectionProfilePath(opts.silverhandRoot);
  if (!existsSync(path)) {
    return { ok: false, reason: 'not_found' };
  }
  if (!safe.isEncryptionAvailable()) {
    logger.warn(
      { path },
      'safeStorage encryption unavailable; refusing to read server connection profile',
    );
    return { ok: false, reason: 'storage_unavailable' };
  }
  let plaintext: string;
  try {
    plaintext = safe.decryptString(readFileSync(path));
  } catch (err) {
    logger.warn(
      { path, err },
      'failed to decrypt server connection profile blob',
    );
    return { ok: false, reason: 'decrypt_failed' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch (err) {
    logger.warn(
      { path, err },
      'server connection profile blob decrypted but JSON parse failed',
    );
    return { ok: false, reason: 'parse_failed', detail: String(err) };
  }
  const result = safeParseServerConnectionProfile(parsed);
  if (!result.ok) {
    logger.warn(
      { path, detail: result.reason },
      'server connection profile blob failed schema validation',
    );
    return { ok: false, reason: 'parse_failed', detail: result.reason };
  }
  return { ok: true, profile: result.profile };
}

/**
 * Convenience: read + redact, returning the renderer-safe view or null
 * if nothing is persisted / readable. Used by the `profile:get` IPC
 * which never exposes raw schema metadata to the renderer.
 */
export function readServerConnectionProfileViewOrNull(
  opts: ProfileStorageOptions,
): ServerConnectionProfileView | null {
  const result = readServerConnectionProfile(opts);
  if (!result.ok) return null;
  return redactServerConnectionProfile(result.profile);
}

/**
 * Write outcome:
 *   - `{ ok: true, profile }` — full committed profile (caller may
 *     redact for the renderer via {@link redactServerConnectionProfile}).
 *   - `{ ok: false, reason: 'storage_unavailable' }` — `safeStorage`
 *     not available; refuse rather than persist plaintext.
 *   - `{ ok: false, reason: 'write_failed', detail }` — I/O failed
 *     after the temp file was created; storage is left in its
 *     pre-write state (rename never ran). `detail` is the message of
 *     the underlying error for the operator log.
 */
export type WriteProfileResult =
  | { ok: true; profile: ServerConnectionProfile }
  | { ok: false; reason: 'storage_unavailable' }
  | { ok: false; reason: 'write_failed'; detail: string };

/**
 * Commit a server connection profile to disk.
 *
 * Pipeline (per §7.5 phase 1):
 *   1. Decide created_at / updated_at: if a prior profile exists,
 *      preserve `created_at` and stamp `updated_at = now()`. If no
 *      prior profile exists, set both to `now()`.
 *   2. Encrypt the JSON blob via `safeStorage.encryptString`.
 *   3. Write to a temp file (unique per process+uuid) with mode 0600.
 *   4. `fsync` the temp file so the bytes are durable before the rename
 *      flips the live name.
 *   5. `rename` over the live path — atomic for a single file on
 *      POSIX filesystems (the OS guarantees readers see either the old
 *      inode or the new inode, never a half-written file).
 *   6. `chmod 0600` as belt-and-braces (some umasks let creation drop
 *      bits even when `mode` was passed to `writeFileSync`).
 *   7. On any throw between step 3 and step 5, the temp file is
 *      unlinked best-effort and the error is propagated as
 *      `{ ok: false, reason: 'write_failed' }`.
 */
export function writeServerConnectionProfile(
  opts: ProfileStorageOptions & { serverUrl: string },
): WriteProfileResult {
  const safe = resolveSafe(opts);
  const logger = resolveLogger(opts);
  const now = resolveNow(opts)();
  const path = serverConnectionProfilePath(opts.silverhandRoot);

  if (!safe.isEncryptionAvailable()) {
    logger.warn(
      { path },
      'safeStorage encryption unavailable; refusing to write server connection profile',
    );
    return { ok: false, reason: 'storage_unavailable' };
  }

  // Preserve `created_at` across overwrites AND advance `version` as a
  // generation counter (Cindy D4.a Commit 2 review fixup): the §7.5
  // phase-2 reconciliation compares `profile.version` vs
  // `daemon-config.profile_version` to decide whether a daemon-config
  // derivation is pending — so each successful commit MUST bump the
  // generation, regardless of whether the URL changed. If reading
  // the prior profile fails for any non-`not_found` reason we still
  // proceed with a fresh `created_at` AND restart the generation
  // at the floor — a wedged old blob must not prevent the user from
  // setting a new URL, and inheriting a generation we couldn't parse
  // would be worse than starting clean.
  const existing = readServerConnectionProfile({
    silverhandRoot: opts.silverhandRoot,
    safe,
    logger,
  });
  const createdAt = existing.ok ? existing.profile.created_at : now;
  const nextVersion = existing.ok
    ? existing.profile.version + 1
    : SERVER_CONNECTION_PROFILE_MIN_VERSION;

  const profile: ServerConnectionProfile = {
    version: nextVersion,
    server_url: opts.serverUrl,
    created_at: createdAt,
    updated_at: now,
  };

  let ciphertext: Buffer;
  try {
    ciphertext = safe.encryptString(JSON.stringify(profile));
  } catch (err) {
    logger.warn(
      { path, err },
      'safeStorage.encryptString threw while writing server connection profile',
    );
    return { ok: false, reason: 'write_failed', detail: String(err) };
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (err) {
    logger.warn(
      { dir: dirname(path), err },
      'failed to ensure desktop profile directory',
    );
    return { ok: false, reason: 'write_failed', detail: String(err) };
  }

  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmp, ciphertext, { mode: 0o600 });
    // Force the encrypted bytes to disk before we rename. Without
    // fsync a crash between the write and the rename could leave the
    // rename pointing at a zero-byte inode — the design explicitly
    // requires fsync here.
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    try {
      chmodSync(path, 0o600);
    } catch (err) {
      // chmod failure on the live file is not fatal — the temp
      // creation already set mode 0600, so this is belt-and-braces.
      // Log and continue.
      logger.warn(
        { path, err },
        'chmod 0600 on server connection profile failed (best-effort)',
      );
    }
  } catch (err) {
    // Best-effort cleanup of the temp file. If unlink itself fails
    // we swallow — the temp name is uuid-suffixed so it won't
    // collide with the live path.
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    logger.warn(
      { path, err },
      'failed to commit server connection profile (temp+fsync+rename)',
    );
    return { ok: false, reason: 'write_failed', detail: String(err) };
  }

  return { ok: true, profile };
}

/**
 * Clear outcome:
 *   - `{ ok: true; cleared: boolean }` — `cleared` indicates whether a
 *     file was actually present before the call (true) or not (false).
 *   - `{ ok: false; reason: 'unlink_failed'; detail }` — the file
 *     existed but `unlink` threw. Caller surfaces a typed error.
 */
export type ClearProfileResult =
  | { ok: true; cleared: boolean }
  | { ok: false; reason: 'unlink_failed'; detail: string };

/**
 * Remove the persisted profile, if any. Idempotent: a non-existent
 * file is reported as `{ ok: true, cleared: false }`, not an error.
 *
 * Intended for two cases:
 *   - User explicitly disconnects from a remote backend.
 *   - Recovery from `decrypt_failed` / `parse_failed` reads (the
 *     renderer offers a "reset and re-enter URL" affordance).
 */
export function clearServerConnectionProfile(
  opts: ProfileStorageOptions,
): ClearProfileResult {
  const logger = resolveLogger(opts);
  const path = serverConnectionProfilePath(opts.silverhandRoot);
  if (!existsSync(path)) {
    return { ok: true, cleared: false };
  }
  try {
    unlinkSync(path);
    return { ok: true, cleared: true };
  } catch (err) {
    logger.warn(
      { path, err },
      'failed to unlink server connection profile blob',
    );
    return { ok: false, reason: 'unlink_failed', detail: String(err) };
  }
}

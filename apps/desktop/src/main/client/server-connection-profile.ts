import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  SERVER_CONNECTION_PROFILE_MIN_VERSION,
  redactServerConnectionProfile,
  safeParseServerConnectionProfile,
  type ServerConnectionProfile,
  type ServerConnectionProfileView,
} from "@silverhand/shared";

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
 * Options bag for the storage primitives. `profilePath` is the RESOLVED
 * profile-file path (#task:1598 — desktop composition root:
 * `desktopAppPaths().desktop.serverProfile`); this leaf never derives it
 * from a root, so a future layout-version flip happens in the selector
 * only. Tests point it into a temp dir directly.
 */
export interface ProfileStorageOptions {
  profilePath: string;
  logger?: ProfileStorageLogger;
}

function resolveLogger(opts: ProfileStorageOptions): ProfileStorageLogger {
  return opts.logger ?? noopLogger;
}

/**
 * Read outcome:
 *   - `{ ok: true, profile }` — profile decoded and schema-validated.
 *   - `{ ok: false, reason: 'not_found' }` — no file on disk yet
 *     (pre-Wizard state). Callers render the "no profile yet" UX.
 *   - `{ ok: false, reason: 'parse_failed', detail }` — file exists
 *     but is not JSON or doesn't match the schema. The `detail`
 *     carries the parse/zod issue summary for the operator log.
 */
export type ReadProfileResult =
  | { ok: true; profile: ServerConnectionProfile }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "parse_failed"; detail: string };

/**
 * Read the persisted profile, if any.
 *
 * Returns a typed outcome union — never throws for missing, unreadable, or
 * parse-failed cases. A present-but-unusable file maps to `parse_failed` so the
 * caller can surface the same "reset profile" repair affordance regardless of
 * whether bytes could not be read or could not be parsed.
 */
export function readServerConnectionProfile(opts: ProfileStorageOptions): ReadProfileResult {
  const logger = resolveLogger(opts);
  const path = opts.profilePath;
  if (!existsSync(path)) {
    return { ok: false, reason: "not_found" };
  }
  let plaintext: string;
  try {
    plaintext = readFileSync(path, "utf8");
  } catch (err) {
    logger.warn({ path, err }, "failed to read server connection profile");
    return { ok: false, reason: "parse_failed", detail: String(err) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch (err) {
    logger.warn({ path, err }, "server connection profile JSON parse failed");
    return { ok: false, reason: "parse_failed", detail: String(err) };
  }
  const result = safeParseServerConnectionProfile(parsed);
  if (!result.ok) {
    logger.warn(
      { path, detail: result.reason },
      "server connection profile file failed schema validation",
    );
    return { ok: false, reason: "parse_failed", detail: result.reason };
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
 *   - `{ ok: false, reason: 'write_failed', detail }` — I/O failed
 *     after the temp file was created; storage is left in its
 *     pre-write state (rename never ran). `detail` is the message of
 *     the underlying error for the operator log.
 */
export type WriteProfileResult =
  | { ok: true; profile: ServerConnectionProfile }
  | { ok: false; reason: "write_failed"; detail: string };

/**
 * Commit a server connection profile to disk.
 *
 * Pipeline (per §7.5 phase 1):
 *   1. Decide created_at / updated_at: if a prior profile exists,
 *      preserve `created_at` and stamp `updated_at = now()`. If no
 *      prior profile exists, set both to `now()`.
 *   2. Serialize the JSON profile.
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
  const logger = resolveLogger(opts);
  const now = Date.now();
  const path = opts.profilePath;

  // Preserve `created_at` across overwrites AND advance `version` as a
  // generation counter (Cindy D4.a Commit 2 review fixup): the §7.5
  // phase-2 reconciliation compares `profile.version` vs
  // `daemon-config.profile_version` to decide whether a daemon-config
  // derivation is pending — so each successful commit MUST bump the
  // generation, regardless of whether the URL changed. If reading
  // the prior profile fails for any non-`not_found` reason we still
  // proceed with a fresh `created_at` AND restart the generation
  // at the floor — a wedged old file must not prevent the user from
  // setting a new URL, and inheriting a generation we couldn't parse
  // would be worse than starting clean.
  const existing = readServerConnectionProfile({
    profilePath: opts.profilePath,
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

  let serialized: string;
  try {
    serialized = JSON.stringify(profile);
  } catch (err) {
    logger.warn({ path, err }, "failed to serialize server connection profile");
    return { ok: false, reason: "write_failed", detail: String(err) };
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (err) {
    logger.warn({ dir: dirname(path), err }, "failed to ensure desktop profile directory");
    return { ok: false, reason: "write_failed", detail: String(err) };
  }

  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmp, serialized, { mode: 0o600 });
    // Force the profile bytes to disk before we rename. Without
    // fsync a crash between the write and the rename could leave the
    // rename pointing at a zero-byte inode — the design explicitly
    // requires fsync here.
    const fd = openSync(tmp, "r+");
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
      logger.warn({ path, err }, "chmod 0600 on server connection profile failed (best-effort)");
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
    logger.warn({ path, err }, "failed to commit server connection profile (temp+fsync+rename)");
    return { ok: false, reason: "write_failed", detail: String(err) };
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
  | { ok: false; reason: "unlink_failed"; detail: string };

/**
 * Remove the persisted profile, if any. Idempotent: a non-existent
 * file is reported as `{ ok: true, cleared: false }`, not an error.
 *
 * Intended for two cases:
 *   - User explicitly disconnects from a remote backend.
 *   - Recovery from `parse_failed` reads (the renderer offers a
 *     "reset and re-enter URL" affordance).
 */
export function clearServerConnectionProfile(opts: ProfileStorageOptions): ClearProfileResult {
  const logger = resolveLogger(opts);
  const path = opts.profilePath;
  if (!existsSync(path)) {
    return { ok: true, cleared: false };
  }
  try {
    unlinkSync(path);
    return { ok: true, cleared: true };
  } catch (err) {
    logger.warn({ path, err }, "failed to unlink server connection profile file");
    return { ok: false, reason: "unlink_failed", detail: String(err) };
  }
}

/**
 * `@silverhand/shared` — server connection profile primitive.
 *
 * D4.a Commit 2 (per `docs/remote-backend-d4-design.md` §7.1).
 *
 * ## What this is
 *
 * The desktop main process owns a single on-disk **server connection
 * profile** that is the canonical source of `server_url` for every
 * desktop ↔ backend transport across both pre-auth and post-auth
 * phases:
 *   - pre-auth `GET /api/server/info`, `POST /auth/signup`,
 *     `POST /auth/login`
 *   - post-auth `GET/POST /api/*` over the `backend:request` proxy
 *   - session validation refresh
 *   - SSE / event WebSocket subscription
 *   - B.2 `POST /api/hosts/claim-or-create`
 *   - D2 daemon outbound WSS (via the derived daemon-config — §7.6)
 *   - D3 daemon-config writer (the derived artifact)
 *
 * The profile is **intentionally minimal** (Cindy round-2 P1 + round-3
 * simplification): only stable connection configuration is persisted.
 * Derived diagnostic state — e.g. whether the current URL + active env
 * qualifies as `insecure_dev` (§8.3) — is computed at runtime from
 * `server_url` + `SILVERHAND_ALLOW_INSECURE_REMOTE`, NOT stored on the
 * profile. That avoids stale-flag drift if the env is toggled later.
 *
 * No `spki_pin` field. V1 does not support self-signed remote backends;
 * see §8 (TLS policy) and §10 (non-goals).
 *
 * ## What this module is NOT
 *
 * This file is the cross-process type / schema contract. It does NOT:
 *   - own storage (that's `apps/desktop/src/main/server-connection-profile.ts`)
 *   - own validation of the URL (that's `server-url.ts` — `classifyServerUrl`)
 *   - own daemon-config derivation (that's Commit 5)
 *
 * The split keeps the schema host-agnostic — the same shape lives in
 * the Electron main process (file I/O), the renderer (read-only redacted
 * view), and any future headless tooling.
 */
import { z } from 'zod';

/**
 * Current profile schema version. Bump when the shape changes
 * non-additively. Reads MUST tolerate older versions for forward
 * compatibility — see `safeParseServerConnectionProfile` below.
 *
 * D4.a V1 ships at version 1. Subsequent commits in D4.a (Commit 5
 * adds the phase-2 daemon-config bridge) do NOT bump this — they add
 * a derived field to the daemon-config artifact, not to the profile.
 */
export const SERVER_CONNECTION_PROFILE_VERSION = 1;

/**
 * Persisted shape of the server connection profile.
 *
 * Field contract (per §7.1):
 *   - `version` — monotonic schema version. Currently always `1`.
 *     Round-trips through the storage layer without modification. The
 *     §7.5 update flow uses the profile's GENERATION (separate concept,
 *     bumped on every commit) inside daemon-config as `profile_version`;
 *     `version` here is the SCHEMA version, not the generation count.
 *     (Design language reuses "version" for both — clarified here to
 *     prevent future readers from conflating the two.)
 *   - `server_url` — canonical URL string. Validation contract:
 *     `classifyServerUrl(server_url)` MUST succeed; this module does NOT
 *     re-run that check (callers do). Persisted as the user-typed
 *     string after URL parsing, so round-trips through `new URL()`.
 *   - `created_at` / `updated_at` — unix milliseconds. `created_at` is
 *     the first commit ts; `updated_at` is the latest commit ts. Both
 *     are populated by the storage layer at write time, NOT by the
 *     caller.
 */
export const ServerConnectionProfileSchema = z.object({
  version: z.literal(SERVER_CONNECTION_PROFILE_VERSION),
  server_url: z.string().min(1),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
});
export type ServerConnectionProfile = z.infer<
  typeof ServerConnectionProfileSchema
>;

/**
 * Redacted view that crosses the IPC boundary to the renderer.
 *
 * Per §7.2: "Persisted profile flows main → renderer only as a
 * redacted view." This is the redaction — we strip `version` and
 * `created_at` because the renderer has no business reading them
 * (`version` would tempt the renderer to branch on schema; `created_at`
 * is provenance metadata only the main process and audit logs care
 * about). The renderer only needs to render "current profile" UI in
 * Settings / Wizard, which is the URL plus a "last updated" timestamp.
 *
 * Encrypted blob never crosses IPC — consistent with the A.4 secret
 * handling convention for `userSessionToken`.
 */
export const ServerConnectionProfileViewSchema = z.object({
  server_url: z.string().min(1),
  updated_at: z.number().int().nonnegative(),
});
export type ServerConnectionProfileView = z.infer<
  typeof ServerConnectionProfileViewSchema
>;

/**
 * Convert a full profile into the renderer-facing redacted view.
 * Pure function — safe to call from any process.
 */
export function redactServerConnectionProfile(
  profile: ServerConnectionProfile,
): ServerConnectionProfileView {
  return {
    server_url: profile.server_url,
    updated_at: profile.updated_at,
  };
}

/**
 * Forward-compatible parser: tolerate older schema versions and
 * unknown extra fields, but reject anything that can't be coerced to
 * the current shape.
 *
 * Today V1 is the only version, so this is a thin wrapper. Keeping it
 * named separately means future upgrades can add a migration path here
 * without touching every call site.
 */
export function safeParseServerConnectionProfile(
  input: unknown,
): { ok: true; profile: ServerConnectionProfile } | { ok: false; reason: string } {
  const result = ServerConnectionProfileSchema.safeParse(input);
  if (result.success) return { ok: true, profile: result.data };
  return {
    ok: false,
    reason: result.error.issues
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; '),
  };
}

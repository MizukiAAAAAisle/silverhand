import { z } from 'zod';

/**
 * #task:1530 — desktop release telemetry wire contract.
 *
 * The desktop client reports its release identity to the server ON the
 * authenticated event-WS upgrade, as ONE optional request header. The server
 * logs it (structured, redacted) so release/version rollout across the fleet is
 * observable in the ECS backend/server JSONL logs — no persistent table, no
 * rollout state machine.
 *
 * This is UNTRUSTED input at the server boundary: the header is bounded-parsed
 * into `valid | missing | invalid` and NEVER `JSON.parse`+spread into a logger.
 * Telemetry is fail-open — a missing/malformed header must NEVER reject the WS
 * upgrade. `missing` is still logged (so we can observe old desktops that don't
 * send the header at all); `invalid` logs only the status, never the raw header
 * or a parse error.
 *
 * Bounded-context note: this describes the desktop↔server RELEASE identity, not
 * the daemon↔server wire protocol. It deliberately carries NO `protocol_version`
 * — `OUTBOUND_PROTOCOL_VERSION` is the daemon-wire epoch, a different concept;
 * `app_version` + `build_commit` already pin what a given build speaks.
 */

/**
 * The request header the desktop main process injects onto the event-WS
 * upgrade (Node lowercases incoming header keys, so this is lowercase).
 */
export const CLIENT_INFO_HEADER = 'x-silverhand-client-info';

/**
 * Hard cap on the raw header string before any parse. The real payload is well
 * under 512 bytes (a uuid + a 40-hex sha + short version/platform strings); this
 * bounds a hostile/oversized header cheaply, measured BEFORE `JSON.parse`.
 */
export const CLIENT_INFO_HEADER_MAX_BYTES = 1024;

/**
 * The deployment shape the desktop build runs in. Values are used verbatim in
 * the server log and in aggregation queries — `remote-only` (not `remote`) so
 * they never collide with the runtime server-mode enum (`embedded | remote`).
 */
export const ClientDeploymentSchema = z.enum(['embedded', 'remote-only']);
export type ClientDeployment = z.infer<typeof ClientDeploymentSchema>;

/**
 * Bounded schema for the client-info payload. Every field is length- and
 * charset-constrained; `.strict()` rejects unknown keys so a malformed/padded
 * payload lands in `invalid` rather than leaking arbitrary shape into the log.
 */
export const ClientInfoSchema = z
  .object({
    /** The reporting surface. v1 is desktop-only. */
    client_surface: z.literal('desktop'),
    deployment: ClientDeploymentSchema,
    /**
     * Desktop release semver (`app.getVersion()`), e.g. `0.1.0` / `1.2.3-beta.1`.
     * Bounded to a real semver shape so pseudo-versions (`abc`, `---`) are
     * classified `invalid` rather than logged as `valid` and polluting fleet
     * version aggregation. Length-capped first as a cheap defense.
     */
    app_version: z
      .string()
      .max(40)
      .regex(
        /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?(?:\+[0-9A-Za-z.-]{1,32})?$/,
      ),
    /** Full 40-hex commit sha, or the `dev` sentinel for un-stamped dev builds. */
    build_commit: z.string().regex(/^(dev|[0-9a-f]{40})$/),
    /** True iff the packaged tree had uncommitted changes at build time. */
    build_dirty: z.boolean(),
    /** `process.platform` — bounded (darwin/win32/linux/...). */
    platform: z
      .string()
      .min(1)
      .max(16)
      .regex(/^[a-z0-9]+$/),
    /** `process.arch` — bounded (arm64/x64/...). */
    arch: z
      .string()
      .min(1)
      .max(16)
      .regex(/^[a-z0-9]+$/),
    /** The existing stable per-install identity (`installation_id` file). */
    installation_id: z.string().uuid(),
  })
  .strict();
export type ClientInfo = z.infer<typeof ClientInfoSchema>;

export type ClientInfoStatus = 'valid' | 'missing' | 'invalid';

export type ClientInfoParseResult =
  | { status: 'valid'; value: ClientInfo }
  | { status: 'missing' }
  | { status: 'invalid' };

/**
 * Serialize a validated client-info payload into the header string the desktop
 * sends. Validates first so the sender can never emit a payload the server
 * would classify `invalid`.
 */
export function serializeClientInfoHeader(info: ClientInfo): string {
  return JSON.stringify(ClientInfoSchema.parse(info));
}

/**
 * Bounded parse of the raw header value at the server boundary. Never throws.
 *
 * - `undefined` / empty / whitespace → `missing` (observe old desktops).
 * - repeated header (array), over-size, non-JSON, or schema mismatch → `invalid`
 *   (record only the status — never the raw header or the parse error).
 * - well-formed + schema-valid → `valid` with the normalized payload.
 *
 * Size is measured with `TextEncoder` (not Node `Buffer`) to keep this module
 * host-agnostic per the `@silverhand/shared` boundary.
 */
export function parseClientInfoHeader(
  raw: string | string[] | undefined,
): ClientInfoParseResult {
  if (raw === undefined) return { status: 'missing' };
  // A repeated header arrives as an array — treat as malformed, not "pick one".
  if (Array.isArray(raw)) return { status: 'invalid' };
  const trimmed = raw.trim();
  if (trimmed === '') return { status: 'missing' };
  if (new TextEncoder().encode(trimmed).length > CLIENT_INFO_HEADER_MAX_BYTES) {
    return { status: 'invalid' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { status: 'invalid' };
  }
  const result = ClientInfoSchema.safeParse(parsed);
  return result.success
    ? { status: 'valid', value: result.data }
    : { status: 'invalid' };
}

import { z } from 'zod';
import { apiPaths } from './api/paths.js';

/**
 * #task:1761 — desktop↔server application API epoch (safe version skew).
 *
 * This is the SINGLE ROOT for the desktop↔server REST/Event-WS compatibility
 * contract. The server-info advertisement, the REST admission middleware, the
 * event-WS admission check, and the desktop startup gate must all derive from
 * the constants in this file — never from HOST_PROTOCOL_VERSION,
 * OUTBOUND_PROTOCOL_VERSION, the DB schema version, app semver, or a build
 * commit. One boundary, one axis.
 *
 * Compatibility model (default "A — safe rejection", see the runbook):
 *   - additive, old-side-safe changes do NOT bump the epoch;
 *   - breaking DTO/behavior changes bump the ATOMIC TRIPLE (current epoch +
 *     both minimums, same value) in the SAME commit — see the constant docs
 *     and runbook §3;
 *   - incompatibility is detected BEFORE business DTOs are read and surfaces
 *     as a typed rejection (HTTP 426 / startup gate), never a deep parse
 *     failure.
 *
 * Runbook (bump rules, rollout order, bridge policy):
 *   docs/desktop-server-api-epoch.md
 */

/**
 * The current desktop↔server application contract generation. Compiled into
 * both the server (advertise + enforce) and the desktop (send + self-check)
 * from this one constant; a version-skewed pair compares ranges at admission.
 *
 * Monotonic integer. **Plan A (default) bump rule — atomic triple:** a
 * breaking REST DTO / event shape / behavior change bumps
 * DESKTOP_SERVER_API_EPOCH, MINIMUM_CLIENT_API_EPOCH, and
 * MINIMUM_SERVER_API_EPOCH to the SAME new value in the SAME commit.
 * Leaving a minimum behind silently re-admits the incompatible pair plan A
 * exists to reject; only an explicit plan-B bridge (adapter + §11 exit
 * conditions) may hold a minimum back, and it must change the lockstep test
 * in the same commit. See docs/desktop-server-api-epoch.md §3–4.
 */
export const DESKTOP_SERVER_API_EPOCH = 1;

/**
 * #task:1761 (Cindy round-2 P1) — the ADMISSION header. Dedicated and
 * minimal: the value is the decimal rendering of the compiled epoch, so
 * assembling it involves no IO and no schema and cannot fail — unlike the
 * fail-open client-info telemetry header, which stays observability-only.
 * Sent by the desktop main process on every backend REST request and the
 * event-WS upgrade.
 */
export const DESKTOP_API_EPOCH_HEADER = 'x-silverhand-desktop-api-epoch';

/**
 * Parse the dedicated epoch header at the server boundary. Never throws.
 * Absent/empty → 0 (pre-epoch legacy generation). Repeated header or a
 * non-canonical value (anything but a small non-negative decimal integer)
 * also → 0: a malformed sender is not distinguishable from a pre-epoch one
 * for ADMISSION purposes (both fail closed once the minimum rises); the
 * observability distribution keeps its own buckets via client-info status.
 */
export function parseDesktopApiEpochHeader(
  raw: string | string[] | undefined,
): number {
  if (raw === undefined || Array.isArray(raw)) return 0;
  const trimmed = raw.trim();
  if (!/^\d{1,9}$/.test(trimmed)) return 0;
  return Number.parseInt(trimmed, 10);
}

/**
 * Lowest client epoch this server build admits on the desktop surface.
 *
 * `0` is the OBSERVATION-BRIDGE value: clients that do not send an epoch at
 * all (pre-epoch desktops) are classified as epoch 0 and still admitted, while
 * the server records the valid/missing/invalid distribution.
 *
 * Exit conditions (docs/architecture-principles.md §11):
 *   - guards: pre-epoch desktop builds already in the field, which cannot be
 *     retro-fitted to send `desktop_api_epoch`;
 *   - removal trigger: fleet observation shows missing-epoch desktop
 *     connections at zero (or an explicit cutoff date is declared in the
 *     runbook) — then raise this to 1 so missing fails closed;
 *   - owner: Lio (#task:1761); the raise is a one-line change reviewed like
 *     any breaking bump.
 */
export const MINIMUM_CLIENT_API_EPOCH = 0;

/**
 * Lowest server epoch this desktop build accepts. Symmetric bootstrap: `0`
 * admits servers that predate the `desktop_api` advertisement in
 * `/api/server/info` (classified as epoch 0). Raise to 1 once fleet servers
 * all advertise, under the same §11 discipline as MINIMUM_CLIENT_API_EPOCH.
 */
export const MINIMUM_SERVER_API_EPOCH = 0;

/** Advertised by `/api/server/info` under the `desktop_api` key. */
export const DesktopApiAdvertisementSchema = z.object({
  current_epoch: z.number().int().nonnegative(),
  minimum_client_epoch: z.number().int().nonnegative(),
});
export type DesktopApiAdvertisement = z.infer<
  typeof DesktopApiAdvertisementSchema
>;

export type DesktopServerApiCompatibility =
  | 'compatible'
  | 'client_too_old'
  | 'server_too_old';

/**
 * Pure range comparison used by BOTH sides. A missing epoch on either side is
 * normalized to 0 by the caller BEFORE this call (absence is a legacy
 * generation, not an error, during the observation bridge).
 *
 * `client_too_old` wins over `server_too_old` when both hold: the actionable
 * remedy ("upgrade the app") is on the client side.
 */
export function classifyDesktopServerApiCompatibility(input: {
  clientEpoch: number;
  minimumClientEpoch: number;
  serverEpoch: number;
  minimumServerEpoch: number;
}): DesktopServerApiCompatibility {
  if (input.clientEpoch < input.minimumClientEpoch) return 'client_too_old';
  if (input.serverEpoch < input.minimumServerEpoch) return 'server_too_old';
  return 'compatible';
}

/**
 * Structured body of the server-side rejection: the JSON body of the HTTP
 * 426 on REST, and the JSON body written on the raw HTTP 426 response that
 * refuses the event-WS upgrade. The server only ever emits
 * `client_too_old` — `server_too_old` is a desktop-local classification made
 * against the server-info advertisement before business requests start.
 */
export const UpgradeRequiredBodySchema = z.object({
  error: z.literal('upgrade_required'),
  reason: z.literal('client_too_old'),
  server_api_epoch: z.number().int().nonnegative(),
  minimum_client_epoch: z.number().int().nonnegative(),
});
export type UpgradeRequiredBody = z.infer<typeof UpgradeRequiredBodySchema>;

export const UPGRADE_REQUIRED_HTTP_STATUS = 426;

/**
 * REST paths on the `/api/*` surface exempt from epoch admission.
 *
 * Surface-scoping proof, in layers:
 *   1. `/internal/*` (agent CLI), `/auth/*`, `/readyz` are outside the
 *      `/api/*` mount — structurally untouched.
 *   2. The public bearer middleware runs BEFORE epoch admission with an
 *      allowlist of exactly health/serverInfo/hostConnectTokenResolve, so
 *      every request that reaches the epoch check either is on this exempt
 *      list or carries an authenticated USER session — i.e. it is the
 *      desktop surface (or a user-credentialed script accepting desktop
 *      semantics). "Missing epoch" therefore only ever classifies the
 *      desktop generation, never the CLI or daemon.
 *   3. The daemon's surfaces are exempt by name:
 *      - hostConnectTokenResolve: daemon bootstrap REST call;
 *      - hostConnect: daemon outbound WS upgrade — HTTP upgrades never
 *        enter the Hono middleware chain at all, so this entry is a
 *        DEFENSIVE pin against a future mount/transport change, not a
 *        currently-reachable path.
 *
 * Everything an incompatible client needs to DISCOVER that it is
 * incompatible stays exempt: health (probes), serverInfo (the
 * advertisement an old desktop reads to render its upgrade gate).
 */
export const DESKTOP_API_EPOCH_EXEMPT_PATHS = [
  apiPaths.health,
  apiPaths.serverInfo,
  apiPaths.hostConnectTokenResolve,
  apiPaths.hostConnect,
] as const;

export function isDesktopApiEpochExemptPath(path: string): boolean {
  return (DESKTOP_API_EPOCH_EXEMPT_PATHS as readonly string[]).includes(path);
}

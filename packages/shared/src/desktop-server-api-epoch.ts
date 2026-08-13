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
 *
 * Epoch 3 (#task:2000): the addressing contract. Who a message addresses is now
 * a canonical `<silverhand://<kind>/<name>>` autolink in prose; the plain `@name`
 * form still RENDERS as a legacy display chip and addresses nobody — render and
 * addressing are two independent axes. No DTO field changed — the break is
 * BEHAVIORAL and mutually silent, which is why it needs admission rather than a
 * parse. An old renderer's composer writes `@name` and this server notifies no
 * one; this renderer's composer writes the canonical token and an old server
 * scans for `@name` and notifies no one. Neither side errors, and the message
 * itself is delivered as always: what is lost is the DIRECTED half — the mention
 * fails to reach its subject. There is no DTO to fail on, so
 * the epoch is the only place this can be caught. Precondition checked per §3,
 * not assumed: epoch 2 is on published upstream `main`, so a released pair at 2
 * can exist and this change may not join that generation.
 */
export const DESKTOP_SERVER_API_EPOCH = 3;

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
 * relocation-v1 §6 raised this to the epoch triple: the workspace local-binding
 * removal deleted required DTO fields (`workspace_path`, `workspace_host_id`)
 * and the `/api/workspaces/local-paths` endpoint, so a pre-epoch desktop cannot
 * decode this server's workspace payloads at all. The former `0`
 * OBSERVATION-BRIDGE value (admit missing-epoch clients while recording the
 * valid/missing/invalid distribution) exited here: a bridge that admits a client
 * whose DTO contract no longer exists would fail deep in a parse instead of at
 * admission. Missing/invalid epochs now fail closed with HTTP 426; the
 * distribution counters stay for observability only.
 *
 * Raised to 3 by #task:2000 with the rest of the triple: a pre-3 desktop writes
 * mentions this server does not deliver, and no request it sends would fail.
 */
export const MINIMUM_CLIENT_API_EPOCH = 3;

/**
 * Lowest server epoch this desktop build accepts. Symmetric to
 * MINIMUM_CLIENT_API_EPOCH and raised with it by relocation-v1 §6: this desktop
 * build reads the post-removal DTOs, so a server that predates the removal (or
 * predates the `desktop_api` advertisement in `/api/server/info`, classified as
 * epoch 0) is refused by the startup gate rather than decoded.
 *
 * Raised to 3 by #task:2000 with the rest of the triple: a pre-3 server does not
 * deliver the mentions this desktop's composer writes, and would report success
 * on every one of them.
 */
export const MINIMUM_SERVER_API_EPOCH = 3;

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
 * normalized to 0 by the caller BEFORE this call: absence NAMES the pre-epoch
 * generation rather than being an error, and since relocation-v1 §6 closed the
 * observation bridge that generation sits below both minima and is refused.
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

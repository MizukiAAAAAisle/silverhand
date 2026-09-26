import { z } from 'zod';
import { BACKEND_ADMISSION } from './backend-admission.generated.js';
import { PROTOCOL_VERSIONS } from './protocol-versions.js';

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
 * The numeric values and transport names used by both sides live in the shared
 * backend-admission artifact; this module owns the desktop↔server admission
 * semantics, not those values. It is deliberately a different gate
 * from the daemon boundaries: those use strict equality, this one a min-window
 * range so a desktop and server one generation apart can still interoperate.
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
 * Runbook (bump rules, rollout order, bridge policy, the release `+1` check):
 *   docs/desktop-server-api-epoch.md
 */

/**
 * The current desktop↔server application contract generation. Compiled into
 * both the server (advertise + enforce) and the desktop (send + self-check)
 * from the single version authority; a version-skewed pair compares ranges at
 * admission.
 *
 * Monotonic integer. **Plan A (default) bump rule — atomic triple:** a
 * breaking REST DTO / event shape / behavior change bumps DESKTOP_SERVER_API_EPOCH,
 * MINIMUM_CLIENT_API_EPOCH, and MINIMUM_SERVER_API_EPOCH to the SAME new value
 * in the SAME commit. Leaving a minimum behind silently re-admits the
 * incompatible pair plan A exists to reject; only an explicit plan-B bridge
 * (adapter + §11 exit conditions) may hold a minimum back, and it must change
 * the lockstep test in the same commit. See docs/desktop-server-api-epoch.md
 * §3–4.
 *
 * Why the epoch is the ONLY place a break can be caught: the renderer applies
 * NO runtime validation to HTTP DTOs, so a missing/renamed field reads as
 * `undefined` deep inside a feature and is never refused at admission. A
 * breaking generation therefore bumps the epoch even when the change is purely
 * behavioral (e.g. who a message addresses) with no DTO to fail on. Which
 * concrete DTO/behavior breaks make up the current generation, and why each is
 * mutually silent, is recorded in the owning tasks and design docs — not
 * duplicated as a number ledger here.
 */
export const DESKTOP_SERVER_API_EPOCH = PROTOCOL_VERSIONS.desktopApi;

/**
 * #task:1761 (Cindy round-2 P1) — the ADMISSION header. Dedicated and
 * minimal: the value is the decimal rendering of the compiled epoch, so
 * assembling it involves no IO and no schema and cannot fail — unlike the
 * fail-open client-info telemetry header, which stays observability-only.
 * Sent by the desktop main process on every backend REST request and the
 * event-WS upgrade.
 */
export const DESKTOP_API_EPOCH_HEADER = BACKEND_ADMISSION.desktopApiEpochHeader;

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
 * Kept equal to the current epoch by the Plan-A atomic triple unless an
 * explicit Plan-B bridge holds it back (runbook §3–4, §11). The numeric value
 * derives from the single version authority.
 */
export const MINIMUM_CLIENT_API_EPOCH = PROTOCOL_VERSIONS.desktopMinClient;

/**
 * Lowest server epoch this desktop build accepts. Symmetric to
 * MINIMUM_CLIENT_API_EPOCH and raised with it by relocation-v1 §6: this desktop
 * build reads the post-removal DTOs, so a server that predates the removal (or
 * predates the `desktop_api` advertisement in `/api/server/info`, classified as
 * epoch 0) is refused by the startup gate rather than decoded.
 *
 * Kept equal to the current epoch by the Plan-A atomic triple unless an
 * explicit Plan-B bridge holds it back. The numeric value derives from the
 * single version authority.
 */
export const MINIMUM_SERVER_API_EPOCH = PROTOCOL_VERSIONS.desktopMinServer;

/** Advertised by `/api/server/info` under the `desktop_api` key. */
export const DesktopApiAdvertisementSchema = z.object({
  current_epoch: z.number().int().nonnegative(),
  minimum_client_epoch: z.number().int().nonnegative(),
});
export type DesktopApiAdvertisement = z.infer<typeof DesktopApiAdvertisementSchema>;

export type DesktopServerApiCompatibility = 'compatible' | 'client_too_old' | 'server_too_old';

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

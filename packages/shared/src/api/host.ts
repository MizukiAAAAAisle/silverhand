// AUTO-SPLIT from the former monolithic api/dto.ts (#task:963).
// Bounded context: host. Re-exported via api/index.ts → @silverhand/shared.
import { z } from 'zod';
import {
  HostKindSchema,
} from '../db/schema.js';

//
// Single source-of-truth shape for every host the user owns. Both the
// owner-filtered `GET /api/hosts` list and the `POST /api/hosts/claim-
// or-create` response inline this DTO so renderer + desktop main share
// one parser. `revoked_at` and `last_seen_at` are owner-scoped
// metadata and are never returned outside the owning user (Stage B.4
// viewer filter at the route boundary).
export const HostDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: HostKindSchema,
  created_at: z.number(),
  /** Soft-delete tombstone. Null while the host is active. After
   *  revoke the row stays around (audit history) but every credential
   *  and runtime placement using it fails closed. */
  revoked_at: z.number().nullable(),
  /** Last claim-or-create touch timestamp. Null only for legacy /
   *  migration-seeded hosts that have not been claimed yet. */
  last_seen_at: z.number().nullable(),
  /** User that claimed/created this computer row. Renderer uses this
   *  to gate host-local controls such as daemon proxy config. Optional
   *  receive-side default keeps older dev backends parseable. */
  creator_user_id: z.string().nullable().optional().default(null),
  /** v36 (#task:808): user-facing rename target. `name` stays the
   *  stable normalized identifier; renderer reads `display_label ?? name`.
   *  NULL on rows claimed before v36 and after the user clears the label.
   *  Length 1-64; CJK/spaces allowed. Set via `POST /api/hosts/claim-or-create`
   *  at claim time (input `label`) or mutated via `PATCH /api/hosts/:id`. */
  display_label: z.string().nullable(),
});
export type HostDto = z.infer<typeof HostDtoSchema>;

/** `PATCH /api/hosts/:id` rename input. Currently only `display_label`
 *  is mutable; `name` is the stable identifier and never changes after
 *  claim. Pass `null` to clear the custom label (renderer falls back to
 *  `name`). Empty/whitespace-only strings are coerced to `null` server-side. */
export const UpdateHostInputSchema = z
  .object({
    /** v36 rename input. The schema cap is intentionally LOOSER than the
     *  repo's `normalizeDisplayLabel` (trim + slice to 64) so a user who
     *  types past the visible limit gets a silent auto-truncate in a
     *  single round-trip — not a 400. Anything wildly larger than the UI
     *  could plausibly emit IS rejected so a buggy renderer / direct
     *  curl can't spam multi-KB strings into the column. (Cindy
     *  `oJ-mzKP7kbXtHUTe` slice-1 review nit #2.) */
    display_label: z.string().max(256).nullable(),
  })
  .strict();
export type UpdateHostInput = z.infer<typeof UpdateHostInputSchema>;

/** `PATCH /api/hosts/:id` response. Returns the updated DTO so the
 *  caller can refresh local UI without a follow-up GET. */
export const UpdateHostResponseSchema = z.object({
  host: HostDtoSchema,
});
export type UpdateHostResponse = z.infer<typeof UpdateHostResponseSchema>;

//
// `GET /api/hosts/:id/status` answers "what is this host running right
// now". Permission: 404 for missing / cross-user (no enumeration via
// id-probing). 200 with `availability` tagged-union once owner ACL
// passes. Renderer NEVER branches on local vs remote — same shape for
// every host.
//
// availability:
//   - 'available'    — daemon connected + responsive; `snapshot` populated.
//   - 'disconnected' — host row OK but no live daemon connection. Renderer
//                      shows persistent fields + "Computer is offline".
//   - 'unreachable'  — connected but RPC failed (timeout / protocol error).
//                      `reason` carries the typed failure.
//   - 'revoked'      — host has `revoked_at` set. Explicit so the renderer
//                      can show "device revoked" instead of pretending it's
//                      just temporarily offline.
//
// agents[] is a registration view — one row per `agents.host_id == hostId`
// row, NOT one row per running process. `online` is derived backend-side
// from the daemon's runtime snapshot (active agent_id set intersected with
// the registered set). pid/started_at/conversation are intentionally
// absent: this pane describes who's bound to this host, not process state.
export const HostAvailabilitySchema = z.enum([
  'available',
  'disconnected',
  'unreachable',
  'revoked',
]);
export type HostAvailability = z.infer<typeof HostAvailabilitySchema>;

export const HostUnreachableReasonSchema = z.enum([
  'daemon_unreachable',
  'timeout',
  'protocol_error',
]);
export type HostUnreachableReason = z.infer<typeof HostUnreachableReasonSchema>;

/** Per-agent registration entry returned at the top level of every
 *  `HostStatusResponse` 200 arm. This is a DB-persisted **registration**
 *  view, NOT a process list — agents registered to this host stay visible
 *  even when the daemon is disconnected / unreachable / revoked, just
 *  with `online: 'offline'` (Cindy `Mtf5zZL-Y7PauIDi` P1: registration is
 *  the primary fact; only `online` is daemon-derived).
 *  v1 UI renders only `display_name` / `handle` / `runtime` / `online`;
 *  `agent_id` stays in the DTO so future row-click / runtime-control
 *  affordances don't need a wire change. */
export const AgentOnHostDtoSchema = z.object({
  agent_id: z.string(),
  display_name: z.string(),
  /** Mention handle (`@<agent.name>`). Prefixed so the renderer doesn't
   *  reassemble it from a raw name. */
  handle: z.string(),
  /** CLI runtime kind (claude / codex / ...) — straight from `agents.runtime`. */
  runtime: z.string(),
  /** Backend-stored avatar URL (null when the user hasn't uploaded one).
   *  Routed through the renderer's `useAgentAvatarObjectUrls` cache so
   *  the host detail surface shows the same avatar a user picked in
   *  #Members instead of falling back to the runtime tile.
   *
   *  **Skew-tolerant**: declared `.nullable().optional().default(null)`
   *  so a response from a backend that predates this field (dev hot-
   *  reload skew, or any future producer/consumer version drift) parses
   *  successfully with `avatar_url = null` rather than failing the
   *  entire `HostStatusResponse` and turning the detail pane into an
   *  error banner. The default normalizes `undefined → null`, so the
   *  inferred output type stays `string | null` and consumers don't
   *  need to handle `undefined`. New backend code emits the field
   *  unconditionally (`buildAgentRows` in routes.ts); the tolerance
   *  here is only the receive-side safety net. */
  avatar_url: z.string().nullable().optional().default(null),
  /** Narrow UI state derived backend-side: 'online' iff this agent's id
   *  appears in the daemon's active-runtime set for this host. Raw
   *  daemon phase strings stay daemon-side; renderer never branches on
   *  them. Always 'offline' on non-`available` arms (no daemon to ask). */
  online: z.enum(['online', 'offline']),
});
export type AgentOnHostDto = z.infer<typeof AgentOnHostDtoSchema>;

/** Dynamic host facts. Present only when `availability === 'available'`.
 *  Every field is read from the live daemon RPC — never persisted to db.
 *  Registered `agents` live at the response arm root, NOT here — the
 *  registration list must survive daemon disconnect. */
export const HostStatusSnapshotSchema = z.object({
  /** Human-readable OS string composed daemon-side (e.g. "macOS 14.5",
   *  "Linux Ubuntu 22.04"). Renderer displays verbatim — does not parse.
   *  `.min(1)` matches the daemon helper's never-empty contract; an empty
   *  string would otherwise reach the renderer as a blank cell. */
  os: z.string().min(1),
  /** Architecture token from `os.arch()` ('arm64' | 'x64' | ...).
   *  Optional so older daemons that don't advertise it still validate. */
  os_arch: z.string().optional(),
  daemon_version: z.string(),
  daemon_pid: z.number().int(),
  started_at: z.number().int(),
  uptime_ms: z.number().int(),
});
export type HostStatusSnapshot = z.infer<typeof HostStatusSnapshotSchema>;

/**
 * `GET /api/hosts/:id/status` response.
 *
 * Discriminated on `availability` (Cindy `oJ-mzKP7kbXtHUTe` slice-1 review
 * P1 #1): the previous wide-object shape let incoherent combinations like
 * `available + reason` or `disconnected + snapshot` pass parse, which would
 * force the renderer to guess + risk routes accidentally emitting them.
 * Each arm pins exactly which fields are legal for that availability.
 *
 * **Registration vs runtime** (Cindy `Mtf5zZL-Y7PauIDi` slice-3 review P1):
 * `agents[]` is at the **arm root** of every 200 arm, NOT inside
 * `snapshot`. Registration is a DB fact, not a daemon fact — when the
 * daemon disconnects we still know which agents the user registered on
 * this host; we just can't tell which are running. `snapshot` keeps ONLY
 * dynamic daemon-derived fields (OS / daemon_version / pid / uptime). On
 * non-`available` arms every `agents[].online === 'offline'`.
 *
 * - `available`    — snapshot REQUIRED; agents at root with live online
 *                    enrichment; no reason; last_seen_at optional.
 * - `disconnected` — host row OK, no live daemon connection. No snapshot,
 *                    no reason; agents all offline; `last_seen_at` for
 *                    "last seen 5m ago" UX.
 * - `unreachable`  — connected but RPC failed. No snapshot; typed `reason`
 *                    REQUIRED; agents all offline; `last_seen_at` optional.
 * - `revoked`      — host has `revoked_at` set. No snapshot, no reason;
 *                    agents all offline (registrations stay visible until
 *                    the user deletes the host); `last_seen_at` optional.
 */
const HostStatusAvailableArmSchema = z
  .object({
    host_id: z.string(),
    availability: z.literal('available'),
    snapshot: HostStatusSnapshotSchema,
    agents: z.array(AgentOnHostDtoSchema),
    last_seen_at: z.number().nullable().optional(),
  })
  .strict();

const HostStatusDisconnectedArmSchema = z
  .object({
    host_id: z.string(),
    availability: z.literal('disconnected'),
    agents: z.array(AgentOnHostDtoSchema),
    last_seen_at: z.number().nullable().optional(),
  })
  .strict();

const HostStatusUnreachableArmSchema = z
  .object({
    host_id: z.string(),
    availability: z.literal('unreachable'),
    reason: HostUnreachableReasonSchema,
    agents: z.array(AgentOnHostDtoSchema),
    last_seen_at: z.number().nullable().optional(),
  })
  .strict();

const HostStatusRevokedArmSchema = z
  .object({
    host_id: z.string(),
    availability: z.literal('revoked'),
    agents: z.array(AgentOnHostDtoSchema),
    last_seen_at: z.number().nullable().optional(),
  })
  .strict();

export const HostStatusResponseSchema = z.discriminatedUnion('availability', [
  HostStatusAvailableArmSchema,
  HostStatusDisconnectedArmSchema,
  HostStatusUnreachableArmSchema,
  HostStatusRevokedArmSchema,
]);
export type HostStatusResponse = z.infer<typeof HostStatusResponseSchema>;

export const HostClaimOrCreateInputSchema = z.object({
  installation_id: z.string().uuid(),
  label: z.string().trim().min(1).max(128).optional(),
  current_host_id: z.string().min(1).optional(),
}).strict();
export type HostClaimOrCreateInput = z.infer<typeof HostClaimOrCreateInputSchema>;

export const HostClaimOrCreateResponseSchema = z.object({
  host_id: z.string(),
  host: HostDtoSchema,
  server_url: z.string().url(),
  host_token: z.string().min(1).optional(),
});
export type HostClaimOrCreateResponse = z.infer<
  typeof HostClaimOrCreateResponseSchema
>;

/** Owner-scoped list response from `GET /api/hosts`. The route filters
 *  to the current viewer's owned hosts only. */
export const HostListResponseSchema = z.object({
  hosts: z.array(HostDtoSchema),
});
export type HostListResponse = z.infer<typeof HostListResponseSchema>;

/** `POST /api/hosts/{id}/revoke` response. Returns the updated DTO so
 *  the caller can refresh local UI without a follow-up GET. */
export const HostRevokeResponseSchema = z.object({
  host: HostDtoSchema,
});
export type HostRevokeResponse = z.infer<typeof HostRevokeResponseSchema>;

/** Embedded `POST /api/hosts/{id}/rotate-token` response.
 *
 *  IMPORTANT: this shape is consumed by Electron main only —
 *  `host_token` is cleartext and must be written to `daemon-config.json`
 *  before any return value crosses the IPC boundary. The renderer
 *  never sees this schema; the renderer-facing IPC return strips
 *  the token and only echoes `{ ok, host_id, status }`. */
export const HostRotateTokenEmbeddedResponseSchema = z.object({
  host_id: z.string(),
  host: HostDtoSchema,
  host_token: z.string().min(1),
});

/** Standalone D2 outbound rotation response.
 *
 *  The cleartext replacement token is delivered only over the authenticated
 *  host WebSocket `rotate_token` command; the HTTP caller only learns that the
 *  rotation completed. */
export const HostRotateTokenStandaloneResponseSchema = z.object({
  host_id: z.string(),
  host: HostDtoSchema,
  status: z.literal('rotated'),
});

export const HostRotateTokenResponseSchema = z.union([
  HostRotateTokenEmbeddedResponseSchema,
  HostRotateTokenStandaloneResponseSchema,
]);
export type HostRotateTokenResponse = z.infer<
  typeof HostRotateTokenResponseSchema
>;

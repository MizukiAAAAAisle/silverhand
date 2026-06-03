import { z } from 'zod';
import {
  AgentMaterializationStatusSchema,
  AttachmentCreatorKindSchema,
  ConversationAgentStatusSchema,
  ConversationKindSchema,
  ConversationStatusSchema,
  FastModeSchema,
  FromKindSchema,
  HostKindSchema,
  NotificationKindSchema,
  ReasoningEffortSchema,
  RuntimeKindSchema,
  StorageKindSchema,
  TaskAssigneeTypeSchema,
  TaskStatusSchema,
  WorkspaceKindSchema,
} from '../db/schema.js';

// ── Host ─────────────────────────────────────────────────────────
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

// ── Host status (ComputerPane / host registry view, #task:808) ──────
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

// ── User ─────────────────────────────────────────────────────────
// Profile-only "human" identity. Auth/credentials live in a separate
// (V2-only) `user_auth_identities` table; this DTO is what the renderer
// reads via /api/me. `avatar_url` is a server-rendered URL (currently
// `silverhand-blob://<storage_key>`); the renderer never assembles
// storage keys directly.
export const UserDtoSchema = z.object({
  id: z.string(),
  /** Unique mention name. Decided once at registration and never editable
   *  after — surfaces in the renderer as `@<name>`. Globally unique
   *  across users.name ⊕ agents.name. */
  name: z.string(),
  display_name: z.string(),
  /** Resolved avatar URL or null. */
  avatar_url: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type UserDto = z.infer<typeof UserDtoSchema>;

export const UsersResponseSchema = z.object({
  users: z.array(UserDtoSchema),
});
export type UsersResponse = z.infer<typeof UsersResponseSchema>;

/**
 * Pre-authentication shape returned by `GET /api/me` when no user
 * session has been established yet. The renderer
 * branches on the discriminator and shows `<RegistrationGate>` rather
 * than mounting the AppShell.
 *
 * `suggested_name` is a server-rendered placeholder of shape
 * `user-<4hex>` — the renderer uses it as the input default so the form
 * is never empty on first paint. The user is free to overwrite.
 */
export const RegistrationRequiredSchema = z.object({
  registration_required: z.literal(true),
  suggested_name: z.string(),
});
export type RegistrationRequired = z.infer<typeof RegistrationRequiredSchema>;

/** Discriminated union returned by `GET /api/me`. */
export const MeResponseSchema = z.union([
  UserDtoSchema,
  RegistrationRequiredSchema,
]);
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const BindAddressScopeSchema = z.enum(['loopback', 'lan', 'public']);
export type BindAddressScope = z.infer<typeof BindAddressScopeSchema>;

export const ServerInfoSchema = z.object({
  signup_enabled: z.boolean(),
  /**
   * D4.a Commit 4 (per `docs/remote-backend-architecture-notes.md §3`
   * condition 3): classification of the address the standalone /
   * embedded backend is bound to, so desktop and ops tooling can
   * read "signup_enabled + bind_address_scope" together
   * programmatically.
   *
   *   - 'loopback' — `127.0.0.1` / `::1` / `localhost`. Embedded
   *     backend's default. No external reachability.
   *   - 'lan' — RFC1918 (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16),
   *     link-local (169.254/16, fe80::/10), unique-local IPv6
   *     (fc00::/7), or an mDNS `*.local` name. Reachable from
   *     hosts on the same network but not the public internet.
   *   - 'public' — anything else: a public IP, a globally
   *     resolvable DNS name, or a wildcard bind (`0.0.0.0` / `::`)
   *     because the latter exposes whichever interfaces the host
   *     has, including public ones. The conservative classification
   *     for wildcards (Cindy D4.a invariant: never under-state
   *     exposure scope in a field used to gate a warning).
   *
   * Optional in the schema for backward compat — older standalone
   * builds without the field still parse — but production
   * `/api/server/info` MUST populate it.
   */
  bind_address_scope: BindAddressScopeSchema.optional(),
});
export type ServerInfo = z.infer<typeof ServerInfoSchema>;

// `display_name` is rendered into the agent system prompt (PR-B
// "Members in this conversation:" block) and persisted on `users`
// and `agents`. Reject every character that could survive `.trim()`
// but be interpreted as a line break or non-printable control
// downstream:
//   - C0 controls       U+0000 – U+001F  (NUL, TAB, LF, CR, VT, FF, …)
//   - DEL               U+007F
//   - C1 controls       U+0080 – U+009F  (includes U+0085 NEL)
//   - Line separators   U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR
//
// `JSON.stringify` only escapes U+0000-U+001F; everything else above
// would land in the prompt verbatim. The `quotePromptValue` helper in
// platform-prompt.ts escapes the line-separator subset at render time
// as defense-in-depth, but blocking the full set at the write
// boundary keeps the DB clean and prevents future schema drift /
// direct-DB writes from leaking malicious values into the prompt.
// See @Cindy review threads on `d65cc19` and `d7680e5`. Other
// punctuation (`,` `:` `"`) is allowed: humans legitimately use these
// in display names (e.g. `"Alice (lead)"`, `"Bob, the bot"`) and the
// prompt's JSON-quoted form makes them unambiguous to the model.
const DISPLAY_NAME_FORBIDDEN_RE = /[\x00-\x1F\x7F-\x9F\u2028\u2029]/;
const DISPLAY_NAME_FORBIDDEN_MSG =
  'display_name must not contain control characters or Unicode line separators';

/**
 * Shared validator for any user-editable `display_name` field. Used by
 * `AuthSignupInputSchema`, `UpdateUserProfileInputSchema`, and
 * `UpdateAgentInputSchema`. Trim → 1..64 chars → reject control
 * characters (C0 U+0000–U+001F, DEL U+007F, C1 U+0080–U+009F) and
 * Unicode line separators (U+2028 / U+2029).
 */
export const DisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(s => !DISPLAY_NAME_FORBIDDEN_RE.test(s), {
    message: DISPLAY_NAME_FORBIDDEN_MSG,
  });

const AuthEmailSchema = z.string().trim().email().max(320);

export const AuthSignupInputSchema = z.object({
  email: AuthEmailSchema,
  password: z.string().min(8).max(1024),
  display_name: DisplayNameSchema.optional(),
});
export type AuthSignupInput = z.infer<typeof AuthSignupInputSchema>;

export const AuthLoginInputSchema = z.object({
  email: AuthEmailSchema,
  password: z.string().min(1).max(1024),
});
export type AuthLoginInput = z.infer<typeof AuthLoginInputSchema>;

export const AuthSessionResponseSchema = z.object({
  user_token: z.string().min(1),
  user: UserDtoSchema,
});
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;

export const AuthLogoutResponseSchema = z.object({
  ok: z.literal(true),
});
export type AuthLogoutResponse = z.infer<typeof AuthLogoutResponseSchema>;

// PATCH /api/me — post-registration profile update. By design `name`
// is NOT in this schema: the registration boundary is the only public
// writer. Avatar is also separate (POST /api/me/avatar) so the renderer
// has a single binary upload path. Empty objects fail validation.
export const UpdateUserProfileInputSchema = z
  .object({
    display_name: DisplayNameSchema.optional(),
  })
  .refine(v => Object.keys(v).length > 0, { message: 'no fields to update' });
export type UpdateUserProfileInput = z.infer<typeof UpdateUserProfileInputSchema>;

// Response from POST /api/me/avatar. The renderer doesn't need the raw
// storage key; the URL is enough.
export const UploadAvatarResponseSchema = z.object({
  avatar_url: z.string(),
});
export type UploadAvatarResponse = z.infer<typeof UploadAvatarResponseSchema>;

// ── Agent ────────────────────────────────────────────────────────
export const AgentDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  display_name: z.string(),
  runtime: RuntimeKindSchema,
  model: z.string().nullable(),
  reasoning_effort: ReasoningEffortSchema.nullable(),
  fast_mode: FastModeSchema.nullable(),
  host_id: z.string(),
  description: z.string().nullable(),
  /** v26: id of the user who created this agent. The renderer uses it
   *  to decide whether to surface profile-edit affordances (Edit
   *  button, avatar upload). Backend `canEditAgent` is the source of
   *  truth; this field is the renderer's hint. */
  created_by_user_id: z.string(),
  /** v26: resolved avatar URL or null. Matches `UserDto.avatar_url` —
   *  cache-busted by `updated_at`. PR-1 always returns null (no
   *  storage wired); PR-2 flips this on once the storage / route
   *  pair lands. */
  avatar_url: z.string().nullable(),
  /** v33 (D4.d): agent-home materialization lifecycle. Required
   *  because every v33 row has a non-null status — default-list
   *  callers see `'active'`; the failed-row management view
   *  (Q6.a, §7.3) opts in via `?include_failed=1` and reads
   *  `'failed'` here together with the two diagnostic fields
   *  below. `'pending_materialization'` is reserved for the
   *  in-flight window between row reserve and L3a/L3b — readers
   *  see it only when the materialize wire round-trip is still
   *  pending. Note: `idempotency_key` is intentionally NOT
   *  exposed on the default DTO — same-key retry uses a
   *  route-local management payload (Cindy D1 round-2 P2). */
  materialization_status: AgentMaterializationStatusSchema,
  /** v33 (D4.d): populated only when
   *  `materialization_status='failed'`. Mirrors the §3.4 wire→HTTP
   *  error-code mapping plus server-side codes. Kept as
   *  `string | null` (not a narrow enum) so the row column / DTO
   *  / migration do not need a coordinated schema change when a
   *  new server-side code is added — the route layer pins the
   *  exact code set it produces. */
  materialization_failed_code: z.string().nullable(),
  /** v33 (D4.d): epoch ms set together with
   *  `materialization_failed_code`; NULL while the row is in
   *  `pending_materialization` or `active`. */
  materialization_failed_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type AgentDto = z.infer<typeof AgentDtoSchema>;

export const CreateAgentInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_\-]+$/, 'name must be alphanumeric / dash / underscore'),
  runtime: RuntimeKindSchema,
  model: z.string().optional(),
  reasoning_effort: ReasoningEffortSchema.optional(),
  fast_mode: FastModeSchema.optional(),
  host_id: z.string().optional(), // defaults to the current user's owned local host
  description: z.string().optional(),
});
export type CreateAgentInput = z.infer<typeof CreateAgentInputSchema>;

// PATCH /api/agents/:id — every field optional, only provided keys
// are written. `name` and `host_id` are deliberately excluded; `name`
// is the immutable identifier (see migrations.ts v5 comment), and
// changing host is not supported in v1.
export const UpdateAgentInputSchema = z
  .object({
    display_name: DisplayNameSchema.optional(),
    description: z.string().max(2000).nullable().optional(),
    runtime: RuntimeKindSchema.optional(),
    model: z.string().nullable().optional(),
    reasoning_effort: ReasoningEffortSchema.nullable().optional(),
    fast_mode: FastModeSchema.nullable().optional(),
  })
  .refine(v => Object.keys(v).length > 0, { message: 'no fields to update' });
export type UpdateAgentInput = z.infer<typeof UpdateAgentInputSchema>;

// GET /api/agents/:id/workspace/tree + GET /api/agents/:id/workspace/file —
// see "agent home workspace files (tree + read pair)" below for the wire
// contract that backs the two-column workspace pane in the renderer.

// ── #task:811 — agent home workspace files (tree + read pair) ────────
// Pair of read-only protocols that together back the two-column workspace
// pane. The renderer pulls a flat tree of every file under the agent's
// home directory ("agent home workspace files" — agent-home L1 in
// today's topology, i.e. `~/.silverhand/agents/<id>/`), then reads any
// path the user clicks. This intentionally does NOT segment by
// `system_prompt` / `MEMORY` / `notes/`: the protocol speaks one virtual
// path namespace rooted at the agent home dir, and the UI categorizes
// (or doesn't) however it wants.
//
// Forward-compat: a future expansion that exposes a different file root
// (e.g. an L2 workspace dir) will introduce ADDITIVE selector params
// (`scope`, `workspace_id`) — it MUST NOT reinterpret the current path
// semantics: today `path: "MEMORY.md"` is unambiguously the agent-home
// `MEMORY.md`, and that meaning is frozen.
//
// Security (enforced daemon-side, mirrored in the route): every input
// path is parsed segment-by-segment, dot/dot-dot/dotfile segments are
// rejected, every step is `lstat`-ed to refuse symlinks (intermediate
// or leaf), and the realpath of the resolved target must stay strictly
// inside the realpath of the agent home base — a missing or out-of-base
// target is `not_found`, never a leak.

/**
 * One entry in the flat tree response. `path` is a `/`-joined virtual
 * path relative to the agent home (e.g. `system_prompt.md`,
 * `notes/work-log.md`); empty / leading-slash / `..` / dotfile
 * segments are rejected upstream so any value here is safe to feed
 * back into the read endpoint verbatim.
 */
export const AgentWorkspaceTreeNodeSchema = z
  .object({
    path: z.string().min(1),
    kind: z.enum(['file', 'directory']),
    size: z.number(),
    mtime: z.number(),
  })
  .strict();
export type AgentWorkspaceTreeNode = z.infer<
  typeof AgentWorkspaceTreeNodeSchema
>;

/**
 * Flat tree shape — every visible file/directory under the agent home,
 * ordered directories-first then alphabetical within a level. The
 * renderer is responsible for reconstructing the parent/child layout
 * via the `path` segments. Hidden entries (anything starting with `.`)
 * are filtered server-side and never appear here.
 */
export const AgentWorkspaceTreeSchema = z
  .object({
    nodes: z.array(AgentWorkspaceTreeNodeSchema),
  })
  .strict();
export type AgentWorkspaceTree = z.infer<typeof AgentWorkspaceTreeSchema>;

/**
 * Single-file read result. `truncated` flips when the file exceeds the
 * 64KB preview cap; the renderer just labels the preview accordingly.
 * `path` is the canonical virtual path the caller asked for, echoed for
 * cache-key stability.
 */
export const AgentWorkspaceFileReadSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
    size: z.number(),
    mtime: z.number(),
    truncated: z.boolean(),
  })
  .strict();
export type AgentWorkspaceFileRead = z.infer<
  typeof AgentWorkspaceFileReadSchema
>;

// GET /api/agents/:id/runtime-state — every (conversation, agent) pair
// involving this agent, with workspace/channel/thread names denormalized so
// the UI can render the "where it runs" table without N+1 queries.
export const AgentRuntimeConversationSchema = z.object({
  conversation_id: z.string(),
  workspace_id: z.string(),
  workspace_name: z.string(),
  workspace_kind: WorkspaceKindSchema,
  conversation_kind: ConversationKindSchema,
  channel_id: z.string(),
  thread_id: z.string().nullable(),
  channel_title: z.string(),
  thread_title: z.string().nullable(),
  status: ConversationAgentStatusSchema,
  pid: z.number().nullable(),
  closed_at: z.number().nullable(),
});
export type AgentRuntimeConversation = z.infer<
  typeof AgentRuntimeConversationSchema
>;

export const AgentRuntimeStateDtoSchema = z.object({
  conversation_agents: z.array(AgentRuntimeConversationSchema),
});
export type AgentRuntimeStateDto = z.infer<typeof AgentRuntimeStateDtoSchema>;

// GET /api/agents/:id/delete-impact — drives the destructive
// confirmation dialog. Counts the user actually needs to see before
// agreeing to a permanent delete.
export const AgentDeleteImpactDtoSchema = z.object({
  agent_id: z.string(),
  agent_name: z.string(),
  agent_display_name: z.string(),
  dm_channel: z
    .object({
      id: z.string(),
      name: z.string(),
      conversation_count: z.number(),
      message_count: z.number(),
    })
    .nullable(),
  regular_workspaces: z.array(
    z.object({ id: z.string(), name: z.string() }),
  ),
  regular_memberships: z.array(
    z.object({ id: z.string(), name: z.string() }),
  ),
  // D4.e-4 (P1-2): a NARROW window of the owned agent-home workspace, not the
  // full WorkspaceDto. The delete-impact must NOT carry any host-local path
  // (`workspace_path`) or other host-resolution fields (I6) — the daemon owns
  // path resolution. `computeDeleteImpact` explicitly maps these fields rather
  // than returning the repo DTO, so a future WorkspaceDto field can never leak
  // a host path back into this payload.
  owned_home: z
    .object({
      id: z.string(),
      name: z.string(),
      workspace_kind: WorkspaceKindSchema,
      owner_agent_id: z.string().nullable(),
    })
    .nullable(),
  attachments_count: z.number(),
  running_conversation_agents: z.array(AgentRuntimeConversationSchema),
  pending_inbox_count: z.number(),
  // D4.e-4: host-local L1/L2 fs paths are NO LONGER part of the delete
  // impact. The daemon resolves and removes them via `agent_files_purge`
  // (I1/I6) — the backend never derives an agent-host path. The number of
  // L2 dirs equals `regular_memberships.length`; render from that.
});
export type AgentDeleteImpactDto = z.infer<typeof AgentDeleteImpactDtoSchema>;

export const DeleteAgentInputSchema = z.object({
  confirm: z.literal(true),
});
export type DeleteAgentInput = z.infer<typeof DeleteAgentInputSchema>;

// ── Workspace / Conversation model ───────────────────────────────
//
// New naming model for workspace -> channel/dm_channel/thread. The
// legacy Channel/Conversation DTOs below remain during the transition so the
// existing renderer can keep compiling until it is renamed.

export const WorkspaceDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  workspace_kind: WorkspaceKindSchema,
  workspace_path: z.string(),
  workspace_host_id: z.string(),
  owner_agent_id: z.string().nullable(),
  dm_channel_id: z.string().nullable(),
  dm_channel_ids: z.array(z.string()),
  pinned_at: z.number().nullable(),
  archived_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type WorkspaceDto = z.infer<typeof WorkspaceDtoSchema>;

export const WorkspaceMemberDtoSchema = z.object({
  workspace_id: z.string(),
  agent_id: z.string(),
  joined_at: z.number(),
});
export type WorkspaceMemberDto = z.infer<typeof WorkspaceMemberDtoSchema>;

/** Human membership in a workspace (v25). Parallel to
 *  `WorkspaceMemberDto` but for users instead of agents. */
export const WorkspaceUserMemberDtoSchema = z.object({
  workspace_id: z.string(),
  user_id: z.string(),
  joined_at: z.number(),
});
export type WorkspaceUserMemberDto = z.infer<typeof WorkspaceUserMemberDtoSchema>;

export const CreateWorkspaceInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_\-]+$/, 'name must be alphanumeric / dash / underscore'),
  description: z.string().optional(),
  workspace_path: z.string().optional(),
  workspace_host_id: z.string().optional(),
  member_agent_ids: z.array(z.string()).default([]),
  /** Initial human workspace members. The creator is always added
   *  separately; including them here is harmless (`INSERT OR IGNORE`). */
  member_user_ids: z.array(z.string()).default([]),
});
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInputSchema>;

export const UpdateWorkspaceInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_\-]+$/, 'name must be alphanumeric / dash / underscore')
    .optional(),
  description: z.string().nullable().optional(),
}).refine(v => Object.keys(v).length > 0, { message: 'no fields to update' });
export type UpdateWorkspaceInput = z.infer<typeof UpdateWorkspaceInputSchema>;

export const ConversationDtoSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  workspace_path: z.string(),
  kind: ConversationKindSchema,
  parent_conversation_id: z.string().nullable(),
  title: z.string(),
  status: ConversationStatusSchema,
  spawned_by_agent_id: z.string().nullable(),
  closed_at: z.number().nullable(),
  close_summary: z.string().nullable(),
  pinned_at: z.number().nullable(),
  archived_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type ConversationDto = z.infer<typeof ConversationDtoSchema>;

export const ChannelConversationDtoSchema = ConversationDtoSchema.extend({
  kind: z.literal('channel'),
  parent_conversation_id: z.null(),
});
export type ChannelConversationDto = z.infer<typeof ChannelConversationDtoSchema>;

export const DmChannelDtoSchema = ConversationDtoSchema.extend({
  kind: z.literal('dm_channel'),
  parent_conversation_id: z.null(),
});
export type DmChannelDto = z.infer<typeof DmChannelDtoSchema>;

export const CreateConversationChannelInputSchema = z.object({
  title: z.string().min(1).max(128),
  member_agent_ids: z.array(z.string()).default([]),
  member_user_ids: z.array(z.string()).optional(),
});
export type CreateConversationChannelInput = z.infer<
  typeof CreateConversationChannelInputSchema
>;

export const ThreadDtoSchema = ConversationDtoSchema.extend({
  kind: z.literal('thread'),
  channel_id: z.string(),
  anchor_message_id: z.string().nullable(),
});
export type ThreadDto = z.infer<typeof ThreadDtoSchema>;

// ── ConversationRef ──────────────────────────────────────────────
//
// Identity + routing metadata for a conversation, returned by
// `GET /api/conversations/:id/ref`. Designed to back cross-workspace
// secondary-pane resolution and the `#conv:<id>` sigil renderer (PR-3).
//
// Hard contract:
//   - `workspace_kind` is the *external* projection — `agent_home` is
//     mapped to `'dm'` here so the renderer never sees a third kind.
//   - For threads, `parent_channel_id` and `parent_title` are
//     denormalised so the placeholder/sigil can render the parent
//     channel name without an extra round-trip.
//   - Does NOT include unread count, last_seq, message previews, or
//     any per-user state — those go through the existing read-cursor
//     and message-window endpoints. Keep this endpoint identity-only.
//   - Permission: `canViewWorkspace(user, workspace_id)` only. This
//     route is mounted on the user-facing surface only — agents do
//     NOT get a path to call it. If we ever expose to agents, write a
//     dedicated ACL helper; do not relax this one.
export const ConversationRefWorkspaceKindSchema = z.enum(['regular', 'dm']);
export type ConversationRefWorkspaceKind = z.infer<
  typeof ConversationRefWorkspaceKindSchema
>;

export const ConversationRefSchema = z.object({
  id: z.string(),
  kind: ConversationKindSchema,
  title: z.string(),
  workspace_id: z.string(),
  workspace_kind: ConversationRefWorkspaceKindSchema,
  workspace_path: z.string(),
  parent_channel_id: z.string().nullable(),
  parent_title: z.string().nullable(),
  closed_at: z.number().nullable(),
  archived_at: z.number().nullable(),
});
export type ConversationRef = z.infer<typeof ConversationRefSchema>;

export const ConversationRefResponseSchema = z.object({
  ref: ConversationRefSchema,
});
export type ConversationRefResponse = z.infer<typeof ConversationRefResponseSchema>;

export const ConversationAgentDtoSchema = z.object({
  conversation_id: z.string(),
  agent_id: z.string(),
  cli_session_id: z.string().nullable(),
  pid: z.number().nullable(),
  status: ConversationAgentStatusSchema,
  joined_at: z.number(),
});
export type ConversationAgentDto = z.infer<typeof ConversationAgentDtoSchema>;

/** Human membership in a conversation (v25). Parallel to
 *  `ConversationAgentDto` minus the process-lifecycle fields. */
export const ConversationUserMemberDtoSchema = z.object({
  conversation_id: z.string(),
  user_id: z.string(),
  joined_at: z.number(),
});
export type ConversationUserMemberDto = z.infer<typeof ConversationUserMemberDtoSchema>;

// ── Conversation members (rendered) ──────────────────────────────
// `MemberDto` is the unified, rendered shape used wherever code
// needs to treat conversation participants uniformly — currently
// the platform prompt's "Members in this conversation:" block
// (PR-B) and, in PR-C, the chat header chip strip. Distinct from
// `ConversationAgentDto` / `ConversationUserMemberDto`, which are
// raw membership rows.
//
// The `agent_id` / `user_id` discriminator carries the
// participant's primary key so callers (e.g. the prompt builder
// flagging `self: true`, or PR-C click routing) can map back to
// AgentRepo / UserRepo without re-fetching by name.
export const AgentMemberDtoSchema = z.object({
  kind: z.literal('agent'),
  agent_id: z.string(),
  name: z.string(),
  display_name: z.string(),
  runtime: RuntimeKindSchema,
});
export type AgentMemberDto = z.infer<typeof AgentMemberDtoSchema>;

export const HumanMemberDtoSchema = z.object({
  kind: z.literal('human'),
  user_id: z.string(),
  name: z.string(),
  display_name: z.string(),
  avatar_url: z.string().nullable(),
});
export type HumanMemberDto = z.infer<typeof HumanMemberDtoSchema>;

export const MemberDtoSchema = z.discriminatedUnion('kind', [
  AgentMemberDtoSchema,
  HumanMemberDtoSchema,
]);
export type MemberDto = z.infer<typeof MemberDtoSchema>;

/** Response shape for `GET /api/conversations/:id/members`. */
export const ConversationMembersResponseSchema = z.object({
  members: z.array(MemberDtoSchema),
});
export type ConversationMembersResponse = z.infer<
  typeof ConversationMembersResponseSchema
>;

const ConversationMemberHandleSchema = z
  .string()
  .trim()
  .regex(/^@?[a-zA-Z0-9_-]{1,64}$/, {
    message: 'handle must be @optional alphanumeric / dash / underscore',
  });

export const AddConversationMemberByIdInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('agent'),
    agent_id: z.string(),
  }),
  z.object({
    kind: z.literal('human'),
    user_id: z.string(),
  }),
]);
export const AddConversationMemberByHandleInputSchema = z.object({
  handle: ConversationMemberHandleSchema,
});
export const AddConversationMemberInputSchema = z.union([
  AddConversationMemberByIdInputSchema,
  AddConversationMemberByHandleInputSchema,
]);
export type AddConversationMemberInput = z.infer<
  typeof AddConversationMemberInputSchema
>;

export const ClearSessionResponseSchema = z.object({
  ok: z.literal(true),
  prev_cli_session_id: z.string().nullable(),
  was_running: z.boolean(),
});
export type ClearSessionResponse = z.infer<typeof ClearSessionResponseSchema>;

export const ChannelDtoSchema = ChannelConversationDtoSchema;
export type ChannelDto = ChannelConversationDto;

export const ChannelLikeDtoSchema = z.union([
  ChannelConversationDtoSchema,
  DmChannelDtoSchema,
]);
export type ChannelLikeDto = z.infer<typeof ChannelLikeDtoSchema>;

/** Body for `PATCH /api/workspaces/:id/archive`. Toggle-shaped instead of
 *  separate archive / unarchive endpoints — the UI flips a flag, the
 *  backend looks at the boolean. */
export const ArchiveWorkspaceInputSchema = z.object({
  archived: z.boolean(),
});
export type ArchiveWorkspaceInput = z.infer<typeof ArchiveWorkspaceInputSchema>;

/** Body for `PATCH /api/channels/:id/archive`. Same toggle shape as the
 *  workspace archive endpoint. Archive is purely organizational — agents
 *  keep running, delivery keeps working; the sidebar groups archived
 *  channels under a collapsible Archived section. */
export const ArchiveChannelInputSchema = z.object({
  archived: z.boolean(),
});
export type ArchiveChannelInput = z.infer<typeof ArchiveChannelInputSchema>;

/** Query for `GET /api/archived-channels`. `since` is epoch ms (inclusive
 *  lower bound on `archived_at`); the frontend converts 30d/14d/7d
 *  presets to a timestamp client-side. `workspace_id` narrows the list
 *  to a single workspace, omitted = all workspaces visible to the
 *  caller. */
export const ArchivedChannelsQueryInputSchema = z.object({
  workspace_id: z
    .preprocess(
      v => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().optional(),
    ),
  since: z
    .preprocess(
      v => (v === '' || v === undefined ? undefined : v),
      z.coerce.number().int().nonnegative().optional(),
    ),
});
export type ArchivedChannelsQueryInput = z.infer<
  typeof ArchivedChannelsQueryInputSchema
>;

/** Row in the global archived-channels list. `workspace.archived_at`
 *  is included so the UI can flag rows whose workspace itself is
 *  archived without a second lookup. `thread_count` is computed
 *  server-side so the row can render "N threads" without requesting
 *  the threads themselves. */
export const ArchivedChannelListItemDtoSchema = z.object({
  channel: ChannelConversationDtoSchema,
  workspace: z.object({
    id: z.string(),
    name: z.string(),
    archived_at: z.number().nullable(),
  }),
  thread_count: z.number().int().nonnegative(),
});
export type ArchivedChannelListItemDto = z.infer<
  typeof ArchivedChannelListItemDtoSchema
>;

export const ArchivedChannelsDtoSchema = z.object({
  channels: z.array(ArchivedChannelListItemDtoSchema),
});
export type ArchivedChannelsDto = z.infer<typeof ArchivedChannelsDtoSchema>;

// ── Workspace membership ─────────────────────────────────────────
export const AddWorkspaceAgentMemberInputSchema = z.object({
  agent_id: z.string(),
});
export const AddWorkspaceTaggedAgentMemberInputSchema = z.object({
  kind: z.literal('agent'),
  agent_id: z.string(),
});
export const AddWorkspaceHumanMemberInputSchema = z.object({
  kind: z.literal('human'),
  user_id: z.string(),
});
export const AddWorkspaceMemberInputSchema = z.union([
  AddWorkspaceTaggedAgentMemberInputSchema,
  AddWorkspaceHumanMemberInputSchema,
  AddWorkspaceAgentMemberInputSchema,
]);
export type AddWorkspaceMemberInput = z.infer<typeof AddWorkspaceMemberInputSchema>;

export const WorkspaceMembersResponseSchema = z.object({
  members: z.array(AgentDtoSchema),
  human_members: z.array(UserDtoSchema),
});
export type WorkspaceMembersResponse = z.infer<
  typeof WorkspaceMembersResponseSchema
>;

// Ephemeral per-agent run state used by `agent_activity` realtime events and
// reconnect snapshots. These rows are not persisted to the messages DB.
export const AgentRunStatusSchema = z.enum([
  'starting',
  'thinking',
  'tool_running',
  'idle',
  'failed',
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const AgentRunTerminalReasonSchema = z.enum([
  'replied',
  'turn_ended',
  'replaced',
  'stopped',
  'crashed',
  'timeout',
  'conversation_closed',
]);
export type AgentRunTerminalReason = z.infer<
  typeof AgentRunTerminalReasonSchema
>;

export const AgentRunStateSchema = z.object({
  runId: z.string(),
  agentId: z.string(),
  conversationId: z.string(),
  status: AgentRunStatusSchema,
  startedAt: z.number(),
  updatedAt: z.number(),
  lastActivityAt: z.number(),
  terminalReason: AgentRunTerminalReasonSchema.optional(),
  activitySnippet: z.string().optional(),
  toolCallCounts: z.record(z.string(), z.number()).optional(),
  compacting: z.boolean().optional(),
  compactingSince: z.number().optional(),
  compactionStale: z.boolean().optional(),
  detail: z.string().optional(),
});
export type AgentRunState = z.infer<typeof AgentRunStateSchema>;

export const AgentActivityEventSchema = AgentRunStateSchema;
export type AgentActivityEvent = AgentRunState;

export const AgentRunStatesDtoSchema = z.object({
  states: z.array(AgentRunStateSchema),
});
export type AgentRunStatesDto = z.infer<typeof AgentRunStatesDtoSchema>;

// ── Message ──────────────────────────────────────────────────────
export const TaskAssigneeDtoSchema = z.object({
  type: TaskAssigneeTypeSchema,
  id: z.string(),
  /** Agent display_name or user name — denormalized for list render. */
  name: z.string(),
});
export type TaskAssigneeDto = z.infer<typeof TaskAssigneeDtoSchema>;

// ── Attachments ──────────────────────────────────────────────────
//
// Two shapes:
//   - AttachmentDto: full row, returned by upload/get-by-id endpoints.
//   - AttachmentSnapshot: the immutable subset embedded into a message
//     when the message references the attachment. Lives under
//     `metadata.attachments` so renderers can render image/file cells
//     without an extra round-trip.
//
// No de-duplication: every upload creates a new row + new blob, so the
// snapshot/source row never drift.

export const AttachmentDtoSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  source_conversation_id: z.string().nullable(),
  filename: z.string(),
  size: z.number(),
  content_type: z.string(),
  storage: StorageKindSchema,
  created_by_kind: AttachmentCreatorKindSchema,
  created_by_id: z.string(),
  created_at: z.number(),
});
export type AttachmentDto = z.infer<typeof AttachmentDtoSchema>;

/** Minimal immutable subset embedded into a message's metadata. */
export const AttachmentSnapshotSchema = z.object({
  id: z.string(),
  filename: z.string(),
  size: z.number(),
  content_type: z.string(),
});
export type AttachmentSnapshot = z.infer<typeof AttachmentSnapshotSchema>;

export const MessageDtoSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  from_kind: FromKindSchema,
  from_agent_id: z.string().nullable(),
  from_user_id: z.string().nullable(),
  content: z.string(),
  metadata: z.record(z.unknown()).nullable(),
  /** Attachment snapshots attached to this message (null when none).
   *  Mirrored from `metadata.attachments` for typed access. */
  attachments: z.array(AttachmentSnapshotSchema).nullable(),
  seq: z.number(),
  created_at: z.number(),
  /** Task metadata — all null when this message is not a task. */
  task_number: z.number().nullable(),
  task_status: TaskStatusSchema.nullable(),
  task_title: z.string().nullable(),
  task_workspace_id: z.string().nullable(),
  task_closed_at: z.number().nullable(),
  task_assignee: TaskAssigneeDtoSchema.nullable(),
});
export type MessageDto = z.infer<typeof MessageDtoSchema>;

export const ConversationMessagesDtoSchema = z.object({
  messages: z.array(MessageDtoSchema),
  has_more_before: z.boolean(),
  /** True when at least one message exists with seq > max(messages.seq).
   *  For the default "latest" window this is always false; for an
   *  anchored window (`before_seq` / `after_seq` / `around_message_id`)
   *  it reflects the real DB state, so a bidirectional infinite query
   *  knows whether to issue a `getNextPageParam`. */
  has_more_after: z.boolean(),
});
export type ConversationMessagesDto = z.infer<typeof ConversationMessagesDtoSchema>;

export const SendMessageInputSchema = z.object({
  content: z.string().min(1),
  /** Optional attachment ids previously returned by the upload endpoint.
   *  Server validates each id belongs to the same channel as the
   *  destination conversation. */
  attachment_ids: z.array(z.string().min(1)).max(20).optional(),
});
export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

/** Upload endpoint response — same shape as AttachmentDto today. */
export const AttachmentUploadResponseSchema = AttachmentDtoSchema;
export type AttachmentUploadResponse = z.infer<typeof AttachmentUploadResponseSchema>;

/** `silverhand file view` locate response. */
export const AttachmentLocateDtoSchema = z.union([
  z.object({
    storage: z.literal('local'),
    local_path: z.string(),
    filename: z.string(),
    content_type: z.string(),
  }),
  z.object({
    storage: z.enum(['s3', 'oss']),
    download_url: z.string(),
    filename: z.string(),
    content_type: z.string(),
  }),
]);
export type AttachmentLocateDto = z.infer<typeof AttachmentLocateDtoSchema>;

export const MarkConversationReadInputSchema = z.object({
  /** Optional explicit target cursor. Omitted = backend uses MAX(messages.seq). */
  seq: z.number().int().nonnegative().optional(),
});
export type MarkConversationReadInput = z.infer<
  typeof MarkConversationReadInputSchema
>;

export const MarkConversationReadDtoSchema = z.object({
  last_read_seq: z.number(),
});
export type MarkConversationReadDto = z.infer<typeof MarkConversationReadDtoSchema>;

export const MessageUnreadByConversationDtoSchema = z.object({
  by_conversation: z.record(z.string(), z.number()),
  total: z.number(),
});
export type MessageUnreadByConversationDto = z.infer<
  typeof MessageUnreadByConversationDtoSchema
>;

export const MessageUnreadSummaryDtoSchema = z.object({
  by_workspace: z.record(z.string(), z.number()),
});
export type MessageUnreadSummaryDto = z.infer<
  typeof MessageUnreadSummaryDtoSchema
>;

// ── Global chat search ───────────────────────────────────────────

const SearchOptionalStringSchema = z.preprocess(
  value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().optional(),
);

const SearchOptionalMillisSchema = z.preprocess(
  value => (value === '' || value === undefined ? undefined : value),
  z.coerce.number().int().nonnegative().optional(),
);

export const SearchScopeSchema = z.enum(['all', 'regular', 'dm']);
export type SearchScope = z.infer<typeof SearchScopeSchema>;

export const SearchQueryInputSchema = z
  .object({
    q: z.string().trim().max(200).optional().default(''),
    scope: SearchScopeSchema.optional().default('all'),
    workspace_id: SearchOptionalStringSchema,
    conversation_id: SearchOptionalStringSchema,
    user_id: SearchOptionalStringSchema,
    agent_id: SearchOptionalStringSchema,
    from: SearchOptionalMillisSchema,
    to: SearchOptionalMillisSchema,
    limit: z.coerce.number().int().positive().max(200).optional().default(80),
  })
  .refine(v => !(v.user_id && v.agent_id), {
    message: 'user_id and agent_id cannot both be set',
    path: ['user_id'],
  });
export type SearchQueryInput = z.infer<typeof SearchQueryInputSchema>;

export const SearchWorkspaceRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['regular', 'dm']),
});
export type SearchWorkspaceRef = z.infer<typeof SearchWorkspaceRefSchema>;

export const SearchConversationRefSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: ConversationKindSchema,
  channel_id: z.string(),
  thread_id: z.string().nullable(),
  parent_conversation_id: z.string().nullable(),
  closed_at: z.number().nullable(),
  created_at: z.number(),
});
export type SearchConversationRef = z.infer<typeof SearchConversationRefSchema>;

export const SearchResultDtoSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('workspace'),
    workspace: SearchWorkspaceRefSchema.extend({
      description: z.string().nullable(),
      archived_at: z.number().nullable(),
      created_at: z.number(),
      updated_at: z.number(),
    }),
  }),
  z.object({
    type: z.literal('conversation'),
    workspace: SearchWorkspaceRefSchema,
    conversation: SearchConversationRefSchema,
  }),
  z.object({
    type: z.literal('message'),
    workspace: SearchWorkspaceRefSchema,
    conversation: SearchConversationRefSchema,
    message: MessageDtoSchema,
    agent_name: z.string().nullable(),
  }),
]);
export type SearchResultDto = z.infer<typeof SearchResultDtoSchema>;

export const SearchDtoSchema = z.object({
  query: SearchQueryInputSchema,
  results: z.array(SearchResultDtoSchema),
});
export type SearchDto = z.infer<typeof SearchDtoSchema>;

// ── Tasks ────────────────────────────────────────────────────────
//
// Per docs/tasks-design.md. A task == a message with task metadata.
// Numbering space is per-channel (#1 monotonic across all sessions of
// the channel); ownership/operation scope is per-conversation (only agents
// in the task's conversation may claim/unclaim/update; other sessions get
// read-only aggregate visibility). Human UI is not assignee-restricted.

export const TaskConversationRefSchema = z.object({
  id: z.string(),
  title: z.string(),
});
export type TaskConversationRef = z.infer<typeof TaskConversationRefSchema>;

export const TaskCreatorDtoSchema = z.object({
  type: z.enum(['agent', 'user', 'system']),
  id: z.string().nullable(),
  name: z.string(),
});
export type TaskCreatorDto = z.infer<typeof TaskCreatorDtoSchema>;

export const TaskSummaryDtoSchema = z.object({
  message_id: z.string(),
  task_number: z.number(),
  workspace_id: z.string(),
  workspace_name: z.string(),
  channel_id: z.string(),
  channel_name: z.string(),
  thread_id: z.string().nullable(),
  conversation: TaskConversationRefSchema,
  status: TaskStatusSchema,
  title: z.string(),
  assignee: TaskAssigneeDtoSchema.nullable(),
  creator: TaskCreatorDtoSchema,
  created_at: z.number(),
  closed_at: z.number().nullable(),
});
export type TaskSummaryDto = z.infer<typeof TaskSummaryDtoSchema>;

// GET /api/tasks (human) / /internal/agent/:aid/tasks (agent)
export const ListTasksQuerySchema = z.object({
  workspace_id: z.string().optional(),
  conversation_id: z.string().optional(),
  /** Filter by status. Empty / omitted = no filter. Multiple values are
   *  OR-ed (e.g. `?status=in_progress&status=in_review`). */
  status: z.array(TaskStatusSchema).optional(),
  /** Filter by task number. Multiple values are OR-ed
   *  (e.g. `?task_number=190&task_number=191`). */
  task_number: z.array(z.coerce.number().int().positive()).optional(),
  /** Filter by assignee agent id. Single-valued. */
  assignee_id: z.string().optional(),
  /** Cap the number of rows returned (server-side LIMIT). */
  limit: z.coerce.number().int().positive().max(500).optional(),
});
export type ListTasksQuery = z.infer<typeof ListTasksQuerySchema>;

// POST /internal/agent/:aid/tasks — create_tasks MCP tool
export const CreateTasksInputSchema = z.object({
  tasks: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        body: z.string().optional(),
      }),
    )
    .min(1),
});
export type CreateTasksInput = z.infer<typeof CreateTasksInputSchema>;

export const CreateTasksOpErrorSchema = z.enum([
  'conversation_not_found',
  'conversation_closed',
  'not_conversation_member',
  'agent_not_found',
]);
export type CreateTasksOpError = z.infer<typeof CreateTasksOpErrorSchema>;

export const CreateTasksSuccessSchema = z.object({
  tasks: z.array(
    z.object({
      message_id: z.string(),
      task_number: z.number(),
      title: z.string(),
    }),
  ),
});
export const CreateTasksFailureSchema = z.object({
  error: CreateTasksOpErrorSchema,
});
export const CreateTasksResultSchema = z.union([
  CreateTasksSuccessSchema,
  CreateTasksFailureSchema,
]);
export type CreateTasksResult = z.infer<typeof CreateTasksResultSchema>;

// POST /internal/agent/:aid/tasks/claim — claim_tasks MCP tool
export const ClaimTasksInputSchema = z
  .object({
    task_numbers: z.array(z.number()).optional(),
    message_ids: z.array(z.string()).optional(),
    /** Optional workspace selector for cross-workspace task ops. When
     *  omitted, the target task is resolved in the actor's current
     *  conversation's workspace (the legacy default). When provided,
     *  the actor must already be a member of the resolved workspace.
     *  `workspace_id` and `workspace_name` are mutually exclusive.
     *
     *  The selector intentionally does NOT apply to message-id
     *  promotion (turning a not-yet-task message into a task): a
     *  regular message can only become a task in its own
     *  conversation, so promotion always targets the actor's
     *  current workspace regardless of selector. */
    workspace_id: z.string().optional(),
    workspace_name: z.string().optional(),
  })
  .refine(v => (v.task_numbers?.length ?? 0) + (v.message_ids?.length ?? 0) > 0, {
    message: 'provide at least one of task_numbers or message_ids',
  })
  .refine(v => !(v.workspace_id && v.workspace_name), {
    message: 'workspace_id and workspace_name are mutually exclusive',
  });
export type ClaimTasksInput = z.infer<typeof ClaimTasksInputSchema>;

/** Typed code for claim-tool failures. `wrong_conversation` remains for
 *  the message-id promotion path (a message can only become a task in
 *  its own conversation); cross-workspace task ops fail with
 *  `workspace_membership_required` / `unknown_workspace` /
 *  `ambiguous_workspace` instead. `task_done`, `already_claimed` etc.
 *  are stable; the free-form `reason` string is preserved alongside
 *  `code` for tool consumers. */
export const ClaimErrorCodeSchema = z.enum([
  'task_not_found',
  'message_not_found',
  'wrong_conversation',
  'cannot_promote_system_message',
  'cannot_promote_anchor',
  'task_done',
  'task_closed',
  'already_claimed',
  'not_self_assignment',
  'assignee_not_conversation_member',
  'conversation_not_found',
  'not_conversation_member',
  'agent_not_found',
  'not_a_task',
  'unknown_workspace',
  'ambiguous_workspace',
  'workspace_membership_required',
]);
export type ClaimErrorCode = z.infer<typeof ClaimErrorCodeSchema>;

export const ClaimResultEntrySchema = z.object({
  success: z.boolean(),
  task_number: z.number().optional(),
  message_id: z.string().optional(),
  reason: z.string().optional(),
  /** Typed failure code; present whenever `success === false`. */
  code: ClaimErrorCodeSchema.optional(),
  /** If the task belongs to a different channel/thread, its id+title surface
   *  here so the caller can explain to the agent why claim failed. */
  owner_conversation: TaskConversationRefSchema.optional(),
  /** Workspace ids matching the supplied `workspace_name`, returned when
   *  `code === 'ambiguous_workspace'` so the caller can disambiguate. */
  workspace_candidates: z.array(z.string()).optional(),
});
export type ClaimResultEntry = z.infer<typeof ClaimResultEntrySchema>;

export const ClaimTasksResultSchema = z.object({
  results: z.array(ClaimResultEntrySchema),
});
export type ClaimTasksResult = z.infer<typeof ClaimTasksResultSchema>;

// POST /internal/agent/:aid/tasks/unclaim
export const UnclaimTaskInputSchema = z
  .object({
    task_number: z.number().int().positive(),
    /** Optional workspace selector — see ClaimTasksInputSchema. */
    workspace_id: z.string().optional(),
    workspace_name: z.string().optional(),
  })
  .refine(v => !(v.workspace_id && v.workspace_name), {
    message: 'workspace_id and workspace_name are mutually exclusive',
  });
export type UnclaimTaskInput = z.infer<typeof UnclaimTaskInputSchema>;

// POST /internal/agent/:aid/tasks/update-status
export const UpdateTaskStatusInputSchema = z
  .object({
    task_number: z.number().int().positive(),
    status: TaskStatusSchema,
    /** Optional workspace selector — see ClaimTasksInputSchema. */
    workspace_id: z.string().optional(),
    workspace_name: z.string().optional(),
  })
  .refine(v => !(v.workspace_id && v.workspace_name), {
    message: 'workspace_id and workspace_name are mutually exclusive',
  });
export type UpdateTaskStatusInput = z.infer<typeof UpdateTaskStatusInputSchema>;

/** Typed code for unclaim / status mutation failures. */
export const TaskMutationErrorCodeSchema = z.enum([
  'not_a_task',
  'task_not_found',
  'task_done',
  'wrong_conversation',
  'not_assignee',
  'invalid_transition',
  'already_at_status',
  'task_closed',
  'conversation_not_found',
  'not_conversation_member',
  'agent_not_found',
  'unknown_workspace',
  'ambiguous_workspace',
  'workspace_membership_required',
]);
export type TaskMutationErrorCode = z.infer<typeof TaskMutationErrorCodeSchema>;

// Simple success/failure envelope reused by unclaim / update-status.
export const TaskMutationResultSchema = z.object({
  success: z.boolean(),
  reason: z.string().optional(),
  /** Typed failure code; present whenever `success === false`. */
  code: TaskMutationErrorCodeSchema.optional(),
  /** Workspace ids matching the supplied `workspace_name`, returned when
   *  `code === 'ambiguous_workspace'` so the caller can disambiguate. */
  workspace_candidates: z.array(z.string()).optional(),
});
export type TaskMutationResult = z.infer<typeof TaskMutationResultSchema>;

// Human UI — POST /api/tasks/:messageId/status
export const HumanUpdateTaskStatusInputSchema = z.object({
  status: TaskStatusSchema,
});
export type HumanUpdateTaskStatusInput = z.infer<
  typeof HumanUpdateTaskStatusInputSchema
>;

// Human UI — POST /api/tasks/:messageId/claim (optional target agent)
export const HumanClaimTaskInputSchema = z.object({
  agent_id: z.string().optional(),
});
export type HumanClaimTaskInput = z.infer<typeof HumanClaimTaskInputSchema>;

// Realtime payload — published on every task mutation (create / claim /
// unclaim / status change). Consumers refresh the list + any open
// conversation's inline task drawer.
export const TaskChangedEventSchema = z.object({
  kind: z.enum(['create', 'claim', 'unclaim', 'status']),
  workspace_id: z.string(),
  channel_id: z.string(),
  thread_id: z.string().nullable(),
  conversation_id: z.string(),
  task_number: z.number(),
  message_id: z.string(),
  status: TaskStatusSchema,
  assignee: TaskAssigneeDtoSchema.nullable(),
  title: z.string(),
  closed_at: z.number().nullable(),
});
export type TaskChangedEvent = z.infer<typeof TaskChangedEventSchema>;

// ── Internal API (silverhand CLI → backend) ──────────────────────

export const SendMessageTargetSchema = z.union([
  z.literal('self'),
  z.literal('parent'),
  z.object({ thread_id: z.string().min(1) }),
]);
export type SendMessageTarget = z.infer<typeof SendMessageTargetSchema>;

export const AgentSendMessageInputSchema = z.object({
  content: z.string().min(1),
  target: SendMessageTargetSchema.optional(),
  /** Optional attachment ids previously returned by `upload_file`.
   *  Server validates each id belongs to the same channel as the
   *  resolved target conversation. */
  attachment_ids: z.array(z.string().min(1)).max(20).optional(),
});
export type AgentSendMessageInput = z.infer<typeof AgentSendMessageInputSchema>;

// ── Saved messages (bookmarks) ───────────────────────────────────
//
// One global flat list — no per-channel grouping, no tags. Each entry
// joins back to the source message + its workspace/conversation so the Saved
// view can render content + jump back to the conversation.
export const SavedMessageDtoSchema = z.object({
  id: z.string(),
  message: MessageDtoSchema,
  workspace_id: z.string(),
  workspace_name: z.string(),
  conversation_id: z.string(),
  conversation_title: z.string(),
  channel_id: z.string(),
  thread_id: z.string().nullable(),
  /** Display name of the message author at save time. `null` for user messages. */
  agent_name: z.string().nullable(),
  saved_at: z.number(),
});
export type SavedMessageDto = z.infer<typeof SavedMessageDtoSchema>;

export const AgentSpawnChildInputSchema = z.object({
  title: z.string().min(1),
  members: z.array(z.string().min(1)).optional(),
  context_summary: z.string().min(1),
  initial_prompt: z.string().min(1),
});
export type AgentSpawnChildInput = z.infer<typeof AgentSpawnChildInputSchema>;

export const AgentCreateChannelInputSchema = z.object({
  title: z.string().min(1).max(128),
  context_summary: z.string().min(1),
  initial_prompt: z.string().min(1),
});
export type AgentCreateChannelInput = z.infer<
  typeof AgentCreateChannelInputSchema
>;

export const AgentCloseThreadInputSchema = z.object({
  summary: z.string().min(1),
  posted_to_parent: z.boolean().optional(),
  /** Explicit override: bypass the "thread has no open tasks" guard.
   *  Set ONLY when the caller has consciously decided to leave one or
   *  more tasks in `todo`/`in_progress`/`in_review` after the thread is
   *  closed. The server still rejects `already_closed` and
   *  `has_active_children` regardless of this flag. */
  allow_open_tasks: z.boolean().optional(),
});
export type AgentCloseThreadInput = z.infer<typeof AgentCloseThreadInputSchema>;

/** Structured detail attached to the backend `has_open_tasks` error so
 *  the CLI can render a list of the offending tasks without re-parsing
 *  the prose message. */
export const ThreadCloseOpenTaskDetailSchema = z.object({
  task_number: z.number().int().positive(),
  status: z.enum(['todo', 'in_progress', 'in_review']),
  title: z.string(),
  assignee_name: z.string().nullable(),
  assignee_agent_id: z.string().nullable(),
});
export type ThreadCloseOpenTaskDetail = z.infer<
  typeof ThreadCloseOpenTaskDetailSchema
>;

// ── Agent read_history MCP tool ───────────────────────────────────

const ReadHistoryOptionalSeqSchema = z.preprocess(
  value => (value === '' || value === undefined ? undefined : value),
  z.coerce.number().int().nonnegative().optional(),
);

const ReadHistoryOptionalLimitSchema = z.preprocess(
  value => (value === '' || value === undefined ? undefined : value),
  z.coerce.number().int().positive().max(100).optional().default(50),
);

/** read_history target. Deliberately decoupled from
 *  `SendMessageTargetSchema` so adding read-only cross-conversation
 *  navigation here does NOT silently widen the surface that allows
 *  cross-conversation message posting. The `{ conversation_id }`
 *  form is membership-gated server-side via `conversation_agents`. */
export const ReadHistoryTargetSchema = z.union([
  z.literal('self'),
  z.literal('parent'),
  z.object({ thread_id: z.string().min(1) }),
  z.object({ conversation_id: z.string().min(1) }),
]);
export type ReadHistoryTarget = z.infer<typeof ReadHistoryTargetSchema>;

export const AgentReadHistoryInputSchema = z
  .object({
    target: ReadHistoryTargetSchema.optional(),
    before_seq: ReadHistoryOptionalSeqSchema,
    after_seq: ReadHistoryOptionalSeqSchema,
    around_message_id: z.string().min(1).optional(),
    include_content: z.boolean().optional().default(false),
    include_system: z.boolean().optional().default(true),
    limit: ReadHistoryOptionalLimitSchema,
  })
  .refine(
    value =>
      [value.before_seq, value.after_seq, value.around_message_id].filter(
        v => v !== undefined,
      ).length === 1,
    {
      message: 'anchor required: pass exactly one of before_seq, after_seq, or around_message_id',
      path: ['before_seq'],
    },
  );
export type AgentReadHistoryInput = z.infer<typeof AgentReadHistoryInputSchema>;

export const MessageRefSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  conversation_id: z.string(),
  conversation_kind: ConversationKindSchema,
  channel_id: z.string(),
  thread_id: z.string().nullable(),
  seq: z.number(),
  created_at: z.number(),
});
export type MessageRef = z.infer<typeof MessageRefSchema>;

export const MessageSenderRefSchema = z.object({
  kind: FromKindSchema,
  agent_id: z.string().nullable(),
  user_id: z.string().nullable(),
  display_name: z.string().nullable(),
});
export type MessageSenderRef = z.infer<typeof MessageSenderRefSchema>;

export const ReadHistoryTargetRefSchema = z.object({
  conversation_id: z.string(),
  conversation_kind: ConversationKindSchema,
  channel_id: z.string(),
  thread_id: z.string().nullable(),
  workspace_id: z.string(),
  title: z.string(),
});
export type ReadHistoryTargetRef = z.infer<typeof ReadHistoryTargetRefSchema>;

export const ReadHistoryMessageSchema = z.object({
  message_ref: MessageRefSchema,
  sender: MessageSenderRefSchema,
  snippet: z.string(),
  metadata: z.record(z.unknown()).nullable(),
  attachments: z.array(AttachmentSnapshotSchema).nullable(),
  content: z.string().optional(),
});
export type ReadHistoryMessage = z.infer<typeof ReadHistoryMessageSchema>;

export const ReadHistoryAnchorSchema = z.union([
  z.object({ type: z.literal('before_seq'), seq: z.number() }),
  z.object({ type: z.literal('after_seq'), seq: z.number() }),
  z.object({ type: z.literal('around_message_id'), message_id: z.string() }),
]);
export type ReadHistoryAnchor = z.infer<typeof ReadHistoryAnchorSchema>;

export const AgentReadHistoryDtoSchema = z.object({
  target: ReadHistoryTargetRefSchema,
  anchor: ReadHistoryAnchorSchema,
  limit: z.number(),
  include_content: z.boolean(),
  include_system: z.boolean(),
  messages: z.array(ReadHistoryMessageSchema),
  has_more_before: z.boolean(),
  has_more_after: z.boolean(),
});
export type AgentReadHistoryDto = z.infer<typeof AgentReadHistoryDtoSchema>;

// ── Agent list_workspaces / list_channels / search_messages MCP tools ──

/** One workspace the calling agent currently has member access to.
 *  `kind` mirrors DB truth (`'regular' | 'agent_home'`); 'dm' is a
 *  conversation-level concept and is intentionally not synthesized
 *  here. `agent_dir` is the agent's working directory inside this
 *  workspace — for `agent_home` this is the workspace root itself,
 *  for `regular` it is the nested `.silverhand/agents/<agent_id>`
 *  L2 profile dir. */
export const AgentListedWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: WorkspaceKindSchema,
  archived: z.boolean(),
  updated_at: z.number(),
  agent_dir: z.string(),
});
export type AgentListedWorkspace = z.infer<typeof AgentListedWorkspaceSchema>;

export const AgentListWorkspacesDtoSchema = z.object({
  workspaces: z.array(AgentListedWorkspaceSchema),
});
export type AgentListWorkspacesDto = z.infer<typeof AgentListWorkspacesDtoSchema>;

/** Optional query for `list_channels`. When `workspace_id` is omitted,
 *  the route defaults to the source conversation's workspace. */
export const AgentListChannelsQuerySchema = z.object({
  workspace_id: z.string().min(1).optional(),
});
export type AgentListChannelsQuery = z.infer<typeof AgentListChannelsQuerySchema>;

export const AgentListedChannelSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(['channel', 'dm_channel']),
  archived: z.boolean(),
  updated_at: z.number(),
});
export type AgentListedChannel = z.infer<typeof AgentListedChannelSchema>;

export const AgentListChannelsDtoSchema = z.object({
  workspace_id: z.string(),
  channels: z.array(AgentListedChannelSchema),
});
export type AgentListChannelsDto = z.infer<typeof AgentListChannelsDtoSchema>;

export const AgentSearchMessagesScopeSchema = z.enum([
  'current',
  'workspace',
  'channel',
]);
export type AgentSearchMessagesScope = z.infer<
  typeof AgentSearchMessagesScopeSchema
>;

const AgentSearchMessagesLimitSchema = z.preprocess(
  value => (value === '' || value === undefined ? undefined : value),
  z.coerce.number().int().positive().max(100).optional().default(50),
);

export const AgentSearchMessagesInputSchema = z
  .object({
    q: z.string().trim().min(1).max(200),
    scope: AgentSearchMessagesScopeSchema.optional().default('current'),
    workspace_id: z.string().min(1).optional(),
    channel_id: SearchOptionalStringSchema,
    include_system: z.boolean().optional().default(true),
    limit: AgentSearchMessagesLimitSchema,
  })
  .superRefine((v, ctx) => {
    if ((v.scope === 'channel') !== !!v.channel_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'channel_id is required only when scope is channel',
        path: ['channel_id'],
      });
    }
    if (v.workspace_id && v.scope !== 'workspace') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'workspace_id is only valid with scope=workspace',
        path: ['workspace_id'],
      });
    }
  });
export type AgentSearchMessagesInput = z.infer<
  typeof AgentSearchMessagesInputSchema
>;

export const AgentSearchMessageHitSchema = z.object({
  message_ref: MessageRefSchema,
  sender: MessageSenderRefSchema,
  excerpt: z.string(),
  match_offset: z.number().int().nonnegative(),
});
export type AgentSearchMessageHit = z.infer<typeof AgentSearchMessageHitSchema>;

export const AgentSearchMessagesDtoSchema = z.object({
  query: z.string(),
  scope: AgentSearchMessagesScopeSchema,
  workspace_id: z.string().nullable(),
  channel_id: z.string().nullable(),
  include_system: z.boolean(),
  limit: z.number(),
  hits: z.array(AgentSearchMessageHitSchema),
});
export type AgentSearchMessagesDto = z.infer<typeof AgentSearchMessagesDtoSchema>;

// ── Runtime info (binary detection) ──────────────────────────────
export const RuntimeInfoSchema = z.object({
  kind: RuntimeKindSchema,
  installed: z.boolean(),
  binary: z.string().nullable(),
  version: z.string().nullable(),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>;

// ── Notifications ────────────────────────────────────────────────
//
// v1 only emits `mention_external`: a user @-mentioned an agent who
// wasn't a member of the originating conversation. The mention was CC'd
// into that agent's DM channel (a dedicated `Mentions` conversation); a
// notification points the user at it.
//
// `payload` is open-ended JSON for kind-specific extras. For
// mention_external we stash:
//   - source_workspace_name: string  (denormalized for list rendering)
//   - source_conversation_title: string
//   - mention_excerpt: string  (first ~120 chars of the original)
// mention_self stashes:
//   - conversation_title: string
//   - trigger_name: string  (display label of the sender who mentioned viewer)
//   - mentioned_name: string
//   - mention_excerpt: string

export const NotificationDtoSchema = z.object({
  id: z.string(),
  kind: NotificationKindSchema,
  user_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  workspace_id: z.string().nullable(),
  conversation_id: z.string().nullable(),
  message_id: z.string().nullable(),
  source_workspace_id: z.string().nullable(),
  source_conversation_id: z.string().nullable(),
  source_message_id: z.string().nullable(),
  payload: z.record(z.unknown()).nullable(),
  read_at: z.number().nullable(),
  created_at: z.number(),
});
export type NotificationDto = z.infer<typeof NotificationDtoSchema>;

export const MarkNotificationsReadInputSchema = z
  .object({
    /** Mark a specific id; omit to use channel/all selectors. */
    id: z.string().optional(),
    /** Mark all unread notifications scoped to this workspace/sidebar item. */
    workspace_id: z.string().optional(),
    /** Mark all unread notifications scoped to a single conversation. */
    conversation_id: z.string().optional(),
    /** Mark every unread notification (for the current user). */
    all: z.boolean().optional(),
  })
  .refine(v => !!(v.id || v.workspace_id || v.conversation_id || v.all), {
    message: 'must specify id, workspace_id, conversation_id, or all',
  });
export type MarkNotificationsReadInput = z.infer<
  typeof MarkNotificationsReadInputSchema
>;

// ── Mention extraction ───────────────────────────────────────────
//
// Single source of truth for what "@name" means in a message body.
// Mirrors the renderer-side regex in `Markdown.tsx` and the
// composer-side detector — the boundary check rejects emails (`me@x`)
// and paths (`a/@b`), and the alpha-first requirement rejects issue
// refs like `@123`. Aligned with auth-signup generated user names
// (alpha-first by design: `users.name` is the permanent mention
// anchor). `CreateAgentInputSchema.name` is intentionally broader
// (`/^[a-zA-Z0-9_-]+$/`, allows numeric-first); a numeric-first
// agent name will not be `@`-mentionable until/unless that schema
// is tightened — out of scope for the registration rewrite.
const MENTION_RE = /(?<![\w/])@([a-zA-Z][a-zA-Z0-9_-]*)/g;

/** Returns the unique set of @-names referenced in `text`, in
 *  first-occurrence order. */
export function extractMentions(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const name = m[1]!;
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

// ── Schedules ────────────────────────────────────────────────────
//
// Agent-owned cron-like scheduler. A schedule is a self-driven
// reminder for ONE agent — it has zero coupling to channels, tasks,
// or other agents. The agent picks a time policy (`spec`) and the
// service wakes the agent at the next due time by inserting a
// `from_kind='system'` message into the agent's agent_home primary
// dm_channel and delivering it only to the owner.
//
// Specs are a discriminated union:
//   - `once`     : single fire at `fire_at` (or now+`delay_seconds`)
//   - `interval` : fire every `every_seconds` (>=60); `start_at`
//                  optional (defaults to now+every_seconds)
//   - `cron`     : 5-field UNIX cron expression evaluated in the
//                  given IANA timezone
//
// `until_at` and `max_occurrences` are independent caps; either ends
// a repeating schedule. Repeats with neither cap MUST set
// `allow_unbounded: true` on the input — otherwise the request is
// rejected to prevent accidental forever-runs.
//
// Quotas (server-enforced):
//   - per agent: at most 50 active (`pending`+`firing`)
//   - one-shot delay window: [30s, 90d]
//   - interval `every_seconds` >= 60 (aligned to scheduler tick)
//
// All times are epoch-ms UTC.

export const SCHEDULE_MIN_DELAY_SECONDS = 30;
export const SCHEDULE_MAX_DELAY_SECONDS = 90 * 24 * 60 * 60; // 90 days
export const SCHEDULE_MIN_INTERVAL_SECONDS = 60;
export const SCHEDULE_MAX_ACTIVE_PER_AGENT = 50;
export const SCHEDULE_TITLE_MAX_LEN = 120;
export const SCHEDULE_MESSAGE_MAX_LEN = 500;

export const ScheduleStatusSchema = z.enum([
  'pending',
  'firing',
  'done',
  'cancelled',
  'failed',
]);
export type ScheduleStatus = z.infer<typeof ScheduleStatusSchema>;

export const ScheduleSpecOnceSchema = z.object({
  kind: z.literal('once'),
  fire_at: z.number().int().positive(),
});
export type ScheduleSpecOnce = z.infer<typeof ScheduleSpecOnceSchema>;

export const ScheduleSpecIntervalSchema = z.object({
  kind: z.literal('interval'),
  every_seconds: z.number().int().min(SCHEDULE_MIN_INTERVAL_SECONDS),
  start_at: z.number().int().positive().optional(),
});
export type ScheduleSpecInterval = z.infer<typeof ScheduleSpecIntervalSchema>;

export const ScheduleSpecCronSchema = z.object({
  kind: z.literal('cron'),
  // 5-field UNIX cron expression. Validated at schedule time via
  // cron-parser; minute granularity, no seconds field.
  expression: z.string().min(1).max(200),
  // IANA timezone name (e.g., 'Asia/Shanghai', 'America/New_York').
  // Required so DST behavior is explicit and stable across hosts.
  timezone: z.string().min(1).max(64),
});
export type ScheduleSpecCron = z.infer<typeof ScheduleSpecCronSchema>;

export const ScheduleSpecSchema = z.discriminatedUnion('kind', [
  ScheduleSpecOnceSchema,
  ScheduleSpecIntervalSchema,
  ScheduleSpecCronSchema,
]);
export type ScheduleSpec = z.infer<typeof ScheduleSpecSchema>;

export const ScheduleDtoSchema = z.object({
  id: z.string(),
  owner_agent_id: z.string(),
  /** The conversation whose `(conversation, owner_agent)` runtime is woken
   *  up when this schedule fires. The wake message — and the agent's
   *  response/report — both happen in this conversation. Set at create
   *  time and validated against owner agent's membership; v28 backfilled
   *  existing rows from owner's agent_home DM. Never null after v28. */
  target_conversation_id: z.string(),
  /** Server-side derived label for `target_conversation_id`, projected
   *  by the agent-facing schedule list/create response. Format:
   *    - `#<title>`           for a regular channel
   *    - `@<title>`           for a DM channel (workspace_kind agent_home)
   *    - `#<parent>:<title>`  for a thread under a known parent
   *    - `<title>`            for a thread whose parent is missing
   *    - `'Unavailable conversation'` when the target id no longer
   *      resolves (deleted/orphaned).
   *  ACL boundary: this label follows the **schedule's** visibility, not
   *  the target conversation's — once the caller is allowed to see the
   *  schedule, the label is part of the schedule's own semantics
   *  (the schedule describes WHERE it fires) rather than a leaked
   *  metadata projection of the target. The label is intentionally
   *  minimal (title + kind) and never carries workspace path, member
   *  list, parent ids, or any other target-private metadata. */
  target_label: z.string(),
  title: z.string(),
  message: z.string(),
  spec: ScheduleSpecSchema,
  next_fire_at: z.number(),
  status: ScheduleStatusSchema,
  fired_count: z.number(),
  last_fired_at: z.number().nullable(),
  max_occurrences: z.number().nullable(),
  until_at: z.number().nullable(),
  failure_reason: z.string().nullable(),
  cancelled_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type ScheduleDto = z.infer<typeof ScheduleDtoSchema>;

// MCP `schedule` input. `delay_seconds` is a convenience for one-shot
// callers — server canonicalizes to `fire_at = now + delay_seconds*1000`
// before persisting; only one of `fire_at`/`delay_seconds` may be set on
// a `once` spec.
export const ScheduleCreateOnceInputSchema = z.object({
  kind: z.literal('once'),
  fire_at: z.number().int().positive().optional(),
  delay_seconds: z.number().int().positive().optional(),
});
export type ScheduleCreateOnceInput = z.infer<
  typeof ScheduleCreateOnceInputSchema
>;

export const ScheduleCreateInputSchema = z
  .object({
    title: z.string().trim().min(1).max(SCHEDULE_TITLE_MAX_LEN),
    message: z.string().min(1).max(SCHEDULE_MESSAGE_MAX_LEN),
    /** Optional. The conversation whose `(conversation, owner_agent)`
     *  runtime should be woken up on each fire — that runtime owns the
     *  full lifecycle: receive wake → produce work → post result, all
     *  in its own context. If omitted, the server defaults to the
     *  conversation the create call was made from (so creating in DM
     *  fires in DM, in a channel fires in that channel, etc.). The
     *  caller must be a member of the target conversation. */
    target_conversation_id: z.string().optional(),
    spec: z.discriminatedUnion('kind', [
      ScheduleCreateOnceInputSchema,
      ScheduleSpecIntervalSchema,
      ScheduleSpecCronSchema,
    ]),
    /** Optional epoch-ms termination for repeat specs. REJECTED on `once`. */
    until_at: z.number().int().positive().optional(),
    /** Optional max-fire-count cap for repeat specs. REJECTED on `once`. */
    max_occurrences: z.number().int().positive().optional(),
    /** Required `true` for repeat specs without `until_at`/`max_occurrences`.
     *  REJECTED on `once` (one-shots fire exactly once and don't need
     *  a "no upper bound" opt-in). */
    allow_unbounded: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.spec.kind === 'once') {
      // Strict-reject (vs silent-ignore) for repeat-only knobs on a one-shot.
      // Silent-ignore would let the agent see a non-canonical DTO that
      // claims `max_occurrences=N` for a row that can only ever fire once,
      // which is worse than a clear 400.
      if (v.until_at !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['until_at'],
          message: 'until_at is not valid on a `once` schedule',
        });
      }
      if (v.max_occurrences !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['max_occurrences'],
          message: 'max_occurrences is not valid on a `once` schedule',
        });
      }
      if (v.allow_unbounded !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['allow_unbounded'],
          message: 'allow_unbounded is not valid on a `once` schedule',
        });
      }
      if (!!v.spec.fire_at === !!v.spec.delay_seconds) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['spec', 'fire_at'],
          message: 'once spec requires exactly one of fire_at or delay_seconds',
        });
      }
    }
  });
export type ScheduleCreateInput = z.infer<typeof ScheduleCreateInputSchema>;

// MCP `list_schedules` input. `status='active'` is a query-side alias
// for "pending OR firing" — the DB never persists the literal `active`.
export const ScheduleListStatusFilterSchema = z.enum([
  'pending',
  'firing',
  'active',
  'done',
  'cancelled',
  'failed',
  'all',
]);
export type ScheduleListStatusFilter = z.infer<
  typeof ScheduleListStatusFilterSchema
>;

export const ScheduleListInputSchema = z.object({
  status: ScheduleListStatusFilterSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type ScheduleListInput = z.infer<typeof ScheduleListInputSchema>;

export const ScheduleCancelInputSchema = z.object({
  schedule_id: z.string(),
});
export type ScheduleCancelInput = z.infer<typeof ScheduleCancelInputSchema>;

// MCP / internal-route output DTOs. Single-row responses wrap the full
// `ScheduleDto` so the agent always sees the canonical row (e.g. the
// canonicalized `fire_at` after a `delay_seconds` create), and so the
// list response stays consistent with create/cancel output.
export const ScheduleCreateOutputSchema = z.object({
  schedule: ScheduleDtoSchema,
});
export type ScheduleCreateOutput = z.infer<typeof ScheduleCreateOutputSchema>;

export const ScheduleListOutputSchema = z.object({
  schedules: z.array(ScheduleDtoSchema),
});
export type ScheduleListOutput = z.infer<typeof ScheduleListOutputSchema>;

export const ScheduleCancelOutputSchema = z.object({
  schedule: ScheduleDtoSchema,
});
export type ScheduleCancelOutput = z.infer<typeof ScheduleCancelOutputSchema>;

// ── CLI observability ────────────────────────────────────────────────
//
// The CLI fires a one-shot trace at the cli-trace endpoint when it
// fails BEFORE any business HTTP call (parse / strict-flag / unknown
// noun). Backend logs it as `cli.preflight_failure` so we can see the
// typo Top-N without the agent ever realizing the trace exists.
//
// Strict but lenient: every field is optional so a half-formed CLI
// invocation can still be reported. The backend never echoes anything
// back beyond `{ ok: true }`.

export const CliTraceInputSchema = z
  .object({
    /** `silverhand <noun>...` if the noun parsed. */
    noun: z.string().max(64).optional(),
    /** `silverhand <noun> <verb>...` if both parsed. */
    verb: z.string().max(64).optional(),
    /** Names of the flags observed on the command line. NEVER values. */
    flags_seen: z.array(z.string().max(64)).max(64).optional(),
    /** Stable error code from the CLI, e.g. `validation_error`. */
    error_code: z.string().max(64).optional(),
    /** Optional descriptive sub-classification of `error_code`, e.g.
     *  `flag_removed`, `unexpected_arguments`. Wide string here (not a
     *  closed enum) so the CLI can introduce new subkinds without a
     *  shared schema bump; the CLI-side `ErrorSubkind` union is the
     *  source of truth. NEVER values. */
    error_subkind: z.string().max(64).optional(),
    /** First line of the user-facing error message (truncated). */
    error_message: z.string().max(500).optional(),
    /** Wall time from CLI start to error throw, in milliseconds. */
    duration_ms: z.number().nonnegative().optional(),
  })
  .strict();
export type CliTraceInput = z.infer<typeof CliTraceInputSchema>;

export const CliTraceOutputSchema = z.object({ ok: z.literal(true) });
export type CliTraceOutput = z.infer<typeof CliTraceOutputSchema>;

// ── Human-only conversation log debugging ──────────────────────────

export const ConversationLogDebugInputSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();
export type ConversationLogDebugInput = z.infer<
  typeof ConversationLogDebugInputSchema
>;

export const ConversationLogDebugStatusSchema = z
  .object({
    conversationId: z.string(),
    enabled: z.boolean(),
    expiresAt: z.number().int().nullable(),
    daemonSynced: z.boolean().optional(),
  })
  .strict();
export type ConversationLogDebugStatus = z.infer<
  typeof ConversationLogDebugStatusSchema
>;

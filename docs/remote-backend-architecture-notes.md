# Remote-Backend Architecture Notes

> **Status:** living consolidation of *accepted* remote-backend design decisions.
>
> This file absorbs the durable conclusions of the per-stage design / acceptance
> drafts (D4.a–e, D5.a), the Stage-A route-ACL audit, the daemon PR-2
> execution-plane split spec, the human-identity migration plan, and a few
> scratch notes. **Those intermediate documents have been deleted; their
> still-valid content lives here and this file — not git history — is the
> current implementation entry point.** Do not resurrect the old drafts to
> read superseded rationale.
>
> Companion live docs (NOT absorbed, still authoritative on their own axis):
> `remote-backend-roadmap.md` (stages + current status),
> `orchestration-boundary-v1.md` (D2.0 server/daemon boundary contract),
> `auth-and-host-model.md` (auth/identity spec),
> `daemon-outbound-protocol.md` (WS transport),
> `protocol-purity-checklist.md` (drift tripwire),
> and the architecture diagrams `daemon-server-link-flow.html` /
> `auth-comms-chain.html` / `remote-backend-progress.html`.

---

## 0. Terminal-state guardrails (R1–R4)

The whole remote-backend effort is bounded by one rule: **same backend, same
protocol, multiple deployment adapters.** Embedded (desktop-local) and
standalone (networked) deployments differ in *transport and deployment shape*,
never in *protocol semantics*.

- **R4 — adapter, not fork.** Every server↔daemon interaction goes through one
  deployment-neutral `OutboundFrameAdapter`. The transport underneath differs
  (embedded = local Unix socket; standalone = WSS); the frame envelope and
  handler logic do not. Handlers must never branch on deployment mode.
- D4 = "deployment form works"; D5 = "protocol envelope unified". Split by
  *direction*, sequenced so each is independently verifiable.

---

## 1. Auth, identity & session model (shipped end-state)

Three-layer principal hierarchy — see `auth-and-host-model.md` /
`auth-comms-chain.html` for the full picture. Summary of invariants:

- **Principals:** `UserPrincipal{kind:'user',userId}` | `AgentPrincipal{kind:'agent',agentId,conversationId}` | `SystemPrincipal`.
- **Four credential kinds, mutually non-interchangeable, server stores only the sha256 hash:**
  - *user session token* — RFC 6750 Bearer on `/api/*`, sliding TTL (7d default),
    stored hashed in `auth_sessions`, revoked on logout. `issueSession(userId)` →
    32-byte base64url; `validateSessionToken` checks hash+expiry+revocation.
  - *host token* — per-daemon, WS upgrade on `/api/hosts/connect`, long-lived,
    rotate (60s grace) / revoke (immediate). Always minted by the server via
    `POST /api/hosts/claim-or-create`, which **requires a user session bearer** —
    a registered user authorizes every host's birth.
  - *agent token* — per-spawn, env-injected, `/internal/...` scope, revoked on exit.
  - *viewer cookie* — event WS, scope-filtered by workspace/conversation visibility.
- **Local credential storage (V1 policy, #task:772):** all desktop long-lived
  credentials (session token / host token / server-profile) are `0600` plaintext —
  no safeStorage/keychain. Client only promises renderer-invisible +
  not-in-logs/IPC/attachments. Real defense is server-side (opaque token, hash
  only, scope, immediate revoke, TTL/rotation). Escalation trigger = cloud
  backend + multi-user + untrusted host (≈M2), at which point session+host tokens
  migrate together to a real secret store.
- **Registration / first-user (V1 single-user):**
  - `users` = registered humans only; implicit local-user era ended.
  - `GET /api/me` → `{registration_required, suggested_name}` when no session.
  - `/api/register` is desktop embedded-only (sole V1 profile creator);
    credentialed multi-user uses `/auth/signup` + `/auth/login`. Embedded desktop
    token delivery via loopback-only `/auth/embedded-bootstrap`.
  - `name` immutable post-registration (`PATCH /api/me` rejects the `name` key);
    `display_name` + avatar mutable. `users.name` globally unique vs `agents.name`.
  - Exactly one registered user per DB (`register()` → `already_registered` if any exist).
  - **No admin role / no first-user auto-promotion / no admin CLI / no admin API** in V1.
- **Deferred Adoption: RETIRED.** v21 staging tables (`legacy_*_v21`) dropped in
  v23 after a precondition asserts zero unadopted rows. Migrations v21/v22 are
  **immutable frozen records** — never edit; all fixes go in new monotonic
  migrations. **Do not restore pre-v21 backups to current builds** (they can no
  longer auto-adopt). `app_settings.viewer_user_id` is deprecated and ignored
  from C.5+ for current-viewer routing.

---

## 2. Stage-A — route ACL matrix (audit closure)

The principal model that the ACL audit locked:

- Removed `app_settings.viewer_user_id` as a principal fallback. **Session-bearer
  auth failure = 401, not 403.** `registration_required` only for the bootstrap
  no-viewer state.
- **ACL classes:** *public* (no owner gate) · *direct owner* (user/agent-owned
  row or viewer's own state) · *membership edge* (workspace/conversation
  membership table gates) · *inherited-via-parent* (visibility inherited from
  parent conversation/workspace) · *agent principal* (`(conversation_id, agent_id)`
  pair; internal routes only).
- **Cross-user / cross-namespace access defaults to 404, not 403** — anti-enumeration.
- Representative gates: `GET /api/agents` filters by `created_by_user_id` /
  `canViewAgent`; `/api/workspaces/:id/*` → `canViewWorkspace` / `canMutateWorkspace`
  / `canManageMembers`; `/api/conversations/:id/ref` → `canViewConversation`
  (not workspace-wide); `/api/saved` + message save/delete + `/api/search` scope
  to visible conversations; agent control (start/stop/clear-session) verifies
  agent membership before dispatch.

---

## 3. D4 — deployment form (standalone + daemon runtime)

D4 framing (locked): three sequential gates — **G1** standalone control plane,
**G2** runtime e2e, **G3** multi-host ACL — each independently verifiable. R4
drift deferred to D5 (D4 ships on existing IPC shape).

### 3.1 D4.a / G1 — standalone control plane

- **Deployment:** standalone backend binds a network address; desktop in remote
  mode skips the embedded backend and points at `server_url`; daemon stays
  bundled in the desktop and attaches outbound; agent processes run on the
  user's desktop (daemon-colocated).
- **TLS (system-default only, bypass banned):** accept = `system_ca_verified`
  (chain to system CA + hostname match + not expired). Typed failures
  `host_tls_chain_invalid` / `host_tls_hostname_mismatch` / `host_tls_expired`.
  `http` only for loopback literals (`127.0.0.1`, `::1`); non-loopback http needs
  `SILVERHAND_ALLOW_INSECURE_REMOTE=1` (dev escape, not V1-supported).
  **CI gate:** zero `rejectUnauthorized: false` across the TLS client surface
  (`apps/desktop`, `packages/host`, `packages/backend`) outside test dirs.
  OCSP/CRL = best-effort, not a hard gate.
- **Server connection profile** = single source for all pre/post-auth transports:
  `~/.silverhand/desktop/server-profile.bin` (0600, desktop-main exclusive),
  shape `{version,server_url,created_at,updated_at}`. Covers pre-auth
  `/api/server/info`, signup/login, session validation, event WS, host
  claim-or-create, daemon outbound WSS, daemon-config derivation. **The daemon
  never reads the profile** (only daemon-config). Two-phase update (atomic
  profile write → derive daemon-config + IPC reload); phase-2 failure →
  `partial_apply_pending`, recovery via Retry / desktop restart / daemon restart
  all converge to `fully_applied`. daemon-config gains `profile_version:int`
  fingerprint (never in frame or auth header).
- **Signup route:** mounted unconditionally; handler branches on `signupEnabled`;
  disabled → `403 {code:'signup_disabled'}` (not 404 hide-as-missing).
  `SILVERHAND_DISABLE_SIGNUP=1` is part of the lock-down runbook. Non-loopback
  bind + signup enabled → WARN + `/api/server/info.bind_address_scope`
  (loopback|lan|public). Supported deployment = personal/private only
  (Tailscale/VPN/controlled ingress), **not** public-internet SaaS.
- **G1 typed runtime errors allowed:** `remote_host_unavailable` /
  `no_host_placement` / `host_attach_pending`. **Forbidden:** HTTP 500, hang
  without reply, silent embedded fallback, silent no-op.

### 3.2 D4.b / G2 — remote runtime e2e

- Daemon attaches over WSS (observable `connecting → connected`). Spawn / wake /
  stop are full round-trips: intent → daemon → CLI → `session_init` → backend
  projection → UI. Wake = inbox row → daemon wake → drain → reply.
- **Delivery recovery:** `daemon kill -9` → respawn → re-attach → pending inbox
  rows drain with **no loss / no duplicate**. Backend restart → outbound WS
  reconnect within bounded backoff → no divergence. Event projection + message
  dedupe verified; `runtime_stop`/`runtime_wake` traceable per ack frame.

### 3.3 D4.c / G3 — multi-host ACL negatives

- Two daemons attach simultaneously, distinct `host_id` + `connectionId`.
- **Negatives (security perimeter):** cross-user resource read → 404
  (anti-enumeration); invalid/unknown/revoked `host_token` → 401 (no id leak);
  wrong credential kind → 401; valid token for non-local host → 403; Host A spawn
  into a Host B workspace → 409 `host_mismatch` (preflight, before
  `initWorkspaceDir`); cross-host event isolation bidirectional (drop before
  fanout by `agent.host_id` / workspace ownership / `(cid,aid)` membership).
- **Signup-toggle negatives:** existing user session stays valid after toggle (no
  forced logout); existing `host_token` not consumed/revoked/rotated; after
  `DISABLE_SIGNUP=1` restart, `/auth/signup` → 403 typed, operator login still works.

### 3.4 D4.d — `agent_materialize` intent (wire-side agent creation)

- **Invariants:** I1 additive arm in `OutboundServerCommandKind` reusing the
  existing WS/correlation/auth/timeout machinery; I2 L1 truth on the daemon
  (server sends metadata only — `template_choice` — daemon uses local templates,
  no server fs); I3 explicit `agents.materialization_status ∈
  {pending_materialization, active, failed}` (pending hidden from reads; failed
  hidden unless `?include_failed=1`, creator-scoped); I5 create-path only.
- **Wire:** `AgentMaterializeParams{agent_id, agent_home_workspace_id,
  name, runtime, model?, description?, template_choice='default'|'onboarding'|'minimal'}`
  → `AgentMaterializeResult{ok, agent_dir, agent_home_workspace_path (==agent_dir),
  materialized_at}`.
- **Two-layer idempotency:** HTTP `Idempotency-Key` header (1..64,
  `[A-Za-z0-9_-]`, **required**), creator-scoped unique index
  `(created_by_user_id, idempotency_key)`; wire `command_id` server-allocated per
  send, never reused. Dispatch on same key + matching body: active → 200 echo;
  pending → 409 `materialization_in_progress`; failed → 409
  `materialization_previously_failed` (opt in `?retry=true`); no row → new
  attempt. Body-metadata mismatch on a reused key → 400
  `idempotency_metadata_mismatch` **before** dispatch.
- **Server state machine:** L0 ACL + key + metadata-mismatch check → L1 online
  check `connectedConnectionId(hostId)` (**offline → 503 `host_attach_pending`,
  NO row reserved**) + name uniqueness + reserve `pending_materialization` row →
  L2 dispatch → L3a ack-ok atomic tx (flip `active` + insert `agent_home`
  workspace + DM channel + onboarding message + memberships) / L3b ack-err flip
  `failed` typed → L4 post-commit onboarding deliver + DM auto-start (both modes,
  best-effort). Boot reconciler marks `pending` rows >60s old `failed` with
  `backend_crash_during_materialize`. No background sweep beyond boot.
- **Daemon-side idempotency:** dir absent → seed; dir empty → seed (crash
  mid-tx); dir + matching sentinel → idempotent ok; dir + foreign content (no
  sentinel) or corrupt sentinel → `agent_dir_collision` (fail-closed). `DELETE`
  on a failed row → 204 row-only (no daemon RPC); primary recovery is
  `?retry=true` (hits the daemon sentinel-match), last resort manual `rm -rf`.

### 3.5 D4.e — daemon is sole host-local path authority

The decisive cut: **`packages/backend/src` performs zero agent-host path
resolution and emits zero host-local path** (in any outbound frame or
agent-facing DTO). Backend speaks semantic ids; the daemon resolves paths.

- **Daemon-local workspace registry:** daemon-owned JSON file (0600, atomic
  write — not SQLite, no native dep), entries scoped to `(server_origin,
  host_id)` with a load-time foreign-registry guard. Agent-home (DM) path derives
  from `homedir()+agent_id` (no registry entry); regular workspaces use a
  daemon-managed deterministic path (never raw ids as path components). One-time
  legacy adoption imports pre-D4.e `workspace_path` into the registry — the only
  seam where the daemon accepts a path from the backend.
- **Five additive intents** (on the D5.a envelope): `workspace_provision`
  (binds registry entry on workspace create), `agent_l2_seed` (member-add to a
  non-home workspace), `agent_files_purge{scope:'all'|'l2'}` (agent delete,
  fail-fast), `agent_workspace_read` (`GET /api/agents/:id/workspace`; standalone
  disable removed), `agent_workspace_index` (route-time resolver stamping
  `list_workspaces.agent_dir`).
- **`agent_dir` stays** in the agent-facing DTO (the agent runs on the owning
  host, so the path is legitimately useful) but is resolved **at route time** via
  `agent_workspace_index` — spawn-time injection was rejected because membership
  is dynamic.
- **Purge commit boundary (fail-fast):** backend computes impact → dispatches
  `agent_files_purge` → **DB rows are NOT deleted until purge acks success**;
  daemon offline → 503 `host_attach_pending`, row + retry anchor preserved.
- **`workspace_path` column is transitional** — never read by path resolution /
  `runtime_start` / agent resolver; still used as `requested_path` forwarded to
  `workspace_provision` and refreshed from the daemon's `bound_workspace_path`
  ack; display/cache snapshot reads tolerated. Full removal is a follow-up, not D4.e.
- **D4.e-6 (M1-closure blocker):** `runtime_start` carries semantic refs only
  (agent_id, workspace_id, agent_home list — no paths). Daemon
  `resolveRuntimeStartPaths` maps refs → paths via registry/homedir, failing
  closed with `workspace_not_provisioned` / `registry_unavailable`. Backend does
  a bounded lazy backfill (`WorkspaceRegistryBackfiller.ensure`) before dispatch;
  `partial`/`failed` → no dispatch + rollback claimed deliveries. The backend
  builder is semantic-only (no `node:path`/`node:fs`, no `workspace_path`/`home_dir`).
- **Acceptance:** A1 backend zero path resolution (dependency-guard tripwire);
  A2 member-add / workspace-create / agent-delete / workspace-read /
  `list_workspaces` + `runtime_start` all route through the daemon; A3 shared
  adapter contract test per intent (both modes); A4 parity e2e through a real
  daemon; A5 seeded content byte-identical to pre-D4.e; A7 = M1-closure gate.

---

## 4. D5.a — outbound frame adapter unification (R4 paydown)

- Both deployments dispatch the **same** outbound frame schemas
  (`OutboundServerToDaemonCommandFrame`,
  `OutboundDaemonToServerCommandResponseFrame`,
  `OutboundDaemonToServerEventFrame`) through one `OutboundFrameAdapter`. Standalone =
  WSS via `HostWsServerController`; embedded = local Unix socket
  (`daemon-outbound.sock`, 0600) via `EmbeddedUnixOutboundFrameAdapter`.
- **Invariants:** I1 same envelope for `runtime_*` + `agent_materialize` (no
  embedded-only `{intent,params}` carrying these semantics); I3 backend
  `packages/backend/src/**` imports **zero** `HostClient` (acceptance:
  `rg "import .*HostClient" packages/backend/src` → no matches); I4 desktop
  `host_outbound_attach/detach/reload` stay isolated local-control IPC, forbidden
  in backend runtime/materialize code; I6 no durable transport queue —
  delivery-backed retry stays in `RuntimeDeliveryCoordinator` + DB inbox.
- D5.a only swaps transport beneath the existing D4.d route; semantics unchanged.
  Acceptance: `TODO(D5,R4)` anchor count = 0; the only remaining `HostClient`
  call sites live in `apps/desktop/src/main/**` (desktop-local supervisor/control).

---

## 5. Daemon PR-2 — execution-plane split (CM cutover)

`conversation-manager.ts` was split (not whole-file-moved):

- **Execution-plane half → daemon** as a `Supervisor`: process spawn, streams,
  driver parser, init watchdog, lifecycle lock.
- **Control-plane half stays in backend:** inbox state machine, activity-log
  JSONL writer, scheduler, DB.
- **7 intents:** `runtime_start`, `runtime_stop`, `runtime_wake` (batch-native),
  `runtime_status`, `runtime_clear_session`, `runtime_stop_all`,
  `runtime_close_activity_log`. **Not shipped:** `runtime_inject_env`,
  bearer-token auth (filesystem perms only), remote-host support, any
  inbox/markDelivered timing change.
- **Wire contract highlights:**
  - `runtime_start{conversation_id, agent_id, options, startup_delivery?}` →
    `{pid, started_at, startup_delivery_accepted?}`; idempotent on (conv, agent);
    daemon never touches the inbox.
  - `runtime_wake{conversation_id, agent_id, delivery_ids[], payload}` →
    `{delivered:true,...}` | `{delivered:false, reason:'not_running'|
    'not_initialized'|'startup_pending'|'draining'|'driver_refused'}`. Batch,
    all-or-nothing; backend does `ensureDelivery()` before + `markDelivered()`
    after `delivered:true`.
  - `runtime_clear_session` hard-stops the child + drops the daemon
    `cli_session_id` cache; the DB half stays in backend.
- **Events:** non-droppable (`runtime_state`, `runtime_exit`,
  `runtime_ready_for_drain`, `runtime_startup_delivery_consumed/failed`,
  `runtime_output_dropped/paused/resumed`, `shutting_down`); droppable only
  `runtime_output` (raw stdout/stderr, per-(conv,agent) 4 MiB unflushed cap →
  drop + `runtime_output_dropped` summary).
- **Startup/live exclusivity:** backend must not `runtime_wake` while
  `startup_delivery` is in flight; daemon emits no `ready_for_drain` in
  startup-pending; on `startup_delivery_failed` the daemon emits no ready and the
  backend reschedules (no daemon auto-retry).
- **Logging contract (locked):** daemon JSONL records **structured fields only** —
  never stdin bytes, stdout/stderr chunks, inbox content, system prompts, env
  values, or any content-suggesting field (`payload`/`chunk`/`body`/`text`/`prompt`).
- **Cutover is atomic** (no coexistence); `hostClient` becomes required in
  `startBackend`; the full backend test suite runs end-to-end through the new IPC.

> **Deferred-init-watchdog note (verified in code 2026-06-01):** the empty-inbox
> deferred init watchdog *is* implemented and now lives in the daemon-host
> supervisor (`packages/host/src/daemon/supervisor/handle.ts` `initWatchdogArmed`
> gate; `drivers/index.ts` marks an empty-inbox spawn active with a real pid
> while `initObserved=false` and arms the watchdog only when a wake actually
> writes). CLAUDE.md fact #2 is accurate. The 2026-05-08 incident docs remain as
> the empirical evidence for *why* claude withholds `system.init` on empty stdin.

---

## 6. Smaller decisions absorbed from scratch notes

- **`thread create` / `channel create` initial prompt = stdin-only.** Body comes
  from stdin (heredoc/pipe), same UTF-8 / TTY / empty-input rules as
  `message send`. `--initial-prompt` is removed and rejected with `flag_removed`
  + a heredoc/pipe hint. `--context-summary <text>` stays an inline flag. No
  `@-` / `@<path>` / bare-`-` sentinels; one stdin consumer per command. Backend
  RPC still receives `initial_prompt` (no backend semantic change).
- **Inbox / agent-experience philosophy (aspirational, not all shipped):** agents
  *pull* signals from an inbox rather than being *pushed* into context — each
  pulled signal spends context budget, so the agent chooses relevance. A future
  *held-draft* interface would let an agent compose with a freshness mark and, on
  submit, send immediately if the room is unchanged or hold + emit a
  `context_changed` summary if it changed (then revise / send-as-is / stay-silent
  / send-anyway). Design principles: *perception empathy* (give the agent what it
  actually needs at action time) and *action explicitness* (surface choices via
  UX the agent can't self-generate).

### Open observations (no durable decision — kept as breadcrumbs)

- **Codex compaction duplicate-send (2026-05-25, single occurrence):** after
  `context_compacted`, codex replayed an already-executed `message send`
  side-effect on resume within the same turn → duplicate reply. Not a bug in user
  re-entry / inbox ack-replay / re-drain. If it recurs, consider a short-TTL
  idempotency fingerprint `(source_conv, agent, target_conv, content_hash,
  attachment_ids, runtime_run_id)` or a turn-scoped idempotency key into the runtime.
- **CLI error-pattern learnings (2026-05-11→14, 1473 calls / 34 failures, all
  validation):** recurring agent friction was flag churn (`message send`
  `--content`/`--text`; `message search` `--query`/positional; `task list
  --status pending/open/all/active`; `task create` flag names). Most of these
  were since addressed (status macros `active`/`all`/`pending`, `message search
  --q/--query`, removed-flag hints). Remaining ideas: finer error codes
  (`unknown_flag` / `flag_removed` / `enum_invalid` / `required_missing` /
  `positional_unsupported`) and an FTS audit on `message search` p95 latency.

---

## 7. Non-goals explicitly deferred (V1)

Self-signed / SPKI-pin / custom TLS verifier · headless daemon distribution ·
admin role / dashboard / API · multi-user workspace sharing · OAuth providers ·
public-internet SaaS exposure · removing `@silverhand/server` from remote desktop
builds · live config reload (env + restart only) · backend-terminated TLS
(reverse proxy required) · OCSP/CRL as a hard gate · dropping the transitional
`workspace_path` column.

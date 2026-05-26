# Remote backend roadmap — V1 prep

> **Status**: roadmap, 2026-05-25. Owners: @Alice (architecture), @Cindy
> (review). Reverse-engineered from the locked target topology back to the
> work needed today.
>
> **What this document is**: the top-level plan for "what to build now so
> that future remote-server + multi-user + multi-host evolution does not
> require a rewrite." It answers *order, boundaries, acceptance* — not
> the per-table or per-route detail.
>
> **What this document is NOT**: target architecture (see
> `remote-server-target-architecture.md`) or implementation detail (see
> per-stage spec links below). The roadmap deliberately links out rather
> than restating either.
>
> **Reading order**:
> 1. `remote-server-target-architecture.md` — the destination (read for
>    topology + phase plan only; its auth §5 is **superseded** by
>    `auth-and-host-model.md` — do not implement from it)
> 2. This document — the path
> 3. Per-stage detail spec (linked below)

---

## 1. Target (recap)

The locked end state, from `remote-server-target-architecture.md`:

- **Server** = control / state plane only. State, blob, auth, routing,
  protocol. Does NOT run agent or daemon processes.
- **Desktop** = UI client + local daemon host + agent processes (dual
  identity, dual token).
- **Sandbox (future)** = headless daemon host only, reusing the same
  daemon-host protocol as desktop.
- **Daemon and agent process / fs / runtime are host-local** —
  co-located on the same Host. The daemon holds `host_token` and
  represents the execution plane for that Host.
- **Agent CLI is host-local but server-directed**: agent processes use
  `silverhand` CLI calls that go to the server URL outbound with their
  own conversation-scoped credentials. Agent CLI does NOT hold
  `host_token` and is NOT a substitute for the daemon — it is a
  consumer of server APIs, like the desktop UI is. This is the third
  layer of the token taxonomy referenced in `auth-and-host-model.md`
  §5 (user / host / agent-conversation-scoped).

The "remote" in "remote backend" means *the control plane runs elsewhere
than the user's desktop* — it does NOT mean *agents run in the cloud*.
Filling in a server URL only re-targets the control plane; agent
execution stays on whichever Host owns the daemon.

See target doc for the topology diagram, the five orthogonal cuts that
make embedded ≡ remote possible, and the dual-token model.

---

## 2. Non-goals now (deferred to follow-up phase)

To keep the V1 prep scope honest, the following are explicitly **not**
part of Stage A–D and MUST NOT be conflated with them:

- **Headless / remote daemon binary distribution**. Schema arm exists
  (`hosts.kind = local|remote`), but no V1 surface ships. V1's daemon
  outbound (Stage D2) is **desktop-local-host only** — the daemon binary
  stays bundled with the desktop app, just learns to connect outbound to
  a remote server.
- **Remote-host provisioning UI** ("Add remote host" page, bootstrap
  token display). Out of V1 together with the headless binary.
- **Sandbox capability layer** (chroot / seccomp / namespace mounts /
  ephemeral fs / network egress policy). Orthogonal to Host `kind`; see
  `auth-and-host-model.md` Appendix A.5.
- **Multi-user invite / workspace sharing** (V1.5).
- **OAuth providers** (GitHub Device Flow, Google OIDC) — V2.
- **Official server image / image TLS termination**. V1 route 1 ships a
  Node server package first; a maintained server image is deferred until the
  server has passed local/remote soak. Deployers use a reverse proxy (Caddy /
  Tailscale / nginx) for TLS.
- **Password recovery via email** (V1 uses `silverhand-server admin
  reset-password` recovery utility).
- **Backup/restore tooling**.

Each item has a parking lot in `auth-and-host-model.md` Appendix A or
`remote-server-target-architecture.md`; the rule is *not yet*, not
*never*.

**Note on daemon outbound scope**: an earlier version of this roadmap
deferred *the entire daemon-outbound protocol* to follow-up phase. shiki
selected the larger Stage D scope (option 2) so that V1 closes the
"fill in a server URL → app actually works end-to-end" loop. The
deferred items above are the **remaining** boundary: V1 still does NOT
ship distribution channels (headless binary) or new Host kinds
(remote-host UI) or capability layers (sandbox). It only teaches
desktop's bundled daemon to speak outbound to a remote server.

---

## 3. Stages

Four work blocks. Acceptance criteria are concrete and verifiable —
"runs single-user / single-host / single-process correctly under the
full multi-user / multi-host / multi-process contract" is the engineering
definition of "no rework later."

### Stage A — User identity + ACL / resource ownership

**Goal**: every request resolves to a `viewer_user_id`; every resource
query and mutation is scoped by that subject. Single-user today, but the
codepath is identical to the multi-user case.

**In scope**:

- `users` table augmented with `email` (unique-when-set); profile fields
  (`name`, `display_name`, avatar, uniqueness) stay authoritative.
- New `user_password_credentials(user_id PK, password_hash, password_hash_params, password_updated_at)` table — Argon2id, isolated from profile.
- New `auth_sessions(id, user_id, token_hash, ...)`.
- `POST /auth/signup`, `POST /auth/login`, `POST /auth/logout`,
  `GET /api/server/info` (exposes `signup_enabled`).
- `SILVERHAND_DISABLE_SIGNUP=1` env, loaded once at startup, frozen.
- Auth middleware that resolves `viewer_user_id` from
  `Authorization: Bearer <user_token>` and rejects (401) when absent.
- Resource ACL applied per `auth-and-host-model.md §2`: three classes
  (direct owner column / membership edge / inherited via parent).
  Workspaces and conversations go through existing `workspace_users` /
  `conversation_users` — no invented `workspaces.user_id`.
- Deprecate `app_settings.viewer_user_id` as a fallback; routes MUST
  stop reading it.
- Error uniformity for credential failures (constant-time compare +
  401 `auth_failed`).
- Desktop UI: Setup Wizard (signup / login forms), Logout button,
  password storage via `safeStorage.encryptString` → 0600 file.

**Out of scope** (push back if asked):

- OAuth providers (V2).
- Invite / sharing flows.
- Password recovery via email.
- `users.is_admin` / RBAC roles.
- Touching profile-only `users` rows (legacy single-user fallback)
  beyond adding nullable `email`.

**PR breakdown (suggested)**:

1. **A.1 Schema + Argon2id helpers**: new tables + migrations + Argon2id
   wrapper + `password_hash_params` benchmark.
2. **A.2 Auth routes + middleware**: `/auth/signup`, `/auth/login`,
   `/auth/logout`, `GET /api/server/info`, viewer_user_id resolver,
   constant-time compare.
3. **A.3 ACL applied across existing routes**: every backend route
   audited; scoped by viewer; tests pin the three ACL classes per
   resource. `app_settings.viewer_user_id` fallback removed.
4. **A.4 Desktop Setup Wizard + safeStorage session**: renderer Setup
   Wizard, main-process auth client, encrypted blob persistence,
   logout flow.

**Acceptance criteria**:

- Every backend route handler MUST resolve `viewer_user_id` before any
  DB read; missing → 401. Verified by an audit test that walks the
  router and fails on routes without an explicit viewer scope or an
  explicit `@public` opt-out marker.
- No call site reads `app_settings.viewer_user_id`.
- `SELECT` on any resource by an unrelated user returns empty / 404
  (depending on resource), never the row. Integration test seeds two
  users and asserts isolation across every ACL class.
- Credential failure path goes through a constant control flow: when
  the `users` row is absent the implementation MUST hash a dummy
  password against the same Argon2id parameters before returning, so
  there is no early-exit branch on the unknown-email path. Verified by
  a code-level audit (the route's failure branch has no conditional
  return before the hash call) and by a unit test that mocks the hash
  function and asserts it is invoked on both axes. Wall-clock timing
  benchmarks (within X% across enumeration axes) are a manual security
  check, NOT a CI gate — they are too flaky under shared-runner load.
- `SILVERHAND_DISABLE_SIGNUP=1` → `POST /auth/signup` returns 404
  identical to a missing route; startup log prints the resolved value.
- Desktop: fresh install → Setup Wizard appears; signup → login →
  logout cycle works; encrypted session blob survives restart;
  unencrypted token never written to disk or `localStorage`.

**Detail spec**: `auth-and-host-model.md` §2–§4, §8.1–§8.3, §10.

---

### Stage B — Hosts model + credential binding

**Goal**: `Host` becomes a first-class concept in schema and API:
identity, credential issuance/storage/revoke/rotate, a generic token
verifier, and placement routing. Every runtime intent route carries
`host_id`, even with one local host. Phase 4 (the daemon-outbound
protocol that brings a remote host online) becomes a *new transport
landing on existing identity*, not a rewrite of identity itself.

**Critical scope note**: Stage B does NOT introduce any new
daemon-initiated authenticated channel. The current pre-outbound
architecture has backend / Electron main dialing the daemon's Unix
socket via `HostClient`; the daemon does not currently make outbound
HTTP/WS calls to the backend. Stage B keeps that transport unchanged.
`host_token`'s Stage B contract is:

- issued at `claim-or-create` time, hashed at rest in `host_credentials`
- written to the daemon's config file (0600) by Electron main
- validated by a generic server-side `verifyHostToken()` whenever
  server-side code performs an action whose authorization needs the
  host's identity (placement routing, revoke enforcement, future
  daemon-initiated calls)
- never IPC'd to the renderer, never carried by the daemon over a
  channel that does not exist yet

The daemon physically *presenting* `host_token` over an authenticated
outbound channel to the server is **follow-up phase** (daemon outbound
protocol), not Stage B.

**In scope**:

- `hosts` table upgraded: `user_id` FK confirmed, `installation_id`,
  `revoked_at`, `last_seen_at`, `kind` enum stays `local|remote`.
- New `host_credentials(id, host_id, token_hash, kind=long_lived|bootstrap, expires_at, consumed_at, revoked_at)`.
- Routes (local-host scope only): `POST /api/hosts/claim-or-create`,
  `POST /api/hosts/{id}/revoke`, `POST /api/hosts/{id}/rotate-token`.
- Generic `verifyHostToken(token)` server-side primitive: looks up
  `host_credentials` by `token_hash`, denies on row missing, denies on
  `host_credentials.revoked_at != NULL`, denies on
  `host.revoked_at != NULL`, returns `(host_id, user_id)` on success.
  Unit-test surface, no caller required in Stage B.
- Backend `RuntimeHostRegistry` abstraction over today's single
  `hostClient`. Cache keys gain a `host_id` dimension; run-state cache
  is per-host generation. Registry rejects placement on a revoked host
  (fail-closed).
- `conversation_agents.runtime_host_id` (or equivalent placement column)
  on the conversation/agent join row.
- Every runtime intent route resolves a `host_id` via the registry —
  even when there is only one entry. No "if registry has one host, use
  it" shortcut.
- `installation_id` writer on desktop: `~/.silverhand/installation_id`
  auto-created on first run (uuid v4).
- Soft-delete model for both `hosts.revoked_at` and
  `host_credentials.revoked_at`; `verifyHostToken()` denies on either
  set or row missing. **No grace window on revoke**; rotation has 60s
  grace.
- Daemon-config writer in Electron main: after `claim-or-create`
  succeeds, main writes `{host_id, host_token, server_url}` to
  `~/.silverhand/daemon-config.json` (0600, owner-only) for daemon boot
  / follow-up outbound phases. No transport change.

**Out of scope** (push back if asked):

- Remote-host create (`POST /api/hosts` with `kind=remote`),
  `POST /api/hosts/{id}/exchange`, "Add remote host" desktop UI,
  headless daemon binary distribution — all deferred to follow-up
  phase together with their threat model.
- **Daemon outbound host protocol** — the long-lived WS / reconnect /
  backpressure / server-initiated control / "online" presence track is
  follow-up phase. Stage B does NOT introduce a daemon-initiated
  authenticated channel; the existing `HostClient`-dials-unix-socket
  transport is unchanged.
- **Daemon presenting `host_token` to the server in any new request
  path**. That request path does not exist in V1.
- Auto-rotation of `host_token` on every claim. Rotation is explicit;
  `claim-or-create` reuses the desktop's existing local daemon config
  when `current_host_id` matches **and** the server still has an active
  long-lived credential for that host. Missing/stale/revoked credentials
  force a replacement token, but that is recovery from local/server state
  drift, not rotation.

**PR breakdown (suggested)**:

1. **B.1 Schema + RuntimeHostRegistry skeleton + verifyHostToken**:
   tables, migrations, registry interface (single-entry implementation),
   `runtime_host_id` placement column, generic `verifyHostToken()`
   primitive with unit-test coverage of valid / rotated / revoked /
   missing cases.
2. **B.2 Local-host claim + token persistence**: `claim-or-create`
   route + Electron main wires it after login; main writes
   `~/.silverhand/daemon-config.json` 0600 for daemon boot / follow-up
   outbound phases (existing transport — no protocol change). `host_token` is now on
   disk in the daemon's config; how it later gets presented to the
   server is follow-up phase.
3. **B.3 Runtime intent routing through registry**: every existing
   runtime intent route refactored to resolve `host_id` through the
   registry; cache keys updated; per-host run-state generation;
   registry refuses placement on revoked host (fail-closed).
4. **B.4 Revoke + rotate + Hosts UI**: revoke/rotate routes,
   `verifyHostToken()` honours `revoked_at` on both rows, desktop
   Hosts page (list / revoke action).

**Acceptance criteria**:

- `claim-or-create` issues `host_id` + `host_token` when main lacks a
  reusable local daemon config for that host, or when the server no
  longer has an active long-lived credential for the supplied
  `current_host_id` → server stores `token_hash` in `host_credentials` → main writes
  `~/.silverhand/daemon-config.json` 0600 with the cleartext token.
  Verified by smoke test (no transport / channel involvement).
- `verifyHostToken()` unit tests cover the full matrix: valid token →
  returns `(host_id, user_id)`; rotated old token within 60s grace →
  returns ok; rotated old token after 60s → denied; revoked credential
  → denied; revoked host → denied; missing token → denied. Test
  surface is the primitive itself; no caller required in Stage B.
- Every runtime intent route in the codebase carries `host_id` through
  registry lookup. Verified by an audit test on the runtime router.
- `RuntimeHostRegistry.placeAgent(host_id, ...)` refuses to place on a
  `revoked_at != NULL` host. Verified by integration test.
- Revoke: `verifyHostToken()` denies the revoked token within one DB
  roundtrip after revoke commits; existing agents on that host are
  NOT cascade-deleted.
- Rotate: `verifyHostToken()` accepts both old and new tokens within
  the 60s grace window; only new after grace; daemon-config-file
  refresh path lands the new token (file write — no new transport).
- Revoked host + new `claim-or-create` attempt → 409 `host_revoked`
  fail-closed, no silent revival.
- `host_token` never appears in renderer process memory or IPC traffic
  (audited via leak-guard test that greps IPC payload schemas).
- **Out-of-scope verification**: Stage B does NOT introduce a new
  daemon-initiated authenticated request path. The existing
  `HostClient`-dials-unix-socket transport is unchanged. Acceptance
  tests do NOT exercise "daemon making an authenticated outbound
  call" — that surface lands in follow-up phase.

**Detail spec**: `auth-and-host-model.md` §1, §5, §6, §8.2–§8.3, §10.

---

### Stage C — Desktop ↔ Server protocol purity

**Goal**: embedded mode is byte-for-byte equivalent to remote mode at
the protocol layer. No "if embedded, take a shortcut" branch survives.
This is the prerequisite for Stage D — if main-process code still reads
backend objects directly, splitting the server process will leak
in-process shortcuts on every audit.

**In scope**:

- Audit `apps/desktop/src/main/index.ts` for direct backend object reads
  that bypass HTTP. Convert each to authenticated HTTP calls (using
  the `user_token` Stage A landed).
- Audit `apps/desktop/src/preload/index.ts` for IPC routes that pass
  server-side state or absolute paths to the renderer. Tag each route
  as one of:
  - **"OS-IPC"** (clipboard, dialog, system notification): allowed.
  - **"data"** (anything backend would expose): MUST be HTTP from
    renderer's perspective, even if the HTTP call hops through main.
  - **"local-host-only UX"** (e.g.
    `showItemInFolder(workspace_path)`): allowed behind a `host.kind ===
    'local'` runtime check, NOT removed.
- Convert local-host-only UX to use host provenance from
  `BackendInfo.local_host_id` + owner-filtered `/api/hosts`; do not
  gate filesystem affordances on backend `mode` because
  remote-backend + local-Host remains a valid V1 topology.
- Audit CLI (`packages/cli`) `SILVERHAND_*` env injection: confirm
  every CLI invocation routes through `SILVERHAND_SERVER_URL`, never
  through an in-process shortcut.
- `/auth/embedded-bootstrap` route + flow: server in embedded mode
  writes a one-shot `bootstrap_session_token` to
  `~/.silverhand/embedded-bootstrap` (0600) before HTTP listen; desktop
  reads file → POSTs `/auth/embedded-bootstrap { token }` over
  loopback. Four constraints (loopback only + one-shot +
  boot-session-scoped + only when `mode=embedded`) MUST all hold;
  failing any returns 404. This route is independent of
  `SILVERHAND_DISABLE_SIGNUP`.
- Renderer never sees `user_token` plaintext for embedded mode either;
  bootstrap returns a normal session that's persisted via
  `safeStorage` just like the remote signup path. Event WS uses that
  same session subject via an Electron-main-owned `HttpOnly` cookie
  scoped to `/api/ws/events`; renderer never receives a bearer field in
  `BackendInfo`.

**Out of scope** (push back if asked):

- Removing the local-host-only UX (`showItemInFolder` etc.). They are
  legitimate features, just gated by `host.kind`.
- The server-process split itself (that's Stage D1).
- The daemon's outbound protocol upgrade (that's Stage D2, not
  Stage C).
- The orchestration boundary decision for remote-local (that's
  Stage D2.0, not Stage C).

**PR breakdown (suggested)**:

1. **C.1 Audit catalogue**: a single doc/test artifact that enumerates
   every main-process backend-object read and every IPC route, with
   the disposition tag (OS-IPC / data / local-host-only). No code
   change; this is the agreement layer.
2. **C.2 Data-IPC conversions**: each "data"-tagged IPC converted to
   fetch-shaped HTTP semantics from the renderer's perspective, even
   when main proxies the call to keep session/host credentials out of
   renderer memory.
3. **C.3 Host-provenance propagation**: `local_host_id` is consumed by
   renderer alongside `/api/hosts`; local-host-only UX is gated by
   `host.id === local_host_id && host.kind === 'local'`, not backend
   mode.
4. **C.4 Embedded bootstrap**: server-side route + the four
   constraints + desktop reads bootstrap file and POSTs over loopback;
   embedded user flows through the same `safeStorage` session path.

**Acceptance criteria**:

- Audit catalogue is complete and reviewed; every entry has a
  disposition. No "TODO" entries remain at Stage C's end.
- Renderer-source-tree audit shows zero direct calls into backend
  modules; all data access goes via `fetch` (or via main proxying
  with `fetch`-shaped semantics).
- Embedded mode auto-bootstraps a session on first launch with no
  user input; subsequent launches reuse the saved session.
- `/auth/embedded-bootstrap` rejects (404) when invoked over
  non-loopback, after the bootstrap file is consumed, after server
  restart, or when `mode != 'embedded'`. Verified per constraint.
- A diff of HTTP traffic between embedded mode and remote mode shows
  no embedded-only routes other than `/auth/embedded-bootstrap`. The
  point is *protocol parity*; bootstrap is the one allowed delta and
  its surface is fenced by the four constraints.

**Detail spec**: `auth-and-host-model.md` §7.5 (embedded), §10 item 13;
`remote-server-target-architecture.md` §3 (the five orthogonal cuts).

---

### Stage D — Server deployable runtime + daemon outbound (desktop-local host)

**Goal**: backend becomes a deployable artifact, AND desktop's bundled
daemon learns to speak outbound to a remote server. After Stage D,
"fill in a server URL → the app actually works end-to-end" is closed
for the desktop-local host case (agent still runs on the user's
desktop, but control plane runs remotely).

This stage is intentionally larger than the original "server split
only" definition. shiki selected the wider scope (round 4 product call)
because the V1 prep goal is "future remote + multi-user 不返工 **and**
现在 fill URL 就能用". The cost is ~4-5 weeks total and a higher
regression surface; the mitigation is **strict milestone separation**:
D1 ships and soaks before D2.0 starts; D2.0 signs off before D2;
D2 ships and soaks before D3 integrates; D4 is the e2e acceptance
milestone. Do NOT merge daemon
outbound changes into D1 PRs or vice versa.

**Critical scope note** (carried from Stage B): the host-identity
model from Stage B still does NOT presume a daemon-initiated outbound
channel. Stage D2 is where that channel is actually introduced and
where `host_token` is finally presented over a real outbound transport.
This means Stage B's `verifyHostToken()` contract is unchanged — Stage
D2 wires the existing primitive into a new caller, it does not
redefine the primitive.

---

#### D1 — Server deployable runtime (control plane split)

**In scope**:

- New `packages/server` binary that wraps `startBackend(...)`. Single
  entry point used by both `apps/desktop` (embedded) and the standalone
  deployment.
- Env-driven config: `SILVERHAND_LISTEN`, `SILVERHAND_DATA_DIR`,
  `SILVERHAND_DISABLE_SIGNUP`, `SILVERHAND_LOG_LEVEL`. Replace
  constructor-argument config; document the full env contract in
  `docs/server-env-config.md` (to be written alongside this stage).
- Node server deployment/runbook for systemd, pm2, or bare Node. Official
  Docker image is deferred to an independent post-soak stage.
- Persistent state layout per `auth-and-host-model.md §7.1`:
  `/var/lib/silverhand/silverhand.db`, `blobs/`, `workspaces/`.
- Admin recovery subcommand (NOT product flow): `admin reset-password`
  first. It acquires the same DB connection lock the running server uses
  (single-process writes invariant from `CLAUDE.md`), writes an audit log
  entry, and revokes the target user's active sessions. List/revoke-style
  commands are deferred until their auth and audit surface is intentionally
  scoped.
- Readiness (`GET /readyz`) for process supervisors; existing `/api/health`
  remains process liveness only.
- Migration runner: idempotent on startup, fails loud on inconsistent
  state.
- Embedded mode now imports the server entry point exactly the same
  way standalone deployments do — no special embedded code path beyond
  the listen address and `/auth/embedded-bootstrap` enablement.

**Out of scope for D1**: anything touching daemon transport. D1 ships
remote control-plane only; daemon transport is D2.

**PR breakdown**:

- **D1.a** `packages/server` entrypoint + env config; embedded mode
  imports it.
- **D1.b** readiness + data layout docs + Node deployment runbook.
- **D1.c** Admin recovery subcommands (`reset-password` first).
- **D1.d** Migration runner hardening + idempotent startup + version
  check.

**Acceptance criteria for D1**:

- A built Node server process starts successfully and is reachable over the
  bound port.
- Desktop in "remote" mode (server URL in Settings) successfully signs
  up, logs in, lists/creates workspaces, sends a message, receives
  server-side state updates — i.e. **the full control-plane surface
  works against a remote server**. Agent execution NOT yet validated
  in remote mode (that's D4).
- Embedded mode imports the same entry point with no code-path
  divergence beyond config and `/auth/embedded-bootstrap` enablement.
- `silverhand-server admin reset-password --email <x>` works against the
  configured data dir; revokes all sessions for that user.
- Readiness returns 200 once migrations are applied, the DB is writable, and
  the listen socket is open; liveness stays process-only.
- Embedded mode startup time within 10% of the previous in-process
  startup.

**Soak requirement**: D1 ships and runs in production-like usage
(embedded + at least one remote-mode deployment) before D2.0 starts.
Official server image work is intentionally deferred until this soak passes.
The soak surface is large; we do not want D1 control-plane regressions
masked under later milestones' churn.

---

#### D2.0 — Orchestration boundary for desktop-local remote (design pass)

**Goal**: before any D2 transport code lands, decide and document
**which `DaemonAgentRuntimeHost` responsibilities stay server-owned vs
move to daemon-host** for the `kind=local` remote case. This is not
optional architecture cleanup — once remote server and desktop daemon
sit on different machines, the current backend behaviours that
materialize host-local fs state (e.g. `packages/backend/src/spawn-prep.ts`
preparing spawn dirs, system-prompt-file paths, workspace fs paths,
env injection for the agent CLI) execute inside the server Docker
container, where the agent process on the user's desktop cannot read
them. D2 cannot just be "wire WS transport and reuse HostClient
surface" — that surface assumed co-location.

This was previously parked in §5 Follow-up as "orchestration boundary
decision". Round 4 review (Cindy) correctly pointed out that with
Stage D scoped to close the remote-local loop, the V1-minimum boundary
must be locked **before** D2 transport implementation, not after the
follow-up phase.

**In scope**:

- Catalogue of `DaemonAgentRuntimeHost` responsibilities currently on
  the backend side. Items known to require a decision:
  - `spawn-prep.ts`-style spawn-files materialization (system prompt
    file, memory file injection, working dir setup)
  - env-var injection for agent CLI (`SILVERHAND_*`)
  - workspace fs path resolution (currently host-local absolute paths)
  - blob path resolution
  - inbox-drain stdin formatting
  - run-state cache + snippet accumulation
  - SSE event fan-out
  - L1/L2 system-prompt assembly + 16KB cap reads
- For each item, V1 decision: **server-owned** (data crosses the
  transport on demand), **daemon-host-owned** (daemon does the work
  locally given metadata), or **both** (server prepares, daemon
  applies, contract defines the handoff).
- V1 guiding principle (proposal — to be locked in this milestone):
  any work that requires **direct host fs access** (writing spawn
  files, reading workspace fs, resolving blob paths to local files)
  moves to daemon-host. Server stays authoritative on **data** (prompt
  context content, env values, inbox payload) and ships it over the
  transport; daemon owns **fs materialization** locally.
- D1.a's shared `standalone-server` host row is V1 control-plane-only;
  D2 must define per-user host claim/ownership before remote daemon
  placement can rely on `host.user_id`.
- Output: `docs/orchestration-boundary-v1.md` design doc listing each
  item with its V1 decision and rationale.
- Identify what new WS frame shapes D2 needs to support the boundary
  (e.g. spawn frame carries prompt-content + env-map; does NOT carry
  spawn-dir absolute path).

**Out of scope for D2.0**:

- Implementation of any boundary change. D2.0 produces the design
  doc; D2 implements it.
- Headless / sandbox boundary generalisation — still follow-up.

**Acceptance criteria for D2.0**:

- `docs/orchestration-boundary-v1.md` committed with one row per
  responsibility above + the V1 decision + rationale.
- WS frame schema (`docs/daemon-outbound-protocol.md`) draft cites
  this boundary doc for frame payload shapes.
- Alice + Cindy review sign-off before D2.a implementation PR opens.

---

#### D2 — Daemon outbound transport (desktop-local host only)

**In scope**:

- Daemon-initiated WS connection from desktop's bundled daemon to the
  server URL.
- `host_token` presented on connection upgrade (`Authorization: Bearer`).
  Server validates via Stage B's `verifyHostToken()` — no new
  validation primitive.
- WS frame vocabulary, split into two directions (frame shapes
  defined alongside D2.a per the D2.0 boundary doc):
  - **server → daemon commands**: `spawn`, `wake`, `status`, `stop`
    (and whatever else D2.0 identifies). These map to existing
    supervisor entry points on the daemon side; payload shapes come
    from the boundary doc (e.g. `spawn` carries prompt-content + env-map,
    NOT spawn-dir absolute paths).
  - **daemon → server events**: `state`, `output`, `ready`, `exit`,
    `tool_use` (mirroring today's `ParsedEvent` surface). These flow
    from the daemon's supervisor / driver parser into the existing
    backend event-fan-out path.
- WS lifecycle: connection establishment, ping/pong heartbeat,
  reconnect with bounded backoff, **bounded per-connection write
  buffer** (not a durable queue — see "Durability invariant" below),
  connection-loss-during-active-spawn recovery contract.
- Online/offline presence: server tracks `hosts.last_seen_at` from WS
  heartbeats; deriving `host.online: bool` is a function of
  `last_seen_at` recency (no separate column).
- Token-rotation channel: when server issues a new `host_token`, the
  WS delivers it as a server → daemon `rotate_token` command; daemon
  swaps file + token in memory; old token's 60s grace covers the swap
  window.
- TLS required on non-loopback WS connections (loopback exempted for
  embedded mode).

**Durability invariant** (carried from the existing daemon PR-2 +
`multi-daemon-registry.md` baseline — D2 MUST NOT violate it):

> **The DB inbox / `RuntimeDeliveryCoordinator` is the only durable
> intent queue.** The WS transport MUST NOT invent a second durable
> queue. WS write buffer is bounded and **non-durable**.
>
> Server → daemon commands split into two categories with different
> failure semantics; D2 implementations MUST distinguish them:
>
> - **delivery-backed commands** — a `wake` triggered by user message
>   inbox delivery, or a `spawn` with a startup-delivery payload.
>   These have a corresponding `pending` row in the inbox. On
>   `host_disconnected` / `host_backpressure`, the originating inbox
>   row stays `pending` and `RuntimeDeliveryCoordinator` retries the
>   dispatch when the host reconnects and reports `ready`. The
>   command itself is non-droppable because the inbox row is.
> - **non-delivery control commands** — `status`, `stop`,
>   `rotate_token`, and any `spawn` not driven by a delivery (e.g.
>   placement/start lifecycle). These have NO inbox row. On
>   `host_disconnected` / `host_backpressure`, dispatch fails
>   synchronously to the caller with the explicit reason; **the
>   server MUST NOT fabricate an off-DB pending queue** for them.
>   Whether to retry is the caller's decision (UI prompt, scheduler
>   re-issue, etc.) — typically a no-op until the user retries the
>   action.
>
> Both categories are **non-droppable in the dispatch path** — the
> failure is always observable to either the inbox-coordinator or
> the direct caller. Only raw runtime output (high-volume
> `output` events) MAY have droppable semantics, and only when the
> drop is sequence-numbered so the receiver detects the gap.

**Out of scope for D2**: anything that ties daemon outbound to a host
kind other than `local`. Headless daemon binary, remote-host
provisioning UI, sandbox capability — all still deferred (§2).

**PR breakdown**:

- **D2.a** WS protocol frame schema + server endpoint
  (`/api/hosts/connect`) + token validation via `verifyHostToken()`.
  Frame schema cites D2.0's `docs/orchestration-boundary-v1.md` for
  payload shapes.
- **D2.b** Daemon WS client + reconnect/backoff + heartbeat + bounded
  write buffer (no durable queue).
- **D2.c** Server → daemon command frames (`spawn` / `wake` / `status`
  / `stop` / `rotate_token`) mapped to existing supervisor entry
  points; today's `HostClient` becomes a thin shim that routes to
  either the unix-socket transport (embedded loopback fallback) or
  the WS transport (remote).
- **D2.d** Daemon → server event frames (`state` / `output` / `ready`
  / `exit` / `tool_use`) wired into the backend's existing event
  fan-out.
- **D2.e** Delivery-backed dispatch recovery: integrate with
  `RuntimeDeliveryCoordinator` so delivery-backed commands fail with
  explicit reason on disconnect/backpressure and the inbox-coordinator
  re-dispatches on reconnect+ready. **Non-delivery control commands
  (`status` / `stop` / `rotate_token` / delivery-less `spawn`) only
  fail-fast to the caller; they do NOT enter the coordinator.**
- **D2.f** Token rotation over WS (`rotate_token` command).

**Acceptance criteria for D2**:

- WS handshake succeeds with valid `host_token`, rejected with 401
  on revoked / rotated-past-grace / missing token.
- Server → daemon `spawn` frame triggers the same supervisor path as
  today's `HostClient` call, verified by a transport-agnostic test
  that runs both unix-socket and WS transports against the same
  supervisor fixtures.
- Daemon → server `state` / `output` / `exit` events surface in the
  backend event fan-out identically to today's path, verified by the
  same parity test.
- WS reconnect after server restart: daemon reconnects within bounded
  backoff. **No transport-side durable queue exists**; pending
  *delivery-backed* commands are still in the DB inbox marked
  pending and `RuntimeDeliveryCoordinator` re-dispatches them when
  the host reports `ready` after reconnect; duplicate-delivery
  suppression uses the existing inbox `delivered_at` + `dedupKey`
  path.
- **Delivery-backed dispatch failure**: when WS is disconnected /
  saturated and the failing command is a `wake` or delivery-bearing
  `spawn`, the originating inbox row stays `pending`; reconnect +
  `ready` triggers `RuntimeDeliveryCoordinator` to re-dispatch.
  Verified by an integration test that yanks the WS mid-dispatch
  with a queued user message and asserts the inbox row + retry path.
- **Non-delivery control dispatch failure**: when WS is disconnected
  / saturated and the failing command is `status` / `stop` /
  `rotate_token` / delivery-less `spawn`, dispatch returns
  `host_disconnected` or `host_backpressure` synchronously to the
  caller; **no inbox row is created and no off-DB queue is
  fabricated**. Verified by an integration test that asserts no new
  inbox row appears and no retry happens on reconnect (caller's
  responsibility).
- Connection loss during active spawn: agent process is not orphaned;
  on reconnect, state converges via the same `RuntimeDeliveryCoordinator`
  recovery path daemon PR-2 already established (either resumed or
  marked failed with explicit reason). Test matrix covers loss at every
  supervisor lifecycle stage.
- `host_token` rotation over WS: new token takes effect within one
  command-frame roundtrip; old token honoured for 60s grace; daemon
  config file refreshed atomically (no partial write).
- TLS required on non-loopback WS; loopback exempted for embedded.

**Soak requirement**: D2 ships and runs in production-like usage
before D3 starts. WS transport regressions in early production hours
should not be hidden under D3 lifecycle wiring.

---

#### D3 — Desktop local-daemon lifecycle wired to outbound

**In scope**:

- Desktop spawns / restarts the bundled daemon as part of normal
  startup, with `~/.silverhand/daemon-config.json` (from Stage B)
  pointing at the configured `server_url`.
- Daemon-config writer in Electron main updates `server_url` when the
  user changes server URL in Settings; daemon picks up the change on
  next restart (no live config-reload contract in V1).
- Desktop UI shows local-host online/offline state derived from
  server-side presence (Stage B's Hosts page learns to display
  online state).
- Desktop UI shows clear "connecting / connected / disconnected /
  revoked" state for the local host's outbound connection.
- Logout flow leaves the daemon running by default (per
  `auth-and-host-model.md §3.3`); "Sign out and disable this host"
  affordance triggers `POST /api/hosts/{id}/revoke` and the daemon's
  outbound WS receives 401 and transitions to revoked state.

**Out of scope for D3**: any remote-host UI ("Add remote host", etc.).
Local host only.

**PR breakdown**:

- **D3.a** Desktop daemon lifecycle: spawn / restart / signal on
  config change.
- **D3.b** Server-URL change flow in Settings + daemon config refresh
  + daemon restart prompt.
- **D3.c** Hosts page online/offline indicator.
- **D3.d** Outbound connection state UI surface (connecting /
  connected / disconnected / revoked) + logout-vs-disable affordance.

**Acceptance criteria for D3**:

- Fresh desktop launch in remote mode → daemon starts → WS connects
  → server marks `(user_id, host_id)` online — verified by an e2e
  smoke test against a Docker server.
- User changes server URL in Settings → daemon config refreshed →
  daemon restart triggered → new WS connection succeeds → old
  `(user_id, host_id_old)` online flag clears within heartbeat
  timeout.
- Revoke from another device → outbound WS receives 401 within one
  reconnect attempt → daemon transitions to revoked state → local
  agents are NOT cascade-deleted; UI shows revoked status.
- Logout default leaves daemon running; "Sign out and disable this
  host" triggers revoke + WS drop.

---

#### D4 — Remote-mode end-to-end (the actual "fill URL → works" gate)

**In scope**:

- E2E acceptance pipeline that exercises the full closed loop:
  desktop in remote mode → signup/login → workspace + agent created →
  user sends message → server queues intent → server-initiated spawn
  frame to desktop-local daemon over WS → daemon spawns agent process
  on user's machine → agent replies via existing CLI surface → server
  routes reply back to UI.
- Failure-mode tests: server restart mid-conversation, daemon restart
  mid-conversation, WS drop mid-spawn, network partition with
  reconnect.

**Out of scope for D4**: anything other than acceptance + observability.
D4 is the gate, not new features.

**PR breakdown**:

- **D4.a** E2E test harness (Docker server + Electron client +
  scripted agent driver).
- **D4.b** Failure-mode scenarios in the same harness.
- **D4.c** Observability: WS connection metric, intent latency
  histogram, reconnect counter, error code distribution. These live
  in the existing logging surface (`~/.silverhand/logs/`); no new
  metrics infra in V1.

**Acceptance criteria for D4**:

- E2E happy path passes in CI against a Docker server.
- Failure-mode matrix passes: server restart, daemon restart, WS
  drop mid-spawn, network partition with reconnect.
- Observability surface exposes the four signals above in a way that
  an operator can debug "why is this remote install not running my
  agent" without source access.

**Detail spec**: `auth-and-host-model.md` §7 (server deployment);
`remote-server-target-architecture.md` §4 phase 2; the WS frame
schema + reconnect/backpressure contract lands as
`docs/daemon-outbound-protocol.md` together with D2.a (to be
written alongside D2 implementation).

---

## 4. Stage dependencies

```
        ┌────────────┐
        │  Stage A   │ User identity + ACL
        │ auth + ACL │
        └─────┬──────┘
              │ (A.1–A.3 must land; A.4 desktop UI can lag)
              │
        ┌─────▼──────┐
        │  Stage B   │ Hosts identity + token + verifier + placement
        │   hosts    │       (can start B.1 once A.1 lands;
        └─────┬──────┘        B.2 needs A.2 user_token)
              │
        ┌─────▼──────┐
        │  Stage C   │ Protocol purity
        │  protocol  │     (audit can begin earlier;
        └─────┬──────┘      C.4 needs A and B)
              │
              │   ┌──────────────────────────────────────────────┐
              │   │  Stage D — server runtime + daemon outbound  │
              ▼   │  (desktop-local host only)                   │
            ┌─────────────────────────────────────────────────────┐
            │ D1 server deployable runtime                         │
            │    (HARD prerequisite on C; ships + soaks first)     │
            └──┬───────────────────────────────────────────────────┘
               │ soak before D2.0 starts
               ▼
            ┌─────────────────────────────────────────────────────┐
            │ D2.0 orchestration boundary design pass              │
            │      (locks what crosses the WS transport for V1     │
            │       remote-local; no code, design doc only)        │
            └──┬───────────────────────────────────────────────────┘
               │ sign-off before D2.a opens
               ▼
            ┌─────────────────────────────────────────────────────┐
            │ D2 daemon outbound transport (desktop-local host)    │
            │    (uses Stage B's verifyHostToken() — no new        │
            │     identity primitive; new caller only)             │
            │    DB inbox remains the only durable intent queue    │
            └──┬───────────────────────────────────────────────────┘
               │ soak before D3 starts
               ▼
            ┌─────────────────────────────────────────────────────┐
            │ D3 desktop local-daemon lifecycle wired to outbound  │
            └──┬───────────────────────────────────────────────────┘
               │
               ▼
            ┌─────────────────────────────────────────────────────┐
            │ D4 remote-mode end-to-end acceptance + observability │
            │    (the actual "fill URL → works" gate)              │
            └──┬───────────────────────────────────────────────────┘
               │
               ▼
        ┌─────────────┐
        │ Follow-up   │ Headless / remote daemon binary,
        │   phase     │ remote-host provisioning UI,
        └─────────────┘ sandbox capability, V1.5 invite, V2 OAuth
```

**Hard constraints**:

- **A precedes everything**: without `viewer_user_id`, every other
  stage builds on the deprecated single-user fallback and will need to
  be revisited.
- **C must precede D**: this is the main learning from the lock-in
  discussion. Splitting the server process before scrubbing in-process
  shortcuts means each shortcut becomes either a crash or a leak at
  cutover. C is cheap; rework after D is expensive.
- **D1 must ship and soak before D2.0 starts**, **D2.0 must sign off
  before D2.a opens**, **D2 must ship and soak before D3**, **D3
  before D4**: Stage D is the only "wide" stage in V1; mixing
  control-plane split with orchestration boundary design with daemon
  outbound transport with desktop lifecycle changes in a single
  change window is exactly the anti-pattern that earlier rounds of
  this roadmap nearly fell into. The five milestones (D1, D2.0, D2,
  D3, D4) exist precisely to keep that surface separable.
- **Follow-up phase must wait for D4**: distribution / new Host kinds
  / capability layers are *intentionally* held back so V1 ships a
  closed loop on `kind=local` before generalising.

**Soft constraints (partial parallelism)**:

- **A and B overlap**: A.1 (schema + Argon2id) unblocks B.1 (hosts
  schema + registry skeleton + `verifyHostToken()`) immediately. B.2
  (claim flow) needs A.2 (user_token issued) before it can authenticate.
  A.4 (desktop UI) can lag a bit because nothing else gates on it.
- **C.1 (audit catalogue) can start anytime**: it's a doc/test
  artifact, not code. Doing it early surfaces hidden coupling early
  and pre-sizes C's PR queue.
- **D1, D2.0, D2 design/spec work can overlap with C**: the
  `docs/orchestration-boundary-v1.md` (D2.0 deliverable),
  `docs/daemon-outbound-protocol.md` (D2.a frame schema), and
  `docs/server-env-config.md` (D1 env contract) can all be drafted
  while Stage C audit and conversions are landing — these are doc
  artifacts, not implementation. Implementation order remains
  C → D1 → D2.0 → D2 → D3 → D4.

**Anti-pattern to avoid**:

> "Let's bundle D1 + D2 (or D2.0 + D2) into one big Stage D PR set so
> it ships faster."

This is the trap that caused two earlier rounds of this roadmap to
leak daemon outbound into the wrong stage. D1 is *control-plane only*;
D2.0 is *boundary design with no implementation*; D2 is *new transport,
new failure modes*. Mixing any two means regressions of distinct kinds
land in the same change window and the bisect surface is the union of
both. The whole point of the D1 → D2.0 → D2 → D3 → D4 split is to keep
regression bisects narrow.

---

## 5. Follow-up phase (after Stage D)

For forward-reference only. Detail will be planned when Stage D4
acceptance is met. Note that daemon outbound protocol is **NOT** in
this list — round 4 of this roadmap moved it into Stage D2.

- **Headless / remote daemon binary**: standalone build of the daemon
  for non-desktop hosts. Config from env, log to stdout, signal
  handling, packaging story (Docker image? plain binary? both?). Reuses
  the Stage D2 outbound protocol; the binary is just a different
  execution wrapper.
- **Remote host provisioning routes**: `POST /api/hosts` (kind=remote),
  `POST /api/hosts/{id}/exchange` (bootstrap → long-lived swap),
  "Add remote host" desktop UI. Threat model for bootstrap token leak,
  exchange replay, multi-pair attacks.
- **Sandbox capability layer** (Appendix A.5 in `auth-and-host-model.md`).
- **Orchestration boundary generalisation** for headless / sandbox /
  multi-Host-kind cases. V1's `kind=local` boundary is locked in
  Stage D2.0; this follow-up item is the second-pass review that asks
  "are the D2.0 decisions still right when daemon runs in a Docker
  container without a desktop?" — possible new transport frames,
  possible boundary moves. Reusing the Stage D2 transport surface.
- **V1.5 multi-user invite + workspace sharing** (Appendix A.3 in
  `auth-and-host-model.md`).
- **V2 OAuth providers** (Appendix A.2 in `auth-and-host-model.md`).

---

## 6. Document review log

- 2026-05-25 — Initial draft (Alice). Reviewer: @Cindy. Pending shiki
  product confirm. Cross-references `auth-and-host-model.md` (Stage A/B
  detail spec), `remote-server-target-architecture.md` (target topology
  + phase plan), `multi-daemon-registry.md` (RuntimeHostRegistry
  mechanics).
- 2026-05-25 — Round 2 revision (Alice). Addresses Cindy review
  round 1:
  - **P1 daemon outbound leak**: Stage B in-scope rewritten to be
    *identity + issuance + placement routing only*; "daemon outbound
    auth" replaced with "token validator on existing daemon ↔ backend
    channel"; B.2 PR description, acceptance criteria, and a new
    Out-of-scope verification clause all clarify Stage B does NOT land
    long-lived outbound WS / online presence. Stage D acceptance:
    "runs an agent against remote server" claim removed and
    explicitly marked as follow-up-phase-only ("Stage D ships remote
    control-plane only; remote-drives-local-daemon requires daemon
    outbound").
  - **P1 §1 agent/server boundary**: rewritten to distinguish
    daemon (host-local, holds `host_token`, represents execution
    plane) from agent CLI (host-local but server-directed, holds
    conversation-scoped credentials, consumes server APIs like the
    desktop UI does). Cross-references the third token in
    `auth-and-host-model.md §5`.
  - **P2 cross-reference warning**: reading order now flags that
    `remote-server-target-architecture.md §5` auth section is
    superseded by `auth-and-host-model.md` — do not implement from it.
  - **P2 timing acceptance flakiness**: Stage A credential timing
    acceptance changed from "within 10% wall-clock benchmark" to
    "constant control flow + dummy-hash audit"; wall-clock benchmark
    relegated to manual security check, not CI gate.
  - Dependency graph annotated to make Stage-D-ships-control-plane-only
    visible at a glance.
- 2026-05-25 — Round 3 transport-truth fix (Alice). Addresses Cindy
  review round 2 P1: Stage B round-2 in-scope still implied a
  daemon-initiated authenticated request path ("when the daemon makes
  any backend call, server validates `host_token`") and acceptance
  said "daemon's next backend call carries the new Authorization". The
  current pre-outbound architecture has backend / Electron main dial
  the daemon's Unix socket via `HostClient`; the daemon does NOT make
  outbound HTTP/WS calls to the backend. That request path is
  follow-up-phase, not V1.
  - Stage B in-scope rewritten to deliver **host identity + token
    issuance/storage/revoke/rotate + generic `verifyHostToken()` +
    placement routing** only. New explicit out-of-scope item:
    "Daemon presenting `host_token` to the server in any new request
    path — that request path does not exist in V1."
  - Stage B acceptance criteria rewritten around what actually ships:
    smoke test for token issuance + on-disk persistence; unit-test
    matrix for `verifyHostToken()` (valid / rotated within grace /
    rotated past grace / revoked credential / revoked host / missing);
    audit test for runtime-intent host_id routing; fail-closed test
    for `placeAgent()` on revoked host. No test exercises a daemon
    outbound authenticated call.
  - B.1 PR adds `verifyHostToken()` primitive with unit-test surface;
    B.2 reframed as "claim + token persistence", not "claim + outbound
    handshake".
  - Cross-doc cleanup landed in the same round:
    `auth-and-host-model.md §6.1` updated (`2eacfff` on
    `docs/auth-and-host-model`) to remove the matching "[daemon]
    outbound-connects with host_token" diagram line + add a Transport
    note paragraph deferring daemon-initiated outbound to follow-up
    phase.
- 2026-05-25 — Round 4 product-call expansion (Alice). shiki selected
  option 2: pull daemon outbound (for the desktop-local host case)
  into Stage D so that V1 closes the "fill in a server URL → app
  actually works end-to-end" loop. Trade-off: Stage D scope ~1 week →
  ~4-5 weeks, regression surface widens. Mitigation: strict milestone
  separation enforced in the doc.
  - §2 Non-goals: removed "daemon outbound host protocol" (moved into
    Stage D2). Remaining deferrals: headless / remote daemon binary,
    remote-host provisioning UI, sandbox capability, multi-user
    invite, OAuth, TLS in image, email password recovery, backups.
  - §3 Stage D rewritten into four milestones (D1/D2/D3/D4 per
    Cindy's review proposal):
    - D1 = server deployable runtime (control plane split) — ships
      and soaks first.
    - D2 = daemon outbound transport (desktop-local host only) — uses
      Stage B's `verifyHostToken()` primitive, no new identity work.
    - D3 = desktop local-daemon lifecycle wired to outbound.
    - D4 = remote-mode e2e acceptance + observability (the actual
      "fill URL → works" gate).
    - Each milestone has its own in-scope / out-of-scope / PR breakdown
      / acceptance criteria + an explicit soak requirement between
      consecutive milestones.
  - §4 dependency graph redrawn to show Stage D as a four-milestone
    pipeline; new hard constraint "D1 must ship and soak before D2
    starts, D2 before D3, D3 before D4"; new anti-pattern warning
    against bundling D1+D2 into one PR set.
  - §5 Follow-up phase: removed daemon outbound (now in D2); remaining
    follow-up items annotated to reflect that they reuse the Stage D2
    transport.
  - Stage B remains unchanged: still ships identity / token /
    `verifyHostToken()` / placement only. Token presentation over a
    real outbound transport is Stage D2's responsibility, using Stage
    B's primitive as a caller.
- 2026-05-25 — Round 5 architecture-correctness fix (Alice). Addresses
  Cindy review round 4 P1/P2:
  - **P1 orchestration boundary moved into V1**: new milestone
    **D2.0 orchestration boundary design pass** inserted before D2.
    Once remote server and desktop daemon sit on different machines,
    backend behaviours that materialize host-local fs state
    (`spawn-prep.ts`, env injection for agent CLI, workspace fs path
    resolution, blob path resolution) execute inside the server
    container where the agent process cannot read them. D2 cannot
    just be "wire WS transport and reuse `HostClient` surface" —
    that surface assumed co-location. D2.0 produces
    `docs/orchestration-boundary-v1.md` listing each responsibility
    with its V1 server-owned / daemon-host-owned / both decision +
    rationale. Guiding principle (proposal): any work requiring
    direct host fs access moves to daemon-host; server stays
    authoritative on data and ships it over the transport.
    Follow-up phase keeps only the "headless / sandbox
    generalisation review" of these decisions, not the initial
    decision itself.
  - **P1 DB inbox is the only durable queue**: D2 in-scope and
    acceptance rewritten to honour the existing daemon PR-2 +
    `multi-daemon-registry.md` baseline invariant — backend does NOT
    invent a second durable intent queue. New "Durability invariant"
    callout in D2's in-scope section. WS write buffer is bounded
    and **non-durable**; on disconnect or saturation, dispatch of
    `spawn` / `wake` / `status` / `stop` / `rotate_token` returns
    explicit `host_disconnected` or `host_backpressure`; the
    originating delivery row stays pending in the DB inbox and the
    existing `RuntimeDeliveryCoordinator` retries after the host
    reconnects and reports `ready`. Control-plane commands are
    non-droppable; only raw runtime output (high-volume log stream)
    MAY have droppable semantics, and only when the drop is
    explicitly sequence-numbered. Acceptance criteria rewritten
    accordingly; new D2.e "disconnect/backpressure recovery"
    sub-PR.
  - **P2 Stage C out-of-scope stale**: "daemon outbound is follow-up
    phase" line in §3 Stage C out-of-scope updated to "daemon
    outbound is Stage D2"; orchestration boundary added as Stage
    D2.0, also not Stage C.
  - **P2 frame direction**: D2 in-scope and acceptance criteria
    rewritten to split frames into two directions explicitly —
    *server → daemon commands* (`spawn` / `wake` / `status` / `stop`
    / `rotate_token`) and *daemon → server events* (`state` /
    `output` / `ready` / `exit` / `tool_use`). `event` is no longer
    misclassified as a server-initiated frame.
  - §4 dependency graph updated to include D2.0 between D1 and D2
    with "sign-off before D2.a opens" gating; D2 box now annotates
    "DB inbox remains the only durable intent queue".
  - §5 follow-up phase: orchestration boundary entry rewritten as
    "generalisation review for headless/sandbox" — V1 boundary
    decision is now made in D2.0, follow-up reviews it for
    multi-Host-kind cases.
- 2026-05-25 — Round 6 durable-queue scope fix (Alice). Addresses
  Cindy review round 5 P1/P2:
  - **P1 durable queue applies only to delivery-backed commands**:
    earlier durability invariant wording bound *every* control
    command to an inbox row, but only `wake` (always) and `spawn` (when
    driven by startup delivery) are delivery-backed; `status` /
    `stop` / `rotate_token` and delivery-less `spawn` are
    non-delivery control commands with no inbox row. Rewritten the
    Durability invariant callout to split the two categories with
    distinct dispatch-failure semantics: delivery-backed →
    `RuntimeDeliveryCoordinator` retry path; non-delivery → fail-fast
    to caller, no fabricated off-DB queue. Acceptance criteria split
    into two corresponding test paths (one yanks WS with a queued
    user message → asserts inbox row + retry; one yanks WS with a
    `status`/`stop` call → asserts no inbox row appears and no
    retry happens).
  - **P2 sequence-consistency cleanup**: all "before D2 starts" /
    "D1→D2→D3→D4" phrasings updated to include D2.0 between D1 and
    D2 — soak requirement, hard constraints, soft constraints,
    anti-pattern, implementation order ("C → D1 → D2.0 → D2 → D3 →
    D4"), dependency graph already updated in round 5.
  - **P2 D2.e rename**: D2.e "Disconnect / backpressure /
    connection-loss recovery contract" → "Delivery-backed dispatch
    recovery"; same sub-PR now also documents the non-delivery
    fail-fast contract in the same place, so a reader looking at
    D2.e sees both categories of failure handling and doesn't
    assume every control command flows through RDC.

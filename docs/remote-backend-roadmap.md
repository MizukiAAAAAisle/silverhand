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
> 1. `remote-server-target-architecture.md` — the destination
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
- **Daemon and agent always co-located**; agent never reaches the server
  directly.

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

- **Daemon outbound host protocol** (server-initiated control of a
  remote daemon over a daemon's outbound WS). Belongs in the follow-up
  phase, after A–D are stable. Mixing it into the server-split work
  doubles the disruption surface.
- **Headless / sandbox daemon binary distribution**. Schema arm exists
  (`hosts.kind = local|remote`), but no V1 surface ships.
- **Sandbox capability layer** (chroot / seccomp / namespace mounts /
  ephemeral fs / network egress policy). Orthogonal to Host `kind`; see
  `auth-and-host-model.md` Appendix A.5.
- **Multi-user invite / workspace sharing** (V1.5).
- **OAuth providers** (GitHub Device Flow, Google OIDC) — V2.
- **TLS termination in the server image**. Deployers use a reverse
  proxy (Caddy / Tailscale / nginx); the image listens plain.
- **Password recovery via email** (V1 uses `silverhand-server admin
  reset-password` recovery utility).
- **Backup/restore tooling**.

Each item has a parking lot in `auth-and-host-model.md` Appendix A or
`remote-server-target-architecture.md`; the rule is *not yet*, not
*never*.

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
- Credential failure timing within 10% across the four enumeration
  axes (email-known/unknown × password-correct/wrong) on a benchmark.
- `SILVERHAND_DISABLE_SIGNUP=1` → `POST /auth/signup` returns 404
  identical to a missing route; startup log prints the resolved value.
- Desktop: fresh install → Setup Wizard appears; signup → login →
  logout cycle works; encrypted session blob survives restart;
  unencrypted token never written to disk or `localStorage`.

**Detail spec**: `auth-and-host-model.md` §2–§4, §8.1–§8.3, §10.

---

### Stage B — Hosts model + credential binding

**Goal**: `Host` becomes a first-class concept in schema and API. Every
runtime intent route carries `host_id`, even with one local host.
`host_token` is the daemon's outbound credential. Phase 4 (daemon
outbound to remote hosts) becomes a *routing target swap*, not a route
rewrite.

**In scope**:

- `hosts` table upgraded: `user_id` FK confirmed, `installation_id`,
  `revoked_at`, `last_seen_at`, `kind` enum stays `local|remote`.
- New `host_credentials(id, host_id, token_hash, kind=long_lived|bootstrap, expires_at, consumed_at, revoked_at)`.
- Routes (local-host scope only): `POST /api/hosts/claim-or-create`,
  `POST /api/hosts/{id}/revoke`, `POST /api/hosts/{id}/rotate-token`.
- Backend `RuntimeHostRegistry` abstraction over today's single
  `hostClient`. Cache keys gain a `host_id` dimension; run-state cache
  is per-host generation.
- `conversation_agents.runtime_host_id` (or equivalent placement column)
  on the conversation/agent join row.
- Every runtime intent route resolves a `host_id` via the registry —
  even when there is only one entry. No "if registry has one host, use
  it" shortcut.
- Daemon outbound auth: daemon presents `host_token` as
  `Authorization: Bearer` on its connection; server validates against
  `host_credentials`.
- `installation_id` writer on desktop: `~/.silverhand/installation_id`
  auto-created on first run (uuid v4).
- Soft-delete model for both `hosts.revoked_at` and
  `host_credentials.revoked_at`; token validator denies on either set
  or row missing. **No grace window on revoke**; rotation has 60s grace.

**Out of scope** (push back if asked):

- Remote-host create (`POST /api/hosts` with `kind=remote`),
  `POST /api/hosts/{id}/exchange`, "Add remote host" desktop UI,
  headless daemon binary distribution — all deferred to follow-up
  phase together with their threat model.
- Daemon outbound from a non-co-located process. Daemon stays local in
  Stage B.
- Auto-rotation of `host_token` on every claim. Rotation is explicit.

**PR breakdown (suggested)**:

1. **B.1 Schema + RuntimeHostRegistry skeleton**: tables, migrations,
   registry interface (single-entry implementation), `runtime_host_id`
   placement column.
2. **B.2 Local-host claim flow**: `claim-or-create` route + Electron
   main wires it after login; writes `~/.silverhand/daemon-config.json`
   0600; daemon picks up host_token and authenticates outbound.
3. **B.3 Runtime intent routing through registry**: every existing
   runtime intent route refactored to resolve host_id; cache keys
   updated; per-host run-state generation.
4. **B.4 Revoke + rotate + Hosts UI**: revoke/rotate routes,
   token-validator updates (revoked_at check), desktop Hosts page
   (list / revoke action).

**Acceptance criteria**:

- Fresh desktop login → `claim-or-create` issues host_id + host_token →
  daemon authenticates outbound → server marks `(user_id, host_id)`
  online. Verified by a smoke test running through the full handshake.
- Every runtime intent route in the codebase carries `host_id` through
  registry lookup. Verified by an audit test on the runtime router.
- Revoke: token-validator denies the next request bearing the
  revoked token within one DB roundtrip; daemon WS reconnect returns
  401 `host_revoked`; existing agents on that host are NOT cascade-
  deleted.
- Rotate: old token valid for 60s after rotation commit; new token
  valid immediately; daemon receives new token via existing connection.
- Revoked host + new `claim-or-create` attempt → 409 `host_revoked`
  fail-closed, no silent revival.
- `host_token` never appears in renderer process memory or IPC traffic
  (audited via leak-guard test that greps IPC payload schemas).

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
- Convert `BackendInfo` IPC consumer to honour the `mode: 'embedded' |
  'remote'` field that already exists but is currently unconsumed.
- Audit CLI (`packages/cli`) `SILVERHAND_*` env injection: confirm
  every CLI invocation routes through `SILVERHAND_SERVER_URL`, never
  through an in-process shortcut.
- `/auth/embedded-bootstrap` route + flow: server in embedded mode
  writes a one-shot `bootstrap_session_token` to
  `~/.silverhand/embedded-bootstrap` (0600); desktop reads file →
  POSTs `/auth/embedded-bootstrap { token }` over loopback. Four
  constraints (loopback only + one-shot + boot-session-scoped + only
  when `mode=embedded`) MUST all hold; failing any returns 404.
- Renderer never sees `user_token` plaintext for embedded mode either;
  bootstrap returns a normal session that's persisted via
  `safeStorage` just like the remote signup path.

**Out of scope** (push back if asked):

- Removing the local-host-only UX (`showItemInFolder` etc.). They are
  legitimate features, just gated by `host.kind`.
- The server-process split itself (that's Stage D).
- The daemon's outbound protocol upgrade (that's the follow-up phase).

**PR breakdown (suggested)**:

1. **C.1 Audit catalogue**: a single doc/test artifact that enumerates
   every main-process backend-object read and every IPC route, with
   the disposition tag (OS-IPC / data / local-host-only). No code
   change; this is the agreement layer.
2. **C.2 Data-IPC conversions**: each "data"-tagged IPC converted to
   HTTP. Renderer's HTTP client gains the centralised
   `Authorization` header.
3. **C.3 BackendInfo mode propagation**: `mode` field actually
   consumed by renderer; local-host-only UX gated.
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

### Stage D — Server deployable runtime

**Goal**: backend becomes a deployable artifact. The same process that
embedded mode imports is also the entry point for `docker run` and
`systemd`-style deployments. Configuration is env-driven; admin
operations exist as recovery utilities, not as a CLI lifecycle tool.

**In scope**:

- New `packages/server` binary that wraps `startBackend(...)`. Single
  entry point used by both `apps/desktop` (embedded) and the
  standalone deployment.
- Env-driven config: `SILVERHAND_LISTEN`, `SILVERHAND_DATA_DIR`,
  `SILVERHAND_DISABLE_SIGNUP`, `SILVERHAND_LOG_LEVEL`. Replace
  constructor-argument config; document the full env contract in
  `docs/server-env-config.md` (to be written alongside this stage).
- Dockerfile (multi-stage), image publish workflow,
  `silverhand/silverhand-server:vX.Y.Z` tag.
- Persistent volume layout per `auth-and-host-model.md §7.1`:
  `/var/lib/silverhand/silverhand.db`, `blobs/`, `workspaces/`.
- Admin recovery subcommands (NOT product flow): `admin reset-password`,
  `admin list-users`, `admin list-hosts`, `admin revoke-host`. Each
  acquires the same DB connection lock the running server uses
  (single-process writes invariant from `CLAUDE.md`).
- Healthcheck endpoint (`GET /healthz`) for container orchestrators.
- Migration runner: idempotent on startup, fails loud on inconsistent
  state.
- Embedded mode now imports the server entry point exactly the same
  way standalone deployments do — no special embedded code path beyond
  the listen address and `/auth/embedded-bootstrap` enablement.

**Out of scope** (push back if asked):

- TLS termination inside the image (reverse proxy responsibility).
- Backup/restore tooling.
- CLI lifecycle tool (`server start`, `server stop` — use Docker /
  systemd; admin subcommands are *one-shot recovery operations* only).
- Multi-tenant work (single tenant per server in V1).

**PR breakdown (suggested)**:

1. **D.1 packages/server entrypoint + env config**: new package,
   `startBackend` wrapped, env contract documented. Desktop's embedded
   mode now imports this entry point.
2. **D.2 Dockerfile + healthcheck + volume layout**: image build, CI
   workflow, healthcheck route, volume schema.
3. **D.3 Admin recovery subcommands**: `admin reset-password` first
   (highest recovery value), then list/revoke commands.
4. **D.4 Migration runner hardening**: idempotent on startup, schema
   version check, fail-loud on incompatibility.

**Acceptance criteria**:

- `docker run` produces a working server reachable over the bound
  port; embedded mode imports the same entry point with no code-path
  divergence beyond config and `/auth/embedded-bootstrap` enablement.
- Desktop in "remote" mode (server URL set in Settings) successfully
  signs up, logs in, and runs an agent against a server running in a
  separate Docker container.
- Env contract is complete: no required config goes through a non-env
  channel; admin subcommands need only env to find the DB.
- `docker exec silverhand-server silverhand-server admin reset-password
  --email <x>` works; password reset revokes all sessions for that
  user.
- Healthcheck returns 200 once migrations are applied and the listen
  socket is open.
- Embedded mode startup time within 10% of the previous in-process
  startup. (No accidental performance regression from going through the
  HTTP layer for local-loopback traffic — this is fine for protocol
  parity but should be measured.)

**Detail spec**: `auth-and-host-model.md` §7;
`remote-server-target-architecture.md` §4 phase 2.

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
        │  Stage B   │ Hosts model + credential binding
        │   hosts    │       (can start B.1 once A.1 lands;
        └─────┬──────┘        B.2 needs A.2 user_token)
              │
        ┌─────▼──────┐
        │  Stage C   │ Protocol purity
        │  protocol  │     (audit can begin earlier;
        └─────┬──────┘      C.4 needs A and B)
              │
        ┌─────▼──────┐
        │  Stage D   │ Server deployable runtime
        │   server   │     (HARD prerequisite on C)
        └─────┬──────┘
              │
        ┌─────▼──────┐
        │ Follow-up  │ Daemon outbound + remote host + sandbox
        │  phase     │     (HARD prerequisite on D)
        └────────────┘
```

**Hard constraints**:

- **A precedes everything**: without `viewer_user_id`, every other
  stage builds on the deprecated single-user fallback and will need to
  be revisited.
- **C must precede D**: this is the main learning from the lock-in
  discussion. Splitting the server process before scrubbing in-process
  shortcuts means each shortcut becomes either a crash or a leak at
  cutover. C is cheap; rework after D is expensive.
- **Follow-up phase must wait for D**: daemon outbound protocol +
  remote / headless host distribution + sandbox capability are
  *intentionally* held back so the server-process split lands without
  also redesigning the execution plane in the same change window.

**Soft constraints (partial parallelism)**:

- **A and B overlap**: A.1 (schema + Argon2id) unblocks B.1 (hosts
  schema + registry skeleton) immediately. B.2 (claim flow) needs A.2
  (user_token issued) before it can authenticate. A.4 (desktop UI) can
  lag a bit because nothing else gates on it.
- **C.1 (audit catalogue) can start anytime**: it's a doc/test
  artifact, not code. Doing it early surfaces hidden coupling early
  and pre-sizes C's PR queue.

**Anti-pattern to avoid**:

> "Let's roll Stage B and the daemon outbound protocol together because
> they're both about Hosts."

This is exactly the trap the lock-in discussion warned against: don't
change the process boundary and the execution model in the same change
window. Stage B teaches the codebase that Hosts have identity and
credentials; the follow-up phase teaches it that Hosts can live
elsewhere. One thing at a time.

---

## 5. Follow-up phase (after Stage D)

For forward-reference only. Detail will be planned when Stage D
acceptance is met.

- **Daemon outbound host protocol**: server-initiated control of a
  remote daemon over its outbound WS. Long-lived WS auth via
  `host_token`. Backpressure, reconnect, idempotency on
  intent re-delivery. (`remote-server-target-architecture.md` Phase 4.)
- **Headless / remote daemon binary**: standalone build of the daemon
  for non-desktop hosts. Config from env, log to stdout, signal
  handling, packaging story (Docker image? plain binary? both?).
- **Remote host provisioning routes**: `POST /api/hosts` (kind=remote),
  `POST /api/hosts/{id}/exchange` (bootstrap → long-lived swap),
  "Add remote host" desktop UI. Threat model for bootstrap token leak,
  exchange replay, multi-pair attacks.
- **Sandbox capability layer** (Appendix A.5 in `auth-and-host-model.md`).
- **Orchestration boundary decision**: which `DaemonAgentRuntimeHost`
  responsibilities (prompt context / spawn files / token / inbox
  delivery / run-state cache / SSE) stay server-side vs move to
  daemon-host. Alice owns this proposal as a Phase 4 prerequisite.
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

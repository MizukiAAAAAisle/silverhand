# Auth and Host model — V1 spec

> **Status**: V1 implementation spec, 2026-05-25. Companion to
> `remote-server-target-architecture.md`. Reverse-engineered from the target
> topology back to the work needed today.
>
> **Supersedes**: §5 *Auth baseline candidate* of
> `remote-server-target-architecture.md`. That section described a self-hosted
> pairing-flow + owner-concept design that was simplified during channel
> review; this document is the new baseline.
>
> **Related docs**:
> - `remote-server-target-architecture.md` — target topology + phase 0–5
>   migration plan (still authoritative on those topics).
> - `multi-daemon-registry.md` — RuntimeHostRegistry mechanics inside the
>   backend.
> - `silverhand-daemon.md` — current daemon execution-plane scope.
> - `architecture-principles.md` §9 — control plane vs execution plane.
>
> **Scope**: this document covers the auth/identity/host-credential model and
> the V1 work list. Topology, phase ordering, and orchestration-boundary
> design are owned by the related docs above and only summarised here.

---

## 0. Three orthogonal layers

The single most important reframing from review: auth is **not one concern**.
Treating it as one led to a phantom "owner" entity that crossed all three
layers. The V1 design splits cleanly into three orthogonal layers, each with
its own implementation and its own tradeoffs:

| Layer | Question it answers | V1 mechanism |
|---|---|---|
| **Resource ownership** | Once a user exists, what can they see and modify? | `users.id` is the ACL root; every resource resolves an owner user, directly or via parent. |
| **Authentication** | This request — who is it from? | Email + password; server-issued session token (`user_token`); OAuth provider interface reserved for V2. |
| **Registration** | Who is allowed to create a user account, and when? | `POST /auth/signup` open by default; `SILVERHAND_DISABLE_SIGNUP=1` env to close. No bootstrap policy, no first-user-special role. |

The layers are independent: changing the registration mechanism (open signup
→ invite-only → OAuth → SSO) does **not** change the resource ownership model
or the session token shape. Future hardening additions land in their own
layer without disturbing the others.

---

## 1. Target topology recap

For terminology consistency, the agreed target topology (full discussion in
`remote-server-target-architecture.md`):

```
Server (control / state plane)              ← does not run agent or daemon
  state · auth · routing · blob · protocol
    │
    │ HTTP / WS
    │
  ┌─┴────────────────────┬─────────────────┐
  │                      │                 │
Desktop deployment    Sandbox deployment   ...
  UI client +            (V1.5+) headless
  local Host             Host
    │                      │
  Daemon                 Daemon
    │                      │
  Agent processes        Agent processes
```

Three first-class concepts (conceptually independent, all sharing schema with
the existing `hosts` table):

- **Host** — `id, user_id, kind=local|sandbox, label, capabilities, status,
  installation_id, created_at, last_seen_at, revoked_at`. The execution
  environment. Identity unit users see, manage, and revoke.
- **Daemon** — runtime connector running inside a Host. A replaceable instance
  that consumes a Host's credential and supervises agent processes. Daemon
  instance id ≠ host id.
- **Agent** — actor/config that runs on some Host. Has placement
  (`default_host_id` etc.) but does not embed a Host credential.

V1 has exactly one Host kind in scope: `local` (the user's desktop).
`sandbox` is reserved in the schema as `kind` enum value but no provisioning
flow ships in V1.

---

## 2. Resource ownership model

V1 ACL is **per-user resource ownership**, not RBAC. Every queryable resource
must resolve a unique owner user; the request handler must scope every read,
write, and delete to that user.

### 2.1 Resource → owner resolution

| Resource | Ownership path |
|---|---|
| `users` | n/a (root identity) |
| `hosts` | direct `hosts.user_id` |
| `workspaces` | direct `workspaces.user_id` |
| `agents` | direct `agents.created_by_user_id` (existing column, see §6) |
| `conversations` | inherited via `conversations.workspace_id → workspaces.user_id` |
| `messages` | inherited via `messages.conversation_id → ... → workspaces.user_id`; messages have `from_user_id` for authorship attribution but ACL is conversation-scoped |
| `attachments` / `blobs` | inherited via `attachments.message_id → ...` or `blobs.workspace_id → workspaces.user_id` depending on attachment context |
| `notifications` | direct `notifications.user_id` |
| `tasks` | inherited via `tasks.message_id → conversations → workspaces.user_id` |

Implementation invariant: every route handler MUST resolve a `viewer_user_id`
from the request's session token before any DB read; routes that cannot
resolve one MUST return 401. There is no "global" or "system" view in V1
beyond admin recovery commands (§7.4).

### 2.2 No RBAC fields in V1

- No `users.is_admin`, no `users.role`, no `roles` table.
- No "owner" or "admin" designation among users in the data model.
- No "user A invites user B" flow (V1.5+).

A user's only authorisation in V1 is the implicit "I can see and modify
resources whose ownership chain ends at my `user_id`."

### 2.3 What cross-user namespace operations look like

V1 has none in-product. The following are not in V1:

- viewing another user's hosts, workspaces, conversations, agents
- revoking another user's host
- sharing a workspace across users
- promoting/demoting users

If they show up later (V1.5 invite + workspace sharing, V2 admin console),
they are additive layers on top of this model — they do not require rewriting
ownership semantics.

---

## 3. Authentication

### 3.1 V1 mechanism: email + password + session

- `users` table columns: `id, email (unique), password_hash, password_hash_params (JSON), password_updated_at, created_at`.
- `password_hash` uses Argon2id with parameters per OWASP current recommendation; specific values are not committed in this doc — implementation chooses per-env benchmark and stores them in `password_hash_params` so future migration is non-breaking.
- Login: `POST /auth/login {email, password}` → server validates → issues `user_token` (opaque session token) bound to a row in `auth_sessions(id, user_id, token_hash, created_at, last_used_at, revoked_at, user_agent, ip_first_seen)`.
- Token transport: `Authorization: Bearer <user_token>` on every HTTP call from desktop UI / renderer.
- Storage on desktop: macOS Keychain via Electron `safeStorage` API (not `localStorage`, not plain config files).

### 3.2 Provider interface reserved for V2

Schema reserves a `user_auth_links(user_id, provider, provider_user_id, email, linked_at)` table even though V1 only uses one provider (`password`). V2 OAuth additions plug in here without altering `users` or session handling.

V2 provider list (planned, not committed):

- `password` (V1)
- `github_oauth`
- `google_oidc`
- (later) `enterprise_sso` via OIDC/SAML

Regardless of provider, every successful auth ends in the same `auth_sessions` row + same `user_token` shape. Provider only changes how identity is proven, not what identity yields.

### 3.3 Logout vs sign-out-and-disable-host

Two distinct UX actions, two distinct mutations:

- **Logout (UI only)**: invalidates the current `auth_sessions` row, clears keychain `user_token`. Local Host's `host_token` is **not** affected — the daemon stays online (independent lifecycle).
- **Sign out and disable this host**: above, plus `POST /api/hosts/{id}/revoke` for the local host. Daemon connection drops, won't reconnect.

Default UI button label: "Logout". The "disable this host too" affordance lives behind a secondary control or in the Hosts page, not as the default action.

### 3.4 Error response uniformity

All `/auth/*` and `/setup/*` failures (V2 too) MUST return uniform error payloads that do not distinguish between *email exists*, *email unknown*, *password wrong*, or *signup disabled*. Always 401 with a generic message. This prevents account enumeration.

---

## 4. Registration

### 4.1 V1: open signup with disable env

- `POST /auth/signup {email, password}` is open by default.
- `SILVERHAND_DISABLE_SIGNUP=1` env (read once at server startup, frozen) closes the route — returns 404, identical to other not-found.
- `GET /api/server/info` returns `{ signup_enabled: bool }` so desktop UI can render the right surface (signup form vs login-only) without round-tripping through a failed POST.
- Startup log MUST print the resolved value: `Signup: enabled (or: disabled)`.

### 4.2 What V1 does NOT do

- No `bootstrap_policy` config, no `setup_secret`, no special first-user codepath.
- No invite tokens, no email verification, no password recovery via email, no rate limiting beyond what the HTTP layer offers.
- No anti-enumeration response masking for signup specifically (covered by §3.4 already).

The first user is just the first row in `users`. They have no special role.

### 4.3 Frozen at startup

`signup_enabled` is loaded from env once at server startup into an immutable config object. Auth/setup routes reference this in-memory object only; they do **not** read settings tables at request time. Hot-swap is forbidden; toggling signup requires a server restart. This makes audit, testing, and reasoning straightforward.

### 4.4 Future hardening (Appendix A)

Future modes — bootstrap_policy, setup_secret, invite-only signup, OAuth-only — are documented as Appendix A options. They are not implemented in V1 because shiki's V1 product positioning is "I deploy this for myself" — the user is also the deployer, the deployment is implicitly trusted, and `SILVERHAND_DISABLE_SIGNUP=1` after first registration covers the "don't want random signups" case adequately.

---

## 5. Token / credential taxonomy

V1 has three independent credentials with **non-overlapping** lifetimes and authorities. Code MUST treat them as distinct types (not generic `string`), and logs MUST never print them in cleartext.

| Credential | Bound to | Lifetime | Issued by | Used by | Revocation |
|---|---|---|---|---|---|
| `user_token` (session) | `(user_id, auth_sessions.id)` | Long-lived (config; default 30d), refreshed on use | `/auth/login` success | desktop UI / renderer HTTP | Logout invalidates one session; DELETE all user sessions on password change |
| `host_token` | `(user_id, host_id)` | Long-lived (default 90d, rotatable) | First-time exchange of `host_bootstrap_token` (or auto-issue on local-host claim) | Daemon outbound HTTP/WS | `POST /api/hosts/{id}/revoke` invalidates immediately + 60s grace for in-flight |
| `host_bootstrap_token` | `(user_id, host_id, single_use)` | Short (default 15min, one-shot) | `POST /api/hosts` when creating sandbox/external host | Daemon's first-ever connect, exchanged for `host_token` | Single-use; consumed on first exchange. Time-expiry as backup. |

Three rules that the type system / interface MUST enforce:

1. `user_token` is never sent to a daemon.
2. `host_token` is never sent through the desktop UI's HTTP path.
3. `host_bootstrap_token` is never persisted beyond its first exchange.

`installation_id` is **not** in this table because it is not a credential. It is a local stable id (`~/.silverhand/installation_id`, auto-generated UUID per fresh install) used solely to deduplicate auto-registration of the same desktop machine. Server may store it for display/recognition, but it never grants authority — it is paired with `user_token` proving who the user is, and only then maps to a `host_id`.

---

## 6. Host lifecycle flows

### 6.1 Local Host auto-register on desktop login

```
desktop login (POST /auth/login)
  └─→ user_token issued
desktop reads ~/.silverhand/installation_id (creates uuid if absent)
desktop POST /api/hosts/claim-or-create
  Authorization: Bearer <user_token>
  Body: { installation_id, label: os.hostname(), capabilities: { ... } }
server resolves (user_id, installation_id):
  CASE A: existing host, not revoked
    → return { host_id, host_token, server_url } (no rotation if existing token still valid)
  CASE B: no existing host
    → CREATE host (user_id, installation_id, kind=local, label, ...)
    → ISSUE host_token
    → return { host_id, host_token, server_url }
  CASE C: existing host, revoked
    → fail-closed 409 "host_revoked"
    → desktop UI shows "this device's host record was revoked; please contact your administrator (or yourself)"
desktop writes {host_id, host_token, server_url} to ~/.silverhand/daemon-config.json (0600)
desktop spawns local daemon (or signals existing daemon to reload)
daemon outbound-connects with host_token, server marks (user_id, host_id) online
```

### 6.2 Sandbox Host provisioning (V1.5+, schema-ready in V1)

V1 ships the schema (`hosts.kind` enum supports `sandbox`) but does NOT ship the desktop UI flow or the headless daemon distribution. When V1.5 lands, the planned flow is:

```
desktop UI → "Hosts" page → "Add sandbox host"
  user inputs: label
desktop POST /api/hosts { kind: 'sandbox', label }
  → server creates host row (user_id, installation_id=null, kind=sandbox)
  → server returns { host_id, host_bootstrap_token (15min one-shot), server_url }
desktop UI shows: silverhand-daemon bootstrap eyJzZXJ2ZXIi... (base64 of {server_url, host_id, host_bootstrap_token})
user copies, runs in sandbox env (Docker/k8s/VM)
sandbox daemon parses payload, POST /api/hosts/{id}/exchange { host_bootstrap_token }
  → server validates bootstrap token (not yet consumed, not expired, matches host_id)
  → server issues host_token (long-lived)
  → server marks host_bootstrap_token consumed
sandbox daemon stores host_token, opens outbound WS to server_url
```

V1 implementation: schema + `/api/hosts` POST (kind validation) + `/api/hosts/{id}/exchange`, no UI surface, no headless daemon binary.

### 6.3 Host revoke

```
authenticated user → desktop Hosts page → select host → Revoke
desktop POST /api/hosts/{id}/revoke
  → server marks host.revoked_at, deletes host_token (current + 60s grace), broadcasts disconnect to that host's WS
daemon on that host receives disconnect, attempts reconnect, gets 401 host_revoked, transitions to "revoked, manual intervention required" state
```

Soft-delete only. The `hosts` row stays for audit / placement-history continuity. `revoked_at IS NOT NULL` is the in-memory short-circuit.

### 6.4 Host_token rotation

`host_token` rotation is **not** implicit on every claim. Implicit rotation breaks the daemon's existing connection or creates double-token races. Explicit rotation:

- `POST /api/hosts/{id}/rotate-token` issues a new token; old token remains valid for 60s grace; daemon picks up new token via authenticated rotation channel.
- Daily auto-rotation by server is a future hardening option; V1 does no auto-rotation.

---

## 7. Server deployment form

The server is **not** a CLI tool to be invoked locally. It is a deployable artifact. V1 ships in two forms (same image, two deployment paths):

### 7.1 Docker image

Primary distribution form:

- `silverhand/silverhand-server:vX.Y.Z` published image
- Single container; Node.js 24+ runtime; `silverhand-server` is the container's primary process
- Persistent state: `/var/lib/silverhand` (volume-mount required)
  - `silverhand.db` (SQLite WAL)
  - `blobs/` (local blob storage)
  - `workspaces/` (per-workspace fs roots; future host-bound resolution per `[depends: workspace-fs-decision]`)
- Listen: `0.0.0.0:8080` inside container; mapped externally per deployer's reverse proxy / Tailscale / etc.
- Logs to stdout/stderr (Docker captures)

Deployment example:

```
docker run -d --name silverhand-server \
  -p 127.0.0.1:8080:8080 \
  -v silverhand-state:/var/lib/silverhand \
  -e SILVERHAND_LISTEN=0.0.0.0:8080 \
  silverhand/silverhand-server:v1.0.0
```

### 7.2 Standalone Node.js process

Equivalent to the image's primary process — for users who don't want Docker, want NODE_OPTIONS overrides, want to run it as a systemd service, etc.

```
NODE_ENV=production \
SILVERHAND_DATA_DIR=/var/lib/silverhand \
SILVERHAND_LISTEN=127.0.0.1:8080 \
node dist/server.js
```

The container image is just a thin wrapper around this process.

### 7.3 Configuration interface

**Configuration is via environment variables**, not CLI flags. CLI flags are for one-shot operations (§7.4), not for server lifecycle config. The full env list is committed in `docs/server-env-config.md` (to be written alongside V1 implementation), key entries:

- `SILVERHAND_LISTEN` — `host:port` to bind, default `127.0.0.1:8080`
- `SILVERHAND_DATA_DIR` — persistent state root, default `/var/lib/silverhand`
- `SILVERHAND_DISABLE_SIGNUP` — `0|1`, default `0`
- `SILVERHAND_LOG_LEVEL` — `debug|info|warn|error`, default `info`
- (V2 / Appendix A) `SILVERHAND_AUTH_PROVIDERS` — comma list

### 7.4 Admin operations (recovery / maintenance)

The server image includes `silverhand-server admin <subcommand>` for one-shot operational tasks. These are NOT part of the V1 product flow; they are recovery tools. They exist because losing all desktop sessions or forgetting an email's password should not require re-deploying the server.

Available admin subcommands in V1:

- `silverhand-server admin reset-password --email <x>` — interactive prompt for new password; updates `password_hash`; revokes all sessions for that user.
- `silverhand-server admin list-users` — emits `(id, email, created_at)` for diagnostic use.
- `silverhand-server admin list-hosts [--user <email>]` — emits host rows including `revoked_at`.
- `silverhand-server admin revoke-host --host-id <x>` — revokes a host server-side regardless of UI state.

Invocation in Docker: `docker exec silverhand-server silverhand-server admin reset-password --email shiki@example.com`.

These commands talk to the same DB the running server uses; SQLite's WAL allows safe read-only or single-writer access. Admin commands MUST acquire the same connection lock the server uses (single-process writes).

### 7.5 Embedded mode

Embedded mode is the desktop app spawning the server in-process for fully-local users. Same image / Node module is imported and a server is started inside the Electron main process. Listen is loopback (`127.0.0.1:0`, OS-picked port). Auth bootstrap differs only in that the desktop has direct file access to bootstrap a session:

- Server first start: writes a one-shot `bootstrap_session_token` to `~/.silverhand/embedded-bootstrap` (mode 0600, owner-only).
- Desktop reads file → POSTs `/auth/embedded-bootstrap { token }` over loopback.
- Endpoint constraints (all four MUST hold): listen address is loopback ∈ `{127.0.0.1, ::1, unix-socket}`; route enabled only when `mode=embedded`; token is one-shot (consumed on first call); token is boot-session-scoped (server restart invalidates).
- On success: server returns a normal `user_token` (creates a user row if `users` is empty using a default email like `<os.username>@local`).

This makes embedded a deployment variant of remote, not a separate auth path. No HTTP-skipping privileged API exists.

---

## 8. Schema migration map

Three classes of changes:

### 8.1 Reuse (existing fields, V1 keeps semantics)

- `users` table — exists today (single-user fallback). V1 keeps the table; signup populates new rows.
- `agents.created_by_user_id` — already an FK to `users.id`. V1 uses it as the authoritative agent owner.
- `messages.from_user_id` — exists for authorship attribution. V1 keeps as authorship metadata; ACL still flows through conversation→workspace.
- `notifications.user_id` — exists. V1 uses as per-user inbox.

### 8.2 Reinterpret (existing column, new semantic)

- `app_settings.viewer_user_id` — currently the global single-user fallback when no principal header is present. V1: deprecated as fallback; `viewer_user_id` is sourced strictly from the resolved session subject. The column may stay during migration but routes MUST stop reading it.
- `hosts` table — currently registry-scoped. V1: becomes the user-facing Host concept (per `multi-daemon-registry.md`). Add `user_id` FK if not yet present (it should already be there; verify in implementation), `installation_id`, `revoked_at`, `last_seen_at`, `kind` enum.

### 8.3 New (V1 additions)

- `users.password_hash`, `users.password_hash_params`, `users.password_updated_at` — Argon2id storage.
- `users.email` — unique index. (May already exist; verify.)
- `auth_sessions(id, user_id, token_hash, created_at, last_used_at, revoked_at, user_agent, ip_first_seen)` — session table.
- `host_credentials(id, host_id, token_hash, kind=long_lived|bootstrap, expires_at, consumed_at, revoked_at)` — host token storage. Single table with `kind` enum is preferred over two parallel tables.
- `user_auth_links(user_id, provider, provider_user_id, email, linked_at)` — V2 OAuth provider linkage. Empty in V1, schema reserved.

Migration ordering and idempotence are owned by the implementation PR; this doc only captures the destination state.

---

## 9. V1 work list (reverse-engineered from target)

This maps to the phase plan in `remote-server-target-architecture.md` §4. Each entry is a unit of implementation work that this auth/host model spec is a prerequisite for. Time estimates are budget guidance, not commitments.

### Phase 0 — Protocol-purity sweep (1–2 weeks)

Make embedded protocol-equivalent to remote, touching auth/host paths:

- Audit `apps/desktop/src/main/index.ts` for any direct backend object reads that bypass HTTP. Convert to HTTP calls.
- Audit `apps/desktop/src/preload/index.ts` for IPC routes that pass server/host absolute paths to renderer. Tag as "OS-IPC" (clipboard, dialog, notification, etc.) vs "data" (must be HTTP).
- Audit `apps/desktop/src/renderer/components/layout/WorkspacesPanel.tsx` and similar for `showItemInFolder(workspace_path)` patterns. Local-Host-only UX; behind a "host is local" check.
- Convert `BackendInfo` IPC consumer to honour `mode: 'embedded' | 'remote'` (currently field exists but unconsumed).
- Audit CLI (`packages/cli`) `SILVERHAND_*` env injection: confirm path goes through `SILVERHAND_SERVER_URL` only, no in-process shortcuts.

### Phase 1 — RuntimeHostRegistry local-only (1–2 weeks)

Implement the Host model end-to-end, keeping a single local desktop daemon online:

- Schema migration: add columns/tables per §8.
- `/api/hosts/claim-or-create`, `/api/hosts/{id}/rotate-token`, `/api/hosts/{id}/revoke`, `/api/hosts/{id}/exchange` routes.
- Backend `RuntimeHostRegistry` abstraction over today's single `hostClient`. Cache keys gain `host_id` dimension. Run-state cache: per-host generation.
- `conversation_agents.runtime_host_id` (or equivalent placement state) on the conversation/agent join row.
- Tests: every runtime intent route through registry lookup (even when there's only one entry).

### Phase 2 — Standalone server entrypoint (~1 week)

Make `packages/backend` a deployable service:

- New `packages/server` binary that wraps `startBackend(...)` for non-embedded use.
- Env-driven config (per §7.3); replace constructor args.
- Dockerfile + multi-stage build; image publish workflow.
- Persistent volume layout per §7.1.
- TLS not committed in V1 image — deployer's reverse proxy is responsible.

### Phase 3 — Desktop remote connection skeleton + signup/login UI (1–2 weeks)

User-visible connection surface:

- Settings → "Server connection": URL input, connect/disconnect, connection state machine.
- `signup_enabled` state from `/api/server/info` controls whether Setup Wizard shows signup vs login-only.
- Setup Wizard: signup form (email, password, confirm password). Login form. Logout button. "Logout vs disable host" affordance per §3.3.
- Hosts page: list user's hosts, show online status, revoke action.
- Connection state machine: `disconnected | connecting | authenticated | error`. Renderer subscribes via main-process state provider.
- Embedded mode: settings page hides "Server connection" or shows it read-only; password login skipped (auto-bootstrap per §7.5).

### Phase 4 — Outbound daemon-host protocol + headless lifecycle + orchestration boundary decision (3–4 weeks)

Most disruptive phase. Auth model contributes:

- Daemon authenticates with `host_token` for outbound WS connection (Authorization: Bearer).
- Server-side WS connection bound to `(user_id, host_id)` from token verification.
- `host_token` rotation channel: server initiates rotate, daemon receives new token via existing connection, ACKs, server marks old expired with 60s grace.
- Headless daemon entrypoint (sandbox prep, V1.5 use): standalone binary, config from env, log to stdout, signal handling.
- Orchestration-boundary decision (separate proposal doc, Alice owns; pre-Phase 4 deliverable): which `DaemonAgentRuntimeHost` responsibilities stay server-side vs move to daemon-host. Each item from §4 of `remote-server-target-architecture.md` decided.

### Phase 5 — Decision-driven cleanup (deferred per shiki)

V1 / V1.5 keeps deferred:

- `[depends: workspace-fs-decision]` workspace fs as logical vs host-bound — current single-host (desktop-local) leaves host-local fs viable short-term.
- `[depends: L1L2-source-of-truth]` L1/L2 memory location — same; single host, no fork risk.
- `[depends: sandbox-placement-flow]` — sandbox out of V1 scope.
- `[depends: server-auth-mode]` — answered by this doc (V1: open signup + password; V2: OAuth providers).

---

## 10. Implementation invariants checklist

Reviewers (Cindy) will verify the following invariants. Implementation PRs MUST be auditable against this list.

### 10.1 Concept boundaries

1. User auth scope = desktop UI/session only. `user_token` never reaches daemon or agent process.
2. Host credential = execution environment only. `host_token` never appears in desktop UI HTTP path.
3. Daemon = replaceable connector instance. Daemon `instance_id` is per-boot; `host_id` is stable identity.
4. Agent placement references `host_id` only; agent identity does not embed any credential.
5. `host_bootstrap_token` is short-lived, exchanged for `host_token`, never persisted past first exchange.
6. Revoking a Host kills daemon connectivity and prevents future runtime placement on it; it does NOT cascade-delete agents/conversations.

### 10.2 Implementation details

7. Embedded mode auto-issues credentials over the same HTTP API used in remote (via `/auth/embedded-bootstrap`); no privileged in-process shortcut.
8. Logout vs sign-out-and-disable-host are two distinct UX actions; default is logout-only.
9. `host_token` rotation is explicit (no auto-rotation on claim); 60s grace period covers rotation in-flight.
10. `DELETE /api/hosts/{id}` does not exist in V1; only `POST /api/hosts/{id}/revoke` (soft-delete preserves audit/history).
11. Argon2id parameters are not hard-coded in the doc or implementation; stored in `password_hash_params`, set per environment per OWASP recommendation.
12. `/auth/embedded-bootstrap` constraints (all four MUST hold): loopback-only listen + one-shot + boot-session scoped + only when `mode=embedded`. Failing any returns 404.
13. `SILVERHAND_DISABLE_SIGNUP` and other auth-relevant config are loaded once at server startup into immutable in-memory config; auth routes do not re-read settings tables at request time.

### 10.3 ACL and information

14. Open signup ≠ no ACL. Every resource query/mutation is scoped by `viewer_user_id`; routes failing to resolve viewer return 401.
15. Auth/setup error responses are uniform — no enumeration of email/password/disable-state distinguishability.
16. `installation_id` is a stable local id only, not an auth factor. Hardware machine fingerprint is at most a UI display hint, never a permission boundary.
17. Existing host record + revoked_at set + new claim attempt → 409 fail-closed, no silent revival.

---

## Appendix A — Future hardening (not in V1)

Documented for forward planning. Implementation deferred until product positioning requires them.

### A.1 `bootstrap_policy` for distributed deployments

If silverhand-server is distributed for others to self-host, the V1 "open signup" default loses safety because deployers other than shiki may forget to disable signup before exposing publicly. A future config:

- `bootstrap_policy = first_user_signup | setup_secret_required`
- `loopback` listen → default `first_user_signup`
- non-loopback listen → default `setup_secret_required`
- override via `SILVERHAND_BOOTSTRAP_POLICY=...`; non-loopback explicit `first_user_signup` logs warning + `/api/server/info` exposes `policy_relaxed: true`

`setup_secret` mode requires the deployer to read a one-shot secret from server log and paste into the desktop Setup Wizard alongside email/password. Keeps root-of-trust at "can read server log" without forcing CLI interaction.

### A.2 OAuth providers

GitHub first (`auth_provider = github_oauth`):

- Each deployer registers their own GitHub OAuth App against the server's public URL, configures `GITHUB_CLIENT_ID/SECRET`.
- GitHub Device Flow available for headless / no-callback-URL deployments — owner enables Device Flow in the OAuth App settings.
- Desktop UI: "Login with GitHub" button → server `/auth/github/start` → standard or device flow as configured.

Google later (`auth_provider = google_oidc`):

- Standard OIDC web callback only (Google Limited-Input Device Flow not appropriate for desktop apps with browsers).
- Same deployer-registers-OAuth-app friction; consider documenting as "advanced setup".

Provider-agnostic invariant: every successful OAuth login funnels into the same `auth_sessions` row + `user_token` shape.

### A.3 Multi-user invite flow (V1.5)

When silverhand grows beyond single-user-per-server:

- Add `users.is_admin` boolean. First-existing user auto-promoted on migration.
- `POST /auth/signup-with-invite { invite_code, email, password }` — invite-only signup gated by code.
- Admins generate invite codes via desktop UI → `POST /api/invites`.
- Invite codes are short-lived (7d default), single-use, optionally email-bound.
- Open `/auth/signup` toggle: now `signup_policy = closed | invite_only | open` (orthogonal to auth provider).

### A.4 Multi-tenant evolution

When silverhand becomes shared infrastructure (one server, multiple unrelated owners):

- `tenants` table; `users.tenant_id`; resource ownership chain extended through tenant.
- Tenant-scoped admin role.
- Cross-tenant isolation invariant test suite.
- Out of scope for V1 and V1.5.

---

## Appendix B — Non-decisions / known gaps

This doc deliberately leaves the following undecided:

- TLS cert provisioning for V1 image — assumed deployer's reverse proxy handles it. If we ever ship without a reverse proxy assumption, ACME/Let's-Encrypt integration becomes its own scope.
- Password recovery via email — V1 uses admin CLI. V1.5+ may add email-based recovery, which requires SMTP integration.
- Rate limiting on `/auth/login` and `/auth/signup` — V1 relies on basic HTTP rate limiting (or none). Brute-force defense is hardening item, not blocking V1.
- Backup/restore tooling for `/var/lib/silverhand` — out of scope; deployer responsibility.

---

## Document review log

- 2026-05-25 — Initial draft (Alice). Reviewer: @Cindy. Pending shiki product confirm.

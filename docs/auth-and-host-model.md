# Auth and Host model

> TS backend 退役说明：文中的 `packages/backend` / `packages/server` 源码与测试坐标属于迁移期历史，已从当前仓库删除；现行控制面位于 `rust/crates`。迁移权威仍在 `packages/shared/src/db`，独立回归数据在 `rust/test-fixtures`，现行构建与验证见 [testing.md](testing.md)。

This is the canonical contract for the auth/identity/host-credential model:
resource ownership, authentication, registration, principal construction, the
token/credential taxonomy, and host lifecycle. It states the current contract
only. Governance/capability grading is owned by `graded-permissions-v1.md`
(referenced, not restated here); DDL and migrations are owned by
`packages/shared/src/db/schema.ts` + `packages/shared/src/db/migrations.ts`.

> **Related docs**:
>
> - `graded-permissions-v1.md` — the two-axis authority model (human roles +
>   agent capabilities) layered on top of the ownership base defined here.
> - `silverhand-daemon.md` — daemon execution-plane scope.
> - `daemon-outbound-protocol.md` — the daemon↔backend wire contract.
> - `orchestration-boundary-v1.md` — control plane vs execution plane, incl.
>   host-local path authority (§5.1).
> - `architecture-principles.md` — control plane vs execution plane.
>
> **Scope**: topology, phase ordering, and orchestration-boundary design are
> owned by the related docs above and only summarised here.

---

## 0. Three orthogonal layers

Auth is **not one concern**. Treating it as one produces a phantom "owner"
entity that crosses all three layers. The design splits into three orthogonal
layers, each with its own implementation and tradeoffs:

| Layer                  | Question it answers                                | Mechanism                                                                                                                                                                                                          |
| ---------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Resource ownership** | Once a user exists, what can they see and modify?  | `users.id` is the ACL root; every resource resolves an owner user, directly or via parent. Workspace **governance roles** (owner/admin/member) grade what a member may do — see §2 and `graded-permissions-v1.md`. |
| **Authentication**     | This request — who is it from?                     | Email + password; server-issued session token (`user_token`).                                                                                                                                                      |
| **Registration**       | Who is allowed to create a user account, and when? | `POST /auth/signup` open by default; `SILVERHAND_DISABLE_SIGNUP=1` env to close. No bootstrap policy, no first-user-special role.                                                                                  |

The layers are independent: changing the registration mechanism (open signup
→ invite-only) does **not** change the resource ownership model or the session
token shape.

---

## 1. Topology recap

For terminology consistency, the deployment topology:

```
Server (control / state plane)              ← does not run agent or daemon
  state · auth · routing · blob · protocol
    │
    │ HTTP / WS
    │
  ┌─┴────────────────────┬─────────────────┐
  │                      │                 │
Desktop deployment    Remote deployment   ...
  UI client +            headless
  local Host             Host
    │                      │
  Daemon                 Daemon
    │                      │
  Agent processes        Agent processes
```

Three first-class concepts (conceptually independent, all sharing the `hosts`
table):

- **Host** — `id, user_id, kind=local|remote, provisioning_source, label,
capabilities, status, installation_id, created_at, last_seen_at,
revoked_at`. The execution environment. Identity unit users see, manage, and
  revoke.
- **Daemon** — runtime connector running inside a Host. A replaceable instance
  that consumes a Host's credential and supervises agent processes. Daemon
  instance id ≠ host id.
- **Agent** — actor/config that runs on some Host. Has placement
  (`host_id` etc.) but does not embed a Host credential.

Both Host kinds — `local` (the user's desktop, `provisioning_source =
'app_install'`) and `remote` (a user-managed computer, `provisioning_source =
'user_invite'`) — are live and first-class. _Sandbox is not a Host kind_:
sandboxing is a Host capability / mount concern, not an enum tag.

### 1.1 HOSTS uniformity (top-level invariant)

`local` Hosts and `remote` Hosts are the **same first-class entity** at the
auth and wire layers. All differences are confined to provisioning and
capability metadata; the credential, validation, transport, and lifecycle
control plane are identical.

| Concern            | local Host                                                              | remote Host (user-managed computer)                                                                                                  |
| ------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| DB row             | `hosts` (`kind='local'`, `provisioning_source='app_install'`)           | `hosts` (`kind='remote'`, `provisioning_source='user_invite'`)                                                                       |
| Credential row     | `host_credentials` (one or more `kind=long_lived`)                      | `host_credentials` (one or more `kind=long_lived`)                                                                                   |
| Mint authority     | `user_token` session via `POST /api/hosts/claim_or_create` (§6.1)       | `user_token` session via `POST /api/hosts` (§6.2) — desktop is always the trust anchor                                               |
| Wire auth          | `Authorization: Bearer <host_token>` on the daemon connect/WS transport | identical (the `connect_token` is a long-lived `host_token`, used as both the `connect-token/resolve` bearer and the WS credential)  |
| Server validator   | `HostTokenService.verifyHostToken()`                                    | identical (no separate code path)                                                                                                    |
| Outbound transport | one outbound WebSocket per Host                                         | identical                                                                                                                            |
| Rotation           | `POST /api/hosts/:id/rotate-token` + 60s grace (§6.4)                   | `POST /api/hosts/:id/connect-token/rotate` (§6.2)                                                                                    |
| Revoke             | `POST /api/hosts/:id/revoke` (hard deny, no grace)                      | for a user-managed computer, `DELETE /api/hosts/:id` (hard delete) / `POST /api/hosts/:id/disconnect` instead — revoke is local-only |
| Placement key      | `agent.host_id` → `RuntimeHostPlacementResolver`                        | identical (resolver is host-kind-agnostic)                                                                                           |
| Capability layer   | `host_capabilities.*` rows describe local fs / mounts                   | identical mechanism                                                                                                                  |

What this invariant buys:

- The desktop / a logged-in user session is always the trust anchor for any
  new Host. There is no zero-trust path where a Host claims itself into
  existence — every Host's first credential is minted by an authenticated user
  session, whether the daemon runs on the desktop machine or elsewhere.

### 1.2 Outbound TLS policy (all dial-out processes)

Every outbound HTTPS the desktop-main process, the daemon, and the spawned CLI
make relies **entirely** on Node/Electron's system-default CA verification
pipeline — chain-to-a-system-trusted-CA plus hostname match plus validity-window
check. Silverhand writes no custom verifier, pins nothing, and does not touch
the trust store; it only classifies the errors that pipeline produces. Handshake
failures collapse into a **closed set of three** typed codes so UI, logs, and
runbooks share a stable surface: `host_tls_chain_invalid` (untrusted / unverifiable
chain — the fallback for any TLS-class error not more specifically recognized),
`host_tls_hostname_mismatch`, and `host_tls_expired` (covers both expired and
not-yet-valid). Non-TLS errors (DNS / connect / timeout / HTTP 401/403) are _not_
folded into this taxonomy — they carry their own typed codes elsewhere.

`http://` (no TLS) is accepted **only** for the loopback literals
`{ localhost, 127.0.0.1, ::1, [::1] }` (the embedded-backend and local-dev case).
A non-loopback `http://` server URL is rejected (`insecure_remote_http_disallowed`)
unless the client is explicitly launched with `SILVERHAND_ALLOW_INSECURE_REMOTE=1`
(matched as the exact string `'1'`). That escape hatch is a client-side dev
opt-in, **not a supported production mode**: there is no self-signed / SPKI-pin
accept state.

The unverified-TLS bypass — `rejectUnauthorized: false` — is banned across the
entire client TLS surface, and the ban is enforced mechanically: a `pnpm test`
gate (`packages/shared/tests/no-insecure-tls.test.ts`) greps the production
source scopes (`apps/desktop/src/main`, `apps/desktop/src/preload`,
`packages/{host,backend,shared,cli}/src`) and fails on any occurrence. The
legitimate production count is exactly zero; test fixtures constructing bad TLS
contexts are out of scope by design.

---

## 2. Resource ownership model

The base ACL is **per-user resource visibility**. Every queryable resource
resolves to a `viewer_user_id` scope for a `user` principal; the request
handler scopes every read, write, and delete to that user. Visibility comes
from one of three orthogonal paths — there is **no** single global
`<resource>.user_id` shortcut where the schema already represents access via
membership edges.

Layered on top of this base, workspace **governance roles**
(`owner`/`admin`/`member`) grade what a member may do inside a workspace they
can see (rename, archive, manage members/agents). Roles do not replace the
visibility paths below — they refine authority _within_ a visible resource.
The role model, its storage, and the orthogonal agent-capability axis are
owned by `graded-permissions-v1.md`; §2.4 records only the storage anchor.

### 2.1 Three ownership / visibility paths

There are three classes of ACL path. Each resource picks exactly one:

| Class                       | Mechanism                                                                                         | Examples                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **A. Direct owner column**  | Resource carries `user_id` (or equivalent) FK; viewer's user_id must match.                       | `hosts.user_id`, `notifications.user_id`, `agents.created_by_user_id` (existing).                        |
| **B. Membership edge**      | Resource is reachable iff there is a row in a join table linking `(viewer_user_id, resource_id)`. | `workspaces` via `workspace_users`; conversations via `conversation_users` (existing membership tables). |
| **C. Inherited via parent** | Resource has no own ACL; resolves through its parent's class A or B path.                         | `messages` → conversation → workspace; `attachments` → message; `tasks` → message.                       |

### 2.2 Resource → ACL path table

| Resource                | Class | Path                                                                                           |
| ----------------------- | ----- | ---------------------------------------------------------------------------------------------- |
| `users`                 | n/a   | root identity                                                                                  |
| `hosts`                 | A     | `hosts.user_id`                                                                                |
| `agents`                | A     | `agents.created_by_user_id`                                                                    |
| `notifications`         | A     | `notifications.user_id`                                                                        |
| `workspaces`            | B     | `workspace_users(workspace_id, user_id)` membership                                            |
| `conversations`         | B     | `conversation_users(conversation_id, user_id)` membership (and inherited workspace membership) |
| `messages`              | C     | inherited via `messages.conversation_id` → conversation membership                             |
| `attachments` / `blobs` | C     | inherited via parent message / workspace                                                       |
| `tasks`                 | C     | inherited via `tasks.message_id` → conversation                                                |

Principal-source contract: a public route resolves a `user` principal from the
session bearer (no principal ⇒ registration gate refuses the route); an
internal agent route resolves an `agent` principal from its URL binding; a
`system` principal exists for backend-internal triggers and is never
HTTP-resolved. The authoritative statement of principal construction is §3.5 —
this table does not restate it. So "every route resolves a `viewer_user_id`"
holds for public routes only, not for internal agent or system contexts.

### 2.3 Per-user creation does not implicitly equal direct ownership

The frequent-but-wrong shorthand "every resource a user creates is owned by
that user" hides the membership/inheritance path. A user creating a workspace
becomes its first member (`workspace_users` row) with `owner` role, not a row
in `workspaces.user_id`. Class B scopes visibility through membership, so
widening a workspace to more humans (adding `workspace_users` rows) does not
change the ACL class.

### 2.4 Governance roles

Workspace governance roles are **live**: `WorkspaceRole = 'owner' | 'admin' |
'member'`, stored on `workspace_users.role` (the authoritative source), with a
denormalized `workspaces.owner_user_id` pointer. `canGovernWorkspace(ctx,
principal, workspaceId, minRole)` gates governance ops (`owner` ⊇ `admin` ⊇
`member`); `member` visibility still flows through the class-B membership edge.
Design, capability axis, and role→operation matrix are owned by
`graded-permissions-v1.md`.

Note the axis boundary: `conversation_users` has **no** role column —
conversation membership is binary (member or not). Governance roles are
workspace-scoped only. There is no `users.is_admin` / global-admin designation;
authority is per-workspace.

### 2.5 Cross-user namespace operations

Shared-workspace human membership and per-workspace role governance are
current: multiple humans can be members of one workspace, each with a role, and
`owner`/`admin` govern it per §2.4.

---

## 3. Authentication

### 3.1 Mechanism: email + password + session

**Identity vs credential split.** The `users` table is profile/human identity —
`name`, `display_name`, avatar, name uniqueness across users/agents. It is NOT
an email-only auth row. Auth-related state lives in dedicated tables; the
`users` row stays the profile root.

- `users`: keeps `name`, `display_name`, etc., plus `users.email`
  (unique-when-set) as the canonical login handle; profile fields stay
  authoritative for display.
- `user_password_credentials(user_id PK FK, password_hash, password_hash_params JSON, password_updated_at)` —
  Argon2id storage in its own table. A `users` row without a row here is a
  profile-only user (e.g. agents-as-actor metadata; embedded single-user
  bootstrap) and cannot log in until a credential is provisioned.
- `password_hash` uses Argon2id with parameters per current OWASP
  recommendation; specific values are not committed in this doc —
  implementation chooses per-env benchmark and stores them in
  `password_hash_params` so future migration is non-breaking.
- Signup takes the immutable mention handle from the user: body shape
  `{ email, password, name, display_name? }`, where `name` is REQUIRED and
  validated by `ParticipantNameSchema` at the route and re-asserted by
  `UserRepo.create` at the persistence boundary. `display_name` stays optional
  and is defaulted from the email local-part when absent — it is mutable, so a
  guessed default costs nothing irreversible, whereas `name` has no rename path
  and is re-parsed out of historical message text by the mention resolver, so it
  must not be guessed. There is no server-side handle deriver any more; the
  email→handle suggestion survives only as a renderer prefill
  (`suggestParticipantNameFromEmail`).
- A **human handle** (`users.name`), once held, is **never recycled**. There is no
  account-deletion path today, so nothing needs to be built for this; the
  constraint is on future work: if account deletion is added it must soft-delete,
  or otherwise keep the handle permanently reserved, so that no new subject can
  acquire an old one. `@mentions` are re-parsed out of stored message text at read
  time, so recycling a handle would silently re-point every historical mention of
  the previous holder (shiki, 2026-08-05). Scope note: this is a ruling about USER
  handles, and it deliberately is not stated for the namespace as a whole —
  `AgentRepo.delete` is a hard DELETE today, so an agent name IS reusable after
  deletion. Whether agent handles should be reserved too is the same question with
  the same mention argument behind it, but it is undecided and unimplemented; do
  not read this bullet as covering it.
- Login: `POST /auth/login {email, password}` → server resolves
  `users` row by email, joins `user_password_credentials`, validates → issues
  `user_token` (opaque session token) bound to a row in
  `auth_sessions(id, user_id, token_hash, created_at, last_used_at, revoked_at, user_agent, ip_first_seen)`.
- Session activity renewal: every HTTP authentication checks persisted revocation,
  idle expiry and user integrity. A recent session is read-only; activity is written
  only when at least five minutes have elapsed since its last persisted use. Due
  renewals recheck under the SQLite writer lock, so concurrent requests do not
  repeatedly write or revive a revoked session. The 30-day sliding idle lifetime
  therefore has up to approximately five minutes of activity/expiry precision loss.
  No client timer or in-memory session cache participates. Read admission observes
  committed state: an uncommitted revoke cannot cancel a previously admitted
  request. Existing WS rechecks remain non-renewing.
- Self-service password change: authenticated `GET /api/me/password` reports
  `has_password`; profile-only embedded identities have no change-password form.
  `POST /api/me/password {current_password, new_password}` verifies the current
  password and uses the signup password bounds (8–1024 UTF-16 units, no trimming).
  It atomically compares the verified credential, replaces it, and revokes all of
  that human's sessions, including the caller. A concurrent stale login cannot
  issue a new session against the replaced credential. Other humans and daemon
  credentials are unaffected. Success requires signing in again.
- Password requests are not logged or automatically retried. If the response is
  lost, the client instructs the user to sign in again; a late success may clear
  only its initiating login, never a later login. Existing event sockets recheck
  persisted session validity before application frames and on the 30-second
  heartbeat, without extending idle expiry. Revocation closes the socket before
  its next admitted frame; an already admitted frame can still be in flight.
- Token transport: `Authorization: Bearer <user_token>` on every HTTP call
  from desktop UI / renderer.
- Storage on desktop: the opaque `user_token` lives in a main-owned
  0600 plaintext file under `~/.silverhand/desktop/session.bin`. This is
  intentionally the same local-file policy used by `daemon-config.json`
  for `host_token`: the desktop is inside the trust boundary, and
  local encryption would not defend against user-level code execution.
  The renderer never sees the token; the file must not be copied into
  workspaces, logs, IPC payloads, attachments, or support bundles. Server
  storage remains hash-only and logout/session revoke invalidates the
  bearer immediately.
- The local credential-file policy applies uniformly to `session.bin`,
  `daemon-config.json` (`host_token`), and `server-profile.bin`:
  main/daemon-only access, mode 0600, opaque bearer values, renderer
  never receives credentials, no credential bytes in logs/IPC/attachments,
  and server-side revoke/rotation is the real containment boundary. If
  the threat model later changes to "untrusted desktop / multi-tenant
  managed endpoint / cloud-synced credential material", migrate all local
  long-lived credentials together to a real secret store instead of
  encrypting only one token class.

### 3.2 Server connection profile (single desktop-main transport source)

`server-profile.bin` is the **single desktop-main-owned source of `server_url`**
for every desktop↔backend transport, across both the pre-auth phase
(`GET /api/server/info`, signup, login) and the post-auth phase (proxied
`/api/*`, session refresh, the event WebSocket, host claim). It lives at
`~/.silverhand/desktop/server-profile.bin`, mode 0600, under the same local
credential-file policy as `session.bin` and `daemon-config.json`. Its persisted
shape is intentionally minimal — JSON with exactly `{ version, server_url,
created_at, updated_at }` (no token, no TLS/insecure flag, no SPKI pin; insecure
status is recomputed at runtime from the URL + env, never stored). The renderer
only ever receives a redacted view (`{ server_url, updated_at }`).

The daemon **never reads the profile.** It reads only the _derived_
`daemon-config.json` (`{ server_url, host_id, host_token, profile_version?,
allow_insecure_remote? }`). Updating the server URL is a two-phase operation:
phase 1 commits the profile atomically (temp file → fsync → rename, so a crash
before the rename leaves the prior profile intact); phase 2 derives a fresh
daemon-config from `{ profile.version, server_url, host_id, host_token }` and
sends the daemon a reload IPC. If phase 2 fails (config-write / reload-IPC /
ack / missing host token), the profile is already at the new generation while
the daemon still runs the old config; this is recorded as
`partial_apply_pending` and converges via a Retry, a daemon restart, or a
boot-time reconciliation that re-derives state by comparing `profile.version`
against `daemon-config.profile_version`. A pre-auth commit with no host claim
yet is _not_ pending — the next sign-in's host claim stamps the current profile
into the daemon-config it writes.

`profile.version` is a monotonic **generation counter** (floor 1, bumped on
every commit), not a schema version. It exists solely to drive that local
reconciliation and reload-fingerprint decision; it is a strict local-config
boundary and is **never** placed on any outbound WSS frame, backend HTTP
request, or `Authorization` header. The daemon↔backend protocol is unaware of
it — the daemon authenticates with `host_token` alone.

### 3.3 Logout vs sign-out-and-disable-host

Two distinct UX actions, two distinct mutations:

- **Logout (UI only)**: invalidates the current `auth_sessions` row and removes the local session file. Local Host's `host_token` is **not** affected — the daemon stays online (independent lifecycle).
- **Sign out and disable this host**: above, plus `POST /api/hosts/:id/revoke` for the local host. Daemon connection drops, won't reconnect.

Default UI button label: "Logout". The "disable this host too" affordance lives behind a secondary control or in the Hosts page, not as the default action.

### 3.4 Error response uniformity

`/auth/*` and `/setup/*` errors MUST NOT leak account-state distinguishability
(_email exists_, _email unknown_, _password wrong_, _credential row absent_).
The rule is **uniformity within the same route**, not "always 401":

- `POST /auth/login` and `POST /auth/signup` credential-failure path: 401
  with one generic `{error_code: "auth_failed"}` payload, identical body
  shape and timing across all credential-related failure causes (use
  constant-time compare; if a `users` row is absent, hash a dummy password
  before responding so timing is similar).
- Disabled signup (`SILVERHAND_DISABLE_SIGNUP=1`) returns 404 from
  `POST /auth/signup` — the same 404 a missing route returns. This is fine:
  it does not distinguish _email A is taken_ from _email B is free_; it
  only signals that signup is closed, which `/api/server/info` already
  exposes truthfully.
- Validation errors (malformed JSON, missing field) keep their normal 400
  shape; they do not distinguish account state.
- `POST /auth/signup` handle collision: 409 `{error_code: "handle_taken"}`,
  deliberately distinguishable. What §3.4 protects is CREDENTIAL state; a
  mention handle is public by construction (its purpose is that other people
  type it), and the user chooses it, so a caller who is not told which of the
  two unique fields collided cannot complete signup at all. One code covers both
  halves of the namespace (`users.name` UNIQUE and the cross-table trigger
  against `agents.name`) — which side holds the name is not the caller's
  business and not actionable. **Answer ordering is part of the contract**: the
  handle verdict is decided first and depends ONLY on the handle, so a taken
  handle answers the identical 409 whether or not the email is registered. The
  reverse order would turn the 401/409 pair into an email-existence oracle for
  anyone holding one known-taken handle. The same priority holds on the DB-conflict
  path: a UNIQUE/trigger failure proves the pre-check read was stale, so the
  handle is re-read and answered first rather than reporting whichever constraint
  SQLite happened to hit. Every signup attempt that REACHES identity resolution —
  i.e. signup is enabled and the body passed the request schema — pays exactly one
  Argon2id hash before either lookup, so neither answer is cheaper than the other.
  (Earlier exits, `signup_disabled` and `invalid input`, do not hash; they reveal
  configuration or request shape and read no identity state at all.) Accepted
  residual cost, stated rather than hidden: while signup is enabled an
  unauthenticated caller can probe whether a given handle exists, one full POST
  at a time. The _cheap_ oracle is what stays closed — there is no public,
  unauthenticated handle-availability endpoint, and the authenticated
  agent/workspace availability probes are not reused here.

Anti-enumeration applies to authentication outcomes, not to route
existence or to public naming. Implementations MUST add timing-equalisation for
the credential path; the disabled-signup 404 needs no special handling.

### 3.5 Principal source per route class (single owner of the identity axis)

Every request resolves exactly one `Principal` (`user` / `agent` / `system`),
but the **input source** differs by route class and is not negotiable by the
caller. This is the single authoritative statement of principal construction;
other docs reference it, they do not restate it.

| Route class                        | Principal kind | Source                                                                                                                    | Enforced by                                                           |
| ---------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| public `/api/*`                    | `user`         | session bearer (`user_token`) → `auth_sessions` subject                                                                   | `bearer.ts` sets the principal; no request-declared header is trusted |
| internal `/internal/agents/:aid/*` | `agent`        | URL `aid` + live runtime-slot bearer（scope / generation / daemon instance）；conversation 由显式地址或对象派生后单独授权 | `installInternalPrincipalMiddleware` + `RuntimePrincipalVerifier`     |
| backend-internal code              | `system`       | not HTTP-originated                                                                                                       | never resolved from a request                                         |

- **Internal routes reject the principal header (400, not silent-ignore).**
  `X-Silverhand-Principal` on any `/internal/*` route returns
  `400 principal header is not allowed on internal routes`. Machine identity
  has one combined source — URL agent id + live runtime bearer — so a second identity input would only
  create conflict: trusting the header would let any token-bearing process forge
  an agent identity (the URL/bearer binding wasted); trusting the URL would leave the
  header a decorative footgun a caller believes is effective. A hard 400 makes a
  mis-set header fail loudly at the caller rather than resolve to the wrong
  identity. (The header is not a public principal source either: the public
  bearer middleware is the only place a `user` principal is set; no legacy
  header is synthesised into one.)
- **`from_kind='system'` messages are never HTTP-originated.** The `system`
  principal exists only for backend-internal triggers (onboarding, lifecycle,
  provision). No HTTP route resolves a `system` principal, so a `from_kind =
'system'` insert must always be traceable to backend-internal code; the repo
  layer asserts this rather than relying on a route guard.

---

## 4. Registration

### 4.1 Open signup with disable env

- `POST /auth/signup {email, password, name, display_name?}` is open by default (see §3.1 for why `name` is required).
- `SILVERHAND_DISABLE_SIGNUP=1` env (read once at server startup, frozen) closes the route — returns 404, identical to other not-found.
- `GET /api/server/info` returns `{ signup_enabled: bool }` so desktop UI can render the right surface (signup form vs login-only) without round-tripping through a failed POST.
- Startup log prints the resolved value: `Signup: enabled (or: disabled)`.

### 4.2 What registration does NOT do

- No `bootstrap_policy` config, no `setup_secret`, no special first-user codepath.
- No invite tokens, no email verification, no password recovery via email, no rate limiting beyond what the HTTP layer offers.
- No anti-enumeration response masking for signup specifically (covered by §3.4 already).

The first user is just the first row in `users`. They have no special global role (workspace-scoped `owner` on their workspaces is a separate axis, §2.4).

### 4.3 Frozen at startup

`signup_enabled` is loaded from env once at server startup into an immutable config object. Auth/setup routes reference this in-memory object only; they do **not** read settings tables at request time. Hot-swap is forbidden; toggling signup requires a server restart. This keeps audit, testing, and reasoning straightforward.

---

## 5. Token / credential taxonomy

There are two live credential classes with **non-overlapping** lifetimes and authorities. Code treats them as distinct types (not generic `string`), and logs never print them in cleartext.

| Credential             | Bound to                      | Lifetime                                                     | Issued by                                                                                                                       | Used by                                | Revocation                                                                                                                                                    |
| ---------------------- | ----------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_token` (session) | `(user_id, auth_sessions.id)` | Long-lived (config; default 30d), refreshed on use           | `/auth/login` success                                                                                                           | desktop UI / Electron main HTTP client | Logout invalidates one session; DELETE all user sessions on password change                                                                                   |
| `host_token`           | `(user_id, host_id)`          | Long-lived, rotatable (`host_credentials.kind='long_lived'`) | `POST /api/hosts/claim_or_create` (local) or `POST /api/hosts` (remote/user-managed computer — returned as the `connect_token`) | Daemon outbound HTTP/WS only           | `POST /api/hosts/:id/revoke` (local) or `DELETE`/`disconnect` (user-managed) invalidates immediately (hard deny, no grace). Rotation has 60s grace — see §6.4 |

The `host_credentials.kind` enum has a second arm, `bootstrap`. It has **no
live issuance path** today: both local and remote provisioning mint a
`long_lived` `host_token` directly (remote returns it as the `connect_token`,
which the daemon presents to `GET /api/hosts/connect-token/resolve` and then
reuses as the WS bearer).

Rules the type system / interface enforces:

1. `user_token` is never sent to a daemon.
2. `host_token` is never visible to the renderer/UI process. The Electron
   main process may receive it (over an authenticated HTTP call using
   `user_token`) and write it to the daemon config file via privileged
   local FS, but it MUST NOT be forwarded over IPC to the renderer.
3. If a `bootstrap`-kind credential is ever issued, it is never persisted beyond its first exchange.

`installation_id` is **not** in this table because it is not a credential. It is a local stable id (`~/.silverhand/installation_id`, auto-generated UUID per fresh install) used solely to deduplicate auto-registration of the same desktop machine. Server may store it for display/recognition, but it never grants authority — it is paired with `user_token` proving who the user is, and only then maps to a `host_id`.

---

## 6. Host lifecycle flows

### 6.1 Local Host auto-register on desktop login

This flow runs in the Electron **main** process; the renderer only sees
"connected / not connected" state, never `host_token`.

```
[main] desktop login (POST /auth/login from main process)
       └─→ user_token issued, stored in main-owned 0600 local file
[main] read ~/.silverhand/installation_id (creates uuid if absent)
[main] POST /api/hosts/claim_or_create
         Authorization: Bearer <user_token>
         Body: { installation_id, label: os.hostname(), current_host_id? }
[server] resolves (user_id, installation_id):
         CASE A: existing host, not revoked
           → return { host_id, server_url }
              (host_token omitted only when main has a local daemon config
               for that host AND the server still has at least one active
               long_lived credential; stale/missing/revoked credentials force
               a replacement token without treating claim as rotation)
         CASE B: no existing host
           → CREATE host (user_id, installation_id, kind=local,
                          provisioning_source='app_install', label, ...)
           → ISSUE host_token
           → return { host_id, host_token, server_url }
         CASE C: existing host, revoked
           → fail-closed 409 "host_revoked"
              desktop UI shows "this device's host record was revoked;
              re-create it from the Hosts page" (no silent revival)
[main] write {host_id, host_token, server_url} to
       ~/.silverhand/daemon-config.json (mode 0600, owner-only)
[daemon] holds host_token on disk; presents it as the bearer on the
         outbound daemon↔backend transport (see transport note below)
```

**Transport note**: the daemon reaches the backend over an outbound channel —
a local `daemon-outbound.sock` in embedded mode, an outbound WSS in standalone
mode (`daemon-outbound-protocol.md`). `host_token` is the bearer on that
channel: issued, persisted, validated server-side by a generic
`verifyHostToken()`, and used to authorize host-scoped operations (placement
routing, revoke enforcement). (`daemon.sock` is the separate desktop
host-control IPC — revoke/rotate/disconnect — not the runtime data plane.)

Renderer-side surface: the renderer sends "log me in" / "log me out" IPCs
to main and observes connection state via subscription. It never receives
`host_token` or daemon config contents over IPC.

### 6.2 Remote Host provisioning (user-managed computer)

A `remote` Host — a "user-managed computer" (`provisioning_source =
'user_invite'`) — is provisioned from the desktop and attaches over the same
outbound transport as the local Host. The flow:

```
desktop UI → "Add computer"
[main] POST /api/hosts               Authorization: Bearer <user_token>
[server] CREATE host row (user_id, kind='remote',
                          provisioning_source='user_invite')
         ISSUE long_lived host_token
         RETURN { host_id, host, connect_token, daemon_npm_spec }
[main] desktop UI shows a copyable connect command carrying <connect_token>
user runs the command in the target env (another machine / container)
[remote daemon] GET /api/hosts/connect-token/resolve
                 Authorization: Bearer <connect_token>
[server] verifyHostToken(connect_token) + assert host.kind='remote',
         provisioning_source='user_invite', not revoked
         → RETURN { host_id }   (daemon learns its host id for local namespacing)
[remote daemon] opens outbound WS to server_url, presenting the same
                connect_token as the WS bearer
[main] PATCH /api/hosts/:id   finalizes the setup draft (display_label)
       after first daemon attach
```

Notes:

- The `connect_token` _is_ a `long_lived` `host_token` (§5) — there is no
  separate bootstrap-exchange step. `connect-token/resolve` only maps the token
  to its `host_id`; the token itself remains the WS credential.
- The connect command intentionally carries no host id; the daemon proves
  possession of the token and the server returns the id.
- Rotation is via `POST /api/hosts/:id/connect-token/rotate` (§6.4);
  teardown is `DELETE /api/hosts/:id` (hard delete of an empty user-managed
  computer) or `POST /api/hosts/:id/disconnect` (drop the live WS). A
  user-managed computer does not use the local `revoke` path.

### 6.3 Host revoke

```
authenticated user → desktop Settings → Local host → Revoke
[renderer] window.silverhand.revokeHost({ hostId })
[main]   POST /api/hosts/:id/revoke (Authorization: Bearer <user_token>)
[server] BEGIN
           mark host.revoked_at = now (only when not already revoked)
           bulk-mark host_credentials.revoked_at = now WHERE revoked_at IS NULL
         COMMIT
         broadcast disconnect to that host's WS
[daemon on revoked host] receives WS close → attempts reconnect
                          → server returns 401 host_revoked
                          → daemon transitions to
                          "revoked, manual intervention required"
[main]   if revoked host == current local host:
           remove daemon-config.json, set local_host_status = 'revoked'
[renderer] re-fetch BackendInfo; user is prompted to sign in again.
```

**Revoke has no grace window.** Revocation is the user's "this host should
stop acting on my behalf right now" signal; granting an in-flight grace
period would let a compromised or misbehaving host keep posting. After the
revoke transaction commits, the next request bearing that token MUST fail
fast — the token-validator's primary check is `host_credentials.revoked_at
IS NULL AND host.revoked_at IS NULL` (and missing-row → deny). The 60s
grace described in §6.4 applies to **rotation only**, never to revoke.

Soft-delete on both the `hosts` row (`hosts.revoked_at`) and every active
`host_credentials` row (`host_credentials.revoked_at = now`). The rows
stay for audit / placement-history continuity. Token-validator
treats `revoked_at != NULL` and missing row identically (deny).

**Invariants:**

- The route is **idempotent**: revoking an already-revoked host is a 200
  OK and still sweeps any straggler `host_credentials` rows whose
  `revoked_at` is NULL (reconciles half-failed prior runs). The
  `hosts.revoked_at` tombstone timestamp is NOT advanced on re-revoke —
  the original revocation moment is the audit anchor.
- **No row cascade.** `agents`, `workspaces`, `conversation_agents`,
  `conversations` rows that reference the revoked host are kept. The
  runtime placement boundary (`RuntimeHostPlacementResolver`) is what
  fails closed: any agent whose `host_id` resolves to a revoked host
  rejects start / message-deliver / clear-session at the runtime entrypoint.
  This means after revoke, **records remain but runtime capability is
  lost** until a future re-bind or migration. Confirm copy and docs MUST
  distinguish these two facts so users do not believe revoke deletes
  their conversation history.
- **Active-only `(user_id, installation_id)` UNIQUE.**
  Re-claiming the same installation after revoke transparently mints a
  new active host row; the old revoked row is preserved. This prevents
  "revoked your own local host → permanently locked out from this
  desktop" without any local-state surgery.
- **Owner check uses 404, not 403,** for missing or cross-user host ids
  (matches the route ACL convention "non-visible → 404", §2.5). No
  `host_id` enumeration through this surface.
- The route requires a **session bearer** (`requireSessionBearerUser`).

### 6.4 Host_token rotation

`host_token` rotation is **not** implicit on every claim. Implicit rotation breaks the daemon's existing connection or creates double-token races. There are two explicit rotation surfaces, one per Host kind:

- **Local Host — `POST /api/hosts/:id/rotate-token`** issues a new long_lived token; the
  prior credential's `expires_at` is set to `min(now+60_000, prior)` so it
  remains valid for the 60-second grace window; the new token is returned
  to the desktop main process, which writes `daemon-config.json` (mode 0600) atomically before the IPC return crosses the renderer boundary.
- **User-managed computer — `POST /api/hosts/:id/connect-token/rotate`** issues a fresh `connect_token` for the remote host. Unlike the local path there is no local daemon-config write; the operator re-copies the new connect command.

**Invariants (local `rotate-token`):**

- **Owner-only,** session bearer required. Cross-user / missing host id
  → 404 (no enumeration). Already-revoked host → 409
  `error_code: host_revoked`. Non-`local` kind → 409
  `error_code: kind_not_supported` — a user-managed computer rotates through
  `connect-token/rotate` instead, not this route.
- **Renderer never sees `host_token`.** The route response carries the
  cleartext token; `assertApiProxyPath` refuses to proxy
  `/api/hosts/*/rotate-token` through the generic `backend:request`
  IPC. Rotation flows exclusively through the dedicated
  `hosts:rotate` IPC, whose return shape strips the token and only
  echoes the updated `HostDto` plus a snapshot of
  `BackendInfo.local_host_*`.
- **Current-host hard guard.** `hosts:rotate` refuses any `hostId` that
  doesn't match `daemon-config.host_id`. Otherwise rotating an owned-
  but-non-current host and writing the response token to local
  daemon-config would silently re-bind this desktop to a different
  identity. The renderer also disables the rotate button for
  non-current rows; the main-side check is the authority.

### 6.5 Listing hosts

`GET /api/hosts` is **owner-scoped**:

- Session bearer required.
- Returns every host owned by the caller, including revoked rows
  (sorted active-first, then by `created_at`). `HostDto` includes
  `revoked_at` and `last_seen_at` so the Settings page can render
  audit history. Unfinalized user-invite drafts are hidden from this list (they surface only via `GET /api/hosts/:id`, §6.2).
- There is no cross-user host visibility.

---

## 7. Server deployment form

The server is **not** a desktop-only helper. It is a deployable Node server
artifact. The Node process is the shipped form.

### 7.1 Standalone Node.js process

Primary distribution form:

- Node.js 24+ runtime; `silverhand-server` is the primary process.
- Persistent state: `/var/lib/silverhand` or another absolute
  `SILVERHAND_DATA_DIR`.
  - `silverhand.db` (SQLite WAL)
  - `silverhand.db-wal` / `silverhand.db-shm` beside the DB file
  - `blobs/` (local blob storage)
  - `workspaces/` (per-workspace fs roots)
- `silverhand.db`, `silverhand.db-wal`, and `silverhand.db-shm` must remain in
  the same directory on the same filesystem.
- Listen: default `127.0.0.1:8080`; bind and expose it through the deployer's
  process supervisor / reverse proxy / Tailscale / etc.
- Logs write to stdout/stderr and to `logs/` under the data root when file
  logging is enabled.

Deployment example:

```
NODE_ENV=production \
SILVERHAND_DATA_DIR=/var/lib/silverhand \
SILVERHAND_LISTEN=127.0.0.1:8080 \
node packages/server/dist/server.js
```

Operators running under systemd, pm2, or a bare Node process own native
dependency installation/rebuild for the target Node ABI (`better-sqlite3`
included).

### 7.3 Configuration interface

**Configuration is via environment variables**, not CLI flags. CLI flags are for one-shot operations (§7.4), not for server lifecycle config. The full env list is in `docs/server-env-config.md`; key entries:

- `SILVERHAND_LISTEN` — `host:port` to bind, default `127.0.0.1:8080`
- `SILVERHAND_DATA_DIR` — persistent state root, default `/var/lib/silverhand`
- `SILVERHAND_DISABLE_SIGNUP` — `0|1`, default `0`
- `SILVERHAND_LOG_LEVEL` — `debug|info|warn|error`, default `info`
- `SILVERHAND_MIGRATE` — `0|1`; standalone default `0` (existing DB schema
  upgrades require operator opt-in), embedded desktop default `1` (auto-upgrade
  with the same pre-migration backup). Any allowed upgrade backs up the whole
  data dir to a sibling `<data_dir>-backup-<utc>/` before applying migrations

### 7.4 Admin operations (recovery / maintenance)

The server package includes `silverhand-server admin <subcommand>` for one-shot operational tasks. These are NOT part of the normal product flow; they are recovery tools. They exist because losing all desktop sessions or forgetting an email's password should not require re-deploying the server.

Available admin subcommands:

- `silverhand-server admin reset-password --email <x>` — masked prompt for new password; updates the credential through `PasswordCredentialService`; revokes all sessions for that user.

`--password` is intentionally unsupported. For non-interactive recovery, use
`--password-from-file <path>` with an owner-only secret file; the CLI unlinks it
after reading. Unknown emails fail with `user_not_found` and never create a new
user.

Invocation: `SILVERHAND_DATA_DIR=/var/lib/silverhand silverhand-server admin reset-password --email shiki@example.com`.

These commands talk to the same DB the running server uses; SQLite's WAL allows safe read-only or single-writer access. Admin commands MUST acquire the same connection lock the server uses (single-process writes).

### 7.5 Embedded mode

Embedded mode is the desktop app spawning the server in-process for fully-local users. The same Node server module is imported and a server is started inside the Electron main process. Listen is loopback (`127.0.0.1:0`, OS-picked port). Auth bootstrap differs only in that the desktop has direct file access to bootstrap a session:

- Server boot: writes a one-shot `bootstrap_session_token` to `~/.silverhand/embedded-bootstrap` (mode 0600, owner-only) before HTTP listen, and keeps only its hash in process memory.
- Desktop reads file → POSTs `/auth/embedded-bootstrap { token }` over loopback.
- Endpoint constraints (all four MUST hold): listen address is loopback ∈ `{127.0.0.1, ::1, unix-socket}`; route enabled only when `mode=embedded`; token is one-shot (consumed on first call); token is boot-session-scoped (server restart invalidates).
- On success: server returns a normal `user_token` (creates a profile-only local user if `users` is empty, reuses the sole existing user when exactly one exists, and fails loud with `bootstrap_ambiguous_user` when 2+ users exist). The bootstrap user has no `user_password_credentials` row; password login for that profile follows the ordinary missing-credential failure path.
- `SILVERHAND_DISABLE_SIGNUP=1` closes `/auth/signup` only. It does not disable embedded bootstrap, otherwise a local embedded first launch could self-lock.
- Event WS uses the same session subject via an Electron-main-owned `HttpOnly`, `SameSite=Strict`, `/api/ws/events` cookie. Ordinary REST routes still accept only `Authorization: Bearer <user_token>` from Electron main and do not read that cookie.

This makes embedded a deployment variant of remote, not a separate auth path. No HTTP-skipping privileged API exists.

---

## 8. Schema

The live tables and columns backing this model — `users`, `users.email`,
`user_password_credentials`, `auth_sessions`, `hosts`, `host_credentials`,
`workspace_users` (incl. `role`), `conversation_users` — and the append-only
migrations that define them are self-documenting in
`packages/shared/src/db/schema.ts` and `packages/shared/src/db/migrations.ts`.
Read those for the authoritative column set; this doc does not mirror DDL.

---

## 9. Invariants checklist

The following invariants hold; implementation PRs are auditable against this list.

### 9.1 Concept boundaries

1. User auth scope = desktop UI/session only. `user_token` never reaches daemon or agent process.
2. Host credential = execution environment only. `host_token` never reaches the renderer process — Electron main owns it, daemon receives it via privileged local FS, neither IPC nor HTTP exposes it to the renderer.
3. Daemon = replaceable connector instance. Daemon `instance_id` is per-boot; `host_id` is stable identity.
4. Agent placement references `host_id` only; agent identity does not embed any credential.
5. Provisioning mints a `long_lived` `host_token` directly (local via `claim_or_create`, remote as the `connect_token`); the `bootstrap` credential arm has no live producer. Any short-lived credential, if introduced, is never persisted past first exchange.
6. Revoking a Host kills daemon connectivity immediately (no grace) and prevents future runtime placement on it; it does NOT cascade-delete agents/conversations. Token-validator's primary check is `host_credentials.revoked_at IS NULL AND host.revoked_at IS NULL`.
7. `kind=sandbox` is not a Host kind. The schema arm is `local|remote`; sandboxing is a Host capability orthogonal to `kind`.

### 9.2 Implementation details

8. Embedded mode auto-issues credentials over the same HTTP API used in remote (via `/auth/embedded-bootstrap`); no privileged in-process shortcut.
9. Logout vs sign-out-and-disable-host are two distinct UX actions; default is logout-only. Logout clears the desktop session and local daemon config file but does **not** revoke the server-side Host row or its credentials; the next login reclaims the Host and receives a replacement token if the old local token is gone/stale.
10. `host_token` rotation is explicit (no auto-rotation on claim); 60s grace period applies to **rotation only**, never to revoke.
11. Teardown differs by kind: a local Host is soft-deleted via `POST /api/hosts/:id/revoke` (soft-delete on `hosts.revoked_at` AND `host_credentials.revoked_at`; token-validator denies on either set or row missing; rows stay for audit). A user-managed computer is hard-deleted via `DELETE /api/hosts/:id` (empty only) or dropped via `disconnect`.
12. Argon2id parameters are not hard-coded in the doc or implementation; stored in `user_password_credentials.password_hash_params`, set per environment per OWASP recommendation.
13. `/auth/embedded-bootstrap` constraints (all four hold): loopback-only listen + one-shot + boot-session scoped + only when `mode=embedded`. Failing any returns 404.
14. `SILVERHAND_DISABLE_SIGNUP` and other auth-relevant config are loaded once at server startup into immutable in-memory config; auth routes do not re-read settings tables at request time.
15. Auth credential storage is split from profile identity: `users` keeps profile fields; `user_password_credentials` is a separate one-to-zero-or-one table. Profile-only `users` rows (no credential row) cannot log in.

### 9.3 ACL and information

16. Every resource picks exactly one of three ACL classes (direct owner column / membership edge / inherited via parent) per §2.1. Routes do not invent ad-hoc paths.
17. Open signup ≠ no ACL. Every public route resolves a principal per §3.5: a `user` principal scopes reads/mutations by `viewer_user_id` (no principal → 403 registration gate); internal agent routes carry an `agent` principal from the URL binding; `system` is backend-internal only.
18. Auth/setup error responses are uniform within the same route for CREDENTIAL facts — no enumeration of email/password/credential-row distinguishability. Disabled-signup 404 is allowed; credential-failure path is always 401 with constant-time compare. Signup's 409 `handle_taken` is the one deliberate exception and is scoped to a public, user-chosen name, never to credential state (§3.4).
19. `installation_id` is a stable local id only, not an auth factor. Hardware machine fingerprint is at most a UI display hint, never a permission boundary.
20. Existing host record + revoked_at set + new claim attempt → 409 fail-closed, no silent revival.

### Embedded initial profile completion

The automatic embedded session remains a normal authenticated human session.
Step99 adds `users.embedded_profile_pending`, defaulting to false for existing
identities (including historical default names) and remote signups. Only the
transaction that creates a new embedded bootstrap identity sets it to true;
selecting an existing identity never changes it. No local cache or name heuristic
controls completion. The existing 2+ user bootstrap ambiguity is unchanged.

Authenticated `GET /api/me/embedded-profile-setup` returns `{required,user}`.
Embedded-only `PUT` accepts `{name,display_name}`, reusing existing handle and
display-name validation and the global users/agents handle namespace. Under one
write transaction it rechecks pending, commits both fields, and clears pending.
Completed identities reject all later requests with 409 `profile_setup_completed`;
name collisions return 409 `name_taken`. A missing or invalid human session is
refused; remote deployments return 403 `embedded_only` even for authenticated users.
There is no caller-selected user ID or new credential flow.

The completion response carries the current viewer and the existing post-commit
`user_changed` invalidation is emitted. Clients apply that viewer before entering
the main screen. If a response is lost, re-read the durable status rather than
attempting a rename. Optional avatar upload uses the existing separate endpoint;
its failure cannot roll back successful core completion or imply setup is pending.
The renderer may upload after completing the core profile and report avatar errors
separately. Existing profile/remote login behavior is unchanged.

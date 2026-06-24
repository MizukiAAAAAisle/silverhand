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

- **Host** — `id, user_id, kind=local|remote, label, capabilities, status,
  installation_id, created_at, last_seen_at, revoked_at`. The execution
  environment. Identity unit users see, manage, and revoke.
- **Daemon** — runtime connector running inside a Host. A replaceable instance
  that consumes a Host's credential and supervises agent processes. Daemon
  instance id ≠ host id.
- **Agent** — actor/config that runs on some Host. Has placement
  (`default_host_id` etc.) but does not embed a Host credential.

V1 ships exactly one Host kind in scope: `local` (the user's desktop). The
existing `HostKindSchema` is `local|remote`; this doc keeps that schema
unchanged. *Sandbox is not a Host kind* — per `multi-daemon-registry.md`,
sandboxing is a Host capability / mount concern, not an enum tag. A future
sandbox-provisioning flow (Appendix A.5) MUST come with its own HostKind
redesign decision; V1 does not pre-commit either schema or provisioning.

### 1.1 HOSTS uniformity (top-level invariant)

`local` Hosts and `remote` Hosts are the **same first-class entity** at the
auth and wire layers. All differences are confined to provisioning and
capability metadata; the credential, validation, transport, and lifecycle
control plane are identical.

| Concern | local Host | remote Host |
|---|---|---|
| DB row | `hosts` (one row, `kind='local'`) | `hosts` (one row, `kind='remote'`) |
| Credential row | `host_credentials` (one or more `kind=long_lived`) | `host_credentials` (one `kind=bootstrap` consumed at first exchange, then one or more `kind=long_lived`) |
| Mint authority | `user_token` session via `POST /api/hosts/claim-or-create` (§6.1) | `user_token` session via `POST /api/hosts` (§6.2) — desktop is always the trust anchor |
| Wire auth | `Authorization: Bearer <host_token>` on `GET /api/hosts/connect` | identical |
| Server validator | `HostTokenService.verifyHostToken()` | identical (no separate code path) |
| Outbound transport | one outbound WebSocket per Host (D2) | identical |
| Rotation | `POST /api/hosts/{id}/rotate-token` + `rotate_token` WS command + 60s grace (§6.4 / D2.f) | identical |
| Revoke | `POST /api/hosts/{id}/revoke` (hard deny, no grace) | identical |
| Placement key | `agent.host_id` → `RuntimeHostPlacementResolver` | identical (resolver is host-kind-agnostic) |
| Capability layer | `host_capabilities.*` rows describe local fs / mounts | identical mechanism; sandbox profile etc. attach here (Appendix A.5) |

What this invariant buys:
- Adding a new Host kind in the future (`remote_sandbox`, `cloud`, …) requires
  only enum extension + a new provisioning entry route. **Wire schema, auth
  validator, transport, rotation, revoke, and placement code paths do not
  change.**
- A user-facing "create sandbox" UX is the same shape as remote-host
  provisioning (§6.2): desktop UI calls server, server mints a Host row +
  bootstrap token, the user delivers the bootstrap into the target environment.
  The sandbox daemon then exchanges to long-lived `host_token` and connects
  via the same `/api/hosts/connect` endpoint as the local daemon.
- The desktop is always the trust anchor for any new Host. There is no
  zero-trust path where a Host claims itself into existence — every Host's
  first credential is minted by a logged-in user session in the desktop UI,
  whether the daemon will run on the desktop machine or elsewhere.

V1 narrows the active surface to `local` only (D2 endpoint, claim-or-create
route, desktop UI) but the schema, protocol, and code paths are already
shaped for `remote` to be opened later by enum widening + provisioning UI,
not by re-architecting the auth model.

---

## 2. Resource ownership model

V1 ACL is **per-user resource visibility**, not RBAC. Every queryable
resource MUST resolve to a `viewer_user_id` scope; the request handler MUST
scope every read, write, and delete to that user. Visibility comes from one
of three orthogonal paths — V1 does **not** invent a single global
`<resource>.user_id` shortcut where the schema already represents access via
membership edges.

### 2.1 Three ownership / visibility paths

V1 distinguishes three classes of ACL path. Each resource picks exactly one:

| Class | Mechanism | Examples |
|---|---|---|
| **A. Direct owner column** | Resource carries `user_id` (or equivalent) FK; viewer's user_id must match. | `hosts.user_id`, `notifications.user_id`, `agents.created_by_user_id` (existing). |
| **B. Membership edge** | Resource is reachable iff there is a row in a join table linking `(viewer_user_id, resource_id)`. | `workspaces` via `workspace_users`; conversations via `conversation_users` (existing membership tables). |
| **C. Inherited via parent** | Resource has no own ACL; resolves through its parent's class A or B path. | `messages` → conversation → workspace; `attachments` → message; `tasks` → message. |

### 2.2 Resource → ACL path table

| Resource | Class | Path |
|---|---|---|
| `users` | n/a | root identity |
| `hosts` | A | `hosts.user_id` |
| `agents` | A | `agents.created_by_user_id` (existing column) |
| `notifications` | A | `notifications.user_id` |
| `workspaces` | B | `workspace_users(workspace_id, user_id)` membership |
| `conversations` | B | `conversation_users(conversation_id, user_id)` membership (and inherited workspace membership) |
| `messages` | C | inherited via `messages.conversation_id` → conversation membership |
| `attachments` / `blobs` | C | inherited via parent message / workspace |
| `tasks` | C | inherited via `tasks.message_id` → conversation |

Implementation invariant: every route handler MUST resolve a `viewer_user_id`
from the request's session token before any DB read; routes that cannot
resolve one MUST return 401. There is no "global" or "system" view in V1
beyond admin recovery commands (§7.4).

### 2.3 Per-user creation does not implicitly equal direct ownership

The frequent-but-wrong shorthand "every resource a user creates is owned by
that user" hides the membership/inheritance path. A user creating a workspace
becomes its first member (workspace_users row), not a row in `workspaces.user_id`.
Class B is still scoped to the creator in V1 because membership starts at
size 1, but the data model permits later widening (V1.5 invite + workspace
sharing) without changing class.

### 2.4 No RBAC fields in V1

- No `users.is_admin`, no `users.role`, no `roles` table.
- No "owner" or "admin" designation among users in the data model.
- No "user A invites user B" flow (V1.5+).

A user's only authorisation in V1 is the implicit "I can see and modify
resources whose ownership chain ends at my `user_id`."

### 2.5 What cross-user namespace operations look like

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

**Identity vs credential split** (P1 review fix). The existing `users` table
is profile/human identity — `name`, `display_name`, avatar, name uniqueness
across users/agents. V1 does NOT reshape it into an email-only auth row.
Auth-related state lives in dedicated tables, the `users` row stays the
profile root.

- `users` (existing, augmented): keeps `name`, `display_name`, etc. V1 adds
  `users.email` (unique nullable until first auth-enabled user, then
  enforced) **only as the canonical login handle**; profile fields stay
  authoritative for display.
- `user_password_credentials(user_id PK FK, password_hash, password_hash_params JSON, password_updated_at)` —
  Argon2id storage in its own table. A `users` row without a row here is a
  legacy profile-only user (e.g. agents-as-actor metadata; v0 single-user
  fallback) and cannot log in until a credential is provisioned.
- `password_hash` uses Argon2id with parameters per OWASP current
  recommendation; specific values are not committed in this doc —
  implementation chooses per-env benchmark and stores them in
  `password_hash_params` so future migration is non-breaking.
- Signup MUST populate `users.name` / `users.display_name` (defaults derived
  from email local-part if user does not provide them) so the new row is
  valid against existing profile constraints + uniqueness; signup body
  shape: `{ email, password, display_name? }`.
- Login: `POST /auth/login {email, password}` → server resolves
  `users` row by email, joins `user_password_credentials`, validates → issues
  `user_token` (opaque session token) bound to a row in
  `auth_sessions(id, user_id, token_hash, created_at, last_used_at, revoked_at, user_agent, ip_first_seen)`.
- Token transport: `Authorization: Bearer <user_token>` on every HTTP call
  from desktop UI / renderer.
- Storage on desktop: V1 stores the opaque `user_token` in a main-owned
  0600 plaintext file under `~/.silverhand/desktop/session.bin`. This is
  intentionally the same local-file policy used by `daemon-config.json`
  for `host_token`: the desktop is inside the V1 trust boundary, and
  local encryption would not defend against user-level code execution.
  The renderer never sees the token; the file must not be copied into
  workspaces, logs, IPC payloads, attachments, or support bundles. Server
  storage remains hash-only and logout/session revoke invalidates the
  bearer immediately.
- V1 local credential file policy applies uniformly to `session.bin`,
  `daemon-config.json` (`host_token`), and `server-profile.bin`:
  main/daemon-only access, mode 0600, opaque bearer values, renderer
  never receives credentials, no credential bytes in logs/IPC/attachments,
  and server-side revoke/rotation is the real containment boundary. If
  the threat model later changes to "untrusted desktop / multi-tenant
  managed endpoint / cloud-synced credential material", migrate all local
  long-lived credentials together to a real secret store instead of
  encrypting only one token class.

### 3.2 Provider interface reserved for V2

V1 has exactly one auth provider (`password`) and ships the credential
table for it (`user_password_credentials`). When V2 adds OAuth, it
introduces a sibling `user_auth_links(user_id, provider, provider_user_id,
email, linked_at)` table in the same migration that ships the route — V1
does NOT pre-create an empty OAuth table.

V2 provider list (planned, not committed):

- `password` (V1)
- `github_oauth`
- `google_oidc`
- (later) `enterprise_sso` via OIDC/SAML

Regardless of provider, every successful auth ends in the same `auth_sessions` row + same `user_token` shape. Provider only changes how identity is proven, not what identity yields.

### 3.3 Logout vs sign-out-and-disable-host

Two distinct UX actions, two distinct mutations:

- **Logout (UI only)**: invalidates the current `auth_sessions` row and removes the local session file. Local Host's `host_token` is **not** affected — the daemon stays online (independent lifecycle).
- **Sign out and disable this host**: above, plus `POST /api/hosts/{id}/revoke` for the local host. Daemon connection drops, won't reconnect.

Default UI button label: "Logout". The "disable this host too" affordance lives behind a secondary control or in the Hosts page, not as the default action.

### 3.4 Error response uniformity

`/auth/*` and `/setup/*` errors MUST NOT leak account-state distinguishability
(*email exists*, *email unknown*, *password wrong*, *credential row absent*).
The rule is **uniformity within the same route**, not "always 401":

- `POST /auth/login` and `POST /auth/signup` credential-failure path: 401
  with one generic `{error_code: "auth_failed"}` payload, identical body
  shape and timing across all credential-related failure causes (use
  constant-time compare; if a `users` row is absent, hash a dummy password
  before responding so timing is similar).
- Disabled signup (`SILVERHAND_DISABLE_SIGNUP=1`) returns 404 from
  `POST /auth/signup` — the same 404 a missing route returns. This is fine:
  it does not distinguish *email A is taken* from *email B is free*; it
  only signals that signup is closed, which `/api/server/info` already
  exposes truthfully.
- Validation errors (malformed JSON, missing field) keep their normal 400
  shape; they do not distinguish account state.

Anti-enumeration applies to authentication outcomes, not to route
existence. Implementations MUST add timing-equalisation for the credential
path; the disabled-signup 404 needs no special handling.

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
| `user_token` (session) | `(user_id, auth_sessions.id)` | Long-lived (config; default 30d), refreshed on use | `/auth/login` success | desktop UI / Electron main HTTP client | Logout invalidates one session; DELETE all user sessions on password change |
| `host_token` | `(user_id, host_id)` | Long-lived (default 90d, rotatable) | First-time exchange of `host_bootstrap_token` (or auto-issue on local-host claim, see §6.1) | Daemon outbound HTTP/WS only | `POST /api/hosts/{id}/revoke` invalidates immediately (hard deny, no grace). Rotation has 60s grace — see §6.4 |
| `host_bootstrap_token` | `(user_id, host_id, single_use)` | Short (default 15min, one-shot) | `POST /api/hosts` when creating a remote host | Daemon's first-ever connect, exchanged for `host_token` | Single-use; consumed on first exchange. Time-expiry as backup. |

Three rules that the type system / interface MUST enforce:

1. `user_token` is never sent to a daemon.
2. `host_token` is never visible to the renderer/UI process. The Electron
   main process may receive it (over an authenticated HTTP call using
   `user_token`) and write it to the daemon config file via privileged
   local FS, but it MUST NOT be forwarded over IPC to the renderer.
3. `host_bootstrap_token` is never persisted beyond its first exchange.

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
[main] POST /api/hosts/claim-or-create
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
           → CREATE host (user_id, installation_id, kind=local, label, ...)
           → ISSUE host_token
           → return { host_id, host_token, server_url }
         CASE C: existing host, revoked
           → fail-closed 409 "host_revoked"
              desktop UI shows "this device's host record was revoked;
              re-create it from the Hosts page" (no silent revival)
[main] write {host_id, host_token, server_url} to
       ~/.silverhand/daemon-config.json (mode 0600, owner-only)
[main] existing local daemon transport remains unchanged in Stage B
[daemon] holds host_token on disk; presents it on whatever transport
         the daemon ↔ server channel uses (see transport note below)
```

**Transport note**: V1 (Stage B; stages now in `remote-backend-architecture-notes.md`) keeps
the existing pre-outbound transport — backend / Electron main dials the
daemon's Unix socket via `HostClient`. The daemon does NOT initiate
HTTP/WS calls to the backend in V1. Adding `host_token` to the request
shape of an outbound daemon-initiated channel is the
**follow-up phase** (daemon outbound protocol). Stage B's contract for
`host_token` is: it is issued, persisted, validated by a generic
`verifyHostToken()` server-side, and used to authorize host-scoped
operations the server performs (placement routing, revoke enforcement).
Stage B does NOT introduce a new daemon-initiated authenticated
connection.

Renderer-side surface: the renderer sends "log me in" / "log me out" IPCs
to main and observes connection state via subscription. It never receives
`host_token`, `host_bootstrap_token`, or daemon config contents over IPC.

### 6.2 Remote Host provisioning (V1.5+, schema arm exists, no V1 surface)

The existing `HostKindSchema` already has `local|remote`. V1 ships `local`
end-to-end; `remote` is the next step (headless daemon binary, sandbox
provisioning, etc.). The **provisioning flow** below is the planned shape;
V1 implementation MUST NOT ship the desktop UI surface or the headless
daemon binary, but the protocol shape is fixed here so Phase 4 has a target:

```
desktop UI → "Hosts" page → "Add remote host"
  user inputs: label
[main] POST /api/hosts { kind: 'remote', label }
       Authorization: Bearer <user_token>
[server] CREATE host row (user_id, installation_id=null, kind=remote)
         ISSUE host_bootstrap_token (15min one-shot, scope=host_id)
         RETURN { host_id, host_bootstrap_token, server_url }
[main] desktop UI shows: silverhand-daemon bootstrap eyJzZXJ2ZXIi...
       (base64 of {server_url, host_id, host_bootstrap_token})
user copies bootstrap string, runs in target env (Docker / k8s / VM)
[remote daemon] parses payload, POST /api/hosts/{id}/exchange
                 Authorization: Bearer <host_bootstrap_token>
[server] validates bootstrap token (not yet consumed, not expired,
         matches host_id) → ISSUE host_token (long-lived)
         → mark host_bootstrap_token consumed
[remote daemon] stores host_token, opens outbound WS to server_url
```

**V1 ship scope from this section: nothing** (other than the existing
`hosts.kind` enum already supporting `remote`). The protocol shape above
is documented here so Phase 4 / V1.5 has a fixed target, but V1
implementation MUST NOT ship `POST /api/hosts` (kind=remote create),
`POST /api/hosts/{id}/exchange`, the desktop "Add remote host" UI, or the
headless daemon binary. Those routes carry their own threat model
(bootstrap-token leak surface, exchange replay, daemon outbound auth) and
should land **with** their callers and headless daemon binary, not ahead
of them — exposing an exchange endpoint without a real consumer means
shipping unaudited surface area. V1's only host routes are the local-host
set: `claim-or-create`, `revoke`, `rotate-token` (§6.1 / §6.3 / §6.4).

*Sandboxing as a Host capability* (chroot, seccomp, namespace mounts,
ephemeral fs) is orthogonal to `kind` and out of scope here; see Appendix
A.5 for the future track.

### 6.3 Host revoke

```
authenticated user → desktop Settings → Local host → Revoke
[renderer] window.agentHub.revokeHost({ hostId })
[main]   POST /api/hosts/{id}/revoke (Authorization: Bearer <user_token>)
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
stay for audit / placement-history continuity; physical row removal is a
future compaction concern, not a revoke responsibility. Token-validator
treats `revoked_at != NULL` and missing row identically (deny).

**Stage B.4 invariants:**

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
- **Active-only `(user_id, installation_id)` UNIQUE** (migration v31).
  Re-claiming the same installation after revoke transparently mints a
  new active host row; the old revoked row is preserved. This prevents
  "revoked your own local host → permanently locked out from this
  desktop" without any local-state surgery (the previous design had the
  partial-unique cover any non-null pair, which made re-claim 409).
- **Owner check uses 404, not 403,** for missing or cross-user host ids
  (matches the route ACL convention from A.3 §2.5: "non-visible →
  404"). No `host_id` enumeration through this surface.
- The route requires a **session bearer** (`requireSessionBearerUser`).
  The retired embedded server-config token is not accepted by public
  bearer auth at all, so a pre-Stage-A renderer cannot reach it by
  forging viewer headers.

### 6.4 Host_token rotation

`host_token` rotation is **not** implicit on every claim. Implicit rotation breaks the daemon's existing connection or creates double-token races. Explicit rotation:

- `POST /api/hosts/{id}/rotate-token` issues a new long_lived token; the
  prior credential's `expires_at` is set to `min(now+60_000, prior)` so it
  remains valid for the 60-second grace window; the new token is returned
  to the desktop main process, which writes `daemon-config.json` (mode
  0600) atomically before the IPC return crosses the renderer boundary.
- Daily auto-rotation by server is a future hardening option; V1 does no auto-rotation.

**Stage B.4 invariants:**

- **Owner-only,** session bearer required. Cross-user / missing host id
  → 404 (no enumeration). Already-revoked host → 409
  `error_code: host_revoked`. Non-`local` kind → 409
  `error_code: kind_not_supported` (V1 surface only rotates the user's
  local host; remote / sandbox hosts have no UI yet, so their rotation
  channel is reserved for the future remote-daemon era).
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

`GET /api/hosts` is **owner-scoped** (Stage B.4 viewer filter):

- Session bearer required. A retired server-config bearer is treated as
  an invalid public bearer (401) before the host route runs.
- Returns every host owned by the caller, including revoked rows
  (sorted active-first, then by `created_at`). `HostDto` includes
  `revoked_at` and `last_seen_at` so the Settings page can render
  audit history.
- The previous unscoped behaviour ("return all rows in the `hosts`
  table") is gone. There is no production caller that needed
  cross-user host visibility.

---

## 7. Server deployment form

The server is **not** a desktop-only helper. It is a deployable Node server
artifact. V1 route 1 ships the Node process first; an official Docker image is
deferred until the server has passed local/remote soak.

### 7.1 Standalone Node.js process

Primary V1 distribution form:

- Node.js 24+ runtime; `silverhand-server` is the primary process.
- Persistent state: `/var/lib/silverhand` or another absolute
  `SILVERHAND_DATA_DIR`.
  - `silverhand.db` (SQLite WAL)
  - `silverhand.db-wal` / `silverhand.db-shm` beside the DB file
  - `blobs/` (local blob storage)
  - `workspaces/` (per-workspace fs roots; future host-bound resolution per `[depends: workspace-fs-decision]`)
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

### 7.2 Future Docker image

The official Docker image is deferred until after V1 route-1 soak. When it
lands, it must preserve the same env contract, data-root layout, and single
replica SQLite/WAL invariant.

### 7.3 Configuration interface

**Configuration is via environment variables**, not CLI flags. CLI flags are for one-shot operations (§7.4), not for server lifecycle config. The full env list is committed in `docs/server-env-config.md` (to be written alongside V1 implementation), key entries:

- `SILVERHAND_LISTEN` — `host:port` to bind, default `127.0.0.1:8080`
- `SILVERHAND_DATA_DIR` — persistent state root, default `/var/lib/silverhand`
- `SILVERHAND_DISABLE_SIGNUP` — `0|1`, default `0`
- `SILVERHAND_LOG_LEVEL` — `debug|info|warn|error`, default `info`
- `SILVERHAND_MIGRATE` — `0|1`; standalone default `0` (existing DB schema
  upgrades require operator opt-in), embedded desktop default `1` (auto-upgrade
  with the same pre-migration backup). Any allowed upgrade backs up the whole
  data dir to a sibling `<data_dir>-backup-<utc>/` before applying migrations
- (V2 / Appendix A) `SILVERHAND_AUTH_PROVIDERS` — comma list

### 7.4 Admin operations (recovery / maintenance)

The server package includes `silverhand-server admin <subcommand>` for one-shot operational tasks. These are NOT part of the V1 product flow; they are recovery tools. They exist because losing all desktop sessions or forgetting an email's password should not require re-deploying the server.

Available admin subcommands in V1:

- `silverhand-server admin reset-password --email <x>` — masked prompt for new password; updates the credential through `PasswordCredentialService`; revokes all sessions for that user.

`--password` is intentionally unsupported. For non-interactive recovery, use
`--password-from-file <path>` with an owner-only secret file; the CLI unlinks it
after reading. Unknown emails fail with `user_not_found` and never create a new
user. List/revoke-style admin commands are deferred until their auth and audit
surface is intentionally scoped.

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

## 8. Schema migration map

Three classes of changes:

### 8.1 Reuse (existing fields, V1 keeps semantics)

- `users` table — exists today as profile/identity (name, display_name,
  avatar). V1 keeps profile fields untouched; signup writes additional
  rows in new auth tables and a new `email` column on `users` (see §8.3).
- `agents.created_by_user_id` — already an FK to `users.id`. V1 uses it as the authoritative agent owner.
- `messages.from_user_id` — exists for authorship attribution. V1 keeps as authorship metadata; ACL still flows through conversation→workspace membership.
- `notifications.user_id` — exists. V1 uses as per-user inbox.
- `workspace_users`, `conversation_users` — existing membership tables. V1
  uses them as the class-B ACL edge per §2; no schema change.

### 8.2 Reinterpret (existing column, new semantic)

- `app_settings.viewer_user_id` — deprecated legacy row. V1 no longer
  writes or reads it as a current-viewer bridge; viewer identity is
  sourced from the resolved session subject, and viewer-scope fanout uses
  membership tables. The row/key may stay until D-stage schema cleanup.
- `hosts` table — currently registry-scoped. V1: becomes the user-facing
  Host concept (per `multi-daemon-registry.md`). `kind` enum stays
  `local|remote`. Add `installation_id`, `revoked_at`, `last_seen_at` if
  not yet present (verify in implementation); `user_id` FK should already
  be there. `kind=sandbox` is **not** added in V1.

### 8.3 New (V1 additions)

- `users.email` — unique-when-set (`UNIQUE` index on non-NULL). May already
  exist; verify. Profile rows that predate auth migration keep `email
  IS NULL` and cannot log in until upgraded.
- `user_password_credentials(user_id PK FK→users.id, password_hash, password_hash_params JSON, password_updated_at)` —
  one-to-zero-or-one with `users`. Argon2id storage isolated from profile
  identity. Future providers (OAuth) MUST add their own credential tables
  rather than reusing this one.
- `auth_sessions(id, user_id, token_hash, created_at, last_used_at, revoked_at, user_agent, ip_first_seen)` — session table.
- `host_credentials(id, host_id, token_hash, kind=long_lived|bootstrap, expires_at, consumed_at, revoked_at)` — host token storage. Single table with `kind` enum is preferred over two parallel tables.

### 8.4 Deferred to V2

- `user_auth_links(user_id, provider, provider_user_id, email, linked_at)`
  — OAuth provider linkage. V1 has no OAuth, no need to ship empty table;
  the V2 migration that adds `github_oauth` introduces this table together
  with the route. (Closes Cindy's open question on review round 1.)

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
- `/api/hosts/claim-or-create`, `/api/hosts/{id}/rotate-token`, `/api/hosts/{id}/revoke` routes (local-host scope only). Remote-host create + `/api/hosts/{id}/exchange` are deferred to Phase 4 / V1.5 along with the headless daemon binary — see §6.2.
- Backend `RuntimeHostRegistry` abstraction over today's single `hostClient`. Cache keys gain `host_id` dimension. Run-state cache: per-host generation.
- `conversation_agents.runtime_host_id` (or equivalent placement state) on the conversation/agent join row.
- Tests: every runtime intent route through registry lookup (even when there's only one entry).

### Phase 2 — Standalone server entrypoint (~1 week)

Make `packages/backend` a deployable service:

- New `packages/server` binary that wraps `startBackend(...)` for non-embedded use.
- Env-driven config (per §7.3); replace constructor args.
- Node process deployment/runbook for systemd, pm2, or bare Node.
- Persistent state layout per §7.1.
- Official Dockerfile + multi-stage image publish workflow deferred until
  after V1 route-1 soak.
- TLS not committed in V1 server package — deployer's reverse proxy is
  responsible.

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
2. Host credential = execution environment only. `host_token` never reaches the renderer process — Electron main owns it, daemon receives it via privileged local FS, neither IPC nor HTTP exposes it to the renderer.
3. Daemon = replaceable connector instance. Daemon `instance_id` is per-boot; `host_id` is stable identity.
4. Agent placement references `host_id` only; agent identity does not embed any credential.
5. `host_bootstrap_token` is short-lived, exchanged for `host_token`, never persisted past first exchange.
6. Revoking a Host kills daemon connectivity immediately (no grace) and prevents future runtime placement on it; it does NOT cascade-delete agents/conversations. Token-validator's primary check is `host_token.revoked_at IS NULL AND host.revoked_at IS NULL`.
7. `kind=sandbox` is NOT a V1 Host kind. The schema arm is `local|remote`; sandboxing is a future Host capability orthogonal to `kind`.

### 10.2 Implementation details

8. Embedded mode auto-issues credentials over the same HTTP API used in remote (via `/auth/embedded-bootstrap`); no privileged in-process shortcut.
9. Logout vs sign-out-and-disable-host are two distinct UX actions; default is logout-only. Logout clears the desktop session and local daemon config file but does **not** revoke the server-side Host row or its credentials; the next login reclaims the Host and receives a replacement token if the old local token is gone/stale.
10. `host_token` rotation is explicit (no auto-rotation on claim); 60s grace period applies to **rotation only**, never to revoke.
11. `DELETE /api/hosts/{id}` does not exist in V1; only `POST /api/hosts/{id}/revoke` (soft-delete on `hosts.revoked_at` AND `host_credentials.revoked_at`; token-validator denies on either set or row missing). Physical row removal is a future compaction concern, not a revoke responsibility.
12. Argon2id parameters are not hard-coded in the doc or implementation; stored in `user_password_credentials.password_hash_params`, set per environment per OWASP recommendation.
13. `/auth/embedded-bootstrap` constraints (all four MUST hold): loopback-only listen + one-shot + boot-session scoped + only when `mode=embedded`. Failing any returns 404.
14. `SILVERHAND_DISABLE_SIGNUP` and other auth-relevant config are loaded once at server startup into immutable in-memory config; auth routes do not re-read settings tables at request time.
15. Auth credential storage is split from profile identity: `users` keeps profile fields; `user_password_credentials` is a separate one-to-zero-or-one table. Profile-only `users` rows (no credential row) cannot log in.

### 10.3 ACL and information

16. Every resource picks exactly one of three ACL classes (direct owner column / membership edge / inherited via parent) per §2.1. Routes do not invent ad-hoc paths.
17. Open signup ≠ no ACL. Every resource query/mutation is scoped by `viewer_user_id`; routes failing to resolve viewer return 401.
18. Auth/setup error responses are uniform within the same route — no enumeration of email/password/credential-row distinguishability. Disabled-signup 404 is allowed; credential-failure path is always 401 with constant-time compare.
19. `installation_id` is a stable local id only, not an auth factor. Hardware machine fingerprint is at most a UI display hint, never a permission boundary.
20. Existing host record + revoked_at set + new claim attempt → 409 fail-closed, no silent revival.

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

### A.5 Sandboxing as a Host capability

Per `multi-daemon-registry.md`, sandboxing (chroot, seccomp, namespace
mounts, ephemeral fs, network egress policy) is orthogonal to `Host.kind`.
A future hardening track adds:

- `host_capabilities.sandbox_profile` (nullable; selects a server-defined
  profile).
- Daemon advertises sandbox capability bits in its bootstrap; server stores
  alongside `hosts.capabilities`.
- Agent placement filters can require `sandbox_profile=<x>` for a given
  agent class.
- Pre-V1.5 there is no `kind=sandbox` enum addition; if we ever need a
  separate kind, it would be `kind=remote_sandbox` or similar — but the
  current expectation is that sandbox is a capability layer on top of
  `kind=remote`, not a sibling kind.

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
- 2026-05-25 — Round 2 revision (Alice). Addresses Cindy review round 1
  P1/P2 findings:
  - HostKind aligned to existing `local|remote` schema; sandbox flow
    rewritten as remote-host provisioning + Appendix A.5 capability track.
  - Resource ownership rewritten as three orthogonal classes (direct
    owner / membership edge / inherited) honouring existing
    `workspace_users` / `conversation_users` tables.
  - `users` profile identity preserved; auth credential split into
    `user_password_credentials`; signup must populate name/display_name.
  - Revoke flow: hard deny, no grace; rotation alone keeps 60s grace.
  - `host_token` boundary corrected to "renderer never sees it; main owns
    it"; renderer/main process responsibilities annotated in §6.1.
  - Auth error uniformity scoped to credential failure; signup-disabled
    404 explicitly allowed.
  - Desktop local credential policy later simplified to unified 0600
    plaintext files for session/profile/host credentials; server keeps
    hash-only state.
  - `user_auth_links` deferred to V2 migration (Cindy open question).
- 2026-05-25 — Round 3 cleanup (Alice). Addresses Cindy review round 2 P2:
  - Revoke uses soft-delete on **both** `hosts.revoked_at` and
    `host_credentials.revoked_at`; token-validator denies on either set
    or row missing. Earlier "hard-delete the credential row" wording
    removed for consistency with the schema column.
  - Remote-host route scope tightened: V1 ships only the local-host set
    (`claim-or-create` / `revoke` / `rotate-token`). `POST /api/hosts`
    (remote create) and `POST /api/hosts/{id}/exchange` move with the
    headless daemon binary into Phase 4 / V1.5 so we don't expose
    bootstrap-exchange surface ahead of its caller.
- 2026-05-25 — Round 4 transport-truth fix (Alice). Addresses the
  cross-doc finding from Cindy during remote-backend roadmap round 2:
  - §6.1 last diagram line previously read "[daemon] outbound-connects
    with host_token; server marks (user_id, host_id) online". This
    overstated V1's transport — V1 keeps the pre-outbound model where
    backend/Electron main dials the daemon's Unix socket via
    `HostClient`; the daemon does NOT initiate HTTP/WS to the backend.
    Rewritten to "daemon holds host_token on disk; presents it on
    whatever transport the daemon ↔ server channel uses" + new
    "Transport note" paragraph clarifying that the daemon-initiated
    authenticated connection lands in the **follow-up phase** (daemon
    outbound protocol), not Stage B. Stage B's `host_token` contract:
    issued + persisted + validated by `verifyHostToken()` + used to
    authorize host-scoped server-side operations (placement, revoke
    enforcement). No new daemon-initiated channel.

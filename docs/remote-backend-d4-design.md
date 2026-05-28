# Remote backend Stage D4 — design contract

> **Status**: design pass, 2026-05-28. Owners: @Alice (architecture +
> draft), @Cindy (review). shiki product owner.
>
> **What this doc is**: the locked design contract for Stage D4
> "remote backend e2e (deployment + runtime + multi-host)". Output of
> the D4.0 design pass on thread `#conv:z8B7l4UPhwUc0OOB`.
>
> **What this doc is NOT**: implementation plan for any single G-gate
> (each G-gate has its own task and its own commit chain), nor a
> general remote-backend tutorial (see `remote-backend-roadmap.md` for
> the V1 prep path; see `remote-server-target-architecture.md` for the
> destination topology).
>
> **Reading order**:
> 1. `remote-server-target-architecture.md` — destination topology
> 2. `remote-backend-roadmap.md` — V1 prep path (D4 section links here)
> 3. This doc — D4 framing, gates, acceptance, deferrals
> 4. `auth-and-host-model.md` — auth + host model detail spec
> 5. `docs/daemon-server-link-flow.html` — terminal architecture
>    visual (R1–R4 guard reference)

---

## 1. Why this design pass exists

D3 (desktop local-daemon lifecycle wired to outbound) shipped as a
checkpoint on `feature/remote-backend-v1-stage-d3 @ 4682ef5`.

Before D4 implementation starts, three open architecture questions
needed to be answered:

1. **R4 drift** — `HostClient` IPC `subscribe` currently exposes a
   daemon RPC API rather than an outbound-frame-envelope adapter. The
   terminal-state guard's **R4** (wire protocol is deployment-invariant)
   is the only one of R1/R2/R3/R4 still broken. **Question**: do we
   pay R4 down inside D4, or defer to D5?
2. **D4 scope shape** — should D4 be one big "remote backend works"
   gate, or a multi-stage gate ladder?
3. **D4 vs D5 boundary** — if R4 paydown is deferred, does that
   become D5? What else lives in D5?

The pass also locked four cross-cutting concerns that any D4
implementation must respect:

- task decomposition (avoid over-slicing)
- TLS policy (system-default CA verification only; typed fail; no
  SPKI pin / no self-signed support in D4)
- first-user / signup model (Option A: default-on signup + 5 hard
  lock-in conditions, no admin role)
- R4 deferral mechanics (grep-able TODO anchor format)

---

## 2. Framing locks (P1 / P2 / P3)

These three propositions are **locked** for D4. Any later push to
relitigate one of them re-opens the D4 design pass — do not silently
absorb a change to P1/P2/P3 inside a D4 implementation PR.

### P1 — R4 drift is **deferred to D5**, not paid down in D4

D4 ships **on top of the existing IPC shape**:

- `HostClient` still exposes a Unix-socket `subscribe`-style daemon
  RPC surface in embedded mode.
- Server↔daemon protocol parity (single outbound-frame envelope across
  embedded loopback and standalone WSS) is **not** required for D4
  acceptance.

D5 owns the unification:

- Daemon always speaks the same outbound frame envelope.
- Embedded deployment becomes a **transport adapter** (Unix socket /
  in-proc) carrying the same envelope, not a parallel RPC API.

D4 still honours **R1 / R2 / R3**:

- **R1** server↔daemon formal semantics must be runnable on outbound
  WS + DB inbox (embedded loopback is allowed as an acceleration, but
  the semantics are the WS+inbox ones).
- **R2** UI is designed around remote backend (embedded loopback is a
  V1 packaging choice, not a protocol assumption).
- **R3** backend is one codebase; deployment forms vary
  (embedded / standalone), handler code does not fork.

R4 is the only relaxation, and it is **explicit and scoped**.

### P2 — D4 ships as three gates: G1 / G2 / G3

D4 is **not** a single binary "remote backend works" gate. It is three
sequential acceptance gates, each independently verifiable:

| Gate | Scope | Verifies |
|------|-------|----------|
| **G1** | Standalone control plane | Backend deployable to a remote machine; desktop in remote mode logs in, sees workspaces/conversations, sends/receives plain messages. **Agent runtime not required.** |
| **G2** | Remote runtime e2e | Daemon on user's desktop attaches to remote backend; agent spawn / wake / stop work end-to-end; delivery recovery is correct (reconnect / inbox replay / no loss / no duplicate). |
| **G3** | Multi-user / multi-host smoke | Two desktops, two daemons, both attached to the same remote backend; cross-tenant ACL negatives hold; signup-toggle behaviour validated. |

Each gate has a hard acceptance list (§5). G1 must pass before G2
opens; G2 before G3.

### P3 — D4 and D5 are split work blocks

| Block | Focus | Touches |
|-------|-------|---------|
| **D4** | Deployment **form** works | Standalone bootstrap, desktop remote-mode gate, daemon attach to remote, multi-host ACL e2e |
| **D5** | Protocol **envelope** is unified | Daemon ↔ backend frame-envelope unification; embedded transport becomes adapter; eliminates the R4 drift documented in this doc |

They are decoupled by direction:

- D4 does **not** introduce a new wire protocol form.
- D5 does **not** change deployment topology.

D5 has its own design contract (TBD). It is **not** within the scope
of this doc beyond §9 (R4 deferral mechanics).

---

## 3. Task decomposition

Four tasks total. **No second-level slicing** (D4.a.1 / D4.a.2 / …) at
design time — if a gate's implementation turns out genuinely too large
for one branch, that decision happens in the gate's own thread, not
here.

| Task | Branch | Scope |
|------|--------|-------|
| **D4.0** | `feature/remote-backend-v1-stage-d4-design` | This design contract + roadmap update. Doc-only, no code. |
| **D4.a (G1)** | `feature/remote-backend-v1-stage-d4-a-g1` | Standalone backend bootstrap; desktop remote-mode config gate (no embedded backend startup); TLS policy enforcement; auth/signup wiring; G1 acceptance e2e. |
| **D4.b (G2)** | `feature/remote-backend-v1-stage-d4-b-g2` | Daemon attach to remote backend; agent spawn / drain / event end-to-end; delivery recovery; G2 acceptance e2e. |
| **D4.c (G3)** | `feature/remote-backend-v1-stage-d4-c-g3` | Multi-host smoke; cross-tenant ACL negatives; signup-toggle negative tests; G3 acceptance e2e. |

Each task carries its own commit chain (reference D3.a–e, which ran
4–6 commits per task on one branch — same pattern). PR description
must explicitly state which gate(s) the change closes against.

---

## 4. Deployment model

### 4.1 What "remote backend" means in D4

- **Server** runs on a remote machine. Single Node process (the same
  entry point Stage D1 introduced via `packages/server`), bound to a
  network address reachable by the desktop's WAN/VPN/LAN.
- **Desktop** runs in **remote mode**: configured with a
  `server_url`, does **not** start the embedded backend.
- **Daemon** stays bundled inside the desktop app. It attaches
  outbound to the remote backend using the Stage B / D2 mechanisms
  (no headless / sandbox daemon in D4 — that is still follow-up phase
  per `remote-backend-roadmap.md` §2).
- **Agent processes** run on the user's desktop (daemon-co-located,
  per the locked target topology in `remote-server-target-architecture.md`).

### 4.2 "Desktop doesn't run embedded backend" — precise definition

Cindy boundary lock (D4.0 §1):

> D4 = **remote mode does not start / does not depend on an embedded
> backend at runtime**. D4 does **not** require packaging to physically
> remove `@silverhand/server` from the desktop artifact, and does
> **not** require rewriting the desktop dependency graph.

Concretely:

- Desktop main detects `server_url` config and **skips** the embedded
  `startBackend(...)` call when configured to remote.
- Desktop main does not background-launch a fallback embedded backend
  "just in case" remote is unreachable.
- The embedded code path remains importable (so embedded deployments
  keep working unchanged) — D4 only changes **when** it is invoked,
  not **whether** it ships.

Artifact slimming (e.g. ship a "remote-only desktop build" with
`@silverhand/server` excluded) is **out of scope** for D4. May land in
V1.1 as a packaging optimization; not a D4 acceptance item.

### 4.3 Standalone bootstrap and deployment runbook

This section is the V1 deployment recipe operators follow.

**Minimum operator surface**:

- Standalone backend binary: invoke `silverhand-server` (the D1
  entrypoint) with env config.
- Required env: `SILVERHAND_LISTEN`, `SILVERHAND_DATA_DIR`,
  `SILVERHAND_DISABLE_SIGNUP` (optional; default `0` — see §6),
  `SILVERHAND_LOG_LEVEL`.
- Persistent state layout: per `auth-and-host-model.md §7.1` —
  `<DATA_DIR>/silverhand.db`, `<DATA_DIR>/blobs/`,
  `<DATA_DIR>/workspaces/`.
- TLS termination: reverse proxy (Caddy / Tailscale / nginx) recommended
  for V1; backend itself does not terminate TLS. **Daemon refuses to
  attach over a non-loopback non-TLS server URL** — §8.
- Readiness probe: `GET /readyz` returns 200 once migrations applied,
  DB writable, listen socket open.

**Operator runbook** (will live in `docs/remote-backend-d4-design.md`
tail — §12 of this doc, drafted in D4.a alongside the implementation).

---

## 5. Gate acceptance criteria

All three gates must pass to call D4 complete.

### 5.1 G1 — Standalone control plane

**Must work** (these block G1 acceptance):

- Standalone backend boots on a remote machine, `/readyz` returns 200.
- Desktop in remote mode points at `https://<remote>` (or
  loopback-http per §8) and reaches it.
- `POST /auth/signup` works (when signup enabled) end-to-end against
  remote. **When signup disabled**: `POST /auth/signup` returns
  `403 { code: 'signup_disabled' }` (route always mounted under D4 —
  see §6.2; this updates the A.2 hide-as-missing behaviour).
- `POST /auth/login` works end-to-end against remote.
- `GET /api/server/info` returns the expected `signup_enabled` /
  `bind_address_scope` (§6) fields.
- Listing / creating / deleting workspaces works.
- Listing / creating / deleting conversations works.
- Sending and receiving plain user messages in a conversation works
  end-to-end.
- SSE event stream stays open and delivers state updates (workspace /
  conversation changes, notifications) without polling fallback.
- Notification deep-link click opens target conversation.

**Allowed to fail** (G1 does **not** require these to succeed) but
**failure form must be typed** (these block G1 acceptance if they fail
with the wrong shape):

- Agent runtime operations (spawn / wake / stop): return typed code
  from the set `{ remote_host_unavailable, no_host_placement,
  host_attach_pending }`.

**Explicitly forbidden failure forms** (these block G1 acceptance):

- HTTP 500 from any runtime route.
- Hang (request times out without typed reply).
- Silent embedded-backend fallback bootstrap (desktop secretly starts
  embedded backend because remote was unreachable).
- Silent no-op (UI shows success state for an operation that did not
  actually happen).

### 5.2 G2 — Remote runtime e2e

**Must work**:

- Desktop daemon attaches to remote backend over WSS (or loopback ws
  per §8); attachment is observable in Hosts UI within `connecting →
  connected` transition window.
- Agent spawn in a remote-backed conversation: backend dispatches
  intent → daemon receives → daemon spawns agent CLI on desktop →
  agent emits `session_init` → backend projects it → UI shows agent
  active.
- Agent wake (user sends message to an offline agent's inbox): inbox
  row created → daemon receives wake → drain delivers message →
  agent processes → reply propagates back to UI.
- Agent stop (`runtime_stop` intent): graceful → daemon ack → agent
  process exit observed → backend marks state.

**Delivery recovery** (Cindy boundary §5):

- `daemon kill -9` → desktop respawns daemon (D3.b path) →
  daemon re-attaches → previously pending inbox rows drain on
  reconnect → no message lost, no message duplicated.
- Backend restart (controlled) → daemon outbound WS reconnects within
  bounded backoff → runtime event projection resumes in order →
  no state divergence between daemon's local view and backend's view.
- Agent message end-to-end dedupe verified (the existing inbox
  `markDelivered` idempotency holds across reconnect).
- `runtime_stop` / `runtime_wake` correlation: every intent has a
  traceable ack frame and a final state observable in backend logs.

### 5.3 G3 — Multi-user / multi-host smoke + ACL negatives

**Multi-host setup**:

- Two desktops, each with its own daemon, attach to the same remote
  backend. Each daemon registers under its own user's `host_id`.

**ACL negative tests** (these are the security perimeter; all must
pass):

- User A → request workspace / conversation / agent owned by User B
  on any `/api/*` route → returns 404 / 403 per the
  `auth-and-host-model.md §2` layering. No row leakage in error body.
- Daemon configured with User A's `host_token` attempts to attach to
  a host slot owned by User B → server rejects with
  `host_token_owner_mismatch` (or equivalent typed code). No silent
  cross-tenant attach.
- Daemon for host A attempts to spawn agent into User B's workspace
  → server rejects with typed code (candidate:
  `host_workspace_not_owned`).
- Both daemons online simultaneously: messages / events for User A do
  **not** appear in User B's daemon's event stream and vice versa.

**Signup-toggle negative tests** (Cindy boundary §6.5):

- Create two users via default signup (`DISABLE_SIGNUP=0`).
- Operator sets `DISABLE_SIGNUP=1` and restarts backend.
- After restart: existing User A's session bearer still authenticates
  (no forced logout). Daemon A's host attach is unaffected. New
  `POST /auth/signup` returns `403 { code: 'signup_disabled' }` —
  the route stays mounted; the handler branches on `signup_enabled`
  and returns the typed body when disabled (see §6.2; this is the
  D4 contract, replacing the A.2 hide-as-missing behaviour).

---

## 6. Auth and bootstrap — first-user (Option A + 5 hard conditions)

shiki picked **Option A** (default signup on, operator manually
locks). The 5 conditions Cindy required as the safety perimeter are
locked into D4 acceptance.

### 6.1 Default behaviour

- `SILVERHAND_DISABLE_SIGNUP=0` is the default.
- Open desktop in remote mode → `POST /auth/signup` works → user gets
  session bearer → desktop UX is identical to embedded dogfood.
- No CLI seed step. No setup token. No admin role.
- "First user = admin" is **not** introduced. V1 has no admin/RBAC
  concept (existing ACL is owner / membership / inherited per
  `auth-and-host-model.md §2`).

### 6.2 Operator lock-down

- Operator runs: set `SILVERHAND_DISABLE_SIGNUP=1`, restart backend.
- On boot with `DISABLE_SIGNUP=1`, the `/auth/signup` route is **still
  mounted** and returns `403 { code: 'signup_disabled', message:
  <human-readable> }`. This is a **change from A.2** (which hid the
  route as `404 missing`); D4 prefers a typed body over enumeration
  resistance because (a) every other negative across G1/G2/G3 is
  typed, (b) V1 remote is a personal/private deployment so
  enumeration resistance is a weak argument, and (c) desktop UX needs
  a deterministic signal to hide the signup form rather than relying
  on both `/api/server/info.signup_enabled` and a generic 404
  fallback. **D4.a updates the A.2 contract** (mount the route
  unconditionally, branch on `signup_enabled` inside the handler);
  the A.2 routes test (`packages/backend/tests/routes/auth-routes.test.ts`)
  is updated in the same PR.
- Operator can re-enable by clearing the env and restarting. No
  admin API for live toggle in D4 (would expand auth surface).
- Other auth routes (`/auth/login`, `/auth/logout`) are unaffected.

### 6.3 Five hard conditions (Cindy lock)

These five must be true at D4 close. They are written into the design
contract as enforceable acceptance items:

1. **Supported deployment model**. D4/V1 remote = personal / private
   deployment (own cloud / Tailscale / VPN / controlled ingress).
   **Not** a public-internet SaaS exposure model. Documented as a
   first-class supported / non-goal split in §10.
2. **`SILVERHAND_DISABLE_SIGNUP=1` is part of the lock-down runbook**.
   The standalone deployment runbook includes "create account → set
   `DISABLE_SIGNUP=1` → restart" as the recommended hardening step.
   G1 dogfood checklist verifies both directions:
   - signup-enabled path: `POST /auth/signup` accepted, user created.
   - signup-disabled path: `POST /auth/signup` returns
     `403 { code: 'signup_disabled' }` from the always-mounted
     route handler (no 500, no silent fallback, no 404).
3. **Non-loopback bind + signup-enabled emits visible warning**. On
   backend boot:
   - If listen address is non-loopback AND `signup_enabled = true`:
     `backend-<utc>.log` emits a `WARN` line referencing the runbook
     lock-down section.
   - `GET /api/server/info` exposes a structured `bind_address_scope`
     field (values `{ loopback, lan, public }`) and the existing
     `signup_enabled` boolean, so desktop and ops tooling can read
     the combination programmatically.
4. **No admin role / no first-user-admin auto-promotion / no admin
   CLI seed in D4**. Auth model shape is unchanged from A.2; only the
   default value of `DISABLE_SIGNUP` and the deployment recommendation
   move.
5. **G3 includes signup-toggle negative coverage**. The negative
   tests in §5.3 are part of G3 acceptance, not a "nice to have".

### 6.4 What is explicitly out of scope (no admin subsystem creep)

- Admin / operator dashboard.
- Invite system / one-time setup tokens / SPKI-bound enrollment.
- `users.is_admin` column / RBAC roles.
- Live `/admin/disable-signup` API.
- Account recovery via email (still parked in roadmap §2).
- Audit log surface beyond the existing `backend-<utc>.log` lines.

These are not banned forever; they are explicitly **not** D4 work.
Any later expansion goes through its own design pass.

---

## 7. Server connection profile (pre-auth + post-auth single source)

This section closes the gap surfaced in Cindy round-1 blocker 2.
Before this section existed, no spec said which desktop-side
component owned the `server_url` source of truth — pre-auth desktop
traffic (`GET /api/server/info`, `POST /auth/signup`,
`POST /auth/login`, plus the SSE event WS under the session bearer)
runs before any Host is claimed, so the pre-D2 "Hosts config"
abstraction did not apply, and there was no defined contract for
who held `server_url` and who validated TLS for that traffic. The
server connection profile fills that gap by being the **single
source of `server_url`** for every desktop→backend transport across
both auth phases, plus the canonical anchor for the
`partial_apply_pending` mechanism that keeps profile and
daemon-config in sync across URL changes (§7.5).

### 7.1 Data shape

```
ServerConnectionProfile {
  version: int             // monotonic; increments on every commit
  server_url: string       // canonical URL string (scheme + host + port)
  created_at: int          // unix ms
  updated_at: int          // unix ms
}
```

This is intentionally minimal (Cindy round-2 P1 + round-3
simplification): the profile persists only stable connection
configuration. Derived diagnostic state — e.g. whether the current
URL + active env qualifies as `insecure_dev` (§8.3) — is computed
at runtime from `server_url` + `SILVERHAND_ALLOW_INSECURE_REMOTE`,
**not** stored on the profile. This avoids stale-flag drift if the
env is toggled later.

No `spki_pin` field. V1 does not support self-signed remote backends;
see §8 (TLS policy) and §10 (non-goals).

### 7.2 Storage and ownership

- **Desktop main process exclusive owner**. File path:
  `~/.silverhand/desktop/server-profile.bin`, mode `0600`, contents
  encrypted via `safeStorage.encryptString` (same primitive A.4
  already uses for the user session bearer).
- **Persisted profile flows main → renderer only as a redacted
  view**. Renderer-facing IPC surfaces (Settings UI, Setup Wizard
  "current profile" panel) get
  `{ server_url, updated_at }` — encrypted blob never crosses IPC,
  consistent with A.4 secret-handling convention.
- **Renderer → main URL submission is allowed**. The Setup Wizard
  and Settings URL editor both pass user-entered `server_url`
  through IPC to main; main runs the §7.5 validate-and-commit flow.
- **Daemon never reads the profile**. Daemon only reads
  daemon-config (§7.6). Profile is a desktop-main concept; keeping
  it out of the daemon's read path preserves R4 hygiene (profile
  versioning does not leak into daemon ↔ backend protocol).

### 7.3 Coverage — which transports the profile owns

Single source of `server_url` for:

- Pre-auth `GET /api/server/info`
- Pre-auth `POST /auth/signup` (when enabled) / `POST /auth/login`
- Post-auth `GET/POST /api/*` over `backend:request` proxy
- Session validation refresh
- SSE / event WS subscription
- B.2 `POST /api/hosts/claim-or-create`
- D2 daemon outbound WSS (delivered via the derived daemon-config)
- D3 daemon-config writer (the derived artifact)

All of those resolve `server_url` from this single profile. There
is no "look up server_url from app_settings" parallel path. The
grep gate treats any other resolution path in non-test code as a
finding.

### 7.4 Pre-auth UX: Setup Wizard

Setup Wizard's "Connect to backend" first screen:

1. User enters `server_url` (required).
2. Wizard performs a test connection (`GET /api/server/info`) using
   the entered URL (no commit yet).
3. **Outcome A — `system_ca_verified`** (§8.1): profile commits.
   Continue to signup/login screen.
4. **Outcome B — `host_tls_chain_invalid`**: Wizard surfaces a
   typed error explaining "this server's certificate is not trusted
   by your system CA" and points the user at the runbook (§12.1
   prereqs: Caddy / Let's Encrypt / Tailscale Funnel / a private CA
   already in the system trust store). Wizard does **not** offer a
   one-click trust path. V1 does not support self-signed (§10
   non-goals); the user must fix the TLS setup at the server side.
5. **Outcome C — other typed fail** (`hostname_mismatch`,
   `expired`): typed error surfaced; Wizard does not commit; user
   must fix `server_url` or fix the cert at the server end.

### 7.5 Profile update flow (Settings → atomic phase-1 + phase-2)

When user updates `server_url` from Settings:

**Phase 0 — validate**

- Run a test connection against the proposed `server_url`.
- Fail-fast on any typed TLS code (§8.2); nothing committed; UI
  shows the typed error.

**Phase 1 — commit profile**

- Write next-version profile to temp file in
  `~/.silverhand/desktop/`, `fsync`, `rename` over the current
  profile file (atomic at the filesystem level for a single file).
- After this rename succeeds, the profile is **committed**. There
  is no way to atomically un-commit it across the boundary into
  daemon-config (Cindy correction: do not pretend cross-file
  transactions exist).

**Phase 2 — derive daemon-config and reload**

- Build new daemon-config from
  `{profile.version, profile.server_url, host_id, host_token}` (the
  last two from the D3-already-persisted host claim state).
- Write daemon-config to temp file, `fsync`, `rename`.
- Send `host_outbound_reload` IPC to daemon.
- Await daemon's reload ack frame.

**Failure handling for phase 2**

- If phase 2 fails (daemon-config write / IPC / reload ack any
  step): profile is **already** at the new version, daemon is
  **still** running on the old config. Mark in-memory desktop state
  `partial_apply_pending = true`. Settings UI does NOT show
  "success"; shows a typed `partial_apply_pending` indicator with
  a "Retry" affordance.
- Recovery (Cindy requirement — partial_apply_pending must be
  recoverable):
  - **User clicks Retry** → re-run phase 2 with current profile.
  - **Desktop restart** → on launch, compare
    `profile.version` vs `daemon-config.profile_version`;
    mismatch → automatically re-run phase 2 in the background.
  - **Daemon restart (D3.b)** → desktop supervisor's daemon-attach
    path re-derives daemon-config from current profile before
    spawning the new daemon, so a daemon respawn naturally
    converges the two if they were out of sync.
- Acceptance (G1): `partial_apply_pending` must converge to
  `fully_applied` after at least one of {Retry click, desktop
  restart, daemon restart}. No code path leaves it stuck.

### 7.6 daemon-config (the derived artifact)

`~/.silverhand/daemon-config.json` mode `0600` (D3 existing layout)
gains **additive** new fields. The existing fields (`server_url`,
`host_id`, `host_token`, etc. — see `packages/shared/src/config.ts`)
are preserved unchanged; D4.a is an additive migration, **not** a
rename. Specifically:

```
{
  // ── existing D3 fields, kept as-is ──
  server_url: string         // canonical URL; mirror of profile.server_url
  host_id: string            // from claim-or-create
  host_token: string         // from claim-or-create
  // ... other existing D3 fields ...

  // ── new D4 additive field ──
  profile_version: int       // mirror of profile.version at derivation
}
```

"`effective_url`" is a documentation term meaning "the URL that is
effectively in force = the value of `server_url` in this
daemon-config snapshot". It is **not** a separate JSON field — the
JSON field stays `server_url` so existing D2/D3 consumers
(`packages/host/src/daemon/outbound-client.ts` and its callers)
keep reading the same key (Cindy round-2 P1/P2 — D4 must not
silently rename established schema).

**Daemon fingerprint inclusion** (Cindy nuance): when daemon
computes a config fingerprint to short-circuit no-op reload IPCs,
`profile_version` MUST be part of the hash input. Otherwise a
profile commit that changes only metadata (timestamps) without
changing the URL would be treated as a no-op, and desktop's
generation tracking would diverge from daemon's. `profile_version`
is **local config consistency only** — it is NOT sent in any
outbound WSS frame, not in any auth header, not in any backend
request. Keeping it local-only preserves R4 future-unification
scope.

### 7.7 Out of scope for §7

- **Multiple concurrent profiles** (e.g. switch between two remote
  backends): V1 has one profile at a time. Multi-profile support
  is a follow-up.
- **Profile bootstrap from environment variables** (auto-provision
  for CI / dogfood): out of D4 scope; if added later, treat env as
  a one-shot seed for the profile file, not a parallel source.
- **Sharing the profile between desktop and a future headless
  daemon binary**: covered when headless daemon ships (follow-up
  phase, §10).

---

## 8. TLS policy

This section is the V1 TLS verification contract for **every**
desktop→backend transport — `apps/desktop` main-process fetch
(pre-auth `/api/server/info`, `/auth/signup`, `/auth/login`,
post-auth `/api/*`), SSE / event WS, B.2 `claim-or-create`, D2
daemon outbound WSS. The single source of `server_url` for all of
these is the server connection profile defined in §7.

D4 V1 takes the **simplest possible TLS stance** (shiki product
call 2026-05-28 + Cindy endorsement): only system-default TLS
verification is supported. No SPKI pin path, no self-signed
support, no custom TLS verifier. This collapses what was previously
multiple accept states + an audited helper exception into a single
accept state with a clean absolute ban on bypass primitives.

### 8.1 Accept matrix

The verification has **exactly one accept state**:

| Accept state | Required conjunction |
|--------------|----------------------|
| `system_ca_verified` | (1) cert chain to a system-trusted CA **AND** (2) hostname matches `server_url` **AND** (3) cert not expired. |

Everything else is a typed fail (§8.2). Self-signed certificates,
private CAs not in the system trust store, and any other
trust-policy fallback are explicitly **not** supported in V1 (§10
non-goals). Operators who need to use a private CA must install
that CA into the host's system trust store first; the daemon and
desktop then verify chains through the standard system path with
no special handling required.

### 8.2 Typed failure codes

Failures are surfaced with specific typed codes (not a generic
`tls_error`). Evaluation order (first matching code wins):

1. **No system-CA chain** → `host_tls_chain_invalid`. Error detail
   carries `{ profile_id }`. The runbook (§12) directs the user to
   use a CA-trusted cert (Let's Encrypt / Caddy auto-TLS /
   Tailscale Funnel / system-installed private CA).
2. **Chain satisfied, but hostname mismatch** →
   `host_tls_hostname_mismatch`. Error detail carries
   `{ profile_id, expected_hostname, observed_san_list }`.
3. **Chain and hostname satisfied, but expired** →
   `host_tls_expired`. Error detail carries
   `{ profile_id, expired_at }`.

### 8.3 `rejectUnauthorized: false` — absolute ban, no exception

V1 has no legitimate use for bypassing chain validation. Therefore
`rejectUnauthorized: false` (and any equivalent disable-TLS-verify
primitive) is **default-denied across the full TLS client
surface**: `apps/desktop/src/main/**`,
`apps/desktop/src/preload/**`, `packages/host/**`,
`packages/backend/**`, `packages/shared/**`, `packages/cli/**`.

**CI gate spec**:

- `rg 'rejectUnauthorized:\s*false' --type ts` over every directory
  in the surface above MUST return **zero matches** outside test
  directories.
- Test-only escapes live in `packages/*/src/**/__tests__/**` and
  `apps/desktop/src/**/__tests__/**` only (mock TLS endpoints,
  etc.).

There is no audited-helper exception in V1. If self-signed support
is later added (follow-up phase per §10), that work will reintroduce
a controlled bypass + the audited helper pattern; D4 deliberately
does not pre-build that surface.

### 8.4 http vs https

- **System-CA path is the V1 supported remote path**. Most operators
  will terminate TLS at a reverse proxy with a Let's Encrypt or
  commercial CA cert; verification goes through `system_ca_verified`.
- **http is allowed only for loopback literals**: `127.0.0.1`,
  `localhost`, `::1`. This preserves the embedded loopback case
  without opening a remote-http hole. Loopback-http profiles skip the
  TLS verification entirely (there is no TLS).
- **`*.local`, LAN IP literals, any non-loopback hostname over http**:
  requires `SILVERHAND_ALLOW_INSECURE_REMOTE=1` env (developer
  escape hatch). When this flag is set:
  - UI Hosts page marks the host with a visible "Insecure dev (HTTP,
    non-loopback)" warning badge. The badge is derived at runtime
    from `(server_url scheme, host literal class, env flag)`; it is
    NOT a persisted profile field (Cindy round-3 — avoid stale-flag
    drift).
  - `backend-<utc>.log` host attach event includes `insecure: true`.
  - This combination is **not a V1 supported remote path**. The
    runbook explicitly says so.

### 8.5 Revocation

OCSP / CRL revocation checking in Node TLS is famously inconsistent
across runtime versions and platforms. D4 acceptance is shaped
accordingly:

- chain / hostname / expiry: **fail-loud**, required.
- revocation: best-effort. Use whatever the platform / Node standard
  TLS surface provides. **Do not bypass** (no disabling OCSP, no
  mocking revoked = valid). But revocation correctness is **not** a
  D4 acceptance gate, because the underlying capability is not
  uniformly available.

---

## 9. R4 deferral mechanics

R4 paydown is D5 work (per P1). D4 must leave the drift in a state
where D5 can find and close it cleanly.

### 9.1 What the drift is

Today, in embedded deployment:

- Daemon ↔ backend communication uses `HostClient` (Unix socket).
- The wire surface is a daemon RPC API with `subscribe`-style
  long-poll patterns.
- This **differs** from the standalone-WSS outbound frame envelope.
  Same business semantics, different shapes.

R4 ("wire protocol is deployment-invariant") wants this normalized:

- Both transports carry the **same outbound frame envelope** (same
  auth shape, same error code set, same ACL semantics, same
  event-intent shape).
- Transport adapter (loopback Unix socket / in-proc / TCP+TLS+WSS)
  may differ. The **envelope** does not.

### 9.2 What D4 does about it

- D4 **does not** refactor `HostClient` or the embedded subscribe
  path.
- D4 **does** add grep-able TODO anchors at every drift hotspot, in a
  uniform format so D5 can audit-grep them in one pass.

### 9.3 Anchor format (mandatory)

Every D4 code change that touches a drift hotspot (or that would
otherwise paper over it) must add (or preserve) the anchor:

```
// TODO(D5,R4): unify with outbound frame envelope.
//   This call uses the embedded HostClient subscribe RPC, which
//   exposes a daemon RPC API distinct from the standalone WSS
//   outbound frame envelope. D5 unifies the envelope and reduces
//   embedded transport to a Unix-socket / in-proc adapter carrying
//   the same envelope frames.
//   See: docs/remote-backend-d4-design.md §9.
```

Required elements:

- `TODO(D5,R4)` literal — both tokens are part of the grep contract.
- Reference to this doc's §9 (so D5 reviewers can read the framing
  without re-discovering it).
- A one-paragraph "what this place does today" note (so the anchor
  is self-explaining without git blame archaeology).

D5 acceptance will require this anchor count to drop to **zero**.
Forbidden phrasings (will fail D4 review):

- "temporary hack" / "to be cleaned up later" / "FIXME": these are
  unverifiable. The anchor must point at a specific D5 target.
- Missing `R4` tag: D5 audit will grep for `D5,R4` together.

### 9.4 Code review enforcement

D4 PR descriptions must explicitly state:

> "This IPC / RPC surface is local supervisor / control transport,
> not server↔daemon formal semantics. R4 drift is captured by
> `TODO(D5,R4)` anchors per `docs/remote-backend-d4-design.md §9`."

This phrasing was agreed with Cindy for D3.b/c and continues for D4.

---

## 10. Non-goals (push back if asked)

The following are out of scope for D4 and must not be conflated with
G1/G2/G3 acceptance:

- **R4 protocol envelope unification** — D5. Captured by `TODO(D5,R4)`
  anchors only.
- **Self-signed remote backend / SPKI pin / TOFU / custom TLS
  verifier / `verifyPinnedTlsProfile()` helper** — V1 takes only
  system-default TLS verification (§8); self-signed support and the
  pin / pre-auth-paste / audited-bypass surface are deliberately
  out. Operators with private CAs must install them into the system
  trust store before deploy. Follow-up phase may re-open this if a
  concrete use case emerges; round 1+2 of D4.0 design specced the
  full surface, round 3 (shiki + Cindy) chose to defer.
- **Headless / remote daemon binary distribution** — already follow-up
  per `remote-backend-roadmap.md §2`. D4 still requires daemon to live
  on the user's desktop.
- **"Add remote host" UI / remote host provisioning routes** —
  follow-up.
- **Sandbox capability layer** — follow-up.
- **Multi-user invite / workspace sharing** — V1.5.
- **OAuth providers** — V2.
- **Public-internet SaaS exposure model** — V1 remote is personal /
  private deployment only. See §6.3 condition 1.
- **Admin / operator dashboard / admin role / admin API** — see §6.4.
- **Account recovery via email** — still parked.
- **Backup / restore tooling** — still parked.
- **Packaging slim-down** (remove `@silverhand/server` from the
  desktop artifact for remote-only builds) — possibly V1.1.
- **Live config reload of `DISABLE_SIGNUP`** — env + restart only.
- **TLS termination by backend itself** — D4 expects reverse proxy.
- **OCSP / CRL revocation as a hard gate** — best-effort per §8.5.

Each item has a place either in the roadmap follow-up phase, a later
V1.x, or D5. The rule remains *not yet*, not *never*.

---

## 11. Hard ordering

```
G1 (standalone control plane)
   │  must pass + soak (informal, no fixed window)
   ▼
G2 (remote runtime e2e)
   │  must pass + soak
   ▼
G3 (multi-host + ACL negatives)
   │  must pass
   ▼
D4 closed.  D5 design pass begins.
```

The implementation order **D4.a → D4.b → D4.c** mirrors the gate
order. Doc artifacts for G2/G3 (e.g. the test matrix) may be drafted
in parallel with D4.a coding, but no G2 code merges before G1 closes.

---

## 12. Runbook (drafted in D4.a)

This section is a placeholder. The standalone deployment runbook is
drafted **inside D4.a** alongside the implementation that backs it,
so the two stay in sync. Final form: appended here in §12 in D4.a's
commit chain.

To prevent D4.a from forgetting a step, the runbook skeleton headings
are locked here at D4.0; D4.a fills the prose under each:

### 12.1 Prerequisites
- **TLS termination is mandatory and must produce a CA-trusted
  cert.** V1 only supports system-default TLS verification (§8) —
  self-signed and private-CA-via-pin are **not** in scope. Three
  recommended setups:
  - **Caddy** (auto-TLS via Let's Encrypt) in front of
    `silverhand-server` (simplest for a public-DNS hostname)
  - **Tailscale Funnel** / Tailscale serve (auto-cert tied to your
    tailnet)
  - **nginx / Caddy + Let's Encrypt certbot** on an existing host
  - For a private CA: install that CA into the system trust store
    on **every** desktop that will connect, then point
    `silverhand-server` behind a reverse proxy using a cert
    issued from that CA. No app-level pin/import.
  - For loopback-only embedded development: skip TLS termination,
    use `http://127.0.0.1:<port>` (§8.4).
- Persistent data directory (`SILVERHAND_DATA_DIR`) on the deploy
  host; backup expectations
- Network reachability checklist (port open from desktop's
  perspective; firewall / VPN topology)

### 12.2 First-time deploy
- Install `silverhand-server` binary (D1.b deliverable)
- Set env: `SILVERHAND_LISTEN`, `SILVERHAND_DATA_DIR`,
  `SILVERHAND_LOG_LEVEL`. **Do not** set `DISABLE_SIGNUP=1` yet
  (operator needs to create their account first)
- Start service; verify `/readyz` returns 200
- Configure reverse proxy + cert; verify https reachable
  end-to-end with a healthy `system_ca_verified` outcome
  (`curl https://<host>/api/server/info` from a fresh shell, no
  `-k`, must succeed)

### 12.3 Desktop first connect (server connection profile setup)
- Open desktop, enter `server_url` in Setup Wizard "Connect to
  backend" screen
- Wizard test-connects against `GET /api/server/info`; on
  `system_ca_verified` (§8.1) the profile commits and the wizard
  advances to signup/login
- On `host_tls_*` typed fail (§8.2): the wizard surfaces the typed
  error and points the user back to §12.1 to fix the cert/proxy
  setup. There is no in-app TLS bypass

### 12.4 Account creation
- Signup the operator's account through the Setup Wizard
- Verify login / session persistence across restart

### 12.5 Post-signup lock-down (5 hard conditions §6.3)
- Set `SILVERHAND_DISABLE_SIGNUP=1` in deployment env
- Restart `silverhand-server`
- Verify: `POST /auth/signup` returns `403 { code:
  'signup_disabled' }`; existing operator login still works;
  desktop UI hides signup form (driven off
  `/api/server/info.signup_enabled`)
- Verify `GET /api/server/info` reports `signup_enabled: false`
  and the expected `bind_address_scope`

### 12.6 Adding subsequent users (V1: signup-then-relock)
- Temporarily set `SILVERHAND_DISABLE_SIGNUP=0`, restart
- New user signs up via their desktop
- Re-set `DISABLE_SIGNUP=1`, restart

### 12.7 Troubleshooting

#### 12.7.1 `host_tls_*` typed codes

When the Setup Wizard or Settings → Connect dialog surfaces a
`host_tls_*` code, route the operator straight to §8.2 — the
mapping table there names the underlying cert / chain / SNI
problem and the fix. There is **no** in-app TLS bypass (§8.3
hard ban); the only path forward is to repair the cert/proxy
setup on the deploy host.

#### 12.7.2 `partial_apply_pending` (Settings → Connect update half-applied)

Indicator origin: §7.5 phase-2 failed after phase-1 committed.
The desktop's profile file is at the new version; daemon-config
is still at the old version. Settings UI shows the typed
`partial_apply_pending` chip + a Retry button.

Three recovery paths converge to `fully_applied` (§7.5
acceptance):

1. **User clicks Retry** in Settings. Re-runs phase-2 against
   the current profile.
2. **Restart the desktop.** On launch, desktop compares
   `profile.version` against `daemon-config.profile_version`;
   on mismatch it re-runs phase-2 in the background. The
   user does not need to click anything.
3. **Restart the daemon** (e.g. the supervisor respawns it).
   The daemon-attach path derives daemon-config from the
   **current** profile before spawning the new daemon, so a
   respawn naturally converges.

If none of the three converges, capture
`~/.silverhand/desktop/server-profile.bin` (the safeStorage-
encrypted profile blob — do NOT expect to be able to open it
directly; capture as-is) +
`~/.silverhand/daemon-config.json` and the desktop logs and
escalate — this should be a real bug, not normal operation.

#### 12.7.3 "Can't reach this Silverhand backend" boot-time gate

What the user sees: full-screen card with the saved server URL
and the captured fetch error, plus two buttons — **Retry
connection** and **Open Setup Wizard…** — and a footer line
about `SILVERHAND_FORCE_EMBEDDED=1`.

When it fires: the desktop has a saved (remote or
`dev_local_remote`) profile, but on the most recent
`getAuthState()` call the underlying `fetchServerInfo()` threw
before reaching the server (DNS / TLS / refused / not running).
The renderer routes through `BackendUnreachableGate` —
intentionally **without** any signup form, because the server's
signup policy is unknown when it's unreachable (Cindy 5d-fixup
P1-2).

Triage in order:

1. **Reachability sanity check from the desktop machine.** Run
   the equivalent of `curl https://<server>/api/server/info`
   from the desktop's shell (no `-k`). The shell error message
   is usually a more specific version of the gate's `message`
   line.
2. **DNS / VPN.** If the server is on a Tailscale network or
   private VPN, confirm the desktop is connected to the right
   tailnet / VPN.
3. **TLS / proxy regression.** If `curl` reports a TLS error,
   §12.7.1 + §8.2 are the fix path. The boot gate intentionally
   does NOT show `host_tls_*` typed codes because the
   pre-auth fetch path collapses every TLS failure into the
   generic "fetch failed" message at the OS layer.
4. **Server is genuinely down / restarting.** Click **Retry
   connection** once the operator confirms the server is back.

If the user needs to bypass the saved profile entirely (to
re-enter a new URL, or to fall back to embedded), click **Open
Setup Wizard…** — the wizard owns the "clear server profile"
affordance.

If the user is *locked out* — the saved profile points at a
backend they have no way to bring up right now — they can boot
embedded via §12.7.5 (`SILVERHAND_FORCE_EMBEDDED=1`).

#### 12.7.4 "Can't reach server" mid-session banner

What the user sees: a small top-center banner with **"Can't
reach server"** + a Retry button. Shown while signed in (i.e.
past the boot gate) when any tracked query / mutation throws
`ApiError.kind === 'backend_unreachable'`.

When it fires: same network-layer root causes as the boot gate
(§12.7.3), but encountered mid-session (server restarted, VPN
dropped, etc.). The renderer subscribes to React Query's query
+ mutation caches and watches for the typed kind; generic 4xx /
5xx errors do NOT trigger it (they belong to per-route copy).

Recovery:

1. The banner auto-clears the moment any subsequent query /
   mutation succeeds — typically the user does not need to do
   anything if the server comes back quickly.
2. **Retry button** runs `queryClient.invalidateQueries()` (no
   filter) so every active query is re-issued and acts as a
   liveness probe.
3. If the banner persists across multiple Retry clicks, treat
   the situation like §12.7.3 — the underlying connectivity
   problem is not transient. Capture the desktop logs and
   the deploy-host backend logs; the next sign-in/launch will
   surface the same condition as the boot-time gate, which
   provides the richer diagnostic surface.

There is intentionally no auto-poll / "Reconnecting…" affordance.
The renderer trusts the user to decide when to retry.

#### 12.7.5 `SILVERHAND_FORCE_EMBEDDED=1` escape hatch

What it does: skips the saved remote profile **for that launch
only**. The profile file on disk is preserved; the desktop boots
with the embedded backend at `http://127.0.0.1:<port>` instead.

When to use it:

- Operator is locked out of a remote deployment they can't
  bring back up right now and needs to access embedded data /
  settings.
- Operator wants to verify whether a "can't reach server" gate
  is a network problem (FORCE_EMBEDDED boots fine → network
  problem) vs a desktop-side bug (FORCE_EMBEDDED also fails →
  bug, escalate).
- Operator is replacing the remote URL: boot with FORCE_EMBEDDED,
  open Setup Wizard, enter the new URL, commit. On the next
  launch (without FORCE_EMBEDDED) the new profile is used.

How to use:

```
SILVERHAND_FORCE_EMBEDDED=1 /Applications/Silverhand.app/Contents/MacOS/Silverhand
```

(or invoke `electron` with the same env var in dev). The next
launch without the env var goes back to using the saved
profile.

**What it does NOT do:**
- It does not delete or rewrite the saved profile. To clear the
  profile, use the Setup Wizard's "clear" affordance, not a
  filesystem `rm` (the latter leaves stale daemon-config
  unless desktop catches up).
- It does not bypass any auth — the embedded backend still
  requires its single-user bootstrap or the operator's
  embedded-side account.

#### 12.7.6 `~/.silverhand/server-config.json` is embedded-only

This artifact is the **legacy embedded backend's** persisted
config (embedded backend URL / port / bind address; legacy
configs written before C.6 may still contain a retired
`auth_token` field — current writers no longer emit it, but
the reader stays tolerant). It is created lazily by the
desktop's `loadOrCreateServerConfig()` helper on the embedded
boot path **only**.

Hard contract (Cindy 5d-fixup P1-1, pinned by
`apps/desktop/src/main/__tests__/execute-backend-startup.test.ts`):

- On an **embedded** boot, the file MAY be created if missing.
- On a **remote** boot, the file MUST NOT be touched. If it
  already exists from a previous embedded launch on the same
  machine, that's fine — it's just sitting on disk unused.
- On a **refuse** boot (profile classified `profile_invalid`
  before the daemon launches), the file MUST NOT be touched
  either. Production bootstrap intercepts the refuse arm
  before the adapter is called; the
  `executeBackendStartup` adapter still pins the negative
  case as defense-in-depth.

Operator implications:

- **Do not** rely on this file existing or being valid for a
  remote-mode deploy. The remote-mode boot path reads
  `~/.silverhand/desktop/server-profile.bin` (§7.2; a
  safeStorage-encrypted blob, not human-readable JSON), not
  this file.
- Deleting this file is safe on a remote-mode desktop and
  triggers no behavior change. On an embedded-mode desktop
  it will be re-created at next launch.
- If `~/.silverhand/server-config.json` mysteriously updates
  its mtime on a remote-mode boot, file a bug with the
  desktop logs from that boot — the §4.2 hard gate has
  regressed.

#### 12.7.7 Daemon attach failures

D3 Hosts pane diagnostics (`#task:626` and later) cover the
daemon-side connection state — outbound WS attach, host token
revocation, etc. Operator entry point: open the desktop's
Hosts page; statuses there map to the daemon's view of the
outbound WS.

If a daemon attach failure is preventing sign-in (e.g. the
desktop is stuck on "Initializing host…" past the budget),
the desktop falls into one of the typed local-host states
(`local_host_unbound` / `local_host_failed`). To diagnose,
collect logs from all three sides — the daemon lives on the
**desktop**, not on the deploy host, so do not look for
daemon errors in the backend log:

- **Desktop main / renderer** — the setup-wizard / Hosts page
  state machine and the IPC plumbing. See §12.7.8 for the
  macOS console + log-file locations.
- **Desktop-side daemon + supervisor** — the daemon process
  itself plus the D3 supervisor that respawns it. Lifecycle
  events appear in the desktop main-process log tagged
  `local_host_supervisor.*`; the daemon's own stdout/stderr
  also lands there.
- **Deploy-host backend** — only the *server-side acceptance*
  of the outbound WS attach is visible here
  (`~/.silverhand/logs/backend-<utc>.log` on the deploy host).
  Use it to confirm whether the attach reached the server at
  all, or whether the server rejected it (e.g. revoked token,
  unknown host). Connection-side failures (DNS, TLS, retry
  backoff) live on the desktop, not here.

#### 12.7.8 Where to find logs

- **Desktop renderer + main logs:** macOS console (`log
  stream --predicate 'process == "Silverhand"'`) plus
  `~/Library/Logs/Silverhand/*.log` if logging-to-file is
  enabled in the build.
- **Backend logs (deploy host):**
  `~/.silverhand/logs/backend-<utc>.log` per the global
  CLAUDE.md logging convention. One file per backend boot;
  agent + CLI logs are separate sibling files.
- **Desktop-side daemon (D3 supervisor):** colocated with
  the desktop log directory; the supervisor's lifecycle
  events are tagged `local_host_supervisor.*` in the main
  process log.

### 12.8 D4.c surface — operator notes (added in D4.c G3 closure)

The operator-facing acceptance evidence for D4.c (G3) and a
test-name index live in [`docs/d4-c-g3-acceptance.md`](./d4-c-g3-acceptance.md).
This subsection only captures runbook-relevant behavior for
operators who manage a standalone deployment.

#### 12.8.1 Standalone bring-up order

The required order on a fresh deploy:

1. Start `silverhand-server` (the backend binary). Verify
   `/readyz` returns 200.
2. Open the desktop, complete Setup Wizard with `server_url`
   pointing at the backend.
3. Desktop signup or login (mints a user-session bearer).
4. Desktop's main process calls `POST /api/hosts/claim-or-create`
   with its `installation_id` (the renderer's session bearer is
   the auth principal). Backend mints a host row + host_token,
   returns both, and the desktop writes them to
   `daemon-config.json`.
5. Local daemon (the D3 supervisor) reads
   `daemon-config.json` and opens its outbound WS to the
   backend. The backend's `HostWsServerController` registers a
   fresh `hostws-*` connection id; the desktop's BackendInfo
   pill turns green.

Do not invert steps 3 and 4. The claim-or-create route requires
a user-session bearer; without signup/login first, the desktop
has no principal to present.

#### 12.8.2 Host revoke

`POST /api/hosts/:id/revoke` is the operator-facing soft-delete:

- The host row's `revoked_at` is set; the row is preserved for
  audit history.
- Every `host_credentials` row for the host with
  `revoked_at IS NULL` is swept (idempotent: a half-failed prior
  revoke is reconciled).
- If a live outbound WS is currently attached for that host,
  the controller closes it with WS code **1008** and reason
  **`host_revoked`** (D4.c C2). The renderer reacts immediately
  (no waiting for the next heartbeat / config-poll cycle).
- Cross-user revoke attempts return 404 (not 403) and do NOT
  call `disconnectHost` — anti-enumeration boundary.
- Re-claim after revoke transparently mints a fresh active host
  row for the same `(user, installation_id)`; the partial-unique
  index is keyed on active rows only (B.4).

#### 12.8.3 Signup toggle — config is boot-frozen

The `signupEnabled` flag (resolved from `SILVERHAND_DISABLE_SIGNUP`)
is **read once at backend boot** and frozen on the
`BackendContext`. Hot-toggle (change config without restart) is
forbidden by design.

To lock down signup after the operator has created their account:

1. Edit the deployment's env / `EnvironmentFile`:
   `SILVERHAND_DISABLE_SIGNUP=1`.
2. Restart the backend service (`systemctl restart silverhand-server`
   or equivalent). The new boot picks up the value.
3. Verify: `GET /api/server/info` returns `signup_enabled: false`.
   `POST /auth/signup` returns 403 with body
   `{ code: 'signup_disabled' }` (always-mounted route per D4.a
   Commit 4).

What does **not** happen across the toggle (pinned by C8):

- Existing user-session bearers remain valid. No forced logout.
- Existing host_token rows remain valid; daemons stay attached.
  `host_credentials` rows are not consumed, revoked, or rotated
  on the restart.

The toggle is reversible: setting `SILVERHAND_DISABLE_SIGNUP=0`
(or removing the env var) and restarting re-opens signup.

#### 12.8.4 `clearSession` — `503` / `409` typed codes (C7)

`POST /api/agents/:id/clear-session` clears the resumable
`cli_session_id` on a `(conversation, agent)` pair so the next
`runtime_start` is a fresh spawn rather than a `--resume`. In
standalone mode the route's typed-error responses:

- **`503 clear_session_timeout`** — backend dispatched
  `runtime_clear_session` to the daemon and received the daemon's
  `result.cleared` acknowledgement, but the corresponding
  `runtime_exit` projection did not land within
  `CLEAR_SESSION_EXIT_TIMEOUT_MS` (10s). The DB row is left
  UNCHANGED (no partial commit). **Operator action**: safe to
  retry; the next attempt either lands `runtime_exit` and
  commits, or surfaces a stable error (e.g. daemon detached).
- **`409 clear_session_in_progress`** — a concurrent
  `clearSession` for the same `(conv, agent)` pair is in
  flight. **Operator action**: do not retry immediately; let the
  first call complete (success or `503`) and only then issue the
  next.

Neither code is in the placement taxonomy
(`placementErrorStatusMap`); both are route-local typed errors
because they describe transient lifecycle conditions, not
placement decisions.

#### 12.8.5 Multi-daemon — sticky host ownership, no auto failover

V1 does **not** auto-migrate or auto-failover an agent between
daemons. An agent's `host_id` is set at the membership / first-claim
moment and stays there. If a user has multiple desktops with
multiple daemons:

- Agents created on desktop A stay pinned to host A; their
  runtime can only run on the daemon attached to host A.
- The cross-host perimeter (C5/C6) drops any frame whose
  `agent.host_id` does not match the connection's hostId, so
  there is no silent cross-pollination.
- If host A is offline, agents pinned to host A surface as
  unavailable (`host_attach_pending`). They do **not** transparently
  start on host B.

Operator-side recovery from a permanently lost desktop: revoke
host A, then re-claim against host B with the same
`installation_id` (Stage B.4 minted-on-claim partial-unique index
makes this safe). The pinned agents stay where they were unless
the operator explicitly moves them; M1 has no automated migration
tool. T1 / M2 may layer one on later.

---

## 13. Review log

- **2026-05-28 — Draft 1 (Alice)**. Thread `#conv:z8B7l4UPhwUc0OOB`
  converged P1/P2/P3 framing + 4-task split (D4.0 / D4.a/G1 /
  D4.b/G2 / D4.c/G3) + TLS policy (system CA / SPKI pin / typed
  fail) + Option A signup with 5 hard lock-in conditions + R4
  deferral with grep-able TODO anchor format + doc structure
  (separate design contract + roadmap link, not roadmap-only). shiki
  product-confirmed Option A and "P1-P3 OK". Cindy preview-aligned
  on review angle: lock P1/P2/P3, G1/G2/G3 acceptance observable,
  no sub-slice mixing R4 paydown.
- **2026-05-28 — Round 2 (Alice)**. Addresses Cindy round-1 review:
  - **B1 signup-disabled contract contradiction**: §6.2 rewrote
    operator lock-down to "route stays mounted, returns `403
    { code: 'signup_disabled' }`" (changes A.2 hide-as-missing
    behaviour; D4.a updates the A.2 routes test in the same PR).
    §5.1 G1 acceptance line updated to match.
  - **B2 TLS pinning didn't cover pre-auth desktop flow**: new §7
    "Server connection profile" inserted as the single source of
    `{server_url, spki_pin?}` for all desktop→backend transport
    across pre-auth + post-auth. Storage is desktop-main exclusive
    (`safeStorage`-encrypted, mode 0600); daemon never reads the
    profile, only reads the derived daemon-config artifact (Cindy
    correction). Profile update flow is "validated-first + staged
    writes + old retained on pre-commit failure; post-profile-commit
    daemon-config/reload failure surfaces typed
    `partial_apply_pending` state and blocks success UI"; no
    cross-file transaction pretence (Cindy correction). Recovery is
    explicit: user Retry / desktop restart / daemon restart all
    converge `partial_apply_pending` → `fully_applied`, never stuck.
    `profile_version` enters daemon-config fingerprint to avoid
    no-op reload misjudgement, but stays local-only — never in any
    outbound frame or auth header (Cindy R4-scope nuance). Setup
    Wizard self-signed UX uses out-of-band SPKI verification with
    diagnostic-only fingerprint display (no one-click trust, Cindy
    lock). `rejectUnauthorized: false` grep gate extended to
    `apps/desktop/src/**` and `packages/shared/**` /
    `packages/cli/**` per Cindy boundary.
  - **B3 pinned_spki_verified bypassed hostname/expiry**: §8.1
    accept matrix rewrote pinned path as conjunction "(pin match)
    AND (hostname match) AND (not expired)". §8.2 typed failure
    codes given explicit evaluation order (pin mismatch first;
    chain invalid; hostname mismatch; expired). SPKI pin replaces
    only chain trust, not hostname or expiry.
  - **Doc structure refinements**: Renumbered §7 (TLS) → §8 to make
    room for new §7 (Server connection profile); subsequent
    sections shift accordingly (§9 R4 / §10 Non-goals / §11 Hard
    ordering / §12 Runbook / §13 Review log). Cross-refs updated.
  - **§12 Runbook skeleton**: locked seven skeleton sub-headings
    so D4.a cannot accidentally drop pre-auth profile setup,
    SPKI pin entry recipe, or post-signup lock-down steps. Prose
    stays D4.a's responsibility.
  - **§11 Hard ordering soak**: kept informal per Cindy's review
    point answer (no fixed 48h window).
  - Pending Cindy round 2 review.
- **2026-05-28 — Round 3 (Alice)**. Addresses Cindy round-2 review
  + shiki's product-scope simplification on TLS:
  - **Cindy round-2 P1 stale signup wording**: §5.3 (G3
    signup-toggle negative) and §6.3 condition 2 (G1 dogfood
    checklist) had stale "route not mounted" / "boot-time gate"
    wording left over from round-1; rewritten to match the §6.2
    "route always mounted, handler branches on `signup_enabled`,
    returns `403 { code: 'signup_disabled' }`" contract.
  - **Cindy round-2 P1/P2 daemon-config field name**: §7.6
    rewrote the daemon-config schema to keep the existing
    `server_url` field name (matching
    `packages/shared/src/config.ts:35-39` and the daemon outbound
    consumer at `packages/host/src/daemon/outbound-client.ts`)
    instead of silently renaming it to `effective_url`. D4.a is
    now an **additive** migration: existing fields stay as-is,
    only `profile_version` (and originally `spki_pin`, now
    removed) is added. `effective_url` survives as a documentation
    term only.
  - **Cindy round-2 nit on pin/renderer wording**: §7.2 rewrote
    "same threat model as bearer tokens" to "SPKI fingerprint is
    trust-policy material, not a bearer secret". Distinguished
    "persisted profile flows main→renderer as redacted view" from
    "renderer can submit candidate pin to main"; clarified that
    confidentiality is not the threat being protected — integrity
    of the persisted policy and origin of pin entry are. (Section
    further simplified in round 3 once pin path was removed
    entirely.)
  - **Roadmap stale §8 → §9 R4 cross-refs**:
    `docs/remote-backend-roadmap.md` had two pointers to the old
    R4 section number; updated to §9 to match the
    post-§7-insertion numbering.
  - **shiki round-3 product call — V1 TLS simplification to
    system-default only**. shiki (2026-05-28 01:48) +
    Cindy (concurrent endorsement) decided V1 should not ship a
    self-signed / SPKI pin path. D4 is for getting the
    deployment-form-works loop closed (G1 → G2 → G3); a custom
    TLS verifier is "明显超出 G1 的最小必要面" (Cindy). Deletions:
    - §7.1 profile shape: dropped `spki_pin`. Also dropped
      `insecure_dev` per Cindy round-3 correction — it is derived
      runtime state from `(server_url scheme, host literal class,
      env flag)`, not stable config; persisting it creates
      drift if env is toggled later. Final shape:
      `{ version, server_url, created_at, updated_at }`.
    - §7.2: dropped the trust-policy material / pin-submission
      paragraphs; renderer-facing redacted view now just
      `{ server_url, updated_at }`.
    - §7.3 coverage: "single source of `server_url`" (no pin).
    - §7.4 Setup Wizard: dropped "Advanced → SPKI pin"
      collapsible; on `host_tls_chain_invalid` the wizard now
      points the user to the runbook §12.1 prereqs (fix at server
      side / install CA into system trust store), not to an
      in-app TLS bypass.
    - §7.5 profile update flow: kept the validated-first + phase-1
      + phase-2 + `partial_apply_pending` recovery mechanism (URL
      change still needs cross-file coordination); dropped pin
      rotation language.
    - §7.6 daemon-config: dropped `spki_pin`; kept
      `profile_version`.
    - §8.1 accept matrix: single state `system_ca_verified` (was
      two states).
    - §8.2 typed failure codes: three codes
      (`host_tls_chain_invalid` / `host_tls_hostname_mismatch` /
      `host_tls_expired`); evaluation order simplified; pin
      mismatch path removed.
    - §8.3 SPKI pin specifics: **entire subsection replaced** with
      "`rejectUnauthorized: false` — absolute ban, no exception".
      The audited-helper / `verifyPinnedTlsProfile()` exception
      from round 2 is gone; the CI grep gate is now a clean zero
      forward-matches on the full TLS client surface.
    - §10 non-goals: added "self-signed remote backend / SPKI pin
      / TOFU / custom TLS verifier / `verifyPinnedTlsProfile()`
      helper" as an explicit deferral, with attribution to the
      round 1+2 → round 3 evolution.
    - §12 runbook: tightened §12.1 prereqs to require CA-trusted
      TLS via reverse proxy (Caddy / Tailscale Funnel / Let's
      Encrypt + nginx / system-trust-installed private CA), with
      loopback http allowed only for embedded dev; dropped the
      `openssl s_client` SPKI fingerprint recipe from §12.3.
    Net diff: roughly 200 lines removed from §7+§8+§12; the
    contract is materially smaller and Cindy round-2 P1's
    "absolute ban vs. SPKI helper exception" conflict is resolved
    by the absolute ban now being literally true.
  - Pending Cindy round 3 review.

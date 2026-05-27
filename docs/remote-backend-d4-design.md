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
- TLS policy (system CA / SPKI pin / typed fail)
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
of this doc beyond §8 (R4 deferral mechanics).

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
  attach over a non-loopback non-TLS server URL** — §7.
- Readiness probe: `GET /readyz` returns 200 once migrations applied,
  DB writable, listen socket open.

**Operator runbook** (will live in `docs/remote-backend-d4-design.md`
tail — §11 of this doc, drafted in D4.a alongside the implementation).

---

## 5. Gate acceptance criteria

All three gates must pass to call D4 complete.

### 5.1 G1 — Standalone control plane

**Must work** (these block G1 acceptance):

- Standalone backend boots on a remote machine, `/readyz` returns 200.
- Desktop in remote mode points at `https://<remote>` (or
  loopback-http per §7) and reaches it.
- `POST /auth/signup` works (when signup enabled) end-to-end against
  remote.
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
  per §7); attachment is observable in Hosts UI within `connecting →
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
  `POST /auth/signup` returns `signup_disabled` typed code (boot-time
  gate per A.2: route not mounted, **not** a request-time 404 from a
  mounted route).

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
- On boot with `DISABLE_SIGNUP=1`, the `/auth/signup` route is
  **not mounted** (same boot-time gate as A.2).
- Operator can re-enable by clearing the env and restarting. No
  admin API for live toggle in D4 (would expand auth surface).

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
   - signup-disabled path: `POST /auth/signup` returns typed
     `signup_disabled` (route not mounted, no 500, no silent
     fallback).
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

## 7. TLS policy

This section is the V1 daemon-side TLS verification contract for the
desktop daemon's outbound connection to the remote backend.

### 7.1 Accept matrix (Cindy phrasing lock)

The verification has **exactly two accept states**:

| Accept state | Meaning |
|--------------|---------|
| `system_ca_verified` | Cert chain to a system-trusted CA, valid hostname, not expired. **No pin required.** |
| `pinned_spki_verified` | Cert is not chain-verified by system CA, but the user has provided an explicit SPKI sha256 pin in the Hosts config and the observed cert's SPKI matches. |

Everything else is a typed fail. There is **no third accept state**.

### 7.2 Typed failure codes

Failures are surfaced with specific typed codes (not a generic
`tls_error`):

- `host_tls_chain_invalid` — cert does not chain to system CA and no
  pin is configured.
- `host_tls_hostname_mismatch` — chain valid but hostname doesn't
  match.
- `host_tls_expired` — cert (or any cert in chain) past its `notAfter`.
- `host_tls_pin_mismatch` — pin configured, observed SPKI does not
  match. Error detail carries `{ host_id, expected_spki_sha256,
  observed_spki_sha256 }` (no full cert, no chain, to avoid leaking a
  half-trusted artifact into the error path).

### 7.3 SPKI pin specifics

- Pin object: **SPKI sha256 fingerprint** (subject public key info),
  not leaf cert fingerprint. Reason: SPKI survives leaf cert renewal
  on the same key without re-pin; key rotation correctly forces
  explicit re-pin (fail-loud is intentional).
- Pin storage: in the Hosts config alongside `server_url`. Owner-only
  file (0600), already covered by D3 daemon-config-file semantics.
- Pin rotation flow (Hosts UI in D3.d gains a "rotate pin" affordance
  in D4.a):
  1. User pastes new SPKI fingerprint in Hosts UI.
  2. Daemon dry-runs a TLS handshake against `server_url` using the
     new pin.
  3. Handshake success → atomically replace pin in config.
  4. Handshake fail → keep old pin, surface typed error.
- **No TOFU**. Unknown self-signed cert without a configured pin →
  reject with `host_tls_chain_invalid` (not "accept once and pin
  automatically").
- **No `rejectUnauthorized: false`** anywhere in non-test code. CI
  grep gate enforces this on `packages/host/**` and
  `packages/backend/**`. Test-only escapes live in
  `packages/*/src/**/__tests__/**` only.

### 7.4 http vs https

- **System-CA path is the V1 supported remote path**. Most operators
  will terminate TLS at a reverse proxy with a Let's Encrypt or
  commercial CA cert; daemon verifies that path via standard
  system-CA chain validation.
- **http is allowed only for loopback literals**: `127.0.0.1`,
  `localhost`, `::1`. This preserves the embedded loopback case
  without opening a remote-http hole.
- **`*.local`, LAN IP literals, any non-loopback hostname over http**:
  requires `SILVERHAND_ALLOW_INSECURE_REMOTE=1` env (developer escape
  hatch). When this flag is set:
  - UI Hosts page marks the host with a visible "Insecure dev (HTTP,
    non-loopback)" warning badge.
  - `backend-<utc>.log` host attach event includes
    `insecure: true`.
  - This combination is **not a V1 supported remote path**. The
    runbook explicitly says so.

### 7.5 Revocation

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

## 8. R4 deferral mechanics

R4 paydown is D5 work (per P1). D4 must leave the drift in a state
where D5 can find and close it cleanly.

### 8.1 What the drift is

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

### 8.2 What D4 does about it

- D4 **does not** refactor `HostClient` or the embedded subscribe
  path.
- D4 **does** add grep-able TODO anchors at every drift hotspot, in a
  uniform format so D5 can audit-grep them in one pass.

### 8.3 Anchor format (mandatory)

Every D4 code change that touches a drift hotspot (or that would
otherwise paper over it) must add (or preserve) the anchor:

```
// TODO(D5,R4): unify with outbound frame envelope.
//   This call uses the embedded HostClient subscribe RPC, which
//   exposes a daemon RPC API distinct from the standalone WSS
//   outbound frame envelope. D5 unifies the envelope and reduces
//   embedded transport to a Unix-socket / in-proc adapter carrying
//   the same envelope frames.
//   See: docs/remote-backend-d4-design.md §8.
```

Required elements:

- `TODO(D5,R4)` literal — both tokens are part of the grep contract.
- Reference to this doc's §8 (so D5 reviewers can read the framing
  without re-discovering it).
- A one-paragraph "what this place does today" note (so the anchor
  is self-explaining without git blame archaeology).

D5 acceptance will require this anchor count to drop to **zero**.
Forbidden phrasings (will fail D4 review):

- "temporary hack" / "to be cleaned up later" / "FIXME": these are
  unverifiable. The anchor must point at a specific D5 target.
- Missing `R4` tag: D5 audit will grep for `D5,R4` together.

### 8.4 Code review enforcement

D4 PR descriptions must explicitly state:

> "This IPC / RPC surface is local supervisor / control transport,
> not server↔daemon formal semantics. R4 drift is captured by
> `TODO(D5,R4)` anchors per `docs/remote-backend-d4-design.md §8`."

This phrasing was agreed with Cindy for D3.b/c and continues for D4.

---

## 9. Non-goals (push back if asked)

The following are out of scope for D4 and must not be conflated with
G1/G2/G3 acceptance:

- **R4 protocol envelope unification** — D5. Captured by `TODO(D5,R4)`
  anchors only.
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
- **OCSP / CRL revocation as a hard gate** — best-effort per §7.5.

Each item has a place either in the roadmap follow-up phase, a later
V1.x, or D5. The rule remains *not yet*, not *never*.

---

## 10. Hard ordering

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

## 11. Runbook (drafted in D4.a)

This section is a placeholder. The standalone deployment runbook —
how to provision a host, install the backend, configure env, terminate
TLS at a reverse proxy, perform the post-signup lock-down — is drafted
**inside D4.a** alongside the implementation that backs it, so the
two stay in sync. Final form: appended here in §11 in D4.a's commit
chain.

---

## 12. Review log

- **2026-05-28 — Draft 1 (Alice)**. Thread `#conv:z8B7l4UPhwUc0OOB`
  converged P1/P2/P3 framing + 4-task split (D4.0 / D4.a/G1 /
  D4.b/G2 / D4.c/G3) + TLS policy (system CA / SPKI pin / typed
  fail) + Option A signup with 5 hard lock-in conditions + R4
  deferral with grep-able TODO anchor format + doc structure
  (separate design contract + roadmap link, not roadmap-only). shiki
  product-confirmed Option A and "P1-P3 OK". Cindy preview-aligned
  on review angle: lock P1/P2/P3, G1/G2/G3 acceptance observable,
  no sub-slice mixing R4 paydown. Pending Cindy review of full draft.

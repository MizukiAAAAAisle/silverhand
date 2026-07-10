# User-managed Computer — design v1

> **Status**: v1 design draft (2026-07-06, Alice). Owns the **user-facing
> "New computer" provisioning path** and the model changes that let a user
> create, name, and attach a computer that the app did not install. Direction
> confirmed by shiki (#task:1345 thread): runtime model unifies onto one active
> host/computer form; provisioning stays two staged create paths; long-term target
> is desktop's own computer also converging onto auto-invite.
>
> **Reviewer**: @Cindy (hard lines: source field must not enter runtime
> capability branches; pending host must not leak into picker/placement; user
> New-computer must not reuse `claim-or-create` / `installation_id` semantics).
>
> **Interaction design (§7)**: @Norman owns; his seq-22 "connection-wait" spec is
> folded in as the interaction section. Mockup + UI task land at execution stage.
>
> **Acceptance (§9)**: @Mbappe's release-blocker checklist, recorded here; walked
> at the verification stage, not during design.
>
> **Must-read first**:
> - `docs/auth-and-host-model.md` §6 — the host-credential lifecycle and the
>   **already-specified** remote provisioning flow (§6.2) this doc activates.
> - `docs/multi-daemon-registry.md` — daemon identity (daemon_id / instance_id /
>   host_descriptor / hosts.id) and `RuntimeHostRegistry`.
> - `docs/remote-server-target-architecture.md` — Phase 3 (desktop remote
>   connection) + Phase 4 (outbound daemon-host) this feature makes user-visible.
> - `docs/architecture-principles.md` §9 — control plane vs execution plane.

---

## 0. What this doc owns / does not own

**Owns**:
- The domain answer to shiki's question: *does a user-managed computer coexist
  with the app-install-bound host, and can the two be fused?* (§1, §8)
- The unified runtime model: every **active** computer is one shape regardless of
  how it was provisioned (§2).
- The identity/lifecycle semantics — `hosts.id` = identity, `installation_id` =
  desktop idempotency key, the new `provisioning_source` = lifecycle metadata,
  and the pending → attached → active → revoked lifecycle (§3, §4).
- The user-facing New-computer flow wired onto the existing credential model
  (§5, §6), plus interaction design (§7).
- Coexistence + migration + the staged path toward desktop-as-auto-invite (§8).
- Acceptance / release blockers (§9).

**Does NOT own** (consumed, not redesigned here):
- The `host_credentials` table and the host-credential lifecycle — owned by
  `auth-and-host-model.md`. Already in schema (`kind IN ('long_lived',
  'bootstrap')`). This doc consumes the **table and the standing-credential arm**;
  the user-managed `connect-token` is stored in it (hashed) as the standing bearer
  credential. This doc deliberately does **not** use the `bootstrap → exchange`
  two-step (§5) — the `bootstrap` credential kind is simply left unused by this
  path.
- `RuntimeHostRegistry` mechanics, daemon identity layers, placement key —
  `multi-daemon-registry.md`.
- Sandbox FS/permission UX — `multi-daemon-registry.md` §8. A user-managed
  computer is orthogonal to sandboxing; a sandbox is a *capability* of a daemon,
  not a provisioning source.
- Cross-daemon mid-run migration of a live (conv, agent) — explicitly out of
  scope everywhere.

---

## 1. The question, answered

**Q (shiki #4): 这套机制跟当前的 app 安装锁定 host 机制融洽吗?能融合吗?**

**A: 完全融洽,而且身份模型根本不用改——因为它现在就没把 device 当 identity。融合发生在运行态,不在创建/连接协议。**

Verified against code (2026-07-06):

- `hosts` table (`baseline-schema.ts`): `id` is the identity. `installation_id`
  is `nullable`. The unique index that enforces "one host per install" is
  **partial** — `uniq_hosts_user_installation_when_active ... WHERE user_id IS
  NOT NULL AND installation_id IS NOT NULL AND revoked_at IS NULL`. It does not
  constrain rows where `installation_id IS NULL`.
- `RuntimeHostPlacementResolver.resolveOwnedLocalForUser` already returns
  `0 → local_host_unbound / 1 → ok / ≥2 → local_host_ambiguous`
  (`host-repo.ts:listOwnedActiveLocalForUser` + comment). The "one user, one
  machine, multiple active hosts" case is **already modeled**.
- `host_credentials` already carries `kind = bootstrap | long_lived`; revoke /
  rotate-token / status routes already exist.

Consequence: a user-created computer that carries `installation_id = NULL` is
**already schema-legal** and does not collide with the desktop's install-bound
host — even on the same physical device. shiki's worry ("不再锁定设备唯一了") is
correct as an observation but is *not* an invariant being broken:
device-uniqueness was never an identity invariant. `installation_id` is only the
**desktop auto-registration idempotency key**, and its uniqueness is already
scoped `WHERE installation_id IS NOT NULL`.

So this feature is **displacement, not rebuild**: most of the substrate exists;
what's missing is (a) a second create path, (b) an explicit `provisioning_source`
label, (c) an explicit pending lifecycle, and (d) the UX.

---

## 2. Terminal-state model — one active computer shape

From the終局: there is exactly **one** kind of thing a user manages, places
agents on, inspects, and revokes. Call it a **computer** in the UI, a **host** in
the domain (ubiquitous language: `computer` (UI) ≡ `host` (domain/DB) — one
concept, one name mapping; `daemon` = the replaceable process that attaches to
it).

An **active computer** is, uniformly:

```
host_id + attached daemon instance + credentials + status + placement target
```

Everything downstream — agent/workspace placement, host status page, `revoke`,
`rotate-token`, agents-on-host list, event-WebSocket availability — reads this one shape and
**never branches on how the host was provisioned**. This is the fusion Cindy
named: *运行态统一,创建/身份协议分两条,最终收敛到一个 active host 形态*.

The only thing that differs between an app-installed computer and a
user-created one is **how it got to `active`** — the create/connect path. Two
entry surfaces, one terminal state.

---

## 3. Identity & lifecycle semantics — three layers + a red-line

The single most important rule of this design: **do not let "how it was created"
become a second identity axis.**

| field | role | scope of consumption |
|---|---|---|
| `hosts.id` | **The** identity. Placement, membership, credential ownership, status all key on it. | everywhere |
| `installation_id` (nullable) | Desktop app-managed default computer's **recovery / idempotency key**. NOT device identity, NOT a general uniqueness constraint. | **only** the desktop `claim-or-create` fast path (§5.1) |
| `provisioning_source` (**new**: `app_install` \| `user_invite` \| `system`) | Pure **lifecycle / origin metadata**. Explains where a host came from; drives nothing runtime. `system` = backend-created placeholder (e.g. `ensureStandaloneServer`), never user-managed. | **only** UI copy, connect/recovery flow selection, revoke/rotate messaging |
| `activated_at` (**new**, nullable timestamp) | **Technical-connection** fact. `NULL` until the first successful authenticated WS attach (`GET /api/hosts/connect` with `Bearer <connect-token>`); for the trusted desktop fast path it is set atomically at claim (§5.1). **NOT** set at token-issuance time. Attachment alone does **not** make a computer real (see `finalized_at`). | composed into the readiness predicate (§4) |
| `finalized_at` (**new**, nullable timestamp) | **User-commitment** fact. `NULL` = the row is still a *setup draft* even if a daemon has already attached; set when the user confirms the Add computer flow (names it / Done, §5.2) — for the desktop fast path, atomically at claim. `activated_at` and `finalized_at` are two genuinely distinct facts (technical connect ⊥ user commitment) that occur at different times; separating them is what lets an attached-but-unconfirmed machine stay a discardable draft. | composed into the readiness predicate (§4) |

### 3.1 The `provisioning_source` red-line (hard)

**Umbrella principle — the Unified Computer model (ratified 2026-07-06, shiki +
team).** app-managed and user-managed are **two attach / provisioning paths of
ONE Computer model, not two runtime models** — the Computer-level instance of the
Human/Agent isomorphism this codebase already enforces (`architecture-principles.md`).
Runtime capability is answered **only** from `hostId + ownership (user_id) +
lifecycle (finalized / revoked) + live attachment + credential` — never from
`provisioning_source` / `kind`. Corollaries that fall out of this and are review-gated:
- **One dispatch port.** Every command to a computer flows through the single
  composite `outboundFrameAdapter`, routed by host id (kind-agnostic). No
  desktop-main-local IPC bypass may be added (the bug that caused user-managed
  computers to read `offline`, fixed in `067019f`).
- **Host-local truth lives on the target daemon.** proxy, agent runtime,
  workspace registry, etc. are read/written by the owning daemon in its own
  isomorphic per-computer profile dir — never by the app reaching a shared local
  file. Editing them is availability-gated (only while the computer is online).
- **Legitimate provenance differences stay attributes, not forks.** app-managed
  being non-removable / auto-provisioned is a real lifecycle fact expressed as a
  badge + lifecycle state — never a styling or capability fork. Terminal goal
  (§8.2): desktop converges to auto-invite and the two paths become one.

`provisioning_source` is allowed **only** in: (a) rendered UI copy, (b) selecting
which connect/recovery flow applies, (c) revoke/rotate messaging. It is
**forbidden** in placement, routing, ACL, capability, and any runtime-capability
decision.

**Enforceable判据 for review**: any `if (provisioning_source === …)` (or switch)
appearing in placement / routing / ACL / capability code is a model leak — reject
it. Runtime capability answers come only from: host `active`/`revoked`,
ownership (`user_id`), credentials, and attachment/status. The moment the source
field gates a runtime capability, it has silently become a second identity axis —
exactly the rot this doc exists to prevent.

The same red-line has a **UI corollary** (Norman): the rail renders app-managed
and user-created computers with the *same card*, differing only by an
`app-managed` badge + a non-removable attribute — no forked visual treatment. If
the visual diverges by source, the red-line has leaked into the renderer.

### 3.2 Why timestamps (`activated_at` / `finalized_at`) rather than a `status` enum string

Following the codebase's `revoked_at` pattern (timestamp-as-state, single source
of truth), the host lifecycle is four-valued and fully derivable from three
authoritative timestamps:

```
revoked_at != NULL                                  → revoked
activated_at != NULL AND finalized_at != NULL       → active   (a real computer)
activated_at != NULL AND finalized_at == NULL       → attached (daemon connected, not yet confirmed)
otherwise (activated_at == NULL)                    → pending  (created, never connected)
```

The `status` enum in the DTO (`pending | attached | active | revoked`) is
**derived** from these timestamps by one backend helper, never a stored second
source of truth that can drift — the renderer buckets rail/modal off `status`
instead of re-deriving from raw timestamps. **Resolved (Cindy):** `activated_at`
and `finalized_at` are explicit columns (both are host-lifecycle facts that must
survive credential rotation, and a column is cheaper to filter than a subquery).
Their semantics are pinned: `activated_at` = "first successful authenticated
daemon attach", `finalized_at` = "user confirmed the Add computer flow" — two
distinct facts, so a computer whose token was issued (or even attached) but never
confirmed stays a **draft**, not a real computer (§4 / §5.2).

---

## 4. Host lifecycle — one state machine, two connect entries

```
                     ┌──────────── desktop fast path (§5.1): create + activate ───────────┐
                     │            + finalize atomically (trusted launcher)                 │
                     ▼                                                                      │
 (nonexistent) ─► pending ─► attached ─► active ─► revoked                                  │
                     ▲  │    first auth   user      revoke (hard, immediate)                │
                     │  │     connect    confirms                                           │
                     │  │              (name/Done)                                          │
                     │  └──► (deleted): cancel setup pre-finalize = hard-delete draft;      │
                     │           token cascade-dropped + live WS force-dropped (§5.2)       │
                     └──────── user invite path (§5.2): create pending, wait ───────────────┘
```

- **pending**: host row exists, `activated_at IS NULL`. A `connect-token` has been
  issued (the user has been shown the command) but no daemon has completed an
  authenticated attach yet.
- **attached**: `activated_at` set, `finalized_at IS NULL`. A daemon **is
  connected** (there may be a live WS), but the user has not confirmed the Add
  computer flow — so this is still a **setup draft**, not a real computer.
- Both **pending** and **attached** are *ephemeral setup drafts, not committed
  entities* (ratified by shiki, 2026-07-06): they hold no placements, no history.
  They live only in the Add computer modal — the bulk host list hides all
  unfinalized `user_invite` rows, so a draft never appears in the rail / picker /
  placement. **Any close before finalize (`DELETE /api/hosts/:id`, §5.2)
  hard-deletes the draft** — its `connect-token` cascade-drops and, for an
  `attached` draft, its live WS is force-dropped — no tombstone, no orphan. Cancel
  is a *delete*, not the soft `revoke` reserved for computers that had a real life.
  (Parking a draft in the rail for later — the old "waits in the background"
  behavior — is a **deferred** explicit opt-in, not this cut; see §7.)
- **active**: `activated_at` **and** `finalized_at` both set — a real, committed
  computer. The user confirmed the flow (named it); only now does it enter the
  rail / list / placement.
- **revoked**: `revoked_at` set; the `connect-token` is hard-denied immediately and
  any live WS is force-dropped (existing `revoke` semantics, no grace — §5.3).

**The readiness / eligibility predicate** — applied **after** owner scope / ACL,
and deliberately **`kind`-independent** (see §5.4):

```
activated_at IS NOT NULL AND finalized_at IS NOT NULL AND revoked_at IS NULL
```

It is **not** the complete selection condition and must not be read as replacing
ownership/ACL. The full picker/placement selection is **owner-scoped +
activated + finalized + not revoked**; runtime dispatch then further requires
credential/attachment/status. Within the *readiness* dimension, this is the
single gate — and it is where "unfinalized draft must not enter placement"
(blocker §9.1) is enforced **by construction**: a `pending` host has
`activated_at IS NULL` and an `attached` draft has `finalized_at IS NULL`, so both
fail the readiness predicate everywhere it is applied. Do not scatter ad-hoc "is
it ready?" checks; funnel every picker/placement read through this one predicate
(composed with owner scope), never through `kind`. **Separately**, the bulk host
list (`GET /api/hosts`, feeding the rail) hides unfinalized `user_invite` drafts
outright (`NOT (provisioning_source = 'user_invite' AND finalized_at IS NULL)`),
so a draft is invisible to *every* rendered surface — this list predicate keeps
`revoked` rows (the rail shows them), so it is intentionally **not** the readiness
predicate.

### 4.1 Two entries converge; they do not fork the model

- **Desktop fast path** = `pending → attached → active` collapsed into one atomic
  trusted step (`activated_at` and `finalized_at` set together): the app has its
  own credentials, spawns its own local daemon over the Unix socket, and names it
  "This Mac" by default. It can skip the interactive wait + explicit confirm
  because the launcher is trusted and co-located.
- **User invite path** = the interactive walk through the *same* states: create
  `pending`, issue a `connect-token`, user runs the daemon `connect` command
  somewhere, server waits, daemon attaches with the token → `attached` on that
  first successful attach, user confirms by naming it (finalize) → `active`.

Same aggregate, same terminal `active` shape. `claim-or-create` is a
**specialization** of the general create-pending→connect protocol (trusted +
idempotent-by-`installation_id`), not a parallel universe. This framing is what
prevents the app-managed special-case branches from metastasizing.

### 4.2 Host-touching partition semantics — declare before rendering

User-managed computers make Silverhand a distributed system: the backend owns
control-plane truth, while the target computer owns host-local truth. Any
operation that touches host-local truth must explicitly declare what happens
when that computer is offline, unreachable, or in a transient setup state.

This declaration is a **backend / shared-contract property**, not a renderer
guess. The renderer consumes the declared semantics and renders the matching
copy/affordance; it must not re-derive partition behavior from `kind`,
`provisioning_source`, status-query freshness, cached host rows, or local
knowledge of a specific endpoint. This is the same rule as placement readiness:
the backend owns the predicate, the renderer displays it.

Every host-touching operation must fit one of these buckets:

| partition semantics | Meaning | UI consequence |
|---|---|---|
| `offline-completable` | Pure control-plane mutation. The operation does not require live host-local state. | Allow while offline. Do not disable on daemon liveness. |
| `best-effort` | The control-plane operation may complete even if host-local cleanup / notification fails. | Allow, and surface only real control-plane failure. Log host-local misses for diagnostics. |
| `requires-connection` | Correctness requires the target daemon to answer now. | Disable or fail with a product error that says to connect the computer first. |
| `cascade-with-residue` | A higher-level aggregate delete is allowed to proceed while host-local residue may remain. | Require explicit consequence confirmation; do not pretend host-local wipe happened. |
| `retry-later` | A transient lifecycle state is in progress; neither success nor structural cascade is correct yet. | Show a retry-later state. Do not collapse into a structural `has_dependents` / cascade flow. |

Canonical examples:

- Runtime catalog detection and proxy editing are `requires-connection`: the
  target computer is the source of truth.
- Workspace deletion is `offline-completable` plus `best-effort` runtime cleanup:
  a disconnected computer must not make a regular workspace undeletable.
- Direct delete-agent is `requires-connection` for active agents because
  fail-closed host-local purge protects files/secrets from being orphaned on a
  temporarily disconnected computer.
- Delete-computer can be `cascade-with-residue` for its own agents because
  "remove this computer" is the aggregate-level decommission intent; the backend
  must still recompute dependents and keep regular workspaces as hard blockers.
- Pending materialization is `retry-later`: it is not a structural dependent set
  the user can confirm through.

Initial classification for the current user-facing surface:

| operation | partition semantics | Notes |
|---|---|---|
| Create user-managed computer draft / cancel unfinalized draft | `offline-completable` | Pure control-plane setup lifecycle. If a draft happened to attach, live disconnect is best-effort cleanup. |
| Finalize Add-computer flow | `retry-later` until attached, then control-plane commit | Naming/finalize is not valid until the daemon has attached at least once. |
| Runtime catalog detection | `requires-connection` | The target computer owns PATH, installed runtimes, and version checks. |
| Agent creation/materialization on a target computer | `requires-connection`; `retry-later` while materialization is pending | Host-local agent home and runtime setup live on the target computer. |
| Runtime start/stop/restart/clear-session commands | `requires-connection` | They address a live runtime host. |
| Proxy get/set | `requires-connection` | Proxy config is host-local runtime configuration, not backend desired state. |
| Disconnect current computer connection | `best-effort` | Drops the current live attachment if present; already-offline is a benign no-op. |
| Rotate/revoke computer credentials | `offline-completable` plus best-effort live disconnect | Credential invalidation is control-plane authoritative and must work while the computer is offline; live socket drop is immediate when available and non-blocking when not. |
| Delete a regular workspace | `offline-completable` plus best-effort runtime cleanup | A disconnected computer must not make a control-plane workspace undeletable. |
| Delete an agent | `requires-connection` for active host-local purge | Direct agent deletion is fail-closed to avoid orphaning files/secrets on a temporarily disconnected computer. |
| Delete an empty user-managed computer | `offline-completable` plus best-effort live disconnect | The computer row/credentials are the authority; a running daemon process may outlive the row but cannot stay attached. |
| Delete a user-managed computer with only agent dependents | `cascade-with-residue` | The computer is the aggregate-level decommission intent; backend must recompute dependents and show the delete-set. |
| Delete a user-managed computer with regular workspace dependents | hard block, not a partition bucket | Regular workspaces are structural dependents and must be cleared in their own context first. |

Renderer copy should come from a small semantic vocabulary keyed by the bucket,
not from one-off endpoint prose. The contract owns the template **shape**; the
renderer owns final product wording:

- `offline-completable`: no offline-specific copy. Silent success is the right
  UX; do not add "worked while offline" notices.
- `best-effort`: no user-visible warning for host-local misses. Report only real
  control-plane failure; best-effort host-local misses belong in diagnostics.
- `requires-connection`: name the unavailable computer authority and give one
  recovery action.
- `retry-later`: say the operation is temporarily unavailable and invite retry.
- `cascade-with-residue`: name the consequence and render the backend-provided
  delete-set, not a daemon status snapshot. Do not surface host-file residue in
  the confirm copy; that is internal cleanup semantics, not the user-facing
  consequence.

The same declaration also feeds any future Computer health / diagnostics
surface. The health page is an aggregation of operation semantics and host-local
facts; it is not the authority that decides whether an operation is allowed.

Review rule: when adding or changing any operation that touches a computer,
first classify its partition semantics. If the operation cannot be classified,
the model is incomplete and the implementation should stop before adding UI or
fallback behavior.

---

## 5. Backend — activate remote provisioning, simplified to one reusable token

The remote provisioning protocol in `auth-and-host-model.md §6.2` **already
describes this feature's shape** (create a host row, hand the target machine a
credential, daemon attaches over the outbound WS) and is deliberately unshipped
("schema arm exists, no V1 surface"). This doc ships that shape — but with one
**deliberate simplification driven by shiki's "same command every time"
requirement**: there is **no `bootstrap → exchange → long-lived token` two-step**.
The user is handed a single reusable **`connect-token`** that authenticates every
connect directly. See §5.2/§5.3 for why this is the right collapse and what it
costs.

### 5.1 Desktop path (unchanged, just labeled)

`POST /api/hosts/claim-or-create` stays exactly as today (§6.1 of the auth doc).
Additions:
- writes `provisioning_source = 'app_install'`,
- sets `activated_at` at claim time (trusted fast path),
- keeps `installation_id` — its idempotency semantics stay confined to this path.

**Do not** relax `installation_id` to optional-and-shoehorned so this path also
serves user-created computers. That is the explicit anti-goal (Cindy's hard
line).

### 5.2 User invite path (new surface, connect-token model)

```
rail "New computer" (no name input yet)
  [main] POST /api/hosts { provisioning_source: 'user_invite' }
  [server] CREATE host row (user_id, installation_id=NULL, activated_at=NULL,
           provisioning_source='user_invite', kind='remote' (§5.4), display_label=NULL)
           ISSUE connect-token: a long-lived, single-computer-scoped bearer
             credential. Store ONLY its hash in host_credentials, bound to
             (host_id, user_id). The cleartext is returned once, for display.
           RETURN { host_id, host, connect_token,
                    daemon_npm_spec (server-owned launch recipe, §6.1) }
             The server returns NO url and NO assembled command string. The
             desktop assembles the connect command at the edge via shared
             `assembleConnectCommand`, using the URL it is itself connected to
             — the server never mints a command and so cannot leak its bind
             address as the daemon's reach URL (§4.3 of
             `docs/orchestration-boundary-v1.md`).
  [server] host is now `pending` (activated_at NULL, finalized_at NULL) → an
           ephemeral setup draft, modal-scoped; the bulk list hides it, so it is
           NOT in the rail / picker / placement
  ── cancel branch (any close before finalize) ────────────────────────────────────
  user closes / cancels the setup surface BEFORE finalize (may be pending OR attached)
  [main] DELETE /api/hosts/{id}   (apiPaths.hostCancelPending; accepts only owner's
         user_invite + remote where finalized_at IS NULL & not revoked)
  [server] HARD-DELETE the draft host row; its connect-token in host_credentials
           goes with it via `ON DELETE CASCADE` (token now verifies as missing —
           no tombstone). If the draft was already `attached` (live WS), also
           force-drop the socket (`disconnectHost`, non-blocking) so no daemon
           zombies onto a deleted host. Success 200 `{ host_id, deleted: true }`.
           Guarded races: already finalized → 409 `host_already_active` (benign —
           the user confirmed between close and this call; client treats as success
           / refresh, NOT a cancel failure); revoked → 409 `host_revoked`; not
           user-managed → 409 `provisioning_source_not_supported`; extreme race
           missing the DELETE predicate → 409 `pending_setup_not_cancellable`.
           Retry = Add computer again (fresh draft).
  ────────────────────────────────────────────────────────────────────────────────
  user runs the (always-identical) daemon connect command on the target machine
  [daemon] GET /api/hosts/connect-token/resolve  Authorization: Bearer <connect-token>
           → { host_id }   (preflight: the command carries no host_id, so the
           daemon proves token possession here and learns the server-side host_id
           purely for local data-root / config namespacing. NOT a credential
           exchange — the SAME token is reused verbatim as the WS bearer next.
           Server gate: remote && user_invite && user_id != null && not-revoked.)
  [daemon] GET /api/hosts/connect   Authorization: Bearer <connect-token>   (WS upgrade)
  [server] hash the presented token, look it up in host_credentials →
           resolve (host_id, user_id); verify not-revoked, not-expired;
           check LIVE attachment for this host (§5.3 concurrency):
             - already attached elsewhere → REJECT computer_already_connected
             - free → accept the WS
  [server] on the FIRST successful authenticated attach → SET activated_at
           host transitions pending → `attached` (still a draft); event WebSocket notifies renderer
  [modal]  polls GET /api/hosts/{id} (by-id returns the draft; the list does not) →
           observes status pending → attached; on `attached` it shows
           "Connected to <hostname>" + the name input for the first time
  user enters the final name → PATCH /api/hosts/{id} { display_label }
  [server] name required + must be already attached; in ONE transaction set
           display_label AND finalized_at (markFinalized) → host becomes `active`.
           Guards: not yet attached → 409 host_pending_attach; empty name → 400
           display_label_required. Finalize is the real commit, not a best-effort
           rename — on failure the modal stays open and retries.
  [reconnect] every later run is the SAME command → same GET /api/hosts/connect
              with the same Bearer <connect-token>; server re-resolves identity
              from the token each time. No exchange, no local credential to lose.
```

There is **no `POST /api/hosts/{id}/exchange`** and **no separate long-lived token
minted daemon-side**. The `connect-token` *is* the standing credential; identity
is resolved from it on every attach (`token → host_id`), so the command needs no
`host_id` and the target machine keeps no durable auth state of its own (§6.1).

Reused verbatim: `revoke`, `rotate-token` (rotation = the user-facing "regenerate"
— §5.3/§7), `GET /api/hosts/:id/status` (availability tagged union already covers
`available|disconnected|unreachable|revoked`), `GET /api/hosts/connect` (the
outbound WS upgrade — its auth is now the `connect-token`, see §5.4). New routes:
- `POST /api/hosts` — `user_invite` create + issue connect-token.
- `GET /api/hosts/connect-token/resolve` — daemon-facing preflight: Bearer
  connect-token → `{ host_id }`. Route-owned bearer auth (`verifyHostToken`),
  gated `remote && user_invite && user_id != null && not-revoked`, returns only
  the host_id. Lets the copied command stay host_id-free while the daemon learns
  the id it needs for local data-root / config namespacing. **Not** a credential
  exchange (§5.3): the same token is the WS bearer immediately after. *(Possible
  future simplification: fold host_id into the WS `ready` frame and drop this
  round-trip — backlog, not this cut.)*
- `GET /api/hosts/:id` — owner-scoped by-id read that **does** return an
  unfinalized draft (the bulk list hides it), so the Add computer modal can poll
  `pending → attached → active`. The by-id response also carries
  `connected_host_name` (nullable) — the live-attachment diagnostic (availability
  axis), sourced from the current WS attachment, **never** written into `name` /
  `display_label` (§7.1).
- `PATCH /api/hosts/:id { display_label }` — rename, and (for an unfinalized
  `user_invite` remote) the **finalize** commit: requires the host be already
  `attached` (else 409 `host_pending_attach`) and a non-empty name (else 400
  `display_label_required`), then sets `display_label` **and** `finalized_at` in
  one transaction → `active`. A post-finalize PATCH is a pure rename.
- `DELETE /api/hosts/:id` (`apiPaths.hostCancelPending`) — pre-finalize setup
  discard, accepts **only** owner's `user_invite + remote` where
  `finalized_at IS NULL AND revoked_at IS NULL`; the atomic DELETE predicate
  re-checks all of these, so a concurrent finalize between the handler's read and
  the delete makes it a no-op → 409 `host_already_active` (benign race).
  Hard-deletes the draft host; `host_credentials` cascade-deletes via FK,
  invalidating the token; if the draft was `attached`, the live WS is also
  force-dropped. No soft `revoke`, no tombstone — keeping cancel semantically
  distinct from revoke (which `active`/`revoked` computers use). DELETE (rather
  than a `POST /:id/cancel` action route) is a deliberate choice: it is an honest
  hard-delete, and can never mean "delete any computer" because the handler
  rejects finalized/`active`/`revoked` — the only reachable meaning is "discard
  this unfinalized draft".
- `POST /api/hosts/:id/disconnect` **(#1351 — landed, in_review)** — the
  credential-preserving connection release (§7 "Disconnect current connection").
  Owner-scoped, `user_invite` remote, not-revoked, finalized (else `409
  host_not_active`). Force-drops the current live WS via
  `hostWsController.disconnectHost` — the **WS-lifecycle side** of the
  dispatch/lifecycle invariant (touches the controller directly, *not* the
  composite `outboundFrameAdapter`) — and **leaves the connect-token untouched**,
  so the same command reconnects. Writes **no lifecycle timestamp** — that is the
  axis line between it and `revoke`/`rotate`, and why the three do not share a
  handler. Returns `{ host_id, host, disconnected }`: `disconnected` is
  `disconnectHost`'s boolean, so an already-disconnected / offline host is a
  benign `200 { disconnected: false }` no-op; only a genuine teardown throw is an
  error (`502 disconnect_failed`) — "nothing to drop" and "drop failed" stay
  distinct. The renderer additionally gates the button on availability (shown only
  when online) so it is never a dead click (Norman).

The auth doc's `POST /api/hosts/{id}/exchange` is **not** shipped by this design —
the connect-token model removes the need for it (revisit only if a future flow
needs a throwaway pairing secret distinct from the standing credential).

### 5.3 The `connect-token` — a standing bearer credential (blocker-grade rules)

The connect-token is the whole auth story for user-managed computers, so its rules
are hard requirements, not guidance.

**What it is.** A long-lived, **single-computer-scoped** bearer credential.
Server stores **only its hash** in `host_credentials`, bound to `(host_id,
user_id)`. It resolves identity (`token → host_id`) and authorizes every
`GET /api/hosts/connect`. The cleartext exists server-side only transiently, at
the moment it is minted (issuance or rotate), and is returned exactly once.

**Display lifecycle — hash-only, reveal-once (P1, resolved with Cindy; RATIFIED
by shiki).** "Server stores only the hash" and "the target page shows the full
command forever" are mutually exclusive — you cannot re-display a secret you only
kept the hash of. This design chooses **hash-only**, and the UI follows from it:

- The **full connect command (token included) is shown only in the session that
  minted it** — the create flow, or an explicit rotate. Within that session it is
  a password field: masked by default, click-to-reveal, copy-whole-command.
- **After that session (e.g. app restart), the target page cannot and does not
  reveal the old command.** There is no API that returns a stored cleartext token.
  The page's affordance to obtain a working command is **regenerate → rotate**
  (which mints a fresh token, shows the new command once, and invalidates the old).
- This is the standard API-key / PAT model (GitHub, Tailscale auth keys): shown
  once, then rotate if lost — and it is exactly why "treat it as a password" is the
  right frame (you reset a password, you never re-view it).
- **The rejected alternative** — persist an encrypted-at-rest cleartext so the
  page can re-show it — is *not* adopted: it reintroduces a recoverable standing
  secret on the server (key management + decryption-authority threat model) purely
  for display convenience, defeating the hash-only boundary. If shiki requires
  permanent re-viewing, the doc must switch to that model **and** rewrite the
  threat model (§9 acceptance then changes shape — Mbappe). Do not leave the
  implementer guessing between the two.

**The cost we are accepting, stated plainly.** Because the same command runs every
time, this standing credential lives in the connection command — therefore, *at
mint time*, in the renderer, the clipboard, the user's shell history, and
`ps`/process args on the target machine. This is a real widening versus a
short-lived single-use secret. We accept it because shiki's "identical command, no
local state" goal requires it, and we **bound the blast radius** so a leak is
survivable:

- **Scope is one computer, never the account.** A leaked connect-token lets an
  attacker impersonate exactly one computer — attach a daemon as that host. It is
  not a session token, grants no account access, and cannot enumerate or reach
  other hosts.
- **Instant, forceful revoke/rotate.** Revoke or rotate takes effect immediately
  and **force-drops any live WS for that host** — it does **not** wait for a
  heartbeat/pong cycle. Rotate invalidates the old token's hash and issues a new
  one; the old daemon's next frame is rejected and it is disconnected. This is the
  leak-response primitive and must be verified end-to-end (§9).
- **Never in derived/observable server surfaces.** The token must never be
  written to logs, emitted in a system message, stored in conversation history, or
  cached in a renderer query cache. It flows only: mint (issue/rotate) response →
  command card (masked) → user → target machine. (The old "long-lived token never
  crosses the renderer" boundary is **gone by construction** — there is no second
  token; this list plus the reveal-once lifecycle above is what replaces it.)
- **UI treats it as a password** (§7): masked by default, click-to-reveal,
  copy-whole-command, with an explicit "this is a credential, do not share" frame.

**Concurrency — reject the later connect, never silent-replace (shiki, decided).**
If a second daemon presents the same connect-token while one is already attached,
the **later attach is rejected** with a typed `computer_already_connected`; the
existing connection is left untouched. Rationale: silently replacing the live
connection would let a stale copy of the command (or a leaked one) kick the user's
working daemon offline — the default must **protect the incumbent**.

- **Reject on LIVE attachment, not DB `activated_at`.** The gate is "is there a
  live WS for this host right now?", checked against the live attachment registry
  — not the persistent `activated_at` flag (which only records that activation
  *ever* happened). An activated-but-currently-disconnected computer must accept a
  fresh connect.
- **The token is not a preemption lock.** A crashed/netsplit daemon must not
  wedge the computer forever. A stale attachment is released after the
  heartbeat/pong timeout, after which a new connect succeeds. Release is driven by
  liveness detection, not by the token.
- **Actionable, machine-named error.** The rejection must name **which machine
  currently holds the connection** (the attach-reported hostname — diagnostic
  only, never identity/dedupe) so the user knows what they are up against.
- **Explicit escape hatch — "default protect, explicit migrate."** The
  target-computer page offers first-class, explicit actions to move the computer
  to a new machine: **disconnect current / force takeover**, and **rotate** (which
  invalidates the old token → the old daemon drops → the new machine connects with
  the new command). Protection is the default; migration is always one explicit
  action away.

### 5.4 `kind` — decision: user-invite is `remote`, and eligibility is kind-independent

**Decision (was open; resolved with Cindy):** this version *activates remote
provisioning*, so a user-managed computer is `kind = 'remote'`, set by the create
path (§5.2) — a user daemon attaches over the **outbound WS** path, which is what
`remote` lineage means. `kind` is **not** inferred from any daemon-reported field
(the earlier "descriptor honestly says otherwise" line is removed — a reported
value must not decide DB semantics), and `kind` must **never** be repurposed to
mean "user-managed" (that is `provisioning_source`'s only job). `kind` is
effectively "attach mode" (embedded local socket vs. outbound WS); the
`local|remote` naming is legacy and a future rename candidate, out of scope here.

Because today's code gates several runtime paths on `kind = 'local'`, activating
remote provisioning **requires these changes, which are in scope for this work**
(this is what makes §4's "single, kind-independent eligibility predicate" true
rather than aspirational):

1. **Open the WS connect gate.** `host-ws-server.ts:802` currently rejects any
   `host.kind !== 'local'` with 403. It must accept an active, owned,
   user-managed `remote` host, authenticated by its `connect-token` (hashed,
   looked up in `host_credentials`, resolved to `host_id`/`user_id` server-side —
   §5.2/§5.3).
2. **Replace the placement/picker source query.** `listOwnedActiveLocalForUser`
   (`host-repo.ts:160`, `WHERE kind='local'`) must no longer be the picker /
   placement eligibility source. Introduce an eligibility query keyed on the §4
   predicate — `activated_at IS NOT NULL AND finalized_at IS NOT NULL AND
   revoked_at IS NULL` (owner-scoped), **kind-independent**. (The
   `local_host_ambiguous` resolver stays for the
   desktop-local disambiguation it was built for; it is just no longer the
   general placement gate.)
3. **Update the renderer picker filter.** The agent/workspace picker that filters
   `host.kind === 'local'` must switch to the same eligibility predicate, so an
   active user-managed computer is selectable.
4. **Add a user-managed connect-token rotation surface (P1, Cindy).** The doc
   makes rotate/regenerate a first-class capability (§5.3, §7), but today's
   `POST /api/hosts/:id/rotate-token` is the *old desktop-host* path and is wrong
   for this on three counts: it rejects `host.kind !== 'local'` with a 409
   `kind_not_supported` (routes/hosts.ts); in embedded mode it returns the cleartext
   only to Electron **main** (the old token-stripping IPC keeps it from the
   renderer); and its whole premise is "renderer never sees the long-lived token."
   User-managed rotation inverts all three: `kind='remote'`, and the fresh token
   **must** reach the renderer for the show-once card. The rotation surface (extend
   this route or add a sibling) must be **owner-scoped, remote-eligible, return
   cleartext exactly once to the renderer, and — as the leak-response primitive —
   invalidate the old token + force-drop the live WS immediately** (§5.3). It must
   **not** inherit the old desktop `main`-only token-stripping semantics.

The `system` placeholder row (`ensureStandaloneServer`, `kind='remote'`,
`user_id=NULL`, `activated_at` never set) stays non-eligible by construction: it
has `activated_at IS NULL` and no owner, so the predicate excludes it without any
`kind`- or source-based special case.

---

## 6. The daemon as an npm package

shiki's #2/#3: the daemon is a standalone npm package the user runs on the target
machine. The invocation is one **stable, literally-identical `connect` command** —
first connect and every subsequent reconnect are the *same string*, with no
host_id and no variant:

```
npx @silverhand-ai/daemon@latest connect --server-url <url> --connect-token <token>
```

### 6.1 One command, first == subsequent — how it holds

The unification is structural, not a trick: the `connect-token` is a standing
credential that authenticates **every** connect, and identity is resolved from it
server-side on each attach. There is no first-run/later-run branching in the
daemon and no local auth state to diverge.

1. **No internal id in the command** (shiki). The command carries no
   host_id/computer_id — exposing it would leak DB shape onto the product surface
   and make users think the id is theirs to manage. The server resolves
   `token → host_id` on every attach.
2. **Every run is the same attach.** The daemon opens the outbound WS to
   `GET /api/hosts/connect` with `Authorization: Bearer <connect-token>`. The
   server hashes the token, resolves `(host_id, user_id)`, verifies
   not-revoked/not-expired, and applies the concurrency gate (§5.3). First
   successful attach activates the computer; later attaches just reconnect. The
   daemon does the identical thing each time.
3. **No local credential to store or lose.** The target machine keeps **no
   durable auth state** — the token in the command *is* the credential. A wiped
   data-root, a fresh container, or a re-imaged machine changes nothing: re-run
   the same command and it reconnects. (This is the key simplification the
   connect-token model buys over a pairing+exchange flow — there is no
   "credential minted locally then lost" failure mode, so §6.2's old hard-fail
   recovery path is gone.)
4. **Multiple computers on one machine** disambiguate purely by **which token you
   pass** — each `connect --connect-token <A>` / `<B>` attaches a distinct
   computer, into a distinct data-root (§6.5), with no shared selector or id.

Running the command on a *different* machine is not "revival" — it is exactly the
migration path. If the incumbent is still live, the new machine is **rejected**
(`computer_already_connected`, §5.3); to actually move, the user disconnects the
incumbent or rotates the token from the app. A leaked command is bounded the same
way: single-computer scope + instant revoke/rotate with forced disconnect.

### 6.2 Revoke / rotate is the only way a command stops working

Because there is no local credential and no single-use semantics, a connect
command keeps working until the user **revokes or rotates** the token from the
app (§5.3/§7). That is the intended model: the standing credential is managed
server-side, its lifecycle is explicit and user-driven, and "make this command
stop working" is a first-class action, not a TTL side effect. A daemon presenting
a revoked/rotated-away token is rejected on its next attach and, if currently
live, force-dropped.

### 6.3 Flag & credential naming

- User-facing flag: **`--connect-token`** (team consensus — Cindy +1, Norman +1;
  **RATIFIED by shiki**). It names what the credential does on *every* run — authorize
  this connect — rather than binding a re-runnable command's name to a one-time
  action. Preferred over `--api-key` (implies a durable generic account key),
  `--bootstrap-token` / `--pairing-token` (both imply "first time only", which is
  wrong for a command that runs identically forever).
- **"Regenerate" = rotate.** One entry covers move-machine / re-pair after loss /
  leak-rotation: rotating issues a fresh connect-token (new command) and
  invalidates the old one. There is no separate "regenerate a single-use secret"
  concept anymore.
- **CLI vocabulary = the product word `computer`, not `host`** (Norman,
  ubiquitous language): the whole chain — rail, command, target page — says
  *computer*; `host` stays the DB/internal name. This is a deliberate, documented
  user-vs-internal split, **not** naming drift: `host_credentials` and `hosts.*`
  stay internal; only the user surface uses `computer` / `connect-token`. The DB
  credential-kind enum can keep whatever internal name fits (`long_lived` etc.) —
  CLI semantics ≠ DB enum.

### 6.4 `@latest` command + protocol-version gate

`@latest` keeps the copied command short-lived and self-updating while the daemon
package is iterating. The safety boundary is the handshake `protocol_version`
gate (already in `multi-daemon-registry.md` §3.1): on connect, version mismatch
→ fail-fast with an upgrade hint, never a silent partial-protocol attach.

### 6.5 Instance-scoped data root (no global singleton)

The single-daemon assumption (`~/.silverhand/run/daemon.sock`,
`~/.silverhand/run/daemon.pid`, one agent home, one log stream) breaks the moment
two daemons run on one device. Each daemon uses an **instance-scoped data root**,
e.g. `~/.silverhand/computers/<host_id>/{run,logs,agents}`, aligned with the
launcher-supplied `--daemon-home` in `multi-daemon-registry.md` §2.5.

Two things follow from the connect-token model:

- **The data-root holds only agent runtime working files** (run/pid/sock, logs,
  agent homes) — **not** the auth credential. There is no `daemon-config` with a
  stored long-lived token, and no paired-computer registry: the credential is the
  `--connect-token` passed on the command line each run, resolved server-side.
  Losing the data-root loses working state, never auth — re-running the same
  command rebuilds it.
- **No "re-home under host_id" step.** The server returns `host_id` in the connect
  handshake response, so the daemon creates its data-root under the right id on
  first write — no token-namespace-then-rehome dance.

### 6.6 Package boundary (bounded context)

The daemon package stays execution-plane only (`packages/host` today): it speaks
the protocol, reports identity/capabilities, supervises agent processes. It never
reads the backend DB, never authors its own `hosts.id`, never learns
`provisioning_source`. Everything DB-anchored is resolved server-side
(`multi-daemon-registry.md` §2.2). Publishing it as an npm artifact is a packaging
change, not a boundary change.

### 6.7 Reconnect, daemon mode & command persistence

Because the daemon keeps **no local credential** (§6.5), the connect command *is*
the durable credential, and its home is **the target machine, not the app**. This
is what makes reconnect work without the app ever re-showing the token:

- **Ordinary reconnect (daemon restart / network drop)** re-runs the same
  command with the same still-valid `connect-token` — no app involvement, no
  rotate. The token is unchanged; the daemon just re-attaches.
- **`connect` defaults to daemon mode.** A copied command must be safe to paste
  into a remote shell without keeping a terminal or `screen` session open:
  `silverhand-daemon connect ...` resolves its instance data-root, starts a
  detached foreground child, writes `<data-root>/silverhand-daemon.pid`, and
  exits after printing the exact stop command for that instance. `--foreground`
  / `--no-daemon` are explicit opt-outs for diagnostics.
- **Stop is instance-scoped.** The printed stop line must include the resolved
  absolute data-root, e.g. `npx @silverhand-ai/daemon@latest stop --data-root <actual-data-root>`,
  so copy-paste stops the daemon that was just started.
  Argless `stop` is only a convenience path: it auto-discovers a single live
  daemon under `~/.silverhand/computers/*/silverhand-daemon.pid`; if multiple
  live instances exist, it fails loudly and requires `--data-root`.
- **Persistence is a target-side responsibility**, and the daemon package should
  make it easy rather than leaving it to "remember to save the command": on first
  `connect`, daemon mode solves "close terminal and keep running"; a later
  launchd (macOS) / systemd service install can solve reboot auto-start by
  storing the same command (token included) as user-owned OS config. Then reboot
  → auto-reconnect, and the command is durably stored in the service unit — so
  the common case never depends on the user hand-saving it.
  **This is not credential-smuggling back into the app or into daemon-private
  state:** the service unit is *user-owned, user-visible OS config the user opted
  into* — exactly equivalent to the user pasting the command into their own
  script. At runtime the daemon still holds **no credential of its own**; it reads
  the token from its argv each launch (the service merely supplies that argv). No
  app persistence, no hidden daemon secret store — the "no local credential"
  invariant (§6.5) is intact. (This is the concrete mitigation of the "hash-only
  means I can't get the command back" worry: the command persists where it is
  *used*.)
- **Only a genuinely lost command** (never saved, machine wiped) needs the app,
  and the answer there is **Rotate → new command, old token dies** (§7.3) — cheap
  because a computer has at most one live daemon (reject-not-replace, §5.3).

Net: the token's persistence lands on the user's command / the target's service
unit — never in the app, never in hidden daemon-local state (which is exactly
shiki's "don't depend on local credential"). Hash-only costs one thing, and it is
standard secret hygiene: lose the command → rotate a new one, don't fetch the old.

---

### 6.8 Runtime detection — per-host catalog & resolver contract

**Problem (production):** users report "找不到 claude" even though it is installed.
Root cause is host-local PATH, not missing detection. A GUI-launched (Finder/Dock)
desktop app inherits launchd's minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`); the
daemon spawned by it inherits that same env (`packages/host/src/spawn.ts` — child
env is `{ ...process.env, ...launcher.env }`), and `detectRuntimes` resolves each
binary via `which`, which sees only that minimal PATH — so `/usr/local/bin/claude`,
`/opt/homebrew/bin`, npm-global, and version-manager shims are all invisible.

There is *already* a login-shell PATH patch
(`apps/desktop/src/main/index.ts` `patchPathFromLoginShell()`, `$SHELL -ilc`,
packaged-macOS only) that even explicitly appends `/usr/local/bin`. The reason the
failure survives it is the load-bearing bug: **its fallback directories live inside
the `try`, *after* a successful shell probe.** A slow rc, a non-standard shell, a
5s timeout, a marker-parse miss, or a non-packaged build takes the `catch` path and
leaves `process.env.PATH` untouched at launchd-minimal — with *zero* fallback dirs
added. The discovery has no floor.

**This is the concrete trigger for the "potential asymmetry" backlog item** (`/api/runtimes`
was app-local detection, never a per-computer capability). The fix is a host/daemon
**resolver contract**, owned here (daemon bounded context, §6.6); the create-dialog
is a *consumer* (owner @Norman, §7).

Invariants (violating any reintroduces the false-negative):

1. **One resolver serves both detection catalog and supervisor spawn — never a
   probe-only path.** This already holds (`supervisor` `defaultResolveBinary` wraps
   `runtimes.ts` `detectRuntimes`), so "detected ⟺ spawnable" is true *by
   construction*. Every change below goes into that one resolver; a second
   detection path would let probe and spawn drift (the parallel-copy anti-pattern).
2. **Unconditional candidates floor.** The resolver constructs its lookup set as:
   process PATH + macOS `path_helper` + `/usr/local/bin` + `/opt/homebrew/bin` +
   npm/pnpm/yarn global bins + nvm/fnm/asdf/mise version-root globs. **These are
   applied unconditionally — NOT gated behind the login-shell probe.** Login-shell
   PATH discovery (resolving the binary as the user's initialized interactive shell
   would, which is what catches version-manager runtime-hook installs) is an
   *enhancement layered on top*; its failure must never remove the floor. This is
   the correctness floor the current best-effort patch lacks.
3. **candidate-first preserved.** Platform-native candidates (e.g.
   `/Applications/Codex.app/.../codex`) resolve *before* PATH lookup — an existing
   cold-start optimization (`runtimes.ts` `PLATFORM_CANDIDATES`); do not regress it.
4. **Three-state result, not a boolean.** `--version` is health info, never the
   install gate (spawn uses the resolved path, not the version):
   - `present` — path resolved (+ version if `--version` answered).
   - `present_unverified` — path resolved, `--version` failed/timed out. **Not
     `absent`** — version behavior ≠ start behavior.
   - `absent` — resolver ran to completion and the binary is a deterministic
     ENOENT / non-executable. **Only this state may hard-block / disable.**
   - `unknown` — host online but the probe itself errored/timed out/unparseable.
     Warn + allow; never block (a probe hiccup must not lock an installed runtime).
   The catalog returns an **explicit state entry per probed runtime**; omission is
   never a state — "in the supported list but missing from the response" would
   collapse `absent` (disable) into `unknown` (warn) and break the consumer's
   disable-vs-warn gate. **The probed set is derived from the shared runtime
   catalog SoT** (`packages/shared/src/runtime-catalog.ts`, `RUNTIME_CATALOG`
   filtered on `selectable` — today **claude / codex / qoder**), NOT a hardcoded
   list. `selectable` is a curated product flag with the invariant
   `selectable ⇒ hasDriver`. **Non-selectable kinds are not listed in the picker at
   all** (shiki decision 2026-07-07: show only creatable runtimes; unsupported ones
   are simply absent from the UI — no "coming soon" / roadmap group). Consequently
   there is **no new `hostDetectable`-style flag**: the probe/list set *is*
   `selectable`. Minting a second flag would either duplicate `selectable` (naming
   drift) or leak `cursor` (`hasDriver:true`, `selectable:false`) back into the
   picker — and a `⇒ hasDriver` guard would not catch that leak. (Not offered today:
   `cursor` — has a driver, product not offered; `gemini` — no driver.)
5. **`absent` is trustworthy only once the floor (invariant 2) exists.** With no
   floor, the current failure mode emits a *false* `absent` (the lookup never
   reaches a state that can distinguish absent from unknown). Therefore the UI
   disable-on-`absent` gate depends specifically on the floor landing — until then
   `absent` must be treated as non-disabling. Ordering hazard, not a nicety.
6. **Hard-block consumes a *fresh* resolution, not the cache.** The gate that
   disables/blocks on `absent` must force-refresh at the moment it decides, so a
   stale cached `absent` never blocks a just-installed runtime before spawn's own
   refresh could recover it.
7. **One `force-refresh` primitive, three triggers.** Kill the per-boot negative
   cache (memoized `detectRuntimes` promise in `supervisor`): replace with TTL +
   a single forced-refresh path shared by (a) create-time pre-hard-block, (b) the
   UI manual "重新探测", (c) spawn-miss.
8. **Per-host via daemon command, two-transport symmetric.** Detection runs on the
   *target* machine's daemon (composite dispatch, routed by hostId — kind-agnostic),
   returning `RuntimeInfo[]`; embedded (app-managed) runs the same command locally.
   The current in-backend `detectRuntimes` import (`backend/src/routes.ts`) is
   app-local and must route through the host. user-managed daemons are
   terminal-launched (PATH already near the user's real shell) so the floor is
   mostly a no-op there; desktop app-managed is the primary risk surface — one
   resolver covers both with no per-shape branching.

Consumer mapping (owner @Norman, §7): the picker lists **only `selectable`
(creatable) runtimes** — today claude / codex / qoder; non-selectable kinds
(cursor, gemini) are not shown at all. Each listed runtime carries its three-state:
`absent` → disabled + "not installed"; `unknown` → enabled + "无法确认 / 连接后可探测";
`present_unverified` → enabled, subtle "已安装·版本未验证" (no warning color);
`present` → normal. Disabled items carry a "重新探测" action wired to the
force-refresh primitive. Target offline → the runtime section collapses into the
availability gate, no separate probe.

**First regression test:** with the login-shell probe forced to fail entirely, the
resolver still resolves `/usr/local/bin/claude` via the unconditional candidates
floor. (Tasks: #1375 resolver + catalog, #1376 create-dialog picker, #1377 this
contract. desktop `patchPathFromLoginShell` may remain as a coarse fallback for
non-runtime tooling or be removed once the resolver lands — but runtime-resolution
authority converges to the one resolver.)

---

## 7. Interaction design (owner: @Norman — connect-token spec, folded in)

The one user-perceivable complexity is the **connection-wait** of New computer.
Borrow the established device-pairing mental model (GitHub self-hosted runner /
Tailscale / VS Code tunnel) — but the credential is a *standing* one, so the UX
treats it as a password, not a disposable code. Norman's five acceptance points
(= his rescan criteria) are the spec:

1. **The command.** `npx @silverhand-ai/daemon@latest connect --server-url <url>
   --connect-token <token>` — **no host/computer id**; first connect and every
   reconnect are **literally identical**. The card offers one-click copy of the
   whole command.
2. **Token = a password, revealed once (hash-only; §5.3).** The full command
   (token included) is shown **only in the session that mints it** — the create
   flow or an explicit rotate — as a password field: masked by default,
   click-to-reveal, copy-whole-command, with a prominent **"copy now — this token
   will not be shown again."** The command card and target page state plainly:
   **"this command is the credential for connecting this computer — treat it like a
   password, do not share it."** No "short-lived / single-use" labeling (it is
   neither). This does **not** conflict with shiki's "same command every time": the
   command is for the *daemon* to re-run, and the *user* keeps it (shell history /
   script / launchd) — the app need not re-display it. **First connect happens
   while the setup surface is live** (the user runs the command on the target and
   the attach lands before they close it); closing before that connect *cancels and
   deletes the draft* (§5.2), so a lost/abandoned command pre-activation is simply
   re-created via **Add computer** again. Once the computer is *active*, the command
   persists on the target and lost-command recovery is **Generate new connection
   command** (rotate — post-activation only).
   At the reveal moment, the card actively nudges persistence: a prominent "copy &
   save this command" plus an optional **"set up auto-start (launchd/systemd)"**
   affordance (§6.7), so reconnect-after-reboot is automatic and the user does not
   later expect the app to hand the command back.
3. **Target computer page — show-once, then rotate/revoke are first-class.**
   After the minting session the page **never re-displays the token**: it shows a
   masked form (`connect --connect-token ••••`) plus two prominent one-click
   actions (**not** buried in an overflow menu):
   - **Generate new connection command** (the rotate action) — mints a fresh token,
     reveals the new command once, invalidates the old immediately. This one entry
     covers move-machine / re-issue / leak-rotation / **lost-command recovery**.
   - **Revoke computer** — kill the computer's credential.
4. **Concurrency rejection is legible and escapable.** When a second machine is
   rejected (`computer_already_connected`, §5.3), the message is **actionable and
   names the machine currently holding the connection** (attach-reported
   hostname). The target page provides an explicit escape — **Disconnect current
   connection** — which releases the current holder so another machine can re-run
   the (same, reusable) command; so "default protect" and "explicit migrate" are
   *both* present on the surface. (The product wording is "Disconnect current
   connection"; the jargon "force takeover" is not surfaced.)

   The three connection actions on the target page sit on **two orthogonal axes
   and must read as distinct in copy — conflating them is a safety bug**:
   - *Disconnect current connection* = **availability axis only**. Force-drops the
     live WS; the credential is untouched, so the *same* command reconnects.
     Reversible. *(Backend route `POST /:id/disconnect` landed in #1351 (in_review);
     Phase 2 shipped Generate + Revoke first, and rotate already covers the urgent
     kick-and-reconnect case at the cost of a new command. Renderer wires the button
     next, gated on online availability so it is never a dead click.)*
   - *Generate new connection command* (rotate) = **credential swap**. Revokes the
     old connect-token (the old command dies and its live WS is force-dropped) and
     issues a new one, revealed once. The card must state that generating a new
     command invalidates the previous one and drops any machine using it.
   - *Revoke computer* = **lifecycle terminal**. Sets `revoked_at`; the credential
     is dead and the computer leaves the rail — recreate to use again.

   "Disconnect" (reconnectable) and "Revoke" (irreversible) especially must not be
   worded as near-synonyms. Gating this whole block on user-managed computers is a
   **legitimate** `provisioning_source` use (connect-recovery flow + UI copy, §3.1
   red-line) — app-managed local hosts have no connect-command concept; this is
   not a capability fork.
5. **Invariants that must not regress:**
   - **The setup draft is ephemeral and modal-only — the rail shows only
     *finalized* computers** (decided by shiki, 2026-07-06; finalize-gated model
     ratified). *Both* draft states — `pending` (no attach yet) and `attached`
     (connected but not yet confirmed) — live **inside the active Add-computer
     surface only**, never as rail items. A computer becomes a rail item **only
     when the user confirms it** (names it / Done → `finalized_at` set, §4).
     Closing / cancelling the surface **before finalize deletes the draft**
     (`DELETE /api/hosts/{id}`, §5.2) — including an `attached` draft, whose live
     WS is force-dropped on delete. This is why placement never needs a "dimmed,
     not-selectable pending card": an unfinalized computer is simply *absent* from
     the rail and the picker by construction (list-exclusion predicate, §4). *(This
     supersedes both the earlier "pending card parked in the rail / background
     modal" invariant and the interim "pending draft dimmed-in-place" phrasing —
     background-persisted setup is a deferred explicit opt-in, not this cut.)*
   - **The flow is a single wait-then-name surface, driven by two facts.** The
     surface opens in `pending` (command shown, waiting), advances to `attached`
     on the first successful connect (`activated_at` set → hostname confirmation
     frame "Connected: `<hostname>`"), and only then reveals the **name input**;
     confirming it (`finalized_at` set) is what *creates the rail item*. The
     `pending` step shows **no name input**. The rail therefore never renders an
     unnamed ghost — a draft has no name field until `attached`, and no rail
     presence until `finalized`.
   - **Same card for app-managed and user-created** computers, differing only by
     an `app-managed` badge + non-removable attribute — no source-forked styling
     (the UI face of the §3.1 red-line).
   - On finalize → **target computer page** (host status / agents-on-host, reusing
     the existing status surface).

The hostname/OS shown on connect is **diagnostic display only** — the pairing
confirmation frame ("yes, that's the machine") — and never participates in
identity or dedupe (Cindy). Mockup (rail New entry → command card → pending wait →
hostname confirm → naming → target page) and the UI task land at the execution
stage; the interaction *decisions* above are settled.

### 7.1 Terminology — canonical product vocabulary (ubiquitous language)

shiki's **copy gate**: all user-facing terms use formal product language, not the
mockup's colloquial placeholders or internal jargon. This table is the single
source of truth; UI (Norman/#1348), user-facing DTO labels, and this doc stay on
one vocabulary. Internal concepts (`host`, `daemon`, `remote`, `connect-token`)
**never appear in user prose** — they exist only inside the literal command
string the user copies.

**The hard rule — two axes, never one word (Alice).** A computer's state is *two
orthogonal axes*; productized copy must keep them distinct or it loses a real
state (an **active-but-currently-offline** computer — fully set up, daemon just
not attached right now — which is semantically different from *pending / never
connected*).

| Axis | Source | Value | Product label |
|---|---|---|---|
| **Lifecycle** | `status` (= `activated_at`/`finalized_at`/`revoked_at`, §3.2/§4) | `pending` | **"Waiting for connection"** *(Add-computer surface only — never a rail card)* |
| | | `attached` | **"Connected: `<hostname>` — name this computer"** *(Add-computer surface only — the confirm step, never a rail card)* |
| | | `active` | *(no standalone lifecycle word — just a normal computer)* |
| | | `revoked` | **"Revoked"** |
| **Availability** | live attachment (`/status`) — a real-time dot **on active computers only** | `online` | **"Connected"** (enriched to **"Connected to `<hostname>`"** when a live hostname is shown) |
| | | `offline` | **"Offline"** |
| | | `unreachable` | **"Unreachable"** |

**"Connected" belongs to the availability axis only — never a lifecycle label.**
The two draft lifecycle states (`pending`, `attached`) exist **only inside the
Add-computer surface**; the rail buckets solely by the *finalized* states —
normal card (`active`) vs. revoked — and the real-time availability dot lives on
the normal card.

**The `connected_host_name` field — availability-axis diagnostic, one source
(Alice, ratified).** The machine name shown on the `attached` confirm step
("Connected: `<hostname>`") and in the concurrency-rejection message ("…currently
connected on `<hostname>`", §5.3) are the **same fact** — *who is live-attached
right now* — so they are **one nullable DTO field**, `connected_host_name`
(sourced from the live attachment / `ready` event, `null` when nothing is
attached), **not** two. It sits on the **availability axis** and is **orthogonal
to identity**: it is *never* written into `name` (the stable identifier) or
`display_label` (the user's chosen label) — a daemon-reported diagnostic must not
become a pseudo-source of identity. The renderer's display resolution is
`connected_host_name ?? display_label ?? name`: show the real machine name while
a daemon is live-attached, else fall back to the established v36 (#808) display
resolution (`display_label ?? name`). Adding `connected_host_name` does not
disturb that tail.

**Product vocabulary:**

| Concept / action | Product term | Avoid (jargon/colloquial) |
|---|---|---|
| The entity | **Computer** | host, remote, machine, "this computer" |
| Add one | **Add computer** (COMPUTERS header, `+` icon) | New computer (dashed row) |
| The command | **Connection command** | connect-token, daemon command, magic token |
| Re-issue the command | **Generate new connection command** | rotate, re-pair |
| Remove | **Revoke computer** | delete, kill |
| Concurrency escape | **Disconnect current connection** | force takeover |
| Reveal-once notice | **"This connection command is shown only once. Copy it now; it can't be retrieved later."** | short-lived / single-use / expires |

**Scope note (Norman, this cut):** per-host live-availability rendering for
**non-local** computers is deferred (avoid mounting N `/status` RPCs at list
mount); the existing local-host cheap signal is unchanged. Until it lands, a
user-managed *active* computer renders as a normal computer without a live dot —
this is a rendering-surface deferral, not a model change: the availability-axis
DTO/endpoint already exists, so the label mapping above is stable and forward-
compatible.

---

## 8. Coexistence, migration, and the terminal goal

### 8.1 Migration (additive, low-risk)

Existing rows are **not** all app-installed — `ensureStandaloneServer` creates a
`kind='remote'`, `user_id=NULL` control-plane placeholder. So the backfill is
conditional, not a blanket default:

- `ALTER TABLE hosts ADD COLUMN provisioning_source TEXT`, then in the same
  migration:
  - `= 'app_install'` where the row is **user-owned with an installation_id**
    (`user_id IS NOT NULL AND installation_id IS NOT NULL`) — the real desktop
    hosts;
  - `= 'system'` for everything else (the standalone-server placeholder and any
    unclaimed legacy local bootstrap row — `user_id IS NULL`). These are never
    user-managed, so an `app_install` badge / revoke copy would mislead.
  - After backfill, the column can be tightened to `NOT NULL`. New writes:
    `claim-or-create` → `app_install`, user-invite create → `user_invite`,
    `ensureStandaloneServer` → `system`.
- `ALTER TABLE hosts ADD COLUMN activated_at INTEGER` (nullable). Backfill
  **only user-owned non-revoked local hosts** → `activated_at =
  COALESCE(last_seen_at, created_at)`, so no live desktop host regresses to
  pending. Placeholder/system rows keep `activated_at NULL` (they were never
  user-placeable; the owner-scoped eligibility predicate excludes them anyway).
- No change to the partial unique index — it already exempts
  `installation_id IS NULL`, which is exactly what user-managed hosts carry.
- Migration runner per `architecture-principles.md` §5 (v-runner template,
  `foreign_key_check` before commit, sandbox dry-run first). Both are additive
  column adds; the backfill UPDATEs are bounded by the (small) host count.

### 8.2 Two create paths are a **staged path, not a permanent dual model**

The two create surfaces coexist, but the doc commits them as *stages*:

- **Now**: desktop `claim-or-create` fast path + user invite/connect path, both
  landing on the one `active` shape.
- **Terminal goal** (write it down so it does not fossilize as a permanent
  special case): the desktop's own computer becomes just an **auto-invite/attach**
  performed internally by Electron main — user-invisible — over the same
  protocol. At that point `installation_id` degrades to a desktop-local recovery
  key and, once the desktop persists its own `host_id`, may become vestigial.
  We do **not** force a single public endpoint in stage 1; but naming the
  terminal goal is what stops "app-managed" from silently becoming a second
  identity axis three years out.

### 8.3 What must NOT be fused

- Do not claim "one device → one computer." Same-device multiple computers is a
  first-class case (already schema-legal).
- Do not route user New-computer through `claim-or-create` /
  `(user_id, installation_id)`. Merging distinct daemons under one install key
  would mis-merge same-machine daemons, make revoke/rotate of one affect another,
  and collide data roots.
- Do not let `provisioning_source` or `kind` fork runtime behavior (§3.1, §5.4).

---

## 9. Acceptance / release blockers (@Mbappe — walked at verification stage)

Recorded from the thread consensus; @Mbappe formats/owns the final checklist at
the verification stage (not during design).

1. **Unfinalized computer never enters placement / host picker.** Enforced by the
   single readiness predicate (§4: `activated_at IS NOT NULL AND finalized_at IS
   NOT NULL AND revoked_at IS NULL`). Verify no picker/placement path bypasses it —
   *both* draft states are excluded: a computer whose `connect-token` was issued but
   never attached (`activated_at IS NULL`, `pending`) **and** one that has attached
   but not yet been confirmed by the user (`finalized_at IS NULL`, `attached`) must
   stay non-placeable.
2. **`connect-token` handled as a long-term credential (§5.3).** Verify:
   single-computer scope (a leaked token reaches exactly one host, never the
   account); immediate `revoke`/`rotate` that **force-drops the live WS** (does
   not wait for a heartbeat cycle); the token never lands in logs / system
   messages / conversation history / renderer query cache; the UI renders it as a
   password field (masked, click-to-reveal). **Hash-only / reveal-once (RATIFIED
   by shiki — §5.3):** the full command is shown only in the
   minting session; after rotate the old command is unrecoverable and the new one
   is shown only that once; after app restart the target page does not reveal the
   cleartext (masked form only, rotate to get a new one); **no API returns a
   stored cleartext token.** (If shiki instead mandates encrypted-at-rest cleartext
   for permanent re-display, these three checks are replaced by encrypted-storage /
   key-management / decryption-authority checks — Mbappe re-derives §9 then.)
3. **Same `connect-token`, concurrent connect → later rejected (§5.3).** Second
   attach gets typed `computer_already_connected`; decision is based on **live
   attachment**, not DB `activated_at`; a stale attachment is **not** released
   before the heartbeat/pong timeout. Verify three scenarios: (a) two live
   daemons → second rejected; (b) after a netsplit/crash, once the timeout
   elapses a fresh connect succeeds; (c) after an explicit disconnect, a fresh
   connect succeeds immediately.
4. **`connect-token` leak = computer takeover, bounded by instant response.**
   Verify that `revoke`/`rotate` **immediately disconnect an already-established
   WS** (not on the next heartbeat) — measure the latency from token invalidation
   to the offending connection being dropped; confirm the old token is rejected on
   any subsequent attach.
5. **Daemon connect reports protocol version / package version / data-root;
   device info (hostname/OS) is diagnostic display only, never identity/dedupe.**
6. **Revoke / rotate path completeness** — deleting a computer: connect-token
   revoked, daemon receives disconnect, in-flight agent sessions terminated. The
   **user-managed rotation surface** (§5.4.4) works on a `remote` host (not gated
   to `local`), returns cleartext **exactly once** to the renderer, and drops the
   old token + its live WS immediately.
7. **Daemon crash recovery** — after abnormal exit, how fast does the server-side
   host go `disconnected`? Heartbeat/pong timeout? UI reflects true connection
   state (and the token becomes reconnectable per §9.3b).
8. **Data-root isolation** — multiple daemon instances on one device share no
   socket/pid/log; `ls ~/.silverhand/computers/<host_id>/` shows clean per-instance
   isolation, and none of them stores the auth credential (§6.5).

---

## 10. Open questions / follow-ups

- **§3.2 `activated_at` — RESOLVED** (Cindy): explicit column; semantics =
  first successful authenticated connect, **not** token issuance.
- **Credential model — RESOLVED** (shiki): one reusable `connect-token`
  authenticates every connect; no `bootstrap → exchange` two-step, no daemon-local
  stored credential. Command is identical first and every reconnect, carries no
  host_id (`token → host_id` resolved server-side).
- **Concurrency — RESOLVED** (shiki): second concurrent connect is **rejected**
  (`computer_already_connected`), never silent-replace; gate is live attachment,
  released on heartbeat/pong timeout; explicit move/force-takeover + rotate as the
  migration escape. "Default protect, explicit migrate."
- **Flag name — `--connect-token` — RATIFIED by shiki** (team consensus).
- **Token display lifecycle — hash-only / reveal-once — RATIFIED by shiki** (P1,
  Cindy; team-aligned Norman+Mbappe). Server keeps only the hash; the full command
  is revealed once at mint (create/rotate), never re-displayable afterward; the
  target page shows a masked form + rotate-to-regenerate. Rejected alternative =
  encrypted-at-rest cleartext for permanent re-display (would need a rewritten
  threat model). Reconnect story (§6.7): reusable command persists target-side
  (user's command / launchd/systemd unit), lost-command recovery = rotate on the
  computer page. See §5.3 / §6.7 / §7.2-3 / §9.2.
- **Setup lifecycle — finalize-gated, `finalized_at` — RATIFIED by shiki**
  (2026-07-06, "选确认 finalize-gated"). A computer becomes a rail entity only
  when the user confirms the Add-computer flow. Two orthogonal facts, two
  timestamps: `activated_at` = the technical-connection fact (first authenticated
  daemon attach), `finalized_at` = the user-commitment fact (user confirmed /
  named). Four derived states `pending → attached → active → revoked` (§3.2/§4);
  readiness predicate gains `finalized_at IS NOT NULL`. Both draft states
  (`pending`, `attached`) are ephemeral and Add-computer-surface-only; closing
  before finalize hard-deletes the draft (force-dropping an `attached` draft's live
  WS). Rejected alternative = treating `display_label IS NULL` as the finalize
  signal (a display field driving a domain state — anti-pattern).
- **§5.4 `kind` + legacy-local gates — RESOLVED** (Cindy): user-invite = `remote`;
  eligibility is kind-independent; the **four** legacy `kind='local'` gates (WS
  connect, placement query, renderer picker, **and the token rotate/regenerate
  route — P1**) are in scope. Do not overload `kind`; do not infer it from a
  reported field.
- **Placement policy** for a (conv, agent) whose computer goes permanently dark —
  inherits `multi-daemon-registry.md` §7 OPEN (sticky + manual re-place is the
  lean).
- **Persistent daemon directory** for "show computers even when none connected" —
  `multi-daemon-registry.md` §10.
- **Terminal-goal migration** (desktop → auto-invite) — sequencing TBD; named
  here so it is not lost.
- **Proxy editing for user-managed computers** (dogfood #2a, 2026-07-06) — the
  target-page `ProxySection` gates edit on `isLocalSelf` (this desktop's own local
  host); a user-managed remote falls through to the copy "Open Silverhand on the
  physical machine that owns this host", which is **wrong** — a user-managed
  computer is a headless daemon with no desktop app. Two stages:
  - **Interim (ship now):** replace that copy with productized "this computer's
    proxy is managed on the computer itself; editing from here isn't supported
    yet" — never imply an app on the target.
  - **Target form:** proxy `get`/`set` becomes a **general host capability over
    the daemon WS** (`host_proxy_config_get` / `host_proxy_config_set`), dispatched
    through the same composite outbound adapter as `host_status` (`067019f`). The
    renderer calls an owner-scoped backend API; the backend **never stores proxy**,
    it only `sendCommand`s to the target daemon, which writes **its own** per-computer
    profile dir (`~/.silverhand/computers/<originHash>-<hostId>/proxy-config.json`).
    The command carries proxy **values, never a path** (daemon resolves its own
    dir — no path injection). Gating is **availability-based, not kind-based**:
    online → normal edit form (local & remote identical, `isLocalSelf` dropped);
    offline → `computer_offline` / "connect this computer to edit its proxy". Proxy
    config may carry credentials → redact-on-display + never into log / history /
    query-cache.
  - **Legacy migration (migrate-then-delete, `architecture-principles.md` §11).**
    app-managed proxy today lives at `~/.silverhand/daemon/proxy-config.json`
    (`apps/desktop/src/main/index.ts:510`), **not** the per-computer dir — so
    unifying = a one-shot migration: on startup, once the app-managed host_id is
    known, if legacy exists and the new per-computer `proxy-config.json` does not,
    move it in; if the new path exists, it wins (no overwrite); rename legacy to
    `.migrated`. Idempotent / crash-safe (re-run skips when new exists), **no
    dual-read** afterward (a fallback read = the shim that never dies; distinct
    from our *unbounded* forward-compat cases which stay). **Exit condition:** one
    release after the migration ships, delete the desktop-main `hostClient +
    localHostClaim` proxy IPC bypass + the legacy-path read. Tests: legacy-only →
    new created; both exist → new not overwritten; post-migration get/set never
    touches legacy.
  - **Open scope decision (pending shiki):** migrate *proxy only*, or converge the
    *whole* app-managed profile dir into `~/.silverhand/computers/<originHash>-<hostId>/`?
    Terminal (unified model) = the latter. Recommended: staged full convergence —
    each host-local truth (proxy first, then agent runtime / workspace registry)
    sinks to a daemon command + one-shot migration + legacy delete, all toward the
    one per-computer profile dir; don't stall in a half-converged state.

- **Local vs remote host status model reconciliation (§8.2 follow-up, not scheduled).**
  The local embedded host's status pill (`connection-state.ts`) maps a richer
  server enum (`local_host_status`: `unclaimed|claimed|revoked|error|failed` ×
  `attachedAt`) and so carries states the remote availability triad does not —
  `Connecting…` (claimed, not yet attached) and `Stopped` (supervisor hard-fail
  after the restart budget). The **shared** concepts are converged to the §7.1
  vocabulary (`Ready → Connected`, `Removed → Revoked`; app-managed must not
  source-fork per the Unified Computer model), but these extra supervisor states
  are a *different bounded context* and are intentionally **not** force-mapped onto
  the computer-availability model. Whether the two state models should ultimately
  present as one — collapsing/reconciling the local supervisor states with remote
  availability — belongs to the §8.2 terminal convergence, not a near-term cut.

---

## 11. Cross-references

- Credential lifecycle + the provisioning flow this activates:
  `docs/auth-and-host-model.md` §6.1 / §6.2, token table §335–337.
- Daemon identity, registry, placement key, capability gating:
  `docs/multi-daemon-registry.md`.
- Migration phases (Phase 3 desktop remote-connect, Phase 4 outbound daemon):
  `docs/remote-server-target-architecture.md`.
- Control plane vs execution plane; host as first-class runtime endpoint:
  `docs/architecture-principles.md` §9.
- Host DTO / status availability union / agents-on-host:
  `packages/shared/src/api/host.ts`.
- Current host repo (identity binding, placement resolver, partial unique index):
  `packages/backend/src/repos/host-repo.ts`, `packages/shared/src/db/baseline-schema.ts`.

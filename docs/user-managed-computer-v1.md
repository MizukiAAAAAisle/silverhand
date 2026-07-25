# User-managed Computer

> This doc owns the **Computer model**: how a user creates, names, attaches, and
> manages a computer the app did not install, and the single active runtime shape
> both provisioning paths converge on. Auth, placement, and the outbound wire are
> consumed from their owners, not restated here.
>
> Consumed contracts (not restated):
> - `auth-and-host-model.md` §6 — host identity (`hosts.id`), credential
>   lifecycle, connect-token, and rotation.
> - `orchestration-boundary-v1.md` §5 / §5.1 — control ⟂ execution plane and
>   host-local path authority (semantic ids in, paths resolved daemon-side).
> - `daemon-outbound-protocol.md` — outbound WS wire, the `/api/hosts/connect`
>   endpoint, and per-host routing.
> - `architecture-principles.md` §9 — control plane vs execution plane; host is
>   the security boundary.

---

## 1. Unified Computer model

Ubiquitous language: **computer** (UI) ≡ **host** (domain / DB) — one concept,
one name mapping; **daemon** = the replaceable process that attaches to a host.

There is exactly one kind of thing a user manages, places agents on, inspects,
and revokes. An **active computer** is, uniformly:

```
host_id + attached daemon instance + credentials + status + placement target
```

Everything downstream — agent/workspace placement, host status page, revoke,
rotate-token, agents-on-host list, event availability — reads this one shape and
**never branches on how the host was provisioned**. App-managed and user-managed
are two attach paths of *one* Computer model, not two runtime models — the
Computer-level instance of the Human/Agent isomorphism this codebase enforces.

### 1.1 The `provisioning_source` red-line (hard invariant)

`provisioning_source ∈ {app_install, user_invite, system}` is pure lifecycle /
origin metadata. **Runtime capability is answered only from `host_id` +
ownership (`user_id`) + lifecycle (`finalized` / `revoked`) + live attachment +
credential — never from `provisioning_source` or `kind`.**

- `provisioning_source` is allowed **only** in: rendered UI copy, connect/recovery
  flow selection, and revoke/rotate messaging. It is **forbidden** in placement,
  routing, ACL, capability, and any runtime-capability decision. Any
  `if (provisioning_source === …)` in that code is a model leak — the moment the
  source field gates a capability it has become a second identity axis, exactly
  the rot this model prevents.
- **One dispatch port.** Every command to a computer flows through the single
  composite `outboundFrameAdapter`, routed by host id (kind-agnostic). No
  desktop-main-local IPC bypass may be added.
- **Host-local truth lives on the target daemon**, in its own per-computer profile
  dir — proxy, agent runtime, workspace registry, etc. — never read/written by the
  app reaching a shared local file. Editing it is availability-gated (only while
  the computer is online).
- **UI corollary.** The rail renders app-managed and user-created computers with
  the *same card*, differing only by an `app-managed` badge and a non-removable
  attribute — no source-forked visual treatment. Legitimate provenance differences
  (app-managed is non-removable / auto-provisioned) stay attributes, never
  capability or styling forks.

---

## 2. Two provisioning paths, one terminal state

Two entry surfaces, one terminal `active` shape. The only thing that differs is
*how a host reaches `active`*.

- **Desktop fast path** — `claim-or-create`: trusted and co-located, so
  `pending → attached → active` collapses into one atomic step (the app has its own
  credentials, spawns its local daemon over the Unix socket, names it "This Mac").
  It keeps `installation_id` as its idempotency / recovery key — nullable, **not**
  device identity, and confined to this path.
- **User invite path** — the interactive walk through the *same* states: create a
  `pending` host, issue a `connect-token`, the user runs the daemon connect command
  on the target machine, the daemon attaches (→ `attached`), the user names/confirms
  it (→ `active`).

`claim-or-create` is a **specialization** of the general
create-pending → connect protocol (trusted + idempotent-by-`installation_id`), not
a parallel universe — which is what keeps app-managed special-case branches from
metastasizing.

**Anti-goals.**
- Do not route user New-computer through `claim-or-create` / `(user_id,
  installation_id)` — merging distinct daemons under one install key mis-merges
  same-machine daemons, cross-contaminates revoke/rotate, and collides data roots.
- Do not claim "one device → one computer." Same-device multiple computers is a
  first-class case (a user-created host carries `installation_id = NULL` and does
  not collide with the desktop's install-bound host, even on the same machine).
- Do not let `provisioning_source` or `kind` fork runtime behavior (§1.1).

**Terminal design intent.** The desktop's own computer converges to an internal,
user-invisible **auto-invite/attach** over the same protocol; at that point
`installation_id` degrades to a desktop-local recovery key and, once the desktop
persists its own `host_id`, may become vestigial. Naming this stops "app-managed"
from fossilizing as a permanent second identity axis.

---

## 3. Lifecycle — two orthogonal timestamps, four derived states

Following the codebase's `revoked_at` pattern (timestamp-as-state), the host
lifecycle is four-valued and derived from three authoritative timestamps:

```
revoked_at   != NULL                               → revoked
activated_at != NULL AND finalized_at != NULL       → active    (a real computer)
activated_at != NULL AND finalized_at == NULL       → attached  (daemon connected, not confirmed)
otherwise (activated_at == NULL)                    → pending   (created, never connected)
```

- `activated_at` = the **technical-connection** fact: first successful
  authenticated daemon attach (`GET /api/hosts/connect` with the connect-token).
  **Not** set at token-issuance time.
- `finalized_at` = the **user-commitment** fact: the user confirmed the Add
  computer flow (named it). These are two genuinely distinct facts (technical
  connect ⊥ user commitment) at different times; separating them lets an
  attached-but-unconfirmed machine stay a discardable draft.
- The `status` enum (`pending | attached | active | revoked`) is **derived** by one
  backend helper, never a stored second source that can drift. Using a display
  field (e.g. `display_label IS NULL`) to drive a domain state is the rejected
  anti-pattern.

**Drafts are ephemeral.** Both `pending` and `attached` are setup drafts, not
committed entities: they hold no placements and no history, and live only inside
the Add computer surface. The bulk host list hides unfinalized `user_invite` rows,
so a draft never appears in the rail / picker / placement. **Any close before
finalize hard-deletes the draft** — its connect-token cascade-drops and, for an
`attached` draft, its live WS is force-dropped. Cancel is a *delete*, distinct
from the soft `revoke` reserved for computers that had a real life.

**Readiness predicate** — applied after owner scope / ACL, and deliberately
`kind`-independent:

```
activated_at IS NOT NULL AND finalized_at IS NOT NULL AND revoked_at IS NULL
```

This is the single readiness gate; funnel every picker/placement read through it
(composed with owner scope), never through `kind`. Both draft states fail it by
construction (`pending` has `activated_at IS NULL`; `attached` has `finalized_at IS
NULL`), so "unfinalized draft must not enter placement" holds by construction. It
is the *readiness* dimension only — the full selection is owner-scoped + ready, and
runtime dispatch further requires credential/attachment/status.

**`kind`.** A user-managed computer is `kind = 'remote'`. `kind = local | remote`
is host-category / provisioning-acceptance metadata — **not** a wire mode. At the
auth and wire layers local and remote hosts are the same first-class entity, both
reached over one outbound connection per host; the embedded local-socket vs
outbound-WSS split is a deployment / transport-adapter concern, not a `HostKind`
(a standalone deployment's local host also attaches over the outbound WS — see
`auth-and-host-model.md` §1.1). `kind` must **never** be repurposed to mean
"user-managed" (that is `provisioning_source`'s only job) and must never be
inferred from a daemon-reported field. Runtime placement / dispatch route by
`host_id` and are **kind-agnostic** (`RuntimeHostPlacementResolver`), and
eligibility is `kind`-independent (§3 readiness predicate). The `system`
placeholder row (`kind='remote'`, `user_id=NULL`, `activated_at` never set) is
non-eligible by construction — no `kind`- or source-based special case needed.

### 3.1 Host-touching partition semantics

A user-managed computer makes Silverhand a distributed system: the backend owns
control-plane truth, the target computer owns host-local truth. Every operation
that touches host-local truth must declare what happens when that computer is
offline, unreachable, or transiently in setup. This declaration is a **backend /
shared-contract property**; the renderer consumes it and renders matching copy —
it must not re-derive partition behavior from `kind`, `provisioning_source`,
status-query freshness, cached rows, or endpoint knowledge.

Every host-touching operation fits one bucket:

| bucket | meaning | UI consequence |
|---|---|---|
| `offline-completable` | pure control-plane mutation; needs no live host-local state | allow while offline; do not disable on daemon liveness |
| `best-effort` | control-plane op completes even if host-local cleanup/notify fails | allow; surface only real control-plane failure; log host-local misses |
| `requires-connection` | correctness requires the target daemon to answer now | disable / fail with "connect the computer first" |
| `cascade-with-residue` | aggregate delete proceeds while host-local residue may remain | require explicit consequence confirmation; do not pretend host-local wipe happened |
| `retry-later` | a transient lifecycle state is in progress; neither success nor cascade is correct yet | show retry-later; do not collapse into a structural `has_dependents` flow |

Canonical examples: runtime-catalog detection and proxy editing are
`requires-connection` (the target computer is the source of truth); regular
workspace deletion is `offline-completable` + best-effort runtime cleanup (a
disconnected computer must not make a workspace undeletable); direct delete-agent
is `requires-connection` (fail-closed host-local purge protects files/secrets);
delete-computer is `cascade-with-residue` for its own agents and workspaces;
pending materialization is `retry-later`.

Review rule: when adding or changing any computer-touching operation, classify its
partition semantics first. If it cannot be classified, the model is incomplete —
stop before adding UI or fallback behavior.

---

## 4. The `connect-token` — a standing bearer credential

The connect-token is the whole auth story for user-managed computers.

- **What it is.** A long-lived, **single-computer-scoped** bearer credential. The
  server stores **only its hash**, bound to `(host_id, user_id)`; it resolves
  identity (`token → host_id`) and authorizes every `GET /api/hosts/connect`. The
  cleartext exists server-side only transiently at mint (issue or rotate) and is
  returned exactly once.
- **One command, first == every reconnect.** The stable contract is that a mint
  returns one command whose shape carries **no host_id** and that works for the
  first connect and every reconnect alike — the daemon npm spec itself is
  server-provided (`HostCreateResponse.daemon_npm_spec`, configurable via
  `SILVERHAND_DAEMON_NPM_SPEC`), not a fixed literal. The default form is:
  `npx @silverhand-ai/daemon@latest connect --server-url <url> --connect-token <token>`.
  The server resolves `token → host_id` on every attach, so the command needs no id
  and the target keeps no durable auth state — the token in argv *is* the
  credential. The handshake `protocol_version` gate fails fast on mismatch (never a
  silent partial attach).
- **Hash-only, reveal-once.** The full command (token included) is shown **only in
  the session that mints it** (create or rotate), as a password field (masked,
  click-to-reveal, copy-whole-command). No API returns a stored cleartext token;
  after the minting session the target page shows a masked form and the way to get
  a working command again is **rotate**. This is the standard API-key/PAT model
  (shown once, then rotate if lost). The rejected alternative — persist an
  encrypted-at-rest cleartext for permanent re-display — reintroduces a recoverable
  standing secret purely for display convenience and is not adopted.
- **Bounded blast radius.** A leaked token impersonates exactly **one computer**,
  never the account, and cannot enumerate or reach other hosts. Revoke/rotate takes
  effect immediately and **force-drops the live WS for that host** (it does not wait
  for a heartbeat cycle); rotate invalidates the old hash and issues a new one. The
  token must never land in logs, system messages, conversation history, or renderer
  query cache — it flows only mint → command card (masked) → user → target machine.
- **Concurrency: reject the later connect, never silent-replace.** If a second
  daemon presents the token while one is already attached, the **later attach is
  rejected** (`computer_already_connected`); the incumbent is left untouched. The
  gate is **live attachment**, not the DB `activated_at` flag, so an
  activated-but-currently-disconnected computer accepts a fresh connect; a stale
  attachment is released after the heartbeat/pong timeout. The rejection names the
  machine currently holding the connection (attach-reported hostname — diagnostic
  only, never identity/dedupe). Migration is always one explicit action away:
  disconnect the incumbent, or rotate (old daemon drops, new machine connects with
  the new command).
- **Instance-scoped data root.** Each daemon uses its own data root under
  `~/.silverhand/computers/` keyed by host id (`{run,logs,agents}`), resolved
  daemon-side (host-local path authority). It holds **only** agent runtime working
  files — **never** the auth credential. A wiped data-root, fresh container, or
  re-imaged machine changes nothing: re-run the same command and it reconnects.
- **Persistence is target-side.** `connect` defaults to daemon mode (detached
  child, instance pidfile, prints an instance-scoped stop command); reconnect after
  reboot is solved by the user storing the same command (launchd/systemd) as
  user-owned OS config, never by the app re-displaying the token or by a hidden
  daemon secret store. A genuinely lost command is recovered by **rotate**.

The daemon package stays execution-plane only: it speaks the protocol, reports
identity/capabilities, supervises agent processes; it never reads the backend DB,
authors its own `hosts.id`, or learns `provisioning_source`. Publishing it as an
npm artifact is a packaging change, not a boundary change.

---

## 5. Revoke ≠ Delete — two verbs, one danger surface per computer

A computer has exactly one danger surface, chosen by provisioning path (a
legitimate `provisioning_source` flow-selection use, not a capability fork):

- **Revoke** (app-managed) — soft-delete: one transaction sets `revoked_at`,
  sweeps credentials, and post-commit disconnects the WS; it does **not** cascade
  agents / workspaces / conversations. A user-managed host rejects revoke.
- **Delete** (user-managed) — hard-delete: it removes the computer together with
  everything rooted on it, its agents **and** its `regular` workspaces (channels,
  messages, memberships, attachments included).

**The delete flow is two steps, and the second one is atomic:**

1. `GET /api/hosts/:id/resources` — the ordinary Computer-domain query: which
   agents are placed on this computer and which `regular` workspaces keep their
   files there (each with the viewer's `viewer_role`). The dialog shows this as
   the impact. It is *not* a delete-impact read model: it carries no action
   fields and predicts nothing about whether the delete will succeed.
2. `DELETE /api/hosts/:id` with `{ cascade_dependents: true }` — ONE boolean.
   The server re-reads the current dependency set inside a single transaction,
   re-checks the per-workspace owner gate and pending materialization there,
   captures everything the post-commit teardown needs (runtime-stop pairs **and
   their routing**, purge targets, attachment storage refs), and deletes
   workspaces + agents + the computer atomically. Non-2xx means nothing
   happened — no row, no blob, no host-local purge.

Consent is an intent over the computer, not an id snapshot: a dependency that
appears between step 1 and step 2 is deleted too. Exact-id confirmation, set
equality and a `dependents_changed` re-confirmation were considered and
**rejected** — everything reachable is rooted on the computer the user just
condemned, so a snapshot could not protect a different CLASS of object, and it
bought a second consent model plus a UI branch for a near-impossible window.

**Refusals that remain, and why each is the only path to its state:**
- `409 has_dependents` (no flag, non-empty computer) — a guard for a caller that
  skipped step 1. The renderer never hits it; it is not a UI state.
- `409 has_pending_agents` — a materialization in flight cannot be torn down
  safely. Transient, so it answers "retry", and it must **never** collapse into
  `has_dependents` (that causes a confirm → 409 loop). It is also the only path
  to that state: `/resources` deliberately does not carry
  `materialization_status`, because a query lists the affected objects, it does
  not predict whether the command will succeed.
- `403 workspace_forbidden` — re-checked authoritatively at execution time.
  Step 1 already named the non-owned workspaces via `viewer_role`, so this can
  only mean ownership drifted.
- An FK violation from a reference this cascade does not model **fails loud**
  (500), instead of being dressed up as an actionable `has_dependents` with
  nothing named.

**Safety pivot: default-safe vs walled-dangerous.** Routine delete-agent is
fail-closed (host unreachable → 503, never silent residue); "leave host-local
residue" is welded **only** behind the explicit whole-computer delete. An agent,
its agent-home (DM workspace), and its DM-channel co-live; deletion is
one-directional (delete-agent cascades the home, never the reverse).

---

## 6. Interaction

The one user-perceivable complexity is the **connection-wait**. It borrows the
device-pairing mental model (GitHub self-hosted runner / Tailscale / VS Code
tunnel), but the credential is a *standing* one, so the UX treats it as a password,
not a disposable code.

- **Single wait-then-name surface.** It opens in `pending` (command shown,
  waiting), advances to `attached` on the first successful connect (a hostname
  confirmation frame, "Connected: `<hostname>`"), and only then reveals the **name
  input**; confirming the name is what creates the rail item. `pending` shows no
  name input, so the rail never renders an unnamed ghost, and a draft has no rail
  presence until finalized. Closing before finalize deletes the draft (force-drops
  an `attached` draft's live WS).
- **Token = a password, revealed once.** Masked by default, click-to-reveal,
  copy-whole-command, with a prominent "copy now — this command is shown only once."
  The card nudges persistence (copy & save, optional launchd/systemd auto-start).
- **Three connection actions on two orthogonal axes — must read as distinct in
  copy (conflating them is a safety bug):**
  - **Disconnect current connection** = *availability axis*. Force-drops the live
    WS; the credential is untouched, so the *same* command reconnects. Reversible.
  - **Generate new connection command** (rotate) = *credential swap*. Revokes the
    old token (old command dies, its live WS force-dropped) and issues a new one,
    revealed once. Covers move-machine / re-issue / leak-rotation / lost-command
    recovery.
  - **Revoke computer** (app-managed) = *lifecycle terminal*. Sets `revoked_at`;
    the credential dies and the computer leaves the rail — recreate to use again.
  - **Delete computer** (user-managed) = *terminal removal*. The dialog lists what
    lives on the computer (its agents and its `regular` workspaces), one
    confirmation deletes all of it atomically (§5); the credential dies and the
    computer leaves the rail.
  "Disconnect" (reconnectable) and the terminal removals ("Revoke" / "Delete",
  both irreversible) especially must not read as near-synonyms.
- **Concurrency rejection is legible and escapable** — it names the machine
  currently holding the connection and offers **Disconnect current connection** as
  the explicit release.
- **Same card** for app-managed and user-created, differing only by the
  `app-managed` badge + non-removable attribute.

The hostname/OS shown on connect is **diagnostic display only** (the pairing
confirmation frame) and never participates in identity or dedupe.

### 6.1 Terminology (ubiquitous language)

A computer's state is **two orthogonal axes**; product copy must keep them distinct
or it loses a real state (an *active-but-currently-offline* computer is
semantically different from *pending / never connected*). **"Connected" belongs to
the availability axis only — never a lifecycle label.**

| Axis | Value | Product label |
|---|---|---|
| **Lifecycle** (`activated_at`/`finalized_at`/`revoked_at`) | `pending` | "Waiting for connection" *(Add-computer surface only)* |
| | `attached` | "Connected: `<hostname>` — name this computer" *(Add-computer surface only)* |
| | `active` | *(no lifecycle word — a normal computer)* |
| | `revoked` | "Revoked" |
| **Availability** (live attachment, `active` computers only) | `online` | "Connected" / "Connected to `<hostname>`" |
| | `offline` | "Offline" |
| | `unreachable` | "Unreachable" |

`connected_host_name` is an **availability-axis diagnostic, one nullable DTO
field** (who is live-attached right now — the `attached` confirm frame and the
concurrency-rejection message are the *same* fact). It is orthogonal to identity:
never written into `name` (stable identifier) or `display_label` (user's label).
Display resolution is `connected_host_name ?? display_label ?? name`.

Product vocabulary (internal names — `host`, `daemon`, `remote`, `connect-token` —
never appear in user prose; they exist only inside the literal command string):

| Concept / action | Product term |
|---|---|
| The entity | **Computer** |
| Add one | **Add computer** |
| The command | **Connection command** |
| Re-issue the command | **Generate new connection command** |
| Remove | **Revoke computer** (app-managed) / **Delete computer** (user-managed — one confirmation cascades its agents + `regular` workspaces) |
| Concurrency escape | **Disconnect current connection** |
| Reveal-once notice | "This connection command is shown only once. Copy it now; it can't be retrieved later." |

---

## 7. Per-host runtime detection (hard invariant)

Runtime detection runs on the *target* computer's daemon (composite dispatch,
routed by host id — kind-agnostic); embedded (app-managed) runs the same command
locally. The contract that keeps it correct:

- **One resolver serves both the detection catalog and supervisor spawn** — so
  "detected ⟺ spawnable" holds by construction. A second detection path would let
  probe and spawn drift.
- **Unconditional candidate floor.** The lookup set (process PATH + macOS
  `path_helper` + `/usr/local/bin` + `/opt/homebrew/bin` + npm/pnpm/yarn global
  bins + nvm/fnm/asdf/mise version-root globs) is applied **unconditionally**, not
  gated behind the login-shell probe. Login-shell PATH discovery is an enhancement
  layered on top; its failure must never remove the floor. (This floor is what a
  GUI-launched app — inheriting launchd's minimal PATH — otherwise lacks, the root
  cause of false "runtime not found".)
- **Candidate-first**: platform-native candidates resolve before PATH lookup.
- **Four-state result, not a boolean.** `present` / `present_unverified` (path
  resolved, `--version` failed — *not* `absent`) / `absent` (deterministic ENOENT —
  the **only** state that may hard-block) / `unknown` (probe errored/timed out —
  warn + allow). `--version` is health info, never the install gate. Omission is
  never a state — the catalog returns an explicit entry per probed runtime.
- **The probed set is the `selectable` runtime catalog** (`runtime-catalog.ts`),
  not a hardcoded list. Non-selectable kinds are absent from the picker entirely (no
  "coming soon" group), so there is no second `hostDetectable`-style flag to drift.
- **Hard-block consumes a fresh resolution, not the cache**; one `force-refresh`
  primitive backs create-time pre-block, the manual "重新探测", and spawn-miss.

---

## 8. Open questions (contract-changing, undecided)

- **Host-local-truth convergence scope.** Migrate proxy config only, or converge
  the *whole* app-managed profile dir into the per-computer profile dir? The
  unified model's terminal form is full convergence (each host-local truth — proxy,
  then agent runtime, workspace registry — sinks to a daemon command behind the
  availability gate); the staging is a pending product decision.
- **Placement policy for a permanently-dark computer.** The lean is sticky
  placement + manual re-place (`RuntimeHostPlacementResolver` resolves the host from
  `agents.host_id`); the exact policy is undecided.

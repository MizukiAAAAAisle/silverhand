# Workspace layout relocation v1

Status: proposed design for #task:1801. Revised after review rounds 1–2
(@Cindy BLOCKER 1–4 / MEDIUM 1–2 of both rounds adopted; @shiki ruled §3.5).

This document decouples a **workspace** from any agent working directory, moves
the per-workspace agent L2 memory into the agent-centric home tree, and retires
the workspace→filesystem binding (`workspace_path`, `workspace_host_id`, and the
daemon workspace-registry as a *runtime* path authority). It also specifies the
one-time, **same-computer, in-place** migration that carries existing users onto
the new layout without losing their memory or their live CLI sessions.

> Consumed contracts (not restated):
> - `app-data-layout-v2.md` — the app-root, the single path-resolution boundary,
>   the target `computers/<computer_id>/agents/<agent_id>` agent home (§6.2), the
>   shared session-migration unit (§5.2/§6.2), and invariants #8 (external
>   workspace paths are never relocated) and #10 (`cli_session_id` is the resume
>   authority; clearing it is not a migration strategy).
> - `desktop-server-api-epoch.md` — the `DESKTOP_SERVER_API_EPOCH` axis, its
>   **plan-A atomic triple bump** for breaking DTO changes, and the lockstep test
>   that forbids a non-atomic minimum/current divergence. The removal in §6 is a
>   plan-A release, not a client-first bridge.
> - `orchestration-boundary-v1.md` §5 / `architecture-principles.md` §9 — control
>   ⟂ execution plane; semantic ids cross the wire, paths resolve daemon-side.
> - `user-managed-computer-v1.md` — the Computer (`hosts.id`) model.
> - `legacy-workspace-registry-recovery.md` — the daemon workspace-registry this
>   design demotes to a migration-only reader.

---

## 1. Scope and invariants

**In scope (this task):**

1. **Design** — stop treating a workspace as the owner of a filesystem working
   directory; relocate per-workspace agent L2 into the agent home; delete the
   dead workspace→filesystem binding.
2. **Migration** — a one-time, same-computer, in-place upgrade that transposes
   existing on-disk L2 into the new coordinate and keeps existing Claude/Qoder
   CLI sessions resumable after the cwd cutover.

**Explicitly out of scope — must not leak back as a *permanent* compatibility
shim:**

- Embedded desktop (the author's own single install; all product users are
  remote-server).
- Any *cross-computer* migration verb or flow. The new layout merely makes a
  future manual data move *possible*; whether that future task clears or imports
  sessions is decided there, not here.
- Old-machine online / split-brain / two-daemon reconciliation. This migration
  assumes the old daemon and runtimes on the same computer are already stopped.
- Silverhand owning, recording, or persisting the agent's *project* working
  directory. After this task the working checkout is conversationally directed
  and is not Silverhand's truth.
- Generalizing a normal `session_not_found` into auto-clear (that would break
  the existing recovery contract).
- **Automatic removal of the migrated-from source directory.** The source is
  preserved verbatim and is terminally inert (§5). Reclaiming it would reopen
  @shiki's locked ruling "we do not delete the user's existing content" and
  therefore needs its own explicit product decision and coverage evidence — it
  is NOT pre-baked here as a natural follow-up (MEDIUM 2, round 2).
- **Reproducing the old *working* directory at the new cwd.** When a managed
  shared cwd held a project checkout (repo, `.git`, build output), that payload
  is retained in place (§5) but is **not** copied into the new per-agent bundle
  and the new initial cwd does **not** reconstruct it. The working location was
  never Silverhand's persistent truth (§3.1); a resumed agent recovers it from
  its migrated session/memory and `cd`s there. v1 does not reproduce the legacy
  initial cwd; the project location is conversation/session state, which
  Silverhand does not model as a persistent truth (§3.1; @shiki, locked).

**Invariants the design and migration must preserve:**

1. **DB is the live-identity authority; bytes stay in the directory; the target
   coordinate is pure ids.** The database is the sole authority for *which*
   workspaces/agents are live in the terminal state. The byte-truth of any L2
   file remains the directory itself. The DB never decides *which content is
   worth keeping* and — crucially — is **not consulted to compute a migration
   target**: a bundle path is `(local computer_id, registry workspace_id, old
   on-disk child agent_id)`, all available without the DB. A retained directory
   that has no live DB row must still have a reachable migration path.
2. **One runtime resolver, deterministic.** A bundle path is a pure function of
   `(computer_id, agent_id, workspace_id)`. The runtime registers *only* this
   resolver; there is no second, legacy runtime resolution path. The legacy
   registry is read *exclusively inside the migration preflight* as inventory
   (MEDIUM 1, round 2).
3. **One migration owner for this facet.** Host/daemon code owns this facet's
   migration and completion marker (§5) in both launch forms. Standalone
   `connect` invokes the ordered preflight directly; Electron launches the same
   daemon binary in a one-shot `preflight` mode and waits for it to exit before
   spawning the supervised daemon. Desktop main only passes the existing
   computer binding and never moves bytes or writes the marker. Data-sized work
   therefore sits outside the supervised daemon's ready-handshake deadline.
4. **A single completion marker gates startup admission.** The migration runs as
   a daemon **startup preflight**, before any registry or data-plane surface
   exists (as the existing convergence pass already does, fail-closed). The
   marker (§5) is written only after *both* the L2 relocation *and* the session
   fan-out verify. Marker absent/corrupt → the preflight runs the migration;
   if it cannot complete and verify, **the daemon aborts startup** — it never
   comes up serving a half-migrated state or a legacy resolver. Marker present →
   the data plane comes up and the deterministic resolver is authoritative.
5. **Transpose, never curate; migrate opaquely — but only within the migration
   truth set.** The migration truth is exactly two things: each agent's own
   `.silverhand/agents/<agent_id>/` L2 subtree, and the Claude/Qoder cwd-scoped
   session namespace. Within that set the move is verbatim and opaque — no
   membership filter, no `MEMORY.md`/`notes` shape filter, no GC, and **no parsing
   of any vendor-private session-store internals**; every byte *of those two
   things* is preserved, and departed-member and dormant-agent L2 move too.
   Everything else that happens to sit under a *managed* shared cwd — a project
   checkout, `.git`, `node_modules`, sibling `.silverhand` content outside
   `agents/<agent_id>/` — is **not migration truth**: it is left in place,
   untouched, never deleted and never copied into the new bundle. The initial cwd
   changing is the new model's expected behavior, not a broken environment: the
   real working location was never Silverhand's persistent truth (§3.1); it is
   carried by conversation and the agent's own resumed session, so a resumed agent
   knows where its repo is and `cd`s there when it needs it.
6. **Fail closed, retry idempotently.** Any unverifiable or conflicting state
   leaves the original bytes untouched, does not enter a partial new layout,
   does not clear `cli_session_id`, does not write the marker, and re-runs
   cleanly on the next startup.

---

## 2. The problem today

For a regular (non-`agent_home`) workspace, the agent's durable L2 lives *inside
the workspace's shared working directory* — whichever of two path regimes
provisioned it:

- The agent process cwd is the registry-resolved `workspace.path`, resolved by
  **`workspace_id`, not `agent_id`** (`packages/host/src/daemon/supervisor/
  index.ts:2126` ← `runtime-start-resolve.ts:174` ← `run.ts:801`
  `workspaceRegistry.resolve(workspaceId)`). **Every agent of a workspace
  therefore shares one cwd** — and thus one Claude/Qoder cwd-scoped session
  namespace directory.
- L2 memory is `<workspace.path>/.silverhand/agents/<agentId>/`
  (`packages/host/src/daemon/prompt-context.ts:116-121`), plus the same root in
  the L2 seed / index / files-purge / agent-workspace-fs handlers.

That `workspace.path` is one of two things, and the migration must treat both as
a shared cwd carrying `.silverhand/agents/*`:

- a **user-proposed checkout** (`requested_path`) — the user's own external
  project directory, typically a real Git repo per `app-data-layout-v2.md`
  invariant #8, possibly on a different filesystem than `~/.silverhand`; or
- a **daemon-managed root** (no `requested_path`) —
  `<workspaceDataRoot>/workspaces/<workspace_id>`, a Silverhand-managed directory
  the user never chose. It is *still a shared cwd*: an agent may have written a
  repo or arbitrary payload directly into it just the same, so B1's
  "retain-in-place, do not copy" (§1, §5) applies to a managed root exactly as it
  does to a user checkout — this is not only about external checkouts.

Consequences:

- Silverhand's durable memory is entangled with a directory it must never
  relocate or own.
- "A workspace has a local path" leaks to public DTOs (`workspace_path` on
  `WorkspaceDto`, `ConversationDto`), a `/api/workspaces/local-paths` endpoint,
  and a full renderer surface.
- The DB column `workspaces.workspace_path` (+ denormalized
  `conversations.workspace_path`) is **never read to build a real path** — every
  real path resolves daemon-side from the registry keyed on `workspace_id`. The
  column is pure legacy passthrough.
- `workspaces.workspace_host_id` exists only to route to the workspace's home
  computer for that same filesystem resolution; it carries no independent
  domain value.

---

## 3. Terminal design

### 3.1 A workspace no longer owns a working directory

A workspace becomes a purely logical/IM entity. Silverhand provides exactly one
thing here: a single initial cwd for the agent, which **is** the agent's L2
bundle root (§3.2). It does **not** provide, record, or persist any "project
working directory" — there is no "default vs. custom working directory" model
and no second persistent regime to fork on. Where the agent works after that —
staying in the bundle root, or `cd`ing into a checkout the user directs — is
entirely up to the user and the agent and produces **no state in Silverhand**.

The migration therefore moves the one thing Silverhand owns — the L2 bundle. Any
other payload an agent happened to write under an old shared cwd is simply
outside this model: it is not a working directory Silverhand tracks, so it is
left in place (§1, §5), not reproduced at the new cwd.

### 3.2 Agent-centric L2 bundle

Each `(agent, workspace)` pair gets a bundle that extends the already-shipped
agent home (`computers/<computer_id>/agents/<agent_id>/`, `app-data-layout-v2.md`
§6.2) with a per-workspace sublevel:

```text
<app-root>/computers/<computer_id>/agents/<agent_id>/
├── system_prompt.md              # L1 identity (unchanged, already here)
└── workspaces/<workspace_id>/    # ← L2 bundle (new)
    ├── MEMORY.md
    ├── notes/
    └── <anything the agent writes>   # all opaque durable data
```

- The bundle root **is** the agent process's initial cwd for that workspace — a
  durable home base, not a "project directory."
- The prompt-facing L2 path becomes `.` (the cwd is the L2 root).
- `MEMORY.md`, `notes/`, and any file the agent creates coexist and are owned/
  migrated as one opaque subtree.

In remote mode each agent's bundle lives on that agent's own computer. A
workspace therefore no longer has a single home computer; its L2 is distributed
across each member agent's own computer — exactly the control⟂execution
separation of `architecture-principles.md` §9.

### 3.3 The deterministic resolver is the only runtime resolver

`memoryDirFor` and the cwd resolver stop calling `registry.resolve(workspaceId)`
and instead compute `join(agentHomeRoot(computer_id, agent_id), 'workspaces',
workspace_id)` purely from ids. This is the **sole** runtime resolver — there is
no legacy fallback path in the running daemon. The daemon reaches this state only
after the startup preflight (§5) has completed the migration and written the
marker; a daemon that cannot complete migration does not serve at all (invariant
#4). The workspace-registry survives only as the preflight's inventory reader and
is then removed as a runtime authority. `agent_home` (DM) workspaces are
unchanged.

### 3.4 Retirements (what stops existing)

- **`workspace_path`** — delete the `workspaces.workspace_path` and denormalized
  `conversations.workspace_path` columns (append-only migration), the
  `WorkspaceDto`/`CreateWorkspaceInput`/`ConversationDto`/host-resources DTO
  fields, the `/api/workspaces/local-paths` endpoint, and the create-form input.
  Because the column is never read to build a path, this is a contract/DTO
  cleanup, not a path-resolution change. The client/server release sequencing is
  §6.
- **`workspace_host_id`** — retire together with the binding. Every consumer is
  workspace→home-computer routing (provision, reconcile, delete, `/local-paths`
  dispatch, guest-vs-home realization). None carries independent domain value.
  *Implementation must re-confirm this per consumer before deletion* (evidence
  gate); the guest-vs-home realization path in particular must be re-derived
  from the agent-centric model rather than silently dropped.
- **`create-workspace` collapses to name + membership.** With no workspace path
  and no home computer, workspace creation stops taking `requested_path` /
  `workspace_host_id`, stops forwarding a `requested_path` to a daemon, and stops
  doing provision-at-create. There is no workspace directory to provision — each
  agent materializes its own bundle lazily at spawn/materialize time (the
  existing agent-materialize path). The create form becomes a pure name (+
  member) form (confirmed with @Norman on the UI side).
- **daemon workspace-registry** — survives only as the migration inventory
  reader; not a runtime path authority in the terminal state.

### 3.5 Product surface: delete and keep invisible (ruled by @shiki)

**@shiki's IA ruling: delete all workspace-local-path surfaces and keep them
invisible to the user — no replacement entry point.** Rationale (with @Norman):
these surfaces expose a *derived coordinate*, not a user decision — a managed
workspace's directory is computed deterministically from ids, and the user never
had a real "pick a path" task. Deleting them removes a field that should never
have been there; it is not removing a capability. On a future new computer the
DB-backed workspace/channel/message content is programmatically restorable by id
(precisely because it is computed, there is nothing to restore); only agent L2
(not in the DB) would be lost, which is bounded and acceptable, and is the
*future cross-computer task's* contract, not this one. Concretely:

- **create-workspace form** → name + members only; the path input is removed
  entirely (@Norman re-balances the slimmed dialog's layout/copy in the same
  cut).
- **path display** → removed from Titlebar / WorkspaceSettingsDialog / lists.
- **local-paths picker + endpoint, Copy path, Reveal-in-Finder** → removed with
  the binding.

The success path has no UI. The only user-visible surface is an
action-oriented diagnostic on **in-place upgrade startup failure** (§5) — it
uses in-place-upgrade vocabulary (never "switch machine") and never falls back to
letting the user hand-pick a path to repair system state. That diagnostic is
@Norman's lane.

---

## 4. Reuse map (extend the shipped machinery — and where it does NOT apply)

The relocation runs as a **new facet on the daemon's existing one-time startup
migration**, driven by the shared `runWorkspaceStartupPreflight`
(`packages/host/src/daemon/workspace-registry/convergence-pass.ts`). Standalone
`connect` invokes it after resolving the binding; Electron passes its existing
binding to a one-shot daemon-binary child, which invokes the same unit and exits
before the supervised daemon is spawned. Both happen BEFORE any registry or
data-plane surface exists (fail-closed: the daemon does not start on a migration
error). Reuse the composition-entry shape, the runtime inventory
(`CWD_SCOPED_SESSION_RUNTIMES = ['claude','qoder']`, Codex/opencode/cursor/gemini
no-op, exhaustive `RuntimeKind` switch), the slug computation
(`cwdSessionSlug`, computed only from exact known cwds, never parsed back), the
`isSlugVerifiableCwd` charset gate, the config-dir override normalization, and
the fail-closed taxonomy. Two mechanics are genuinely new, and rounds 1–2
corrected three false reuse claims:

- **Session migration is whole-namespace opaque fan-out (1→N copy), NOT a
  rename, NOT a selective per-session split** (BLOCKER 1, rounds 1+2). The
  cwd-scoped store is a whole bucket per cwd (`~/.claude/projects/<cwd-slug>`,
  `~/.qoder/projects/<cwd-slug>`) whose *internal* shape is vendor-private
  (`<sessionId>.jsonl`, `<sessionId>/subagents|tool-results`, project-level
  `sessions-index.json`, `memory/`, …). The existing pass deliberately moves the
  **whole directory** and never parses those internals; a `cli_session_id`-keyed
  split cannot prove session closure without reverse-engineering that private
  format. The old bucket was keyed by the *shared* old cwd (all agents of a
  workspace shared one bucket); the terminal gives each `(agent, workspace)` a
  **distinct** new cwd. So the facet **copies the entire old bucket verbatim,
  opaquely, into each new agent-workspace cwd namespace** that needs continuity
  (1→N). Each agent resumes its own `cli_session_id` from its own copy; the other
  sessions carried along are inert. Regular files request filesystem
  copy-on-write clones first (macOS: `/bin/cp -c`, backed by APFS
  `clonefile(2)`; other platforms: Node's `COPYFILE_FICLONE` hint), so
  same-volume copies initially share physical blocks and diverge only when
  written. Both mechanisms transparently fall back to an ordinary copy when
  cloning is unsupported or the copy crosses filesystems. This preserves
  independent real destination trees without eager N× physical-byte
  amplification for the primary macOS user base. The fan-out uses the
  **same staging + stable-snapshot manifest + publish classifier** as the L2 copy
  (§5), and its destination census is the same filesystem `.silverhand/agents/*`
  child set the L2 inventory enumerates — never a DB `cli_session_id` query.
  `runSessionRenamePass` (1→1 whole-dir rename) is therefore NOT reused as-is; its
  opaque whole-bucket discipline is.
- **The physical move is a cross-filesystem copy, NOT a same-fs rename**
  (BLOCKER 2, round 1). The L2 source is inside an arbitrary user checkout that
  may sit on a different filesystem than the app root, so `renameSync` can raise
  `EXDEV`; fail-closing on `EXDEV` would permanently block legitimate users. Reuse
  the classify-once discipline and fail-closed taxonomy; do NOT reuse the
  "physical move == rename" assumption — this facet copies (§5).
- **Reuse as-is:** the plan→(session)→execute ordering, idempotent re-run, and
  the fail-closed typed errors (`FlattenLayoutError` / `SessionMigrationError`).

---

## 5. Migration: same-computer, in-place upgrade

**Owner & trigger.** Host/daemon code owns this facet. It runs the shared daemon
**startup preflight** on the *original* computer after the computer binding is
resolved and BEFORE any registry/data-plane surface exists, with the old
daemon/runtimes already stopped. Standalone `connect` invokes it directly;
Electron runs a one-shot daemon-binary preflight child, awaits successful exit,
then starts the supervised daemon under its ordinary 30-second ready deadline.
The migration child itself has no fixed duration timeout because work scales
with retained bytes. Preflight failure aborts daemon startup (invariant #4).

**Completion marker — the SSOT (BLOCKER 3, rounds 1+2).** The daemon convergence
pass has no completion marker today; it uses the flat registry as its resume
authority, and this design retires that registry. This facet introduces a
concrete, computer-local marker:

- **Path** — computer-local, under this computer's daemon workspace-data root:
  `<workspaceDataRootDir>/relocation-v1.marker.json`
  (`workspaceDataRootDir` is the per-computer `paths.workspaceDataRootDir` the
  connect daemon already derives; the marker sits beside the data it attests to).
  Never `~/.silverhand` global, never the DB.
- **Schema** — `{ schema_version: 1, facet: "workspace-layout-relocation-v1",
  completed_at, migrated: { workspaces: <n>, agents: <n> } }`. `schema_version`
  routing is NOT "any unknown ⇒ re-run" (MEDIUM 1, round 3): a **missing file** or
  a file that is the **current version but unparseable/corrupt** is treated as
  *not done* and re-run (the equivalence classifier below makes an
  already-published destination a safe no-op); a **strictly higher** version is a
  future/downgrade artifact this old binary has no right to interpret →
  **startup fail-closed**, never reinterpreted as v1; a **lower known** version
  routes to its explicit upgrade arm (v1 is the first, so none exists below it
  yet — but the arm is named, not lumped into "unknown").
- **Writer** — written by the shared daemon startup preflight **only**, **last**, after
  both L2 relocation and session fan-out verify. Single writer; atomic
  temp-file-plus-`rename` within the same directory (never a partial in-place
  write). No other process writes it; desktop main may pass a binding to its
  child but must not write this marker.
- **Semantics** — marker present ⇒ deterministic resolver authoritative,
  registry never consulted at runtime; marker absent/corrupt ⇒ preflight
  (re-)runs and, if it cannot verify, startup aborts.
- *Falsifier:* L2 already published but session fan-out fails → the marker is not
  written, the daemon does NOT start on the new resolver, and a restart converges
  from that exact physical state.

**Inventory — the registry, never DB membership.** The old daemon-local
`workspace-registry.json` supplies the authoritative `workspace_id → old root`.
DB membership must **not** be the census: the contract keeps a member's L2 after
they leave, the old directory has no sentinel, and filtering by current
membership would silently drop retained L2. For each registry root, enumerate
`.silverhand/agents/*` and migrate every child agent subtree found. Anything else
under that root (a managed shared-cwd project checkout, `.git`, build artifacts,
`.silverhand` siblings outside `agents/`) is **not enumerated and not migrated** —
it stays in place per invariant 5. The
**destination coordinate is computed without the DB** (MEDIUM 1, round 1):
`computers/<this computer_id>/agents/<child agent_id>/workspaces/<registry
workspace_id>/`. The DB decides only terminal live identity, never migration
routing — so a retained directory with no live DB row still migrates.

**One publish classifier for every copied destination (BLOCKER 1, round 3).**
Because the source is retained forever and both L2 subtrees and session buckets
publish **per destination**, a crash leaves `source + some-published-destinations`
— which is the **normal idempotent-replay state, not a conflict**. The old rename
pass's "old/new coexist ⇒ abort" judgement does not carry into a copy model. Every
copied destination (L2 subtree *and* session bucket alike) is classified purely by
filesystem state:

- **source present, destination absent** → stage → copy → manifest-verify →
  atomic publish.
- **source + destination present, manifests equivalent** → *settled*, no-op
  (this is what a replay after a mid-batch crash sees for already-done items).
- **source + destination present, NOT equivalent** → conflict, fail-closed.
- **source absent, destination absent** → *not-applicable*, settled no-op
  (BLOCKER 1, round 4). This is the common, correct state for a runtime a
  workspace never used — e.g. a Claude-only workspace has no Qoder bucket. The
  facet must NOT synthesize an empty destination, and this state must count as
  settled so the marker can be written; only the row below is a conflict.
- **source absent, destination present, marker missing** → under the
  "source retained forever" contract the source can never legitimately vanish, so
  this is unverifiable → fail-closed (do not treat a lone destination as done).

**Manifest a stable snapshot, integrity + POSIX mode (BLOCKER 2 + MEDIUM 2, round
3; BLOCKER 2 round 1 / BLOCKER 4 round 2).** "Old daemon/runtimes stopped" does
not stop a user's editor from touching the old checkout during a long cross-fs
copy. So for each destination:

1. Build a **source-before manifest keyed by relative path**: per entry the type;
   for a regular file a **streaming content hash** *and* its **POSIX mode**
   (permission bits); for a directory its mode; for a symlink the **link target**
   (recorded, never followed). A non-copyable type (FIFO, socket, block/char
   device) → **fail closed**. (mtime / xattr / ownership are explicitly
   out-of-scope.)
2. Copy to a **target-filesystem** staging dir (opaque; symlinks recreated, not
   dereferenced; regular-file mode preserved).
3. Re-manifest the staged copy **and** re-manifest the source again
   (source-after). Publish only when **source-before == source-after ==
   staging** across content hash, symlink target, type, and mode. If the source
   changed under the copy, or the copy diverged (same size, different content;
   changed symlink target; lost executable bit; missing/extra path) → **do not
   publish, do not write the marker**; retry reads the next stable snapshot.
4. Atomic **publish** by a single same-filesystem rename of the staged tree into
   the destination.
5. The **source is left untouched, verbatim, and terminally inert** — never
   auto-removed (invariant #4 scope-out, MEDIUM 2 round 2). It keeps replay
   idempotent; reclaiming it is a separate future product decision.

- *Falsifiers:* source on an external volume (`EXDEV`) still migrates; a crash
  mid-copy re-runs without loss (staging discarded, source intact); a subtree
  mixing plain files and symlinks publishes with symlink targets preserved and
  verified; a same-size-different-content corruption is refused; a FIFO/socket/
  device fails closed; **content or a symlink target rewritten mid-copy is
  refused (source-before ≠ source-after), retried on the next stable snapshot**;
  **an executable file is still executable after migration** (mode preserved and
  verified).

**Session continuity — deterministic filesystem fan-out, no DB (BLOCKER 3, round
3).** The cwd changes from the shared old `workspace.path` to each agent's
distinct bundle root. The migration does **not** read `cli_session_id` or any DB
value — that id is the *backend's* resume authority consumed **later**, when the
agent next spawns at its new cwd; the migration's only job is to make each
agent's own vendor history reachable at that new cwd. The fan-out census is a pure
filesystem fact — **the same `.silverhand/agents/*` direct-child set the L2
inventory already enumerates** under the registry workspace root:

- For Claude and Qoder, compute the one old shared bucket coordinate from the old
  shared cwd; for **each child agent in that inventory set**, publish a verbatim
  copy of that bucket to the child's **new-cwd** bucket coordinate, through the
  same staging + classifier + atomic publish above (1→N opaque fan-out; the extra
  sessions carried along are inert). Guard slug/config-dir with
  `isSlugVerifiableCwd` / override normalization (fail closed on unverifiable).
  Codex and the other non-cwd-scoped runtimes are explicit no-ops; a runtime whose
  old bucket is absent is the not-applicable classifier cell (no empty
  destination synthesized).
- **Batch-level snapshot invariant (BLOCKER 2, round 4).** The N copies share one
  source bucket, so per-destination stability is not enough — the source could be
  stable across each destination's own window yet differ between destination 1 and
  destination 2, leaving N copies from different versions with the marker still
  written. So the stability boundary is the **whole `(workspace, runtime)`
  fan-out, not the item**: take **one** batch `source-before` manifest of the
  shared bucket; every staged copy **and** every already-present equivalent
  destination must equal *that same* manifest; after all N destinations are
  processed, take **one** `source-after` and require `source-before ==
  source-after`. Only then may the fan-out facet settle. No destination may
  independently pick its own legal source version.
- A session bucket that exists for the workspace's old cwd while the inventory has
  **zero** child agents (source present, but no destination at all) is an
  unexpected state — a spawned agent always leaves an L2 child — → **fail closed,
  never silently orphaned** (distinct from the source-absent not-applicable cell).
- *Falsifiers:* with no DB query, two child agents each receive the old-namespace
  copy at their own new cwd and each resumes its own session (via its persistent
  `cli_session_id`) when the backend later spawns it; a fan-out that publishes the
  first of N destinations then crashes re-runs to verify that one equivalent and
  complete the rest — coexistence is replay, not abort; a source rewritten between
  destination 1's publish and destination 2's start makes the whole fan-out
  withhold the marker, and a retry lands all N equal to one stable source; a
  Claude-only workspace migrates with Qoder a no-op and no empty bucket created.

**Single marker gates the whole preflight.** The marker is written only after
every L2 destination *and* every session-bucket destination classify as published
or settled. Any conflict, integrity/stable-snapshot mismatch, unverifiable path,
lone-destination-without-source, `EXDEV` with no writable staging, special-file,
or permission failure → do not write the marker, do not enter a partial layout, do
not clear `cli_session_id`, preserve original bytes, and **abort daemon startup**;
retry idempotently next startup. Dormant agents migrate in the same pass. No
persistent per-item journal is introduced: retained source + deterministic
filesystem inventory + manifest-equivalence classification already make the whole
batch a safe idempotent replay.

**Acceptance proof (for the implementation task).** A Claude/Qoder agent with a
live session resumes the *same* session at its new cwd and appends transcript;
two agents in one workspace each resume their own session; Codex resumes by id; a
crash mid-migration re-runs without losing bytes or switching sessions; source on
an external drive migrates; a same-size-different-content corruption is refused;
departed-member and dormant L2 arrive intact; no partial layout is ever
observable; with the marker absent the daemon never starts on the new resolver.

---

## 6. Release sequencing for the DTO / endpoint removal (BLOCKER 2/4 rounds; plan A)

`workspace_path` and `workspace_host_id` are required fields on DTOs that current
remote clients decode; `/api/workspaces/local-paths` is a live endpoint. Removing
a required DTO field is a **breaking change** under `desktop-server-api-epoch.md`
§3, which mandates the **plan-A atomic triple bump** — in the SAME commit as the
removal set all three constants to the same new value:

```
DESKTOP_SERVER_API_EPOCH  = N+1
MINIMUM_CLIENT_API_EPOCH  = N+1
MINIMUM_SERVER_API_EPOCH  = N+1
```

The lockstep test (`packages/shared/tests/desktop-server-api-epoch.test.ts`)
structurally forbids the non-atomic "ship a tolerant client first, then raise the
server minimum later" sequence that round 1 mistakenly proposed — that shape is
the plan-B bridge, which is not built by default and would require changing the
lockstep test, an adapter, and the §11 exit-condition triple. So:

1. In one commit: remove the DTO fields, `/api/workspaces/local-paths`, the
   append-only column drop, the renderer surfaces (§3.5), and bump the atomic
   triple.
2. Ship server and desktop from that tree. Remote deployment order is free: an
   incompatible pair is rejected before any business DTO is read (HTTP 426 +
   the desktop full-screen upgrade gate) — the accepted plan-A behavior, not an
   incident.

There is no transitional dual-shape DTO and no bridge to exit; the epoch gate is
the existing, sufficient mechanism. The renderer side is @Norman's, landed
lockstep in task 3.

---

## 7. Implementation task breakdown (proposed)

1. **Agent-centric L2 coordinate + deterministic resolver** — introduce
   `workspaces/<workspace_id>/` under the agent home; repoint `memoryDirFor`, the
   cwd resolver, and the L2 seed/index/files-purge/agent-workspace-fs handlers to
   the id-derived path as the sole runtime resolver; prompt L2 → `.`.
2. **L2-relocation migration facet** — add the facet to the daemon convergence
   preflight: registry inventory, cross-fs opaque copy + manifest-hash integrity
   + atomic publish, whole-namespace opaque session fan-out (1→N), the
   computer-local completion marker, startup-abort on failure, all fail-closed
   and idempotent (§5). Owns the falsifiers as tests.
3. **Retire `workspace_path` as a plan-A epoch release** — remove DTO fields,
   `/local-paths`, the append-only column drop, and the renderer surfaces per
   §3.5, with the atomic triple bump in the same commit (§6). Renderer side
   claimed by @Norman, lockstep.
4. **Retire `workspace_host_id` and demote the registry** — per-consumer
   evidence-gated removal; re-derive guest-vs-home realization from the
   agent-centric model; reduce the workspace-registry to a migration-only reader.

Sequencing: 1 and 2 land the new truth and carry existing data; 3 and 4 remove
the dead binding once 1/2 prove the new resolver authoritative; 3 is a single
atomic epoch release (§6).

---

## 8. Open decisions to route

- **Implementation-time evidence gate** — confirm `workspace_host_id` has no
  consumer beyond the workspace→filesystem binding before deleting it, and that
  the guest realization path has a clean agent-centric replacement (§3.4).

(§3.5, previously open, is resolved by @shiki's ruling above.)

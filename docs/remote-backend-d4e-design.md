# D4.e — daemon-owned data-plane proxy (design pass)

**Status**: design pass, **revision 3** (incorporates @Cindy review of
rev2 `b0c04e3`: registry/bind model locked, `agent_dir` route-time
resolver locked, RQ answers locked). Author: @Alice. Reviewer: @Cindy.

**Spec lineage**:
- `docs/remote-backend-d5a-design.md` (D5.a — control/outbound
  **transport** unification, merged at `2e5fd60`).
- `docs/architecture-principles.md` §9 (control plane vs execution
  plane; §9.2 fs-leak design checks; §9.3 daemon = security boundary).
- `docs/d4-d-acceptance.md` (D4.d — `agent_materialize`, the first
  daemon-owned agent-file op; the precedent D4.e generalizes).

---

## 1. Problem statement (revised)

D5.a unified the **transport**. It did **not** make the backend
deployment-invariant, because the backend is still the authority for
**host-local path resolution** of agent/workspace files. That single
disease shows up in three forms:

- **(a) Direct fs ops** — the backend computes a path and acts on it
  (`fs.writeFile` / `readFile` / `rm`) for L1/L2/CONSENSUS.
- **(b) Path metadata shipped to the daemon** — `runtime_start` carries
  backend-computed `agent.home_dir` + `workspace.path`. This is a
  *deliberate* carve-out today (`packages/host/src/protocol.ts:281,382`
  comment: "base metadata … is allowed to cross the boundary as data").
- **(c) Paths published to agents** — `list_workspaces` returns
  `agent_dir` (a backend-computed absolute path) and
  `platform-prompt.ts:573` tells agents to read MEMORY/notes/logs from
  it.

All three are "backend owns path resolution". In embedded mode they're
invisible because backend and daemon share one disk; in remote they
break (wrong host) or are dead carve-outs. **The thesis of D4.e is:
make the daemon the sole authority for host-local path resolution**, and
route every path-dependent operation through it. Moving the four
lifecycle fs ops is necessary but not sufficient — (b) and (c) must move
too, or invariant I1 is a slogan, not a property.

> This corrects revision-1 §1.1, which wrongly claimed "backend only
> sends semantic runtime-start metadata". The READ *bytes* are
> daemon-owned (`prompt-context.ts`), but the READ *path resolver* is
> still backend-owned (`runtime-start-options.ts:45,90,98`). Cindy
> P1-1.

### 1.1 What is already correct (do NOT touch)

- **Prompt-assembly byte reads** happen inside the daemon
  (`packages/host/src/daemon/prompt-context.ts`). D4.e keeps the read
  *in* the daemon; it only changes *who resolves the paths* it reads
  from (backend → daemon registry, see §3).
- **Agent creation** materializes L1 on the daemon via
  `agent_materialize` (D4.d) — and notably resolves the agent-home path
  from the daemon's own `homedir()`, the exact pattern D4.e
  generalizes.
- **Backend-local infra fs** (logger, SQLite/WAL/migration-lock,
  embedded-bootstrap token, DB backups) — the backend's **own host**
  resources; out of scope, correctly stay on the backend.

### 1.2 The gap surface (corrected & extended)

| # | Operation | Code today | Form | Must become |
|---|-----------|-----------|------|-------------|
| G1 | L2 workspace seed | `seedAgentL2`/`ensureAgentL1Dir` @ `routes.ts:1658-1659,2192-2193` | (a) | `agent_l2_seed` intent |
| G2 | Workspace init + CONSENSUS | `initWorkspaceDir` @ `routes.ts:1640` | (a) | `workspace_provision` intent (= the **bind** step, §3.1) |
| G3 | Agent-file delete | `DELETE /api/agents/:id` fs.rm @ `routes.ts:4544-4556` | (a) | `agent_files_purge` intent |
| G4 | Agent-workspace UI read | `buildAgentWorkspaceDto` @ `agent-workspace.ts:64-73`; standalone-disabled @ `routes.ts:4202-4210` | (a) | `agent_workspace_read` intent (read-only) |
| **G5** | **`list_workspaces.agent_dir`** (agent-facing path) | `buildAgentListWorkspacesDto`; DTO `dto.ts:1476`; `platform-prompt.ts:573` | **(c)** | host-local resolved, see §3.4 |
| **G6** | **`runtime_start` path metadata** (`home_dir`, `workspace.path`, `workspace_memory_index`) | `runtime-start-options.ts:45,90,98`; `protocol.ts:281,297,382,390` | **(b)** | semantic-ids, daemon resolves (§3.5, **mandatory**) |

G5/G6 are new vs revision-1 (Cindy P1-3, P1-1).

---

## 2. The missing primitive: daemon-local workspace registry (Cindy P1-2)

Revision-1 said "daemon computes `<ws>/.silverhand/...` from its own
truth". **It has no such truth.** The daemon has no backend DB and no
`workspace_id → host-local path` mapping. The only mapping today is
`workspaces.workspace_path` in the **server** DB — which is exactly the
value `workspace_path_not_supported` already gates off in standalone.
So the "daemon computes paths" claim is unimplementable as written.

**D4.e introduces a daemon-local workspace registry** (storage form
**locked**, Cindy rev2 P1): a persistent host-side mapping
`workspace_id → absolute local path`, owned by the daemon.

**Storage (locked):** a **daemon-owned JSON registry file** — NOT
SQLite, NOT any native dep (keeps the daemon dependency-light and avoids
a second ABI surface). Concretely:
- Lives in the daemon state dir, same domain as daemon identity/config.
- `mode 0600`, **atomic write** (write-temp + `rename`), and a
  top-level `schema_version` for forward migration.
- **Namespace isolation (locked, Cindy):** entries must NOT be keyed by
  bare `workspace_id` — that collides / leaks across backend or profile
  swaps on the same machine. The registry is scoped to a **host
  namespace** = `(server_origin, host_id)` (the daemon's bound identity).
  Mechanism: the file records `{ server_origin, host_id }` in its
  header, the managed-path root is namespaced by that identity (below),
  and **load-time guard**: if the file's recorded identity ≠ the current
  daemon identity, the registry is treated as foreign and not used
  (refuse, don't silently adopt). Entries inside are then keyed by
  `workspace_id` safely, because the file itself is identity-isolated.

**Path resolution rules:**
- **Agent-home workspace** (`agent_home` / DM): path derives from the
  daemon's `homedir()` + `agent_id`, no registry entry needed — same as
  `agent_materialize` already does.
- **Regular workspace (M1, locked):** the daemon picks a **deterministic
  daemon-managed path** at provision time — `<daemon-state>/<host-ns>/
  workspaces/<workspace_id>` (root is daemon-local + identity-namespaced;
  exact root dir is the daemon's to choose). **D4.e M1 does NOT support
  arbitrary user-chosen folders** — letting the user bind an external
  folder is a later explicit host-control feature, and it must NOT route
  a path back through the backend. The chosen path is recorded in the
  registry at `workspace_provision` (§3.1); every later op
  (`agent_l2_seed`, `agent_files_purge`, `agent_workspace_read`,
  `agent_workspace_index`, runtime_start resolution) looks it up there.
  The daemon never accepts a path from the backend.

This also cleanly explains standalone's `workspace_path_not_supported`:
in the target model `workspace_path` is **daemon-local truth**, never
server-held — so the server simply doesn't have it, by design.

**Migration weight (risk, §6).** The backend DB column
`workspaces.workspace_path` is read in many places. End-state: it is
deprecated (the server keys workspaces by id; paths live only on the
owning daemon). D4.e cannot delete the column in one slice; the
transitional stance is in §6.1.

---

## 3. Chosen architecture

### 3.1 Operation-named intents over the D5.a envelope (Cindy RQ2: agreed)

Operation-named, **not** a generic `fs_*` RPC — rationale unchanged and
endorsed by review: a generic fs proxy re-leaks paths to the backend
(violates I1/§9.2) and is a security hole (daemon = security boundary,
§9.3.3). All intents are `server_to_daemon` commands, additive on the
D5.a envelope, carrying semantic ids only, with per-command typed-error
scoping like `agent_materialize`.

| Intent | Params (semantic) | Result | Resolves via |
|--------|-------------------|--------|--------------|
| `workspace_provision` | `{ workspace_id, kind }` | `{ provisioned, bound }` | **binds** registry entry (§2) at a daemon-managed path + CONSENSUS + agents dir |
| `agent_l2_seed` | `{ agent_id, workspace_id, template_choice }` | `{ seeded, l2_present }` | registry |
| `agent_files_purge` | `{ agent_id, scope:'all'\|'l2', workspace_ids? }` | `{ purged_count }` or typed `partial_purge` | registry + homedir |
| `agent_workspace_read` | `{ agent_id }` | capped `{ system_prompt_preview, memory_preview, notes:[{name,size}] }` | homedir (L1) |
| `agent_workspace_index` | `{ agent_id, workspace_ids }` | `{ entries: [{ workspace_id, agent_dir }] }` | registry + homedir (route-time `agent_dir` resolver, §3.4) |

`workspace_provision` is the keystone: it is the **bind** step that
populates the registry, so it must land first (§8).

### 3.2 Backend side after D4.e

- Member-add route stops calling `ensureAgentL1Dir`/`seedAgentL2`;
  dispatches `agent_l2_seed`.
- Workspace-create dispatches `workspace_provision` (which binds the
  registry); backend stores only `workspace_id`, never the path.
- `DELETE /api/agents/:id` dispatches `agent_files_purge`; DB-impact
  computation (which rows/workspaces) stays backend (IM/ACL); commit
  boundary per §3.3.
- `GET /api/agents/:id/workspace` dispatches `agent_workspace_read`;
  standalone hard-disable (`routes.ts:4202-4210`) removed.
- `list_workspaces` keeps its ACL/DB list but dispatches
  `agent_workspace_index` to stamp each `agent_dir` daemon-side (§3.4).

### 3.3 Purge / delete commit boundary (Cindy P1-4 + RQ3: fail-fast)

Single testable rule, replacing revision-1's contradictory §3.3/§6.2:

1. Backend computes the delete impact (rows, workspaces) — unchanged.
2. Backend dispatches `agent_files_purge`. **DB rows are NOT deleted
   until the purge acks success.**
3. Daemon offline → 503 `host_attach_pending`; row preserved; user
   retries. Typed `partial_purge` / failure → **block the delete, keep
   the row** so a later retry has its routing anchor.
4. Only a clean purge ack → backend commits the DB row deletion.

No 2-phase commit and no `tombstone`/`pending_delete` state machine in
D4.e (that stronger "delete DB now, sweep orphans later" semantics is a
separate future item). This does change today's behavior
(`fs.rm({force:true})` + always-204) to remote-safe fail-fast — called
out as an intentional behavior change.

### 3.4 `list_workspaces.agent_dir` (Cindy P1-3; mechanism locked rev2)

Decision: **keep `agent_dir` in the agent-facing DTO** (the agent runs
*on* the owning host, so a same-host path is legitimately useful to it),
resolved via a **route-time daemon resolver** — **locked, Cindy rev2**.

**Mechanism (locked):** `list_workspaces` stays a backend route that
does ACL/DB list, then dispatches the narrow `agent_workspace_index`
intent `{ agent_id, workspace_ids }` to the owning daemon, which returns
`{ workspace_id, agent_dir }` per workspace (resolved from registry +
homedir). The DTO keeps `agent_dir`, but the **value is daemon-stamped,
never backend-assembled** from `workspace_path`.

**Rejected: spawn-time injection.** `list_workspaces` is a *dynamic*
tool — an agent's membership set can change while it is running — so a
path set injected once at spawn goes stale. Route-time resolution is the
only correct option. (This settles rev2 RQ4.)

**No agent-facing write path is added** (Cindy RQ5): agents edit their
own files via Read/Edit on their host; D4.e adds no backend-mediated
write intent. `agent_workspace_read` stays read-only.

### 3.5 `runtime_start` semantic-ids migration (Cindy P1-1 + RQ1)

**Accepted: this is mandatory, not a deferrable follow-up.** While
`runtime_start` ships backend-computed `home_dir`/`workspace.path`/
`workspace_memory_index`, I1 and I6 are false and M1 cannot claim
final-form closure.

Target: `runtime_start` carries semantic refs (`agent_id`,
`workspace_id`, `agent_home_workspace_id`, and a list of workspace_ids
for the memory index). The daemon resolves all paths via §2 (registry +
homedir) — it already does exactly this for `agent_materialize`. The
`protocol.ts:281,382` "paths allowed to cross as data" carve-out is
**revoked**.

Placement: it is the **M1-closure-blocking final slice** of D4.e
(D4.e-6). It may be split into its own branch D4.f for review hygiene,
but **M1 must not be declared closed before it lands**. It is sequenced
last because it touches the hottest path (spawn) and the most tests, and
it depends on the registry (§2) existing first.

---

## 4. Hard invariants (revised)

- **I1 — Daemon is the sole host-local path authority.** No backend
  code transmits or acts on an agent-host fs path — not in data-plane
  intents, not in `runtime_start`, not in agent-facing DTOs. Backend
  speaks `agent_id`/`workspace_id`; daemon resolves via §2.
- **I2 — Additive to the D5.a envelope, no fork.** Same add-an-intent
  surface + per-command typed-error scoping as `agent_materialize`.
- **I3 — Idempotent / retry-safe**, daemon-online-or-fail-fast, no
  durable offline queue.
- **I4 — Ownership enforced on the daemon** (`agent.host_id ==
  workspace_host_id == this host`); backend ACL = who-may-ask, daemon =
  whose-disk.
- **I5 — Deployment-invariant**: identical intents/envelope embedded &
  standalone; no mode branch in routes.
- **I6 — Terminal: `packages/backend/src` holds no agent-host path
  resolution** — no fs ops on L1/L2/CONSENSUS **and** no
  `workspace_path`-derived path emitted to daemon or agent. Enforced by
  a dependency-guard test (mirrors D5.a's
  `dependency-guard-no-host-client`). I6 is only true once G6
  (runtime_start) and G5 (agent_dir) land — hence both are in scope.

---

## 5. What happens to backend fs / path code

- `workspace-files.ts` (`seedAgentL2`/`ensureAgentL1Dir`/
  `initWorkspaceDir`/`seedNotesIfMissing`), `agent-workspace.ts`
  (`buildAgentWorkspaceDto`), the `DELETE` fs.rm block, and the
  `runtime-start-options.ts` path computation all lose their fs/path
  bodies; backend keeps only the dispatch + DB/ACL semantics.
- **Template ownership (Cindy RQ4: daemon canonical).** `SEED_NOTES`,
  `INITIAL_MEMORY_MD`, the CONSENSUS default move to the daemon (the
  only writer). Backend does **not** import the daemon's templates;
  only **shared schemas/types** may be shared. Byte-identity of seeded
  content is pinned by tests (§7 A5).

Out of scope: avatar/blob storage (T1/M2 "blob remote 中转"),
backend-local infra fs, prompt-assembly byte reads (already
daemon-side).

---

## 6. Risks & trade-offs

### 6.1 `workspace_path` column deprecation (locked: transitional)
**Locked (Cindy rev2):** transitional-deprecate, **do not drop the
column in D4.e**. The registry (§2) is the authority. The server column
survives only as an embedded legacy / display-compat value and:
- is **never read** by formal path resolution, data-plane intents,
  `runtime_start`, or any agent-facing DTO (those all go through the
  daemon registry);
- carries an explicit `@deprecated` comment at its definition + a
  guard/lint (extend the I6 dependency-guard test) asserting it is not
  referenced by those code paths.

Full column removal is a tracked follow-up, not D4.e scope.

### 6.2 Migration atomicity per op
Each slice must flip one operation end-to-end (add intent → route
switches → delete backend fs/path body) within the **same** slice, so
the backend body and the daemon body never both run.

### 6.3 runtime_start blast radius
G6 touches spawn + many tests; sequenced last, on the proven registry.

### 6.4 Purge orphans
Mitigated by §3.3 fail-fast (keep row until ack); no blind DB delete.

### 6.5 Template byte-drift
Moving templates to the daemon must not change seeded bytes; pinned.

---

## 7. Acceptance criteria (sketch)

- **A1** `packages/backend/src` does zero agent-host path resolution:
  no L1/L2/CONSENSUS fs ops **and** no `workspace_path`-derived path in
  any outbound intent or agent-facing DTO (dependency-guard test).
- **A2** member-add, workspace-create, agent-delete,
  agent-workspace-read, `list_workspaces`, **and `runtime_start`** all
  route path resolution through the daemon; no fs/path fallback.
- **A3** Shared adapter contract test per intent (embedded + standalone).
- **A4** Parity e2e per op through a real daemon, both rigs (reuse
  D5.a parity harness).
- **A5** Seeded content (notes/MEMORY/CONSENSUS) byte-identical to
  pre-D4.e.
- **A6** `GET /api/agents/:id/workspace` works in standalone (disable
  removed); `list_workspaces.agent_dir` correct in both modes.
- **A7** M1-closure gate: G6 landed, `runtime_start` carries no paths.

---

## 8. Implementation slicing (revised)

- **D4.e-1 — Workspace registry + `workspace_provision` (bind) +
  `agent_workspace_index`.** The keystone primitive (§2): daemon-owned
  JSON registry (identity-namespaced, 0600, atomic, schema_version),
  daemon-managed deterministic paths, bind at provision, CONSENSUS +
  agents dir. Includes the `agent_workspace_index` route-time resolver
  so `list_workspaces.agent_dir` becomes daemon-stamped (§3.4) — it
  depends on the registry, so it lands here.
- **D4.e-2 — Read proxy `agent_workspace_read`.** L1 (homedir) read
  first to prove the pattern + remove the standalone disable; reuses
  registry for any L2 read.
- **D4.e-3 — `agent_l2_seed`** + member-add route switch + delete
  backend `seedAgentL2`; move L2 templates to daemon.
- **D4.e-4 — `agent_files_purge`** + DELETE route switch (commit
  boundary §3.3) + delete backend fs.rm block.
- **D4.e-5 — Cleanup + guard (A1) + acceptance doc
  `docs/d4-e-acceptance.md`** (excludes the runtime_start gate, which
  is -6).
- **D4.e-6 — `runtime_start` semantic-ids migration (MANDATORY,
  M1-closure-blocking).** Revoke the path carve-out; daemon resolves
  via registry; update A7. May be branched as D4.f for review hygiene
  but blocks M1 closure either way.

Each slice: shared contract test + parity e2e, Cindy review per slice,
fixups squashed at closeout.

---

## 9. Decisions log (rev3 — all locked)

Round-1 (rev2): RQ1 runtime_start → mandatory (§3.5); RQ2
operation-named → kept (§3.1); RQ3 purge → fail-fast, no 2PC (§3.3);
RQ4 templates → daemon canonical (§5); RQ5 read-only, no write path
(§3.4).

Round-2 (rev3, Cindy locked):
1. **Registry storage** → daemon-owned JSON file, no SQLite/native dep;
   0600, atomic write, `schema_version`; identity-namespaced by
   `(server_origin, host_id)` with a load-time foreign-registry guard
   (§2).
2. **`workspace_path` column** → transitional-deprecate, not dropped in
   D4.e; `@deprecated` + guard that formal/runtime_start/agent-facing
   paths never read it (§6.1).
3. **`workspace_provision` trigger** → daemon picks a deterministic
   daemon-managed path `<daemon-state>/<host-ns>/workspaces/
   <workspace_id>`; no arbitrary user-chosen folder in D4.e M1; external
   folder bind is a later host-control feature that must not route a
   path through the backend (§2).
4. **`agent_dir` mechanism** → route-time daemon resolver via
   `agent_workspace_index`; spawn-time injection rejected (stale under
   dynamic membership) (§3.4).
5. **D4.e-6 vs D4.f** → keep runtime_start as the in-stage final slice;
   may split to a separate blocking branch if implementation is large,
   but progress/acceptance must not claim M1 closure before it lands
   (§3.5).

No open questions remain; D4.e-1 is unblocked on LGTM.

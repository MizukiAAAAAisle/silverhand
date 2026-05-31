# D4.e — Acceptance: daemon as sole host-local path authority

Stage **D4.e** removes host-local path resolution from the backend control
plane and routes every workspace/agent filesystem operation through formal
daemon intents. This document is the acceptance closure for slices
**D4.e-1 … D4.e-6**. The final slice **D4.e-6** (`runtime_start` semantic-ids)
is the M1-closure gate and is now **LANDED** — M1 closure is claimable (§6).

Design source: `docs/remote-backend-d4e-design.md`. Predecessor acceptance:
`docs/d4-d-acceptance.md` (D4.d — `agent_materialize`, the first formal
server↔daemon path semantic).

---

## 0. Commit chain (branch `feature/remote-backend-v1-stage-d4-e-design`)

Squashed at handoff to **one clean commit per slice** (fixups folded in), on
base `eb35192` (D5.a-done tip). Pre-squash history preserved at tag
`d4e-pre-squash-backup`.

| Slice | Commit | What landed |
| --- | --- | --- |
| D4.e design | `ca9eda2` | Design doc — daemon as sole host-local path authority + registry/bind model + `agent_dir` resolver (rev1→rev3). |
| D4.e-1 | `6ea2afe` | Daemon workspace **registry** + `workspace_provision` (bind) + `agent_workspace_index` (route-time resolver); lazy `WorkspaceRegistryBackfiller`; `list_workspaces` daemon-stamps `agent_dir`; A3 contract + A4 parity for the registry intents. |
| D4.e-2 | `e78356e` | `agent_workspace_read` daemon intent; `GET /api/agents/:id/workspace` rewired (semantic id only); **deleted** backend `src/agent-workspace.ts`; standalone disable removed (A6). |
| D4.e-3 | `fb6d5b8` | `agent_l2_seed` daemon intent; member-add + create-with-members route switch; **deleted** backend `seedAgentL2`; co-location gate lifted (universal). |
| D4.e-4 | `7f5433f` | `agent_files_purge` daemon intent; `DELETE /api/agents/:id` rewired on the §3.3 fail-fast commit boundary; **deleted** backend `fs.rm` block + `l1_path`/`l2_paths` from the delete-impact DTO; backfill-before-purge + `skipped_unprovisioned` fail-closed. |
| D4.e-5 | `aea0902` | Cleanup of dead agent-host fs/path code (`workspace-files.ts`, `agent-profile.ts`, `provision.ts`'s `validateWorkspacePath`) + **A1 dependency-guard** + this acceptance doc. |
| D4.e-6 | `bac9635` | `runtime_start` semantic-ids migration — **M1-closure gate, LANDED**. Wire `runtime_start` refs go semantic-only (`id`/`name`/`kind`); daemon resolves every host path (`registry.resolve` for `regular`, `computeAgentDir` for `agent_home`, with the `agent_home` id validated against `agentHomeWorkspaceId(agentId)`) and fails closed with typed `workspace_not_provisioned`/`registry_unavailable`; backend does a bounded lazy registry backfill before dispatch (no-dispatch + pending-rollback on partial/failed) behind an I4 host-equality gate; A1 dependency-guard extended to the path-emission half. |

---

## 1. Acceptance criteria status

| ID | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| **A1** | `packages/backend/src` does zero agent-host path resolution: no L1/L2/CONSENSUS fs ops **and** no `workspace_path`-derived path in any outbound intent or agent-facing DTO. | **DONE** — both halves closed. | `dependency-guard-no-agent-host-fs.test.ts`: fs-import allow-list + retired-`validateWorkspacePath` name-pin (fs-op half) **and** the D4.e-6 path-emission guard — `runtime/runtime-start-options.ts` imports no `node:path`/`node:fs` and emits no `workspace_path`/`home_dir`, and `home_dir` appears nowhere in `backend/src`. |
| **A2** | member-add, workspace-create, agent-delete, agent-workspace-read, `list_workspaces` **and `runtime_start`** route path resolution through the daemon; no fs/path fallback. | **DONE** | Per-slice route rewrites (§0); D4.e-6 made `runtime_start` semantic-only — daemon resolves all paths, backend does a bounded lazy backfill before dispatch and fails closed (no path fallback). |
| **A3** | Shared adapter contract test per intent (embedded + standalone). | **DONE** | `tests/runtime/outbound-frame-adapter-contract.ts` run by `.embedded.test.ts` + `.standalone.test.ts`: `workspace_provision`, `agent_workspace_index`, `agent_workspace_read`, `agent_l2_seed`, `agent_files_purge` round-trip + positive-typed + foreign-code negatives. |
| **A4** | Parity e2e per op through a real daemon, both rigs. | **DONE** | `tests/e2e/parity/outbound-parity-contract.ts` Phases D (provision/index), E (read), F (l2 seed), G (purge), run by `embedded-parity.test.ts` + `standalone-parity.test.ts`. |
| **A5** | Seeded content (notes/MEMORY/CONSENSUS) byte-identical to pre-D4.e. | **DONE** | Daemon is the canonical writer; bytes pinned by `packages/host/tests/workspace-registry/handlers.test.ts` (CONSENSUS default + L2 notes set) and `agent-materialize/handler.test.ts` (L1 template). |
| **A6** | `GET /api/agents/:id/workspace` works in standalone (disable removed); `list_workspaces.agent_dir` correct in both modes. | **DONE** | D4.e-2 removed the standalone disable; D4.e-1 daemon-stamps `agent_dir`. |
| **A7** | M1-closure gate: G6 landed, `runtime_start` carries no paths. | **DONE** | D4.e-6: `runtime_start` wire frame is semantic-only (schema-rejects `path`/`home_dir`); daemon resolver is the single path authority; per-command typed-error scoping + fail-closed. M1 closure claimable. |

---

## 2. Invariants

- **I1 — Daemon is the sole host-local path authority.** Backend forwards
  `requested_path` verbatim (workspace-create user input, backfill of legacy
  rows) and caches the daemon's authoritative `bound_workspace_path` back into
  the transitional `workspace_path` column; it never interprets, stats, or
  derives a host path itself. ✔ for all D4.e ops; D4.e-6 closed the last
  exception — `runtime_start` now ships semantic refs and the daemon resolves
  every path (registry for `regular`, `computeAgentDir` for `agent_home`).
- **I4 — Ownership on the daemon.** Materialize/seed/purge/read/index all run
  against the daemon's own registry; the backend supplies semantic ids.
- **I5 — Deployment-invariant.** Identical intents/envelope embedded &
  standalone; no mode branch in routes. ✔ (e.g. D4.e-2 removed the last
  standalone-only disable).
- **I6 — `packages/backend/src` holds no agent-host path resolution.**
  **FULLY CLOSED.** fs-op half closed in D4.e-5; the
  `workspace_path`-derived-path-emission half closed in D4.e-6 (`runtime_start`
  semantic-only + extended dependency-guard). I6 now holds in full.

---

## 3. D4.e-5 cleanup — what was removed

The backend's pre-D4.e agent-host fs/path modules were dead (zero production
call sites) once D4.e-2…-4 routed every op through the daemon. They are now
deleted from `packages/backend/src`:

- **`workspace-files.ts`** — `initWorkspaceDir` / `ensureAgentL1Dir` /
  `seedNotesIfMissing` + the seed-template constants. The daemon owns these
  (`workspace_provision` → `initWorkspaceSkeleton`; `agent_materialize` → L1
  template; `agent_l2_seed` → `getAgentL2Template`). The embedded test fake's
  L1/skeleton stand-in moved to a **test-only** clone,
  `packages/backend/tests/utils/embedded-seed-fixtures.ts` (per the
  `dependency-guard-agent-materialize` tripwire's prescribed "copy it locally"
  remedy — the backend production graph never imports the daemon template
  module).
- **`agent-profile.ts`** — `activeAgentProfileDir` / `agentL1ProfileDir` /
  `agentMemoryDirFor`. Pure `workspace_path`-derived agent L1/L2 path string
  builders, zero callers. Deleted.
- **`provision.ts`** — `validateWorkspacePath` (a backend-side `workspace_path`
  validator: root/home/silverhand-state-root rules) was a host-path AUTHORITY
  with zero callers; its rule now lives only on the daemon registry. Deleted.
  The file's one surviving responsibility, `ensureWorkspacesRoot` (managed-root
  `mkdir`, backend-local infra), moved to a narrow single-purpose module
  `src/workspaces-root.ts`, and `provision.ts` was removed.
- Their unit tests (`tests/repos/workspace-files.test.ts`,
  `tests/agent-profile.test.ts`) were deleted with them; the real seeding
  behavior is covered by the daemon's own tests (A5).

Earlier slices already deleted `src/agent-workspace.ts` (D4.e-2) and the
DELETE `fs.rm` block (D4.e-4).

---

## 4. A1 dependency-guard (the structural enforcement)

`packages/backend/tests/dependency-guard-no-agent-host-fs.test.ts` bans any
`node:fs` / `fs` / `fs/promises` import from `packages/backend/src` except an
explicit **backend-local-infrastructure** allow-list:

| Allowed fs importer | Why (backend's OWN on-disk state, not an agent-host path) |
| --- | --- |
| `db.ts` | SQLite open / WAL |
| `logger.ts` | JSONL logs under `~/.silverhand/logs` |
| `storage/blob-file-storage.ts` | attachment/blob storage |
| `runtime/activity-log-writer.ts` | per-conversation activity log files |
| `workspaces-root.ts` | `ensureWorkspacesRoot` (managed root dir; narrow single-purpose module) |
| `index.ts` | boot wiring |
| `auth/embedded-bootstrap.ts` | embedded identity/config bootstrap |

A new fs importer trips the guard and forces a review: either it is more
backend-local infra (extend the allow-list with justification) or it is an
agent-host fs op that must move to the daemon. The guard also self-checks the
matcher against every realistic import form and asserts no stale allow-list
entry.

The fs-import guard cannot see a host-path authority that resolves paths with
pure string ops (no `fs`). A separate pin therefore asserts the retired
`validateWorkspacePath` symbol does not reappear anywhere in
`packages/backend/src`, so a server-side path validator can't be re-introduced
behind the allow-list.

**The path-EMISSION half of A1 (D4.e-6).** The fs-import guard cannot see a
host-path authority that resolves paths with pure string ops (no `fs`) —
`runtime-start-options.ts` pre-D4.e-6 built a `workspace_path`-derived
agent-home path STRING (it imported `node:path`, not `fs`). D4.e-6 revoked that
carve-out and the guard now also pins, in a dedicated block:
- the runtime_start builder (`runtime/runtime-start-options.ts`) imports no
  `node:path`/`node:fs`;
- it references no host-path field (`workspace_path` / `home_dir` /
  `silverhandDir` / `agentHomeDir`);
- the agent L1 home key `home_dir` appears nowhere in `packages/backend/src`
  (so a server-emitted agent-home path cannot quietly reappear).

---

## 5. `workspace_path` column (transitional)

Locked decision (design §6.1): **do not drop the column in D4.e.** The daemon
registry is the authority. The column survives only as an embedded
legacy/display-compat cache and:
- is never read by any **formal path-resolution / `runtime_start` / agent-facing
  resolver** surface (D4.e-2…-4 all dispatch semantic ids; the delete-impact
  DTO's host-path fields were removed in D4.e-4; D4.e-6 made `runtime_start`
  semantic-only). No host path the backend computes ever crosses to the daemon
  or an agent.
- is still read by the **path-resolution seams** in exactly two allowed ways:
  forwarded as `requested_path` to `workspace_provision` (create + backfill),
  and refreshed from the daemon's `bound_workspace_path` ack.
- **transitional display/snapshot residue (NOT path resolution):** the column
  is also copied verbatim into conversation rows as a denormalized snapshot
  (`channel-service.ts`, `conversation-repo.ts` copy `workspace.workspace_path`
  onto the conversation/child rows) and surfaced in some display DTOs. These
  are cache/display reads, never used to resolve, stat, or emit a host path to
  the daemon/agent — so they don't pierce I1/I6. They retire with the column
  itself (a tracked follow-up), not in D4.e.

As of D4.e-6, `runtime-start-options.ts` no longer reads the column at all (it
builds semantic refs only); the daemon resolves `runtime_start` paths and the
backend's bounded lazy backfill forwards `workspace_path` as `requested_path`.
Full column removal is a tracked follow-up, not D4.e scope.

---

## 6. M1 closure — claimable

Per design §9 round-2 decision 5: progress/acceptance must not claim M1 closure
before `runtime_start` carries no paths. **D4.e-6 has landed:** the
`runtime_start` wire frame is semantic-only (schema-rejects `path`/`home_dir`),
the daemon is the single path authority (registry / `computeAgentDir`,
fail-closed with typed codes), the backend does a bounded lazy registry
backfill before dispatch, and the A1 dependency-guard now covers the
path-emission half. A1/A2/A7 are DONE and I1/I6 hold in full — **M1 closure is
claimable**. This document closes D4.e-1…-6.

### How D4.e-6 closes the gate (slice detail)

- **Wire (`packages/host/src/protocol.ts`).** `runtime_start` workspace ref is
  `{id,name,kind}` and agent ref is `{id,name}` — both `.strict()`, with
  `home_dir` added to `FORBIDDEN_RUNTIME_START_OPTION_KEYS` (banned nested too).
  New `RuntimeStartErrorCodeSchema = {workspace_not_provisioned,
  registry_unavailable}` is unioned into a per-command `runtime_start` error
  schema (per-command scoping — no foreign typed code leaks onto its arm), and
  mirrored on the outbound frame schema.
- **Daemon resolver (`daemon/runtime-start-resolve.ts`).**
  `resolveRuntimeStartPaths(options, deps)` maps semantic refs →
  `ResolvedStartOptions` (the internal path-bearing shape): `agent.home_dir` and
  `agent_home` workspaces resolve via `computeAgentDir`, `regular` workspaces via
  the injected `resolveRegularWorkspacePath` (registry). A failure throws a typed
  `RuntimeStartResolveError`. The Supervisor resolves BEFORE binary/prompt/spawn
  (fail-closed: no spawn for an unprovisioned regular workspace); `run.ts` wires
  the registry resolver and maps `WorkspaceRegistryError` → the typed codes.
- **Backend builder (`runtime/runtime-start-options.ts`).** Semantic-only; no
  `node:path`/`node:fs`, no `workspace_path`/`home_dir`.
- **Backend bounded lazy backfill (`runtime/outbound-event-fanout.ts`).** Before
  dispatching `runtime_start`, the regular workspaces it references (primary +
  memory-index; `agent_home` skipped) are re-bound via
  `WorkspaceRegistryBackfiller.ensure`; `ok`/`noop` → dispatch, `partial`/`failed`
  → no dispatch + rollback the claimed deliveries to pending (retry anchor). This
  covers the cold-start / hydrate→pending-replay path that would otherwise jam on
  the daemon-side fail-closed (Cindy `2A_y70Aue5X1SlOr`).

---

## 7. Gates at D4.e-6 tip (`bac9635`)

- `pnpm -r typecheck` — clean (all 6 workspace projects).
- backend full suite — 1458 pass | 1 skip (118 files).
- host full suite — 827 pass (37 files), incl. new `runtime-start-resolve.test.ts`
  (resolver + fail-closed), `protocol.test.ts` D4.e-6 semantic-ref reject +
  typed-error taxonomy, supervisor fail-closed, and the two `runtime_start`
  typed-error wire fixtures.
- A1 dependency-guard — 7 pass (fs-op half + D4.e-6 path-emission half).
- A3 adapter contract (both transports) + A4 parity (both rigs) green for all
  five D4.e intents; `runtime_start` parity exercised by the standalone/embedded
  g2 + parity rigs through the real daemon registry.

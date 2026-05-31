# D4.e — Acceptance: daemon as sole host-local path authority

Stage **D4.e** removes host-local path resolution from the backend control
plane and routes every workspace/agent filesystem operation through formal
daemon intents. This document is the acceptance closure for slices
**D4.e-1 … D4.e-5**. The final slice **D4.e-6** (`runtime_start` semantic-ids)
is the M1-closure gate and is **NOT yet landed** — see §6.

Design source: `docs/remote-backend-d4e-design.md`. Predecessor acceptance:
`docs/d4-d-acceptance.md` (D4.d — `agent_materialize`, the first formal
server↔daemon path semantic).

---

## 0. Commit chain (branch `feature/remote-backend-v1-stage-d4-e-design`)

| Slice | Commits | What landed |
| --- | --- | --- |
| D4.e-1 | `19db51e` … `877bd52`, `d207c07`, `e3a31f2` | Daemon workspace **registry** + `workspace_provision` (bind) + `agent_workspace_index` (route-time resolver); lazy `WorkspaceRegistryBackfiller`; `list_workspaces` daemon-stamps `agent_dir`; A3 contract + A4 parity for the registry intents. |
| D4.e-2 | `75ea21c`, `59b3ca8` | `agent_workspace_read` daemon intent; `GET /api/agents/:id/workspace` rewired (semantic id only); **deleted** backend `src/agent-workspace.ts`; standalone disable removed (A6). |
| D4.e-3 | `6d8efe6`, `50132e6` | `agent_l2_seed` daemon intent; member-add + create-with-members route switch; **deleted** backend `seedAgentL2`; co-location gate lifted (universal). |
| D4.e-4 | `65e2112`, `6dffaa4` | `agent_files_purge` daemon intent; `DELETE /api/agents/:id` rewired on the §3.3 fail-fast commit boundary; **deleted** backend `fs.rm` block + `l1_path`/`l2_paths` from the delete-impact DTO; backfill-before-purge + `skipped_unprovisioned` fail-closed. |
| D4.e-5 | `b47325c` | Cleanup of dead agent-host fs/path code (`workspace-files.ts`, `agent-profile.ts`, `provision.ts`'s `validateWorkspacePath`) + **A1 dependency-guard** + this acceptance doc. |
| D4.e-6 | *(pending)* | `runtime_start` semantic-ids migration — **M1-closure-blocking**, not yet landed. |

---

## 1. Acceptance criteria status

| ID | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| **A1** | `packages/backend/src` does zero agent-host path resolution: no L1/L2/CONSENSUS fs ops **and** no `workspace_path`-derived path in any outbound intent or agent-facing DTO. | **PARTIAL** — fs-op half **CLOSED**; path-emission half pending D4.e-6. | `dependency-guard-no-agent-host-fs.test.ts` (fs-import allow-list + retired-`validateWorkspacePath` name-pin). Residue: `runtime/runtime-start-options.ts` still emits a `workspace_path`-derived agent-home path into `runtime_start`. |
| **A2** | member-add, workspace-create, agent-delete, agent-workspace-read, `list_workspaces` **and `runtime_start`** route path resolution through the daemon; no fs/path fallback. | **PARTIAL** — all except `runtime_start` (D4.e-6). | Per-slice route rewrites (§0); `runtime_start` still carries paths. |
| **A3** | Shared adapter contract test per intent (embedded + standalone). | **DONE** | `tests/runtime/outbound-frame-adapter-contract.ts` run by `.embedded.test.ts` + `.standalone.test.ts`: `workspace_provision`, `agent_workspace_index`, `agent_workspace_read`, `agent_l2_seed`, `agent_files_purge` round-trip + positive-typed + foreign-code negatives. |
| **A4** | Parity e2e per op through a real daemon, both rigs. | **DONE** | `tests/e2e/parity/outbound-parity-contract.ts` Phases D (provision/index), E (read), F (l2 seed), G (purge), run by `embedded-parity.test.ts` + `standalone-parity.test.ts`. |
| **A5** | Seeded content (notes/MEMORY/CONSENSUS) byte-identical to pre-D4.e. | **DONE** | Daemon is the canonical writer; bytes pinned by `packages/host/tests/workspace-registry/handlers.test.ts` (CONSENSUS default + L2 notes set) and `agent-materialize/handler.test.ts` (L1 template). |
| **A6** | `GET /api/agents/:id/workspace` works in standalone (disable removed); `list_workspaces.agent_dir` correct in both modes. | **DONE** | D4.e-2 removed the standalone disable; D4.e-1 daemon-stamps `agent_dir`. |
| **A7** | M1-closure gate: G6 landed, `runtime_start` carries no paths. | **NOT YET** | Pending D4.e-6. M1 closure must NOT be claimed before it lands. |

---

## 2. Invariants

- **I1 — Daemon is the sole host-local path authority.** Backend forwards
  `requested_path` verbatim (workspace-create user input, backfill of legacy
  rows) and caches the daemon's authoritative `bound_workspace_path` back into
  the transitional `workspace_path` column; it never interprets, stats, or
  derives a host path itself. ✔ for D4.e-1…-4 ops; `runtime_start` is the
  remaining exception (D4.e-6).
- **I4 — Ownership on the daemon.** Materialize/seed/purge/read/index all run
  against the daemon's own registry; the backend supplies semantic ids.
- **I5 — Deployment-invariant.** Identical intents/envelope embedded &
  standalone; no mode branch in routes. ✔ (e.g. D4.e-2 removed the last
  standalone-only disable).
- **I6 — `packages/backend/src` holds no agent-host path resolution.**
  **fs-op half CLOSED** in D4.e-5 (guard below); the
  `workspace_path`-derived-path-emission half closes in D4.e-6. Until then I6
  is not fully true.

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

**What the guard does NOT cover (by construction):** the path-EMISSION half of
A1. `runtime-start-options.ts` builds a `workspace_path`-derived agent-home
path STRING (it imports `node:path`, not `fs`) and emits it in `runtime_start`
options — invisible to an fs-import guard. That residue is the explicit subject
of D4.e-6.

---

## 5. `workspace_path` column (transitional)

Locked decision (design §6.1): **do not drop the column in D4.e.** The daemon
registry is the authority. The column survives only as an embedded
legacy/display-compat cache and:
- is never read by formal path resolution or any agent-facing DTO (D4.e-2…-4
  all dispatch semantic ids; the delete-impact DTO's host-path fields were
  removed in D4.e-4);
- is still read in exactly two **allowed** ways: forwarded as `requested_path`
  to `workspace_provision` (create + backfill), and refreshed from the daemon's
  `bound_workspace_path` ack. Full column removal is a tracked follow-up,
  not D4.e scope.

`runtime-start-options.ts` reading it remains the one path-derivation use,
closed by D4.e-6.

---

## 6. M1 closure — explicitly NOT claimed

Per design §9 round-2 decision 5: progress/acceptance must not claim M1 closure
before `runtime_start` carries no paths. **D4.e-6 has not landed.** A7 is open;
A1/A2/I6 are partial. This document closes D4.e-1…-5 only.

---

## 7. Gates at D4.e-5 tip

- `pnpm -r typecheck` — clean (all 6 workspace projects).
- backend full suite — 1451 pass | 1 skip (118 files).
- host byte-parity (`workspace-registry/handlers`, `agent-materialize/handler`)
  — 62 pass.
- A3 adapter contract (both transports) + A4 parity (both rigs) green for all
  five D4.e intents.

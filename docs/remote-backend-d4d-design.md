# D4.d — `agent_materialize` intent flow (design pass)

**Status**: draft (Q1 + Q6 resolved 2026-05-28; pending Cindy final
LGTM, then slicing). Base = D4.c tip `1498ccb` on
`feature/remote-backend-v1-stage-d4-c-g3`. Worktree
`/Users/shiki/workspace/silverhand-wt-d4-d`.

**Companion documents** (must read together):

- `docs/remote-backend-d4-design.md` — D4 umbrella spec (§5.3 ACL,
  §12.8 runbook). D4.d **extends** §3.3 protocol surface (one new
  intent arm) and adds a new subsection to §12.8 (lifecycle runbook
  for `agent_materialize`).
- `docs/d4-c-g3-acceptance.md` — G3 acceptance closure. D4.d
  inherits all G3 perimeters; nothing here weakens them.
- `docs/orchestration-boundary-v1.md` — D2.0 guiding principle
  (server holds authoritative data, daemon-host owns local fs).
  D4.d is the direct realization of "create-agent is a wire intent,
  not a server-side `mkdir`".

**Scope (one sentence)**: replace the current
backend-direct-fs-write `POST /api/agents` path with a wire-intent
flow — desktop → server (ACL + placement + reserve row) → outbound
WS → daemon (materialize L1) → ack → server (flip row active) — so
that creating an agent works identically under embedded and
standalone deployment and survives the eventual cloud-host scenario
without code branching.

---

## §0. Conventions and out-of-scope (read first)

### Conventions

- `commit:<sha>` = first 7 chars of a commit on
  `feature/remote-backend-v1-stage-d4-d-*` branches.
- `intent` = an outbound WS frame `kind` in
  `OutboundServerCommandKind`. `agent_materialize` is the new arm.
- `materialization_status` (new column) = lifecycle state of the
  agent row at the row level. Different concept from
  `conversation_agents.status` (per-conversation runtime state).
  These are not unified; see §4.
- `Idempotency-Key` = client-supplied HTTP header that survives
  retries. Different concept from outbound `command_id` (wire frame
  correlation). See §3.2.

### Hard out of scope (Cindy R0 #5)

These are NOT in D4.d. Each lives in a downstream stage:

1. **Workspace materialization over wire**. Workspace POST/PATCH
   still writes the workspace dir directly on embedded; standalone
   already 403s with `workspace_path_not_supported` (D4.c C3).
   Wire-based workspace creation → **D4.e** or later.
2. **Agent L2 view / proxy** (read or edit `MEMORY.md` / `notes/` /
   `CONSENSUS.md` from a non-host machine). The materialize flow
   ships L1 only. L2 is daemon-local working storage per D2.0 Rev 4
   §6.2. L2 proxy → **D4.e**.
3. **Agent profile updates over wire** (rename / edit
   `system_prompt.md` / change `description`). Today these are
   in-process operations; lifting them to wire intents is a
   separate design pass (likely D4.f or later).
4. **L1 hot-edit / live re-seed**. After materialization, L1 dir
   ownership is the daemon's. D4.d does not specify how L1 content
   is later updated; this is intentional and aligned with D2.0
   Rev 4 (daemon-host self-hydration).
5. **Bidirectional agent state sync** (server reading what's on
   daemon's L1). The materialize path is **write-only at creation
   time**; the server never reads L1 bytes back as part of D4.d.
6. **Non-home workspace L2 seeding (`seedAgentL2` at workspace
   join).** When an agent joins a non-home workspace (workspace
   POST or add-member), the existing route calls
   `seedAgentL2(workspace, agentId)` to drop the workspace-scoped
   `MEMORY.md` + `notes/`. Embedded mode works today (server
   writes the workspace dir directly); standalone returns
   `workspace_path_not_supported` (D4.c C3). **D4.d does not
   touch this call** — it lives on the workspace-join path, not
   on agent-create. (Round-2 code audit clarification: the
   create-agent route `createAgentWithHome` itself does NOT call
   `seedAgentL2`; the agent_home is bootstrapped by the wire
   intent's home bootstrap, see §8.1.) Lifting `seedAgentL2` to
   a wire intent is **D4.e** scope.

---

## §1. Hard invariants (locked before draft body)

These are the boundaries that the rest of the document must respect.
They were locked during Cindy round-0; any later wording that drifts
from them is a doc bug.

### I1 — Additive arm only, no protocol fork (R4)

`agent_materialize` is **one new arm** in the existing
`OutboundServerCommandKind` discriminated union. It reuses every
existing mechanism without modification:

- Same outbound WS connection (no new transport).
- Same `command_id` correlation (`HostWsServerController.sendCommand`).
- Same envelope shape (`type: 'command' | 'command_response'`,
  `id`, `kind`, `params` / `result | error`).
- Same auth (bearer host token on attach, no per-command auth).
- Same timeout / retry / reattach semantics (D4.b).
- Same daemon-side dispatch surface (`IntentDispatcher`).

There is **no second protocol path** — no HTTP endpoint
daemon-to-server, no new IPC channel, no embedded-only shortcut
that bypasses the wire intent. Embedded deployment runs the same
intent over a loopback transport adapter (per R4); the protocol
semantic is identical to standalone.

What this rules out:

- Embedded `POST /api/agents` calling `agentsService.createWithFs()`
  directly (today's code) while standalone takes a wire intent —
  that is a fork. After D4.d, **both** call the wire intent path.
- A separate "internal" admin route that materializes agents
  out-of-band.
- Stuffing materialization into an existing intent's `params`
  (overloading `runtime_start` to also create the agent dir).

### I2 — L1 fs truth lives on daemon-host (D2.0 Rev 4)

The materialize intent does **not** ship L1 file bytes over the
wire (see §3 schema choice = template seed, not byte transfer).
The server does not persist `system_prompt.md` text in the DB; it
does not write any file under `~/.silverhand/agents/<id>/`; it
does not stage L1 content in a buffer before sending.

L1 seeding is the daemon's job, using daemon-local templates. The
server only ships **metadata** (id, name, runtime, model?,
description?, template choice). This decision is locked in §3.3
("Schema option B locked; option A rejected").

### I3 — Row state machine is explicit and never lies about daemon state

The `agents` table grows a new column `materialization_status` with
three values: `pending_materialization` / `active` / `failed`.

- A row in `pending_materialization` is **never visible** through
  any read path that implies "the agent exists and is usable" — it
  is hidden from `canViewAgent` for the visible-active filter, and
  the list endpoint includes it only with an explicit
  `?include_pending=1` query (used by the management UI for retry
  / cleanup).
- A row in `failed` is also hidden from default reads (Q6.a
  resolved 2026-05-28 — see §7.3 and §14 Q6). It surfaces only
  through the explicit `?include_failed=1` query, **creator-
  scoped** — the ACL/creator filter runs first, then the flag
  decides whether to widen the already-filtered set with failed
  rows. The flag does NOT widen visibility across users.
- The transition `pending_materialization → active` happens **only
  on receipt of a `command_response` with `result.ok: true`** from
  the daemon. The server never sets a row to `active` based on a
  timer, a heartbeat, or a side channel.
- Failed rows are kept (not deleted) so the user can see why the
  attempt failed and explicitly clean up via
  `DELETE /api/agents/:id`.
- See §4 for the full state machine.

### I4 — Multi-host routing, idempotency, retry, and offline behavior are all contract-first (Cindy R0 #4 + #2)

No code lands before the following are explicit in this document:

- Which host receives the intent (D4.c
  `RuntimeHostPlacementResolver.resolveOwnedLocalForUser` — §6).
- What happens when the chosen host has no live attachment
  (immediate 503 `host_attach_pending`, no row reserved — §6.3
  L0/L1).
- How HTTP-level retry idempotency works
  (`Idempotency-Key` header, creator-scoped unique on the key — §3.2).
- How a `pending_materialization` row is reconciled if the server
  crashes between row insert and daemon ack (boot reconciliation —
  §5).
- What a user-visible failed row looks like, and the explicit
  cleanup affordance (§9).

### I5 — D4.d closes the **create** path only

Read, update, and delete of `agents` rows are out of scope.
`DELETE /api/agents/:id` is the only orthogonal exception: it is
specified here because a `failed` row needs an explicit cleanup
verb, and that verb has to specify whether it tears down any
partial daemon-side state (it doesn't — see §4.5).

---

## §2. What this stage delivers

D4.d delivers, end to end:

1. A new outbound WS intent arm: `agent_materialize` (request +
   response_success + response_error schemas, all additive to
   existing zod schemas).
2. A daemon-side handler that materializes a fresh
   `~/.silverhand/agents/<id>/` (L1) using daemon-local templates,
   returns `result.ok: true` on success.
3. A new column on `agents`: `materialization_status` (+
   `materialization_failed_code`, `materialization_failed_at`,
   `idempotency_key`). Migration is additive, backfills existing
   rows to `active`.
4. A rewritten `POST /api/agents` route that:
   - Resolves placement → reserves row → sends intent → waits → ack
     → flips status (all in one HTTP request lifecycle).
   - Treats `Idempotency-Key` as the user-retry primitive.
   - Returns typed errors mapping daemon ack failures and timeouts.
5. A `DELETE /api/agents/:id` route specialized for the
   failed-cleanup case (and reusable for general delete in future
   stages — but the visible contract here is "user-driven cleanup
   of a failed materialization").
6. A boot reconciler that runs on backend startup and reconciles
   any `pending_materialization` rows older than a configurable
   threshold to `failed` with a typed reason (the server died
   mid-flight).
7. Wire fixtures for the three new wire frames (request /
   response_success / response_error) extending the catalogue from
   #task:560.
8. Server-side test surface: route tests (idempotency / online /
   offline / ack ok / ack fail / timeout), placement reuse tests,
   integration test with a real daemon handler, e2e with the
   standalone harness (an analog of D4.b G2 — see §13).
9. Daemon-side test surface: dispatcher dispatches the new intent;
   handler materializes the dir; templates match
   new daemon agent-home bootstrap template (§8.1:
   `system_prompt.md` + `MEMORY.md` + `notes/` + `.materialized`
   sentinel). Daemon-side idempotent re-materialize semantics on
   the daemon side (see §4.6).
10. Acceptance documentation update: D4.c
    `agents-no-host-typed-fail.test.ts` standalone gate is lifted;
    `docs/d4-c-g3-acceptance.md` does not need updating (D4.d
    introduces a new lifecycle, not a new G3 ACL gate); a new
    standalone-flavored G2-style acceptance file is added.

What it does **not** deliver: items in §0 "out of scope".

---

## §3. Wire protocol additive (R4 acceptance gate)

### §3.1 New intent arm in `OutboundServerCommandKind`

```ts
// packages/host/src/outbound-protocol.ts (illustrative)

export const AgentMaterializeParamsSchema = z.object({
  agent_id: z.string().min(1),                    // server-allocated; base64url, not UUID
  agent_home_workspace_id: z.string().min(1),     // server-allocated; `wsah_<agentId>` (helper agentHomeWorkspaceId)
  name: z.string().min(1).max(64),
  runtime: RuntimeKindSchema,                     // 'claude' | 'codex' | ...
  model: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  template_choice: z.enum(['default', 'onboarding', 'minimal'])
                    .default('default'),
});

export const AgentMaterializeResultSchema = z.object({
  ok: z.literal(true),
  agent_dir: z.string(),                              // absolute path to the materialized agent home / L1, daemon-side
  agent_home_workspace_path: z.string(),              // MUST equal agent_dir (see §6.5)
  materialized_at: z.number().int().positive(),
});

export const AgentMaterializeErrorCodeSchema = z.enum([
  'fs_quota_exceeded',
  'fs_unavailable',
  'agent_dir_collision',           // foreign content at agent L1 dir (NOT idempotent re-call)
  'unsupported_template',
  'unsupported_runtime',           // daemon does not know this runtime
  'internal_error',                // catch-all
]);
```

Notes:

- `agent_id` is a base64url random string (12 bytes → 16 chars,
  per `packages/backend/src/repos/agent-repo.ts:16`
  `randomBytes(12).toString('base64url')`), not a UUID.
  `agent_home_workspace_id` follows the existing
  `agentHomeWorkspaceId(agentId)` helper pattern — current code
  produces `wsah_<agentId>`. Both schemas validate as
  `z.string().min(1)`; tighter regex validation is the route
  layer's job (Cindy round-2 P1 #5).
- `agent_home_workspace_path` MUST equal `agent_dir`. Per
  `docs/agent-system-prompt-memory.md` and CLAUDE.md §3, the DM
  workspace path **coincides with L1**: `agent_home` is the agent's
  own workspace, and its `workspace_path` is the agent's L1 dir.
  The materialize intent already creates that dir, so daemon
  returns the same string for both fields. See §6.5 for the model
  (Cindy round-2 P1 #1).
- **Daemon idempotency** (P1 #4 conflict resolved): same
  `agent_id` re-sent → daemon's handler runs §4.6's sentinel/
  template-match check. Match → `ok: true` idempotent (the row
  is in a consistent state from a prior successful materialize).
  Foreign content / dir exists with no sentinel → returns
  `agent_dir_collision` error (the dir is unexpectedly populated
  by some other process). The error code name uses `collision`
  (not `already_exists`) to make the foreign-content meaning
  explicit; idempotent re-call is **not** an error.
- The result deliberately does not include `system_prompt_bytes`,
  `memory_bytes`, or any L1 content; the server never inspects
  what the daemon wrote (I2).
- `materialized_at` is an opaque-to-server timestamp used only for
  audit; the row's `created_at` remains the server's authoritative
  time.

### §3.2 Two-layer idempotency (Cindy R0 #2)

There are **two distinct retry surfaces**, each with its own
idempotency primitive. Conflating them is a doc bug.

| Layer | Surface | Primitive | Scope |
|---|---|---|---|
| HTTP retry | `POST /api/agents` | `Idempotency-Key` header — client-supplied opaque retry key, 1..64 chars, `[A-Za-z0-9_-]`, server treats as opaque (UUIDv4/nanoid recommended but not required; §14 Q1 resolved 2026-05-28) | User-driven (browser retry, UI Retry button, network blip) |
| Wire frame correlation | Outbound WS `command` ↔ `command_response` | `command_id` (server-allocated per send) | Server-controlled; never user-visible |

**HTTP idempotency rule** (revised per Cindy R0 #1 + round-2 P1 #5):
the server requires an `Idempotency-Key` header (400 if absent). The
key is stored on the `agents` row under a **creator-scoped unique
index** (`UNIQUE (created_by_user_id, idempotency_key) WHERE
idempotency_key IS NOT NULL`). One key permanently binds to **one**
`(creator, agent_id, idempotency_key)` reservation per user — there
is no "same key, different agent_id" path for the same caller. Two
different users may legitimately pick the same opaque key without
either being able to observe the other (per-user scoping eliminates
the side-channel that a globally-unique key would create). All
lookup paths must filter by `WHERE created_by_user_id = ? AND
idempotency_key = ?` — never by key alone.

**Body-metadata mismatch invariant on ANY same-key repeat** (Cindy
round-1 P1 #3): before consulting the table below, the server
must compare the request body's metadata against the stored row's
metadata-snapshot. If they differ — for any field in `(name,
runtime, model, description, template_choice, host_id)` — the
server rejects with **400 `idempotency_metadata_mismatch`**,
regardless of the row's current `materialization_status`. This is
the broader idempotency contract: same `Idempotency-Key` always
implies same semantic request. Without this check, a client could
send the same key with a different body and inadvertently get a
200 echo of someone else's agent, or a 409 in_progress while
believing they're starting a different agent — both equate to
"same key, different semantic request" which is the exact failure
mode HTTP idempotency is supposed to prevent.

| Repeat call with same `Idempotency-Key` AND matching body, row is in… | Server response |
|---|---|
| `pending_materialization` (another request still in flight) | 409 `materialization_in_progress` |
| `active` (already done) | 200 echo of the existing agent payload (same `agent_id`) |
| `failed` | 409 `materialization_previously_failed` with `failed_code` in body; the row is **not** auto-retried. Client must explicitly opt in (see "Retry on failed" below). |
| (no existing row for this key) | New attempt. |

**Retry on a failed row** — two explicit affordances; never
implicit:

- **(a) Same-row retry**: `POST /api/agents` with the **same
  `Idempotency-Key`** plus query `?retry=true`. Server flips the
  existing row's `materialization_status` from `failed` →
  `pending_materialization` in a short tx, resends the wire intent
  with the same `agent_id` **and the same metadata that was
  persisted on the row at reserve time** (name / runtime / model /
  description / template_choice / host_id). The HTTP response is
  the new terminal state for that one row. Useful when the user
  is retrying after fixing the failure root cause (e.g., daemon
  was offline, now online).

  **Invariant** (Cindy R0 follow-up + P1 #3): `?retry=true`
  cannot change any of the row's metadata. The body-metadata
  mismatch check (above) fires first and identically — if the
  client body differs from the stored row, the server rejects
  with 400 `idempotency_metadata_mismatch` BEFORE entering the
  retry path. Allowing metadata change on retry would
  re-introduce the implicit-fork problem (same key, two
  different agents semantically) by another door. If the client
  wants different metadata, they take path (b).

- **(b) Fresh-key retry**: client supplies a **different**
  `Idempotency-Key`. This is a brand-new attempt with a new
  `agent_id`. The old failed row remains untouched (audit
  history). Useful when the user wants to start over and the old
  attempt is cosmetically not their target anymore.

**Invariant (immutable)**: one `Idempotency-Key` permanently binds
to one `(agent_id, metadata-snapshot)` reservation. The row's
metadata is set at the very first reserve and never mutated
afterwards. State transitions (`pending_materialization` ↔ `active`
↔ `failed`) are allowed; metadata mutation is not.

**Why retry must be explicit**: silently letting a failed row's
key be reused for a different `agent_id` would mean "same key,
two outcomes" — which violates the HTTP idempotency contract that
clients rely on for safe retry. By forcing an explicit choice
(same row vs new attempt), the contract stays "same key, same
reservation, possibly multiple transitions".

**Wire idempotency rule**: each `sendCommand` mints a fresh
`command_id`. Server never reuses a `command_id` across retries.
Daemon, on receiving the same `agent_id` twice (different
`command_id`), runs the idempotency check on its side (see §4.6).

Why this matters: if the server retried the wire frame using the
same `command_id` (it doesn't), the daemon would see a duplicate
correlation id and reject it with `transport_response_mismatch`.
HTTP retry uses the same `agent_id` (allocated once at row reserve
time) — that's how the daemon can still detect "I've already
materialized this".

### §3.3 Schema option B locked; option A explicitly rejected

Two options were considered for shipping L1 content:

**Option A** (rejected) — server reads form fields like
`initial_system_prompt`, ships them inside the wire frame, daemon
writes them to `system_prompt.md` verbatim.

**Option B** (locked) — server only sends metadata
(`template_choice`); daemon uses its **own local templates** to
seed L1.

Rationale:

1. The current `POST /api/agents` UI does not actually accept a
   user-typed `system_prompt`. `ensureAgentL1Dir` already writes a
   hardcoded template (`# Global role\n\n_To be shaped via DM._\n`).
   There is no real "user-supplied bytes" use case.
2. Not putting bytes on the wire makes leakage impossible by
   construction. Audit, error dump, observability — none of these
   can accidentally include `system_prompt` content because they
   never see it.
3. Templates evolve with the daemon, not the server. A
   newer-version daemon can ship a better default; the server does
   not need to track template versions.
4. Future "user-typed system prompt" (when it becomes a real
   product feature) is a separate design pass. It will need its own
   threat model around prompt-byte leakage and is exactly the kind
   of decision that should not be retrofitted into D4.d.

**Wire schema does not have a `system_prompt_bytes` field. Adding
one in a future stage requires a new design pass, not a backward-
compatible additive change.**

### §3.4 Error codes mapping (wire → HTTP)

The daemon may return a typed error. The server translates wire
error codes → HTTP status codes per this table:

| Daemon `error.code` | HTTP status | Body `code` | Server-side action |
|---|---|---|---|
| `fs_quota_exceeded` | 507 | `fs_quota_exceeded` | Flip row `failed` with this code |
| `fs_unavailable` | 502 | `fs_unavailable` | Flip row `failed`; runbook entry |
| `agent_dir_collision` | 409 | `agent_dir_collision` | Flip row `failed`; investigation needed |
| `unsupported_template` | 400 | `unsupported_template` | Flip row `failed`; server-side bug |
| `unsupported_runtime` | 400 | `unsupported_runtime` | Flip row `failed`; server-side bug |
| `internal_error` | 500 | `daemon_internal_error` | Flip row `failed` |
| **transport-level** | | | |
| `transport_timeout` | 504 | `materialize_timeout` | Flip row `failed` with code `materialize_timeout` |
| `transport_disconnected` | 503 | `host_attach_pending` | Flip row `failed`; user can retry |
| `transport_no_connection` | 503 | `host_attach_pending` | **Row was never reserved** (see §6.3 L0/L1) |
| **server-side L3a failures** | | | |
| `dependent_row_insert_failed` | 500 | `dependent_row_insert_failed` | Flip row `failed`; very rare (would mean a DB invariant broke) |

`host_attach_pending` is the same typed code surfaced by D4.b for
runtime intents — reusing it keeps the renderer error surface
coherent across stages.

---

## §4. Server-side state machine

### §4.1 `agents` table schema (additive migration)

New columns (migration **v33** — D4.c tip `1498ccb` is at schema
v32 (`conversation_inbox_delivery_in_flight`); D4.d's additive
migration is the next slot):

```sql
ALTER TABLE agents
  ADD COLUMN materialization_status TEXT NOT NULL DEFAULT 'active'
    CHECK (materialization_status IN ('pending_materialization',
                                       'active', 'failed'));
ALTER TABLE agents
  ADD COLUMN materialization_failed_code TEXT;
ALTER TABLE agents
  ADD COLUMN materialization_failed_at INTEGER;
ALTER TABLE agents
  ADD COLUMN idempotency_key TEXT;

-- (created_by_user_id, idempotency_key) unique, scoped by creator.
-- Cindy round-2 P1 #5: a globally-unique index would let two distinct
-- users colliding on the same key see each other's existence (a side
-- channel: "your key is taken" leaks "someone else's row exists with
-- that key"). Per-user scoping eliminates this leak AND preserves the
-- standard HTTP idempotency contract within each caller. Lookup paths
-- in §3.2 / §6.3 must filter by `WHERE created_by_user_id = ?` AND
-- `idempotency_key = ?` together — never by key alone.
CREATE UNIQUE INDEX idx_agents_idempotency_key_per_user
  ON agents (created_by_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

**Backfill**: existing rows (D4.c tip and earlier) were written
through the legacy backend-direct-fs path, which means the L1 dir
already exists. They default to `materialization_status = 'active'`
with `idempotency_key = NULL`.

**Read-path filter** (Q6.a resolved 2026-05-28; see §7.3 / §14
Q6): all "agent visibility" code paths must filter to
`materialization_status = 'active'` by default. The existing
`canViewAgent` helper gains an internal filter; explicit opt-ins
pass `includeStatuses: ['pending_materialization', 'failed']` (or
either alone). **The ACL/creator filter runs first, then the
status widener applies** — `?include_pending=1` /
`?include_failed=1` widen what the **already-ACL-scoped** caller
sees of their **own** rows; they never widen visibility across
users. The boot reconciler, the management UI's pending-and-
failed view, and the failed-row cleanup DELETE all use this
status widener after the ACL filter has applied.

### §4.2 State diagram

```
HTTP POST /api/agents
   ↓ (1) body-metadata mismatch check (§3.2): if same Idempotency-Key
        with stored row + different body → 400 idempotency_metadata_mismatch
   ↓ (2) idempotency dispatch (Idempotency-Key, body matches stored)
        → row in active   → 200 echo
        → row in pending  → 409 materialization_in_progress
        → row in failed   → 409 materialization_previously_failed
                              (client must opt in to retry per §3.2)
        → no row          → continue to (3)
   ↓ (3) ACL + placement (D4.c resolveOwnedLocalForUser)
   ↓ (4) daemon online check (HostWsServerController.connectedConnectionId)
        → offline → 503 host_attach_pending (NO row reserved)
   ↓ (5) short tx: reserve agents row {
            materialization_status: 'pending_materialization',
            idempotency_key, agent_id, agent_home_workspace_id,
            ...metadata-snapshot
        }
   ↓ (6) sendCommand('agent_materialize',
            { agent_id, agent_home_workspace_id, runtime, model,
              template_choice, name, description })
        with timeoutMs
   ├── ok        → L3a single tx: flip materialization_status='active'
   │              + INSERT agent_home workspace + DM + memberships
   │              + onboarding message (§6.3)
   │              → tx commit → L4 deliver + DM runtime auto-start
   │              (both modes; §6.3 L4)
   │              → HTTP 201 with full agent + dependent surface
   ├── err typed → atomic flip materialization_status='failed' + failed_code
   │              → HTTP 502/503/409 typed per §3.4
   └── timeout   → atomic flip materialization_status='failed'
                    + failed_code='materialize_timeout'
                  → HTTP 504
```

### §4.3 Transitions are atomic-per-step (not one big tx)

Reserve row (L1) is one tx. Flip on ack (L3a / L3b) is a second
tx. These are NOT held inside a single transaction across the
wire round-trip (that would hold a write lock for the entire
daemon ack window — unacceptable for SQLite).

The contract: `pending_materialization → active|failed` always
happens in the same HTTP request lifecycle as the row reserve.
If the server process dies between L1 and L3, the boot reconciler
(§5) eventually flips the orphan to `failed` with code
`backend_crash_during_materialize`.

### §4.4 No background sweep beyond boot reconciliation

There is no periodic task that scans for stale
`pending_materialization` rows. The only reconciliation mechanism
is the boot-time pass (§5) plus the per-request flip. This is
intentional: it keeps the operational model simple and avoids
hidden state mutations.

### §4.5 `DELETE /api/agents/:id` semantics

The existing production `DELETE /api/agents/:id` route
(`routes.ts:3574-3644`) is a full destructive delete: stop
running runtime → remove memberships → sweep DM blobs → delete
agent row → rm L1 and L2 dirs. **D4.d preserves the existing
active-row semantics intact** (Cindy round-1 P1 #2 — must not
silently remove production destructive delete) and **adds a
branch for `failed` rows**:

```
DELETE /api/agents/:id
  - if row.materialization_status = 'active' → existing destructive
    flow (stop / memberships / DM blobs / delete row / rm L1/L2).
    Behavior unchanged from pre-D4.d.
  - if row.materialization_status = 'failed' → delete agents row
    only, return 204. Does NOT attempt to wire-call daemon, does
    NOT rm any fs (see §4.5.1 below for the reasoning).
  - if row.materialization_status = 'pending_materialization' →
    409 materialization_in_progress (cannot delete in-flight).
  - if row not found or not visible → 404.
```

**Known transitional debt** (out of D4.d scope, flagged for D4.e):
the existing active-row destructive flow's "rm L1/L2" step writes
to daemon-host fs (`<silverhandDir>/agents/<id>/` and the
agent_home workspace dir). In embedded mode this works today
because server owns the fs. In standalone mode, server cannot rm
daemon-host paths. The fully-final form would require a wire
intent `agent_demolish` (or similar). D4.d does NOT lift this:
standalone DELETE on an active row will leave orphaned daemon-side
dirs after deleting the DB row. This is the **only** remaining
mode-asymmetric server-direct fs path in the create/destroy
surface after the round-2 corrections (the create path itself is
mode-symmetric per §6.3). The runbook entry in
`docs/remote-backend-d4-design.md §12.8` (D4.d subsection) flags
the manual cleanup needed if a user creates agents in standalone
and later deletes them.

### §4.5.1 Why failed-row DELETE does not call daemon (Cindy round-2 P1 #4)

The `failed_code` on the row tells us how far the materialize
attempt got, which determines whether anything is on disk:

**Group A — failure happened before daemon write**: nothing on
disk to clean.

- `fs_quota_exceeded`, `fs_unavailable`,
  `unsupported_template`, `unsupported_runtime` — daemon
  rejected before write.
- `agent_dir_collision` — daemon refused to write; the dir that
  was there belongs to some other content (NOT this agent), so
  DELETE-side cleanup would be incorrect.
- `host_attach_pending` — wire intent never sent.
- `idempotency_metadata_mismatch` — rejected at preflight; no
  row reserved → no DELETE path.

**Group B — failure happened after daemon successfully wrote
L1** (Cindy round-2 P1 #4): the agent_dir IS on disk. These
codes occur on the server side AFTER ack ok:

- `dependent_row_insert_failed` — L3a tx rolled back AFTER
  daemon ack ok. L1 dir exists on daemon-host.
- `backend_crash_during_materialize` — boot reconciler can't
  distinguish "crashed before sending" from "crashed after ack
  ok / before L3a commit". Treat conservatively as **unknown fs
  state** (the dir MAY exist).

**Group C — unknown fs state**: daemon may or may not have
written.

- `daemon_internal_error`, `materialize_timeout` — daemon error
  / no ack received; cannot tell from outside whether the dir
  was written.

For groups B + C, the recovery posture is **not** manual `rm`.
The primary recovery is `?retry=true` (§3.2): the user resends
the original request with the same `Idempotency-Key`. The
server flips the failed row back to `pending_materialization`
and resends the wire intent with the same `agent_id` + metadata
snapshot. The daemon hits §4.6 case #4 (dir exists + sentinel
matches) and returns `ok: true` idempotently — the L3a tx then
fires cleanly and the agent becomes active. This works for both
"daemon wrote then we crashed" and "daemon-side internal_error
that nonetheless left the dir written".

Manual `rm -rf` of the agent_dir is the **last-resort** recovery
for the residual scenario where retry repeatedly fails for a
disk-on-host reason the operator can resolve (e.g., a corrupted
sentinel that needs manual investigation). The operator runbook
entry in `docs/remote-backend-d4-design.md §12.8` (D4.d
subsection) describes the steps; in the common case, retry is
sufficient.

A wire-issued "delete this agent dir" command (`agent_demolish`)
would itself be a new intent, which is out of D4.d scope. The
failed-row DELETE verb stays DB-only so D4.d does not expand the
wire protocol surface beyond `agent_materialize`. Operators
choosing to manually clean group B/C dirs after a permanent
giveup do so via host shell access, not via a Silverhand verb.

### §4.6 Daemon-side idempotency

Daemon receives `agent_materialize` with a server-allocated
`agent_id`. The daemon-side handler:

1. Computes the target dir path.
2. If the dir does not exist → seed templates, return ok.
3. If the dir exists and is empty → seed templates, return ok
   (server crash mid-tx scenario; the row was probably failed-
   reconciled and the user is retrying).
4. If the dir exists and contains files matching a template
   signature for `<runtime>` → return ok (idempotent re-call).
5. If the dir exists with foreign content (anything that doesn't
   match the template signature) → return
   `agent_dir_collision` error.

The template signature check is a single sentinel file (e.g., a
`.materialized` marker with the daemon's known version) written
atomically as the last step of seeding. This avoids brittle
"compare every file's bytes" logic.

---

## §5. Boot reconciliation

On backend startup, after migrations and before the HTTP listener
binds:

```ts
const RECONCILE_THRESHOLD_MS = 60_000; // 1 minute
const now = Date.now();

db.prepare(`
  UPDATE agents
     SET materialization_status = 'failed',
         materialization_failed_code = 'backend_crash_during_materialize',
         materialization_failed_at = ?
   WHERE materialization_status = 'pending_materialization'
     AND created_at < ?
`).run(now, now - RECONCILE_THRESHOLD_MS);
```

Threshold reasoning: any row that's been `pending_materialization`
for more than a minute is, by definition, orphaned — the per-
request flip happens inside one HTTP lifecycle and times out at
`commandTimeoutMs` (default 30s, §3.4). 60s is a comfortable
margin.

Rows fresher than the threshold are left alone — they might be
genuine in-flight requests on a sibling backend instance (note:
single-process write per CLAUDE.md, so this isn't actually a
concern today, but the threshold is the right guard if the
deployment model ever changes).

Boot reconciliation runs **synchronously** during bootstrap; it
must complete before the HTTP server listens. This is the same
discipline used by D1.d migration runner (`SILVERHAND_MIGRATE`
opt-in semantics, fail-loud on lock contention).

---

## §6. ACL, placement, host routing, and full request lifecycle

### §6.1 ACL preflight (Cindy round-2 P2 ordering)

`POST /api/agents` requires a logged-in user (session bearer).
The route runs these checks in **this exact order**, fail-loud
on any:

1. Auth: `requireRegisteredViewer` (existing).
2. `Idempotency-Key` header present + shape-valid (`1..64`
   chars, `[A-Za-z0-9_-]`, per §14 Q1 resolution). 400 if
   missing or malformed.
3. **Idempotency lookup** (§3.2): query
   `(created_by_user_id, idempotency_key)`. Find existing row or
   none. Lookup-only — no short-circuit yet.
4. **If row exists: body-metadata mismatch check first** (§3.2
   invariant). Compare the request body's metadata against the
   stored row's metadata snapshot
   `(name, runtime, model, description, template_choice, host_id)`.
   On any difference → return 400
   `idempotency_metadata_mismatch`. This MUST run before step 5
   so a same-key repeat with mismatched body never silently
   reuses someone else's row state (Cindy final-review P1
   `ZPJBJ8ANrJRpyQRq`).
5. **If row exists AND metadata matched in step 4**:
   short-circuit per the §3.2 dispatch table — active → 200
   echo, pending → 409 `materialization_in_progress`, failed →
   409 `materialization_previously_failed` (unless `?retry=true`,
   which enters the failed-retry path with the same row + same
   metadata).
6. **If no row exists**: continue to placement / name uniqueness
   / reserve.
7. `host_id` resolution: if user supplied `host_id`, validate
   `placement.assertOwnedActiveHost(host_id, currentUserId)`
   (existing D4.c). Otherwise call
   `placement.resolveOwnedLocalForUser(currentUserId)` (D4.c C1
   helper, 0/1/N pin: 0 → 409 `local_host_unbound`; ≥2 → 409
   `local_host_ambiguous`).
8. Name uniqueness within the creator's visible agent set
   (existing semantics — preserved by D4.d; only reached when
   step 3 found no matching idempotency row, so legitimate "same
   name new attempt" still 409s; same-key retry of a successful
   create short-circuits at step 5 with 200 echo before this
   step would have fired `agent_name_taken`).

**Invariant**: **lookup may run early; dispatch / short-circuit
must NOT run before metadata mismatch is ruled out**. This
matches §4.2's state diagram (mismatch first, dispatch second)
and preserves the §3.2 "same key → same semantic request"
contract.

### §6.2 Online check before reserve

After placement, before reserving the row:

```ts
const conn = ctx.hostWsController.connectedConnectionId(
  resolvedHostId,
  'agent_materialize',
);
// conn throws HostWsCommandTransportError if no live attachment
// → caught by the routes layer; mapped to 503 host_attach_pending
// per existing D4.b convention. No row reserved.
```

This is the same `connectedConnectionId` helper introduced in
D4.b round-1 P1-1 for A-class runtime trigger routes. Reusing it
keeps the offline behavior identical across stages.

### §6.3 Full request lifecycle (Cindy round-1 P1 #1 + round-2 refinement)

Today's `createAgentWithHome` (`packages/backend/src/routes.ts:
3114-3232`) does much more than insert one row. It also creates
the `agent_home` workspace, the DM channel, the
`conversation_agents` binding, the human membership, an
onboarding message, the L1 dir (which **IS** the agent_home
workspace_path — see §6.5), then delivers the onboarding message
and starts the DM runtime. After D4.d, the **wire intent
materializes the agent's home (L1 / agent_home workspace
contents)**, and the rest of the dependent rows must still come
into existence — otherwise a user sees an agent without its DM,
search, or open-Finder affordances.

D4.d's contract: **DB surface for the full agent + dependent
rows is created in the same HTTP request lifecycle, regardless
of deployment mode. All fs side effects beyond the wire intent's
own materialization are also identical across modes** — because
the only fs surface needed (the L1/agent_home dir + its DM
MEMORY/notes) is exactly what the daemon materializes.

The route runs in six phases. **No phase is mode-gated**: round-1's
embedded-vs-standalone split (L4/L5) was based on a model error
that treated `agent_home.workspace_path` as a separate workspace
path. Once that is corrected to "agent_home.workspace_path = L1
dir" (§6.5), the standalone path has every fs prerequisite for
deliver + runtime auto-start, and there is no asymmetry to gate.

| # | Phase | What runs |
|---|---|---|
| L0 | Preflight | §6.1 ACL + §6.2 online check + idempotency lookup → mismatch check → dispatch (§3.2). Note: idempotency dispatch fires **before** name-uniqueness check (Cindy round-2 P2) so an `active` retry hits 200 echo instead of `agent_name_taken`; mismatch check fires **before** dispatch (Cindy final-review P1) so same-key + different body always 400s instead of silently returning the stored row. |
| L1 | Reserve tx | INSERT into `agents` with `materialization_status = 'pending_materialization'`, `idempotency_key`, allocated `agent_id` + metadata snapshot. **No dependent rows yet.** |
| L2 | Wire intent | `sendCommand('agent_materialize', { agent_id, agent_home_workspace_id, runtime, model, template_choice, name, description })`; await response or timeout. Daemon materializes the **agent home bootstrap** at L1 — see §8.1 for what's seeded. |
| L3a | Flip + dependent rows tx | On ack ok: single DB tx — (a) UPDATE `agents` set `materialization_status = 'active'`; (b) INSERT `agent_home` workspace row with `workspace_path = ack.agent_dir` (the materialized L1 dir; see §6.5); (c) INSERT DM `conversations` row (`kind='dm_channel'`); (d) INSERT `conversation_agents` binding; (e) INSERT `workspace_users` + `conversation_users` for the human creator; (f) INSERT onboarding message into `messages`. |
| L3b | Flip-failed tx | On ack typed err / timeout: single tx — UPDATE `agents` set `materialization_status = 'failed'` + `materialization_failed_code` + `materialization_failed_at`. **No dependent rows are created.** |
| L4 | Onboarding deliver + DM runtime auto-start | `runtimeHost.deliverMessage(dm_channel, agent_id, onboarding_msg_id)` + `runtimeHost.start(dm_channel, agent_id)`. **Runs in both embedded and standalone modes** (Cindy round-2 P1 #3): because the agent's cwd is the materialized L1 dir, all runtime prerequisites are present. Embedded and standalone behavior is identical at the API surface. |

**Crucial invariants** the lifecycle respects:

- **No "half agent" state** (Cindy round-1 P1 #1 + round-2 P1 #3):
  the API response shape is identical across embedded and
  standalone. Both return a full payload with `agent`,
  `agent_home_workspace_id`, `dm_channel_id`, and
  `onboarding_message_id`. There is no flag like
  `pending_workspace_materialize`; standalone agents are fully
  visible / searchable / addressable / runnable.
- **No mode-gated fs side effect**: L4 deliver + auto-start run in
  both modes because the agent's home dir is exactly what the
  wire intent materialized. There is no separate "non-DM
  onboarding workspace" the route writes to (Cindy round-2 +
  code audit at `routes.ts:3180-3236`: `createAgentWithHome`
  does NOT call `seedAgentL2`; that function is reserved for
  workspace POST and workspace add-member paths, both outside
  D4.d's scope).
- **`agent_home.workspace_path` = materialized L1 dir** (Cindy
  round-2 P1 #1): see §6.5 for the model. The wire intent's ack
  returns `agent_dir`, and that string is written verbatim into
  the new `agent_home` row's `workspace_path`. Daemon ack happens
  AFTER materialization, so the dir is on disk when the server
  writes the row.
- **Atomic flip + dependents (L3a)**: the same DB tx that flips
  `agents.materialization_status = 'active'` also inserts all
  dependent rows. If any insert fails, the whole tx rolls back
  and the route falls through to L3b (flip failed with code
  `dependent_row_insert_failed`). This means a row in `active`
  status **always** has its full dependency graph; the API
  response can rely on this without separate existence checks.
  L4 fires **only after L3a tx commit**; process death between
  ack ok and L3a commit still leaves a `pending_materialization`
  row that boot reconciliation (§5) later flips to `failed`
  (this is now a known "fs already materialized" case — see
  §4.5.1 for the recovery posture). Process death between L3a
  tx commit and L4 leaves a complete DB surface with the
  onboarding message persisted but undelivered to runtime; the
  next user interaction with the DM channel triggers
  `runtimeHost.start` anyway, so it's recoverable without
  operator action. No "active half-agent" can exist (Cindy
  round-1 detail).

### §6.4 Why dependent rows come AFTER the wire ack (not at L1 reserve)

Two reasons:

1. **No row points at a failed agent.** Reserve-time creation
   would mean dependent rows briefly point at a
   `pending_materialization` agent. Every read path
   (`canViewAgent`, search, list, mention) would have to gate on
   the upstream's materialization status — an invariant we'd
   prefer not to add. Post-ack creation skips this entirely.
2. **Failure rollback is simpler.** If L2 wire intent fails, L3b
   just flips one row to `failed`. No dependent rows to roll
   back, no cascade deletes, no orphan workspaces.

The cost is a slightly longer tx in L3a (multi-row insert), but
all dependent inserts are local INSERTs on a single connection;
the duration is comparable to today's `createAgentWithHome` tx.

### §6.5 `host_id`, `agent_home`, and workspace_path provenance (Cindy round-2 P1 #1)

`agent_home` is the workspace the agent owns 1:1. Its
`workspace_host_id` is the same as the agent's `host_id` (the
existing `assertWorkspaceAgentsMatchHost` invariant holds
trivially because the agent IS the only member).

**`agent_home.workspace_path` IS the agent's L1 dir.** Per
`docs/agent-system-prompt-memory.md` and CLAUDE.md §3, the DM
workspace path coincides with L1: an agent's home workspace is
not a separate location — it's the same directory the agent's
identity (`system_prompt.md`) lives in. The directory serves
double duty: as the L1 identity store and as the L2 storage of
the DM workspace (so `MEMORY.md` + `notes/` live at the same
root).

Consequences for the wire intent:

- The wire intent's `agent_home_workspace_id` (a server-allocated
  id of the form `wsah_<agentId>` per the existing
  `agentHomeWorkspaceId` helper) is the **DB id** of the
  agent_home workspace row that L3a will INSERT.
- The wire intent's ack carries `agent_dir` (absolute path on
  daemon-host where the daemon materialized the agent's home /
  L1) AND `agent_home_workspace_path`. **These two MUST be equal
  byte-for-byte** — they refer to the same on-disk directory.
  The daemon-side handler enforces this; the server cross-checks
  on ack (mismatch → flip row failed with
  `daemon_internal_error`).
- The server writes that string into the new `agent_home` row's
  `workspace_path` column. By the time L3a INSERTs the workspace
  row, the dir already exists (daemon materialized it before
  ack'ing). There is no period where the agent_home row points
  at a non-existent path.

The daemon computes the path deterministically — per existing
conventions, it lives under `<daemonSilverhandDir>/agents/
<agent_id>/`. Future daemon versions may change the scheme;
servers only see the result, never compute it themselves. This
isolates the server from daemon-host filesystem layout.

There is no "metadata-only" path here. Round-1's wording about
"daemon has NOT mkdir'd this workspace yet" was based on a
model error that treated `agent_home` as a separate workspace
from the agent's home dir; with the DM-path-coincides-with-L1
correction, the wire intent's single materialization IS the
agent_home dir materialization.

---

## §7. Renderer UI contract (sync→async semantics)

### §7.1 Today vs. tomorrow

Today (pre-D4.d): `POST /api/agents` is fully synchronous from
the renderer's POV. The renderer sends, gets 201 with the full
agent payload, and immediately uses it.

Tomorrow (post-D4.d): `POST /api/agents` is still synchronous
from the renderer's POV. The request blocks until the daemon acks
(or times out). Renderer behavior is largely unchanged — but the
range of typed errors broadens.

### §7.2 New error codes the renderer must handle

| HTTP | Body `code` | UI affordance |
|---|---|---|
| 503 | `host_attach_pending` | "Daemon not connected. Make sure the desktop app is running and try again." [Retry] button keeps the same `Idempotency-Key` |
| 504 | `materialize_timeout` | "Took too long to create the agent. Check logs or try again." [Retry] reuses key |
| 507 | `fs_quota_exceeded` | "Not enough disk space on the host machine." [Retry] reuses key (after user frees space) |
| 502 | `fs_unavailable` | "The host machine's storage is currently unavailable." [Retry] reuses key |
| 409 | `materialization_in_progress` | (transient) UI suppresses; another request already in flight with the same key |
| 409 | `agent_dir_collision` | "An agent directory already exists on the host. Choose a different name." (creation flow) |
| 409 | `local_host_unbound` / `local_host_ambiguous` | Existing D4.c text |

Cancel during in-flight materialization is **not** a D4.d feature.
The user-side cancel button (if any) only cancels the HTTP
request from the renderer; the server still completes the request
to a terminal state (active or failed). A user who closes the tab
mid-flight ends up with either an active agent or a failed row,
not a dangling pending row.

### §7.3 List endpoint visibility for non-active rows (Q6.a resolved 2026-05-28)

**`pending_materialization`**: never visible through normal read
paths. Locked by §I3.

**`failed`**: hidden from default list and from default
`GET /api/agents/:id`. Visible to the **creator only**, behind
the explicit query flag `?include_failed=1`. Equivalent for
single-row read: a creator can `GET /api/agents/:id` for their
own failed row only if they pass the same flag (or use the
management view's `GET /api/agents?include_failed=1`). The flag
is **never** a cross-user widener:

- ACL/creator filter (`canViewAgent` baseline) **runs first** and
  scopes the candidate row set to those the caller may see.
- `?include_failed=1` then unions failed rows into that
  already-scoped set. It cannot reveal another user's failed
  row, cannot reveal another user's active or pending row, and
  is not a search/enumeration surface.

UI affordance (creator-visible only):

- Management view ("Agents > Pending & Failed" subpage or
  equivalent) calls `GET /api/agents?include_failed=1&
  include_pending=1` and renders failed rows with a
  `materialization_status='failed'` badge + `failed_code` +
  `failed_at`. Inline actions: `Retry` (same row, sends `POST
  /api/agents` with the same `Idempotency-Key` + `?retry=true`)
  and `Delete` (calls `DELETE /api/agents/:id` failed branch =
  204 row-only delete per §4.5).
- Default `GET /api/agents` (no flag) renders only active rows
  — failed rows do not show up in normal navigation, sidebar
  badges, search results, or @-mentions.

Rationale (recorded for traceability with §14 Q6 resolution):
keeps failed clutter out of the everyday product surface while
preserving audit history; avoids §4.4 violation that Q6.c would
have required (no background sweep); does not require the new
notification surface that Q6.d would have introduced.

---

## §8. L1 vs L2 boundary — `agent_materialize` = agent home bootstrap (Cindy round-2 P1 #2)

### §8.1 What gets materialized: the agent's home (L1 + DM L2 root)

Per `docs/agent-system-prompt-memory.md`'s four-file model, an
agent has L1 files (identity, shared across every workspace) and
L2 files (workspace memory, per-workspace). For an agent's **own
home / DM workspace**, the L1 path and the L2 path **coincide**
on disk (CLAUDE.md §3): the agent's L1 dir IS the DM workspace's
storage. The `agent_materialize` wire intent therefore is not
"L1 identity-only" — it is the **agent home bootstrap**, and the
daemon seeds every file the agent needs to operate in its DM
from the moment the runtime first starts.

Daemon writes, at `agent_dir` (== `agent_home_workspace_path`,
per §6.5):

- `system_prompt.md` — identity (L1 truth; template per
  `template_choice`).
- `MEMORY.md` — DM workspace's memory index (L2 truth, but at
  the L1 path because of DM coincidence). Empty / template
  bootstrap.
- `notes/` — DM workspace's notes dir (L2 truth, at L1 path).
  Created empty.
- `.materialized` — sentinel (see §4.6).

Daemon does NOT write at `agent_dir`:

- `CONSENSUS.md` — that's a workspace-scoped file, and per
  `ConversationManager.buildPromptContext` is **skipped for DM
  / agent_home workspaces** (only one member, no need for shared
  rules). It is also NOT written for any other workspace by
  this intent; it lives at `<workspace>/.silverhand/CONSENSUS.md`
  and is created lazily by the workspace itself.

The framing is "agent home bootstrap", not "L1 identity-only":
the daemon's job is to produce a directory the runtime can cd
into and immediately operate with the agent's identity + DM
memory surface intact.

### §8.2 What is NOT in this intent (L2 for non-home workspaces)

`MEMORY.md` + `notes/` for **non-DM workspaces** (when an agent
joins a regular shared workspace) are written by the existing
`seedAgentL2` helper at the join-workspace path
(`POST /api/workspaces/:id/agents`, etc.), NOT by
`agent_materialize`. D4.d does not move, rewrite, or reimplement
`seedAgentL2`; the join-workspace path continues to call it
(embedded only; standalone returns `workspace_path_not_supported`
per D4.c C3 until D4.e proxies the workspace).

`CONSENSUS.md` is workspace-scoped and is not in scope for
`agent_materialize` (the DM workspace skips it; other workspaces
manage it themselves).

`system_prompt.md` for an agent already exists for its lifetime
(post-D4.d). Editing it lives outside D4.d (see §0 out-of-scope
#3).

### §8.3 Transitional debt: pre-D4.d `ensureAgentL1Dir` already does this

The current `packages/backend/src/workspace-files.ts:287` helper
`ensureAgentL1Dir` already writes `system_prompt.md` + `MEMORY.md`
+ `notes/` at L1 (= agent home), unconditionally, from inside the
backend process. D4.d's wire intent does the **same set of
files**, just from the daemon side rather than the backend. This
is what makes the cutover clean: there is no file the legacy
backend-direct path writes that the daemon-driven path does not
also write.

**D4.d does not migrate existing rows or their fs layout.** Agents
created before D4.d have their L1 dirs already populated. Agents
created after D4.d via the materialize intent get the same set
of files at the same path, written by the daemon. The cutover
is at the "who calls fs" boundary, not at "what's on disk".

A follow-up (not D4.d) eventually removes the
`ensureAgentL1Dir` call from the backend's hot path once all
agent creation flows through the wire intent. Until then, the
helper stays as a no-op safety net for any code path that still
references it.

### §8.4 Embedded-mode `seedAgentL2` is NOT called by D4.d's create path

`seedAgentL2` is reserved for **workspace join** flows (workspace
POST, workspace add-member). The `createAgentWithHome` route
(D4.d's create path) does NOT call `seedAgentL2` — code audit at
`packages/backend/src/routes.ts:3180-3236` confirms this. The
agent_home / DM workspace is handled entirely by the wire intent's
home-bootstrap (§8.1); no second `seedAgentL2` call is needed.

The seedAgentL2 call site for non-home workspaces remains
embedded-only until D4.e lifts it to a wire intent
(`workspace_member_seed` or similar). That deferral does not
affect D4.d's create path.

---

## §9. Observability and audit

### §9.1 Audit log

Every materialization attempt writes one audit entry, regardless
of outcome:

```json
{
  "kind": "agent_materialize_attempt",
  "agent_id": "<agent-id>",
  "user_id": "<creator>",
  "host_id": "<target>",
  "idempotency_key": "<opaque-idempotency-key>",
  "outcome": "active" | "failed",
  "failed_code": "<code>" | null,
  "duration_ms": 1234,
  "command_id": "<wire>",
  "ts": <epoch_ms>
}
```

The audit entry deliberately omits: `name`, `description`,
`runtime`, template content. Reasoning: minimize PII / content
leakage; the row itself carries that metadata if you need it.

### §9.2 Wire log

Outbound WS log already redacts payloads. The
`agent_materialize` frame adds nothing new to that surface
because the params carry no bytes (option B; §3.3).

`FORBIDDEN_LOG_KEYS` should be reviewed but is expected to need
no additions.

### §9.3 No new metric exposed

No new counter, gauge, or histogram. Stage T2 (observability) will
add metrics across the board; D4.d does not pre-empt that.

---

## §10. Test surface

### §10.1 Wire fixtures (`packages/host/tests/fixtures/wire/`)

Three new fixtures, all driven by the catalogue invariants from
#task:560:

- `request/agent_materialize` — NDJSON literal for the request
  frame.
- `response_success/agent_materialize` — NDJSON literal for ok
  ack.
- `response_error/agent_materialize_<each-code>` — one per error
  code in `AgentMaterializeErrorCodeSchema`.

The catalogue invariant test
(`packages/host/tests/wire-contract-fixtures.test.ts`) auto-fails
if `AgentMaterializeErrorCodeSchema.options` grows without a
matching fixture.

### §10.2 Daemon-side unit tests

- Dispatcher knows the new intent (negative test: removing it
  from `intentSchemas` fails the test).
- Handler seeds templates correctly (file-content snapshot).
- Handler idempotency (§4.6 cases #1-#5).
- Sentinel file format is stable across handler versions.

### §10.3 Backend unit / route tests

- Route accepts/rejects `Idempotency-Key` per §3.2 + §14 Q1
  (missing header 400; malformed shape — too long / wrong
  charset — 400; same-key body mismatch 400
  `idempotency_metadata_mismatch`).
- Online check fires before reserve (online → reserve;
  offline → 503, no row).
- Placement reuse (cross-host attempt 403; local unbound 409;
  local ambiguous 409).
- Reserve row writes `pending_materialization`; not visible to
  default `canViewAgent`.
- Ack ok runs L3a tx (active flip + agent_home + DM + memberships
  + onboarding message) atomically; row + dependents visible
  afterward.
- L3a tx rollback on simulated dependent INSERT failure → flips
  failed with `dependent_row_insert_failed` (low-probability path
  but pinned for tx atomicity).
- Embedded vs standalone parity at API surface: same shape,
  identical agent + agent_home_workspace_id + dm_channel_id +
  onboarding_message_id; **all lifecycle phases (L0-L4) run
  identically in both modes** (post-round-2 lock).
- Ack typed error flips failed with correct code; failed row is
  hidden from default `GET /api/agents` and from default
  `GET /api/agents/:id`; visible only to creator behind
  `?include_failed=1` (Q6.a). Cross-user `?include_failed=1`
  attempt does **not** widen to another user's failed rows —
  ACL filter runs first (Cindy round-3 Q6 lock note).
- Timeout flips failed with `materialize_timeout`.
- DELETE on active → existing destructive flow (preserved
  unchanged); on failed → 204; on pending → 409.

### §10.4 Boot reconciler test

- Seeded `pending_materialization` row older than threshold →
  reconciled to `failed` with code
  `backend_crash_during_materialize`.
- Seeded `pending_materialization` row newer than threshold →
  left alone.
- Reconciler runs before HTTP server listens (sequencing test).

### §10.5 Integration test (real daemon handler)

Two suites, mirroring the D4.b approach:

- **Embedded analog**: backend with embedded host client; full
  HTTP → handler → fs assertion. Uses the existing test fixture
  daemon if possible; otherwise a minimal handler stub that
  exercises the real seeding code.
- **Standalone G2-style e2e**: backend + real daemon process via
  the existing `bootG2Harness`; full HTTP → outbound WS → daemon
  → ack → flip; fs assertion on daemon's silverhand dir.

### §10.6 Standalone lift of D4.c C4 gate

`tests/routes/agents-no-host-typed-fail.test.ts` (D4.c C4) pins
the 409 `host_runtime_disabled` for standalone. D4.d lifts this:

- The test is **rewritten**, not deleted. It now asserts the
  standalone happy path (daemon online → materialize) and the
  standalone offline path (daemon offline → 503
  `host_attach_pending`).
- The 409 `host_runtime_disabled` code is no longer used for
  agent creation. It remains for B-class CRUD operations not yet
  lifted.

---

## §11. Acceptance gates (no new G letter)

D4.d does not introduce a new G gate. The existing G acceptance
matrix is:

- G1 — embedded protocol parity (D4.a, closed)
- G2 — standalone backend e2e (D4.b, closed)
- G3 — security & multi-host acceptance (D4.c, closed
  `1498ccb`)

D4.d's acceptance is captured as a separate document
`docs/d4-d-acceptance.md` (analog of `docs/d4-c-g3-acceptance.md`):

- L1 materialization correctness (file presence, perms, template
  bytes)
- Two-layer idempotency (HTTP key + wire correlation)
- State machine completeness (every §6.3 lifecycle phase
  L0/L1/L2/L3a/L3b/L4 pinned, including atomic L3a tx
  rollback path)
- Boot reconciliation
- Embedded vs standalone parity at API + behavior surface (same
  HTTP request → same DB outcome → same runtime auto-start; only
  the daemon's host filesystem differs by host-local path prefix)
- DELETE semantics
- Failed-row visibility (Q6.a): default-hidden in list + get;
  `?include_failed=1` creator-scoped visibility; cross-user
  flag attempt blocked by ACL precedence
- Out-of-scope explicit (§0)

---

## §12. Migration / schema impact

- **DB migration v33** (D4.c tip `1498ccb` is at v32; D4.d is the
  next slot): additive columns + creator-scoped unique index on
  `(created_by_user_id, idempotency_key)` (`WHERE idempotency_key
  IS NOT NULL`). No data-shape changes. Backfill
  `materialization_status = 'active'` for existing rows.
- **No protocol breaking changes**. Old daemons that don't know
  `agent_materialize` would return `unknown_intent` — but the
  whole point of D4.d is that daemon and backend ship together
  per V1 (embedded packaging) and per M2 (cloud deploy will pin
  versions). No mid-flight backward compat concern.
- **No wire envelope breaking changes**. Same `OutboundFrame`
  type, one more arm.

---

## §13. Slicing plan (preliminary, subject to review)

Targeting 6 commits, each independently reviewable, mirroring D4.c
v2 slicing style. **This is preliminary** — Cindy review may
collapse, split, or reorder.

- **D1** (additive schema + types): migration v33, new zod schemas
  (`AgentMaterializeParamsSchema` etc.), `OutboundServerCommandKind`
  arm. No behavior change yet (`POST /api/agents` still uses
  legacy path).
- **D2** (daemon handler): dispatcher slot, handler
  implementation, template seeding moved into `packages/host`
  (or `packages/host-templates`), `.materialized` sentinel,
  idempotency rule §4.6. Unit tests.
- **D3** (server-side route rewrite): new `POST /api/agents`
  implementing the full §6.3 lifecycle (preflight → reserve →
  wire → L3a tx → L4 deliver + auto-start),
  `Idempotency-Key` enforcement, creator-scoped unique index
  lookups. Route tests. Standalone gate
  (`agents-no-host-typed-fail.test.ts`) updated to the new
  happy/sad path (standalone reaches L3a tx + L4 just like
  embedded; only `host_attach_pending` 503 if daemon offline).
- **D4** (boot reconciler): startup pass, threshold logic,
  sequencing before HTTP listen. Unit + integration tests.
- **D5** (DELETE failed branch + Q6.a list/get filter):
  `DELETE /api/agents/:id` gains the `failed` → 204 row-only
  delete branch and the `pending_materialization` → 409 guard.
  Active-row destructive flow is **unchanged** (Cindy round-1
  P1 #2). Route tests for the two new DELETE branches; existing
  active-flow tests left as is. Q6.a list/get filter (now
  resolved) ships in the same commit: default list/get hides
  failed; `?include_failed=1` is creator-scoped (ACL filter
  before status widener; Cindy Q6 lock); failed rows expose
  `materialization_status` + `failed_code` + `failed_at` in the
  payload for the management view. Cross-user
  `?include_failed=1` negative test pins ACL precedence.
- **D6** (e2e + acceptance doc): standalone G2-style e2e using
  `bootG2Harness`; `docs/d4-d-acceptance.md` analog of G3
  acceptance; runbook §12.8 update in the umbrella design doc.

Each commit's PR description must include the standard line:

> this IPC is local supervisor/control, not server↔daemon formal
> semantics

… in commits D2 and D3 specifically (where the wire path is
extended); the others are server-internal or test-only and the
line is optional but harmless.

---

## §14. Open questions (for round-1 review)

These are deliberately left open so that Cindy round-0 can
collapse or expand them. Nothing in the rest of the document
hinges on the answer.

- **Q1 — `Idempotency-Key` shape (resolved 2026-05-28 by shiki +
  Cindy)**: client-supplied opaque string, `1..64` chars,
  character set `[A-Za-z0-9_-]`. Server treats as opaque (no
  parsing / format interpretation). UUIDv4 / nanoid recommended
  but not required. Uniqueness scoped per creator
  (`(created_by_user_id, idempotency_key)`, see §3.2 / §4.1
  index). Rationale: matches silverhand's existing ID style
  (also base64url random opaque, e.g. `agent_id`), matches
  industry idempotency-token convention (Stripe, AWS S3), does
  not constrain client ID systems unnecessarily.
- **Q2** — should the template seeding move to `packages/host` or
  a brand-new `packages/host-templates`? Tradeoff: same package
  is simpler; separate package makes "no backend access to
  template bytes" structural. My recommendation: same package
  (`packages/host`) with a clear file boundary; a tripwire test
  asserts `packages/backend` does not import from the templates
  subdir.
- **Q3** — should the `.materialized` sentinel carry just a
  version string, or also a template-choice + runtime triple?
  Tradeoff: more data is more diagnostic; less data is harder to
  drift. My recommendation: `{ version: number,
  template_choice: string, runtime: string, materialized_at:
  number }`. Daemon validates `version` on idempotent re-call.
- **Q4** — boot reconciler threshold (60s default): configurable
  via env? My recommendation: yes, `SILVERHAND_MATERIALIZE_
  RECONCILE_THRESHOLD_MS`, default 60_000, hidden from user-
  facing docs (operator runbook only).
- **Q5** — should the new HTTP error codes be added to the
  central error-code enum in `docs/auth-and-host-model.md`? My
  recommendation: yes, but as a D6 doc commit; the codes
  themselves land in D3.
- **Q6 — `failed` row visibility (resolved 2026-05-28 by shiki +
  Cindy)**: candidate Q6.a — **hide entirely from default
  `GET /api/agents` and `GET /api/agents/:id`; expose only via
  the explicit `?include_failed=1` query, creator-scoped, with
  inline `Retry` + `Delete` affordance in the management view.**
  ACL/creator filter runs **before** the status widener (Cindy
  Q6 lock note `gMpODJXMetG39cKq`): `?include_failed=1` cannot
  reveal another user's failed rows, is not a search /
  enumeration surface. Implementation lands in slicing commit
  D5 alongside the failed-branch DELETE (see §13). Rationale:
  keeps the everyday product surface clean (vs Q6.b); preserves
  audit history (vs Q6.c which would auto-prune); does not
  require a background sweep that would violate §4.4 (vs Q6.c);
  does not require a new notification surface design (vs Q6.d).
  See §7.3 for the locked behavior.

  *Considered but rejected:*
  - Q6.b — failed inline in default list with badge + DELETE:
    daemon hiccups would surface to non-operator users.
  - Q6.c — auto-prune after N days: requires periodic
    background sweep, conflicts with §4.4 invariant.
  - Q6.d — failed-as-notification with Archive: novel surface,
    requires its own design pass, not warranted in D4.d.

---

## §15. Review log

### Round 0 — pre-draft prep (2026-05-28)

- Cindy `S60itcYyubK4-T6j`: 4 reviewer hard boundaries (additive
  arm / L1 truth / state machine / contract-first). Folded into
  §1 (I1, I2, I3, I4).
- Cindy `HWoUOfu98QgwpaCf`: 5 round-0 prep points (status enum
  separation / wire-vs-HTTP idempotency / option B lock / no
  pending half-products / scope fence). Folded into §1 (I3
  explicit column, I4 partial-unique index), §3 (option B
  rejection, two-layer idempotency table), §4 (state diagram + no
  background sweep), §5 (boot reconcile), §0 out of scope.
- Alice ack: preferred model adopted as §4 state diagram.

### Round 0.5 — draft mid-review corrections (2026-05-28)

Cindy `TQJxQHNnkq_BTkHj` + `YlkmTAZ6_ky9-Hzb`: three tightenings
applied directly to the in-progress draft before round-1.

- **Idempotency-Key semantics tightened (Cindy `TQJxQHNnkq...`)**:
  the original partial-unique-index approach allowed "same key,
  different agent_id" on failed retry, which violates the standard
  HTTP idempotency contract ("same key, same response"). Rewrote
  §3.2 and §4.1: full unique index on `idempotency_key`; one key
  permanently binds to one `(agent_id, metadata-snapshot)`
  reservation; retry on failed requires explicit `?retry=true`
  (same row) or a fresh key (new attempt). §4 state diagram
  updated. **(Superseded by round-2 P1 #5)** — the unique
  index is now creator-scoped (`(created_by_user_id,
  idempotency_key)`) to prevent the cross-user existence side
  channel; the "same key, same response" contract still holds
  within each user.
- **Immutable metadata invariant on `?retry=true` (Cindy
  `YlkmTAZ6...`)**: same-row retry cannot change any metadata —
  if the client body differs from the stored row, server rejects
  with 400 `retry_metadata_mismatch`. Otherwise retry would be an
  implicit fork (two agents semantically under one key). §3.2 now
  bakes this as an invariant.

  **(Final names, post-round-1)**: the error code was renamed
  `retry_metadata_mismatch → idempotency_metadata_mismatch` in
  round-1 P1 #3 (the check fires on every same-key dispatch, not
  just `?retry=true`), and the index `partial unique on
  idempotency_key WHERE NOT NULL` from round-0.5 became
  `UNIQUE (created_by_user_id, idempotency_key) WHERE NOT NULL`
  in round-2 P1 #5. Both historical names appear above for
  traceability of the discussion; the §3.2 / §4.1 / §12 sections
  use the final names.
- **`failed` row visibility unpinned (Cindy `TQJxQHNnkq...`)**: the
  original §7.3 baked a product/UX decision (default-hidden +
  `?include_failed=1` query). That is a product call, not a
  technical lock; moved to §14 Q6 with four candidate behaviors
  (a/b/c/d) and recommended decision-owner shiki.
- **L1 templates narrowed to identity-only (Cindy `TQJxQHNnkq...`
  + `YlkmTAZ6...`)**: per `docs/agent-system-prompt-memory.md`'s
  four-file model, L1 = identity. Daemon-side materialize seeds
  `system_prompt.md` + `.materialized` sentinel only. `MEMORY.md`
  / `notes/` / `CONSENSUS.md` stay at L2 via `seedAgentL2`
  (unchanged). The fact that today's `ensureAgentL1Dir` writes
  L2-style content at L1 is **transitional debt** flagged as a
  separate follow-up; D4.d does NOT migrate existing rows or
  advertise this as a product change. §8 rewritten.
  **(Superseded by round-2 P1 #2)** — because DM L2 root
  coincides with L1, the daemon DOES seed `MEMORY.md` + `notes/`
  at the agent_dir; round-2 reframed the intent as "agent home
  bootstrap" rather than "L1 identity-only".

### Round 1 — dependent-row contract + integrity fixes (2026-05-28)

Cindy `2-HS3Nr1AY8ieGXc` + `h6hCS0oIteVLqnjA` + `YW9WbDbgS-gEJfeU`:
five P1 blockers + four P2 cleanup items. All applied directly to
the draft.

- **P1 #1 dependent-row state machine (full request lifecycle)**.
  The original draft only spoke about the agents row; the
  existing `createAgentWithHome` (`routes.ts:3114-3232`) also
  creates `agent_home` workspace, DM channel,
  `conversation_agents`, human membership, onboarding message,
  L1 dir, L2 seed, runtime auto-start. Round-1 redirected
  through two iterations:
  - Alice initial proposal: split standalone path so dependent
    rows defer to D4.e, response carries
    `pending_workspace_materialize` flag.
  - Cindy rejection: that creates a "half agent" state worse
    than the workspace materialize debt; every later read /
    delete / search / UX would have to gate on the flag.
  - Final lock: ack ok runs single tx that flips active **AND**
    inserts all dependent DB rows; API response shape is
    identical across embedded and standalone (full agent +
    agent_home_workspace_id + dm_channel_id +
    onboarding_message_id); only L4 (`seedAgentL2`) and L5
    (DM runtime auto-start) fs side effects are skipped in
    standalone, with explicit deferral to D4.e. NO
    `pending_workspace_materialize` flag. `agent_home.
    workspace_path` is daemon-side path metadata returned by
    the daemon ack as `agent_home_workspace_path`; server never
    mkdirs it. Field name suffix `_workspace_path` deliberately
    chosen to signal "metadata only, not materialized" (Cindy
    detail).
  - §6 rewritten as "ACL, placement, host routing, and full
    request lifecycle". Five-phase table L0/L1/L2/L3a/L3b/L4/L5
    spells out which mode runs what.
  - **(Superseded by round-2 P1 #1 + #3 + L4 drop)** —
    round-2 corrected the agent_home model
    (`workspace_path` IS the L1 dir), dropped L4 (the
    `seedAgentL2` phantom), and lifted L5 (now renamed L4) to
    run in both modes. The "embedded-only fs side effect"
    split is gone; mode parity is full at every lifecycle
    phase except the active-row destructive DELETE (§4.5).
- **P1 #2 DELETE active-row destructive flow preserved (Cindy
  `2-HS3Nr1AY8ieGXc`)**. Original draft returned 405 for
  `DELETE` on active rows, silently removing the existing
  production destructive delete (`routes.ts:3574-3644`). §4.5
  rewritten: active-row DELETE flow unchanged; D4.d only adds
  the `failed → 204 row-only delete` branch and the `pending →
  409` guard. The standalone "rm L1/L2" portion of the active
  destructive flow is flagged as known transitional debt (same
  class as L4/L5), to be lifted by a future `agent_demolish`
  intent (D4.e or later).
- **P1 #3 idempotency body-metadata mismatch invariant applies
  to ALL same-key repeats (Cindy `2-HS3Nr1AY8ieGXc`)**. Original
  draft only enforced the metadata-immutability check on
  `?retry=true`. §3.2 rewritten: the check fires before any
  same-key dispatch (active / pending / failed / no-row), so a
  same key with a different body never hits the
  state-transition table. Error code renamed
  `retry_metadata_mismatch → idempotency_metadata_mismatch` to
  reflect the broader applicability.
- **P1 #4 daemon idempotency wording resolved (Cindy
  `2-HS3Nr1AY8ieGXc`)**. §3.1 and §4.6 disagreed: §3.1 said
  same `agent_id` re-sent returns `agent_dir_already_exists`;
  §4.6 said sentinel/template match returns ok. Resolved per
  Cindy's recommendation: sentinel-match is idempotent `ok:
  true`; the error code (renamed `agent_dir_collision`) only
  fires for foreign content collision. §3.1 wording rewritten;
  §4.6 unchanged.
- **P1 #5 migration version + unique-index wording aligned with
  real HEAD (Cindy `2-HS3Nr1AY8ieGXc`)**. D4.c tip `1498ccb` is
  at schema v32, not v31. All migration references updated to
  v33. `partial unique index` wording (residual from round-0.5
  carry-over in §I4 / §12 / §13) replaced with `full unique on
  idempotency_key WHERE NOT NULL`. **(Superseded by round-2
  P1 #5)** — "full unique on idempotency_key" further
  narrowed to "creator-scoped unique on (created_by_user_id,
  idempotency_key)".
- **P2 cleanups**: §10.3 + §13 list-filter test/commit phrasing
  loosened to "depends on §14 Q6"; §2 #9 changed
  `ensureAgentL1Dir current content` → `new daemon L1 identity
  template`; §4.2 typo `command_id active → 200 echo` corrected
  to `idempotency row active`; D5 slicing commit reworded to
  add `failed → 204` branch only (active flow preserved);
  list-filter changes split out to a possible D5b commit
  contingent on Q6 resolution.
- **Cindy round-1 follow-up details (msg `YW9WbDbgS-gEJfeU`)**:
  (1) field name `agent_home_dir` → `agent_home_workspace_path`
  to make "metadata only, not materialized" unmistakable;
  (2) explicit wording that the L3a tx covering active flip +
  all dependent INSERTs must commit before L4/L5 fs side
  effects fire, so process death between ack ok and L3a commit
  leaves a `pending_materialization` row reconcilable by §5,
  and process death between L3a commit and L4/L5 leaves a
  complete DB surface with no L2 seed (recoverable by reopening
  the DM channel). No "active half-agent" can exist. Both
  folded directly into §6.3 / §6.5. **(Superseded by round-2
  P1 #1)** — the "metadata only, not materialized" reading
  was itself a model error; the daemon IS the entity that
  materializes agent_dir == agent_home_workspace_path. Round-2
  rewrote §6.5 around the corrected model and removed all
  "_workspace_path suffix signals metadata-only" language.

### Round 2 — agent_home model correction + L4 drop + idempotency scoping (2026-05-28)

Cindy `PZkzghHhoaDIGpgJ` + `ss-k54wpPOqdPcDZ`: five P1 blockers
+ three P2 + L4 drop. All applied directly to the draft.

- **P1 #1 `agent_home.workspace_path` IS the L1 dir, not a
  separate workspace path** (supersedes round-1's
  "_workspace_path suffix signals metadata-only" wording).
  Per `docs/agent-system-prompt-memory.md` and CLAUDE.md §3,
  the DM workspace path coincides with L1 — `agent_home` is
  the agent's own workspace and its `workspace_path` is the
  agent's home dir. The wire intent's single materialization
  creates that one dir. §3.1 result schema, §6.5 provenance,
  and the "metadata only / has NOT mkdir'd" wording have all
  been rewritten. Result schema now requires
  `agent_home_workspace_path == agent_dir`.
- **P1 #2 daemon materialize = agent home bootstrap, not L1
  identity-only** (supersedes round-1's "system_prompt.md +
  .materialized only" narrowing). Because L1 = DM L2 root, the
  daemon must seed `system_prompt.md` + `MEMORY.md` + `notes/`
  + `.materialized` at the agent_dir so the DM runtime can
  start immediately. `CONSENSUS.md` is workspace-scoped, lazy,
  and skipped for DM/agent_home workspaces; not written by
  this intent. §8 rewritten end-to-end.
- **P1 #3 L4/L5 should run in both modes** (supersedes
  round-1's embedded-only split). Once §6.5 is corrected,
  standalone has every fs prerequisite for runtime auto-start
  (the agent's cwd IS the materialized dir). No mode gate;
  L4 + L5 collapsed into a single L4 (onboarding deliver + DM
  runtime auto-start) that fires in both modes. §6.3 table
  rewritten.
- **P1 #4 fs-state classification for post-ack failures**
  (refines round-1 §4.5.1's "nothing on disk" claim).
  `dependent_row_insert_failed` happens AFTER daemon ack ok →
  L1 IS on disk. `backend_crash_during_materialize` may also
  be post-materialize → unknown fs state. §4.5.1 rewritten
  with Group A (pre-write) / B (post-write known) / C (unknown)
  classification, and primary recovery shifted to `?retry=true`
  (daemon hits §4.6 sentinel-match idempotent ok); manual `rm`
  is last resort.
- **P1 #5 idempotency key scoped per creator** (supersedes
  round-1's "full unique on idempotency_key"). Globally-unique
  would let two users collide on the same opaque key and one
  could observe the other's existence (side channel). Index
  changed to `UNIQUE (created_by_user_id, idempotency_key)
  WHERE NOT NULL`; lookup must always scope by
  `created_by_user_id`. Also: `agent_id` / `agent_home_workspace_id`
  schemas were `z.string().uuid()` but the real ID shapes are
  base64url + `wsah_<agentId>` — both schemas changed to
  `z.string().min(1)` and a note added that the route layer
  uses the existing `agentHomeWorkspaceId(agentId)` helper.
- **P2 #1 §6.1 preflight ordering** (Cindy round-2 P2):
  enumerated explicitly — auth → key-present → idempotency
  dispatch → metadata-mismatch → placement → name-uniqueness.
  Idempotency dispatch MUST come before name-uniqueness so a
  retry of a successful create hits 200 echo, not
  `agent_name_taken`.
- **P2 #2 residual S1/S3 labels** replaced with L1/L3a/L3b
  in §4.3 (the §6.3 phase scheme is the only authoritative
  labelling).
- **P2 #3 review log supersession notes**: this round 2 entry
  itself.
- **L4 drop** (Cindy `ss-k54wpPOqdPcDZ` + code audit at
  `routes.ts:3180-3236`): round-1's L4 (post-active
  `seedAgentL2` for a "non-DM onboarding workspace if
  applicable") was a phantom phase — code audit confirms
  `createAgentWithHome` does NOT call `seedAgentL2`. The
  phase has been removed entirely; old L5 (onboarding
  deliver + DM auto-start) is renamed to L4 and now runs in
  both modes (P1 #3). The phase table is L0/L1/L2/L3a/L3b/L4
  only; all references to L5 are gone.

### Round 3 — P2 doc nits (2026-05-28)

Cindy `hZKKmWRAk9jJ2Hh_` round-3 verdict: **no P1**. Two P2 doc
nits + history grep-noise cleanup. Applied in commit `963726f`:

- §12 audit example placeholders `<uuid>` → `<agent-id>` /
  `<opaque-idempotency-key>` (Q1 was still pending).
- §3.2 idempotency table "client UUID" → "client opaque
  idempotency key; UUID-vs-opaque locked by §14 Q1" (later
  superseded by round-4 Q1 lock).
- §15 round-0.5 entry gained "(Final names, post-round-1)" note
  mapping `retry_metadata_mismatch` → `idempotency_metadata_
  mismatch` and "partial unique" → "creator-scoped unique".

### Round 4 — Q1 + Q6 product call resolution (2026-05-28)

shiki `R1hOjlB48t2J6ZuE` + `yjkdn5L5zZ0mmM6D` resolved both
remaining product calls. Applied in commits `88c6437` (Q1) and
this commit (Q6).

- **Q1 resolved — `Idempotency-Key` opaque**. Cindy
  `oZqN5tDjWLF6iVDW` provided concrete lock: `1..64` chars,
  charset `[A-Za-z0-9_-]`, server treats as opaque (UUIDv4 /
  nanoid recommended but not required). §3.2 table, §6.1
  preflight (now validates shape), §14 Q1 (resolved), §16
  anchor table, §10.3 test bullet all locked. Also fixed
  pre-existing typo §3.1 "16 bytes / 22 chars" → "12 bytes /
  16 chars" with file:line reference.
- **Q6 resolved — Q6.a, default-hide failed + creator-scoped
  `?include_failed=1`**. Cindy `gMpODJXMetG39cKq` added the
  critical ACL-first constraint: `?include_failed=1` cannot
  become a cross-user enumeration surface — ACL/creator filter
  runs **before** the status widener, so the flag can only
  widen what the caller already sees of their own rows. §I3
  + §4.1 read-path filter + §7.3 (full rewrite from "open" to
  "Q6.a resolved" with UI affordance description) + §10.3
  test bullet (cross-user negative pin) + §11 acceptance + §13
  D5 slicing (folded list-filter into D5) + §14 Q6 (full
  resolution recording with considered-but-rejected
  alternatives) + §16 anchor (`?include_failed=1`,
  `?include_pending=1`) all locked.

**Status after round 4**: all 5 P1 (round-2) + 3 P2 (round-2) +
2 P2 (round-3) + Q1 + Q6 are resolved. The design contract is
complete. Pending: Cindy final design LGTM → slicing impl pass
D1-D6.

### Round 5 — final-review P1 §6.1 ordering fix (2026-05-28)

Cindy `ZPJBJ8ANrJRpyQRq` (final design pass) caught one P1 doc
self-contradiction: §6.1 had idempotency dispatch (step 3)
short-circuit BEFORE body-metadata mismatch check (step 4),
which allowed an active row + mismatched body to silently
return 200 echo — violating the §3.2 invariant ("same key →
same semantic request"). §4.2 state diagram already had
mismatch first / dispatch second; only §6.1 needed alignment.

Fix (this commit):

- §6.1 expanded to 8 steps; staged correctly: lookup (3) →
  mismatch check (4, fires only if row exists) → dispatch (5,
  only if row exists AND metadata matched) → placement (7) →
  name uniqueness (8). New explicit invariant at the bottom:
  "lookup may run early; dispatch / short-circuit must NOT run
  before metadata mismatch is ruled out".
- §6.3 L0 table cell also updated to reflect the staged
  sequence ("idempotency lookup → mismatch check → dispatch").

Q1/Q6 落点、ACL-first filter、slicing/acceptance all consistent
per Cindy's verdict (`git diff --check eaa4c61..HEAD` clean).

### Round 6 — TBD

(Final design LGTM pending Cindy verification of the round-5
ordering fix.)

---

## §16. Anchor table for grep

When implementing, the following anchors are guaranteed-stable
phrases that the implementation will reference. Do not rename
them without updating both this document and the implementation:

| Anchor | Where |
|---|---|
| `agent_materialize` | wire intent kind (§3.1) |
| `materialization_status` | DB column (§4.1) |
| `materialization_failed_code` | DB column (§4.1) |
| `idempotency_key` | DB column + HTTP header (§3.2, §4.1) |
| `Idempotency-Key` | HTTP header — opaque 1..64 chars `[A-Za-z0-9_-]` (§14 Q1) (§3.2) |
| `pending_materialization` | column value (§4.1) |
| `materialization_in_progress` | error code (§3.2 / §4.5) |
| `materialization_previously_failed` | error code (§3.2) |
| `idempotency_metadata_mismatch` | error code (§3.2, all same-key paths) |
| `agent_home_workspace_id` | params field (§3.1) |
| `agent_home_workspace_path` | result field, MUST equal `agent_dir` (§3.1, §6.5) |
| `dependent_row_insert_failed` | error code (§3.4, §6.3 L3a rollback) |
| `host_attach_pending` | error code reused (§3.4) |
| `materialize_timeout` | error code new (§3.4) |
| `agent_dir_collision` | error code new (§3.1, §3.4) |
| `backend_crash_during_materialize` | error code new (§5) |
| `.materialized` | sentinel file (§4.6) |
| `RECONCILE_THRESHOLD_MS` | tunable (§5, §14 Q4) |
| `?retry=true` | same-row retry verb (§3.2) |
| `?include_failed=1` | creator-scoped failed-row visibility flag (§7.3, §14 Q6 resolved) |
| `?include_pending=1` | creator-scoped pending-row visibility flag for boot/management view (§4.1) |

---

**End of draft round 5 (§6.1 ordering fixed).** Ready for Cindy final design LGTM.

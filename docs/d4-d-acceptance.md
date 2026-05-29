# D4.d — `agent_materialize` intent acceptance closure

**Status**: D4.d closes the create-agent materialize wire flow.
D4.e (daemon-owned local data-plane proxy) and D5+ (R4 paydown
of the embedded loopback adapter) remain in the M1 path; this
document does NOT claim "D4 final form complete" — it scopes
itself to the D4.d slicing plan (`docs/remote-backend-d4d-design.md`
§13) and the §11 acceptance gate.

**Spec source**: `docs/remote-backend-d4d-design.md`. Each
acceptance row below cites the spec section first, then the
implementation commit(s) and test(s) that pin it.

**Conventions** (same as `docs/d4-c-g3-acceptance.md`):

- `commit:<sha>` = first 7 chars of a commit on
  `feature/remote-backend-v1-stage-d4-d-design`.
- `test:<path>::<describe>::<it>` = a specific test in this repo.
  Filepaths are relative to repo root.
- "Real path" = production code path end-to-end (real HTTP
  listener / real DB / real outbound WS / real daemon
  `IntentDispatcher`), not a fake/double of the gate under test.

**R4 anchoring** (`docs/remote-backend-d4-design.md` §9.3): the
`agent_materialize` intent **is** server↔daemon formal
semantics — the standard "this IPC is local supervisor/
control" carve-out does NOT apply to D1/D2/D3/D6-2 wire
commits. D4 (boot reconciler), D5 (DELETE + Q6.a visibility),
D6-1 (visibility widener), and D6-3 (this doc) are
server-internal and the carve-out applies trivially. The
per-commit R4 anchor lines are summarized in §8 below.

---

## 0. Slicing chain

D4.d landed in six slices on
`feature/remote-backend-v1-stage-d4-d-design`. The chain (newest
first; fixups grouped with their parent):

| Slice | Commit | Scope |
|---|---|---|
| D6-3 | `f559eac` | This acceptance doc. |
| D6-2 fixup | `d1e1763` | Narrow `testHooks` + real `materializeAgent` in e2e (Cindy `d4IID_Nnn1VShRa5` P1-1 + P1-2). |
| D6-2 | `253e350` | Real-wire `agent_materialize` e2e (this commit's evidence in §6; superseded API surface fixed in `d1e1763`). |
| D6-1 | `2dc3f6b` | `?include_pending=1` widener parity (this commit's evidence in §5). |
| D5-fixup2 | `0dd7450` | `permissions.ts` doc drift — delete-impact stays active-only (Cindy `lYctOahGX8f6Us8d` P2). |
| D5-fixup1 | `58ba65e` | Lift status filter into `canViewAgent` — close D5 round-1 P1/P2 (Cindy `vB9vzUo4y_vgSZf8` + `f0JxEM9nMhsVfLIo`). |
| D5 | `8869fc5` | Failed-row recovery surface — DELETE failed + `?include_failed=1` + `?retry=true`. |
| D4 | `2617d6c` | Boot-time materialization reconciler (mark-failed-only). |
| D3 | `c2a2016` | `POST /api/agents` materialization lifecycle + D3 invariant pins. |
| D2 | `501776a` | Daemon `agent_materialize` handler + dispatcher slot. |
| D1 | `4b8bff1` | Schema + `agent_materialize` wire arm. |
| Design | `68a1c04` | `docs/remote-backend-d4d-design.md`. |

Branch base is D4.c tip `1498ccb`.

---

## 1. Wire arm + schema (D1)

**Spec (§3.1 + §3.3 + §4.1)**: additive `agent_materialize` arm
in `OutboundServerCommandKind`; schema option B (single intent,
parameterized) locked; `agents` table additive columns
(`materialization_status`, `materialization_failed_code`,
`materialization_failed_at`, `idempotency_key`,
`created_by_user_id`) plus creator-scoped unique index on
`(created_by_user_id, idempotency_key)`.

| # | Acceptance | Evidence |
|---|---|---|
| W1 | New `agent_materialize` arm on `OutboundServerCommandKind` + zod params/result + wire-error schemas live in `packages/host/src/protocol.ts` (`AgentMaterializeParamsSchema` at line 1039, `AgentMaterializeResultSchema` at line 1072); `packages/host/src/outbound-protocol.ts` re-exports them as part of the host public surface; both reach the `@silverhand/host` barrel. | D1 `commit:4b8bff1`. `test:packages/host/tests/outbound-protocol.test.ts` (param/result/error round-trip). |
| W2 | Migration v33 applies cleanly on existing DBs; `materialization_status='active'` backfill for pre-existing rows; creator-scoped unique index `WHERE idempotency_key IS NOT NULL` (partial index — fresh-key creates can coexist with NULL legacy rows). | D1 `commit:4b8bff1`. `test:packages/backend/tests/db-migrations.test.ts::v33 adds agent materialization columns and creator-scoped idempotency_key index`. |
| W3 | Wire arm is additive only — no rename, no field removal, no envelope shape change (R4 invariant I1). | Verified by absence: no diff to `OutboundFrame` shape, only a new union arm. Tripwire `test:packages/host/tests/wire-contract-fixtures.test.ts` would fail if envelope fixtures drifted. |

---

## 2. Daemon handler (D2)

**Spec (§4.6 + §8.1)**: daemon-side `materializeAgent` is the
sole writer of `~/.silverhand/agents/<id>/`; writes templated
files atomically; writes `.materialized` sentinel; idempotency
rule §4.6 (sentinel match → reuse, sentinel mismatch → typed
`agent_dir_collision`, missing → fresh seed).

| # | Acceptance | Evidence |
|---|---|---|
| H1 | `IntentDispatcher` slot `agentMaterializeHandler` is wired and typed-error narrowing routes `AgentMaterializeError` → wire `error.code` instead of collapsing to `internal_error`. | D2 `commit:501776a`. `test:packages/host/tests/agent-materialize/dispatcher-integration.test.ts::IntentDispatcher.agent_materialize slot::preserves the typed AgentMaterializeError.code on the response frame`. |
| H2 | First-call materialize seeds full template tree (`system_prompt.md` + `MEMORY.md` + `notes/` + `.materialized` sentinel) atomically; sentinel content matches `{ version, template_choice, runtime, materialized_at }`. | D2 `commit:501776a`. `test:packages/host/tests/agent-materialize/handler.test.ts::materializeAgent — §4.6 decision tree::first-time materialize: missing dir → seed + sentinel + ok`. |
| H3 | Re-call with matching sentinel → reuse (no rewrite, returns same `agent_dir` / `agent_home_workspace_path`); re-call with mismatched sentinel → typed `agent_dir_collision`; re-call with foreign content (no sentinel) → typed `agent_dir_collision`; sentinel JSON corrupt → `agent_dir_collision` (fail-closed). | Same file: `idempotent re-call` + `foreign content in dir (no sentinel) → agent_dir_collision` + `sentinel JSON corrupt → agent_dir_collision (fail-closed)` + the `it.each(['agent_id', 'template_choice', 'runtime'])` mismatch matrix. |
| H4 | `host_templates`-style file boundary enforced — backend code may not import from `packages/host/src/daemon/agent-materialize/**`. Public `@silverhand/host` barrel re-exports the throwable `AgentMaterializeError` only (for the e2e fault-injector hook), NOT `materializeAgent` / `getAgentHomeTemplate` / template bytes. | D2 `commit:501776a` + tripwire `commit:8869fc5` + barrel re-export `commit:d1e1763` (D6-2 fixup). `test:packages/backend/tests/dependency-guard-agent-materialize.test.ts` (2/2 pass). Public-barrel allowance documented at `packages/host/src/index.ts:140-159`. |

---

## 3. Server route — full lifecycle (D3)

**Spec (§6.3)**: `POST /api/agents` runs the full L0 → L1 → L2 →
L3a → L3b → L4 chain. ACL preflight before any side effect (§6.1);
online check before reserve (§6.2); creator-scoped idempotency
dispatch (§3.2 two-layer); `host_id` + `agent_home` + workspace_path
provenance per §6.5.

| # | Phase | Acceptance | Evidence |
|---|---|---|---|
| L1.0 | L0 ACL | Unauthenticated → 401; authenticated but body invalid → 400; cross-host `host_id` → 403 `host_not_owned`. | D3 `commit:c2a2016`. `test:packages/backend/tests/routes/agents.test.ts::POST /api/agents` + `test:packages/backend/tests/routes/d4-d-structural-invariants.test.ts::Invariant 1: metadata mismatch precedence (§3.2 / §6.1)`. |
| L1.1 | L0.5 §3.2 dispatch (existing key) | Same key + body-mismatch → 400 `idempotency_metadata_mismatch`; same key + matching body + row `active` → 200 echo (no second dispatch); same key + matching body + row `pending_materialization` → 409 `materialization_in_progress`; same key + matching body + row `failed` (no `?retry=true`) → 409 `materialization_previously_failed` + `failed_code`. | `test:packages/backend/tests/routes/d4-d-structural-invariants.test.ts::Invariant 1` (mismatch precedence) + `Round-1 P1.3 — active idempotent echo shape == 201 fresh shape`. Pins Cindy D3 round-1 P1 status-aware dispatch. |
| L1.2 | L0.7 fresh attempt | No idempotency row → online check `controller.connectionIdForHost(hostId)`; if offline → 503 `host_attach_pending` (NO row reserved); if online → name uniqueness check + reserve `pending_materialization`. | `test:packages/backend/tests/routes/agents-no-host-typed-fail.test.ts::POST /api/agents — daemon offline (fail-fast, NO reserve)`. Pins Cindy D3 round-1 P1 §6.2 "no failed orphans on transient offline" invariant. |
| L1.3 | L1 reserve | INSERT-only path with creator-scoped unique idempotency_key; reservation race → 409 `agent_name_taken`. | `test:packages/backend/tests/routes/d4-d-structural-invariants.test.ts::Round-1 P1.2 — Idempotency-Key header required`. |
| L1.4 | L2 wire dispatch | `controller.sendCommand({ kind: 'agent_materialize', params, expectedConnectionId })`; reattach race during the (online-check → sendCommand) window → typed `host_attach_pending`-equivalent fail-fast via `expectedConnectionId` mismatch. | `test:packages/backend/tests/routes/agents-no-host-typed-fail.test.ts::host_attach_pending` describes (transport mapping); `expectedConnectionId` plumbing in `packages/backend/src/routes.ts:3931-3945`. |
| L1.5 | L3a atomic tx | On daemon ack ok: single tx inserts `agent_home` workspace + DM channel + onboarding system message + flips `materialization_status='active'`. Rollback on tx failure leaves row at `failed` with typed `code`. | `test:packages/backend/tests/routes/d4-d-structural-invariants.test.ts::Invariant 3: L3a tx atomicity (§6.3 L3a/L3b)`. |
| L1.6 | L3b sentinel post-commit | Row flips to `active`; `failed_code` / `failed_at` cleared on success path. | Same file, `Standalone happy path (D4.d D3 lift)` describe. |
| L1.7 | L4 post-commit best-effort | Onboarding deliver + auto-start fired as `.catch(err => logger.error(...))`; L4 failure does NOT roll back L3a commit (Cindy D3 round-1 P1.4 — L3a IS the success boundary). | Same file, `Round-1 P1.4 — L4 post-commit best-effort` describe. |

**`host_id` / `agent_home` / workspace_path provenance pin** (§6.5):

- `agent_home.id === agent.id` (same id, different table).
- `agent_home.workspace_host_id === agent.host_id`.
- `agent_home.workspace_path === agent.agent_dir` (daemon-side
  `materializeAgent` returns `agent_home_workspace_path` ≡
  `agent_dir`; backend writes both to the same column value).
- Verified by `test:packages/backend/tests/routes/d4-d-structural-invariants.test.ts::Invariant 3` + the `Standalone happy path (D4.d D3 lift)` describe (asserts `workspaces.workspace_path === agents.agent_dir` post-commit).

---

## 4. Boot reconciler (D4)

**Spec (§5)**: at boot, sweep `agents` rows whose
`materialization_status='pending_materialization'` AND
`created_at < now - threshold` (default 60s,
`SILVERHAND_MATERIALIZE_RECONCILE_THRESHOLD_MS` override). Mark
each as `failed` with code `backend_crash_during_materialize`.
Runs BEFORE HTTP listen. No daemon-side cleanup, no L1 dir
touch (per §4.4 + §4.5.1).

| # | Acceptance | Evidence |
|---|---|---|
| R1 | Stale `pending_materialization` rows (`now - created_at > threshold`) flip to `failed` with code `backend_crash_during_materialize`; fresh rows are left alone. (Pre-listen sequencing pinned by R5.) | D4 `commit:2617d6c`. `test:packages/backend/tests/runtime/materialize-reconciler.test.ts::D4.d §5 — markStaleMaterializationsFailed (repo primitive)::flips a pending row older than the threshold; leaves a fresher one alone`. |
| R2 | Fresh `pending_materialization` rows (`< threshold`) left untouched; the in-flight request still owns the row. | Same file, boundary test `row exactly at the cutoff boundary ... is NOT flipped (strict ´<´ semantics)`. |
| R3 | Reconciler is mark-failed-only — no daemon RPC, no L1 dir touch, no DELETE. §4.4 "no background sweep beyond boot reconciliation" honored. | Same file, `already-active rows are left untouched` + `already-failed rows are left untouched` + `idempotent: a second call ... is a no-op`. |
| R4 | Threshold override resolves env → integer → fallback 60_000ms; invalid env value falls back with a WARN line. | Same file, `D4.d §5 — resolveReconcileThresholdMs (env knob)` describe (7 cases: unset / empty / valid / non-integer / zero / negative / etc). |
| R5 | Reconciler runs synchronously before `app.listen()` so the management view never sees a stale `pending_materialization` row for the first ~60s. | Same file, `D4.d §5 — sequencing: runs before HTTP listener binds (real boot)::seeded stale pending row is ´failed´ by the time startBackend() resolves AND log order proves pre-listen sequencing`. |

---

## 5. Failed-row recovery + Q6.a / D6-1 visibility (D5 + D6-1)

**Spec (§4.5 + §7.3)**: three-action management model (Delete /
Retry / Inspect); failed rows hidden from default
`GET /api/agents` and `GET /api/agents/:id`; `?include_failed=1`
(D5) and `?include_pending=1` (D6-1) widen visibility, both
creator-scoped, both ACL-first. ACL filter runs **before**
status widener so neither flag can become a cross-user
enumeration surface (Cindy Q6 lock `gMpODJXMetG39cKq`).
PATCH/avatar/runtime/schedules/stop sub-routes default to
active-only — failed/pending rows are immutable except for
DELETE + retry (Cindy D5 round-1 P1 `vB9vzUo4y_vgSZf8`).

### 5.1 Three-action model

| # | Acceptance | Evidence |
|---|---|---|
| F1 | `DELETE /api/agents/:id` on a `failed` row → 204 row-only delete (no daemon RPC, no L1 dir touch). | D5 `commit:8869fc5`. `test:packages/backend/tests/routes/d5-failed-recovery.test.ts::DELETE /api/agents/:id materialization dispatch::failed → 204 row-only delete`. |
| F2 | `DELETE /api/agents/:id` on a `pending_materialization` row → 409 `materialization_in_progress` (preserves the in-flight request's claim). | Same file, `DELETE /api/agents/:id materialization dispatch::pending_materialization → 409 materialization_in_progress`. |
| F3 | `POST /api/agents?retry=true` on a `failed` row (same key + matching body + daemon attached) → `failed → pending_materialization → active` atomic flip; same `agent_id` reused; 201 on success. | Same file, `?retry=true same-row retry matrix::failed + matching metadata + daemon attached → 201 + row reaches active`. |
| F4 | `?retry=true` with NO matching idempotency_key row → 404 `retry_target_not_found` (explicit misuse, not silent fresh-create). | Same file, `?retry=true same-row retry matrix::no-row + retry=true → 404 retry_target_not_found (not silent fresh-create)`. |
| F5 | `?retry=true` on a non-`failed` existing row follows the §3.2 dispatch (NOT a single error code): `active` → 200 echo of the original 4-field payload; `pending_materialization` → 409 `materialization_in_progress`. `retry_target_not_failed` is **not** the general non-failed response — it is only the defensive 409 raised by `flipFailedToReserveAgain` when the row was `failed` at the dispatch entry but a concurrent mutation flipped it out from under us between the dispatch check and the atomic flip (route source `packages/backend/src/routes.ts:3807-3815`). | Same file, `?retry=true same-row retry matrix::active + retry=true → 200 echo (no-op for already-good rows)` + `pending + retry=true → 409 materialization_in_progress (same regardless of retry flag)`. |
| F6 | Retry online check runs BEFORE row flip — daemon offline at retry time → 503 `host_attach_pending`, row stays `failed` (Cindy D5 guard rail #2; no `failed → pending → failed` bounce). | Same file, `?retry=true same-row retry matrix::failed + daemon offline → 503 host_attach_pending, row STAYS failed (no failed → pending bounce)`. |
| F7 | Same-key retry preserves immutable metadata snapshot (§3.2): the failed row's stored `(name, runtime, description, model, host_id)` is the comparator on the retry request's body; mismatching body → 400 `idempotency_metadata_mismatch` FIRST, retry verb does NOT mutate. PATCH cannot mutate the snapshot (see F12 below). | Same file, `?retry=true same-row retry matrix::failed + mismatching metadata → 400 idempotency_metadata_mismatch FIRST (retry verb does NOT mutate)`. |

### 5.2 `canViewAgent` ACL-first status filter (D5-fixup1 + D5-fixup2)

| # | Acceptance | Evidence |
|---|---|---|
| F8 | `canViewAgent(ctx, principal, agentId, { includeStatuses? })` orders: row exists → principal ACL pass (system / agent-self / creator / workspace member) → status in `includeStatuses` (default `['active']`). ACL false short-circuits to false BEFORE the status check. | D5-fixup1 `commit:58ba65e`. `packages/backend/src/permissions.ts` `canViewAgent`. `test:packages/backend/tests/permissions.test.ts::canViewAgent`. |
| F9 | Default list (`GET /api/agents`) and single (`GET /api/agents/:id`) call `canViewAgent` with default `includeStatuses=['active']`. Failed AND pending rows return 404 by default. | D5 `commit:8869fc5` + fixup `58ba65e`. `test:packages/backend/tests/routes/d5-failed-recovery.test.ts::default read paths hide non-active rows` (2 pins: list + single GET both 404 for pending). |
| F10 | `?include_failed=1` widens to `['active','failed']`; `?include_pending=1` widens to `['active','pending_materialization']`; both flags compose to `['active','failed','pending_materialization']` (D6-1). Flags are independent dimensions. | D6-1 `commit:2dc3f6b`. `test:packages/backend/tests/routes/d5-failed-recovery.test.ts::?include_failed=1 widener semantics` (2 pins) + `::?include_pending=1 widener (D6)::list: ?include_failed=1&include_pending=1 widens to BOTH (management view)`. |
| F11 | Cross-user `?include_failed=1` / `?include_pending=1` still 404 — ACL-first ordering means pending/failed rows (which have no dependent workspaces, since L3a never ran) cannot match the workspace-membership ACL branch. Neither flag is a cross-user enumeration surface. | Same file, `::?include_pending=1 widener (D6)::list: ?include_pending=1 from user B does NOT widen to user A's pending rows` + `single: ?include_pending=1 cross-user → 404 (ACL-first creator-scoped)`. |
| F12 | PATCH still 404 for `pending_materialization` / `failed` rows even with `?include_*` flags — the widener is read-only; PATCH/avatar/workspace/runtime-state/schedules/stop sub-routes do NOT opt-in and stay at default active-only. Closes Cindy D5 round-1 P1 (PATCH could mutate failed-row metadata snapshot). | D5-fixup1 `commit:58ba65e`. `test:packages/backend/tests/routes/d5-failed-recovery.test.ts::PATCH /api/agents/:id: non-active rows are immutable (locks §3.2 snapshot invariant)` (2 pins: PATCH on failed + PATCH on pending) + `::?include_pending=1 widener (D6)::PATCH/avatar/etc still 404 for pending even with ?include_pending=1 (widener is read-only)`. |
| F13 | `DELETE /api/agents/:id` opts in to all three statuses via module-local `DELETE_INCLUDE_STATUSES = ['active','pending_materialization','failed']` so §3.2 status dispatch reaches 409/204; `GET /api/agents/:id/delete-impact` stays at default active-only (management rows have only Delete + Retry; impact computation is for active-row destructive flow only — Cindy `f0JxEM9nMhsVfLIo`). | D5-fixup1 `commit:58ba65e` + D5-fixup2 `commit:0dd7450` (doc drift fix). `packages/backend/src/routes.ts` DELETE handler + delete-impact handler. |

---

## 6. Real-wire e2e (D6-2)

**Spec (§10.5 + §11)**: standalone G2-style e2e using
`bootG2Harness` + `bootDaemonWithSupervisor`; drives
`POST /api/agents` from real HTTP listener through real
outbound WS to real in-process daemon running real
`IntentDispatcher.agentMaterializeHandler` slot. No
`FakeHostWs`, no `app.fetch(...)` shortcut, no hand-built
outbound frames.

| # | Phase | Acceptance | Evidence |
|---|---|---|---|
| E1 | Happy create | Fresh POST → daemon ack ok → row `active` + dependent rows (agent_home / DM / onboarding) in backend DB + daemon-side L1 dir written by **real `materializeAgent`** containing the real template (`system_prompt.md` + `MEMORY.md` + `notes/onboarding-guide.md` + `notes/onboarding-faq.md` + `notes/user-preferences.md` + `notes/project.md` + `notes/work-log.md`) and the real `.materialized` sentinel schema (`{ version, agent_id, template_choice, runtime, materialized_at }`). | D6-2 `commit:253e350` + fixup (Cindy `d4IID_Nnn1VShRa5`). `test:packages/backend/tests/e2e/standalone-d4-d6-materialize-wire.test.ts` phase 1 assertions. |
| E2 | Typed-failure injection (real wire) | Pre-handler fault hook returns `AgentMaterializeError('agent_dir_collision', ...)` once → dispatcher narrows typed → wire `error.code='agent_dir_collision'` → HTTP 409 → row `failed` / `materialization_failed_code='agent_dir_collision'`. Fault hook short-circuits BEFORE `materializeAgent` runs, so no L1 dir is written for the failed `agent_id`. | Same file, phase 2 first leg. Asserted by `existsSync(agentL1Dir(...)) === false` post-fail. |
| E3 | Same-row `?retry=true` over real wire | Fault hook is exhausted → real `materializeAgent` runs → row `failed → pending_materialization → active` over the SAME wire → 201 + same `agent_id` + L1 dir for the same `agent_id` appears with `.materialized` + `MEMORY.md` + `notes/onboarding-faq.md` (real template). Proves wire is reusable, not one-shot. | Same file, phase 2 second leg. |
| E4 | §3.2 echo over real wire | Same key + same body as phase 1 → 200 echo + 4-field payload identical to phase 1 + NO second daemon dispatch. Verified via on-disk dir count: three POSTs produce only two L1 dirs (happy + retry; echo short-circuits at the route layer before reaching the wire). | Same file, phase 3 + final assertion. |
| E5 | Wire-path realness — narrow test seam | `bootG2Harness` uses real `startBackend({ mode: 'standalone' })` (real `installHostWebSocketServer`, real `OutboundRuntimeEventFanout`); `bootDaemonWithSupervisor` uses real `runDaemon` (real `IntentDispatcher`, real `OutboundDaemonClient`). The dispatcher slot ALWAYS calls real `materializeAgent` — there is no embedder-facing handler-replacement option. The only test seam is `RunDaemonOptions.testHooks?` with two narrow knobs: `agentMaterializeHomeDir` (tmp dir override for `materializeAgent`'s `homeDir` param) and `agentMaterializeFaultInjector` (deterministic typed-error pre-hook). Production omits `testHooks` entirely. Cindy D2 pre-gate #3 holds; Cindy D6-2 P1-1 (`d4IID_Nnn1VShRa5`) narrowing satisfied. | `packages/host/src/daemon/run.ts:153-189` (`testHooks` field + production-fixed `materializeAgent` call). `packages/backend/tests/e2e/g2-harness.ts` `bootDaemonWithSupervisor` (passes `testHooks` through verbatim). |

---

## 7. Out of scope for D4.d (explicit)

These belong to subsequent M1 / M2 work and are NOT part of
D4.d closure:

- **D4.e**: daemon-owned local data-plane proxy.
  `system_prompt.md` / `MEMORY.md` / `notes/` / `CONSENSUS.md`
  reads + writes proxied through the owning daemon. No
  bidirectional sync; truth lives on the owning daemon.
- **D5 (R4 paydown)**: embedded loopback adapter carries the
  same outbound frame envelope as the standalone WSS.
- **Multi-host agent migration**: changing an agent's
  `host_id` post-create is out of v1 scope.
- **Background materialize sweep beyond boot**: §4.4 invariant.
  The boot reconciler is the only sweep; mid-process stale
  rows are observable until the next backend restart.
- **Renderer Inspect surface**: D5 ships the read-only
  visibility flags + management-view list payload (`failed_code`
  + `failed_at`). The renderer's Inspect modal / Retry button
  / Delete button wiring is a renderer commit, not D4.d
  backend scope.

---

## 8. R4 carveout per slice (anchor table)

Per `docs/remote-backend-d4-design.md` §9.3, every D4.d slice
PR description carries the R4 anchor line. The `agent_materialize`
intent IS formal server↔daemon semantics; the standard "local
supervisor/control" carve-out does NOT apply to the wire
commits.

| Slice | R4 status |
|---|---|
| D1 `4b8bff1` | Formal semantics. Wire arm + schema. Carve-out does NOT apply. |
| D2 `501776a` | Formal semantics. Daemon handler + dispatcher slot. Carve-out does NOT apply. |
| D3 `c2a2016` | Formal semantics. Server route lifecycle calls into the wire. Carve-out does NOT apply. |
| D4 `2617d6c` | Server-internal (boot reconciler, no wire). Carve-out applies trivially. |
| D5 `8869fc5` (+ fixups `58ba65e` / `0dd7450`) | Server-internal (DELETE branch + visibility). Carve-out applies trivially. |
| D6-1 `2dc3f6b` | Server-internal (visibility widener). Carve-out applies trivially. |
| D6-2 `253e350` (+ fixup `d1e1763`) | Formal semantics. E2E asserts the wire stays correct. The fixup narrows the test seam to `RunDaemonOptions.testHooks` so the formal-semantics boundary cannot be replaced by future embedders. Carve-out does NOT apply. |
| D6-3 `f559eac` | Server-internal (this doc). Carve-out applies trivially. |

---

## 9. Cindy guard rails honored

This section pins the round-1/round-2 review locks that shaped
D4.d's final form. Each row cites the message id and the
commit/test where the lock landed.

| Lock | Source | Landed at |
|---|---|---|
| §6.1 ACL preflight ordering (creator scope → host ownership → name uniqueness) BEFORE any reservation. | Cindy round-2 P2. | D3 `commit:c2a2016` + `test:packages/backend/tests/routes/d4-d-structural-invariants.test.ts::Invariant 1: metadata mismatch precedence (§3.2 / §6.1)`. |
| §6.2 online check BEFORE reserve — daemon offline never reserves a row. | Cindy round-1 P1. | D3 `commit:c2a2016` + `test:packages/backend/tests/routes/agents-no-host-typed-fail.test.ts::POST /api/agents — daemon offline (fail-fast, NO reserve)`. |
| §6.3 P1.4 L3a commit IS the success boundary — L4 deliver / auto-start are post-commit best-effort, failures only log. | Cindy round-1 P1.4. | D3 `commit:c2a2016` + `test:packages/backend/tests/routes/d4-d-structural-invariants.test.ts::Round-1 P1.4 — L4 post-commit best-effort`. |
| §4.5.1 failed-row DELETE does NOT call daemon — row-only delete; daemon's stale L1 dir is orphaned and reclaimed by sentinel-mismatch logic on next attempt with the same id (which cannot recur because `agent_id` is fresh per attempt). | Cindy round-2 P1 #4. | D5 `commit:8869fc5` + `test:packages/backend/tests/routes/d5-failed-recovery.test.ts::DELETE /api/agents/:id materialization dispatch::failed → 204 row-only delete`. |
| §3.2 same-key retry MUST return the same outcome it returned the first time without re-dispatching — `active` row → 200 echo, no second wire call. | Cindy D3 round-1 P1. | D3 `commit:c2a2016` + `test:packages/backend/tests/routes/d4-d-structural-invariants.test.ts::Round-1 P1.3 — active idempotent echo shape == 201 fresh shape`; e2e pin E4. |
| §3.2 metadata snapshot is immutable — failed-row's stored `(name, runtime, description, model, host_id)` is the comparator on retry; PATCH must NOT mutate it. | Cindy D5 round-1 P1 `vB9vzUo4y_vgSZf8`. | D5-fixup1 `commit:58ba65e`. PATCH defaults to `canViewAgent` active-only; failed rows 404 → no path to mutate. Pinned by `test:packages/backend/tests/routes/d5-failed-recovery.test.ts::PATCH /api/agents/:id: non-active rows are immutable (locks §3.2 snapshot invariant)::PATCH on a failed row returns 404 and does NOT mutate description/runtime/model`. |
| `canViewAgent` ACL-first ordering (row → principal ACL → if pass, then status) — not status-first. | Cindy D5 fixup `f0JxEM9nMhsVfLIo`. | D5-fixup1 `commit:58ba65e`. `packages/backend/src/permissions.ts` `canViewAgent`. `test:packages/backend/tests/permissions.test.ts::canViewAgent`. |
| Q6 ACL filter runs BEFORE status widener — `?include_failed=1` and `?include_pending=1` cannot reveal another user's rows. | Cindy Q6 lock `gMpODJXMetG39cKq`. | D5 `commit:8869fc5` + D6-1 `commit:2dc3f6b`. Pinned by `test:packages/backend/tests/routes/d5-failed-recovery.test.ts::?include_pending=1 widener (D6)::list: ?include_pending=1 from user B does NOT widen to user A's pending rows` + `single: ?include_pending=1 cross-user → 404 (ACL-first creator-scoped)`. |
| `delete-impact` stays at default active-only — management rows have only Delete + Retry; impact computation is for active-row destructive flow only. | Cindy `f0JxEM9nMhsVfLIo`. | D5-fixup1 `commit:58ba65e` + doc drift fix D5-fixup2 `commit:0dd7450`. |
| D5 guard rail #2 — retry online check runs BEFORE row flip; daemon offline at retry time leaves row `failed`, does NOT bounce `failed → pending → failed`. | Cindy D5 round-1. | D5 `commit:8869fc5` + `test:packages/backend/tests/routes/d5-failed-recovery.test.ts::?retry=true same-row retry matrix::failed + daemon offline → 503 host_attach_pending, row STAYS failed (no failed → pending bounce)`. |
| D5 guard rail #3 — no new protocol surface for retry. Fresh and retry both hit `d5RunMaterializeFromReserved`. | Cindy D5 round-1. | D5 `commit:8869fc5`. Shared helper in `packages/backend/src/routes.ts`. |
| E2E real-wire criterion — drive `POST /api/agents` through real WS + real daemon; the dispatcher slot must ALWAYS call real `materializeAgent`. Test seam is a narrow `testHooks` namespace on `RunDaemonOptions`, NOT an embedder-facing handler-replacement option. | Cindy `hkIP6tEkWJ2VcYfq` D6 review #1 + D6-2 P1-1 `d4IID_Nnn1VShRa5`. | D6-2 `commit:253e350` + fixup `commit:d1e1763`. Pin E5. |
| Public-barrel re-export discipline — `AgentMaterializeError` allowed (throwable class needed by the `agentMaterializeFaultInjector` test-hook return value); `materializeAgent` / `getAgentHomeTemplate` / template bytes NOT exported. Backend tests must construct the typed error via the public barrel, not the forbidden deep path. | Cindy `hkIP6tEkWJ2VcYfq` D6 review #3. | D6-2 fixup `commit:d1e1763`. `packages/host/src/index.ts:140-159` boundary comment. `test:packages/backend/tests/dependency-guard-agent-materialize.test.ts` (2/2 pass — backend deep-path import still tripwired). |

---

## 10. Test inventory (D4.d)

| Test file | Suite count | Scope |
|---|---|---|
| `packages/backend/tests/db-migrations.test.ts` (v33 row only) | 1 | Schema migration v33 + backfill + partial idempotency_key index. |
| `packages/backend/tests/dependency-guard-agent-materialize.test.ts` | 2 | Backend deep-path import tripwire + public-barrel allowance. |
| `packages/host/tests/agent-materialize/dispatcher-integration.test.ts` | 10 | Dispatcher slot wiring + typed-error narrowing + malformed-params rejection + missing-handler internal_error fallback. |
| `packages/host/tests/agent-materialize/handler.test.ts` | 18 | `materializeAgent` §4.6 decision tree (happy / idempotent / mismatch / corrupt sentinel / foreign content / unsupported template / EACCES / race window). |
| `packages/host/tests/outbound-protocol.test.ts` | (D1) | Wire param/result/error schema round-trips. |
| `packages/backend/tests/routes/agents.test.ts` (POST + GET/DELETE + GET :id + PATCH sections) | (D3) | Public CRUD surface for `/api/agents`; POST share lifecycle invariants with §3. |
| `packages/backend/tests/routes/d4-d-structural-invariants.test.ts` | 8 describes | Invariants 1-3 + Standalone happy path + Round-1 P1.2/P1.3/P1.4 pins. |
| `packages/backend/tests/routes/agents-no-host-typed-fail.test.ts` (POST offline + bulk-stop + clear-session sections) | (D3 + D4.a/D4.c carry-over) | Daemon-offline fail-fast (NO reserve), `host_attach_pending` mapping, bulk stop typed aggregation. |
| `packages/backend/tests/runtime/materialize-reconciler.test.ts` | 19 (3 describes: repo primitive + env knob + sequencing) | D4 boot reconciler — stale sweep + threshold env + pre-listen sequencing. |
| `packages/backend/tests/routes/d5-failed-recovery.test.ts` | 24 (7 describes) | DELETE failed/pending + `?retry=true` matrix (8 pins) + default-hide + `?include_failed=1` + `?include_pending=1` (D6-1, 6 pins) + PATCH-locked (D5-fixup1, 2 pins). |
| `packages/backend/tests/permissions.test.ts` (`canViewAgent` describe) | (D5-fixup1) | `canViewAgent` ACL-first ordering + system/agent-self/creator/workspace-member ACL branches. |
| `packages/backend/tests/e2e/standalone-d4-d6-materialize-wire.test.ts` | 1 (3 phases) | Real-wire e2e: happy + typed-fault injection + `?retry=true` + §3.2 echo. Runs real `materializeAgent` via the production dispatcher slot. |

Gates at D6-3 tip `15085c5` (D6-3 doc + evidence-correction fixup, after D6-2 fixup `d1e1763` re-pin):

- D6-2 e2e: 1/1 pass (real `materializeAgent`).
- Host `agent-materialize/handler.test.ts`: 18/18.
- Host `agent-materialize/dispatcher-integration.test.ts`: 10/10.
- D5 regression: 24/24.
- Dependency tripwire: 2/2.
- `pnpm -r typecheck`: clean.

---

## 11. Branch and merge

- Branch: `feature/remote-backend-v1-stage-d4-d-design`
- Base: D4.c tip `1498ccb`
- Worktree: `/Users/shiki/workspace/silverhand-wt-d4-d` (not
  pushed to remote per shiki's autonomous-mandate constraint).
- Commit chain (D4.d only, newest first):
  - D6-3 `f559eac` — this acceptance doc.
  - D6-2 fixup `d1e1763` — narrow `testHooks` + real `materializeAgent` in e2e (Cindy `d4IID_Nnn1VShRa5` P1-1 + P1-2).
  - D6-2 `253e350` — real-wire `agent_materialize` e2e (superseded API surface fixed in `d1e1763`).
  - D6-1 `2dc3f6b` — `?include_pending=1` widener parity.
  - D5-fixup2 `0dd7450` — `permissions.ts` doc drift.
  - D5-fixup1 `58ba65e` — lift status filter into `canViewAgent`.
  - D5 `8869fc5` — failed-row recovery surface.
  - D4 `2617d6c` — boot-time materialization reconciler.
  - D3 `c2a2016` — `POST /api/agents` materialization lifecycle.
  - D2 `501776a` — daemon handler + dispatcher slot.
  - D1 `4b8bff1` — schema + wire arm.
  - Design `68a1c04` — `docs/remote-backend-d4d-design.md`.

When this branch lands on `main`, D4.d is closed. D4.e
(daemon-owned local data-plane proxy) begins next.

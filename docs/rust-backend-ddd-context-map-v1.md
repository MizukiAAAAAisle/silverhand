# Rust Backend — DDD Bounded-Context Map (v1)

> TS backend 退役说明：文中的 `packages/backend` / `packages/server` 源码与测试坐标属于迁移期历史，已从当前仓库删除；现行控制面位于 `rust/crates`。迁移权威仍在 `packages/shared/src/db`，独立回归数据在 `rust/test-fixtures`，现行构建与验证见 [testing.md](testing.md)。

> Task: #2167. Owner: @Alice. Independent review: @Cindy.
> Supersedes v0 (`docs/rust-backend-ddd-context-map-v0.md`, commit `285876ec`). This
> revision addresses Cindy's 8 blocking findings; §0 records exactly how.
>
> **Scope.** Reverse-derive the backend's bounded contexts from _business rules,
> transaction boundaries, authorization, and event semantics_ — NOT from the
> current TypeScript directory layout. No business migration is performed. All
> evidence is against the worktree at the commit this file is committed in;
> repo paths and line numbers are stable references, verifiable with the embedded
> extractor and `rg`.

---

## 0. What changed since v0 (response to review)

| #   | Finding                                                          | Resolution in v1                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Three levels labelled as peer contexts                           | §2 is now **two-layer**: coarse bounded contexts (write-ownership) → internal domain-modules / orchestrators / read-models. Attention and Scheduling are demoted (read-model, orchestrator).                                                                                                                                                                                                                                                          |
| 2   | Access ownership self-contradictory; host_credentials unresolved | §2.1 gives **one** ownership model: a single table→owner map (no double ownership); Access owns the _decision layer + policy tables_, reads resource facts via a read port; `host_credentials` → Host&Runtime, definitively.                                                                                                                                                                                                                          |
| 3   | member⇒capability atomicity disproves the split                  | §2.1 + §4: `enrollAgentIntoWorkspace` writes membership **and** capability in **one** atomic boundary through one `tx` port ⇒ they are one module in Identity&Access, decided **before** any shared-UoW discussion.                                                                                                                                                                                                                                   |
| 4   | §4/§6/authz unverified but load-bearing                          | Evidence completed: full transaction table-set inventory (§4), authorization inventory (§2.1/§7), event-consumer classification (§6). Nothing terminal rests on "quota interrupted"; anything still unproven is marked and carries no conclusion.                                                                                                                                                                                                     |
| 5   | Event handling contradictory                                     | §6 assigns **exactly one** semantic to each cross-context reaction: same-tx orchestration / post-commit effect / durable record. The bus is rejected consistently; must-be-atomic teardown is same-tx, never post-commit.                                                                                                                                                                                                                             |
| 6   | Ports infrastructure-centric                                     | §7 rewrites ports as **use-case/aggregate capabilities**. Default UoW is a **semantic per-use-case UoW** (e.g. `MessageUnitOfWork`, adapter holds pool/connection/tx — per #2165), _not_ a generic `atomically(fn: TxScope)`; that callback shape is recorded as current evidence, designed only when a real cross-repo atomic slice needs it. Environment capabilities are introduced **per slice**, not preset as global Clock/IdGen/Random Traits. |
| 7   | Migration step 1 invalid                                         | §11 consumes #2165's settled wire direction (**Rust wire DTO → checked-in TS bindings + drift gate**), does not re-decide it, and drops "zero-risk" wording. First-cut is given as **candidates + selection criteria**, not a prescribed roadmap: #2165's create-message vertical slice is the recommended foundation proof; C5 Scheduling is a candidate but an **orchestrator (depends on C1/C3/C4), not a proven leaf**.                           |
| 8   | Attachment not self-proving                                      | The SCC/edge numbers are produced by `docs/rust-ddd-scc-extractor.mjs` (committed beside this file, runnable: `node docs/rust-ddd-scc-extractor.mjs`). §1 quotes its verified output; v0's guessed "16-node SCC" is corrected.                                                                                                                                                                                                                        |

**Kept from v0 (Cindy validated):** SQLite-adapter gate (§8b), remote-only composition gate (§9), the three seq axes as brands (§13), and SCC-vs-domain-coupling separation (§5).

**Second review round (migration blockers):** after the evidence layer passed, four
migration-relevant blockers were resolved without expanding archaeology: (1)
`notifications`/`conversation_inboxes` now have a **single write-owner** — C3's
Delivery module; the Viewer Read-Model invokes a semantic mark-read/clear transition
port, never writes those tables (§2, §2.1, §12.3). (2) §7 default UoW is semantic,
not generic-callback. (3) §11 consumes #2165's wire direction and drops absolute
risk claims. (4) §10 separates **current coupling** (C1↔C3 bidirectional edge exists
today via the in-tx notice write) from the **extraction target** (where bidirectional
pairs are forbidden), and §11 stops prescribing Scheduling as a proven leaf.

---

## 1. Method & evidence base

Contexts are derived from four evidence sources, in this order of authority:

1. **Write-ownership + atomic transaction boundaries** — which tables are _written_
   together inside one `atomically(...)` / `db.transaction(...)`. A shared atomic
   _write_ boundary is strong evidence of one consistency boundary; a cross-table
   _read_ is not (it is an anti-corruption read port). See §4.
2. **Authorization structure** — `permissions.ts` is a single pure decision module
   over a closed read port; its axes tell us where policy lives. See §2.1.
3. **Already-extracted domain leaves** — `services/<domain>/`, `application/*`,
   `repos/*-persistence.ts` UoW scopes: these are candidate contracts, not shapes to
   inherit verbatim.
4. **DB-boundary fences** — `tests/db-boundary/zones.ts` and the port-contract tests
   already encode an owner/consumer split we must not contradict.

### 1.1 Reproducible dependency-graph facts (finding 8)

`docs/rust-ddd-scc-extractor.mjs` builds the module import graph over
`packages/backend/src`, computes SCCs (Tarjan), and separates **all** imports
from **value-only** imports (type-only dropped). Verified output at this commit:

```
# node docs/rust-ddd-scc-extractor.mjs --granularity=file
ALL imports:        nodes=239 edges=996  largest-SCC=34   context.ts in=76 out=26
VALUE-only imports: nodes=239 edges=561  largest-SCC=0    context.ts in=2  out=0

# node docs/rust-ddd-scc-extractor.mjs --granularity=dir
ALL imports:        nodes=26  edges=127  largest-SCC=13
VALUE-only imports: nodes=26  edges=78   largest-SCC=8
```

Reading (this **corrects** v0, which asserted a "16-node SCC" — the real
all-imports SCC is 34 files / 13 dirs):

- **The file-level value graph is acyclic (0 non-trivial SCCs).** When type-only
  imports are dropped, there is **no runtime import cycle** at the finest
  granularity. This is the load-bearing proof that the contexts below are
  separable without breaking a runtime dependency cycle.
- The all-imports cycle is dominated by `context.ts` (76 in / 26 out — the service
  locator) and a small logger back-edge; both are **composition/observability**
  edges, not domain edges (§5).
- The dir-level value SCC of 8 buckets is a **folding artifact**: `services/`,
  `repos/`, `application/` each collapse many domains into one node, so cross-file
  value edges between two domains that happen to live under the same top dir turn
  into an inter-bucket edge. It does not survive at file granularity.

The method is deliberately auditable (regex scan of static imports, `.js`→`.ts`
resolution for NodeNext). It ignores dynamic `import()` and treats a barrel
re-export as an edge to the barrel; those approximations are documented in the
script header and do not affect the acyclicity result.

---

## 2. Two-layer structure (finding 1)

**Layer A — coarse bounded contexts.** A context is a _write-ownership_ boundary:
the set of tables whose writes it exclusively owns, plus the invariants those
writes maintain. Five contexts:

| Context                                        | Owns (write)                                                                                                                                                                                                                              | Core invariants                                                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **C1 Identity & Access**                       | `users`, `agents`, `workspaces`, `workspace_users`, `workspace_members`, `workspace_agent_capabilities`, `conversation_users`, `conversation_agents`, `auth_sessions`, `user_password_credentials`; **the authorization decision module** | handle uniqueness; role monotonicity; member⇒capability (§2.1); a principal is user\|agent\|system                                   |
| **C2 Host & Runtime** (control⟂execution seam) | `hosts`, `host_credentials`, `agent_runtime_slots`, `agent_runtime_events`, `agent_runtime_control_events`                                                                                                                                | credential lifecycle; authenticated≠accepted (transport slot vs attachment); append-only runtime history                             |
| **C3 Conversation & Messaging**                | `conversations`, `messages`, `message_reactions`, `saved_messages`, `thread_followers`, `conversation_stream_heads`, `conversation_inboxes`, `notifications`                                                                              | seq monotonic per stream; message-committed⇒recipients enqueued; channel address = title; direct-pair endpoints ARE its participants |
| **C4 Tasks**                                   | `tasks`                                                                                                                                                                                                                                   | board-key ↔ placement biconditional; creator/editor provenance triples; status/closed_at coherence                                   |
| **C5 Scheduling**                              | `schedules`                                                                                                                                                                                                                               | owner-agent scoping; fire-count/until bounds                                                                                         |

**Layer B — internal structure of each context** (these are _not_ peer contexts;
they are modules, orchestrators, or read-models inside a Layer-A context):

- **C1 Identity & Access**
  - _Principal / identity_ module (users, agents identity, handle namespace)
  - _Workspace membership_ module — **membership + capability seed are one module**
    (§2.1/§3), not two.
  - _Authorization_ domain service — pure predicates over a read port (§7).
- **C2 Host & Runtime**
  - _Host control-plane_ (hosts + credentials; issuance/rotation/revoke)
  - _Runtime projection_ (observed slot status; append-only events) — execution-plane
    facts reported by the daemon.
- **C3 Conversation & Messaging**
  - _Conversation lifecycle_ (channel create/rename/close, direct-pair mint)
  - _Message posting_ (insert + seq allocation + stream-head projection)
  - _Thread following_ (auto-follow on reply, manual follow, history backfill)
  - _Delivery enqueue_ (inbox/notification fan-out — the durable enqueue side)
  - **Read-side projections co-maintained in-tx**: `conversation_stream_heads`,
    `conversations.latest_message_seq`. These belong to Messaging, written inside
    the message-insert transaction; they are NOT a separate context.
- **C4 Tasks** — a thin context; each write also records a notice via C3's
  published message-insert capability (§6).
- **C5 Scheduling** — owns only `schedules`; `schedule-service.ts` is an
  **application orchestrator** that reads across C1/C3/C4 through ports and fans
  out post-commit. Cross-domain reach ≠ a large context (v0 error corrected).

**Demoted from v0 peer-context status:**

- v0's _Attention_ context → **Viewer Read-Model** (see below), a read/consumption
  model, not a write-owning domain.
- v0's _Scheduling as a big context_ → C5 thin context + orchestrator.

**Viewer Read-Model (cross-cutting read model, not a Layer-A context).** Owns the
_viewer-side_ read state written in a **separate viewer-scoped transaction**
(`observe.ts:227`): `conversation_reads`, `channel_attention_preferences`,
`workspace_attention_preferences`, `user_sort_entry`, `user_list_sort_mode`. It
never shares a transaction with a message write.

It does **not** own `notifications` or `conversation_inboxes`. Those two tables —
including every state transition on them (enqueue, deliver/settle, fail, and
**mark-read/clear**) — are owned solely by C3's internal **Delivery** module (§2.1).
Today `observe.ts` writes `notifications.read_at` directly in the viewer tx; the
target boundary makes mark-read/clear a **semantic transition port** on the
Notification aggregate that the Viewer Read-Model _invokes_ (`markMentionsRead`,
`clearNotification`) rather than a raw table write it owns. This keeps "each table
has exactly one write-owner" true without a schema change: the port call still runs
in the viewer's request, but the write authority (and the invariants guarding
`read_at`, delivery state) lives in C3's Delivery module. See §12.3 for the
alternative (physically splitting the table) that we explicitly did _not_ choose.

---

## 2.1 Ownership resolution (findings 2 & 3)

> **Authority note (#task:2265).** The machine-readable table→owner map now lives in
> [`docs/rust-backend-organization-map.json`](./rust-backend-organization-map.json) and is
> the SINGLE classification authority the organization gates read. This section is kept as
> DDD **rationale** — the reasoning behind the owners — and is no longer a second copy of
> the ownership table. Where this prose and the JSON ever disagree, **the JSON wins**; two
> corrections #2265 made against the v1 prose below are already in the JSON and must not be
> reintroduced here:
>
> - the v1 table listed only 30 of the 33 tables — `app_settings` (→ `platform_install`),
>   `attachments` (→ C3), and `conversation_events` (→ C3, a read-model) were missing;
> - `conversation_users` / `conversation_agents` are **C3** (the conversation roster is
>   born inside the conversation-create transaction), not C1 membership; the
>   registration-backfill / member-removal writes are cross-context orchestration edges,
>   not C1 ownership.

**Rationale (owners are authoritative in the JSON):** every table has exactly one
write-owner. C1 Identity & Access owns the human/agent identity, membership, role,
capability, credential and session tables plus the authorization decision. C2 Host &
Runtime owns `hosts`, `host_credentials`, and the append-only runtime slot/event tables
(`host_credentials` is **not** in the authz model — grep-confirmed — so it is
unambiguously Host, never co-owned by Access). C3 Conversation & Messaging owns the
conversation aggregate, messages, reactions, saved, followers, stream-heads, and the
Delivery tables `conversation_inboxes` + `notifications` (enqueue, deliver/settle, fail,
and mark-read/clear are all its transitions; the Viewer Read-Model _invokes_ the
mark-read/clear transition via a semantic port, it does not write these tables), plus the
conversation roster and the `conversation_events` activity read-model. C4 owns `tasks`,
C5 owns `schedules`, and the Viewer Read-Model owns the viewer-scoped `conversation_reads`
/ `*_attention_preferences` / `user_sort_entry` / `user_list_sort_mode`. The exact
per-table owner, structural role and implementation status are in the JSON above.

**Access owns the decision, not the resources.** `permissions.ts` (1111 lines) is a
single pure module: every predicate is a function of `ctx.authorizationReads` (a
closed read port, `authorization-ports.ts`) plus a `Principal`. It reads resource
_facts_ (agent existence, conversation placement) through that port; it does **not**
own the agents/conversations tables. So there is **no** C2/C4-style double table
ownership: Access owns the _authorization function_ and the _policy tables it writes_
(`workspace_users.role`, `workspace_agent_capabilities`), while resource tables stay
with their contexts and expose read facts via the port.

The model is one cohesive decision layer implementing a small basis of **orthogonal
axes**, each composed per resource:

- **human role axis** — `workspace_users.role` (`canGovernWorkspace`; agents always false)
- **agent capability axis** — `workspace_agent_capabilities` (`canAgentUseCapability`; users always false)
- **conversation participation** — one shared `resolveParticipation` (no per-placement siblings)
- **creator ownership** — `agents.created_by_user_id`, attachment `created_by_*`, `schedules.owner_agent_id`

Host is not a resource in this model; Task/Schedule authorization _borrows_ the
capability + participation axes (`read_tasks`/`write_tasks`/`manage_schedules` +
`isAgentParticipant`), which is why C4/C5 have no predicates of their own.

**member ⇒ capability is one atomic boundary (finding 3, decisive).**
`enrollAgentIntoWorkspace` (`application/add-workspace-agent-member.ts:66-70`):

```ts
const inserted = tx.insertWorkspaceMembership();
if (inserted.created) tx.seedCapabilityDefaults(); // same tx port, gated on `created`
```

Both writes go through the **same** transaction-scoped port; the capability seed is
gated on the membership row actually being created (no-silent-re-widen). Called from
both `create-workspace.ts:175` and `add-workspace-agent-member.ts:126`. Therefore
`workspace_members` and `workspace_agent_capabilities` are **one consistency
boundary → one module in C1**. This is settled by the transaction _before_ any
"shared UnitOfWork" question is even asked; same-DB is not used to mask a boundary.

**The oracle question is a per-surface policy, not a universal rule (v0 corrected).**
v0 asserted "unknown and unauthorized must always merge or it's an oracle." The code
runs **two deliberate, documented postures**, chosen by whether the id is a guessable
secret or a member-enumerable coordinate:

- **Merged** (unknown == unauthorized → one answer) where the id is guessable: agents
  everywhere (`routes/agents.ts:520`, `direct-pairs.ts:146` "an unviewable and a
  nonexistent agent are one answer"), attachment bytes (`attachment-service.ts:329`),
  message-by-id (`routes/conversations.ts:1128`), tasks-by-id
  (`task-service.ts:1654` "indistinguishable by construction"), capability-pair
  (`routes/capability.ts:121`).
- **Distinguished** (404 vs 403) where the id is a member-visible coordinate:
  workspaces (`routes/workspaces.ts:476` `exists ? 403 : 404`), channels/conversations
  (dominant `get→404, predicate→403` across `routes/conversations.ts`), schedules
  (`schedule-service.ts:447` distinct `schedule_not_found`/`not_owner`).

v1 states this as a **per-surface authorization output policy** owned by C1, not an
invariant. No accidental leak was found; the one asymmetry (`canEnrollAgent`
add=404/403 vs delete=merged) is documented as accepted.

---

## 3. Aggregates, entities, value objects

Derived from the write boundaries (§4), not from row shapes:

- **C1**
  - _Workspace_ aggregate root: `workspaces` + `workspace_users` (role) +
    `workspace_members` + `workspace_agent_capabilities`. Invariant: a member row
    implies its default capability set (§2.1); role transitions guard owner
    immovability (`remove-workspace-member.ts:123`).
  - _Agent_ entity: `agents` (identity, `created_by_user_id`, `host_id` reference,
    `session_scope`, materialization status).
  - _User_ entity + credential VOs (`user_password_credentials`, `auth_sessions`).
  - VO: `Principal = user | agent | system`; capability enum; workspace role enum.
- **C2**
  - _Host_ aggregate: `hosts` + `host_credentials` (issuance/rotation/revoke atomic).
  - _RuntimeSlot_ projection entity: `agent_runtime_slots` + append-only
    `agent_runtime_events`. VO: the three seq axes (§13) as distinct brands.
- **C3**
  - _Conversation_ aggregate root: `conversations` (+ generated `pair_key`, seq
    allocator) with `conversation_stream_heads` as its projection.
  - _Message_ entity: `messages`; VOs: author snapshot `(from_kind, author_id)`,
    thread-root reference, attachment snapshot (embedded JSON in `metadata`).
  - _ThreadFollow_ entity; _InboxDelivery_ / _Notification_ entities (enqueue side).
- **C4** _Task_ aggregate: `tasks` (board-key VO, provenance triples).
- **C5** _Schedule_ aggregate: `schedules` (recurrence spec VO).

---

## 4. Transaction inventory (three-state, finding 4 complete)

Every application/service atomic boundary, with its verified table-set and a
tag: **must-be-atomic** (a real invariant spans the write set) /
**temporarily-same-tx** (same-DB convenience; a candidate to relax on extraction) /
**undecided**. `conversations` is C3's root; a `conversations` write below is
usually the seq-allocator `latest_message_seq` bump.

**Key distinction:** in nearly every "cross-domain" site the _writes_ are confined
to one context; the crossing is a **read** of C1 facts (participation / author
snapshot / workspace name). Cross-context **reads do not define a boundary** — they
are anti-corruption read ports. Only shared _writes_ are consistency evidence.

| Site                                                                                                         | Action                                                                       | WRITE set                                                                                                                       | READ-crosses                              | Tag                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add-workspace-agent-member.ts:126` / `create-workspace.ts:175`                                              | enroll agent (member + capability)                                           | `workspace_members`, `workspace_agent_capabilities`                                                                             | —                                         | **must-be-atomic** (member⇒cap)                                                                                                                                                                                                                                      |
| `remove-workspace-member.ts:117`                                                                             | remove member (roster teardown + audit notice)                               | `workspace_members`, `conversation_agents`/`conversation_users`, `messages` (+seq)                                              | role anchor read                          | **must-be-atomic** (no half-torn membership); runtime stop is **post-commit** (§6)                                                                                                                                                                                   |
| `create-agent.ts:359` (agent arm)                                                                            | provision agent + open creator DM + onboarding msg                           | `agents`, `conversations`, `messages`                                                                                           | —                                         | **must-be-atomic** (saga final step: no orphan line)                                                                                                                                                                                                                 |
| `user-service.ts:142` / `user-persistence.ts:141`                                                            | registration backfill                                                        | `users`, `workspace_users`, `conversation_users`, `workspaces.owner_user_id`                                                    | reads `conversations`                     | **must-be-atomic** (identity + initial membership)                                                                                                                                                                                                                   |
| host-token `:81/:116/:152`, `create-host-invite.ts:29`, `revoke-host.ts:87`, `update-host.ts:88`             | credential issue/rotate/revoke; host setup                                   | `hosts`, `host_credentials`                                                                                                     | —                                         | **must-be-atomic**; single-domain (C2)                                                                                                                                                                                                                               |
| `user-auth-service.ts:106/:161`                                                                              | signup / password reset                                                      | `users`+`user_password_credentials` / `user_password_credentials`+`auth_sessions`                                               | —                                         | **must-be-atomic**; single-domain (C1)                                                                                                                                                                                                                               |
| `conversation-message-service.ts:182`                                                                        | send message                                                                 | `messages`, `conversations`(seq/mint), `conversation_stream_heads`, `conversation_inboxes`, `thread_followers`, `notifications` | participation, author, attachments (read) | **must-be-atomic** (msg+seq+stream-head+enqueue); delivery/runtime **post-commit**                                                                                                                                                                                   |
| `message-repo.ts:1386`                                                                                       | atomic insert primitive (+seq +stream-head)                                  | `messages`, `conversations`, `conversation_stream_heads`                                                                        | `agents`/`users` snapshot                 | **must-be-atomic** (the published capability C4/removal/channel reuse)                                                                                                                                                                                               |
| `thread-follow.ts:87` (agent)                                                                                | manual follow + history backfill                                             | `thread_followers`, `conversation_inboxes`                                                                                      | participation                             | **must-be-atomic** (no "followed but not caught up")                                                                                                                                                                                                                 |
| `thread-follow.ts:162` (human)                                                                               | manual follow                                                                | `thread_followers`                                                                                                              | participation                             | must-be-atomic (single write)                                                                                                                                                                                                                                        |
| `channel-service.ts:360`                                                                                     | create channel                                                               | `conversations`, `conversation_agents`, `conversation_users`, `messages`, `conversation_stream_heads`                           | membership reads                          | **must-be-atomic** (no half-built channel)                                                                                                                                                                                                                           |
| `channel-service.ts:608`                                                                                     | create agent-home DM channel                                                 | `conversations`, `conversation_agents`, `conversation_users`                                                                    | agents/workspaces                         | must-be-atomic                                                                                                                                                                                                                                                       |
| `channel-service.ts:798`                                                                                     | rename channel + announce                                                    | `conversations`, `messages`, `conversation_stream_heads`                                                                        | —                                         | must-be-atomic (rename + notice)                                                                                                                                                                                                                                     |
| `task-service.ts:428/665/801/932/1011/1131/1236/1445`                                                        | create/claim/unclaim/status/edit task (+ notice message)                     | `tasks`, `messages`, `conversations`(seq), `conversation_stream_heads`                                                          | in-tx `canPostToConversation` reads (C1)  | **temporarily-same-tx** for the _notice message_: `tasks` write is C4 must-be-atomic; the co-written `messages` notice is a benign-if-delayed announcement (see below)                                                                                               |
| `observe.ts:227` / `observation-persistence.ts:116`                                                          | advance read cursors + clear mentions                                        | `conversation_reads`, `notifications`                                                                                           | reads `conversations`                     | must-be-atomic; Viewer Read-Model. **Current:** writes `notifications.read_at` directly. **Target (§2, §12.3):** invokes C3 Delivery's `markMentionsRead` transition port — the `notifications` write authority moves to C3; `conversation_reads` stays viewer-owned |
| inbox `:163/:220/:251/:267/:286`, `sort-repo.ts:117`, `agent-capability-repo.ts:58`, `workspace-repo.ts:531` | delivery settle / rollback; list reorder; capability replaceSet; owner stamp | single table (or `{workspaces,workspace_users}`)                                                                                | —                                         | must-be-atomic; single-domain                                                                                                                                                                                                                                        |

**The one genuine `temporarily-same-tx`:** C4 (and channel rename, and
membership-removal) write a **notice `messages` row atomically with their own
aggregate change**, by invoking C3's `messages.insertForConversation` inside their
transaction. Today this is same-tx because it is same-DB. On context extraction this
becomes the hard question — must a task-status change and its notice commit
together? The invariant analysis says **no**: the notice is an _announcement_;
losing it is benign read-model staleness, not a broken domain invariant. Target on
extraction: reclassify the notice as a **post-commit integration effect** (§6),
accepting that a task change can be briefly visible before its notice. This is an
explicit **product decision**, flagged not silently assumed — it is the §12 question
to resolve with shiki, not decided here.

---

## 5. Cause of the apparent monolith (SCC vs domain coupling — kept, sharpened)

The all-imports SCC (34 files / 13 dirs) is **not** evidence of context merge. Its
generators are:

1. **`context.ts` service locator** (76 in / 26 out) — a composition-root back-edge:
   leaves import the aggregate context type for wiring. Value-only in/out collapses
   to 2/0.
2. **logger back-edge** — an observability import.
3. **type-only imports** — dropping them makes the file-level value graph acyclic.

Separate the two debts before judging domain coupling:

- **Composition debt** (context.ts): replace the god-context with per-context
  constructor injection — a wiring change, no domain move.
- **Observability debt** (logger): inject a logger port, not a module import.

After both, the residual value graph is already acyclic (§1.1) — the domains do not
form a runtime cycle. This is why the contexts in §2 can be carved without cycle
decomposition beyond removing these two non-domain edges.

---

## 6. Cross-context reactions — one semantic each (finding 5)

Each reaction is assigned **exactly one** semantic. The bus is rejected uniformly:
no backend use-case subscribes to any frame to drive another aggregate (spec
`use-case-layer-p0-spec.md` §2.2; confirmed — every broadcaster/`publish`/
`deliverMessage` call in the task and message clusters runs strictly **post-commit,
outside** the transaction).

| Reaction                                                                                                                                        | Semantic                                                                                   | Evidence                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Membership teardown (remove roster rows + workspace membership + **audit notice message**)                                                      | **same-tx orchestration**                                                                  | `remove-workspace-member.ts:117` — one `atomically`, all writes inside                                                  |
| Stopping the removed agent's runtime                                                                                                            | **post-commit effect** (compensation)                                                      | `remove-workspace-member.ts:147-152` `stopAll` after commit                                                             |
| Message enqueue to recipient inboxes / mention notification insert                                                                              | **same-tx** (durable)                                                                      | inside the send tx (`conversation-message-service.ts:182`); "message committed ⇒ recipients enqueued" is a C3 invariant |
| System-notice messages (task_create/claim/status/edit, channel rename, membership-removed)                                                      | currently **same-tx durable `messages` row**; extraction target **post-commit effect**     | §4; a `messages` row, never `conversation_events`                                                                       |
| `*_changed` / `unread_updated` / `direct_pairs_changed` / `workspace_channels_changed` / `conversation_members_changed` / runtime status frames | **post-commit effect** = transport fact + read-model invalidation to WS/UI                 | consumed only by `scope-event-bus.ts`→`ws-connection.ts`; no backend re-subscription; not persisted/replayed            |
| `deliverMessage` / runtime `start` / wake                                                                                                       | **post-commit effect**                                                                     | delivery layer, after commit                                                                                            |
| Agent/computer teardown (delete-agent, delete-computer)                                                                                         | **same-tx persistence cascade** (FK `ON DELETE CASCADE`/`SET NULL`), not a domain reaction | `delete-agent.ts:297`, `delete-computer.ts:207` — one `DELETE FROM agents`/`hosts` fans out via schema FKs              |
| Runtime clear-session audit notice                                                                                                              | currently **same-tx** notice `messages` row (C2↔C3), extraction target post-commit         | `outbound-event-fanout.ts:1062` / `runtime-fanout.ts:336` — same notice pattern as C4                                   |

**No reaction is both.** A must-be-atomic teardown is same-tx and never guarded by a
post-commit effect (a best-effort effect cannot protect an invariant). The
`ON DELETE CASCADE`/`SET NULL` foreign keys are **persistence-shape** (referential
cleanup), not a domain reaction — they are not counted as events (v0 conflated
these). Agent/computer delete is exactly such a cascade: a single `DELETE FROM
agents`/`hosts` fans out across membership/messaging/tasks/scheduling/runtime tables
by schema FK, inside one control-plane transaction.

> **Verified (finding 5 now settled by the whole-repo sweep, not inference).** The
> only production consumer of `ScopeEventBus` (`scope-event-bus.ts`) is
> `ws/ws-connection.ts:125` (`subscribeScope` → serialize → WS `send` to the
> renderer). **No backend use-case/service re-subscribes to any frame to drive
> another aggregate** — the legacy in-process `events.subscribe(conversationId,…)`
> seam has zero production callers. Therefore **every** cross-context frame
> (`message`, `task_changed`, `*_changed`, `unread_updated`, `notification`, runtime
> status, …) is a `post-commit-effect` (best-effort transport + read-model
> invalidation, bounded in-mem replay, REST snapshot on gap). **No durable domain
> event exists on this bus.** Three frames (`agent_event`, `agent_init_timeout`,
> `compaction_stale`) have no live renderer consumer — dead post-commit effects.
> The daemon→backend runtime frames (`runtime_state`/`runtime_exit`/… consumed at
> `runtime/event-handler.ts:585` via `HostClient`) are a **separate transport** (the
> producer side that translates into the bus frames above), not `ScopeEventBus`
> events. This is what lets §7 keep a `PostCommitEffectSink` and reject a domain-event
> bus outright.

---

## 7. Ports — use-case / aggregate capabilities (finding 6)

Ports are **capabilities the application needs**, not "one repository per context."
Four kinds:

1. **Unit of work — default to a _semantic_ UoW per use-case/aggregate, not a
   generic `atomically(fn: TxScope)`.** #2165 already converged the smaller, correct
   shape: the application sees a **named semantic UoW** (e.g. `MessageUnitOfWork`)
   exposing only the domain verbs one use-case needs; the SQLite adapter internally
   holds the pool/connection/transaction and lock policy. Application code never
   receives a transaction handle or a `TxScope` capability bag. **That is the Rust
   target** — one semantic UoW per aggregate/use-case, so the transaction boundary is
   named by the business operation, not by a generic callback.

   Today's `AuthUnitOfWork` + `atomically(fn: (tx) => T)` callback shape is recorded
   here as **current evidence, not the verbatim target.** A constrained callback-scope
   UoW is designed **only** when a _real_ cross-repo atomic slice proves it is needed
   (multiple aggregates that must commit together and cannot be expressed as one
   aggregate's verbs); even then it exposes narrow capability methods, never a repo or
   raw transaction. Lock policy (`BEGIN IMMEDIATE` vs deferred) stays inside the
   persistence adapter (`repos/*-uow.ts`) and never appears on the application
   contract (db-boundary ratchet already enforces this).

2. **Aggregate capabilities** — minimal verbs per aggregate, expressed in domain
   terms, e.g. `WorkspaceMembership.insertMembership()/seedCapabilityDefaults()`,
   `Messaging.insertForConversation(...)`, `Conversation.getOrCreateDirectPair(...)`,
   `Tasks.create/claim/setStatus/edit`, `Schedules.upsert/cancel`. Not table CRUD.
   These verbs are what a semantic UoW (#1) is composed from.
3. **Cross-context read ports (anti-corruption)** — the read-only facts one context
   needs about another, e.g. `AuthorizationReadPort` (participation, agent facts),
   author-snapshot lookups. These are the _only_ legal cross-context dependency and
   they are unidirectional (§10).
4. **Environment capabilities — introduced per slice, not preset as global Traits.**
   Do **not** define global `Clock`/`IdGen`/`Random` Traits up front. Each use-case
   slice introduces the _minimal_ capability it actually touches (a `now()` source, an
   id source, a token source, a `PostCommitEffectSink` for collect-then-drain
   best-effort effects) as a narrow injected dependency at composition. No business
   logic in them. The set is discovered slice-by-slice, not mandated by this map.

The authorization _domain service_ is a pure function over port #3, not a repository
— the cleanest example of ports-as-capabilities.

---

## 8. Shared types — ownership, no global domain crate

Per shiki: shared cleanup is **not** a prerequisite and full DDD purity is not
required. Only two gates:

- **No Rust domain/DB-internal type may leak into `shared`.** `shared` carries only
  stable **wire shapes** and **protocol constants** (the three seq brands, epoch/
  protocol-version constants, DTOs on the desktop↔server contract).
- **No cross-context bidirectional dependency.** A context may depend on another's
  read port (§10), never mutually.

Shared types are categorized by their owning context; a wire DTO is owned by the
context that produces it and re-exported through the wire seam (§11). No global
`shared` _domain_ crate is proposed.

## 8b. DB portability gate (kept — validated)

The backend already split a DB boundary for a future SQLite→PostgreSQL move; the
Rust map must not re-weld SQLite into domain/application:

- **Adapter owns:** SQL dialect, PRAGMA, driver errors, connection pool,
  transaction/migration _implementation_, and lock strategy (`BEGIN IMMEDIATE` is a
  persistence policy — evidence: it lives in `repos/*-uow.ts` and port doc-comments,
  never in application callbacks).
- **Domain/use-case owns:** business query/write _semantics_ and the _atomicity
  requirement_ (which writes must be one boundary — §4), expressed via the UoW port.
- Do **not** weaken business ports to a cross-DB lowest common denominator. No
  PostgreSQL adapter is designed now; the gate only keeps the seam clean.

## 9. Remote-only composition (kept — validated)

Rust-ization must preserve remote-only Desktop:

- The client artifact contains **no** backend / SQLite / migration / Rust-native
  code; it reaches a remote server over HTTP/WS only.
- The embedded sidecar and the ECS/remote server are the **same external contract**;
  deployment composition must not change any context boundary in §2.
- Any embedded-only / local-shortcut port is an **error boundary**, not a design
  affordance.

## 10. Dependency direction — current coupling vs extraction target

These are **two different graphs**; conflating them is a migration hazard. The
left is what the code does _today_; the right is the boundary we extract _toward_.

**(a) Current coupling (as-built, HEAD):**

```
   C3/C4/C5 ──read ports──▶ C1        (auth, participation, membership — ACL reads)
   Viewer Read-Model ──reads──▶ C1, C3
   C1 (member removal) ──in-tx write──▶ C3   (audit/notice `messages` row, same tx)
   C4 (task events), C3 (rename) ──in-tx write──▶ C3 notice/event rows
   C2 ⟂ C1: agents reference hosts (host_id); Host owns credentials/runtime only
   all contexts ──post-commit effects──▶ WS/UI
```

⇒ **C1 and C3 are bidirectionally coupled _today_:** C3 reads C1 facts (auth), and
C1's member-removal path writes a C3 `messages` audit/notice row _in the same
transaction_ (`remove-workspace-member.ts:117`). This edge **exists** and is not a
defect to hide — it is exactly what the §12.1 notice-atomicity decision resolves.

**(b) Extraction target (post-decision, what we build toward):**

```
        Viewer Read-Model  ──reads / semantic transition ports──▶  C1, C3
   all contexts ──read ports──────▶ C1  (unidirectional ACL reads)
   all contexts ──post-commit effects──▶ WS/UI
```

- **Target rules (goals, not current invariants):** no edge _into_ C1 that writes
  (C1 is the policy source); **no bidirectional context pair**; no context importing
  another's persistence/DB types; no post-commit effect guarding a must-be-atomic
  invariant.
- **The C1↔C3 in-tx notice write is the one edge that violates the target today.**
  Whether it becomes a post-commit effect (breaking the cycle) or is accepted as a
  co-located C1+C3 write is the §12.1 open question. Until that product call, the
  bidirectional edge stands — the "forbid bidirectional pair" rule is **target-only**
  and does not describe HEAD.

## 11. Migration seams & candidate first slice (finding 7)

This map gives **candidates and selection criteria**; it does _not_ prescribe the
first cut as already-proven. Two seams are load-bearing.

**Wire seam — direction is settled by #2165, consume it (do not re-decide).** The
converged, verified seam is: **Rust wire DTO is the source of truth → checked-in TS
bindings are generated from it → a drift gate fails CI if they diverge.** This map
adopts that direction verbatim; it does **not** define a second authoritative
direction. (v0's "generate the Rust type _from_ the TS shape" is deleted — it is
backwards relative to #2165, which makes Rust the producer.) `shared`'s only
obligation is the **negative gate**: no Rust domain/DB-internal type leaks into it,
and the drift check stays green. No claim that any seam is "zero-risk" — the drift
gate exists precisely because the seam has risk.

**Context-extraction candidates (ranked by port-isolation, not proven):**

1. **#2165's create-message vertical slice — the recommended first _foundation_
   proof.** It already exercises the semantic `MessageUnitOfWork` (§7 #1), the wire
   seam direction above, and the post-commit effect drain end-to-end. Using it as the
   first slice proves the whole port/UoW/wire toolchain on a real, already-converged
   path rather than on a hand-picked "easy" context.
2. **C5 Scheduling — a _candidate_, not a proven leaf.** It owns only `schedules`,
   which makes its _table_ boundary clean, **but `schedule-service` is an
   orchestrator that depends on C1/C3/C4** (reads participation/auth, fans out a
   message send) — it is **not** a dependency-free leaf. Its cross-context reach is
   through read ports + post-commit send, so it has no in-tx cross-context _write_ to
   untangle; that is its appeal. Keep it as a candidate; do not claim it is the proven
   optimal first cut.
3. **C4 Tasks** — blocked on the §12.1 notice-atomicity decision (its task-event
   notice is the C1↔C3-style in-tx cross-context write).
4. **C2 Host & Runtime** — control⟂execution seam, already the most port-isolated of
   the large contexts.
5. **C3 Messaging** and **C1 Identity & Access** last — largest write boundaries, most
   read-port consumers.

**Selection criteria for the actual first cut** (apply when the slice is chosen):
smallest set of tables owned; zero in-tx cross-context _writes_ (post-commit-only
reach is fine); a real, already-converged use-case to prove parity against; additive
to `shared` (no context moved). By these criteria #2165's create-message slice scores
highest as the foundation proof; Scheduling is the cleanest _whole-context_ candidate
once the toolchain is proven.

## 12. Open questions (deferred, per Cindy — resolve after this converges)

1. **Notice-message atomicity** (the load-bearing one): may a C4/C3-rename/C1-removal
   domain change commit _without_ its notice message in the same transaction? Product
   call on brief pre-notice visibility. Blocks C4 extraction (§11 step 3).
2. C2 sub-split: is _Runtime projection_ a distinct context from _Host control-plane_,
   or one context with two modules? (Both are execution-plane-facing; deferred.)
3. **Resolved (recorded, not deferred):** `notifications` stays **one table owned
   solely by C3's Delivery module** (§2, §2.1); the Viewer Read-Model reaches
   mark-read/clear through a semantic transition port, not a raw write. We did **not**
   physically split it into produce/consume tables — that alternative is heavier and
   changes schema for no invariant we cannot already enforce with a single owner + a
   port. Revisit only if a future context genuinely needs to own the consume side.

## 13. Glossary — canonical term, forbidden aliases

| Canonical                               | Definition                                                                                                                      | Forbidden aliases / drift                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Principal**                           | `user \| agent \| system` acting identity                                                                                       | "account", "caller" (untyped)                                                                                               |
| **workspace kind**                      | `regular \| agent_home`                                                                                                         | ~~`dm`~~ — a DM is a `direct_pair` **placement**, not a workspace kind (`core-design.md` §2.4 is stale drift — fix the doc) |
| **placement**                           | `workspace \| direct_pair`                                                                                                      | "channel type", "conversation kind"                                                                                         |
| **capability**                          | agent authorization axis (`workspace_agent_capabilities`)                                                                       | "permission" (that's the human role axis)                                                                                   |
| **role**                                | human governance axis (`workspace_users.role`: owner/admin/member)                                                              | "capability", "grant"                                                                                                       |
| **TransportSeq / MessageSeq / ReadSeq** | three distinct seq axes, never cross-assigned (brands)                                                                          | a single "seq"                                                                                                              |
| **notice / system message**             | a `messages` row recording a domain change                                                                                      | ~~"event"~~ (not a bus event; not `conversation_events`)                                                                    |
| **post-commit effect**                  | best-effort action after commit, consumed by WS/UI                                                                              | ~~"domain event"~~                                                                                                          |
| **Delivery module (C3)**                | sole write-owner of `conversation_inboxes` + `notifications` — all transitions (enqueue, deliver/settle, fail, mark-read/clear) | "Viewer owns the clear lifecycle" (it only _invokes_ the transition port)                                                   |

## 14. References & verification status

- Reproducible extractor: `docs/rust-ddd-scc-extractor.mjs` (run: `node docs/rust-ddd-scc-extractor.mjs [--granularity=file|dir]`).
- Schema: `packages/backend/tests/migration-baseline/schema-current.normalized.txt` (33 tables).
- Authorization: `packages/backend/src/permissions.ts`, `authorization-ports.ts`, `permissions-registry.ts`.
- Use-case/tx contract: `docs/use-case-layer-p0-spec.md`; principles: `docs/architecture-principles.md`.
- Transaction sites: enumerated by `rg` + read directly; table-sets resolved to concrete repo SQL (§4).

**Verified (load-bearing, sufficient to fix hierarchy & ownership):** §1.1 graph
numbers (extractor); §2.1 ownership + authz axes + oracle policy (permissions.ts read
in full); §3–§4 aggregates & transaction table-sets (every application/service
`atomically` site traced to concrete repo SQL); §6 post-commit vs same-tx **and** the
"no backend re-subscription / no durable domain event" negative (whole-repo
ScopeEventBus consumer sweep — the only consumer is `ws-connection.ts:125`).

**Provisional (sampled, not exhaustive — per shiki/Cindy's "not full DB archaeology"
scope; to be firmed up by the first real business slice, §11):** C2 runtime-slot
control-plane orchestration beyond its single-table `{agent_runtime_slots,
agent_runtime_events}` writes; the exact agent/computer-teardown cascade closure
(inventoried as a persistence FK cascade, §6, but not needed to fix a boundary); the
C2 sub-split question (§12.2). These carry no terminal conclusion in this map; the
boundary graph (§2/§2.1) and the semantics rules (§4/§6/§7) do not depend on them.

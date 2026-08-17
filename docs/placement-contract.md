# Canonical conversation-place contract (Milestone 1 of #task:2045)

> Status: **contract only, for Cindy independent review (round 6).** No code
> lands until PASS (Milestone 2). Rounds 1 (4), 2 (5), 3 (4), 4 (4), 5 (1)
> blockers all accepted in full. Everything except the §3 discriminant unification
> PASSed at R5. This round unifies Saved/Search onto the canonical
> `HumanConversationPlace` `kind` discriminant and collapses the double
> workspace-kind source in Search.

## 0. Correction ledger

- **R1**: universal union, omitted `agent_inbox`, bundled presentation+namespace,
  hidden `channel_id` redirect.
- **R2**: name too wide; task dual-coordinate; search leaked `agent_home`;
  presentation destination unclosed; audit under-classified; TaskNav punted.
- **R3**: audit cardinality off-by-one; §4 closed channel-name but not
  workspace-name (no producer); TaskNav deletion proof unobservable; the
  "ACL never trusts the Place DTO" wall was scoped to Task only.
- **R4**: Saved/Search DTO shape was still prose (`place + presentation block`),
  admitting impossible states — now discriminable per-arm like `TaskPlace`; §4-B
  left an "extend OR new event" implementer choice — now one frozen producer; §4-C
  wrongly folded `liveness` into the identity carrier — presence is a separate
  axis (#2043/#2049), the carrier holds presentation + subject lifecycle only; §6
  proposed a package-semver regime — replaced by a scoped schema-epoch gate.
- **R5**: §3 invented a second discriminant spelling (`place_kind:
  'workspace'|'direct_pair'`) instead of reusing the canonical
  `HumanConversationPlace` `kind: 'workspace_channel'|'direct_pair'` — Saved/Search
  now reuse the canonical `kind`, extending presentation only on the
  `workspace_channel` arm (Task keeps its board-context `kind:'workspace'` legitimately).
  `SearchConversationPlace` carried both `SearchWorkspaceRef` (own `kind`) and a
  parallel `workspace_kind` (two contradictory kind sources) — collapsed to one by
  correcting `SearchWorkspaceRef.kind` to `regular | agent_space`.

## 1. Domain boundary + name is the first wall

In-scope read models (task board, saved, search, favorites) are human-viewer
faces. Human-viewable place: `placement_kind ∈ { workspace, direct_pair }`.
`agent_inbox` is the third arc (`requireWorkspacePlacement`,
`conversation-placement.ts:62`, **throws** on `workspace_id === null`) — an
agent-runtime fact, never a human place. Identity core is named
**`HumanConversationPlace`**: the name is the first wall, fail-closed constructor
the second.

## 2. Minimal stable identity core — `HumanConversationPlace`

```
HumanConversationPlace =
  | { kind: 'workspace_channel'; conversation_id; workspace_id; workspace_kind: 'regular' | 'agent_space' }
  | { kind: 'direct_pair';       conversation_id }
// constructor asserts placement_kind !== 'agent_inbox' (fail closed, not omit)
```

Rules: (1) `conversation_id` single routing coord both arms. (2) workspace-like
only on `workspace_channel`; `direct_pair` fabricates no workspace/channel.
(3) no mutable presentation in the core. (4) no board namespace (`pair_key`) in
the core. (5) `workspace_kind` = domain projection `regular | agent_space`;
physical `agent_home` stays behind the repo boundary. (6) no `{kind,value}` pair.

## 3. Per-bounded-context projections — one `place` per DTO, folded, no dual coord

- **Task — `TaskPlace`** (replaces `TaskBoardRef`; core folded into each arm):

  ```
  TaskPlace =
    | { kind: 'workspace';   conversation_id; workspace_id; workspace_kind: 'regular'|'agent_space'; channel_name }
    | { kind: 'direct_pair'; conversation_id; pair_key }
  ```

  `TaskSummaryDto` drops its top-level `channel_id` entirely; `place.conversation_id`
  is THE coordinate. `pair_key` lives only here. `TaskChangedEvent` drops the
  redundant `channel_id`, keeps `conversation_id`.

  **`workspace_name` is deleted from this arm** (R3 fix, Norman+Cindy consumer
  grep): it has **zero production readers** — the card renders `channel_name`
  only, and the container header resolves the workspace name from the *live*
  workspace directory (`taskContainer.ts:77` `position.workspace.name`), not a
  frozen DTO field. Building a liveness chain for a zero-consumer projection is
  over-construction; the minimal set `{conversation_id, workspace_id,
  workspace_kind, channel_name}` is complete. Consequence: Task has **no**
  workspace-name liveness obligation (§4-B does not apply to Task).
- **Saved [#task:2050] — `SavedMessageDto.place`, canonical `kind` discriminant.**
  It **reuses `HumanConversationPlace`'s `kind` and literals verbatim**
  (`'workspace_channel' | 'direct_pair'`), and only *extends presentation on the
  `workspace_channel` arm*. Today's flat
  `workspace_id/workspace_name/conversation_id/conversation_title/channel_id`
  fields are replaced by:

  ```
  SavedPlace =
    | { kind: 'workspace_channel'; conversation_id; workspace_id; workspace_kind: 'regular'|'agent_space'; workspace_name; channel_name }
    | { kind: 'direct_pair';       conversation_id }
  ```

  `workspace_id` + `workspace_kind` are the canonical core (from §2);
  `workspace_name` + `channel_name` are the presentation extension, bound to
  workspace identity **in the same arm** — a `direct_pair` row cannot carry them
  (impossible to construct), and a `workspace_channel` row cannot carry peer
  presentation. The pair arm holds only `conversation_id`; peer name/avatar is
  resolved by that id through the DirectPair carrier (§4-C), never frozen. Common
  fields (`message`, `agent_name`, `saved_at`) stay outside the discriminant.
  Because the discriminant is the canonical one, the shared constructor and
  exhaustiveness checks are reused — no second spelling of the same `place`.
- **Search [#task:2051] — `type` discriminant stays; the place reuses the canonical `kind`.**
  `SearchResultDto` remains `discriminatedUnion('type', …)`:
  - `type: 'conversation'` and `type: 'message'` are the **only** arms that carry a
    conversation place, and that place uses the canonical `kind`:

    ```
    SearchConversationPlace =
      | { kind: 'workspace_channel'; conversation_id; workspace: SearchWorkspaceRef; channel_name }
      | { kind: 'direct_pair';       conversation_id }
    ```

    The `workspace_channel` arm carries **one** workspace identity — the
    `SearchWorkspaceRef`, which already has its own `kind`; there is **no** parallel
    `workspace_kind` field (that duplicate was the double-source of truth that could
    construct two contradictory kinds). To make the ref the single source, its
    external domain is corrected: **`SearchWorkspaceRef.kind` changes from
    `'regular' | 'dm'` to `'regular' | 'agent_space'`** (`message.ts:523`) — physical
    `dm`/`agent_home` no longer surfaces on the wire.
  - `type: 'workspace'` is a **named-entity result, NOT a conversation place** — it
    reuses **the same** `SearchWorkspaceRef` (now `regular | agent_space`), carries no
    `conversation_id`, and can never be a `direct_pair`.
  `type` selects the result kind; the canonical `kind` selects the placement inside
  the two conversation-bearing arms; exactly one place per DTO, one workspace-kind
  source, no parallel unions that could contradict.

## 4. Presentation liveness — SEPARATE fact edges, each with a real producer + subscription + falsifier (R3 blocker 2)

Presentation is a live projection keyed on `conversation_id`, never
frozen-denormalized. There are **three distinct fact edges** (channel-name,
workspace-name, peer-identity); a "family" label may NOT substitute for a producer
that does not exist, and separate axes (notably presence, §4-C) may NOT be folded
in:

### 4-A. channel-name fact edge — producer EXISTS

- Source: workspace channel title/archival.
- **Producer (exists):** `channel-service.publishWorkspaceChannelsChanged` →
  `workspace_channels_changed` (`channel-service.ts:869/932`, post-commit on
  rename/archive).
- Subscribers (M2): Task board query (card `channel_name`), Saved list, Search
  results — each registers on `workspace_channels_changed`.
- Falsifier: rename a channel with no task/message change → the three read models'
  `channel_name` refreshes.

### 4-B. workspace-name fact edge — producer DOES NOT EXIST, M2 must add it

- Source: workspace rename (`workspaces.ts:210` `updateMutableMetadata`).
- **Gap (verified):** that handler inserts a system message + publishes a *message*
  event only; it emits **no** workspace-metadata invalidation.
  `viewer_workspaces_changed` (`viewer-workspaces.ts`, viewer-scoped) exists as the
  workspace-list carrier but **rename does not fire it**. So today `workspace_name`
  in Saved / Search / Task goes stale on rename.
- **M2 producer obligation (backend, Alice) — FROZEN, no implementer choice:**
  extend the existing viewer-scoped carrier `viewer_workspaces_changed`
  (`viewer-workspaces.ts:15`) with a new `change` value **`'metadata_changed'`**.
  Today `ViewerWorkspaceChange = 'added' | 'role_changed' | 'removed'`; the rename
  path (`workspaces.ts:210`) publishes `publishViewerWorkspacesChanged(ctx,
  userId, { change: 'metadata_changed', workspace_id })` to **each human viewer of
  the workspace**. This reuses the existing contract exactly: the renderer already
  treats the payload as a hint and refetches `['workspaces']` as the authority
  (`docs/viewer-visibility-sync-v1.md`), so the workspace-list authority refresh
  falls out for free. A dedicated `workspace_metadata_changed` event is
  **rejected**: the payload shape does not diverge, the scope
  (`viewer:${userId}`) is identical, and a second carrier for the same fact
  would fork the "one owner for the event" invariant this module exists to hold.
- Subscribers (M2): **Saved list, Search results only** additionally invalidate
  their cached `workspace_name` on `change: 'metadata_changed'` (distinct from the
  4-A channel-name registration). **Task does not** — it deleted `workspace_name`
  (§3) and resolves its container name from the live workspace directory, so it has
  no frozen `workspace_name` to invalidate.
- Falsifier: rename a **workspace** with no task/message/membership change → the
  Saved/Search rows' `workspace_name` refreshes (fails today; the producing edge
  is what this blocker requires M2 to add).

### 4-C. peer-identity fact edge — presentation + subject lifecycle ONLY, never presence

- Source: DirectPair peer **presentation** (`name` / `display_name` / `avatar_url`
  / `runtime`) and **subject lifecycle** (`status: deleted`, `read_only`
  survivor state). These are exactly the fields `DirectPairCounterpart`
  (`conversation.ts:521`) + the `read_only` survivor flag already carry.
- Producer: `agent_changed` / `user_changed` via the `IDENTITY_CARRIERS` registry
  (presentation + delete lifecycle).
- Subscribers: any pair-arm consumer resolving peer identity via the DirectPair
  carrier (#task:2035 / #2039).
- Falsifier: rename/re-avatar/delete a peer → DM cards/rows refresh without a task
  change.
- **Explicitly NOT this edge — availability / process liveness is a separate axis.**
  `DirectPairCounterpart` does not carry availability or presence, and this
  contract must not re-key it onto the place/pair carrier. Presence is resolved
  by **agent id** through its own authority (`#task:2043` wire + `#task:2049`
  renderer), confirmed by the presence owner (Norman): the two axes were
  deliberately decoupled (placement-keyed presence sources were deleted) and
  #2045 does not fold them back.

## 4a. Global safety wall — Place DTOs are NEVER an authorization source (R3 blocker 4)

A `place` field (`TaskPlace`, `HumanConversationPlace`/`SavedPlace`,
`SearchConversationPlace`, and the Favorites projection) is for **routing /
presentation / namespace ONLY**. **No consumer may derive ACL or participation
from a Place DTO's `workspace_id` / `workspace_kind` / `pair_key`.** Authorization ALWAYS
recomputes from `conversation_id` back to the canonical placement-participation
authority (`resolveParticipation` / `canViewConversation` /
`conversation-placement-sql.ts`). This generalizes the task rule "Board is not an
ACL unit" to every place-bearing read model, closing the workspace-claim
authorization hole that Saved/Search/Favorites would otherwise regrow. M2 verifies
per read model: a forged/stale `workspace_id` in a request/DTO never widens what
the viewer can read.

## 5. Consumer mode fork — `offered scopes` vs `locked context` (PASSed, unchanged)

Exactly one of two modes; the same selector must not be both scope-picker and
placement display. (a) selectable workspace-like scope — picker offers only
`workspace` / `agent_space`, DM never a selectable scope. (b) locked direct_pair
context — scope trigger hidden, identity via DirectPair carrier, filter bar keeps
only Assignee/From, no switching away. `taskContainer.ts:95` read-back removed;
`46d0238a` pair-leaf trigger scrapped; backend `container=direct_messages` stays a
query capability, not a global scope IA.

## 6. `TaskNavRef.channel_id` — compat phase gated by a schema epoch, not package version (R4 blocker 4)

`TaskNavRef.channel_id` (task.ts:161) has a proven installed-CLI consumer
(`packages/cli/src/commands/task.ts` `nav.ref.channel_id`), which is why it earns a
compat phase — but the deletion criterion must be **measurable**, or the dual-field
becomes permanent. The problem is **response-schema compatibility**, not product
versioning, so the gate is a scoped schema epoch — NOT a package-semver regime.

- **Verified sensor gap:** the CLI sends only a static `X-Agent-Hub-Caller:
  silverhand-cli` tag (`client.ts:55`); its `package.json` version is `0.0.0`. The
  server captures `user-agent` only into auth session-metadata at session creation,
  not per request. So "no old installed CLI remains" has **no sensor today**. This
  stays a caller tag — it is not promoted to a release semver.
- **M2 obligation (makes deletion observable, scoped to schema compat):**
  1. The CLI sends a named, monotonic **`SILVERHAND_CLI_API_EPOCH`** request header
     (an integer that increments only when it learns a new response-schema field —
     independent of `package.json` version, which stays `0.0.0`).
  2. The server reads it and enforces a **`MINIMUM_CLI_API_EPOCH`** floor. An old
     CLI that omits the header is treated as **epoch 0**.
  3. During the transition the floor is 0: the server accepts epoch-0 callers and
     emits **both** `channel_id` and `conversation_id`, guaranteed **same value**.
     Epoch-0 CLIs read `channel_id`; epoch-1 CLIs prefer `conversation_id`.
  4. `channel_id` is removed only after the enforced floor is raised to **1** at a
     dated cutover — raising the floor is what makes "no old CLI" *true*, not merely
     observed.
- If the epoch gate is not added, the compat phase is **rejected** (an unobservable
  dual-field is worse than the wart it hides).

Contrast: the top-level task `channel_id` (§3) has NO external consumer → destructive
delete, no bridge.

## 6b. Full workspace-require self-audit — corrected cardinality, zero-omission (R3 blocker 1)

Classes: **WOD** workspace-only by domain · **HPB** human-place bug · **IAO**
internal/agent-only · **LFR** latent forbidden reuse.

### `requireWorkspacePlacement(...)` — universe = **16 production calls** (excl. the `:62` shared definition) = **16 WOD**, zero omitted

| Site | Class | Reason / guard-falsifier |
|---|---|---|
| `viewer-scope.ts:171` | **WOD** | DM handled by the parallel `publishUnreadUpdated` direct_pair branch (comment `:160`) |
| `observe.ts:336` | **WOD** | `direct_pair` intercepted at `:329` (`publishDirectPairsChangedToViewer`); only workspace/agent_inbox fall through |
| `conversation-repo.ts:848` | **WOD** | inside the `WORKSPACE_PLACED` predicate; the assert ties the SQL filter to the non-null DTO field |
| `attention.ts:189` | **WOD** | `getChannel` filter guarantees open-roster⇒workspace; agent_inbox already 404s |
| `channel-service.ts:713/869/932` (×3) | **WOD** | channels are a workspace-only aggregate (invariant #3) |
| `conversation-member.ts:260/541/622/667/905/963/1101/1208/1477` (×9) | **WOD** | membership/roster is a workspace concept; DirectPair has endpoints, not members; M2 asserts these paths reject a direct_pair |

**16 WOD = 16.** (R3 correction: my prior "18 production / 17 WOD" wrongly
counted the `:62` definition line into the total. #2050 RESOLVED the one HPB by
REMOVAL: `saved-message-repo.ts` `save()` no longer calls
`requireWorkspacePlacement` at all — it asserts a three-arm `SavedPlacementError`
on `placement_kind` instead, so `direct_pair` is saveable while `agent_inbox`
still fails closed. The universe therefore shrank 17→16 and is now purely WOD.)

**M2 mechanical completeness gate:** a test enumerates every
`requireWorkspacePlacement` call site AND every hand-written roster read outside
the participation authority (§6b-roster below), failing if any is absent from a
disposition table — a new call that skips classification reddens CI. (The
enumeration was widened from "requireWorkspacePlacement call sites" alone
because #2050 showed a roster gate can be wrong WITHOUT ever touching
`requireWorkspacePlacement`: saved's DM gap was a hand-written
`EXISTS(conversation_users)`, not a workspace-require call.)

### §6b-roster. Hand-written roster reads outside the participation authority

The participation authority (`conversation-placement-sql.ts`
`userParticipates` / `agentParticipates` / the `*_USER_IDS_SQL` set forms) is
the ONLY place that may decide participation. Any OTHER surface that hand-writes
`EXISTS(conversation_users …)` (or the agent/workspace equivalents) as a
visibility gate is **LFR** — latent because it happens to agree with the
authority on the workspace arm, forbidden because it silently disagrees on the
`direct_pair` arm (a DM has no roster seat) and cannot see the v25 membership
conjunct.

| Site | Class | Disposition |
|---|---|---|
| `conversation-read-repo.ts:402` (`unreadCountsByConversation`) | **LFR→HPB** | roster-joins `conversation_users`; must include the DM arm via participation (§7, folded into #2045 Favorites) |
| `saved-message-repo.ts` `listForUser` | **LFR→HPB, FIXED (#2050)** | was a hand-written `EXISTS(conversation_users)` that returned false for every `direct_pair` ⇒ DM saves persisted (201) and read by id but were silently dropped from the list. Now delegates to `userParticipates('conv', userId)`. Falsifier: `tests/repos/saved-message-repo.test.ts` — save+list a `direct_pair` message returns it; a stale seat without `workspace_users` membership does NOT list |

### `JOIN workspaces` — universe = 19 hits / 8 files, by surface (was 20; #2050 dropped saved's inner join to a single LEFT JOIN)

| File | hits | Surface / disposition |
|---|---|---|
| `conversation-repo.ts` | 6 | workspace channel-list reads — **WOD** (WORKSPACE_PLACED-scoped) |
| `search-repo.ts` | 4 | search read model — **HPB** on the DM arm (#2051): drop `workspacePlaced` for `direct_pair` |
| `favorites.ts` | 2 | Favorites — **HPB** (§7: DM star-able ⇒ pair arm via participation) |
| `saved-message-repo.ts` | 1 | saved — **HPB, FIXED (#2050)**: `JOIN workspaces` → **LEFT JOIN**, `workspace_id` derived from `conv.workspace_id`, place narrowed on `placement_kind` (v81 dropped the denormalized `saved_messages.workspace_id`) |
| `agent-repo.ts` | 2 | agent↔agent_home ownership — **IAO** |
| `conversation-placement-sql.ts` | 2 | the participation **authority itself** — WOD by construction |
| `task-sql.ts` | 1 | task board read — folds into `TaskPlace`; pair arm needs no workspace join |
| `migrations.ts` | 1 | schema history — not a read model; excluded |

## 7. Product decisions — RESOLVED & frozen by shiki (2026-08-17)

- **DM star-ability: YES.** `favorites.ts` = **HPB** folded into #2045: pair arm
  authorizes via participation (per §4a, not the workspace inner join); the
  `:129-136` "human never participates in a workspace-less placement" comment is
  deleted as factually wrong. Its unread dependency `unreadCountsByConversation`
  (`conversation-read-repo.ts:402`, roster-joins `conversation_users`) is **LFR
  promoted to HPB**: must include the DM arm via participation.
- **DM `@agent` CC-to-inbox: NO.** Behavior stays "no CC"; `mention-cc.ts:178`'s
  reason changes from `source_not_workspace_placed` to "this placement does not
  permit audience expansion". Classified **IAO/product**; capability naming +
  test corrected.

## 8. Non-goals for Milestone 1

- No migration / backend / renderer code (Milestone 2, post-PASS).
- No UI layout/visual work.
- Host-protocol physical-path fields untouched.

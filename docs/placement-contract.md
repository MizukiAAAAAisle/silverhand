# Canonical conversation-place contract (Milestone 1 of #task:2045)

> Status: **Milestone 1 (this contract) PASSed; Milestone 2 is landing
> incrementally against it.** Review owner for M2 tickets is @Paul. Rounds 1 (4),
> 2 (5), 3 (4), 4 (4), 5 (1), 6 (1) blockers all accepted in full; R6 unified
> Saved/Search onto the canonical `HumanConversationPlace` `kind` discriminant and
> collapsed the double workspace-kind source in Search.
>
> The M1 PASS covers **the contract, and is not an advance approval of any M2
> commit**. In particular M1 does **not** authorize a new persisted `place`
> column, nor freezing `channel_name` / `workspace_name` / `peer` presentation
> back into storage — that would destroy §4's live projection.

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
  proposed a package-semver regime — replaced by a scoped schema-epoch gate, itself
  retired in M2 once the "installed-CLI consumer" premise was falsified (see §6).
- **R5**: §3 invented a second discriminant spelling (`place_kind:
  'workspace'|'direct_pair'`) instead of reusing the canonical
  `HumanConversationPlace` `kind: 'workspace_channel'|'direct_pair'` — Saved/Search
  now reuse the canonical `kind`, extending presentation only on the
  `workspace_channel` arm (Task keeps its board-context `kind:'workspace'` legitimately).
  `SearchConversationPlace` carried both `SearchWorkspaceRef` (own `kind`) and a
  parallel `workspace_kind` (two contradictory kind sources) — collapsed to one by
  correcting `SearchWorkspaceRef.kind` to `regular | agent_space`. That surviving
  `kind` was itself retired in #task:2075 (see §2 rule 5 and §3): one source became
  no source.

## 1. Domain boundary + name is the first wall

In-scope read models (task board, saved, search, favorites) are human-viewer
faces. Human-viewable place: `placement_kind ∈ { workspace, direct_pair }`.
A third arc, `agent_inbox`, was an agent-runtime fact and never a human place;
#task:2072 retired that placement (v84/v85), so the stored alphabet and the
human-viewable set now COINCIDE. That is a fact about today's schema, not a
relaxation of this section — the two walls carry the same weight against a
different subject: `direct_pair` has no workspace coordinate
(`requireWorkspacePlacement` in `conversation-placement.ts` **throws** on
`workspace_id === null`, and a DM reaching a workspace-scoped surface is the
routing bug it always was), and the next placement added must arrive at a
refusal rather than at a silently omitted row. Identity core is named
**`HumanConversationPlace`**: the name is the first wall, fail-closed constructor
the second.

## 2. Minimal stable identity core — `HumanConversationPlace`

```
HumanConversationPlace =
  | { kind: 'workspace_channel'; conversation_id; workspace_id }
  | { kind: 'direct_pair';       conversation_id }
// constructor is TOTAL over placement_kind: these two arms are the whole stored
// alphabet today, and an unrecognized value throws (fail closed, not omit) — §1
```

Rules: (1) `conversation_id` single routing coord both arms. (2) workspace-like
only on `workspace_channel`; `direct_pair` fabricates no workspace/channel.
(3) no mutable presentation in the core. (4) no board namespace (`pair_key`) in
the core. (5) **NO container word at all** (see below). (6) no `{kind,value}` pair.

Rule (5) has been sharpened twice, and each version is stronger than the last —
the later one is the contract:

M2 (#task:2069, @Paul review finding; the original wording, "physical `agent_home`
stays behind the repo boundary", named the wrong axis — a reader would derive the
wrong rule from it):

> **The physical word may be READ, never PUBLISHED.**

The axis was WHERE THE WORD APPEARS, not which layer holds it and not who is
reading. Every read face carried the PROJECTED word `regular | agent_space` —
human and agent faces alike, because the ubiquitous language does not fork by
audience (a private dialect for agents costs a vocabulary translation on every
cross-surface inference).

#task:2075's stop-publish step (the current rule):

> **No container WORD is published — the ownership RELATION is.**

The projected word was never independent data: it merely restated the ownership
relation, so the boundary was translating a fact it could simply carry. Every
published face now carries `owner_agent_id` and asks "whose container is this"
through `isAgentHomeWorkspace*` (`packages/shared/src/agent-home-workspace.ts`) —
one fact, one spelling, and a face that needs the OWNER (not merely the kind) no
longer has to join for it. #task:2080 has since dropped the stored `workspace_kind`
word itself, proving it redundant: `owner_agent_id` is now not merely the published
spelling but the ONLY one that exists (the surviving schema CHECK ties it to
name-namespace membership — an agent home carries no name key). The projection
argument is therefore trivially true — there is no second carrier left to keep in
step.

Do NOT re-derive a container word from `owner_agent_id` at a read face: that moves
the alphabet rather than retiring it, and re-creates the two-spellings-of-one-bit
problem this step deleted (#task:2078 removed the last such derivation from the
renderer).

There are now **zero exceptions**. The rule can finally be phrased by boundary
alone: no container-alphabet word crosses ANY wire. The last survivor —
`RuntimeStartWorkspaceRefSchema.kind` on the host protocol — was retired by
#task:2081. The daemon used to read that stored word to select a filesystem
resolution strategy; it now recognizes an agent-home ref from the id convention
itself (`AGENT_HOME_WORKSPACE_ID_PREFIX` for the alphabet, exact match against
`agentHomeWorkspaceId(agentId)` for ownership — `daemon/runtime-start-resolve.ts`),
so the decision is keyed on the id, never on a copy of a word a product rename
could contradict. The two negative gates that pinned the survivor (the schema
field had to be `WorkspaceKindSchema` itself, and the wire had to reject the
published word) are gone with it. That removal folded into the same unreleased
`HOST_PROTOCOL_VERSION` generation — no separate bump (§8's host-protocol
physical-path fields remain untouched).

**The axis is the container alphabet's VALUES** — what a face says the kind IS.
Key spellings and id prefixes are not on it, so two things an `agent_home` grep
will hit on the wire are off-axis rather than counter-examples to the sentence
above: the `agent_home_workspace_id` field (the create-agent HTTP response and the
`agent_materialize` host frame — declared in `useCreateAgent`'s response type on
the renderer side, never read) and the `wsah_` id prefix, whose sole definition is
`AGENT_HOME_WORKSPACE_ID_PREFIX` in `packages/shared/src/agent-home-workspace.ts`
(its docblock already records that the prefix, its builder and its matcher live in
exactly one place). Neither is a value in the alphabet, neither can be keyed on to
branch, and respelling either buys no correctness — so they are deliberately left
alone (@Paul, verified twice), not missed. This paragraph is a live rule, not a
ledger entry: it exists to answer one future grep, so it anchors on names that a
rename would have to update anyway, never on line numbers that any unrelated edit
would silently falsify.

## 3. Per-bounded-context projections — one `place` per DTO, folded, no dual coord

- **Task — `TaskPlace`** (replaces `TaskBoardRef`; core folded into each arm):

  ```
  TaskPlace =
    | { kind: 'workspace';   conversation_id; workspace_id; channel_name }
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
  channel_name}` is complete (the container word that sat in this set went the same
  way and for a stronger reason — zero readers AND a second spelling of
  `owner_agent_id`; #task:2075). Consequence: Task has **no**
  workspace-name liveness obligation (§4-B does not apply to Task).
- **Saved [#task:2050] — `SavedMessageDto.place`, canonical `kind` discriminant.**
  It **reuses `HumanConversationPlace`'s `kind` and literals verbatim**
  (`'workspace_channel' | 'direct_pair'`), and only *extends presentation on the
  `workspace_channel` arm*. Today's flat
  `workspace_id/workspace_name/conversation_id/conversation_title/channel_id`
  fields are replaced by:

  ```
  SavedPlace =
    | { kind: 'workspace_channel'; conversation_id; workspace_id; channel_name }
    | { kind: 'direct_pair';       conversation_id }
  ```

  `workspace_id` is the canonical core (from §2);
  `channel_name` is the one embedded presentation field, bound to workspace
  identity **in the same arm** — a `direct_pair` row cannot carry it (impossible
  to construct), and a `workspace_channel` row cannot carry peer presentation.
  **`workspace_name` is deleted from this arm** (F1, #task:2050 review — aligns
  with `TaskPlace`, §3): a workspace's name is its aggregate's mutable field, so
  the renderer joins it live from `['workspaces']` (kept fresh by §4-B) instead
  of freezing a per-read-model snapshot. Saved therefore has **no** frozen
  `workspace_name` to invalidate (§4-B applies to Saved only as the authority-layer
  refresh of `['workspaces']`, exactly as for Task). `channel_name` stays embedded
  — aligned with the shipped `TaskPlace` — and is the one presentation field §4-A
  keeps live. The pair arm holds only `conversation_id`; peer name/avatar is
  resolved by that id through the DirectPair carrier (§4-C), never frozen. Common
  fields (`message`, `saved_at`) stay outside the discriminant.
  Because the discriminant is the canonical one, the shared constructor and
  exhaustiveness checks are reused — no second spelling of the same `place`.

  > **#task:2045 endgame (coordinate-only, deferred — not #2050/#2051):** the
  > long-term target strips `channel_name` too, so `SavedPlace`/`SearchConversationPlace`
  > carry only coordinates and the renderer joins every name. The client
  > channel-name join authority **already exists** (`useChannelsAcrossWorkspaces`,
  > board already reads it), so this is a three-consumer convergence + a `TaskPlace`
  > retrofit, NOT new infrastructure. It is gated on shiki sequencing because the
  > retrofit touches shipped #2041. Until then Saved embeds `channel_name` + §4-A,
  > aligned with #2041.

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
    `SearchWorkspaceRef`; there is **no** parallel `workspace_kind` field beside it
    (that duplicate was the double-source of truth that could construct two
    contradictory kinds). M2 made the ref the single source by correcting its own
    `kind` from `'regular' | 'dm'` to the published `'regular' | 'agent_space'`;
    #task:2075's stop-publish step then deleted that `kind` as well and the ref
    carries **`owner_agent_id`** instead (#task:2075-A1 added the arc BEFORE the word
    left, so no face was ever wordless-and-arcless). One kind source became zero, and
    the question "which kind of container" is answered from the relation.
  - `type: 'workspace'` is a **named-entity result, NOT a conversation place** — it
    reuses **the same** `SearchWorkspaceRef`, carries no `conversation_id`, and can
    never be a `direct_pair`.
  `type` selects the result kind; the canonical `kind` selects the placement inside
  the two conversation-bearing arms; exactly one place per DTO, no container word on
  any of them, no parallel unions that could contradict.

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
  `ViewerWorkspaceChange = 'added' | 'role_changed' | 'removed' | 'metadata_changed'`
  (the fourth member landed in `0e54c09e`, consumer-side whitelist in `3be6ca86`); the rename
  path (`workspaces.ts:210`) publishes `publishViewerWorkspacesChanged(ctx,
  userId, { change: 'metadata_changed', workspace_id })` to **each human viewer of
  the workspace**. This reuses the existing contract: the renderer treats the
  payload as a hint and refetches `['workspaces']` as the authority
  (`docs/viewer-visibility-sync-v1.md`). It does **not** fall out for free — the
  consumer guard `isViewerWorkspacesChangedPayload` (`features/workspaces/hooks.ts`)
  fail-closes any `change` it does not recognize, so `'metadata_changed'` had to be
  added to that whitelist (F3, #task:2050); otherwise the producer edge is a dead
  letter and the F1 join is as stale as the embed it replaced. Pinned by
  `decideViewerSyncInvalidations`' branch test ("invalidates the workspace list on
  metadata_changed"). A dedicated `workspace_metadata_changed` event is
  **rejected**: the payload shape does not diverge, the scope
  (`viewer:${userId}`) is identical, and a second carrier for the same fact
  would fork the "one owner for the event" invariant this module exists to hold.
- Subscribers (M2): **Search results only** invalidate a *frozen* `workspace_name`
  on `change: 'metadata_changed'` (distinct from the 4-A channel-name
  registration) — that is a SEPARATE query key `decideViewerSyncInvalidations` does
  not touch, so it is the **#task:2051 consumer's** obligation, reviewed on the same
  yardstick as F3. **Task and Saved do not** — both deleted `workspace_name` (§3,
  and F1 for Saved) and resolve the workspace name from the live `['workspaces']`
  directory, so neither has a frozen copy to invalidate. For them §4-B is the
  authority-layer edge that keeps `['workspaces']` itself fresh on rename — the
  join they read from — so liveness is proven ONCE at the authority rather than
  re-proven per read model. (The #2045 endgame retires the Search frozen copy too;
  see §3.)
- Falsifier: rename a **workspace** with no task/message/membership change →
  - the workspace-list authority `['workspaces']` refreshes so Task/Saved joined
    names follow — **live as of F3** (producer `routes/workspaces.ts` + consumer
    whitelist + branch test);
  - any Search row's *frozen* `workspace_name` refreshes — **still fails today**;
    the producing edge exists, but the Search consumer key is unwired until #2051.


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
from a Place DTO's `workspace_id` / `owner_agent_id` / `pair_key`.** Authorization ALWAYS
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

## 6. `TaskNavRef.channel_id` → `conversation_id` — destructive rename, no bridge (R4 blocker 4, **AMENDED in M2**)

**M2 amendment (2026-08-18, @Paul ruling): the compat phase and its epoch gate are
RETIRED — unbuilt, not deferred.** The rename lands in one commit; the field is
`conversation_id`; there is no dual-emit and no `SILVERHAND_CLI_API_EPOCH` /
`MINIMUM_CLI_API_EPOCH`.

This is not a reversal of R4's reasoning — it is R4's own rule applied after its
premise was falsified. R4 granted the compat phase because the field had "a proven
installed-CLI consumer (`packages/cli/src/commands/task.ts` `nav.ref.channel_id`)".
That grep hit is `task detail --help` **prose**, and the CLI does not parse this
response at all (`client.ts` `getTaskDetail` is a typed passthrough; the file
contains no `parse`/`safeParse`) ⇒ **removing the field cannot make any installed
CLI throw.** With no consumer, R4's own closing rule applies — the same treatment
the top-level task `channel_id` gets in §3: destructive delete, no bridge. R4 also
wrote that an un-gated compat phase is rejected outright, so nothing here survives
the corrected premise either way.

Two further reasons the epoch gate was the wrong instrument, independent of the
premise: it would have been a **third** protocol axis next to
`desktop-server-api-epoch.ts` (self-described as "the SINGLE ROOT … One boundary,
one axis") and the daemon↔backend `OUTBOUND_PROTOCOL_VERSION`; and the surface it
was meant to guard is prose frozen in a client, which no handshake can admit or
refuse — so it could never state an exit condition.

**Substituted verification (same commit, ~3 lines):** the field-path placeholder
table in `packages/cli/tests/help-address-grammar.test.ts` is DERIVED from
`TaskNavRefSchema`'s keys instead of hardcoded. Hardcoded, it only reddened when
prose grew an unknown placeholder; a schema rename with untouched prose stayed
green — exactly the direction nobody guarded. Derived, that divergence is
permanently red. The guarded object moves from "an old binary on someone else's
machine" to "prose and schema inside ONE build must not disagree".

**Residual risk, priced:** embedded/loopback ships backend and CLI as one artifact
⇒ zero skew. Only hosted mode has a window, within one protocol generation, where
older help prose teaches the old key name; the cost is one typed 404
(`target_unresolved`, from `delivery-target.ts`'s closed rejection vocabulary — a
malformed address is rejected pre-flight as `target_malformed`) plus a re-read of
`nav`. In-band recoverable, no data loss. That cost does not buy a machine gate.

Contrast retained: the top-level task `channel_id` (§3) likewise has NO external
consumer → destructive delete, no bridge.

## 6b. Full workspace-require self-audit — corrected cardinality, zero-omission (R3 blocker 1)

Classes: **WOD** workspace-only by domain · **HPB** human-place bug · **IAO**
internal/agent-only · **LFR** latent forbidden reuse.

### `requireWorkspacePlacement(...)` — universe = **16 production calls** (excl. the `:62` shared definition) = **16 WOD**, zero omitted

| Site | Class | Reason / guard-falsifier |
|---|---|---|
| `viewer-scope.ts:171` | **WOD** | DM handled by the parallel `publishUnreadUpdated` direct_pair branch (comment `:160`) |
| `observe.ts:336` | **WOD** | `direct_pair` intercepted at `:329` (`publishDirectPairsChangedToViewer`); since #task:2072 retired `agent_inbox`, workspace is the only placement left to fall through, so the call is the DECLARATION that what follows is workspace-scoped rather than a live branch |
| `conversation-repo.ts:848` | **WOD** | inside the `WORKSPACE_PLACED` predicate; the assert ties the SQL filter to the non-null DTO field |
| `attention.ts:189` | **WOD** | `getChannel` filter guarantees open-roster⇒workspace; every fixed-roster row, `direct_pair` included, already 404s there |
| `channel-service.ts:713/869/932` (×3) | **WOD** | channels are a workspace-only aggregate (invariant #3) |
| `conversation-member.ts:260/541/622/667/905/963/1101/1208/1477` (×9) | **WOD** | membership/roster is a workspace concept; DirectPair has endpoints, not members; M2 asserts these paths reject a direct_pair |

**16 WOD = 16.** (R3 correction: my prior "18 production / 17 WOD" wrongly
counted the `:62` definition line into the total. #2050 RESOLVED the one HPB by
REMOVAL: `saved-message-repo.ts` `save()` no longer calls
`requireWorkspacePlacement` at all — it asserts a `SavedPlacementError`
on `placement_kind` instead, so `direct_pair` is saveable while any placement
OUTSIDE the participatory set still fails closed. `agent_inbox` was that outside
arm until #task:2072 retired it; the refusal is kept as the default branch, so it
now binds the next placement added rather than a value this schema can store.
The universe therefore shrank 17→16 and is now purely WOD.)

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
| `saved-message-repo.ts` `listForUser` | **LFR→HPB, FIXED (#2050)** | was a hand-written `EXISTS(conversation_users)` that returned false for every `direct_pair` ⇒ DM saves persisted (201) and read by id but were silently dropped from the list. Now delegates to `userParticipates('conv', userId)`. Falsifiers in `tests/repos/saved-message-repo.test.ts`: save+list a `direct_pair` message returns it; a stale seat without `workspace_users` membership does NOT list (membership conjunct); a workspace member with NO channel seat does NOT list (seat conjunct — see name-join guardrail below) |
| `saved-message-repo.ts` `getByMessageIdForUser` | **OPEN, non-blocking (#2050)** | does NOT re-derive participation — it self-limits on `sm.user_id` and is called ONLY as `save()`'s post-write echo, behind the route's `canViewConversation` ACL, reading back the row the caller just wrote (no reachable stale-reader path). A docblock states the invariant. If it EVER gains a second, standalone caller, that caller must add the `userParticipates` gate first. Recorded here (not only in the comment) so a future reader is enumerated, not rediscovered |

**Agent-side roster reads (`conversations.getAgent` — a `conversation_agents`
row query, the agent twin of `EXISTS(conversation_users)`).** Same rule, same
failure mode: `getAgent` agrees with `agentParticipates` only on the workspace
arm and returns `null` for every rosterless `direct_pair` placement, so any
surface that gates on it silently excludes real endpoint agents. Enumerated here
alongside the human-side reads so the disposition is recorded once, not
re-derived per site:

| Site | Class | Disposition |
|---|---|---|
| `runtime/event-perimeter.ts` step 4, wired at `adapters/runtime-fanout.ts` | **LFR→FIXED (#2048)** | the runtime ingress perimeter fed `getAgent` as its admission predicate ⇒ every DirectPair / agent-inbox agent's parsed-event frame (activity, `runtime_delivery_consumed`, run-state) was dropped with `reason:'agent_not_in_conversation'` ⇒ the DM Activity feed was **permanently empty** (read face returns 200 + `events:[]`, worse to diagnose than the 404 it replaced). Now delegates to `isAgentParticipant`; the perimeter's `RuntimePerimeterConversationReadPort.hasAgent` port method was renamed `isAgentParticipant` so the port name states the authority. Falsifier walks the REAL wiring (not the fake-port guard test): `tests/runtime/outbound-event-fanout.test.ts` "rosterless DirectPair endpoint agent parsed-event frame through the REAL ingress perimeter". The `agent_not_in_conversation` drop-log reason is retained — it is the only runtime signal for this class of hole |
| `routes/conversations.ts` activity GET (`…/agents/:aid/activity`) | **LFR→FIXED (#2048, read face)** | authorized the target agent via `getAgent` ⇒ 404 for a real DirectPair endpoint. Now `isAgentParticipant`. Falsifiers in `tests/routes/conversation-activity.test.ts` (endpoint 200, non-endpoint 404 = unknown, non-viewer 403) |
| `routes/conversations.ts` `start` / `stop` / `clear-session` control plane | **WOD by consumer** | each reads `getAgent` before acting on an agent-in-conversation. For `direct_pair` this is **unreachable today** because the renderer collapses the roster surfaces that would issue these calls (`ChannelView` `rosterTarget===null`; `AgentInfoPopover` `if (!row) return null`). Classified WOD, not FIXED — the conclusion depends on a consumer-side fact, so it is recorded here rather than re-derived. If a renderer ever exposes per-agent control on a pair, these must move to `isAgentParticipant` first |
| `runtime/outbound-event-fanout.ts` clear-session peer-audit fanout | **WOD by same consumer (#2048 F3)** | after clearing a session, the audit row is delivered to the cleared agent directly (`inbox.ensureDelivery`, unaffected) AND to every *other* agent in the conversation via `listAgents(conversationId)`. On a `direct_pair` that enumeration is empty ⇒ the counterpart agent would receive no audit row. **A second roster read gated behind the SAME `clear-session` WOD as the row above** — so it is unreachable today for the identical reason, but the failure it would produce is a SILENT missed delivery (not a 4xx), which is worse. Recorded alongside the control-plane row it depends on: the day that WOD lifts, this must move to a participation enumeration in the same change |

**Name-join guardrail (F1, #2050 — the participation-only invariant, made
executable).** The renderer joins mutable names (`workspace_name` today;
`channel_name` at the #2045 endgame) from live authorities keyed by
`conversation_id` instead of freezing them per read model (§3, §4-B). That model
is sound ONLY while task/saved visibility stays **participation-only** — a
conjunction of a conversation seat AND (workspace arm) live `workspace_users`
membership, per `userParticipates` and `task-repo.ts:100` "public discovery
grants no task read". If visibility ever widened to "workspace member may read",
the join would surface names for channels a viewer discovers but never joined,
which an embedded snapshot would not — that is the exact axis on which the thesis
fails, and the real falsifier to watch (stronger than "place carries no mutable
name"). It is pinned by behavior, not prose:
- **Saved axis:** `tests/repos/saved-message-repo.test.ts` — "hides a channel the
  workspace-member viewer never joined (public discovery grants no read)".
- **Task axis (#task:2045 obligation):** the board-population test must carry the
  mirror — a workspace member with no channel seat sees neither the task nor the
  saved row. If either test reddens or is deleted, that is the moment the live
  name-join begins leaking; treat it as a contract change, not a test fix.


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
- **DM `@agent` CC: NO.** Behavior stays "no CC" when the SOURCE is a DM. The
  destination this item called "the inbox" was retired with the placement
  (#task:2072) — a CC now lands in the direct pair between the agent and the
  person who mentioned it — so the ruling is about the SOURCE placement, not the
  destination. Shipped form (#task:2021 P4-4/P4-5): `mention-cc.ts`'s
  `source_not_workspace_placed` is a REPORTED SKIP, not the throw M1 proposed to
  rename, because a DM source carries no workspace coordinate to key the wrap
  text and the `mention_external` row with. Classified **IAO/product**;
  capability naming + test corrected.

## 8. Non-goals for Milestone 1

- No migration / backend / renderer code (Milestone 2, post-PASS).
- No UI layout/visual work.
- Host-protocol physical-path fields untouched.

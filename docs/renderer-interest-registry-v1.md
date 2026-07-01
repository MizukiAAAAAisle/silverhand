# Renderer Interest Registry (v1) — design draft (#task:1260)

> Status: **rev 3 — P1 + P2 landed (2026-07-01). All 10 renderer slices
> migrated; both gates PASS (Alice transport + Cindy correctness) per slice.**
> The InterestRegistry is the sole `subscribeWsScope` caller for **product
> conversation readers** (message-stream + side); the dev EventStream remains a
> deliberate out-of-scope direct observer on the conversation-side scope, and
> viewer/app/workspace/tasks keep their own direct calls (later slices). P3 is
> doc-only (no dead code to delete — see §5). Everything local/unpushed; push +
> close + dogfood are shiki's.
>
> Canonical facts about transport seq spaces, the single-fanout-source non-goal,
> and satisfaction/floor semantics live in `docs/event-ws-transport-v1.md` and
> `docs/architecture-principles.md` §10. This doc **references** them and defines
> only the renderer-side interest seam. It must not restate transport invariants.

## 0. TL;DR — what #1260 is, and (louder) what it is NOT

**Not a correctness fix.** The "never miss a frame across view churn" guarantee
was already won by #task:1251 (orphan-frame gate, retained resume floor) and
#task:1255 (central ingestor owns apply+cursor atomically, off the view
lifecycle). Correctness does **not** depend on which React components are
mounted. Nothing here fixes a live bug.

**What it is:** a *structural* upgrade. "WS subscription is a bandwidth
optimization, not a correctness boundary" is true today **by discipline** —
smeared across many per-hook `useEffect(subscribeWsScope)` sites. #1260 makes it
**structural and testable**: one renderer authority owns interest for a defined
scope group, its readers become provable cache-only, and a scoped static fence
makes "one of those readers subscribed directly" a test failure. This is the
terminal-state move the three-way review agreed on: *re-guard by structure the
boundaries currently held by convention.*

## 1. Current state (grounded) + subscriber inventory

Two layers already existed and were already decoupled; P2 added the interest seam
on top:

- **Transport** (`renderer/lib/ws-client.ts`): `subscribe(scope)` is
  **refcounted** (`desiredScopes`, L209). Last-unsubscribe (`count → 0`, L221-259)
  sends `unsubscribe`, **drops** `satisfiedPending` (backlog — `80aec14`, #1261)
  + in-flight recovery buffers, but **retains** `appliedPositions` (resume floor)
  + `receivedPositions` so a resubscribe resumes+replays the no-listener gap
  (#1251). `subscribeWsScope(scope)` (L898) is the thin wrapper;
  `subscribeViewerScope()` (L911) wraps the **deferred** `viewer:<id>` scope
  (canonical id unknown until the `authenticated` frame; independent
  detach/re-attach lifetime via `viewerSubscribers`, L200-202).
- **Readers** now declare interest via `useInterest(scope)` (the registry) with
  **no** `onWsFrame` listener — except the two own-listener bridges below, whose
  *interest* also routes through the registry while their listener stays.
- **Ingestor** (`useConversationIngestor` @ `App.tsx:234`): the **sole**
  `onWsFrame` consumer for conversation frames; owns apply+cursor; holds zero
  subscriptions.

**Migrated subscribers (P2 — all landed).** The 8 pure interest-declarers below
each swapped `useEffect(subscribeWsScope)` for `useInterest`, nothing else moved
(the central ingestor consumes their frames, #1255):

### MIGRATED — pure interest-declarers (conversation message-stream + side)
| Reader | Site | Scope family | Slice |
|---|---|---|---|
| useChannelThreads | `useChannelThreads.ts` | `conversation:<id>` | 1 |
| useAgentActivityFeed | `useAgentActivityFeed.ts` | `conversation-side:<id>` | 2 |
| useThreadRoot | `channels/hooks.ts` | `conversation:<id>` | 3 |
| useThreadFollowers | `channels/hooks.ts` | `conversation:<id>` | 4 |
| useThreadCluster | `channels/hooks.ts` | `conversation:<id>` | 5 |
| useChannelMessages | `channels/hooks.ts` | `conversation:<id>` | 6 |
| useChannelAgents | `channels/hooks.ts` | `conversation-side:<id>` | 7 |
| useAgentRunStates | `channels/hooks.ts` | `conversation-side:<id>` | 8 |

### MIGRATED — distinct slices (own `onWsFrame`; interest moved, listener kept)
| Case | Site | Scope | Slice | Note |
|---|---|---|---|---|
| useConversationStream (read-inert bridge) | `useConversationStream.ts` | `conversation:<id>` | 9 | Owns its own `onWsFrame` listener (read-inert, `d3d03d7`). Only its *interest* moved to the registry; the listener + synthetic-`connected` replay are untouched. Interest keys on `conversationId` alone (transport scope is independent of the routeScope arg). |
| useConversationMembers | `useConversationMembers.ts` | `conversation-side:<id>` | 10 | Owns its own `conversation_members_changed` listener (not moved to the ingestor in #1255). Same treatment: interest → registry, listener untouched. |

### OUT OF SCOPE — deliberate direct callers (own future migrations, NOT #1260)
| Scope family | Sites | Disposition |
|---|---|---|
| **dev EventStream** | `components/dev/EventStream.tsx:69` — `subscribeWsScope(wsConversationSideScope(id))` | **A conversation-side direct subscriber that remains by design.** This is why the sole-caller claim is scope-qualified to *product* conversation readers, NOT the entire conversation scope group (§2). Observe-only dev panel; later or never. |
| **viewer** (`subscribeViewerScope()`) | `attention/hooks.ts`, `channels/hooks.ts`, `favorites/hooks.ts`, `notifications/hooks.ts`, `saved/hooks.ts`, `workspaces/hooks.ts` | Migrated **last**. Needs its **own dedicated entry** (NOT the generic string `retain`) — canonical id deferred to `authenticated`, independent detach/re-attach lifetime. Future-migration constraint, not a v1 method (Q2). |
| **`app`** | `agent-sync.ts:77`, `presence/hooks.ts:75` | App-level singleton; later slice. |
| **`workspace:<id>`** | `workspaces/hooks.ts:462` (single), `:776` (multi) | Later slice. |
| **tasks** | `tasks/hooks.ts:65` (multi) | Later slice. |

## 2. The seam — `InterestRegistry`

A single renderer-global registry, the **sole caller of `subscribeWsScope` for
*product* conversation readers** (§3.4 — the dev EventStream stays a deliberate
out-of-scope direct observer on `conversation-side:<id>`, and other scope
families remain unmigrated, so this is *not* a global-sole-caller claim; see the
named invariant §4.5).

```ts
type Scope = string;            // a transport scope, e.g. wsConversationScope(id)
type HolderToken = string;      // stable per interest-holder instance

interface InterestHandle { release(): void; }

interface InterestRegistry {
  // Generic string-scope interest. Idempotent per (scope, holder).
  retain(scope: Scope, holder: HolderToken): InterestHandle;
  snapshot(): ReadonlyMap<Scope, ReadonlySet<HolderToken>>;   // diagnostics / leak attribution
}
// NOTE: viewer scope is NOT in v1 (see §1 out-of-scope). When it is migrated
// later it will need its OWN dedicated entry (NOT this generic string `retain`)
// because its canonical `viewer:<id>` is unknown at retain time (resolved on the
// `authenticated` frame) and it has an independent detach/re-attach lifetime
// (`viewerSubscribers`). Recorded here as a future-migration constraint — not a
// v1 interface method (Alice+Cindy Q2).
```

**Internal shape (Cindy B2 — corrected).** One transport subscription *per
scope*, not per holder:

```ts
type Entry = {
  subscription: WsScopeSubscription;      // scope-level, created once on 0→1
  holders: Map<HolderToken, number>;      // token → generation
};
const scopes = new Map<Scope, Entry>();
```

- `retain(scope, holder)`: if no entry, `subscription = subscribeWsScope(scope)`
  (0→1). Bump the holder's **generation** and record it; the returned handle
  captures `(scope, holder, generation)`.
- `handle.release()`: **idempotent + generation-safe** — it removes the holder
  **only if** the entry's current generation for that token equals the handle's
  captured generation. This is the load-bearing edge (React StrictMode double-
  invoke; a scope change that releases-then-retains the same token): a *stale*
  handle must never evict a *fresh* holder. When the holders map empties, call
  `subscription.unsubscribe()` once and delete the entry.
  - **Why correctness, not counting-hygiene (Alice, transport view):** a stale
    gen-1 `release()` evicting a gen-2 holder empties the holder set → the
    registry calls transport `.unsubscribe()` on a **still-watched live scope**
    → `satisfiedPending` dropped (L240) + a real unsubscribe frame sent → the
    channel the user is looking at silently enters a no-listener gap with no
    re-subscribe. Generation-safe release protects a transport state invariant;
    it is not a numeric nicety.

## 3. Answering the must-answer checklist (Cindy) + gate rulings

**3.1 InterestKey shape.** Transport key = the scope string (grammar unchanged,
reused from `ws-frames.ts`). Interest tracked as `(scope, holderToken,
generation)`; `holderToken` is a stable per-hook instance id (`useId()`), not a
scope, not a component name — re-render never double-counts and `snapshot()`
attributes a leak to a token.

**3.2 Who retains / releases.** In v1, the slice-1 reader hooks, through
`useInterest(scope)` — a thin wrapper over `subscribeWsScope` (typo fixed from
rev 1) via the registry — retain on mount / release on unmount, keyed by scope.
The registry (not the view) owns the actual unsubscribe decision, leaving room
for later policy **without touching views**; v1 ships pure pass-through
(release→0 unsubscribes immediately).

**3.3 Refcount 归零时机.** When a scope's holder set empties → registry calls the
stashed `subscription.unsubscribe()` exactly once. The holder set is the single
renderer authority for "do we still want this scope."

**3.4 How it calls `subscribeWsScope` — and the "sole caller" scoping.** For a
migrated conversation scope the registry calls `subscribeWsScope` once (0→1) and
`.unsubscribe()` once (n→0). It is the sole caller **for *product* conversation
readers only** — NOT the entire conversation scope group: the dev EventStream
(`components/dev/EventStream.tsx`) is a deliberate out-of-scope direct subscriber
on `conversation-side:<id>`, and viewer/app/workspace/tasks keep their own direct
calls until their own slices. See the named invariant §4.5. The transport
refcount stays the resilient lower guard and legitimately holds >1 whenever a
migrated product reader and the dev observer (or, historically, a mid-migration
raw caller) watch the same scope. **Q1 ruling (Alice+Cindy reconciled — no
tripwire):** *no* dev refcount assertion, not in v1 and not scheduled. Coupling a
diagnostic to transport-internal `desiredScopes` refcount is exactly the internal
leak to avoid. The static fence (§6) + registry unit tests cover the known
surface; a dev-only diagnostic is a *possible future add only if drift is
observed in practice*, not a planned step.

**3.5 interest→0 reuses `80aec14` backlog-drop (no second implementation).** The
registry has **zero** backlog/floor logic. `release → 0` → transport
`.unsubscribe()` → the existing last-unsubscribe path drops `satisfiedPending`,
retains floor/received-water. This structurally forecloses the "view released but
floor still pends a seq nobody holds" deadlock (Alice verified L221-259). The
registry's only obligation is exactly-once unsubscribe per interest→0 — enforced
by the generation-safe idempotent handle (§2).

**3.6 Which readers stay pure cache readers (own no floor).** **All slice-1
readers — unchanged.** No reader owns the floor (ingestor + ws-client do);
#1260 does not move that. Readers move from `useEffect(subscribeWsScope)` to
`useInterest(scope)`; they still hold no `onWsFrame` listener, never call
`markSatisfied`/`commitSnapshotBaseline`, only read ingestor-written caches.
(useConversationStream keeps its read-inert listener — that's its bridge role,
orthogonal to interest, untouched.)

## 4. Invariants this design must not break

1. **Floor ownership unchanged** — cursor/floor stays in ws-client + ingestor.
2. **Backlog-drop reused, never reimplemented** (§3.5).
3. **Readers stay cache-only** (§3.6); ingestor stays sole `onWsFrame` consumer.
4. **Scope grammar reused** from `ws-frames.ts`.
5. **Sole-caller is slice-scoped, not global** (§3.4) — the doc must never claim
   a global invariant the migration hasn't reached. *Concrete instance (as of
   P2):* the registry is the sole `subscribeWsScope` caller for **product
   conversation readers** only; `components/dev/EventStream.tsx` remains a
   conversation-side **out-of-scope direct observer**, and
   viewer/app/workspace/tasks keep their own direct calls. Future migrations
   (viewer/app/workspace/tasks/dev) may only **extend the migrated slice set** —
   they must not let this scope-qualified claim drift into "the registry is the
   global sole caller."
6. **Generation-safe release** (§2) — a stale handle never evicts a fresh holder.
7. **Behavior-preserving v1** — same subscribe/unsubscribe frames for the same
   view lifecycle; only the *origin* of the calls changes. Policy (sticky/
   debounce) is out of #1260 entirely (Q4 split).

## 5. Migration (P1 + P2 LANDED — P3 doc-only)

- **P1 — centralize, behavior-preserving. (LANDED)** Add `InterestRegistry` +
  `useInterest`. Pure pass-through refcount. Migrate **no** reader yet; the fence
  P1 ships is the **registry-source inert fence** (the registry module holds no
  floor/cache/read/viewer logic) + registry unit/churn tests. The reader
  direct-subscribe **deny-list is NOT built in P1** — it starts and grows from
  P2's first reader migration (§6). Prove: identical subscribe/unsubscribe
  sequence vs today.
- **P2 — migrate readers one at a time. (LANDED — 10/10 slices)** The 8 pure
  interest-declarers in §1's MIGRATED table (slices 1-8), then
  useConversationStream (slice 9) and useConversationMembers (slice 10) each as
  their **own** slice (both own an `onWsFrame` listener — migrated their interest
  without touching their listener). Each slice proved: unmount is not a
  correctness boundary (frame during unmount→remount lands via resume-replay);
  interest→0 doesn't pin the floor; side vs message scope never cross. Both gates
  (Alice transport-boundary + Cindy correctness) PASS per slice.
- **P3 — doc-only closeout. No dead code to delete.** `subscribeWsScope` is
  **not** dead: it stays the registry's transport primitive and the direct
  primitive for the out-of-scope groups (dev EventStream, viewer/app/workspace/
  tasks). P3 = converting the reader fences to terminal-state (each migrated file
  denies `subscribeWsScope(` + requires `useInterest(`), scope-qualifying the
  sole-caller claim (§2/§3.4/§4.5), and this migration table. No Q1 tripwire
  (§3.4 — a diagnostic is added later only if drift is observed). **App-level
  sticky policy is NOT here** — it's a separate follow task co-landing with
  S2/S3 (Q4).
- **Later slices (own tasks):** viewer (via a dedicated entry), app, workspace,
  tasks, dev EventStream.

## 6. Test surface

- **Two distinct fences — do not conflate their timelines:**
  - **(P1, shipped) registry-source inert fence** — the registry module holds no
    floor (`markSatisfied`/`commitSnapshotBaseline`/`recordPosition`), no cache
    (`invalidateQueries`/`setQueryData`/`removeQueries`), no read writers, and no
    `subscribeViewerScope`. This exists now; it guards the registry from growing
    logic it must never own.
  - **(P2 onward) reader direct-subscribe deny-list** (Cindy B3 — mirrors
    `realtime-ingestion-read-inert.test.ts`): an **explicit allow/deny file
    list**, not a blanket `features/**`. Deny `subscribeWsScope(` only in a
    reader file **once that reader is migrated**; the registry becomes the sole
    allowed caller for the migrated group. It **starts empty and grows one entry
    per P2 slice** — P1 builds no direct-subscribe fence over unmigrated readers
    (a blanket fence now would false-red every still-raw scope).
- **Registry unit**: retain idempotent per (scope, holder); n≥2 holders → one
  transport subscribe; last release → exactly one `.unsubscribe()`; retain after
  full release → fresh subscribe (resume path intact); `snapshot()` leak
  attribution.
- **Churn stress slice (Cindy Q3)** — not a big e2e, but covers: same scope
  multiple holders; scope change (release old + retain new same token);
  StrictMode-like double `release()` (idempotent, generation-safe — stale handle
  doesn't evict the fresh holder); **n→0→n resubscribe does not borrow old
  state** (after full release + re-retain, the new subscription resumes from the
  retained floor and does **not** reuse a dropped `satisfiedPending`).
- **No floor writes**: registry module contains no `markSatisfied` /
  `commitSnapshotBaseline` / position mutation (source fence).

## 7. Gate rulings (resolved this rev)

- **Q1 (tripwire):** not in v1 and not scheduled — Alice withdrew her P3-arm and
  adopted Cindy: coupling a diagnostic to transport-internal refcount is the
  internal leak to avoid, and it can only arm post-migration (zero help in the
  risky window). A dev-only diagnostic is a possible future add only if drift is
  observed; static fence + unit tests are the guard.
- **Q2 (viewer):** out of slice 1, migrated last. A dedicated entry (NOT the
  generic string `retain`) is recorded as a *future-migration constraint*
  (canonical id deferred to `authenticated` + independent lifetime), not a v1
  interface method.
- **Q3 (churn):** churn stress slice added to §6 (Cindy).
- **Q4 (app-level policy):** **split to a follow task**, behavior-preserving
  #1260 only (Alice+Cindy+Norman). Policy changes *when* unsubscribe fires →
  *when* `satisfiedPending` drops = correctness-adjacent; folding it in would
  break the P2 same-sequence regression proof.

### Blockers from rev 1 → resolved
- **B1 (scope inventory / first-slice boundary):** §1 full inventory + explicit
  slice-1 in/out tables (recommended option: conversation message-stream +
  conversation-side product readers only).
- **B2 (registry internal shape):** §2 corrected to scope-level `subscription` +
  `holders: Map<token, generation>` + generation-safe idempotent `release()`.
- **B3 (fence scope):** §6 scoped to an explicit migrated-file allow/deny list,
  not `features/**`.

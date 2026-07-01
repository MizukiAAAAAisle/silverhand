# S2 — brand-typed seq: renderer consumption half (#task:1267)

> Status: **implementation baseline rev 5 (2026-07-02).** Aligned to
> the signed **#task:1266 contract** (`docs/brand-typed-seq-v1.md`, @Alice). That
> doc is the single owner of the brands, their lifetimes, and the conversion
> seam; **branding decisions here defer to it.** This doc is the **renderer
> consumption inventory + migration-point map** only.
>
> rev 2 folded Cindy's round-1 review (real `streamSourceAtSeq` name + pending
> seq + full read surface + close-watermark). rev 3 folded round-2 Blocker 4
> (mainline visible-tail read gate) + `first_unread_seq` note. **rev 4 aligns to
> #1266**: (a) corrects §0 — #1265 is **Axis B** (`?? 0` optionality collapse),
> which branding does **not** fix, so this doc is not "the antidote to #1265";
> (b) locks pending → `PendingMessage` type split, no `PendingSeq` brand (contract
> §6 Q5); (c) marks all §4 open questions RESOLVED by contract §6.
> **rev 5 folds Cindy's slice-2 finding (§3.6): the renderer wire is a *typed
> trust boundary* (`api<T>()` = `JSON.parse as T`, no `.parse()`), not a runtime
> decoder — brands are minted server-side at DTO construction; the renderer's only
> genuine runtime decode boundary is localStorage hydrate.**
> Review boundary (Cindy) still holds: (1) renderer authors no second seq
> definition; (2) no `number` escape hatch; (3) every cross-brand conversion is a
> **single, testable** point.
>
> **Implementation status (2026-07-02): slices A + B + C LANDED (local, unpushed).**
> A = test-fixture decode helper (`49d9392`). B = `PendingMessage` type split
> (`17c0b3d` + affordance/cursor fixes `42fa266`/`abca162`; Cindy PASS). **C =
> MessageSeq/ReadSeq consumption tightening, in five rollback-able commits: §3.2
> `connected.seq` deletion (`a5bfe46`); §3.1 thread mark-read chain + the single
> `asReadSeq` mint (`ecbe683`); §3.4 close-watermark localStorage decode
> (`acd9d48`); §3.5 mainline tail read gate (`322e117`); §6 consumption fences
> (`2d80e07`).** Behavior-preserving throughout; desktop typecheck + full suite
> (1263 tests) green. **TransportSeq/TransportEpoch cut LANDED too** (the
> transport-lane census, coordinated with Alice's `ws-frames.ts` half `814504a`):
> `lib/ws-client.ts` `ResumePosition` + `satisfiedPending` set are branded
> `{ epoch: TransportEpoch; lastSeq: TransportSeq }`, `markSatisfied` takes
> `(TransportSeq, TransportEpoch)`, and **every resume-floor advance routes through
> the shared `advanceTransportSeq` boundary** (the drain loop + the two
> gap-detection compares) — zero raw `.lastSeq + 1`, zero `as` cast. The §6 fence
> gained two cases locking that: raw `.lastSeq ± 1` is banned tree-wide and
> `advanceTransportSeq(` is allowed only in `lib/ws-client.ts`. `conversation-
> ingestor.ts` needed no production change (it already consumes branded frames);
> only its test fixture decodes the transport seq via `decodeTransportSeq`. Full
> desktop suite (1265 tests) + typecheck green.

## 0. Two axes — and what the renderer's role is on each

Contract #1266 §1 establishes S2 has **two axes**, and #1265 belongs to the one
branding does *not* fix:

- **Axis A — space mixing.** One ordinal space assigned/compared to another. The
  only hard wall is **MessageSeq ↔ TransportSeq**. Branding fixes this. The
  renderer's single pure Axis-A instance is the `connected.seq` leak
  (`useConversationStream.ts:75`, §3.2) — a TransportSeq copied into a payload a
  business hook could read as a MessageSeq. Fix = delete the field.
- **Axis B — optionality collapse.** `map.get(k) ?? 0` conflates *absent* with
  *value 0*. **This is #1265's actual root cause**, and **brands do not fix it**
  (`?? 0` on a branded `ObservedSeq` still compiles and still lies). Axis B is
  fixed by explicit absence (`Seq | undefined`, no `?? 0`) + a per-role decision
  on what "absent" means (contract §5). The renderer's obligation on Axis B: any
  seq-shaped value it holds uses explicit absence (`MessageSeq | null`), never
  `?? 0`. The two local gates below already do (`tailSeq: MessageSeq | null`);
  the migration must not regress that into a coalesced 0.

So this doc is **not** "the antidote to #1265" — it is the renderer half of the
Axis-A brand consumption plus the renderer's Axis-B absence discipline. The
renderer's job is to *consume* the branded types at the boundary and never
launder one brand into another except at the one declared conversion point
(§3.1).

**Which brands the renderer even sees.** Of contract §3's five brands, the
renderer touches **three**: `MessageSeq`, `TransportSeq` (confined to
transport/ingestor), `ReadSeq` (minted at §3.1). `ObservedSeq` is **daemon-only**
(admission boundary) — no renderer site. `TransportEpoch` rides with TransportSeq
and is a **`string` UUID brand** (contract Blocker 2), passed opaquely.

## 1. The three brand spaces, as the renderer sees them

Contract #1266 §3 defines five brands (`MessageSeq`, `TransportSeq`,
`TransportEpoch`, `ReadSeq`, `ObservedSeq`). The renderer sees three; the table
below is the renderer view:

| Brand (contract #1266) | Renderer meaning | Authority / origin |
|---|---|---|
| **TransportSeq** | WS per-scope frame cursor: resume floor / applied-water / received-water / `markSatisfied` / `commitSnapshotBaseline` | `lib/ws-client.ts` + `features/realtime/conversation-ingestor.ts`. Never leaves the transport/ingestor layer. |
| **MessageSeq** | `MessageDto.seq`; a **conversation-global** message ordinal (allocated by `reserveNextSeq`, *not* per-stream); pagination `before_seq`/`after_seq`; the value the renderer holds in state/refs to mark-read from. **When used as a cursor/gate it is only meaningful paired with a stream identity `(conversation_id, thread_root_id)`** (contract Blocker 1). | backend message rows; consumed across `features/channels/hooks.ts`, `ThreadPanel`, mark-read gates |
| **ReadSeq** | viewer read-cursor position (`conversation_reads`); the `at_seq` a source-observe pins | produced only at `streamSourceAtSeq` (§3.1); consumed by read-cursor mutations |

**Values the renderer touches that are NOT one of the three cleanly — the danger
list (each detailed in §3):**
- **`epoch`** — a **`string` UUID** brand (`TransportEpoch`, contract Blocker 2),
  rides with TransportSeq as a distinct axis; renderer passes it opaquely.
- **`stream_head_seq`** — a MessageSeq value flowing toward a ReadSeq (§3.1).
- **optimistic pending `seq: Date.now()`** — an epoch-ms number wearing
  `MessageDto`'s shape; **NOT a MessageSeq** (§3.3, Blocker 1).
- **close-watermark** — a MessageSeq persisted to localStorage and compared to a
  pointer seq **within one channel/stream** (§3.4, Blocker 3).
- **mainline tail-read gate** — `tailSeq`/`TailReadMark.seq`, a local MessageSeq
  gate compared **same-stream**; branded but **not** converted to ReadSeq
  (§3.5, Blocker 4).

## 2. Renderer consumption inventory

All currently plain `number`.

### TransportSeq — confined to transport + ingestor (must never widen)
| Site | File | Note |
|---|---|---|
| `markSatisfied(scope, seq, epoch)` | `conversation-ingestor.ts:634/648` | seq = TransportSeq |
| `commitSnapshotBaseline(scope, epoch)` | `conversation-ingestor.ts:605` | epoch only (Q1) |
| resume floor / applied / received water | `lib/ws-client.ts` | Alice's lane; renderer only *calls* |
| `seq: frame.seq` copied into synthetic `connected` payload | `useConversationStream.ts:75` | **leak — to be DELETED** (§3.2): sole consumer is dev EventStream, which never reads it |

### MessageSeq — paging, ordering, and seq-held-in-renderer-state for mark-read
| Site | File | Note |
|---|---|---|
| `before_seq`/`after_seq` from `pageParam.seq` | `channels/hooks.ts:1087/1089` | MessageSeq → query |
| page-param derivation `{kind, seq: m.seq}` | `channels/hooks.ts:1171/1182/1387/1396` | from `MessageDto.seq` |
| `stream_head_seq` (cache page field = `msg.seq`) | `channels/hooks.ts:418/435`, read by `useThreadCluster` | open-time snapshot head; MessageSeq by origin |
| `useMarkThreadRead({ snapshotSeq })` | `channels/hooks.ts:2271/2277` | MessageSeq held then handed to `streamSourceAtSeq` |
| `ThreadPanel.issueMarkRead(seq)` → `snapshotSeq` | `ThreadPanel.tsx:350/356/404` | MessageSeq held in callback |
| `maxLoadedSeq` (visible-live) → `threadLiveMarkReadSeq` | `ThreadPanel.tsx:443/448`, `threadMarkRead.ts:161` | MessageSeq held in component state; pure gate then mark-read |

### ReadSeq — the read cursor, produced at exactly one place
| Site | File | Note |
|---|---|---|
| `streamSourceAtSeq(channelId, threadRootId, seq)` → `{kind:'at_seq', seq}` | `attention/observe.ts:38` | **the MessageSeq→ReadSeq conversion** (§3.1) |
| `mainlineStreamSourceHead` / `stream_head` builders | `attention/observe.ts:60/88` | no seq value (server resolves head) — brand-free |
| read-cursor / mark-read mutations, unread summary | `App.tsx` read-cursor effects, `features/notifications`, `features/attention/hooks.ts` | consume ReadSeq |

### Local MessageSeq watermark — the missed path (Blocker 3)
| Site | File | Note |
|---|---|---|
| `MessageUnreadPointerDto.seq` | `@silverhand/shared` (consumed in `lib/channel-open.ts:30/34`) | MessageSeq |
| `resolveChannelOpen(pointer.seq > closeWatermark)` | `lib/channel-open.ts:34` | MessageSeq vs MessageSeq compare |
| `recordCloseWatermark(channelId, seq)` → localStorage `CLOSE_WATERMARK_KEY` | `App.tsx:791`, `lib/place-memory.ts` | MessageSeq persisted; **localStorage hydrate = decode/validate boundary** |

### Local MessageSeq gate — mainline visible-tail read (Blocker 4)
| Site | File | Note |
|---|---|---|
| `tailSeq = messages.at(-1).seq` | `components/layout/ChannelView.tsx:289` | MessageSeq \| null held in render |
| `nextTailReadMark(prev, channelId, tailSeq, isAtTail, hasNewerLiveGap)` → `TailReadMark.seq` | `lib/channel-read.ts:19-33` | pure gate: compares `prev.seq === tailSeq` (MessageSeq vs MessageSeq); returns `{channelId, seq}` |
| `useMarkMessageChannelRead()` → `mainlineStreamSourceHead()` | `ChannelView.tsx:288/302`, `attention/observe.ts` | the emitted observe is **server-resolved head, no seq** — brand-free request, **NOT** a conversion |

**DTO field present but NOT consumed (note to prevent future misjudgment):**
`StreamUnreadDto.first_unread_seq` — the renderer drives off `first_unread_message_id`
(`MessageItem.tsx:343`) + unread counts, never `first_unread_seq`. It should still be
branded MessageSeq at the DTO (#1266) for wire consistency, but there is no renderer
consumption site to migrate.

## 3. Conversion points & danger channels

### 3.1 MessageSeq → ReadSeq — the ONE genuine conversion
`streamSourceAtSeq(channelId, threadRootId, seq)` (`attention/observe.ts:38`) is
the single choke point: the `seq` in is the MessageSeq the viewer has seen;
pinning it as `{kind:'at_seq', seq}` makes it a ReadSeq. Everything upstream —
`snapshotSeq` (useMarkThreadRead / issueMarkRead), `maxLoadedSeq` /
`threadLiveMarkReadSeq`, the `stream_head_seq` open-time snapshot — is
**MessageSeq held in renderer state/refs** and stays MessageSeq until it reaches
this function. **Do NOT have each caller pre-convert** (no scattered
`toReadSeq`); the conversion lives inside/at `streamSourceAtSeq` alone so there
is exactly one testable bridge.

### 3.2 TransportSeq leak → DELETE, don't preserve
`useConversationStream.ts:75` copies `frame.seq` (TransportSeq) into the synthetic
`connected` payload. Verified: the **only** caller of `useConversationStream` is
`components/dev/EventStream.tsx`, and its `connected` handling never reads
`payload.seq`. So the field has no consumer — **remove it** rather than expose a
TransportSeq to a legacy business-event payload. (This is the cleanest kill of a
#1265-shaped one-number-two-meanings trap: delete the ambiguous channel.)

### 3.3 Optimistic pending `seq` — NOT a conversion, a shape collision (Blocker 1)
`channels/hooks.ts:1912` builds an optimistic pending message in `MessageDto`
shape with `seq: Date.now()` (epoch-ms, explicitly *not* a MessageSeq — the
:1163 comment already warns against feeding it to pagination, and pending rows
are skipped by `pending-` id). Once #1266 brands `MessageDto.seq` as MessageSeq,
this line stops compiling — **and that is the point**. **Contract ruling (§6 Q5):
split the type — `PendingMessage` carries `tempId` + `createdAtLocal` (an honest
local timestamp for tail-ordering), NOT a seq**; the cache becomes
`CommittedMessage(MessageSeq) | PendingMessage`. No `PendingSeq` brand (it would
model a quantity that shouldn't exist and invite ordering it against real
MessageSeq); **banned:** `Date.now() as MessageSeq`. This is the highest-risk
item because the pending row already flows into cluster/mainline cache; the split
forces the type-level distinction the cache has only been faking via id
conventions.

**Landed (slice B, `17c0b3d`).** Realized as a renderer-only
`PendingMessage = Omit<MessageDto,'seq'> & { pending: true }` +
`CachedMessage = MessageDto | PendingMessage` (`features/channels/pending-message.ts`),
with `isPendingMessage` / `isCommittedMessage` guards and a `lastCommittedSeq`
tail helper. Contract "tempId + createdAtLocal" is realized without redundant
fields: the temp id is `id` (`pending-<uuid>`), and `createdAtLocal` is the
retained `created_at` (an honest local send wall-clock — for a pending row it IS
the local timestamp, so a separate field would be dead weight). The cache page
becomes `CachedMessagesPage` (a server `ConversationMessagesDto` widens into it).
The append path split into a shared `appendToCache` core (owns the replay-overlap
id-dedup) + `appendMessageToCache` (committed, `stream_head_seq = msg.seq`) and
`appendPendingMessage` (no seq → provisional head `decodeMessageSeq(0)`).
Pagination cursors switched from the `pending-` id heuristic to
`isCommittedMessage`. The render path widened to `CachedMessage` (all seq-free:
`groupMessages`, `MessageItem`, `MessageList`, `threadAnchor`); seq-consumers
narrow to committed (`tailSeq` / `maxLoadedSeq` via `lastCommittedSeq`,
system-row branches, reactions).
**Behavior consequence (flagged, not silent):** row actions
(save / select / share / copy / open-thread / **react**) are **not rendered on a
pending row** — it has no server id/seq, so those actions previously fired
against a `pending-<uuid>` the server rejects (a 404; the top-corner reaction
picker had no guard at all and hit the backend directly). The affordance
*rendering* is gated on `committed` in `MessageItem` (the action-surface handlers
keep an `isCommittedMessage` guard as defense-in-depth); a pending row reads as
"not operable yet" rather than showing a dead button. Effectively a bugfix over
the ~200ms window before the ack swaps in the committed row. Fenced by
`MessageItem.pending-affordance.test.ts` (Cindy slice-B review).

### 3.4 Close-watermark — local MessageSeq persisted (Blocker 3)
`resolveChannelOpen(pointer.seq > closeWatermark)` (`lib/channel-open.ts:34`)
compares `MessageUnreadPointerDto.seq` against the persisted close-watermark. Both
are **MessageSeq**, and the compare is **same-stream** (both scoped to one
channel) — the precondition contract Blocker 4 protects: a MessageSeq↔MessageSeq
compare is only meaningful within one stream identity, and this one is. The
watermark round-trips through localStorage (`recordCloseWatermark` →
`CLOSE_WATERMARK_KEY`), so **localStorage hydrate is a decode/validation
boundary** where a raw stored `number` must be re-branded via the shared
`decodeMessageSeq` (contract §4.1), not blindly `as MessageSeq`.

### 3.5 Mainline visible-tail read gate — local MessageSeq, NOT a conversion (Blocker 4)
`ChannelView.tsx:289` holds `tailSeq = messages.at(-1).seq` and feeds it to
`nextTailReadMark()` (`lib/channel-read.ts`), whose `TailReadMark.seq` is a local
MessageSeq gate deciding whether to fire `useMarkMessageChannelRead()`. The mark
it emits is `mainlineStreamSourceHead()` — server-resolved head, **no seq** — so
this is **not** a MessageSeq→ReadSeq conversion. The `prev.seq === tailSeq`
compare is **same-stream** (both the mainline of one channel) — legal per contract
Blocker 4 precisely because the stream identity is fixed. Brand `tailSeq` /
`TailReadMark.seq` / `nextTailReadMark`'s param as **MessageSeq** (a local gate
that compares MessageSeq to MessageSeq within one stream); **do NOT** convert it
to ReadSeq — that would change the existing semantics. Without listing it, a brand
migration can easily fix only the thread mark-read path and leave the mainline
read gate as raw `number`.

### 3.6 Wire = typed trust boundary, NOT a renderer decoder (Cindy slice-2 finding)
The renderer's `api<T>()` (`lib/api.ts:136`, and `apiUpload` :166) is
`JSON.parse(...) as T` — it does **not** run zod `.parse()`. So a branded seq
arriving on the wire (`MessageDto.seq`, `ConversationMessagesDto.stream_head_seq`,
`MessageUnreadPointerDto.seq`) becomes a `MessageSeq` purely by **typed trust**:
the brand rides the TS type `T`; the value is minted **server-side at DTO
construction** (`decodeMessageSeq(...)`), and the renderer trusts the validated
wire contract. This is a **trust boundary, not a runtime decode boundary** —
"client `.parse()` = decode boundary" is false for the current API layer, and
saying otherwise hides an `as T` behind documentation.

Consequences for #1267:
- **This phase forbids per-call / ad-hoc `.parse()` or `as MessageSeq` to patch
  holes** (Cindy slice-2 refinement). The renderer consumes typed API DTOs and
  trusts them; it does **not** sprinkle scattered parse/cast escape hatches at
  hook call-sites. What is banned is the *scattered escape hatch*, **not** the
  future possibility of centralized hardening.
- **Option 2, if ever done, is a centralized `apiParse(schema, ...)` API-boundary
  migration** — one deliberate boundary where branded DTO endpoints run
  `ConversationMessagesDtoSchema.parse(...)`, never per-hook parse. It touches this
  consumption面 and is **out of S2 scope**, explicitly deferred (a separate
  hardening, not a correctness gap: the brand's job is compile-time, and
  server-side mint validates the value where it is created).
- The renderer's **only genuine runtime decode boundary is localStorage hydrate**
  (§3.4 close-watermark) — the one place a raw untyped `number` re-enters renderer
  memory and must pass through `decodeMessageSeq`. Everything else arriving as a
  brand is trusted from the wire.

## 4. Seam questions — RESOLVED by contract #1266 §6

All four are answered in the signed contract; recorded here so the renderer half
has no open contract dependency beyond the types landing.

- **Q1 — `epoch`.** Own brand → **`TransportEpoch`**, and it is a **`string`**
  brand (UUID), not a number (contract §6 Q1 + Blocker 2). Renderer transports
  `{ epoch: TransportEpoch, seq: TransportSeq }` opaquely.
- **Q2 — pending-seq shape.** **`PendingMessage` type split**, no `PendingSeq`
  brand (contract §6 Q5); see §3.3.
- **Q3 — `stream_head_seq`.** Confirmed **MessageSeq** at source; minted to
  ReadSeq only at `streamSourceAtSeq`, never the cache layer (contract §6 Q3).
- **Q4 — conversion + decode helpers location.** **`@silverhand/shared`** —
  the `asReadSeq` mint and the §4.1 `decodeMessageSeq` decoder colocate there,
  one definition reused by backend/CLI/renderer (contract §6 Q4). **No generic
  cross-brand ordering helper is exported** (contract Blocker B): the deleted
  generic `isUnread`/`isBeyond` do **not** come back; any future comparison
  helper must carry a `MessageStreamKey` and assert same-stream. Renderer-side,
  comparisons stay inline at already-stream-qualified sites (§3.1/§3.4/§3.5), not
  behind a shared brand-only comparator.

**One renderer-relevant carry-over from Cindy's contract review (not an open
question, a discipline the renderer must honor):** contract Blocker 4 — a
cursor↔MessageSeq compare is only legal **same-stream**. **Brands do not prevent
a stream-key mismatch** (a mainline cursor vs. a thread MessageSeq both type as
`MessageSeq`); that is a *third line of defense* — a stream-qualified
accessor/compare, not the type. Renderer-side, that discipline is: every compare
site carries a fixed stream identity (§3.1 carries `(channelId, threadRootId)`;
§3.4 and §3.5 compare within one channel), and the §6 fence forbids importing a
shared generic `isUnread`/`isBeyond` (the contract deletes those from shared
outright) that would erase the stream identity from the signature.

## 5. Migration approach (renderer half) — behavior-preserving

- **Brand at the boundary, propagate inward.** #1266 brands `MessageDto.seq`,
  `EventFrame.seq`, `MessageUnreadPointerDto.seq`, and the read-cursor payloads;
  the renderer then gets red squiggles exactly where a brand is mixed. Each is
  either a legitimate conversion (§3.1) or a latent bug (§3.2/3.3/3.4).
- **No `as number` / `as MessageSeq` escape hatch.** Done only when zero casts
  remain outside the declared conversion/decoder sites. Acceptance bar (Cindy
  criterion 2).
- **Implementation-front risks (must be on the acceptance line):**
  1. **optimistic pending seq** (§3.3) — resolve the `PendingMessage` vs
     brand-split BEFORE branding `MessageDto.seq`, else it's the first thing that
     won't compile.
  2. **localStorage watermark decode** (§3.4) — hydrate path re-brands with
     validation.
  3. **two local MessageSeq gates stay gates** (§3.4 watermark, §3.5 mainline
     tail) — brand them MessageSeq but do **not** convert to ReadSeq; the
     migration must fix both, not just the thread mark-read path.
- **Sequencing.** Renderer half lands *after* #1266's brand types exist (hard
  dependency) and after shiki pushes. This round = design only, no code.

## 6. Test surface (renderer half)

- **Conversion-site fence** (source-scan, node/no-RTL like
  `realtime-ingestion-read-inert`): the only permitted cross-brand casts are
  `streamSourceAtSeq` (§3.1) and the localStorage decoder (§3.4); any other
  seq-brand `as`-cast is a failure.
- **`streamSourceAtSeq` conversion unit**: MessageSeq in → ReadSeq `at_seq` out;
  single bridge.
- **pending-seq type test**: a pending row cannot be assigned where a MessageSeq
  message is expected (compile-fail fixture / type-level assertion).
- **watermark decode unit**: hydrate of a stored number yields a validated
  MessageSeq (via shared `decodeMessageSeq`); malformed input rejected, not
  laundered. **This is the sole renderer runtime decode boundary** (§3.6).
- **wire-trust fence** (§3.6): the fence forbids **per-call / ad-hoc** `.parse()`
  or `as MessageSeq` at renderer consumption sites — branded wire values arrive
  trusted through the typed `api<T>()` boundary (server-minted), so a scattered
  `as`-cast or hook-local parse of a wire seq is a failure. It does **not** forbid
  a future *centralized* `apiParse(schema, ...)` boundary (option 2) — the ban is
  on scattered escape hatches, not on deliberate centralized hardening.
- **no stream-erasing generic compare** (contract Blocker 4): the fence also
  denies a shared generic `isUnread`/`isBeyond` cursor↔message helper reaching
  renderer compare sites; renderer compares stay within a fixed stream identity
  (§3.1/§3.4/§3.5).
- **No behavior change**: existing pagination / mark-read / ingestion / channel-open
  tests stay green — branding is compile-time only.

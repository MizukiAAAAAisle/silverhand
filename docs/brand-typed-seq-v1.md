# Brand-typed seq (S2) — contract v1

This document owns the semantic contract for the sequence brands and their
conversion seams. Renderer enforcement lives with the consumption fences in
`apps/desktop/src/renderer/seq-brand-consumption.test.ts`; implementation
inventory and rollout history belong to git and the task board.

Ubiquitous-language note: this doc is the source of truth for what each "seq"
means. When code conflicts with a name/semantic here, the code is the bug.

> **Superseded in part (freshness redesign, scheme C — see
> `freshness-boundary-authority-v1.md`).** The `ObservedSeq` brand and the daemon
> per-stream **observed boundary** (`observedSeqByStream` /
> `pendingAdmissionSeqByStream`) it typed **no longer exist**: freshness is now a
> whole-runtime backend EXISTS-guard, not a per-stream daemon cursor. References
> to `observedSeqByStream` / `ObservedSeq` below are retained as the **historical**
> motivation for Axis B (the bug was real and did motivate S2), not as live sites.
> The still-live brands are `MessageSeq` / `TransportSeq` / `ReadSeq` /
> `TransportEpoch`; `ObservedSeq` and `asObservedSeq` have been removed from
> `@silverhand/shared`.

---

## 1. Problem

Multiple **distinct** quantities are all called `seq` and typed as plain
`number`. Two failure modes follow, and they are **different axes** — this is
the central finding of the census (§3), and the reason a naive "brand the seqs"
pass would not have prevented the bug that motivated S2.

- **Axis A — space mixing.** A value from one ordinal space is compared/assigned
  to another. The genuine hazard is **MessageSeq ↔ TransportSeq** (a persisted
  message ordinal vs. an ephemeral per-WS-scope event counter): the same
  `number` carrying two unrelated meanings. The renderer seam at
  `useConversationStream.ts:75` (copies a TransportSeq into a payload a business
  hook could read as a MessageSeq) is exactly this — "one number, two meanings",
  the same shape as the false-stale bug class.
- **Axis B — optionality collapse.** `map.get(k) ?? 0` conflates *"absent /
  never set"* with *"present, value 0"*. **This was the false-stale bug's actual
  root cause**
  (`observedSeqByStream.get(MAIN) ?? 0` manufactured `seen=0` for a
  never-observed stream → false-stale — the historical motivating bug; that
  daemon observed-boundary has since been removed by the freshness redesign, but
  the *shape* is what matters here). **Brand types do NOT fix Axis B.**
  `?? 0` on a branded seq still compiles and still lies.

> **Thesis (bold, falsifiable):** S2 must be **two-pronged**. Branding fixes
> Axis A only. Axis B is fixed by *explicit absence* (`Seq | undefined`, no
> `?? 0`) plus a **per-role decision on what "absent" means** — and that
> decision differs by role (§5). Ship only the brands and the false-stale bug class
> survives.
>
> Falsifier: if every live seq defect in the census (§2) were a space-mix and
> none an optionality-collapse, Axis B would be redundant. It is not — the
> motivating sites were `?? 0` optionality collapses at the daemon
> observed-boundary (§2). Those specific sites have since been **retired with the
> freshness redesign** (freshness left the daemon), but Axis B stays
> non-redundant: the discipline (no unclassified `?? 0`, explicit absence) is a
> standing rule, the DeliverySeq boundary (§2) remains a candidate collapse, and
> the ReadSeq role (§5) still demonstrates a *role-defined* zero that must be
> decided per role, not defaulted. (Several other `?? 0` sites are *role-defined
> zero* and correct — see §2's split.)

---

## 2. Census — what the sweep actually found

Six `seq`-ish quantities exist. Architecturally they collapse to **two base
ordinal spaces** plus a **family of cursors denominated in MessageSeq**. The
collapse is load-bearing, so each claim is sourced.

### Two base ordinal spaces (genuinely distinct)

| Brand | What it counts | Authority / lifecycle | Source |
|---|---|---|---|
| **MessageSeq** | ordinal of a message within a **conversation** (NOT per-stream — see below) | DB `messages.seq`, allocated by `reserveNextSeq` bumping `conversations.latest_message_seq` (`message-repo.ts:1155-1159`); **conversation-global**; persisted; survives restart | `packages/shared/src/db/schema.ts:383`, `api/message.ts:35` |
| **TransportSeq** | per-WS-scope fanout event ordinal, for replay/resume | daemon `seqCounters: Map<scope,number>`; **ephemeral**; **resets on backend restart**; unrelated to any message | `packages/backend/src/ws/scope-event-bus.ts:207,213`; `packages/shared/src/ws-frames.ts:107,115` |

MessageSeq and TransportSeq **never legitimately convert**. A
`TransportSeq → MessageSeq` flow is *always* a bug. This is the one hard wall.

> **MessageSeq is conversation-global, not per-stream.** The
> allocator bumps `conversations.latest_message_seq` once per message regardless
> of stream, so a mainline message and a reply-cluster message in the same
> conversation draw from **one** sequence. Stream identity
> `(conversation_id, thread_root_id)` is a **separate coordinate**: a MessageSeq
> only means "a head / read cursor / observed cursor *for a given stream*" when
> paired with that coordinate. `conversation_stream_heads.latest_seq` is exactly
> "the conversation-global `messages.seq` of *that stream's* newest message."
> **Consequence the brand does NOT cover:** branding cannot prevent a
> *stream-key mismatch* (comparing a mainline cursor to a cluster message — both
> are `MessageSeq`, types pass). That invariant is held by **stream-qualified
> accessors/queries + tests** (§4, §7), a third defense line orthogonal to
> branding.

### The cursor family — all **MessageSeq values in a role**, not new spaces

Each of these is a MessageSeq (a position *into* the message ordinal), used in a
particular role. Proof they are MessageSeq, not independent spaces:

- **StreamHeadSeq** = `conversation_stream_heads.latest_seq`. Schema comment,
  verbatim: *"latest_seq is the global messages.seq of the stream's newest
  message and doubles as the CAS token"* (`schema.ts:419-420`). → a MessageSeq.
- **DeliverySeq** = the high-water of a delivery batch = `max(deliveries[].seq)`.
  #task:2106 removed the backend-computed wire scalar; the daemon now derives it
  as `deliveredUpToSeqOf(deliveries) = Math.max(...deliveries.map(d => d.seq))`
  (`supervisor/index.ts`) purely to write the disk sidecar — it never rides the
  wire. → a MessageSeq (the high-water of a batch).
- **ObservedSeq** (retired) — was the daemon `observedSeqByStream` cursor,
  "highest MessageSeq the agent has been shown in this stream". Removed with the
  freshness redesign (scheme C): the daemon no longer keeps a per-stream observed
  cursor, so this brand is gone. Listed here only so the census stays honest.
- **ReadSeq** = `conversation_reads.last_read_seq` — "highest MessageSeq the
  viewer has read in this stream" (`schema.ts:435`). → a MessageSeq cursor.

Because cursors are MessageSeq, **comparing a cursor to a message position is
correct — but only within the same stream** (e.g. the unread test
`last_read_seq < messageSeq`, `mention-cc.ts:342-351`, which SELECTs
stream-qualified `thread_root_id IS ?` *before* comparing). Branding every cursor
as its own ordinal would flag correct code → push people to `number` escape
hatches (which the fence test forbids). So we brand a cursor **only where it
has a mint boundary whose bypass is a bug** (§4), not merely because it plays a
role. The same-stream premise is enforced separately (§4 ordering rule), never by
the cursor's brand.

### Client-side quantities (renderer)

The renderer holds seq-shaped channels the backend sweep can't see. They are
contract decisions (this doc), not renderer-local choices. Four kinds:

1. **Fake MessageSeq → type split.** `useSendMessage` stamps a pending message
   with `seq: Date.now()` inside a `MessageDto` shape (`channels/hooks.ts:1912`;
   `:1163` already warns pagination via a manual `pending-` id skip). **This is
   NOT a MessageSeq** — a client wall-clock stamp masquerading as a server
   ordinal, the purest Axis-A instance and the most dangerous (it already flows
   into mainline/cluster cache). **Decision (§3):** do not brand a `PendingSeq`;
   **split the type** — a pending message is a different aggregate state with no
   server position. It carries `tempId` + `createdAtLocal` (an honest timestamp
   for tail-ordering), **not** a seq. Cache =
   `CommittedMessage(MessageSeq) | PendingMessage`. Branding `MessageDto.seq`
   makes this line stop compiling — *that is the goal*; forcing every reader to
   handle both states is the point, not a cost to `as`-hatch around.

2. **MessageSeq held in renderer, bridged to ReadSeq at one choke point.**
   `snapshotSeq` (`useMarkThreadRead`), `maxLoadedSeq → threadLiveMarkReadSeq`,
   open-time `stream_head_seq` snapshot. All are **MessageSeq held in state/ref**;
   they mint a ReadSeq **only** at `streamSourceAtSeq()` (the real fn — there is
   no `observeAtSeq`). No caller pre-`asReadSeq`; the mint happens once.

3. **MessageSeq comparison gates — held + compared, never converted.** A gate
   compares MessageSeq↔MessageSeq to decide a UI action, but the resulting
   side-effect (mark-read) uses a **server-resolved head with no seq**, so it is
   *not* a ReadSeq conversion. These stay `MessageSeq` (absence `MessageSeq | null`)
   and must never be "fixed" into ReadSeq — that would change semantics. Named
   instances:
   - **close-watermark**: `MessageUnreadPointerDto.seq` → `recordCloseWatermark()`
     → localStorage → `resolveChannelOpen(pointer.seq > watermark)`
     (`App.tsx` / `place-memory.ts` / `channel-open.ts:34`). localStorage hydrate
     is a **decode boundary** (§4.1).
   - **mainline tail-read gate**: `tailSeq = messages.at(-1).seq`
     → `nextTailReadMark()` → `TailReadMark.seq` (`ChannelView.tsx:289-304`,
     `channel-read.ts`); the emitted observe is `mainlineStreamSourceHead()`
     (server head, brand-free). Symmetric with the thread tail gate — brand both
     or a migration silently leaves the mainline gate a raw `number`.

4. **DTO seq present but renderer-unconsumed (note-only).**
   `StreamUnreadDto.first_unread_seq` — branded MessageSeq at the schema, but the
   renderer decides on `first_unread_message_id` / unread count, not this field.
   Not a channel to migrate; noted so a future reader doesn't mistake it for a
   live decision input.

### Dangerous collapse vs. role-defined zero

Not every `?? 0` is a bug. A `0` is only dangerous where "absent" and "value 0"
carry **different** meaning for that role. Splitting the sites:

**Genuinely dangerous (absent ≢ 0) — fix in migration:**

| Site | Pattern | Note |
|---|---|---|
| ~~`supervisor/index.ts:514`~~ (retired) | ~~`pendingAdmissionSeqByStream.get(k) ?? 0`~~ | Was the daemon observed-boundary — the original false-stale layer. **Removed with the freshness redesign** (scheme C): the daemon no longer computes a per-stream observed/admission seq, so this collapse site no longer exists. |
| ~~`delivery-coordinator.ts:1270`~~ (resolved by #task:2106) | ~~`deliveredUpToSeq ?? 0`~~ | Was the surviving Axis-B DeliverySeq collapse candidate. **#task:2106 deleted the coordinator scalar entirely** — `deliveries` is required and the daemon derives the high-water from `max(deliveries[].seq)`, so there is no `deliveredUpToSeq ?? 0` fallback left to price. Finding closed; no impl verification outstanding. |

**Role-defined zero (absent ≡ 0 *is the design*) — do NOT "fix":**

| Site | Pattern | Why 0 is correct |
|---|---|---|
| `message-repo.ts:1182` (stream head) | `latest_seq ?? 0` | empty thread stream's CAS token **is** 0 by design — a thread's first reply sends `seen=0` and inserts (`ON CONFLICT DO NOTHING`, `message-repo.ts:1222-1223`; pinned by test *"thread first reply (seen=0) succeeds even though the main head exists"*, `message-repo.test.ts:459`). The false-stale bug is NOT here. |
| `message-repo.ts:1071` (conversation allocator) | `latest_message_seq ?? 0` | empty conversation's next-seq base is 0; first message reserves 1. Allocator high-water. |
| `scope-event-bus.ts:207,213` (transport counter) | `seqCounters.get(scope) ?? 0` | never-published scope → current 0 / first publish 1 is correct allocator/high-water semantics. |
| `conversation-read-repo.ts:114` (read cursor) | `last_read_seq ?? 0` | never-read ≡ all-unread ≡ cursor before msg 1 (see §5). |

**Cross-stream (Axis A′, not Axis B):**

| Site | Pattern | Note |
|---|---|---|
| `outbound-event-fanout.ts:1848` | `Math.max(...message.seq)` over a mixed-stream batch | same conversation-global ordinal interpreted across streams (§7) — a stream-key mismatch, not Message↔Transport. |

Message↔Transport branding is **preventive** (guards the renderer finding-2 seam
before it's violated); the original live Axis-B bugs were the daemon
observed-boundary sites, now retired with the freshness redesign — the surviving
candidate is the DeliverySeq boundary (`delivery-coordinator.ts:1270`).

---

## 3. Recommended brands (v1)

Minimal set. Brand base spaces hard; brand a cursor only if it is **minted
through a semantic write boundary** whose bypass would skip side-effects.

```ts
// @silverhand/shared — the single definition site. No parallel defs anywhere.
declare const MessageSeqB: unique symbol
declare const TransportSeqB: unique symbol
declare const TransportEpochB: unique symbol
declare const ReadSeqB: unique symbol

export type MessageSeq   = number & { readonly [MessageSeqB]: true }
export type TransportSeq = number & { readonly [TransportSeqB]: true }
// epoch is a UUID string (crypto.randomUUID()), NOT a number — scope-event-bus.ts:64,90;
// ws-frames.ts:69,89,105. Branding it as number would encode the very axis error S2 kills.
export type TransportEpoch = string & { readonly [TransportEpochB]: true }
export type ReadSeq     = number & { readonly [ReadSeqB]: true }   // minted via observe (streamSourceAtSeq)
// ObservedSeq (was: minted via daemon admission) has been RETIRED with the
// freshness redesign — the daemon no longer keeps a per-stream observed cursor.
```

- **NOT branded:** StreamHeadSeq, DeliverySeq → they are `MessageSeq` (a
  distinguished max/high-water). No independent write boundary to protect; their
  only defect is Axis B, fixed by explicit absence, not by a nominal type.
- **ReadSeq is branded** precisely because it has a single mint boundary
  (`observe` write) whose bypass is a bug. The brand makes "you may only become a
  read cursor by going through observe" a compile-time fact — a single testable
  conversion enforced by types, not discipline. (`ObservedSeq` was branded for
  the same reason at the daemon-admission boundary; that boundary is gone.)

---

## 4. Conversions — single, testable, directional

```ts
// The ONLY places a MessageSeq changes role. One function each; unit-tested.
export const asReadSeq     = (m: MessageSeq): ReadSeq     => m as unknown as ReadSeq
// asObservedSeq was retired with the freshness redesign (no daemon observed cursor).
```

**Ordering: NO generic cross-brand comparators in shared.**
Because MessageSeq is conversation-global (§2), `cursor < msg` is only meaningful
*within one stream* — and a bare `isUnread(cursor: ReadSeq, msg: MessageSeq)`
would let a mainline cursor be compared to a cluster message with types passing,
re-opening the stream-key-mismatch bug the brand can't see. So:

- **Do NOT export generic `isUnread`/`isBeyond`.** Comparisons stay **inside
  already-stream-qualified repo/query code** — the SQL has selected
  `thread_root_id IS ?` first, so both sides are known same-stream by
  construction (this is what `mention-cc.ts:342-351` already does).
- If a shared comparator is ever genuinely needed, it must **carry the stream
  identity and assert it**, e.g.
  `isUnread(stream: MessageStreamKey, cursor: ReadSeq, msg: MessageSeq)` with a
  runtime same-stream assert — the premise must live in the signature, never
  vanish. Full static safety would need a phantom `MessageSeq<Stream>` over
  runtime stream keys — out of scope for v1 (§7); the assert + stream-qualified
  call sites are the v1 defense.

- **MessageSeq ↔ TransportSeq: NO conversion exists.** Any need to write one is
  a design error. The brand wall *is* the contract.
- `asReadSeq` lives in `@silverhand/shared` (backend + CLI + renderer all mint).
  (`asObservedSeq` was retired with the freshness redesign.)
- The mint helpers are the enforcement point for Axis B too: they take a
  *present* `MessageSeq`; there is no `asReadSeq(undefined)`. Absence is handled
  before the mint, explicitly (§5).

### 4.1 Serialization / decode boundaries — the only other `number → brand`

A raw `number` may become a branded seq in **exactly two** ways. Everything else
must already be branded (the compiler enforces it):

1. **Mint at origin** — DB insert allocates a MessageSeq; the WS counter
   increments a TransportSeq. One authority each.
2. **Decode at a deserialization boundary** — a raw `number` crossing back in
   from an untyped medium, re-branded through a **validated decoder**, never a
   bare `as`. The media, and which side actually decodes:
   - **DB read** — repo layer decodes rows to branded seqs. This is where a
     server-computed/persisted number becomes a branded seq: repo mappers
     (`messageRowToDto`), and any route that assembles a DTO inline
     (`stream_head_seq`, the unread-pointer builders) **must call the decoder at
     construction**. `better-sqlite3`'s `.prepare<_, Row>()` generic is a
     *trust-cast*, not a decode — keep its `Row` type unbranded and decode the
     value explicitly.
   - **API wire, server side** — genuine zod ingress that runs `.parse()`
     (internal-agent routes, CLI response parsing) decodes to branded seqs at
     parse time (the brand rides the schema).
   - **API wire, renderer side is a *typed trust boundary*, NOT a runtime
     decode.** `apps/desktop/src/renderer/lib/api.ts` does
     `JSON.parse(body) as T` — it never runs `MessageDtoSchema.parse`. So the
     renderer receives already-validated wire values and **trusts** the typed
     contract; the authoritative decode happened **server-side at DTO
     construction** (bullet 1). Consequence: a wire seq
     field MUST be minted/decoded server-side — never claim "the client parses
     it". The renderer must not paper a raw wire number into a brand with an
     ad-hoc `.parse()` or `as MessageSeq`; it consumes the typed DTO. A future
     runtime-validated ingress is possible **only** as a centralized
     `apiParse(schema, …)` API-boundary migration (option 2, out of scope for
     v1) — never scattered per-hook parses.
   - **localStorage hydrate** — e.g. the close-watermark
     (`CLOSE_WATERMARK_KEY`): the stored number is decoded + validated back to a
     `MessageSeq` on read. **This is the renderer's ONE real runtime decode
     boundary.**

`decodeMessageSeq(n: number): MessageSeq` (and peers) live in
`@silverhand/shared` next to the mint helpers — one definition, reused
by backend, CLI, and renderer. A cast `n as MessageSeq` outside a mint or a
decoder is the escape hatch the fence test (§8) forbids.

---

## 5. Axis B — explicit absence, decided per role

Rule: **no *unclassified* `?? 0` on seq-like values.** Every `?? 0` must be owned
by a role-specific accessor/allowlist and tested as either **dangerous-collapse
(forbidden)** or **role-defined-zero (allowed)**. Absence, where it matters, is
`Seq | undefined` (or a repo/​map accessor that returns `undefined`, never a
silent coalesced 0). What "absent" *means* is a per-role semantic decision,
encoded at the single accessor + documented here:

| Role | "absent" means | Collapse to 0? | Why |
|---|---|---|---|
| **ReadSeq** (read cursor) | never read | **Yes → 0 is correct** | nothing-read ≡ cursor before msg 1 ≡ all unread. `mention-cc.ts:351` `?? 0` is *correct*. |
| ~~**ObservedSeq** (freshness, daemon)~~ (retired) | — | — | The daemon per-stream observed boundary was **removed** with the freshness redesign (scheme C): freshness is now a whole-runtime backend EXISTS-guard, so there is no `observedSeqByStream` and no first-touch-skip-CAS decision to encode. This row was the original "one dangerous role"; it no longer exists. |
| **StreamHeadSeq** (CAS token) | no stream head yet | **Yes → 0 is correct** | empty thread stream's CAS token **is** 0 by design — enables the first reply (`seen=0` inserts via `ON CONFLICT DO NOTHING`, pinned by `message-repo.test.ts:459`). Do **not** "fix" `message-repo.ts:1182`. |
| **DeliverySeq** (high-water) | nothing delivered | **check in impl** | "not delivered" vs. "delivered to 0" may matter at the daemon boundary (`delivery-coordinator.ts:1270`); verify whether absent advances observed before deciding. |
| **TransportSeq** (fanout counter) | scope never published | **Yes → 0 is correct** | current 0 / first publish 1 is allocator/high-water semantics (`scope-event-bus.ts:207`); resume gap detection is handled by `epoch` + buffer, not by treating 0 as special. |

The brand cannot encode this table — it is the human contract the reviewer
checks. **After the freshness redesign, DeliverySeq is the only remaining
dangerous-collapse candidate** (ObservedSeq, formerly "the one dangerous role",
was retired); the rest are role-defined zeros that must stay. Branding + this
table together are the S2 deliverable.

---

## 6. Seam decisions

- **Epoch its own brand?** **Yes → `TransportEpoch`.** Epoch (restart
  generation) and TransportSeq (position within a generation) are different
  quantities; bundling them into one field recreates the one-number-two-meanings
  trap S2 exists to kill. Renderer transports the pair
  `{ epoch: TransportEpoch, seq: TransportSeq }` opaquely.
- **Synthetic `connected.seq` in `useConversationStream`:** **delete the
  field.** `useConversationStream`'s only caller is
  `components/dev/EventStream.tsx`, whose `connected` branch reads `kind` only
  and **never reads `payload.seq`**. No consumer → carrying a TransportSeq into a
  legacy business payload is pure leak surface. Deleting the field is cleaner
  than branding-and-keeping and closes a false-stale-shaped channel outright.
  (The connected *event* is load-bearing for resume; the *seq field* is not
  consumed.)
- **`stream_head_seq` = MessageSeq; conversion at observe boundary:**
  **Confirmed at source** (`schema.ts:419-420`). `stream_head_seq` is a
  MessageSeq. The backend decodes it at DTO construction
  (`routes/conversations.ts`, §4.1 — `streamHeadLatestSeq()` stays a plain
  `number` internally per §3, branded only at the wire edge); the renderer
  receives it already-branded via the typed API trust boundary (§4.1 — no
  client `.parse()`). It then flows into `observe` and is minted to a ReadSeq
  **there** via `asReadSeq`, never at the cache-write layer. Cache pages carry
  MessageSeq.
- **`asReadSeq`/`toReadSeq` in shared or renderer?** **`@silverhand/shared`.**
  Backend, CLI, and renderer all mint read cursors;
  one definition, reused. (Named `asReadSeq` for cast-direction clarity; alias
  `toReadSeq` optional.) **Mint helpers and decoders live in shared. No
  generic cross-brand ordering/comparison helpers are exported** (§4) — any future
  comparator must carry `MessageStreamKey` and assert same-stream, or stay inside
  stream-qualified repo/query code.
- **Pending message: `PendingMessage` type or a `PendingSeq` brand?**
  **`PendingMessage` type split** (§2 kind-1). A pending message has no server
  position, so a `PendingSeq` brand would be modeling a quantity that shouldn't
  exist and would invite ordering it against real MessageSeq. Model it as a
  distinct aggregate state (`tempId` + `createdAtLocal` timestamp), cache as a
  union. **Banned:** `Date.now() as MessageSeq`.

---

## 7. Out of scope for S2 (named, not hidden)

- **Cross-stream MessageSeq mismatch** (`outbound-event-fanout.ts:1848`
  `Math.max` over a batch spanning mainline + clusters). Since MessageSeq is
  **conversation-global** (§2), this is not "another ordinal space" — it is the
  *same* ordinal **interpreted against the wrong stream**. The brand cannot
  prevent it: both sides are `MessageSeq`, types pass. Two things follow, and
  neither is a new brand:
  1. **v1 defense = stream-qualified accessors + tests, not types.** Every
     head/cursor read is keyed by `(conversation_id, thread_root_id)`; a test
     fence asserts no comparison crosses stream keys. This is the third defense
     line named in §2/§4.
  2. **Full static safety would need a phantom `MessageSeq<Stream>`** parametrized
     over runtime stream keys — impractical for v1. **Flagged, not folded.**
  The specific `Math.max`-across-streams high-water is a separate correctness fix
  (per-stream max), tracked independently of S2 branding.
- **S1 projection-level recovery** — unrelated axis, sequenced after S2.

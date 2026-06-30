# Event-WS Transport — cursor & resume semantics (v1)

Status: canonical. Owns the client↔server contract for the single-connection
event bus *as a transport*: how scopes are subscribed, how per-scope sequence
cursors are tracked, and how missed frames are recovered. Frame shapes live in
`packages/shared/src/ws-frames.ts`; the client implementation is
`apps/desktop/src/renderer/lib/ws-client.ts`; the server replay path is
`packages/backend/src/ws/ws-connection.ts`. Consumers of the delivered events
(unread, presence, reactions, activity) have their own docs — this one stops at
"the right frames reach `onFrame`, exactly once, in order".

## 1. The one invariant

**The per-scope transport cursor is client-authoritative. The server never
silently advances the client past frames it has not observed.**

Everything below is a corollary. Two distinct bugs (#1241, #1249/#1251) were the
same violation of this invariant at different points in the connection
lifecycle; both fixes restore it.

- A scope's cursor is `{ epoch, lastSeq }` = the highest seq the client has
  *contiguously observed and dispatched* for that scope (see
  `EventWsClient.positions`).
- Per-scope `seq` is strictly monotonic `+1` within an epoch (server
  `scope-event-bus.nextSeq`). So an observed jump is a real gap, never normal
  flow.
- `epoch` is the backend's process-start UUID. An epoch change means the seq
  space reset; the old cursor is moot and the client baselines fresh.

## 2. Three independent cursors — never conflated

The transport layer touches exactly one of these. This is the #1244
"surfaced ≠ eliminated" discipline re-asserted at the transport layer:

| Cursor | Owner | Touched by transport recovery? |
|---|---|---|
| Transport frame cursor (`ws-client positions[scope].lastSeq`) | this doc | **Yes — and only this** |
| Read cursor (`conversation_reads`, advanced by `observe()`) | activity-lifecycle-v1 | **Never** |
| Directed read state (`notifications.read_at`) | activity-lifecycle-v1 §5.3.1 | **Never** |

A replayed frame is **byte-identical** to a live `event` frame and read-inert by
construction: it flows through `onFrame` into the message cache (idempotent), and
read-state only advances on an explicit user action elsewhere. **"补帧『可得』≠
『已读』" — recoverable ≠ read.** No frame carries a `live`/`backfill`
provenance flag today, and none is needed: the frame→cache path writes no
read-state. A provenance gate becomes necessary *only if* replayed frames are
ever fed to a path that advances a visible-render or read cursor — a documented
future hook, not current behavior.

## 3. Subscribe = establish-listener, resume-from-cursor

`subscribe(scope)`:

1. Mark the scope desired (refcounted; multiple mounts share one wire
   subscription).
2. Send `{ type: 'subscribe', scope }`.
3. **If a cursor is retained for the scope, send a paired `resume`** from it
   (`sendSubscribe`). The server replays everything after `lastSeq`.

The `subscribed` ack carries the server's high-watermark seq at registration
time. **It is a baseline of last resort, not a re-baseline:** it sets the cursor
*only* when no usable same-epoch cursor is already retained. A retained
same-epoch cursor is client-authoritative — the ack must NOT advance it to head,
or the resume's replay would look stale and the gap would be skipped (this was
the #1251 clobber). A retained cursor from a *stale* epoch is moot → baseline
fresh from the ack; any optimistic resume against the old epoch self-heals via
`snapshot_required`.

## 4. Unsubscribe retains the cursor

`unsubscribe(scope)` drops the desired/confirmed/recovery state **but keeps
`positions[scope]`**. The scope becomes *detached*: no live listener, cursor
retained so a later resubscribe (§3) can replay anything published in the gap.

Pre-fix, `unsubscribe()` deleted the cursor, so the next `subscribe()` had
nothing to resume from and re-baselined to head off the ack — silently skipping
every frame published while no listener was attached (the **no-listener gap**,
`646d223`). The inbox/Activity work didn't introduce this; it mounts and
unmounts conversation views far more often, so the latent defect started firing
in dogfood.

Cursors are retained for the **whole session** — there is deliberately no
eviction bound. The cost is a scope string + two primitives per scope, sub-MB
even at 10× the conversations a session ever opens; a stale cursor self-heals on
resubscribe (resume → replay, or `snapshot_required` if the gap exceeds the
server buffer). A bounded LRU is **not admissible as a bare delete**: an evicted
scope resubscribes with no `resume`, the server has no reason to emit
`snapshot_required` (it never saw a stale position), and the `subscribed` ack
baselines to head — which silently skips any traffic during detachment, i.e.
the no-listener gap returning in LRU form. If memory ever forces a bound it
**must** carry a tombstone → forced snapshot: an evicted scope's next
subscribe must drive the `snapshot_required` refetch path rather than ack-
baseline. (That path is cheap on the renderer — `channels/hooks.ts` already
maps `snapshot_required` → `invalidateQueries` — but it is out of scope until a
real memory pressure point exists.)

## 5. Live forward-gap recovery (#1241)

While the socket stays OPEN (so reconnect/resume never fires), a dropped frame
used to advance the cursor silently. `acceptEventFrame` now gates every live
`event` on seq continuity within the cursor's epoch:

- `seq === lastSeq + 1` — contiguous. Advance, drop any recovery latch, dispatch.
- `seq > lastSeq + 1` — forward gap. Hold the cursor, `resume` from it, latch
  `recovering` so concurrent gapped frames coalesce into one in-flight resume,
  and swallow the frame (replay redelivers it in order).
- `seq <= lastSeq` — duplicate/stale. Dispatch (cache is idempotent), do not move
  the cursor or disturb recovery.
- missing cursor / epoch change — fresh baseline, dispatch.

The `recovering` latch clears on the first contiguous (replay-caught-up) frame,
on `snapshot_required`, and at every connection-lifecycle reset — no timer, no
deadlock.

## 6. Recovery exhausted → snapshot_required

If the server can't cover the gap (replay buffer too small, or epoch mismatch)
it sends `snapshot_required`. The client deletes the cursor, drops the recovery
latch, and dispatches the frame so conversation hooks do a full REST refetch.
The next event re-baselines cleanly.

## 7. Reconnect

On a fresh socket's `authenticated` frame, `resubscribeDesiredScopes()` re-sends
`subscribe` for every desired scope and one batched `resume` carrying each
scope's retained cursor. Same invariant as §3, applied to the whole desired set
at once.

## 8. Test coverage

`apps/desktop/src/renderer/lib/ws-client.test.ts`:
- viewer-scope canonicalisation (alias never on the wire; reconnect resume
  carries canonical `viewer:<id>` + last seq).
- live forward-gap recovery (#1241): contiguous dispatch, gap swallow + resume,
  snapshot_required re-baseline, concurrent-gap coalescing.
- no-listener gap (#1251): cursor retained across unsubscribe and replayed on
  resubscribe; `subscribed` ack does not clobber a retained same-epoch cursor;
  stale-epoch ack does re-baseline; detached cursors retained for the whole
  session (no lossy eviction — the oldest still resumes after heavy churn).

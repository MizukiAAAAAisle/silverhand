# Human Presence (online / offline) — v1

Status: **implemented and dogfooded** (shiki 2026-06-13).

Tracks online/offline status for **human** participants, surfaced in the desktop
UI, working identically in embedded and standalone (remote-server) deployments.

## 1. Core principle — presence is a *projection*, not a new subsystem

A human is **online iff they hold at least one live event WebSocket**
(`/api/ws/events`). We do **not** build a new heartbeat / ping / `last_seen`
poller — the signal already exists and is authoritative:

- The event WS is authenticated per `viewer_user_id` at upgrade
  (`ws-server.ts:49`), with clean open / close hooks (`ws-server.ts:63-66`).
- Transport-level ping/pong (30 s interval, 5 s timeout) already reaps dead
  sockets and fires `close` (`ws-connection.ts:214-225`).
- `installEventWebSocketServer` is **deployment-mode agnostic** — one code path
  serves embedded (usually one human) and standalone (N humans over the shared
  server). No mode branch.

This is the **Human/Agent/Host isomorphism** (`docs/architecture-principles.md`):
host availability is already derived from `HostWsAttachment` existence; human
presence is derived from event-WS existence the same way. Same shape, different
actor.

### Locked decisions (shiki 2026-06-13)
1. **Binary** `online | offline` only — no "away"/idle in v1.
2. **`last_seen_at` required** — show "last seen X ago" when offline.
3. **Global** broadcast granularity (`app` scope) — not per-workspace, for now.

## 2. Domain model & ubiquitous language

- New term: **presence**, enum `UserPresence = 'online' | 'offline'`.
- `AgentOnHostDto.online: 'online' | 'offline'` already exists for agents. v1
  introduces `presence` for humans; converging the agent field to the same
  `presence` term is a **follow-up naming task** (do not silently fork — flagged,
  not done here).
- Presence is **ephemeral, process-local, not persisted** (mirrors
  `RunStateCache` / `HostWsAttachment`). The only durable bit is
  `users.last_seen_at` (the timestamp a user was *last seen online*).

## 3. Backend mechanism

### 3.1 PresenceRegistry (new, in-memory)
`Map<userId, Set<connId>>` held in the backend process.

- `onConnect(userId, connId)` — add. On **0 → 1** transition: cancel any pending
  offline grace timer, publish `online`.
- `onDisconnect(userId, connId)` — remove. On **1 → 0** transition: capture
  `disconnectedAt = now` (the moment the *last* connection dropped) and start a
  **grace timer** (default ~20 s). If a new connection arrives before it fires,
  cancel (no flap on reload / network blip). On expiry (still offline): stamp
  `users.touchLastSeen(userId, disconnectedAt)` and publish `offline` with
  `last_seen_at: disconnectedAt`.
  - **`last_seen_at` is the disconnect time, NOT the grace-expiry time.** Using
    the timer's `now` would make every offline systematically ~20 s late. The
    grace window only gates *whether* we go offline; it must not shift *when* the
    user was last seen.
- `isOnline(userId)` — read for the snapshot route.
- `dispose()` — clear all pending offline grace timers. Called from the backend
  close path (and in tests) so timers never leak. Timers also `unref()` so they
  don't keep the process alive, but `dispose()` is the authoritative cleanup.

Grace debounce is **hygiene, not a feature** — without it every page reload
flaps online→offline→online. Kept minimal and configurable.

### 3.2 Wiring (single point)
`ws-server.ts` already owns the connection lifecycle. Generate a `connId`
(uuid) at the upgrade site; call `presence.onConnect(viewerUserId, connId)` next
to `connections.set(ws, …)` (`ws-server.ts:63`) and
`presence.onDisconnect(viewerUserId, connId)` in the `ws.on('close')` handler
(`ws-server.ts:64-66`). EventWsConnection itself is untouched.

### 3.3 Broadcast
On every transition, `ctx.events.publishToScope('app', 'user_presence', payload)`
(`scope-event-bus.ts:102`). Payload:

```ts
interface UserPresenceEvent {
  user_id: string;
  presence: 'online' | 'offline';
  last_seen_at: number | null; // ms; set on the offline transition
}
```

`app` is the existing "global, no private data" scope (`ws-frames.ts:14`).
Presence (who is online) is non-private under the v1 global decision.

### 3.4 Snapshot route (authoritative current state)
`GET /api/presence` → `{ users: UserPresenceDto[] }` for **all** users —
`presence.isOnline(userId)` plus `users.last_seen_at` for everyone offline.

The snapshot scope **must match the broadcast scope**: v1 broadcasts to the
global `app` scope (all users), so the snapshot is also global. Returning only
"users the viewer can see" while broadcasting all transitions would leave the
renderer store receiving `online`/`offline` deltas for users absent from its
seed. Pick one model — v1 is global per shiki's decision. (Per-workspace /
viewer-scoped visibility filtering would require dropping the global `app` scope;
deferred.)

This is also the **recovery path**: `app` scope has a 200-event replay buffer +
epoch (`scope-event-bus.ts`). A client (re)subscribes → gets `SubscribedFrame`
seq → REST-snapshots `/api/presence` → resumes from seq. On `epoch_mismatch` /
`gap_too_large` the same snapshot reconciles. Replayed transition deltas are
ordered and safe to apply on top of the snapshot — standard scope pattern, no
special-casing.

### 3.5 Storage
Append-only migration: add `users.last_seen_at INTEGER` (nullable, ms). New
repo method `users.touchLastSeen(userId, ts)`. Written only on the offline
transition (the moment that defines "last seen").

Edge: a hard server crash while a user is online won't stamp `last_seen_at`, so
it shows the prior value. Acceptable for v1.

## 4. Renderer

Presence is **one orthogonal store**, not smeared across every member DTO:

- A global presence store (React Query `GET /api/presence` seed +
  `app`-scope `user_presence` deltas patched in).
- `usePresence()` / `usePresenceById()` hooks.
- `usePresenceSync()` mounted once in the post-auth app shell. It applies
  `user_presence` deltas directly and invalidates the snapshot on app-scope
  `snapshot_required` (backend restart / replay gap).
- UI:
  - left Members / HUMANS list: online/offline dot per human row;
  - chat header member strip: human chip online/offline overlay dot;
  - `HumanInfoPopover`: inline presence text next to the display name
    (`Online`, `Last seen X ago`, or `Offline`) for header chips, message
    avatars, author labels, and inline `@human` mentions.

`HumanProfileCard` intentionally does **not** show presence, matching the agent
profile card.

Keeping presence out of the member DTOs avoids threading a volatile field
through every members response and lets the UI join by `user_id` at render time.

## 5. Failure modes & boundaries

- **Flap on reconnect** → grace timer (§3.1).
- **Multi-device** → set-of-connections; online until the *last* drops.
- **Crashed tab / killed app (no clean close)** → ping/pong reaps within ~35 s;
  worst-case "ghost online" ≈ 35 s + grace. Acceptable.
- **Single-process assumption** → the in-memory registry assumes one backend
  process (true today: better-sqlite3 single-writer). If standalone ever scales
  horizontally to N processes, presence needs a shared backplane (Redis pub/sub
  or a DB heartbeat table). **Flagged, not solved in v1.**

## 6. Change surface & ownership

**Cindy (backend / shared):**
- `packages/shared`: new `api/presence.ts` with `UserPresenceSchema` (the
  `'online' | 'offline'` enum), `UserPresenceDtoSchema` (`{user_id, presence,
  last_seen_at}`), `UserPresenceEventSchema` (the `user_presence` payload —
  schema'd for renderer parse/test even though the event kind isn't strongly
  registered); `apiPaths.presence = '/api/presence'`; append-only migration for
  `users.last_seen_at`.
- `packages/backend`: `presence/presence-registry.ts` (incl. `dispose()`); wire
  `ws-server.ts` onConnect/onDisconnect + connId; `routes/presence.ts` snapshot;
  `users` repo `touchLastSeen` + last-seen read; hook `dispose()` into the close
  path.

**Backend test minimal set (Cindy):**
- registry: multi-connection `0→1` / `1→0`, grace cancel on reconnect,
  `last_seen` written as `disconnectedAt` (not timer `now`).
- `GET /api/presence`: snapshot includes online set + offline `last_seen`.
- WS open/close publishes `user_presence` **only on transitions** (not per
  connection).

**Alice (renderer / desktop):**
- presence store + `usePresence` hook; avatar status dot; "last seen X ago"
  affordance in member list / chat header / DM list.

**Shared / docs:** this doc is canonical. No CLI surface change.

## 7. Phasing
1. Backend registry + `app` broadcast + snapshot route + `last_seen_at` (Cindy).
2. Renderer store + status dot + last-seen (Alice).
3. Follow-up: converge `AgentOnHostDto.online` → `presence` ubiquitous term.

Deferred (not v1): "away"/idle (needs renderer input-idle detection + report
frame), per-workspace privacy granularity, multi-process backplane.

# Channel visibility (public / private) — v1

This is the canonical contract for channel visibility: the storage model, the
three authorization gates, the membership-scoped projections, self-join, and the
discovery-union list. Code that conflicts with this doc is the bug.

Release invariant: the backend discovery union (§4) and the renderer
consumer-split (§4.2) ship in the **same release** — the union list must never
be served to a renderer that has not classified its consumers by `is_member`.

## 1. Model

A regular channel (`conversations.kind = 'channel'`) has a stored, identity-level
`visibility ∈ {'private', 'public'}` (`ConversationDtoSchema.visibility`).

- `private` (default) — membership-gated. Only `conversation_users` members can
  see or interact with it. This is the historical behavior.
- `public` — every **workspace member** may *browse* it (pure reads) and *self-join*;
  interaction still requires membership.

Invariants:

- `visibility` is **NOT NULL**; existing rows were backfilled explicit `private`
  (no "missing ⇒ private" compatibility branch).
- Only a regular `channel` can be `public`. `dm_channel` (and any legacy thread)
  is always `private`, enforced by a DB CHECK in migration **v58**
  (`visibility = 'private' OR kind = 'channel'`; single cross-column CHECK, no
  triggers).
- `visibility` is **channel identity**, not a per-viewer fact. The per-viewer
  membership bit (`is_member`) is never stored on the identity DTO; it is
  route-computed on read/discovery responses (see §4).

Creation: a channel's members are the creator (implicit) plus any explicit
`member_user_ids` / `member_agent_ids` — there is **no** full-workspace member
snapshot. `public` is a human-actor choice and is rejected on the agent_home DM
path. Making a channel public does **not** add every workspace member to it; it
only opens the browse/join surface.

## 2. The three authorization gates

Membership and readability are **separate axes**. There are exactly three
channel-scoped predicates (`packages/backend/src/permissions.ts`); nothing else
derives membership from kind, list position, or visibility.

### 2.1 `canViewConversation` — strict membership + ALL interaction (UNCHANGED)

Passes only for a `system` principal, an explicit `conversation_users` member
(user), or the bound `conversation_agents` agent. This gates **every write and
interaction**: post, react, save/follow, read-state / ambient / debug, observe,
member ops. It was not widened by this feature — so every interaction path stays
fail-closed for a public non-member by default.

### 2.2 `canReadConversation` — the ONLY public read widening

`canViewConversation(...) OR isPublicChannelBranch(...)`. Grants **pure reads
only** to a public non-member: channel detail, message history, thread read, and
the attachment **bytes** of an attachment referenced by a persisted message in
the channel (in-message preview). The Attachments **panel list**
(`GET /api/channels/:id/attachments`) stays membership-only. This is the single
place the public widening lives.

Bytes-vs-affordance: once the backend serves the bytes of an in-message
attachment to a public non-member, export cannot be *technically* prevented (the
same bytes back a preview and a save). The v1 boundary is therefore a **renderer
affordance** one: for a public non-member the renderer offers **preview only** —
no download / Save-As / open-external control. This is a UX/product line, not a
byte-level access gate.

### 2.3 `canJoinPublicChannel` — self-join admission

`isPublicChannelBranch(...)` used **alone** (no membership short-circuit), so a
member of a non-public target (private / `dm_channel` / archived) is **not**
admitted to `/join` — even an existing member. The use case runs this admission
**before** the already-member idempotency check.

### 2.4 Shared branch `isPublicChannelBranch` (private helper)

The public admission both public predicates share:
`principal.kind === 'user'` ∧ `kind === 'channel'` ∧ `visibility === 'public'`
∧ `archived_at === null` ∧ `canViewWorkspace(...)`. Deliberately
membership-agnostic. Agents have **no** public path; an archived public channel
drops out of the non-member surface (archive ≠ delete — it stays reachable to
members via the membership branch).

Governance (rename / archive / member management) remains membership + workspace
role, unchanged.

## 3. Self-join

`POST /api/channels/:id/join` — the **only** non-member mutation the model
allows. Empty body, self-only wire (the caller can only join themselves; no
forgeable target). Returns `{ channel, is_member: true }` (same envelope as GET
channel detail); first-join and retry are both 200 and identical.

Membership is written through **one shared transition primitive**,
`seedChannelHumanMembership` (`application/conversation-member.ts`), used by BOTH
the admin-add human leg AND self-join — so the two paths cannot drift into two
membership models. It writes the `conversation_users` edge + an insert-only
`mentions` attention preference + a per-stream read-cursor baseline. It is **not
re-entrant** (the `markRead(max)` baseline never regresses but would advance the
cursor if re-run after new messages); zero-increment on retry comes from the
callers' `alreadyMember` guard, not the primitive. Call it ONLY inside a
confirmed fresh-entry (absent-member) transition.

Post-commit, self-join publishes `conversation_members_changed` +
`workspace_channels_changed` **only** — NOT `viewer_workspaces_changed` (workspace
membership is unchanged) and no visible system message.

## 4. Reads: discovery-union list + per-viewer `is_member`

`GET /api/workspaces/:id/channels` (user principal) returns a per-viewer list
where **every active item carries an authoritative `is_member`**
(`WorkspaceChannelListItem`):

- regular workspace → **discovery union**: channels the viewer joined (any
  visibility, `is_member: true`) PLUS active **public** channels the viewer has
  not joined (`is_member: false`). Private non-member channels never appear.
- DM (agent_home) workspace → the viewer's membership-filtered DMs, all
  `is_member: true` (the DM list is strictly membership-filtered).

Repo split (`conversation-repo.ts`), keeping per-viewer facts honest:

- `listActiveChannelsForViewer(workspaceId, viewerUserId)` /
  `listActiveDmChannelsForViewer(workspaceId, viewerUserId)` — the viewer
  projections; `viewerUserId` is **required** (membership is a per-viewer fact —
  there is no viewer-less form, and no branch fabricates `is_member`).
- `listActiveChannelsForWorkspace(workspaceId)` — identity-only (all active
  regular channels, no viewer, no `is_member`) for workspace-wide
  existence/fan-out.

This viewer projection is the **single authoritative channel set** for BOTH the
sidebar list and sort-group validation, so a public channel a viewer can see is
also a reorderable member of their sidebar (display order ≠ auto-select; see
§4.2).

### 4.1 `is_member` shape and the gate

`is_member` is a **flat, per-item** field (regular channel or `dm_channel`), not
the nested detail envelope. The renderer gate reads exactly one field:

- `is_member === true` → member.
- `is_member === false` → non-member (public: show Join).
- field **absent** → `unknown` (older/unaware payload) → fetch channel detail;
  never assume membership from kind, list position, or visibility.

### 4.2 SET-semantics change — NOT a backward-compatible additive change

The `is_member` **field** is additive, but the returned **set** widens from
member-only to a discovery union. An unaware consumer would treat a browse-only
public channel as an ordinary joined channel. Therefore **every** consumer of
this list must classify items, and the backend union and the renderer
consumer-split ship in the **same release** — this list must not be published to
an un-migrated renderer.

- **member-scoped** (must require `is_member === true`; `unknown`/`false` both
  excluded — never "exclude known false", or a missing field fails open):
  restore / default / fallback selection, selection persistence (sort touch),
  member-scoped aggregations (e.g. Tasks), sidebar badge / unread.
- **discovery-aware** (consumes the union incl. `unknown`, resolving via detail):
  sidebar rendering (shows unjoined public, but no badge, no auto-select — click
  only), selected-channel descriptor resolution, Composer `#channel`
  autocomplete, and `#channel` / `#conv:` reference rendering (a link pointing at
  a public channel is a read-side fact and is correct).

## 5. Membership-scoped projections (unchanged by this feature)

Unread, ambient attention, favorites, Activity, archived lists, restore, and
delivery stay **membership-scoped**. A public non-member has no membership row,
so these simply return nothing for that channel — e.g. the workspace unread count
INNER-joins `conversation_users` on the viewer
(`conversation-read-repo.ts`), and `GET /api/channels/:id/message-unread` is
`canViewConversation`-gated (403 for a non-member). "No badge on an unjoined
public channel" is therefore backend-consistent, not client-side suppression.

Not a contradiction with §4: the two "sort" surfaces are different scopes. A
channel's **local sidebar** manual order and local star (§4.2) are viewer-local
*presentation* state over the visible list, so they legitimately cover the
discovery union (an unjoined public channel a viewer can see can be positioned /
locally starred). **Global** Favorites, `lastChannel` restore, default/fallback
selection, and recent-touch persistence remain **membership-scoped** — an
unjoined public channel never enters them. Presentation order ≠ membership
projection.

## 6. Deliberate scope boundaries (v1)

- The agent-facing `silverhand channel list` (`agentListChannels`) is
  **unchanged** — agent-side public-channel discovery / join is out of scope.
- Search and the Archived aggregate stay member-scoped in v1.

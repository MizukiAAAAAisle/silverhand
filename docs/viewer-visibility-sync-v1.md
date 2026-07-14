# Viewer-Visibility Sync — live refresh when a human's cross-workspace membership/role changes

Canonical contract for viewer-scope visibility refresh: the carrier, the event
family, the no-op / secondary-invalidation rules, and the safe-downgrade edge.

## 0. Problem

When a human is pulled into a **new workspace** (or removed, or has their role
changed) by another client/agent, the UI must update without a restart. The
`['workspaces']` list query has no self-refresh of its own — no
`refetchInterval`, and the global query client disables refetch-on-focus — so
focus does not refetch either.

So a workspace mutation initiated by *this same client*
(create/delete/rename/archive/pin all `invalidateQueries(['workspaces'])`)
refreshes the list, but being acted upon by *someone else* would be invisible
until restart — absent the viewer-scope event this doc defines.

### Why the obvious fixes are wrong

- **"Just publish on `workspace:<id>` and have the client refresh"** — fails the
  core case. Before being added, the viewer is **not** subscribed to that
  workspace's scope and *cannot* be (subscription authz requires membership —
  `canViewWorkspace`). You cannot listen on the scope of a
  room you are not yet in. The "added to your **first** workspace" case has no
  workspace scope the client could have been on.
- **"Poll `['workspaces']`"** — reintroduces polling we deliberately don't do;
  wrong altitude for an event-sourced UI.

The correct carrier is a channel keyed to **the viewer themselves**, not to any
workspace they must already belong to.

## 1. Thesis

There is already exactly such a channel: the **`viewer:<userId>` scope**. The
mechanism is not new plumbing — it is (a) a *visibility-changed* event family
on that scope, (b) published from the workspace membership/role mutation
points, and (c) one always-mounted renderer subscription that invalidates
`['workspaces']`.

Crucially, the requirement is **"any change" semantics**, not an
`add`-only patch: added / removed / role-changed are one event family, and the
design must be shaped so future viewer-visibility facts ride the same rail
without a new mechanism each time.

## 2. What already exists (do not rebuild)

The `viewer:<userId>` scope is live end-to-end and carries the two contract
properties this design depends on:

- **Self-only authz.** Subscription is gated to `principal.userId ===
  targetUserId`: a viewer can subscribe **only** to their own `viewer:<id>`. So
  publishing membership facts on this scope leaks nothing cross-user — the
  security boundary is already correct.
- **Bootstrap-independent.** The scope is keyed to the authenticated viewer
  (the client-side `viewer:self` alias is canonicalized server-side to the
  resolved `viewer:<id>` from the session), so it **works before the viewer is
  in any workspace** — independent of workspace membership. That is exactly the
  bootstrap property the problem needs.

The existing viewer-scope consumers (unread/badges, saved, notifications) all
follow one idiom: subscribe → filter by current-viewer-scope + frame kind →
invalidate. This design adds another consumer on the same rail.

## 3. Design

### 3.1 Event family (the contract)

One event kind, coarse trigger + structured hints:

```
kind: 'viewer_workspaces_changed'
scope: viewer:<userId>            // the AFFECTED user, always
payload: {
  change: 'added' | 'removed' | 'role_changed',
  workspace_id: string,
  role?: WorkspaceRole,           // present iff change === 'added' | 'role_changed'
}
```

**Design stance — coarse trigger, not a state delta.** Correctness must NOT
depend on the payload. The renderer treats any `viewer_workspaces_changed` as
"your workspace set/role may have changed → refetch `['workspaces']`", and the
refetch is the authority (the server already returns *exactly this viewer's*
workspaces). `change`/`workspace_id`/`role` are **hints** for targeted secondary
work (safe-downgrade on removal, re-gate governance UI on role change) — never
the source of truth. This mirrors how `workspace_channels_changed` /
`unread_updated` already behave (invalidation triggers, not deltas) and makes
the event naturally idempotent and replay-safe.

Why a single kind with a `change` discriminator rather than three kinds: the
"any change" requirement. The renderer's primary action is identical for all
three (invalidate `['workspaces']`); only the secondary effects branch. One kind
keeps the rail open for future viewer-visibility facts (e.g. workspace deleted
out from under a member) by adding a `change` variant, not a new subscription.

The kind name `viewer_workspaces_changed` is deliberately narrower than a
generic `viewer_visibility_changed`, so notifications / other viewer-private
facts don't get vacuumed into it.

**Required secondary invalidation (contract, not optional):** on
`change === 'role_changed'` the renderer MUST also invalidate
`membersKey(workspace_id)` (`['workspaces', id, 'members']`) in addition to
`['workspaces']`. Rationale: the governance UI's `viewerRole` is sourced from
`GET /api/workspaces/:id/members` (`useWorkspaceMemberLists`), **not** from the
workspace list — invalidating only `['workspaces']` would leave stale role gates.
This is part of the contract so the publisher and consumer agree it is mandatory,
not a nicety.

**No-op suppression (contract):** the event name is `*_changed`, so it MUST fire
only on a *real* change. Both backend mutation points can produce no-op shapes —
`addUserMember` is `INSERT OR IGNORE` then returns the row (re-add of an existing
member = no change); `setUserRole` will `UPDATE … RETURNING` even when the new
role equals the old. The publisher MUST gate on the actual delta (`created`
flag for add; `oldRole !== newRole` for role change) and skip publish otherwise.
Repeated publishes are harmless to `invalidate` (idempotent), but they pollute
event semantics and must not be relied on or emitted.

### 3.2 Backend publish points

Publish to `viewer:<affectedUserId>` **after the mutation commits**, at the
three human-membership mutation points, each carrying its `change` variant:

- **add human to workspace** → `change:'added', workspace_id, role`
- **change human role** → `change:'role_changed', workspace_id, role`
- **remove human from workspace** → `change:'removed', workspace_id`

Contract facts:

- **One publish path, not three.** All three branches publish through a single
  helper, and the no-op delta check (§3.1) lives with each mutation. Consistent
  with the project's route→use-case direction (`docs/use-case-layer-p0-spec.md`).
- **Human-remove is owner-only and cannot remove the owner** (there must always
  be an owner; ownership transfer is unsupported), unlike admin-gated human add
  and the agent-only remove. It mirrors the agent-remove cascade: for every
  conversation containing the human it deletes the `conversation_users` row and
  inserts a `conversation_member_removed` system message, deletes the
  `workspace_users` row in the same transaction, then publishes the `removed`
  event as a post-commit effect.
- **Agents have no viewer scope** — agent workspace membership changes stay on
  `workspace:<id>` (the members panel already covers that). This event is
  **human-only**.
- **Post-commit discipline**: publish after the DB write, consistent with the
  use-case `PostCommitEffect` pattern (`docs/use-case-layer-p0-spec.md`).

### 3.3 Renderer subscription

One always-mounted hook subscribes to the viewer scope, mounted **after auth and
independent of any workspace selection** — so the sidebar not being rendered (the
"first workspace" case) cannot gate it. On a `viewer_workspaces_changed` frame on
the current viewer scope it:

- **always** invalidates `['workspaces']` (the authority refetch);
- on `change === 'role_changed'`, **additionally** invalidates
  `membersKey(workspace_id)` (§3.1 required secondary invalidation);
- on `change === 'removed'` for the currently selected workspace, runs the
  safe-downgrade (§3.4).

A `snapshot_required` frame on the viewer scope also invalidates `['workspaces']`
(replay-gap safety), matching the other viewer consumers. Payload fields are
treated as hints only — never the source of truth (§3.1).

### 3.4 Safe-downgrade on removal (the one non-trivial UX edge)

If the viewer is removed from the workspace they are **currently viewing**, the
selection now points at a workspace they can no longer access — subsequent
queries would 403 and could surface as a broken/blank pane. On
`change:'removed' && workspace_id === selected`, the renderer must move
selection to a safe fallback (first remaining workspace, else the empty/no-
workspace state) **before** the refetch removes the row. This is the only piece
that needs care; everything else is a coarse invalidate.

## 4. Scope boundary (what this is NOT)

- Not a generic "domain event" system — single kind on an existing scope, zero
  new infrastructure. Consistent with the standing decision to not introduce
  domain-events (`docs/use-case-layer-p0-spec.md` §2.2): consumer side is
  WS/UI-only, no aggregate cross-subscription/audit.
- Not client-side patching of `['workspaces']` — refetch is authority.
- Not touching agent membership routing (stays on `workspace:<id>`).
- Not subscribing to per-workspace scopes to catch membership — rejected in §0
  (bootstrap impossibility).

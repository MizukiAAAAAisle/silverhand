# Viewer-Visibility Sync v1 — live refresh when a human's cross-workspace membership/role changes

Status: **draft for review** (Alice, #task:995). Reviewer: Cindy (event contract +
backend feasibility). Implementation gated on shiki.

## 0. Problem

When a human is pulled into a **new workspace** (or removed, or has their role
changed) by another client/agent, the UI does not update. Concretely
(grounded against current code):

- `useWorkspaces()` (`apps/desktop/src/renderer/features/workspaces/hooks.ts:121-129`)
  is a bare `useQuery` keyed `['workspaces']` — **no WS subscription, no
  `refetchInterval`**.
- Global query client (`apps/desktop/src/renderer/lib/queryClient.ts:3-11`):
  `refetchOnWindowFocus: false`, `staleTime: 5_000`, `retry: 1`. So focus does
  not refetch either.
- Backend `POST /api/workspaces/:id/members` (human branch,
  `packages/backend/src/routes/membership.ts:145-154`) calls
  `workspaces.addUserMember(...)` and returns — **publishes no event**. Same for
  role change (`setUserRole`, `membership.ts:214`) and agent removal
  (`removeMember`, `membership.ts:244`).

Net: the only ways `['workspaces']` updates today are (a) a workspace mutation
**initiated by this same client** (create/delete/rename/archive/pin all
`invalidateQueries(['workspaces'])`), or (b) an app restart / remount. Being
acted upon by *someone else* is invisible until restart.

### Why the obvious fixes are wrong

- **"Just publish on `workspace:<id>` and have the client refresh"** — fails the
  core case. Before being added, the viewer is **not** subscribed to that
  workspace's scope and *cannot* be (subscription authz requires membership —
  `canViewWorkspace`, `permissions.ts`). You cannot listen on the scope of a
  room you are not yet in. The "added to your **first** workspace" case has no
  workspace scope the client could have been on.
- **"Poll `['workspaces']`"** — reintroduces polling we deliberately don't do;
  wrong altitude for an event-sourced UI.

The correct carrier is a channel keyed to **the viewer themselves**, not to any
workspace they must already belong to.

## 1. Thesis

There is already exactly such a channel: the **`viewer:<userId>` scope**. The
fix is not new plumbing — it is (a) defining a *visibility-changed* event family
on that scope, (b) publishing it from the workspace membership/role mutation
points that currently emit nothing, and (c) one always-mounted renderer
subscription that invalidates `['workspaces']`.

Crucially, the requirement (per shiki) is **"any change" semantics**, not an
`add`-only patch: added / removed / role-changed are one event family, and the
design must be shaped so future viewer-visibility facts ride the same rail
without a new mechanism each time.

## 2. What already exists (grounded — do not rebuild)

The `viewer:<userId>` scope is live end-to-end:

- **Bus**: `viewer:{userId}` is a first-class scope layer
  (`packages/backend/src/ws/scope-event-bus.ts:14-18`); publish via
  `publishToScope('viewer:'+userId, kind, payload)`. A helper for the
  conversation-fanout case already exists
  (`packages/backend/src/viewer-scope.ts:19-29`).
- **Authz (self-only)**: subscription is gated by `canSubscribeScope` →
  `canViewOwnedState` (`packages/backend/src/permissions.ts:463-496`):
  `principal.userId === targetUserId`. A viewer can subscribe **only** to their
  own `viewer:<id>`. So publishing membership facts here leaks nothing
  cross-user — the security boundary is already correct.
- **Renderer**: `subscribeViewerScope()` + `isCurrentViewerScope(scope)` +
  `VIEWER_SCOPE_ALIAS = 'viewer:self'`
  (`apps/desktop/src/renderer/lib/ws-client.ts:143,400,411,418`). The alias is
  canonicalized server-side to the resolved `viewer:<id>` (WS auth resolves the
  user from the session cookie — `packages/backend/src/ws/ws-server.ts:118-126`).
- **Three live consumers** already follow the idiom (subscribe → filter by
  `isCurrentViewerScope` + `frame.kind` → invalidate): unread/badges
  (`features/channels/hooks.ts:976`, `notifications/hooks.ts:55,168`), saved
  (`features/saved/hooks.ts:38`).

Implication: this scope **already works before the viewer is in any workspace**
— it is keyed to the authenticated viewer, independent of workspace membership.
That is exactly the bootstrap property the problem needs.

## 3. Design

### 3.1 Event family (the contract Cindy reviews)

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

Why a single kind with a `change` discriminator rather than three kinds: shiki's
"any change" requirement. The renderer's primary action is identical for all
three (invalidate `['workspaces']`); only the secondary effects branch. One kind
keeps the rail open for future viewer-visibility facts (e.g. workspace deleted
out from under a member) by adding a `change` variant, not a new subscription.

Kind name `viewer_workspaces_changed` is **settled** (Cindy review): narrower
boundary than a generic `viewer_visibility_changed`, so notifications / other
viewer-private facts don't get vacuumed into it.

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

### 3.2 Backend publish points (Cindy implements)

Publish to `viewer:<affectedUserId>` after the mutation commits, at:

| Mutation | Location (current) | Publish |
|---|---|---|
| add human to workspace | `routes/membership.ts:153` `addUserMember` | `change:'added', workspace_id, role` |
| change human role | `routes/membership.ts:214` `setUserRole` | `change:'role_changed', workspace_id, role` |
| remove human from workspace | **no endpoint today** (DELETE members is agent-only, `membership.ts:244`) | `change:'removed', workspace_id` |

Notes / dependencies for review:
- **Remove-human is a gap (confirmed)**: no public endpoint today — only
  persistence methods exist (`WorkspaceRepo.removeUserMember`,
  `ConversationRepo.removeUser`); the `DELETE /workspaces/:id/members/:agentId`
  route is agent-only (`membership.ts:244`). v1 ships **add + role_changed**;
  `'removed'` is reserved in the enum but **not** emitted until a
  remove-human-from-workspace endpoint lands (P2).
- **Centralize publish (Cindy):** do **not** hand-write two publish blocks in the
  two route branches. Add a thin workspace-human-membership use case (or at
  minimum a route-local helper) that owns: the no-op delta check (§3.1) + the
  post-commit publish to `viewer:<userId>`. Consistent with the project's
  route→use-case direction (`docs/use-case-layer-p0-spec.md`) and keeps the
  no-op rule in exactly one place.
- **Agents have no viewer scope** — agent workspace membership changes stay on
  `workspace:<id>` (members panel already covers that). This event is
  **human-only**.
- **Post-commit discipline**: publish after the DB write, consistent with the
  use-case `PostCommitEffect` pattern (`docs/use-case-layer-p0-spec.md`).

### 3.3 Renderer subscription (Alice implements)

One always-mounted hook, `useViewerWorkspacesSync()`, called once in
`RegisteredAppShell` (`apps/desktop/src/renderer/App.tsx:175`) — it must be
mounted **after auth and independent of any workspace selection**, so the
sidebar not being rendered (the "first workspace" case) cannot gate it. Pattern
copies the existing viewer consumers:

```ts
const sub = subscribeViewerScope();
const off = onWsFrame(frame => {
  if (frame.type === 'snapshot_required' && isCurrentViewerScope(frame.scope)) {
    qc.invalidateQueries({ queryKey: ['workspaces'] });
    return;
  }
  if (frame.type !== 'event' || !isCurrentViewerScope(frame.scope)) return;
  if (frame.kind !== 'viewer_workspaces_changed') return;

  qc.invalidateQueries({ queryKey: ['workspaces'] });        // always — authority refetch

  const p = frame.payload as ViewerWorkspacesChangedPayload;  // hints only
  if (p.change === 'role_changed') {
    qc.invalidateQueries({ queryKey: ['workspaces', p.workspace_id, 'members'] });
  }
  if (p.change === 'removed' && p.workspace_id === currentlySelectedWorkspaceId) {
    selectSafeFallbackWorkspace();   // see §3.4
  }
});
```

`snapshot_required` on the viewer scope also invalidates `['workspaces']`
(replay-gap safety), matching the other viewer consumers.

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

## 5. Phasing

- **P1**: enum + `change:'added'|'role_changed'` publish points + renderer
  `useViewerWorkspacesSync` (invalidate `['workspaces']` + role→members) +
  safe-downgrade scaffold. Covers the reported bug (added to new workspace) and
  role changes (needed once #992 role-setting UI lands).
- **P2**: `change:'removed'` once a remove-human-from-workspace endpoint exists;
  wire safe-downgrade live.

## 6. Resolved (Cindy review, 2026-06-10)

Direction PASS; contract settled:

1. Kind name `viewer_workspaces_changed`; single kind + `change` discriminator
   (not three kinds).
2. Coarse trigger + hints; payload is never source of truth — refetch
   `['workspaces']` is authority. (folded into §3.1)
3. Remove-human endpoint does not exist → v1 = add + role_changed; `'removed'`
   reserved, not emitted. (folded into §3.2)
4. No-op suppression is mandatory (`created` / `oldRole !== newRole`), centralized
   in a thin human-membership use case / helper — not duplicated across route
   branches. (folded into §3.1, §3.2)
5. `role_changed` MUST also invalidate `membersKey(workspace_id)` — required
   secondary invalidation, in the contract. (folded into §3.1)
6. `workspace deleted while you're a member` eventually shares this kind, but
   it's an owner-only destructive surface — **not** in P1.

Ready to implement on shiki's go-ahead: renderer (`useViewerWorkspacesSync` at
`RegisteredAppShell`) = Alice; backend (thin human-membership use case +
viewer-scope publish) = Cindy.

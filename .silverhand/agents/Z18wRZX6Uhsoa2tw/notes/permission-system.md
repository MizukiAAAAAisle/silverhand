# Silverhand Permission System (holistic design)

Captured 2026-05-06 in "Attachment 鉴权讨论" channel. Awaiting user review.

## Current model (v1, embedded mode)

- One shared `auth_token` for "is this allowed to talk to backend".
- `X-Silverhand-User-Id` header is renderer-declared, backend-trusted, hard-coded to `local`.
- Public router (`/api/*`) has no Bearer; some routes require viewer header,
  some don't. Attachment GET has neither.
- Internal router (`/internal/*`) requires Bearer + agent membership check.
- WS auth: first-frame token + viewer scope. Already does ACL via `ws/permissions.ts`.
- `workspace_members` table is **agent**-only. No human membership table.
- ACL functions (`canViewWorkspace`, `canViewConversation`) are placeholders
  returning "exists?".

## Three principals × three transports × four ACL families

### Principals (identity)
- `human`: UI viewer. v1: `{kind:'human', id:'local'}`.
- `agent`: spawned CLI. id+conversationId hard-bound at chat-bridge spawn.
- `system`: backend itself. Cannot be injected via external HTTP.

### Transport mechanisms (token → principal)
- **Embedded shared token (v1)**: shared `auth_token`; principal declared in
  `X-Silverhand-Principal` header but constrained by token context (e.g.
  chat-bridge can only declare its bound agent id).
- **Per-principal session token (multi-user/remote)**: humans get session on
  login; agents get short-lived backend-signed token at spawn (claims lock
  agent_id + conversation_id).
- **Signed URL token**: HMAC payload `{resource_id, principal_scope, exp, kv}`,
  always backend-minted. Two distinct kinds, no shared helper:
  - `attachment-view-token` for `<img src>`, viewer-scoped, short TTL.
  - `attachment-share-link` for external sharing, separate audit + revocation.

### Middleware layers
- Identity layer (mounted broadly): `requireBearer → resolvePrincipal`.
  Allowlist: `/api/health` only.
- ACL layer (mounted per-route): `requireWorkspaceView`, `requireConversationView`,
  `requireAttachmentView`, `requireOwnedResource`.
- Identity and ACL strictly separated.

### Resource ACL families
- Workspace: view / mutate / manageMembers
- Conversation/Channel/Thread: view / post / createThread (inherits workspace)
- Per-resource (attachment, future avatar/profile): inherits parent ACL
- Per-viewer state (unread/saved/notifications/tasks): only owning principal

### Mutation authority matrix
- Create workspace / manage members: human + system. Agents cannot.
- Create channel/thread, post normal message, upload attachment: human + agent
  (agent limited to its bound conversation/channel).
- Post `from_kind='system'` message: system only. Invariant must hold at repo
  layer. No HTTP route exposes it.

## v1 implementation plan (4 slices, increasing risk)

**Slice A — naming + structure (zero behavior change)**
- Introduce `Principal` type + `resolvePrincipal()` middleware in `shared`.
- Rename header to `X-Silverhand-Principal` (`human:local` / `agent:<id>`),
  keep old header for one-version compat.
- All `canView*` functions take `Principal` instead of `viewerUserId: string`.
- Ship `docs/permissions.md`.

**Slice B — Bearer rollout**
- Mount `requireBearer` on `/api/*`, allowlist `/api/health`.
- Renderer already sends Bearer; no UX change.
- Tests: 401/200 across public routes.

**Slice C — Attachment ACL (the locked plan from this channel)**
- Per `attachment-auth.md`.

**Slice D — Public CRUD ACL placeholder**
- Workspace CRUD / member add/remove gain `requireWorkspaceMutate(principal, ws)`.
- v1 implementation: `principal.kind === 'human'` (permissive). Multi-user
  swaps implementation only.

## Deferred (multi-user / remote)

Trigger: must land **before** a second human user OR non-loopback exposure.
Not after.

Named artifacts (so future PRs don't collide):
- `human_workspace_members(workspace_id, user_id, role)` — separate from the
  agent `workspace_members` table.
- `users(id, ...)` table + session management.
- Per-principal session tokens replacing shared `auth_token`.
- Backend-signed agent token at spawn (claims lock identity).
- `attachment-view-token` / `attachment-share-link` helpers (independent).
- Avatar/profile ACL (workspace or app scope, not channel).
- Audit log for workspace/membership mutations.

## Open invariants

1. `from_kind='system'` messages cannot originate from external HTTP. Repo
   layer must enforce.
2. Agent identity (`agent_id`, `conversation_id`) is fixed by spawn-time
   parameters and cannot be overridden by request body/header.
3. Cross-channel reads at HTTP level are blocked by membership checks; agents
   never see foreign-channel messages because drainInbox only feeds their own.

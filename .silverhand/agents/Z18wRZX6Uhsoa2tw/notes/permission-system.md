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

**Slice A' — Principal unification (post-isomorphism refactor)**
- Refactor `0ca99ce` already extracted per-service `*Actor` unions
  (`SendMessageActor`, `ChannelActor`, `TaskActor`, `ThreadActor`) and made
  human/agent paths share service methods. Each service has its own actor union.
- Fold all `*Actor` unions into one `Principal` type **kept in backend, not
  shared**:
  `{kind:'user',userId} | {kind:'agent',agentId,conversationId?} | {kind:'system'}`.
  Shared only exports the header constant + encode/decode helpers
  (`encodeUserPrincipalHeader('local') → 'user:local'`); the union stays
  server-side so future session-claim logic stays inside the backend.
- Routes get a `resolvePrincipal()` middleware that produces `c.var.principal`
  from token + header + URL path. Handlers stop hand-constructing actors.
- Public router middleware: principal kind constrained to `'user'` (or
  future session). Reads `X-Silverhand-Principal` header.
- Internal router middleware: **principal MUST come from URL + bearer +
  `conversations.getAgent(cid, aid)`. Header is rejected with 400 if
  present** — not silently ignored, so misuse fails loudly in tests.
- Fold `AttachmentService.createdByKind/createdById` into Principal too.
- **Hard scope guard**: Slice A' does NOT mount `requireBearer` on `/api/*`.
  That's Slice B. If a PR labelled A' touches the public Bearer surface, it
  is rejected — the "zero behavior change" claim only holds when A' stays
  structural.
- Behavior delta is zero for legitimate clients; the only new rejection
  surface is the principal-validation middleware (forged agent claims
  blocked). Document this in the PR description.
- `agent_home` workspace rules: NOT implemented in A'. v1 stays
  exists-check for all workspaces. `docs/permissions.md` documents the
  future rule (owner agent + local human / future human admin) so
  implementation has a target.
- **Hard acceptance tests** (regression guards for slice scope):
  - `test_public_no_bearer_unchanged` — pick 2–3 non-attachment `/api/*`
    paths (`GET /api/workspaces`, `GET /api/runtimes`, etc.); assert no-Bearer
    requests still return 200. Catches accidental Slice B bleed-through.
  - `test_internal_rejects_principal_header` — any `/internal/.../:cid/:aid/...`
    route with `X-Silverhand-Principal: agent:foo` returns 400. Catches
    silent-ignore of the header.
  - **Failure interpretation**: if `test_public_no_bearer_unchanged` fails,
    treat it as scope creep (Slice B bleeding into A'). **Do not "fix" by
    adding Bearer/token plumbing in A'**; revert the offending change and
    leave Bearer rollout to Slice B.

**Slice B — Bearer rollout**
- Mount `requireBearer` on `/api/*`, allowlist `/api/health`.
- Renderer already sends Bearer; no UX change.
- Tests: 401/200 across public routes.

**Slice C — Attachment ACL (the locked plan from this channel)**
- Per `attachment-auth.md`. Note the refactor's comment in
  `attachment-service.ts:137-143` claims "caller has already passed
  channel-membership / viewer auth at the route layer" but the route
  (`routes.ts:1043-1049`) does neither — comment is a placeholder, not a fact.

**Slice D — Public CRUD ACL placeholder**
- Workspace CRUD / member add/remove gain `requireWorkspaceMutate(principal, ws)`.
- v1 implementation: `principal.kind === 'user'` (permissive). Multi-user
  swaps implementation only.

**Recommended order**: A' → C → B → D → docs/permissions.md.
A' first because B/C/D all depend on the Principal abstraction; doing C first
would require reworking the attachment route again when A' lands.

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

# Attachment Auth (v1 + deferred evolution)

Locked design from the "Attachment 鉴权讨论" channel with @Cindy.

## Problem
`GET /api/attachments/:id` is on the public router with no Bearer and no ACL —
it streams to anyone who can reach 127.0.0.1. The renderer already sends
`Authorization: Bearer` + `X-Silverhand-User-Id`, the route just ignores them.
Internal `agentLocateAttachment` already does Bearer + caller + channel
membership; agents go through it.

## v1 plan (locked)
1. `requireBearer` + `requireViewer` route helpers. **Mounted only on
   attachment download/upload/delete** — do not `app.use('*')` them on the
   public router (would silently change health/runtimes/hosts probe semantics
   and existing tests). A full public-Bearer rollout is a separate slice.
2. `AttachmentService.serveForViewer(id, canViewConversationId)` —
   service takes a narrow ACL callback, not `BackendContext`. Service folds
   `not-found` and `ACL denied` into the same `null`. Route maps to **same-
   shape 404 body** for both. Existence opacity is a test assertion.
3. Route calls `canViewConversation(ctx, viewerUserId, channelId)` as the
   callback. `canViewConversation` stays as today (`conversation exists`
   placeholder) — when membership lands, all attachment downloads benefit
   automatically.
4. Comment on `permissions.canViewConversation` must spell out:
   - v1 semantics (placeholder, exists-check only),
   - that `X-Silverhand-User-Id` is a **local viewer hint** only;
     remote/multi-user identity must come from session/token claims, header
     downgrades to debug/compat.
5. Tests: 401 (missing/wrong Bearer), 200 (Bearer + viewer + ACL pass),
   404 row-missing **and** 404 ACL-denied with **identical body shape**.
   Existing attachment tests get the headers added consistently.
6. docs/mcp-system.md §5 and docs/core-design.md §10 gain an "Attachment auth
   model (v1 + remote evolution)" section, naming the deferred artifacts so
   future PRs don't collide.

## Deferred (not in v1)
- `human_workspace_members(workspace_id, user_id, role)` — separate table.
  **Do not reuse `workspace_members`**; that one is already the agent
  membership table (`packages/shared/src/db/migrations.ts:324`). Trigger:
  must land **before** a second human user or non-loopback exposure, not
  after.
- `attachment-view-token` — backend-minted short-lived token for renderer
  `<img src>` to skip the blob-fetch indirection. Mint must happen in the
  backend (HMAC secret stays out of the renderer). Payload:
  `{id, viewer_scope, exp, kv}`. Key version included for rotation.
- `attachment-share-link` — separate authorization semantics (potentially
  anonymous, revocable, audited). Different route, different signer, own
  revocation list. **Must not share helpers with the view-token path.**
- avatar/profile ACL — shares `requireBearer/requireViewer` identity layer
  but resource ACL is workspace/app-scoped, not channel-scoped. Separate
  middleware.

## Ownership
@Cindy implements; @Alice reviews.

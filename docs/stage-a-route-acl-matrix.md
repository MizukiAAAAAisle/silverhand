# Stage A Route ACL Matrix

Status: A.3 audit artifact only. Source audited from
`packages/backend/src/routes.ts` at `ef53814`.

This file intentionally does not prescribe schema changes. The A.3 code pass
should use it to remove the legacy `app_settings.viewer_user_id` principal
fallback, converge session-auth viewer failures to 401, and close route ACL
gaps without changing Stage B host ownership schema early.

## Legend

| ACL class | Meaning |
| --- | --- |
| Public | Anonymous or credential route. It may have auth semantics, but no resource owner gate. |
| Direct owner | The route is scoped to a row owned by one user/agent, or to the current viewer's own state. |
| Membership edge | The route is scoped by a workspace or conversation membership table. |
| Inherited via parent | The resource has no standalone ACL and inherits from its parent conversation, workspace, or owning message. |
| Agent principal | Internal agent-token routes. The principal is `(conversation_id, agent_id)` and every requested target must be reachable from that principal. |

## A.3 Boundaries

| Boundary | Decision |
| --- | --- |
| `app_settings.viewer_user_id` | Remove as a principal fallback. C.5 also stops auth/bootstrap writes; the row/key remains only for settings hide/reject compatibility until D-stage schema cleanup. |
| Pre-register 403 | Preserve `registration_required` for the true no-viewer/no-setup bootstrap state. Session-bearer failures remain 401. |
| Legacy principal headers | Keep during transition, but do not let them reintroduce a settings fallback. |
| A.3 -> A.4 desktop dev gap | Removing the settings fallback before A.4 session UI lands means embedded desktop on the integration branch stays at `registration_required`. Manual HTTP tests must send `X-Silverhand-User-Id` or `X-Silverhand-Principal`; do not add a transient main-process compat patch that reads settings again. Treat A.3+A.4 as one releasable unit. |
| `hosts` ownership | Target class is direct owner, but the owner column/table belongs to Stage B.1. Do not invent a host schema in A.3. |
| Saved messages | Current schema is global by `message_id`. A.3 can gate by message/conversation visibility, but true per-user saved state requires a later schema decision. |
| Cross-user namespace ops | Default to 404 over 403 when denying access would otherwise leak another user's resource namespace. |

## Public/Auth/Host Metadata Routes

| Method | Route | ACL class | Current gate | A.3 action |
| --- | --- | --- | --- | --- |
| GET | `/api/health` | Public | Explicitly skipped by principal + registration middleware. | Keep public. |
| GET | `/api/server/info` | Public | Explicitly skipped; returns signup runtime config. | Keep public. |
| POST | `/auth/signup` | Public | Route owns credential uniformity; route only mounted when startup config enables signup. | Keep public. |
| POST | `/auth/login` | Public | Route owns credential uniformity and issues session token. | Keep public. |
| POST | `/auth/logout` | Public | Validates bearer session token inside route and revokes it. | Keep route-local 401 semantics. |
| GET | `/api/runtimes` | Public | Requires public middleware/gate, no resource owner. | Keep authenticated metadata. |
| GET | `/api/hosts` | Direct owner, Stage B.1 pending | Currently returns all hosts after viewer gate. | Mark as B.1-owned; do not add host schema in A.3. |

## Workspace Routes

| Method | Route | ACL class | Current gate | A.3 action |
| --- | --- | --- | --- | --- |
| GET | `/api/workspaces` | Membership edge | Filters `workspaces.list()` through `canViewWorkspace`. | Keep. |
| POST | `/api/workspaces` | Direct creator + membership edge | Requires user principal; creator is inserted into `workspace_users`. | Keep. |
| GET | `/api/workspaces/:id` | Membership edge | `canViewWorkspace`. | Keep. |
| PATCH | `/api/workspaces/:id` | Membership edge | `canMutateWorkspace`. | Keep. |
| PATCH | `/api/workspaces/:id/archive` | Membership edge | `canMutateWorkspace`. | Keep. |
| POST | `/api/workspaces/:id/pin` | Membership edge | `canMutateWorkspace`. | Keep. |
| DELETE | `/api/workspaces/:id/pin` | Membership edge | `canMutateWorkspace`. | Keep. |
| DELETE | `/api/workspaces/:id` | Membership edge | `canMutateWorkspace`. | Keep. |
| GET | `/api/workspaces/:id/channels` | Membership edge | `canViewWorkspace`; repo filters channel/thread rows by `conversation_users` for users. | Keep. |
| GET | `/api/workspaces/:id/channels/archived` | Membership edge | `canViewWorkspace`; repo filters by `conversation_users` for users. | Keep. |
| GET | `/api/archived-channels` | Membership edge | Optional workspace `canViewWorkspace`; repo filters by `conversation_users` for users. | Keep. |
| POST | `/api/workspaces/:id/channels` | Membership edge | `canMutateWorkspace`; created conversation seeds user/agent membership. | Keep. |
| GET | `/api/workspaces/:id/members` | Membership edge | `canViewWorkspace`. | Keep. |
| POST | `/api/workspaces/:id/members` | Membership edge | `canManageMembers`. | Keep. |
| DELETE | `/api/workspaces/:id/members/:agentId` | Membership edge | `canManageMembers`. | Keep. |
| GET | `/api/workspaces/:id/message-unread` | Direct owner + membership edge | `canViewWorkspace` and `requireViewerUserId`. | Keep after fallback removal. |

## Conversation/Message Routes

| Method | Route | ACL class | Current gate | A.3 action |
| --- | --- | --- | --- | --- |
| GET | `/api/message-unread-summary` | Direct owner | `requireViewerUserId` + `canViewOwnedState`. | Keep after fallback removal. |
| GET | `/api/channels/:id/message-unread` | Direct owner + membership edge | `canViewConversation`, `requireViewerUserId`, `canViewOwnedState`. | Keep after fallback removal. |
| GET | `/api/channels/:id/messages` | Membership edge | Channel kind guard + `canViewConversation`. | Keep. |
| GET | `/api/channels/:id` | Membership edge | Channel kind guard + `canViewConversation`. | Keep. |
| GET | `/api/threads/:id` | Membership edge | Thread kind guard + `canViewConversation`. | Keep. |
| GET | `/api/conversations/:id/ref` | Membership edge | Currently `canViewWorkspace` only. | Tighten to `canViewConversation` unless product explicitly wants workspace-wide ref lookup. |
| GET | `/api/conversations/:id/log-debug` | Membership edge | `canViewConversation`. | Keep. |
| POST | `/api/conversations/:id/log-debug` | Membership edge | `canViewConversation`, user-principal audit. | Keep. |
| GET | `/api/conversations/:id/members` | Membership edge | `canViewConversation`. | Keep. |
| GET | `/api/threads/:id/messages` | Membership edge | Thread kind guard + `canViewConversation`. | Keep. |
| GET | `/api/channels/:id/agents` | Membership edge | `canViewConversation`. | Keep. |
| GET | `/api/threads/:id/agents` | Membership edge | `canViewConversation`. | Keep. |
| POST | `/api/channels/:id/pin` | Membership edge | `canMutateWorkspace` on channel workspace. | Keep. |
| DELETE | `/api/channels/:id/pin` | Membership edge | `canMutateWorkspace` on channel workspace. | Keep. |
| PATCH | `/api/channels/:id/archive` | Membership edge | `canMutateWorkspace` on conversation workspace. | Keep. |
| GET | `/api/channels/:id/agent-run-states` | Membership edge | `canViewConversation`. | Keep. |
| GET | `/api/threads/:id/agent-run-states` | Membership edge | `canViewConversation`. | Keep. |
| POST | `/api/channels/:id/messages` | Membership edge | `canPostToConversation`. | Keep. |
| POST | `/api/threads/:id/messages` | Membership edge | `canPostToConversation`. | Keep. |
| POST | `/api/channels/:id/mark-read` | Direct owner + membership edge | `canViewConversation`; helper uses `requireViewerUserId` + `canViewOwnedState`. | Keep after fallback removal. |
| POST | `/api/threads/:id/mark-read` | Direct owner + membership edge | `canViewConversation`; helper uses `requireViewerUserId` + `canViewOwnedState`. | Keep after fallback removal. |
| GET | `/api/channels/:id/threads` | Membership edge | Parent `canViewConversation`. | Keep. |
| GET | `/api/saved` | Inherited via parent, schema gap | Currently returns all saved rows. | Filter to messages whose conversations are visible; note per-user save schema gap. |
| POST | `/api/messages/:id/save` | Inherited via parent, schema gap | Currently only checks message existence. | Add message conversation `canViewConversation` gate. |
| DELETE | `/api/messages/:id/save` | Inherited via parent, schema gap | Currently removes by id without message visibility check. | Add message conversation visibility gate before delete. |
| GET | `/api/search` | Inherited via parent | Currently searches globally after viewer gate. | Scope results to conversations visible to the viewer. |
| POST | `/api/messages/:id/thread` | Inherited via parent | Message conversation `canPostToConversation`. | Keep. |

## Attachment Routes

| Method | Route | ACL class | Current gate | A.3 action |
| --- | --- | --- | --- | --- |
| POST | `/api/channels/:id/attachments` | Inherited via parent | Channel kind guard, `requireViewerUserId`, `canPostToConversation`. | Keep after fallback removal. |
| POST | `/api/threads/:id/attachments` | Inherited via parent | Thread kind guard, `requireViewerUserId`, `canPostToConversation`. | Keep after fallback removal. |
| GET | `/api/attachments/:id` | Inherited via parent | `AttachmentService.serveForViewer` with `canViewAttachment`. | Keep after fallback removal. |
| DELETE | `/api/attachments/:id` | Inherited via parent + uploader owner | `canDeleteAttachment` requires conversation visibility and uploader identity. | Keep after fallback removal. |

## Conversation Agent Control Routes

| Method | Route | ACL class | Current gate | A.3 action |
| --- | --- | --- | --- | --- |
| POST | `/api/channels/:id/agents/:aid/start` | Membership edge | Helper checks agent membership in conversation and `canPostToConversation`. | Keep. |
| POST | `/api/threads/:id/agents/:aid/start` | Membership edge | Helper checks agent membership in conversation and `canPostToConversation`. | Keep. |
| POST | `/api/channels/:id/agents/:aid/stop` | Membership edge | Helper checks `canPostToConversation`. It does not verify `:aid` is in the conversation before stopping. | Add membership check parity with start/clear-session. |
| POST | `/api/threads/:id/agents/:aid/stop` | Membership edge | Helper checks `canPostToConversation`. It does not verify `:aid` is in the conversation before stopping. | Add membership check parity with start/clear-session. |
| POST | `/api/channels/:id/agents/:aid/clear-session` | Membership edge | Helper checks agent existence, conversation membership, and `canPostToConversation`. | Keep. |
| POST | `/api/threads/:id/agents/:aid/clear-session` | Membership edge | Helper checks agent existence, conversation membership, and `canPostToConversation`. | Keep. |

## Agent Routes

| Method | Route | ACL class | Current gate | A.3 action |
| --- | --- | --- | --- | --- |
| GET | `/api/agents` | Direct owner | Currently returns all agents after viewer gate. | Filter by `agents.created_by_user_id`, or introduce explicit `canViewAgent`. |
| POST | `/api/agents` | Direct creator | Requires user principal; writes `created_by_user_id`. | Keep. |
| GET | `/api/agents/:id` | Direct owner | Currently only checks existence. | Add `canViewAgent`. |
| PATCH | `/api/agents/:id` | Direct owner | `canEditAgent`. | Keep. |
| POST | `/api/agents/:id/avatar` | Direct owner | `canEditAgent`. | Keep. |
| DELETE | `/api/agents/:id/avatar` | Direct owner | `canEditAgent`. | Keep. |
| GET | `/api/agents/:id/avatar` | Direct owner | Currently only checks existence/avatar. | Match `GET /api/agents/:id` with `canViewAgent`. |
| GET | `/api/agents/:id/workspace` | Direct owner | Currently only checks existence. | Add `canViewAgent`. |
| GET | `/api/agents/:id/runtime-state` | Direct owner | Currently only checks existence. | Add `canViewAgent`. |
| GET | `/api/agents/:id/schedules` | Direct owner | Currently only checks existence. | Add `canViewAgent`. |
| POST | `/api/agents/:id/schedules/:scheduleId/cancel` | Direct owner | Service checks schedule belongs to agent; route lacks agent viewer gate. | Add `canEditAgent` before cancel. |
| POST | `/api/agents/:id/stop` | Direct owner | Currently only checks existence. | Add `canEditAgent` or a separate control permission. |
| GET | `/api/agents/:id/delete-impact` | Direct owner | Currently only checks existence. | Add `canEditAgent`. |
| DELETE | `/api/agents/:id` | Direct owner | Currently idempotent delete without `canEditAgent`. | Add `canEditAgent`; preserve idempotent 204 for unknown id. |

## Settings/Profile/Notification Routes

| Method | Route | ACL class | Current gate | A.3 action |
| --- | --- | --- | --- | --- |
| GET | `/api/settings` | Direct owner / host singleton | Currently returns all settings, including legacy keys. | Hide `viewer_user_id` from output; keep other host settings. |
| PUT | `/api/settings` | Direct owner / host singleton | Currently allows every non-deprecated `SETTINGS_KEYS` value. | Reject writes to `viewer_user_id`; no live writer remains after C.5. |
| GET | `/api/me` | Direct owner | Whitelisted pre-register; returns setup shape without principal, user DTO with principal. | Keep bootstrap shape; post-session missing/invalid viewer is 401 at middleware. |
| POST | `/api/register` | Removed public bootstrap | Removed in C.5. Public user creation is `/auth/signup`; embedded bootstrap may create the profile-only local user before issuing a session. | Do not reintroduce. |
| PATCH | `/api/me` | Direct owner | `requireViewerUserId`. | Keep after fallback removal. |
| POST | `/api/me/avatar` | Direct owner | `requireViewerUserId`. | Keep after fallback removal. |
| DELETE | `/api/me/avatar` | Direct owner | `requireViewerUserId`. | Keep after fallback removal. |
| GET | `/api/users/:id/avatar` | Public profile visibility | Currently any logged-in viewer can fetch any user avatar. | Keep logged-in public avatar read for V1; V2 can tighten to same-workspace if needed. |
| GET | `/api/notifications` | Direct owner, legacy bridge | Currently reads global `user_id IS NULL` notifications. | Keep legacy NULL bridge in a named deprecated helper. |
| GET | `/api/notifications/unread` | Direct owner, legacy bridge | Currently counts global NULL notifications. | Keep legacy NULL bridge in a named deprecated helper. |
| POST | `/api/notifications/read` | Direct owner, legacy bridge | Currently marks global rows, then publishes to current viewer scope. | Keep legacy NULL bridge in a named deprecated helper. |

## Task Routes

| Method | Route | ACL class | Current gate | A.3 action |
| --- | --- | --- | --- | --- |
| GET | `/api/tasks` | Inherited via parent | Calls `TaskService.list` with user principal and optional filters. | Verify service enforces visible workspace/conversation bottom guard for unfiltered list. |
| POST | `/api/tasks/:messageId/claim` | Inherited via parent | Calls service with user principal and message id. | Verify service gates by source message conversation visibility. |
| POST | `/api/tasks/:messageId/unclaim` | Inherited via parent | Calls service with user principal and message id. | Verify service gates by source message conversation visibility. |
| POST | `/api/tasks/:messageId/status` | Inherited via parent | Calls service with user principal and message id. | Verify service gates by source message conversation visibility. |
| POST | `/api/tasks/:messageId/archive` | Inherited via parent | Calls service with user principal and message id. Archive is visibility-only, not a status transition. | Verify service gates by source message conversation visibility. |

## Internal Agent Routes

All internal routes first pass the internal bearer token check, then
`installInternalPrincipalMiddleware`, which verifies the `(cid, aid)` pair maps
to an existing conversation, agent, and `conversation_agents` membership.

| Method | Route | ACL class | Current gate | A.3 action |
| --- | --- | --- | --- | --- |
| POST | `/internal/conversations/:cid/agents/:aid/cli-trace` | Agent principal | Token + agent membership; observability only. | Keep. |
| POST | `/internal/conversations/:cid/agents/:aid/send-message` | Agent principal + membership edge | Source conversation `canPostToConversation`; service validates target. | Keep. |
| POST | `/internal/conversations/:cid/agents/:aid/create-thread` | Agent principal + inherited via parent | Source conversation `canPostToConversation`; service creates child thread. | Keep. |
| POST | `/internal/conversations/:cid/agents/:aid/create-channel` | Agent principal + membership edge | Source conversation `canPostToConversation`; channel service uses source workspace and current members. | Keep. |
| POST | `/internal/conversations/:cid/agents/:aid/close-thread` | Agent principal + membership edge | Source conversation `canPostToConversation`; thread service owns thread validity. | Keep. |
| POST | `/internal/conversations/:cid/agents/:aid/read-history` | Agent principal + membership edge | Source `canViewConversation`; target resolver requires target conversation membership. | Keep. |
| GET | `/internal/conversations/:cid/agents/:aid/list-workspaces` | Agent principal + membership edge | Source `canViewConversation`; result from `WorkspaceRepo.listForAgent`. | Keep. |
| GET | `/internal/conversations/:cid/agents/:aid/list-channels` | Agent principal + membership edge | Source `canViewConversation`; cross-workspace uses `canAgentAccessWorkspace`; rows joined to `conversation_agents`. | Keep. |
| POST | `/internal/conversations/:cid/agents/:aid/search-messages` | Agent principal + inherited via parent | Source `canViewConversation`; cross-workspace uses `canAgentAccessWorkspace`; SQL joins `conversation_agents`. | Keep. |
| GET | `/internal/conversations/:cid/agents/:aid/tasks` | Agent principal + inherited via parent | Source `canViewConversation`; route validates cross-workspace membership before service list. | Keep; verify service bottom guard. |
| POST | `/internal/conversations/:cid/agents/:aid/tasks/create` | Agent principal + inherited via parent | Source `canPostToConversation`; service creates tasks in source conversation. | Keep. |
| POST | `/internal/conversations/:cid/agents/:aid/tasks/claim` | Agent principal + inherited via parent | Source `canPostToConversation`; service handles workspace selector. | Keep; verify service target task visibility. |
| POST | `/internal/conversations/:cid/agents/:aid/tasks/unclaim` | Agent principal + inherited via parent | Source `canPostToConversation`; service handles workspace selector. | Keep; verify service target task visibility. |
| POST | `/internal/conversations/:cid/agents/:aid/tasks/update-status` | Agent principal + inherited via parent | Source `canPostToConversation`; service handles workspace selector. | Keep; verify service target task visibility. |
| POST | `/internal/conversations/:cid/agents/:aid/attachments` | Agent principal + inherited via parent | Source conversation and agent membership; `canPostToConversation`; upload binds to source conversation. | Keep. |
| GET | `/internal/conversations/:cid/agents/:aid/attachments/:attachmentId/locate` | Agent principal + inherited via parent | Source conversation and agent membership; `canViewConversation`; locate is same-channel only. | Keep. |
| POST | `/internal/conversations/:cid/agents/:aid/avatar` | Agent principal + direct owner | `canEditAgent` self branch. | Keep. |
| DELETE | `/internal/conversations/:cid/agents/:aid/avatar` | Agent principal + direct owner | `canEditAgent` self branch. | Keep. |
| POST | `/internal/conversations/:cid/agents/:aid/schedules` | Agent principal + direct owner | Token pins agent id; service creates schedule for principal agent. | Keep; target conversation override remains service-gated. |
| POST | `/internal/conversations/:cid/agents/:aid/schedules/list` | Agent principal + direct owner | Token pins agent id; service lists for principal agent. | Keep. |
| POST | `/internal/conversations/:cid/agents/:aid/schedules/cancel` | Agent principal + direct owner | Token pins agent id; service cancels only schedules for principal agent. | Keep. |

## Non-route Viewer Fallback Call Sites

These are not Hono route rows, but they still matter for the A.3 invariant that
`app_settings.viewer_user_id` is no longer a principal source.

| File | Current use | A.3 action |
| --- | --- | --- |
| `packages/backend/src/auth/principal.ts` | `resolvePublicUserPrincipal` resolves only session/explicit legacy principal headers; no settings fallback. | Done. |
| `packages/backend/src/ws/ws-connection.ts` | C.4: WebSocket auth resolves `viewer:<id>` from the session cookie validated during upgrade, not from settings. | Done. |
| `packages/backend/src/repos/settings-repo.ts` | C.5: `getViewerUserId()` removed. The `VIEWER_USER_ID` constant remains only so settings routes can hide/reject the deprecated key until D-stage schema cleanup. | Done. |
| `packages/backend/src/services/conversation-message-service.ts` | C.5: unread invalidation and self-mention notification scope derive from `conversation_users`, not settings. | Done. |
| `packages/backend/src/services/schedule-service.ts` | C.5: schedule-fire unread invalidation derives from target conversation membership, not settings. | Done. |
| `packages/backend/src/runtime/daemon-agent-runtime-host.ts` | C.5: legacy null-user sender fallback uses the conversation's sole human member; ambiguous/no-human cases fall back to generic `user`. | Done. |
| `packages/backend/src/mention-cc.ts` | C.5: null-author fallback uses source conversation membership; 0/multiple humans log+skip instead of guessing a global viewer. | Done. |

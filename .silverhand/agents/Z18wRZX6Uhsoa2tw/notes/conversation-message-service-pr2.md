# PR-2 ConversationMessageService — interface, contract, test matrix

Owner: @Alice draft → @Cindy review → @Cindy implements.
Replaces: routes.ts:805-819 (channel/thread `POST messages` thin
delegators), 1121-1234 (`postUserMessage`), 1803-1931
(`agentSendConversationMessage`). Also absorbs the inline
`distributeConversationMessage` per-message fan-out for these routes
(the helper stays in routes.ts for now because thread/channel create
still uses it; PR-3 ThreadService will collapse those).

## File layout
- New: `packages/backend/src/services/conversation-message-service.ts`
- Wired in `BackendContext` AFTER `ctx.conversationManager` is assigned
  (same order constraint as ChannelService). `buildTestApp` must
  construct it in the same order.
- Constructor opts: `db: Db`, `conversations: ConversationRepo`,
  `messages: MessageRepo`, `agents: AgentRepo`, `notifications:
  NotificationRepo`, `workspaces: WorkspaceRepo`,
  `attachmentService: AttachmentService`,
  `conversationManager: ConversationManager`, `events: ScopeEventBus`,
  `logger: BackendLogger`. (No `mention-cc` import; service calls
  `ccMentionsFromUserMessage` directly with its own dep bundle so we
  don't have to reshape mention-cc in PR-2.)

## Public surface
```ts
export type SendMessageActor =
  | { kind: 'user'; userId: string | null }
  | { kind: 'agent'; agentId: string };

export type SendMessageTarget =
  | 'self'
  | 'parent'
  | { thread_id: string };

export interface SendMessageInput {
  conversationId: string;     // route-resolved current conversation
  actor: SendMessageActor;
  content: string;
  attachmentIds?: string[];
  /** Only honored when actor.kind === 'agent'. User callers MUST omit
   *  it; passing a non-self target as user throws PolicyError. The route
   *  for human send-message has no `target` in its HTTP schema, so this
   *  only fires if a future caller wires it wrong. */
  target?: SendMessageTarget;
}

export interface SendMessageResult {
  message: MessageDto;
  /** Effective conversation the row landed in. Differs from
   *  conversationId when target='parent' or {thread_id}. */
  targetConversationId: string;
}

export class ConversationMessageService {
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
}
```

The route layer collapses to ~10 lines per endpoint: auth → schema parse
→ build `actor` → call service → map errors to HTTP.

## Policy table (the single source of "what differs by origin")
Locked inside the service file as `const POLICIES`. Routes do NOT pass
booleans; the service derives behaviour from `actor.kind`.

| Behaviour | user | agent | Rationale |
|---|---|---|---|
| `requireSenderMembership` | false | true | Agents must be members of their source conversation (defense-in-depth on internal token); v1 user is implicitly everywhere. |
| `allowTarget` | false | true | Only agents can fan to parent or sibling thread. |
| `distributeExcludeSender` | false | true | Don't echo to the sender agent. User is not an agent, so nobody to exclude. |
| `autoStartIdleRecipients` | true | false | A human is waiting; spawn idle agents so they actually pick up the message. Agent→agent goes to inbox without auto-spawn (preserves the existing intentional asymmetry — flag for @Cindy to confirm). |
| `ccMentions` | true | false | `ccMentionsFromUserMessage` already restricted to user origin per its docstring. |
| `resolveRun` | false | true | Agent finished its turn; close the run state for `replied`. |

Add a new origin (webhook, scheduled task, …) by adding a row, not by
sprinkling `if (actor.kind === 'foo')` through the body.

## Invariant contract (top-of-file doc block)
The service is the **single owner** of the following side-effects for
send-message. Routes MUST NOT replicate any of these.

Inside ONE `db.transaction(() => { ... })` (defines the atomic
"validate → determine seq → write" segment; `MessageRepo.insertForConversation`
is multi-statement — MAX(seq)+1 then INSERT — and we want the
attachment snapshot validation in the same window so a row can never
land with a seq that races a concurrent attachment-mutating txn):
1. Validate attachments via `attachmentService.resolveSnapshotsForChannel`
   (after computing `ownerChannelId` from the **target** conversation).
   This is an intentional convergence: today agent route resolves the
   owner channel from `source` (the agent's current conversation), while
   user route resolves from `target` (which equals source for user since
   user has no target). Under current parent/thread constraints these
   are usually equivalent, but pinning to *target* matches the
   destination-invariant rule used elsewhere (attachments belong to the
   channel they will appear in).
2. `messages.insertForConversation({...})` for the target conversation.

After the transaction commits, in this exact order (per @Cindy review —
publish FIRST so a slow/throwing best-effort step cannot hold up the
201, and ordering matches PR-1):
3. `events.publish(targetId, { kind: 'message', payload: { message } })`.
4. `events.publishToScope('viewer:local', 'unread_updated', ...)` via
   the existing `publishUnreadUpdated` logic, lifted into the service
   as a private. mark-read keeps its own 4-line copy in routes.ts; we
   only consolidate further when a notification/read service exists.
5. If the target conversation has a `parent_conversation_id`:
   `events.publish(parent_id, { kind: 'thread_updated', payload: { ... }})`.
6. If `policy.resolveRun`: `conversationManager.resolveRun(sourceCid,
   actor.agentId, 'replied')`. **sourceCid, not targetId** — the run
   belongs to the spawning conversation.
7. Best-effort, all fire-and-forget (try/catch + warn, never block 201):
   - Per recipient in `conversations.listAgents(targetId)`, optionally
     excluding the sender (per `distributeExcludeSender`):
     `conversationManager.deliverMessage(targetId, agentId, msg.id)`.
   - If `policy.ccMentions`: `ccMentionsFromUserMessage(...)`.
   - If `policy.autoStartIdleRecipients`: Promise.all over recipients
     with `status !== 'active' && status !== 'starting'` calling
     `conversationManager.start(targetId, agentId)`.

Service ALWAYS returns `{message, targetConversationId}` once the txn
commits and `publish('message')` succeeds. Best-effort steps cannot
produce 5xx.

## Pre-conditions (validated inside service)
- M1 `conversations.get(conversationId)` exists, else
  `ConversationError('conversation_not_found')`. Source conversation
  must NOT be closed (`closed_at === null`), else
  `ConversationError('conversation_closed')`. (User and agent both;
  matches today.)
- M2 `actor.kind === 'agent'`:
  - `agents.get(actor.agentId)` exists, else
    `ActorError('agent_not_found')`.
  - `conversations.getAgent(conversationId, actor.agentId)` exists,
    else `ActorError('agent_not_member_of_conversation')` — this is
    the defense-in-depth check that's currently inline at routes.ts:1841.
- M3 Resolve `target` (order matters; user policy gate runs FIRST so
  the service never becomes a thread-existence oracle for a misrouted
  caller):
  - **Gate first**: if `actor.kind === 'user'` and target is anything
    other than undefined/'self', throw
    `PolicyError('target_not_allowed_for_user')` — no resolution
    attempted.
  - `target === undefined || 'self'` → targetConv = source.
  - `target === 'parent'`:
    - source.parent_conversation_id required, else
      `TargetError('no_parent')`.
    - parent must exist + not be closed.
  - `target === { thread_id }`:
    - thread exists, else `TargetError('thread_not_found')`.
    - thread.parent_conversation_id === source.id, else
      `TargetError('thread_not_child')`.
  - target conversation NOT closed, else `TargetError('target_closed')`.
- M4 If `attachmentIds.length > 0`:
  - Resolve `ownerChannelId` from the **target** conversation via
    `resolveOwnerChannelId` (channel/dm_channel = self; thread =
    parent). Null → `AttachmentError('attachment_owner_unresolved')`.
  - `attachmentService.resolveSnapshotsForChannel(ids, ownerChannelId)`
    — non-ok → `AttachmentError('attachment_outside_channel',
    attachmentId)`.

## Error taxonomy → HTTP mapping
| Error | Code | Status |
|---|---|---|
| ConversationError | conversation_not_found | 404 |
| ConversationError | conversation_closed | 409 |
| ActorError | agent_not_found | 404 |
| ActorError | agent_not_member_of_conversation | 403 |
| TargetError | no_parent | 400 |
| TargetError | thread_not_found | 404 |
| TargetError | thread_not_child | 400 |
| TargetError | target_closed | 409 |
| PolicyError | target_not_allowed_for_user | 400 |
| AttachmentError | attachment_owner_unresolved | 400 |
| AttachmentError | attachment_outside_channel | 400 |

Same `instanceof` switch helper pattern as `channelServiceErrorResponse`
in PR-1; lift both into a shared `services/error-mapping.ts` if a third
service needs it.

## Test matrix (services/conversation-message-service.test.ts)

| # | Scenario | Expected |
|---|---|---|
| 1 | user, valid channel, no attachments | message inserted, all members get `deliverMessage`, `message`+`unread_updated` fire, no parent event |
| 2 | user, valid thread, no attachments | message inserted into thread, parent gets `thread_updated` |
| 3 | user, source closed | throws ConversationError('conversation_closed') |
| 4 | user, attachments belonging to channel | snapshots attached, valid send |
| 5 | user, attachments outside channel | throws AttachmentError('attachment_outside_channel') with offending id |
| 6 | user, target='parent' | throws PolicyError('target_not_allowed_for_user') |
| 7 | user, mention to non-member | ccMentions fired (verify mock invoked); `auto-start` triggered for any idle agent in conversation |
| 8 | user, all recipients active | no `start()` calls; deliveries still fan out |
| 9 | agent, target='self', valid | message in source; sender excluded from distribute; `resolveRun` called for source cid |
| 10 | agent, target='parent', valid | message in parent; parent's parent (if any) gets `thread_updated`; `resolveRun(sourceCid, ...)` not parent |
| 11 | agent, target={thread_id} for direct child | message in thread; sender excluded from distribute |
| 12 | agent, target={thread_id} where thread is a sibling (different parent) | throws TargetError('thread_not_child') |
| 13 | agent, target={thread_id} not found | throws TargetError('thread_not_found') |
| 14 | agent, target='parent' on top-level channel | throws TargetError('no_parent') |
| 15 | agent, target conversation closed | throws TargetError('target_closed') |
| 16 | agent, sender not member of source | throws ActorError('agent_not_member_of_conversation') |
| 17 | agent, missing agent_id | throws ActorError('agent_not_found') |
| 18 | agent, attachments outside channel | throws AttachmentError, no insert |
| 19 | agent, deliver throws (or hangs) after commit | service swallows + warns, still returns `{message}`, **`message` publish fired before deliver was called so it landed regardless** |
| 20 | agent, ccMentions NOT called for agent origin | mention-cc spy not invoked |
| 21 | user, no auto-start when policy disabled (sanity for future flag) | `start()` count predictable |
| 22 | user, target='parent' (PolicyError gate) | throws `PolicyError('target_not_allowed_for_user')` BEFORE any `conversations.get(parent)` call — verify by spying that the parent fetch never runs |

Plus route-level integration in
`packages/backend/tests/routes/messages.test.ts` (new file):
- Human POST channel + thread both reach the same code path; both fire
  `message` + `unread_updated`.
- Agent POST send-message with `target='parent'` lands in parent.
- Agent POST send-message into closed target returns 409.

## Migration ordering inside PR-2
1. Add `conversation-message-service.ts` + tests (green in isolation).
2. Wire into `BackendContext` and `buildTestApp`.
3. Replace the bodies of `app.post(channelMessages)` and
   `app.post(threadMessages)` (805-819). The route wrappers MUST keep
   their `getChannelLike` / `getThread` kind guards so
   `/api/channels/:id/messages` rejects thread ids and vice versa —
   that's a transport-level routing concern, not a service contract.
   Inside each, build `actor` from `resolveViewerUserId` and call
   `ctx.conversationMessageService.sendMessage(...)`.
4. Delete `postUserMessage` helper from routes.ts.
5. Replace `agentSendConversationMessage` route body (1803-1931) with
   the ~15-line delegating version. Keep its `attachment_ids` handling
   inside the service.
6. Move `publishUnreadUpdated` into the service as a private; mark-read
   keeps its own 4-line copy. Remove the routes.ts top-level helper if
   no other caller remains; otherwise leave it.
7. `distributeConversationMessage` stays in routes.ts (still used by
   create-thread / close-thread). PR-3 ThreadService absorbs it.
8. No `docs/mcp-system.md` change needed (`AgentSendMessageInputSchema`
   shape unchanged).

## Open questions for @Cindy — RESOLVED in PR-2 review
1. Auto-start asymmetry — confirmed user yes / agent no, locked into
   policy table.
2. PolicyError vs silent coerce — throw, don't coerce.
3. `publishUnreadUpdated` — service private; mark-read keeps own copy.
4. `db.transaction` — yes, wrap. The atomic segment is "validate
   attachments + determine seq + insert message"; not a perf concern,
   it's about defining the service's atomic boundary.

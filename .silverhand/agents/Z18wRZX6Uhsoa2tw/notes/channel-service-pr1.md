# PR-1 ChannelService — interface, contract, test matrix

Owner: @Alice draft → @Cindy review → @Cindy or @Alice implements.
Replaces: routes.ts:497-526 (human createChannel),
2023-2075 (agentCreateChannel), 748-772 (pin/unpin), 2324-2333
(publishWorkspaceChannelsChanged helper). Locks the #109 publish drift.

## File layout
- New: `packages/backend/src/services/channel-service.ts`
- Wired in `BackendContext` AFTER `ctx.conversationManager` is assigned
  (ChannelService takes `conversationManager` in its options). Whatever
  builds the context — `index.ts`, `dev:headless` entry, and the
  `buildTestApp` helper used by route tests — must construct
  ChannelService in that order. Tests that previously stubbed
  `conversationManager` need to pass the stub through to ChannelService.
- Repo deps via constructor options: `conversations: ConversationRepo`,
  `workspaces: WorkspaceRepo`, `agents: AgentRepo`, `messages: MessageRepo`,
  `events: ScopeEventBus`, `conversationManager: ConversationManager`,
  `db: Db` (for `db.transaction`), `logger: Logger`.

## Public surface
```ts
type Actor =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; agentId: string; conversationId: string };

interface CreateChannelInput {
  workspaceId: string;
  title: string;
  memberAgentIds: string[]; // route is responsible for assembling this
                            // (human picker uses request body; agent route
                            // helper calls listAgents(actor.conversationId)
                            // — see C3 for the locked semantics)
  actor: Actor;
  /** Optional seed bundle. Present iff caller wants a system context message
   *  + agent-authored initial prompt + auto-start. Agents always pass it;
   *  human picker creates a "blank" channel and omits seed. */
  seed?: {
    systemMessageBody: string;     // becomes a fromKind:'system' message
    initialPrompt: string;         // fromKind:'agent', fromAgentId=actor.agentId
    autoStartMembers: 'all' | 'none';
  };
}

interface CreateChannelResult {
  channel: ChannelConversationDto;
}

interface SetPinnedInput {
  channelId: string;
  pinned: boolean;
}

class ChannelService {
  createChannel(input: CreateChannelInput): Promise<CreateChannelResult>;
  setPinned(input: SetPinnedInput): Promise<{ channel: ChannelConversationDto | DmChannelDto }>;
}
```

The route layer — both human (`/api/workspaces/:id/channels`) and
internal (`/internal/.../agentCreateChannel`) — collapses to ~10 lines:
auth → schema parse → call `channelService.createChannel(...)` → map
errors to HTTP. Same for pin/unpin.

## Invariant contract (lives at top of channel-service.ts as a doc block)
The service is the **single owner** of the following side-effects for
channel create / pin / unpin. Routes MUST NOT replicate any of these:

1. `conversations.insertChannel(...)` — exactly one row.
2. `conversations.addAgent(channelId, agentId)` — for each requested
   member, deduplicated.
3. **If `seed` present**:
   - `messages.insertForConversation(...)` for the system context msg.
   - `messages.insertForConversation(...)` for the agent prompt.
   - `conversationManager.deliverMessage(channelId, actor.agentId, contextMsgId)`.
   - `distributeConversationMessage(...)` for the prompt (excludes
     actor.agentId so the spawning agent doesn't echo to itself).
   - `startConversationAgents(...)` when `autoStartMembers === 'all'`.
4. `events.publishToScope('workspace:'+workspaceId, 'workspace_channels_changed', ...)`
   on every successful create AND every pin/unpin.
5. Logging: a single `info` with `{conversationId, workspaceId, actorKind,
   actorId, memberCount, seeded}` per create.

If a future caller needs additional behaviour (CC, notifications,
search indexing), the side-effect lives **inside** the service and the
caller does not get to opt in/out via boolean flags. Add new actor
shapes or a new method instead.

## Pre-conditions (validated inside service; route does no pre-checks)
For `createChannel`:
- C1 `workspaces.get(workspaceId)` exists AND `workspace_kind === 'regular'`.
  → `WorkspaceUnsuitableError({code: 'workspace_not_found' | 'workspace_not_regular'})`.
- C2 Every `memberAgentIds[i]`:
  - `agents.get(id)` exists → else `MemberError('agent_not_found', id)`.
  - `workspaces.isMember(workspaceId, id)` → else
    `MemberError('agent_not_workspace_member', id)`.
- C3 `actor.kind === 'agent'`:
  - `agents.get(actor.agentId)` exists.
  - `conversations.get(actor.conversationId)` exists, else
    `ActorError('source_conversation_not_found')`.
  - `conversations.getAgent(actor.conversationId, actor.agentId)` exists
    (caller is a member of its source conversation).
    → fixes the audit gap @Cindy flagged: agent path currently does not
    verify aid is a cid member.
  - `conversations.get(actor.conversationId).workspace_id === workspaceId`
    (agent can only spawn channels inside its own workspace; defends
    against forged cross-workspace cid).
  - **Member-source semantics, locked here**: agent route helper calls
    `conversations.listAgents(actor.conversationId)` and passes the
    result as `memberAgentIds`. Service does no fallback. Rationale: keeps
    the service signature symmetric across actors, makes "from a thread,
    members come from the thread" a route decision visible in route code,
    and forces a regression test (see test #17 below).
- C4 `seed` semantics:
  - If `seed` present, `actor.kind` MUST be `'agent'` (only agents seed
    channels). Human picker channel is always blank.
    → `SeedError('seed_requires_agent_actor')`.
  - If `seed.autoStartMembers === 'all'` and `memberAgentIds` is empty,
    that's not an error — start no-op.

For `setPinned`:
- P1 `conversations.get(channelId)` exists. Service translates the repo's
  null-on-missing into typed `RepoError('not_found', ...)` so route gets
  a uniform error shape.
- P2 conversation is `kind === 'channel' || 'dm_channel'` (threads can't
  be pinned). The repo throws `RepoError('thread', ...)` for the pin
  case; service rethrows as-is. For the unpin path the repo currently
  does NOT check kind, so service must add the check before calling
  `conversations.unpin`.
- P3 No other gating; pin/unpin is idempotent on the underlying repo.

## Error taxonomy
Service throws typed errors; routes map to HTTP:
- `WorkspaceUnsuitableError` → 404 (`workspace_not_found`) or
  400 (`workspace_not_regular`).
- `MemberError` → 400.
- `ActorError` (`agent_not_member_of_source_conv`,
  `agent_workspace_mismatch`, `source_conversation_not_found`) → 403
  for the first two, 404 for the last.
- `SeedError` → 400.
- `RepoError` (existing) → mapped via `repoErrorStatusMap`.

No silent fallthrough; the service never returns `null` to mean
"validation failed".

## Atomicity & post-commit ordering
SQLite + WAL, single-process. Inside ONE `db.transaction(() => { ... })`:
- `conversations.insertChannel(...)`
- `conversations.addAgent(...)` × N
- (if seed) `messages.insertForConversation(...)` × 2 (system context + agent prompt)

After the transaction commits, in this exact order:
1. `events.publishToScope('workspace:'+workspaceId, 'workspace_channels_changed', {...})`
   — must succeed; if the bus throws this is a system-level bug that
   should bubble up. **Publish fires before any best-effort delivery so
   that a transient deliver/distribute failure cannot silently hide a
   newly-created channel from the UI** and so that the route always
   returns 201, never 500. Otherwise the agent retries and creates a
   duplicate channel (per @Cindy's PR-1 review).
2. (if seed) `conversationManager.deliverMessage(channelId, actor.agentId, contextMsg.id)` — try/catch, log warn on failure, swallow.
3. (if seed) `distributeConversationMessage(...)` for the prompt (excludes actor.agentId) — try/catch, log warn on failure, swallow.
4. (if seed.autoStartMembers === 'all') `startConversationAgents(...)` — already swallows internally; we still wrap in try/catch for symmetry.

Service ALWAYS returns `{channel}` once the txn commits and publish
succeeds; deliver/distribute/start failures never produce 5xx. This is
a behaviour change vs the current code (which threads delivery awaits
into the response path) — call it out in the PR description.

## Test matrix
File: `packages/backend/src/services/channel-service.test.ts`.
Use the existing in-memory db fixture pattern from
`attachment-service.test.ts`.

Per-method × per-precondition × per-side-effect:

| # | Scenario | Expected |
|---|---|---|
| 1 | human actor, regular workspace, 0 members | channel inserted, no member rows, publish fired with `{workspace_id, channel_id}` |
| 2 | human actor, regular workspace, 2 valid members | 2 member rows, no seed msgs, publish fired |
| 3 | human actor, workspace not found | throws `WorkspaceUnsuitableError(workspace_not_found)`, no insert, no publish |
| 4 | human actor, workspace_kind='dm' | throws `WorkspaceUnsuitableError(workspace_not_regular)`, no publish |
| 5 | human actor, member is not workspace member | throws `MemberError(agent_not_workspace_member)`, no insert, no publish (txn rolls back) |
| 6 | human actor, member agent_id missing | throws `MemberError(agent_not_found)` |
| 7 | human actor with `seed` set | throws `SeedError(seed_requires_agent_actor)` |
| 8 | agent actor, valid cid+workspace match, seed present | channel + members + 2 messages inserted; deliverMessage called for context with actor.agentId; distribute called for prompt excluding actor.agentId; startAgents called when autoStart='all'; publish fired |
| 9 | agent actor, cid in different workspace | throws `ActorError(agent_workspace_mismatch)`, no insert |
| 10 | agent actor, agent not member of cid | throws `ActorError(agent_not_member_of_source_conv)` |
| 11 | agent actor, autoStart='none' | no startAgents call; deliver/distribute still happen |
| 12 | concurrent calls (same workspace) | both channels inserted, both publishes fired |
| 13 | setPinned channel→pinned then unpinned | each call publishes once; pinned_at toggles |
| 14 | setPinned on thread id | throws `RepoError('thread', ...)` mapped from existing pin() error |
| 15 | setPinned on missing channel | throws `RepoError('not_found', ...)` (or 404) |
| 16 | publish event payload shape | `{workspace_id, channel_id}` exactly, scope='workspace:<id>' |
| 17 | agent calls createChannel from a thread, members come from thread (not parent) | service receives `memberAgentIds` matching `listAgents(threadId)`, parent-channel members not auto-added — locks the route-side snapshot rule from C3 |
| 18 | seed delivery throws after commit | service swallows + logs warn, still returns 201 with `{channel}`; publish fired beforehand |
| 19 | publish throws (broken bus) | error propagates; channel row already committed, but route maps to 500 — accepted; this is a system bug, not transient |
| 20 | setPinned on missing channel | throws typed `RepoError('not_found',...)`, no publish |
| 21 | setPinned unpin on a thread id | throws `RepoError('thread',...)` from service-side check (repo `unpin` doesn't check) |

Plus one **integration** test at the route layer
(`packages/backend/tests/routes/channels.test.ts`) that asserts both
the human POST and the internal POST end up firing the same
`workspace_channels_changed` event — that's the explicit anti-#109
regression.

## Out of scope for PR-1
- DM channel creation (different code path; `provisionDmWorkspace`).
- Channel rename / archive / delete (not in #111 audit; future PR).
- ChannelService.deleteChannel — deleted in workspaceMember remove flow;
  the workspace removal path is the "全员状态变更" follow-up.

## Migration ordering inside PR-1
1. Add `channel-service.ts` + tests (green in isolation).
2. Wire into `BackendContext`.
3. Replace human route body (497-526) → ~10 lines.
4. Replace agent route body (2023-2075) → ~12 lines (route still owns
   member-snapshot from current conversation, then delegates).
5. Replace pin/unpin route bodies (748-772).
6. Delete `publishWorkspaceChannelsChanged` helper from routes.ts (now
   only ChannelService publishes).
7. Update `docs/mcp-system.md` if any agent-facing schema changes
   (none in PR-1; AgentCreateChannelInputSchema unchanged).

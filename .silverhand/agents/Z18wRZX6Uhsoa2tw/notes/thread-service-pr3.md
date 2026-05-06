# PR-3 ThreadService — interface, contract, test matrix

Owner: @Alice draft → @Cindy review → @Cindy implements.
Replaces: routes.ts:1036-1180 (`messageThread`, human message-anchored
thread create), 1816-1904 (`agentCreateThread`), 1945-2003
(`agentCloseThread`). Also absorbs the per-thread side-effect ownership
of `distributeConversationMessage` and `startConversationAgents` for
the create-thread paths; those helpers lose their last callers and can
be deleted from routes.ts at the end of PR-3.

## File layout
- New: `packages/backend/src/services/thread-service.ts`
- Wired in `BackendContext` AFTER `ctx.conversationManager` is assigned
  (same constraint as ChannelService / ConversationMessageService).
  `buildTestApp` mirrors the construction order.
- Constructor opts: `db: Db`, `conversations: ConversationRepo`,
  `messages: MessageRepo`, `agents: AgentRepo`, `workspaces: WorkspaceRepo`,
  `conversationManager: ConversationManager`, `events: ScopeEventBus`,
  `logger: BackendLogger`, `serverConfig: ServerConfig` (for
  `child_sessions` limits passed into `insertThread`),
  `lastSpawnAtByAgent: Map<string, number>` (per-process spawn cooldown
  state, currently a field on BackendContext).

## Public surface

```ts
export type ThreadActor =
  | { kind: 'user'; userId: string | null }
  | { kind: 'agent'; agentId: string };

/** Locked design: private `createThreadCore` + two public wrappers.
 *  Routes call wrappers, never core. Wrappers build seed messages,
 *  decide auto-start strategy, and own actor-specific framing. */
export class ThreadService {
  /** Human "thread from quoted message" — POST /api/messages/:id/thread.
   *  Idempotent: if an open thread already exists for this anchor
   *  message, returns it with `reused: true` and skips all side effects. */
  createThreadFromMessage(input: {
    messageId: string;
    viewer: { userId: string | null };
  }): Promise<{ thread: ThreadDto; reused: boolean }>;

  /** Agent-spawned thread — POST /internal/conversations/:cid/agents/:aid/create-thread.
   *  members defaults to "all parent members"; requested members must
   *  be a subset of parent members; caller (aid) is always added. */
  createThreadFromAgent(input: {
    parentConversationId: string;
    spawnerAgentId: string;
    title: string;
    contextSummary: string;
    initialPrompt: string;
    requestedMembers?: string[];
  }): Promise<{ thread: ThreadDto }>;

  /** Close a thread — POST /internal/conversations/:cid/agents/:aid/close-thread.
   *  Currently only agent callers exist (v1). Service accepts
   *  `actor.kind === 'user'` for forward-compat (used in summary
   *  formatting only); HTTP route stays agent-only. */
  closeThread(input: {
    threadId: string;
    actor: ThreadActor;
    summary: string;
    postedToParent: boolean;
  }): Promise<{ thread: ThreadDto }>;
}
```

The route layer collapses to ~12 lines per endpoint: auth → schema parse
→ build wrapper input → call → map errors to HTTP. Both wrappers and
closeThread funnel error mapping through the existing `instanceof`
helper pattern (or a new `services/error-mapping.ts` if we extract it
in PR-3 — see open question 4).

## Private core (lives in same file, not exported)

```ts
interface CreateThreadCoreInput {
  parentChannelId: string;
  title: string;
  spawnedByAgentId: string | null;
  memberAgentIds: string[];          // dedup + non-empty
  seedMessages: Array<{
    fromKind: 'system' | 'agent';
    fromAgentId?: string;            // required when fromKind='agent'
    content: string;
    metadata?: Record<string, unknown>;
    /** Per-seed delivery flags. Each seed entry decides explicitly
     *  what happens to it; core does NOT infer from order or
     *  position. Wrappers must set at most one of these per entry. */
    deliverTo?: string;              // single agent gets this via deliverMessage
    distributeToOthers?: { excludeAgentId?: string }; // fan-out to all
                                                       // thread members
                                                       // minus excluded
  }>;
  autoStart:
    | { mode: 'seedOnly'; agentId: string }
    | { mode: 'all'; excludeAgentId?: string };  // exclude is the agent
                                                  // already running (the
                                                  // spawner)
}

createThreadCore(input): Promise<ThreadDto>;
```

Per-seed delivery model (replaces the earlier "last non-anchor seed
gets distributed" rule, which was position-based and fragile per
@Cindy's review):
- `createThreadFromMessage` builds two seeds:
  - quote system: no flags (no delivery, no distribute — the agent
    reads it on join, no need for an extra deliverMessage push).
  - onboarding system: `deliverTo: seedAgentId`.
- `createThreadFromAgent` builds two seeds:
  - context system: `deliverTo: spawnerAgentId`.
  - prompt agent: `distributeToOthers: { excludeAgentId: spawnerAgentId }`.

Core is the single owner of:
1. `conversations.insertThread({ channelId, title, spawnedByAgentId,
   spawnCtx: { limits: serverConfig.child_sessions, lastSpawnAtByAgent }})`
   — RepoError surfaces (`parent_not_found`, `parent_closed`,
   `concurrent_limit`, `spawn_cooldown`, `max_depth_exceeded`).
2. `conversations.addAgent(threadId, agentId)` for each member, dedup'd.
3. `messages.insertForConversation(...)` for each seed message in order.
4. `events.publish(parentId, { kind: 'thread_updated', payload: {...} })`.
5. After publish, best-effort, per seed entry's flags:
   - `deliverTo` set → `conversationManager.deliverMessage(threadId,
     deliverTo, msgId)` — try/catch + warn.
   - `distributeToOthers` set → for each thread member !== excluded,
     `conversationManager.deliverMessage(threadId, agentId, msgId)` —
     try/catch + warn.
   - Then `conversationManager.start(threadId, agentId)` per
     `autoStart` policy (seedOnly: only seedAgentId; all: every member
     not equal to excludeAgentId, filtered to status !∈ {active,
     starting}).

Steps 1-3 wrap in a `db.transaction`. Steps 4-5 run after commit.
Publish fires before any best-effort delivery (PR-1 / PR-2 pattern;
ensures parent UI sees the new thread even if delivery hangs).

## Wrapper-specific behaviour

### `createThreadFromMessage` (human, anchored to a quoted message)

| Concern | Behaviour |
|---|---|
| Lookup | `messages.getById(messageId)` → original. `conversations.getChannelLike(original.conversation_id)` → parent. |
| Pre-conditions | Original exists; parent exists & not closed. |
| Reuse | `conversations.findOpenThreadChild(parent.id, original.id)` — if open thread exists, return `{ thread, reused: true }` and **skip all side effects**. This must run BEFORE entering the core (no insertThread call). |
| Member resolution | `parentAgents ∪ {original.from_agent_id if agent} ∪ workspace fallback when parent has no agents`. Reject with `MembershipError('no_members_to_thread')` when result is empty. |
| Seed agent | `original.from_agent_id` if message was agent-authored, else first member by index. Must exist; else `SeedAgentError('seed_agent_not_found')`. |
| Title | `'Thread: ' + first 50 chars of flattened original.content`. |
| Seed messages (built by wrapper) | Single `system` message with the rich quote text + thread_anchor metadata (quoted_message_id, quoted_conversation_id, quoted_content, quoted_from_*, quoted_agent_name, quoted_created_at) AND a single `system` onboarding message addressed to seed agent. The onboarding message is the `deliverTo` anchor. |
| autoStart | `{ mode: 'seedOnly', agentId: seedAgentId }`. |
| spawnedByAgentId | `null` (user-anchored). |
| Result | `{ thread, reused: false }` (201 maps in route). |

### `createThreadFromAgent` (agent spawning a child)

| Concern | Behaviour |
|---|---|
| Lookup | `conversations.getChannelLike(parentConversationId)` → parent. **`getChannelLike` returns ONLY channel/dm_channel** (verified in repo); threads cannot nest, per docs/mcp-system.md and the literal `max_depth: 1` in shared config. PR-3 preserves this rule; nested-thread support is a separate repo/schema/docs/prompt design and is explicitly out of PR-3 scope. |
| Pre-conditions | parent exists & kind ∈ {channel, dm_channel} (else `ParentError('parent_not_found')` — same shape as today, since `getChannelLike` returning null already covers a thread id); spawner agent exists; spawner is a member of parent. Else `MembershipError('agent_not_member_of_parent')`. |
| Member resolution | If `requestedMembers` provided & non-empty: each must be a parent member; else inherit ALL parent members. Always union spawner. |
| Seed messages | `system` "Inherited context from parent channel '<title>': <summary>" with metadata `{subtype:'child_context'}`, and `agent` initial_prompt authored by spawner. The CONTEXT message is the `deliverTo` anchor (matches today: spawner gets context delivered, then prompt distributes to others). |
| autoStart | `{ mode: 'all', excludeAgentId: spawnerId }` — spawner is already running (it's the caller). |
| spawnedByAgentId | spawner's agentId. |
| Result | `{ thread }` (200 in route, matching today's `{thread_id}` shape). |

### `closeThread` (currently agent-only)

```
1. conversations.getThread(threadId) — else ThreadError('thread_not_found').
2. thread.closed_at === null — else ThreadError('already_closed').
3. conversations.countActiveChildren(thread.id) === 0 — else
   ThreadError('has_active_children').
4. Actor validation (per @Cindy review — agent close is a high-impact
   mutation, must match the (cid, aid) forge defense from PR-1/PR-2):
   - if actor.kind === 'agent':
     - agents.get(actor.agentId) exists → else ActorError('agent_not_found').
     - conversations.getAgent(thread.id, actor.agentId) → else
       ActorError('agent_not_member_of_thread').
   - actor.kind === 'user': v1 has no HTTP route, but service accepts
     it for forward-compat; user-side auth happens at the route layer.
5. db.transaction:
   - conversations.close(thread.id, summary)
   - if !postedToParent && parent exists & not closed: insert summary
     message (system, subtype='thread_summary') into parent — capture
     the inserted MessageDto for post-commit publish.
6. After commit, in this order (publish-first, mirrors PR-1/PR-2):
   - if a parent summary was inserted: `events.publish(parent.id,
     { kind: 'message', payload: { message: summaryMsg } })`.
   - `events.publish(parent.id, { kind: 'thread_updated', payload })`
     when parent exists.
   - `conversationManager.resolveConversationRuns(thread.id,
     'conversation_closed')`.
   - Best-effort, fire-and-forget:
     - if summary was inserted: per parent recipient
       `deliverMessage(parent, agent, summaryId)` — try/catch + warn,
       no exclusion (system summary visible to all parent members
       including the closing agent if it's also a parent member —
       confirmed intentional in @Cindy review).
     - per thread member `conversationManager.stop(thread.id, agentId,
       'hard')` — try/catch + warn.
7. return { thread: closed }.
```

The `actor` only affects the summary's `@<name>` rendering. Today's
agent-only path uses `agents.get(aid)?.name`. For user actor we'd use
"@you" or the user label — we DON'T add this surface in PR-3 (no HTTP
route exists), but the service signature accepts it so PR-? can flip
the route on without re-shaping the service.

## Invariant contract (top-of-file doc block)
The service is the **single owner** of the following side-effects for
thread create / close:

Inside ONE `db.transaction(() => { ... })`:
- `insertThread` (with spawn limits — service passes
  `serverConfig.child_sessions` + `lastSpawnAtByAgent`).
- `addAgent` × N (dedup'd).
- `insertForConversation` for each seed message (create paths) OR
  `conversations.close` + optional summary insert (close path).

After the transaction commits, in this exact order (PR-1 / PR-2 pattern):
1. (close path with summary) `events.publish(parent, { kind: 'message',
   payload: { message: summaryMsg } })` — must succeed before any
   best-effort delivery is attempted.
2. `events.publish(parentId, { kind: 'thread_updated', payload })`.
3. (close path only) `conversationManager.resolveConversationRuns(...)`.
4. Best-effort, fire-and-forget:
   - (create paths) per seed entry's flags: `deliverMessage` for
     `deliverTo`, distribute for `distributeToOthers`.
   - (create paths) `conversationManager.start(thread, agent)` per
     `autoStart` policy.
   - (close path with summary) per parent recipient
     `deliverMessage(parent, agent, summaryId)` — no exclusion.
   - (close path) per thread member `conversationManager.stop(thread,
     agent, 'hard')`.

Service ALWAYS returns its result once the txn commits and the
required publish steps succeed. Best-effort steps cannot produce 5xx.

## Pre-conditions (validated inside service)
Per method, summarized — full code paths in the implementation file:

`createThreadFromMessage`:
- T1 message exists, else `MessageError('message_not_found')`.
- T2 parent (the message's conversation) exists & is channel-like, else
  `ParentError('parent_not_found')`. Parent not closed, else
  `ParentError('parent_closed')`.
- T3 If `findOpenThreadChild` returns a thread, return reuse path
  immediately. **No core call. No side-effect publish.**
- T4 Member resolution non-empty, else `MembershipError('no_members_to_thread')`.
- T5 Seed agent exists, else `SeedAgentError('seed_agent_not_found')`.

`createThreadFromAgent`:
- T1 parent exists & channel-like, else `ParentError('parent_not_found')`.
- T2 spawner agent exists, else `ActorError('agent_not_found')`.
- T3 spawner is parent member, else
  `MembershipError('agent_not_member_of_parent')`.
- T4 if requestedMembers given: each must be parent member, else
  `MembershipError('member_not_in_parent', memberId)`.

`closeThread`:
- T1 `getThread(threadId)` exists, else `ThreadError('thread_not_found')`.
- T2 thread not already closed, else `ThreadError('already_closed')`.
- T3 no active children, else `ThreadError('has_active_children')`.
- T4 `actor.kind === 'agent'`:
  - `agents.get(actor.agentId)` exists, else `ActorError('agent_not_found')`.
  - `conversations.getAgent(thread.id, actor.agentId)` exists, else
    `ActorError('agent_not_member_of_thread')`. Closes the (cid, aid)
    forge gap left in the current route.

RepoError from `insertThread` (parent_closed / concurrent_limit /
spawn_cooldown / max_depth_exceeded / parent_not_found) propagates as-is
and gets HTTP-mapped via the existing `repoErrorStatusMap`.

## Error taxonomy → HTTP mapping
| Error | Code | Status |
|---|---|---|
| MessageError | message_not_found | 404 |
| ParentError | parent_not_found | 404 |
| ParentError | parent_closed | 409 |
| MembershipError | no_members_to_thread | 400 |
| MembershipError | agent_not_member_of_parent | 400 |
| MembershipError | member_not_in_parent | 400 |
| ActorError | agent_not_found | 404 |
| SeedAgentError | seed_agent_not_found | 404 |
| ThreadError | thread_not_found | 404 |
| ThreadError | already_closed | 409 |
| ThreadError | has_active_children | 409 |
| ActorError (closeThread agent) | agent_not_found | 404 |
| ActorError (closeThread agent) | agent_not_member_of_thread | 403 |
| RepoError (insertThread) | parent_closed / concurrent_limit / etc. | mapped via existing table |

Same `instanceof` switch helper pattern as PR-1 / PR-2.

## Test matrix
File: `packages/backend/tests/services/thread-service.test.ts`.

### `createThreadFromMessage`
| # | Scenario | Expected |
|---|---|---|
| 1 | user message in channel with members → new thread | thread inserted; quote + onboarding system messages; only seed agent gets `deliverMessage` + `start`; `thread_updated` published on parent |
| 2 | agent-authored message → seed agent = original sender | seedAgentId === original.from_agent_id |
| 3 | second call for same anchor message returns reused thread | no new insert, no publish, no deliver |
| 4 | parent has 0 agents but workspace has members → uses workspace fallback | members include workspace agents |
| 5 | parent + workspace both empty → throws MembershipError | no insert |
| 6 | message not found | throws MessageError, no insert, no publish |
| 7 | parent closed | throws ParentError('parent_closed') |
| 8 | seed agent row missing in DB (corrupted) | throws SeedAgentError |
| 9 | publish fires before deliver/start | `order[0]==='publish'` |
| 10 | deliver throws after commit | service swallows + warns; thread still returned |

### `createThreadFromAgent`
| # | Scenario | Expected |
|---|---|---|
| 11 | spawner is parent member, no requestedMembers → all parent members + spawner, deduped | thread members = parent members; context delivered to spawner, prompt distributed to others; all auto-started except spawner |
| 12 | requestedMembers subset of parent | thread members = requestedMembers ∪ {spawner} |
| 13 | requestedMembers contains a non-parent agent | throws MembershipError('member_not_in_parent') |
| 14 | spawner not parent member | throws MembershipError('agent_not_member_of_parent') |
| 15 | spawner agent missing | throws ActorError('agent_not_found') |
| 16 | parent not found | throws ParentError |
| 17 | spawn cooldown active (RepoError) | propagates as RepoError('spawn_cooldown') → 429 |
| 18 | spawnedByAgentId on inserted thread | === spawnerId |

### `closeThread`
| # | Scenario | Expected |
|---|---|---|
| 19 | agent close, postedToParent=false, parent open | summary inserted in parent; **`message` event for summary publishes BEFORE deliverMessage to parent recipients fires**; thread_updated published; resolveConversationRuns called; all thread members get `stop` |
| 20 | agent close, postedToParent=true | NO summary insert in parent; thread_updated still published |
| 21 | agent close, parent closed | NO summary insert (skip); thread_updated still published; resolve+stop still happen |
| 22 | thread already closed | throws ThreadError('already_closed'); no DB change |
| 23 | thread has active children | throws ThreadError('has_active_children'); no DB change |
| 24 | thread not found | throws ThreadError('thread_not_found') |
| 25 | publish fires before stop | order assertion |
| 26 | agent close, aid is not a thread member | throws ActorError('agent_not_member_of_thread'); no DB change, no publish |
| 27 | agent close, aid agent missing | throws ActorError('agent_not_found'); no DB change |
| 28 | summary `message` publish ordered before deliver: hang deliver, assert publish already fired and request returned | order assertion via spies |

### Route-level integration (`tests/routes/threads.test.ts` — new)
- `POST /api/messages/:id/thread` returns 201 with `reused:false`,
  second call returns 200 with `reused:true`.
- `POST /internal/.../create-thread` snapshots correct members from
  parent and respects `members` override.
- `POST /internal/.../close-thread` posts summary to parent unless
  `posted_to_parent: true`.

## Migration ordering inside PR-3
1. Add `thread-service.ts` + tests (green in isolation).
2. Wire into `BackendContext` and `buildTestApp`.
3. Replace `app.post(apiPaths.messageThread)` body. Keep its return
   shape `{ thread_id, thread, reused }` exactly (renderer depends on
   it).
4. Replace `app.post(internalPaths.agentCreateThread)` body. Keep its
   return shape `{ thread_id }`.
5. Replace `app.post(internalPaths.agentCloseThread)` body. Keep its
   return shape `{ thread }`.
6. Delete `distributeConversationMessage` and `startConversationAgents`
   helpers from routes.ts (no callers remain).
7. No `docs/mcp-system.md` change (`AgentSpawnChildInputSchema`,
   `AgentCloseThreadInputSchema` shapes unchanged).

## Open questions for @Cindy — RESOLVED in PR-3 review
1. reuse-path skip publish — keep current behaviour (no new event).
2. close summary distribute does NOT exclude closing agent — keep
   current behaviour; system summary is for everyone in parent.
3. explicit `excludeAgentId: spawnerId` for agent create — adopted
   (clearer than relying on `status !∈ {active,starting}` filter).
4. `services/error-mapping.ts` extraction — defer; per-service
   helpers stay until duplication actually hurts.

Plus four review-blockers, all applied:
- Wrappers cannot claim thread→thread spawning. `getChannelLike`
  returns only channel/dm_channel; nesting is out of PR-3 scope.
- Core's seed delivery is per-entry explicit (`deliverTo` /
  `distributeToOthers`), not position-based.
- closeThread agent actor must validate
  `getAgent(thread.id, actor.agentId)`; new ActorError codes added.
- closeThread post-commit publishes `message` for summary BEFORE any
  deliverMessage (matches PR-1/PR-2 publish-first invariant).

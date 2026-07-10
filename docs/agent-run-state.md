# Agent Run State 与 Activity Strip 设计

> 配套文档：`core-design.md`（§3 进程编排）、`cli-system.md`。compaction 总论已并入本文（§ compaction-as-state）。
> 本文聚焦"agent 在某个 channel/thread 里正在做什么"这一**临时运行态**的端到端模型——driver 输出 → ConversationManager 聚合 → WS scope 分发 → 前端 cache → Activity Strip 渲染——以及 2026-05-08 task #159 / #169 的修复点。

> **2026-07-10 ownership update:** `AgentRunState` 的数据语义与 UI 行为仍是
> 本文主题，但下文把 backend `ConversationManager` 写成执行态 owner 的路径已经
> 过时。当前链路是 host `Supervisor` 聚合 per-handle run state → 发
> `runtime_state` → backend `OutboundRuntimeEventFanout` / projection cache →
> renderer event WebSocket → React Query cache → `ComposerActivityHeader`。
> 涉及 ownership、文件路径或测试落点时，以这条链和当前代码为准；下文的
> `ConversationManager` 图与迁移前文件名只作为历史行为说明，不能用于新增代码。

---

## 1. 设计目标

- **可见性**：用户随时能看到每个在跑的 agent 处于什么阶段（thinking / 工具运行 / 压缩 / idle）、当前在做什么（snippet 文本 / 工具计数）、跑了多久。
- **正确性**：Activity 必须随 agent 真实状态准确开/关；不串流、不漏清、不抖动，且不被消息滚动位置遮蔽。
- **多 agent / 多会话隔离**：同一 channel 多 agent、同一 agent 同时在 channel 与 thread 内跑、同一 workspace 跨 channel 不能互相影响。
- **成本可控**：snippet 流式更新不能产生 1-2 字符级闪烁；心跳广播不能放大噪声。

---

## 2. 端到端链路

```
┌──────────────┐    ParsedEvent     ┌──────────────────────┐    AgentRunState     ┌──────────────────┐    cache + UI    ┌──────────────────┐
│  Runtime CLI │ ─────────────────▶ │ ConversationManager  │ ───── WS scope ────▶ │  Renderer cache  │ ───────────────▶ │ AgentActivityStrip │
│  (claude/    │  thinking / text /  │  - run-state map     │  conversation:{id}   │  agentRunStatesKey │                  │  composer 上方 fixed │
│   codex/...) │  tool_call / etc.   │  - snippet buffer    │   payload =          │  per (conv, agent) │                  │  chip list + jump    │
└──────────────┘                     │  - boundary 调度     │   AgentRunState      │   tombstone TTL  │                  └──────────────────┘
                                     └──────────────────────┘                       └──────────────────┘
```

**层职责**：

| 层 | 文件 | 职责 |
|----|------|------|
| Driver | `packages/backend/src/drivers/{claude,codex,cursor}.ts` | 把 runtime stream 解析成统一的 `ParsedEvent`（kind: `thinking` / `text` / `tool_call` / `tool_output` / `compaction_started` / `compaction_finished` / `turn_end` / `error` / ...） |
| ConversationManager | `packages/backend/src/conversation-manager.ts` | 维护 per (conv, agent) 的 `AgentRunState`，聚合 thinking/text 片段为尾窗 `activitySnippet`，跟踪 compaction，处理 turn 边界 resolve，并在 raw `agent_event` fanout 前压缩大 `tool_call.input` |
| Bus | `packages/backend/src/ws/scope-event-bus.ts` | 把 `agent_activity` payload 路由到 `conversation:{conversationId}` scope，replay buffer 200 条 |
| WS Client | `apps/desktop/src/renderer/lib/ws-client.ts` | 单 socket 多 scope，断线 resume；scope 不匹配的 frame 不投递给该 hook |
| Cache | `apps/desktop/src/renderer/lib/agentRunStateCache.ts` | per-conversation TanStack Query cache，按 (agentId) 去重，终态 tombstone TTL 5 分钟防 stale snapshot 复活 |
| UI | `apps/desktop/src/renderer/components/chat/AgentActivityBubble.tsx` | 渲染 composer 上方的 activity strip；每个 in-flight agent 一个 chip，包含 phase snippet / compaction 状态 / elapsed / 工具总数，并可跳回最近 user message |

---

## 3. 数据模型：`AgentRunState`

`packages/shared/src/api/runtime.ts`：

```ts
AgentRunStatusSchema = z.enum(['starting', 'thinking', 'tool_running', 'idle', 'failed']);

AgentRunTerminalReasonSchema = z.enum([
  'replied', 'turn_ended', 'replaced',  // → status 'idle'
  'stopped', 'crashed', 'timeout', 'conversation_closed',  // → status 'failed'
]);

AgentRunStateSchema = z.object({
  runId: z.string(),
  agentId: z.string(),
  conversationId: z.string(),
  status: AgentRunStatusSchema,
  startedAt: z.number(),
  updatedAt: z.number(),
  lastActivityAt: z.number(),
  terminalReason: AgentRunTerminalReasonSchema.optional(),
  activitySnippet: z.string().optional(),          // 尾窗 200 字符
  toolCallCounts: z.record(z.string(), z.number()).optional(),
  compacting: z.boolean().optional(),              // ← 与 status 正交
  compactingSince: z.number().optional(),          // 独立 elapsed
  compactionStale: z.boolean().optional(),         // 5min watchdog
  detail: z.string().optional(),
});
```

**关键决策**：

- **`compacting` 不进 `AgentRunStatus` enum**——压缩与 thinking/tool_running 可同时为真，flag 化才能让 UI 同时渲染两条独立信息。
- **`replaced` 是终态而非中间态**——前端 tombstone 只看 `status === 'idle' | 'failed'`，所以 `replaced` 映射到 `idle`，前端无需感知新枚举。
- **`runId` 是单次 run 的标识**，不是 cliSessionId / threadId / pid。同一 (conv, agent) 在生命周期内会经历多个 runId（每次 idle → 新消息 → 新 run）。

---

## 4. ConversationManager：状态机

### 4.1 数据结构

```ts
// per (conversationId, agentId)
runStates: Map<key, AgentRunState>;
activitySnippetBuffers: Map<key, { runId, kind: 'thinking' | 'text', text: string }>;

// per AgentHandle
busy: { outstandingToolUses: number; compacting: boolean };
pendingTurnEnd: boolean;          // turn_end 到达但未到 safe boundary
pendingDeliveries: PendingDelivery[]; // 仅 gated 模式，当前进程的 formatted batch cache

// per (conversationId, agentId)
lifecycleQueue: Promise<void>;    // 串行化 start / stop / clearSession
```

`conversation_inboxes` 是 delivery queue 的 durable source of truth；
`pendingDeliveries` 只缓存当前进程已经 format 好、等待 safe boundary 合并写入的内容。
进程被 hard stop 时内存 cache 可以丢，pending DB row 会在下次 start 后重新 drain。

`start` / `stop` / `clearSession` 以及 init timeout retry、oneShot auto-start
共享同一个 per-(conversation, agent) lifecycle lock。公共方法只负责拿锁，
锁内实现用 `startUnlocked` / `stopUnlocked`，避免 `clearSession` 这类编排动作
在锁内再调用公共方法造成自排队。

**`isSafeBoundary(handle)` ≜ `outstandingToolUses === 0 && !compacting`**

### 4.2 状态转移

| 事件 | 处理 |
|------|------|
| `deliverMessage`（agent idle） | inbox enqueue 或 direct write → `startRun(handle, 'thinking')` 创建新 runId |
| `deliverMessage`（agent busy, direct mode = codex `turn/steer`） | write → `markRunThinking(handle)`：保留当前 runId，只切 status |
| `deliverMessage`（agent busy, gated mode = claude） | push 到 `pendingDeliveries`，等下个 safe boundary `flushPending` |
| `tool_call` | `outstandingToolUses += 1`；`recordToolCall` → status `tool_running`，`toolCallCounts[name] += 1` |
| `tool_output` | `outstandingToolUses -= 1`；若降到 0 则 `recordToolOutput` → status 切回 `thinking`，**调用 `tryResolveTurnEndAtBoundary`** |
| `thinking` / `text` | `recordActivitySnippet(handle, kind, text)` → 见 §5 |
| `compaction_started` | `busy.compacting = true`；`recordCompactionStarted` → `compacting=true, compactingSince=now`；启动 5min watchdog |
| `compaction_finished` | `busy.compacting = false`；`recordCompactionFinished` → 清 `compacting/compactingSince/compactionStale`；**调用 `tryResolveTurnEndAtBoundary`**；`flushPending` |
| compaction watchdog 超时 | 一次性 5min timer；`recordCompactionStale` → `compactionStale=true`，同时广播一次 `compaction_stale`；不靠 heartbeat 重复制造 stale 事件 |
| `turn_end` | `outstandingToolUses = 0`；`pendingTurnEnd = true`；`tryResolveTurnEndAtBoundary`；再 `flushPending` |
| 进程退出 | `resolveRunByKey(key, 'replied' / 'crashed' / 'stopped' / 'timeout')` |
| `stop()` | `resolveRunByKey(key, 'stopped')` |
| `clearSession()` | lifecycle lock 内 hard stop live process → `conversation_agents.cli_session_id = NULL` → publish `agent_status` → 写 `session_cleared` audit；不自动 restart，pending inbox row 保留 |

`clearSession()` 清的是 CLI resume handle，不清 MEMORY/notes、不删底层 CLI
jsonl、不清 `conversation_inboxes`。audit message 只在实际清理时写；它会广播给 UI
并投递给同 conversation 的其它 agent，但跳过被清 agent，避免 fresh session 把
"自己被清了"当成新用户意图处理。

### 4.3 `tryResolveTurnEndAtBoundary`（**根因 A 修复**）

```ts
private tryResolveTurnEndAtBoundary(handle: AgentHandle): boolean {
  if (!handle.pendingTurnEnd) return false;
  if (handle.pendingDeliveries.length > 0 || !isSafeBoundary(handle)) return false;
  handle.pendingTurnEnd = false;
  this.resolveRunByKey(handleKey(handle.conversationId, handle.agentId), 'turn_ended');
  return true;
}
```

**调用入口三处**：`turn_end` 事件、`recordToolOutput`（tool 用尽时）、`compaction_finished`。任一边界打开都会触发一次重试。

### 4.4 `startRun` 覆盖语义（**根因 C 修复**）

`startRun` 创建新 runId 之前会：

1. 把上一 runId 的 state 用 `replaced` 终态广播一遍（让前端 tombstone 闭环）。
2. 清掉对应 snippet buffer。
3. 复位 `pendingTurnEnd`。

### 4.5 `markRunThinking`（**根因 B 修复**）

direct-mode steer 不再走 `startRun`，改走 `markRunThinking`：

```ts
private markRunThinking(handle: AgentHandle): void {
  const current = this.runStates.get(key);
  if (current) {
    this.updateRun(handle, { status: 'thinking', detail: undefined, lastActivityAt: now });
    return;
  }
  this.startRun(handle, 'thinking');
}
```

效果：codex `turn/steer` 时 runId 不变，`toolCallCounts`、`startedAt`、UI bubble 挂载状态全部保留。

### 4.6 心跳

`AGENT_ACTIVITY_HEARTBEAT_MS = 2000`。每 2s 重 publish 当前 `runStates` 里所有 state（仅 `updatedAt` 推进），让前端 elapsed 平滑滚动。`runStates.size === 0` 时自动停。

---

## 5. Snippet 累积（**根因 D 修复**）

### 5.1 问题

Codex 通过 `item/reasoning/textDelta` / `item/reasoning/summaryTextDelta` 流式吐 reasoning，每个 delta 1-2 字符。早期实现 `recordActivitySnippet(text)` 直接 `slice(0, 200)` 后**整体覆盖** `activitySnippet`——UI 看到 1-2 字符快速闪过。

Claude 没事是因为 claude CLI 的 `assistant` 事件携带完整的 thinking block（一次性整段），而不是 delta。

### 5.2 解决

Per (key, runId, kind) snippet buffer：

```ts
ACTIVITY_SNIPPET_MAX_CHARS = 200;
ACTIVITY_SNIPPET_BUFFER_MAX_CHARS = ACTIVITY_SNIPPET_MAX_CHARS * 4;  // 防内存膨胀

appendActivitySnippetBuffer(key, runId, kind, text):
  current = buffers.get(key)
  if current.runId === runId && current.kind === kind:
    nextText = current.text + text       // 同 kind 累积
  else:
    nextText = text                       // 不同 runId 或不同 kind 重置
  bounded = nextText.slice(-ACTIVITY_SNIPPET_BUFFER_MAX_CHARS)
  buffers.set(key, { runId, kind, text: bounded })
  return trimActivitySnippet(bounded)    // 取尾窗 slice(-200)
```

### 5.3 关键决策

- **取尾窗（`slice(-200)`），不取首窗**：reasoning 流的"现场感"在最新 token，尾窗最符合直觉。
- **kind 切换重置**：`thinking → text` 或反之必须重置 buffer，不能跨 kind 拼接。
- **runId 切换重置**：通过 `clearActivitySnippetBuffer` 在 `startRun` / `resolveRunByKey` 时清理；同时 buffer 里的 `runId` 字段做二次校验，避免 stale buffer 拼到新 run。
- **空 snippet 不清旧文本**：空 `thinking` / `text` 事件只 materialize/标记 run 为 thinking；已有 `activitySnippet` 只在新 run、终态 resolve 或 kind/runId 切换时被替换。

---

## 6. WS 路由与多会话隔离

### 6.1 后端

`scope-event-bus.ts`：每个 `publish(conversationId, event)` 同时落到 `conversation:{conversationId}` WS scope，per-scope replay buffer 200 条，per-scope monotonic seq。

`agent_event` 是诊断用 raw event，不参与 Activity Bubble 聚合。发布前会 sanitize `tool_call.input`：长字符串截断到 500 字符，数组保留前 20 项，对象保留前 40 个 key，最大深度 4。这样 Write/Edit/fileChange 这类工具的完整 file content / old_string / new_string 不会长期留在 WS replay buffer 或 Events 窗口内存里；`ConversationManager` 内部处理仍使用原始 `ParsedEvent`。

### 6.2 前端

```
useConversationStream(conversationId, onEvent, scope)
  → subscribeWsScope('conversation:' + conversationId)
  → onWsFrame(frame): if frame.scope !== expectedScope return null  ← 严格过滤
```

`agentRunStateCache.applyAgentRunStateToCache`：再次校验 `state.conversationId === conversationId`，防御性双校验。

### 6.3 隔离矩阵

| 场景 | 是否隔离 | 机制 |
|------|----------|------|
| 同一 channel 多个 agent 同时跑 | ✅ | 后端 `runStates` map 按 `(conv, agentId)` 区分；前端 cache 按 `agentId` 去重，独立条目 |
| 同一 agent 同时在 channel + 该 channel 的 thread 里跑 | ✅ | thread 是独立 `conversationId`，独立 handle、独立 cache key |
| 同一 workspace 跨 channel | ✅ | 独立 conversationId / WS scope / cache key |
| 同 (conv, agent) 一次 turn 内 startRun 被换 | ✅ | 旧 run 走 `replaced` 终态广播，前端 tombstone 5min 防复活 |

### 6.4 Mount 与 reconnect race

潜在窗口：useQuery 拉 snapshot 与 WS subscribe 之间，若有终态事件落地，可能错过。修复：

- `useAgentRunStates` 加 `refetchOnMount: 'always'`，channel 切回时强制拉一次 snapshot。
- `reconcileAgentRunStateSnapshot(previous, snapshot, requestedAt)`：旧 cache 中 `updatedAt < requestedAt` 的状态丢弃，避免 stale 复活。
- `terminalRunUpdatedAtByKey` tombstone TTL 5min：snapshot 里有 stale running 状态时也能被前端拒绝。

---

## 7. UI：Composer 内置 Activity Header（方案 A）

`ComposerActivityHeader.tsx`（旧 `AgentActivityBubble.tsx` / `AgentActivityStrip` /
`AgentActivityDock` 已废弃删除）渲染为 **Composer 输入框 shell 盒子的第一个子元素**，
与 textarea 共用同一圈圆角边框（无浮层、无阴影、无缝隙）。读感是"输入区在忙"，不是
调试 HUD。

```
┌─────────────────────────────────────────────────────────┐   ← Composer shell（共享边框）
│ ⟳ @Alice  Bash ×2  正在思考下一步实现…       +1   45s  ⌄ │   ← 折叠：永远一行
├─────────────────────────────────────────────────────────┤
│ 输入消息…                                                 │   ← textarea
│                                            📎      Send   │
└─────────────────────────────────────────────────────────┘
```

- **位置**：并入 composer 自身 chrome（不是浮在上方的独立条）。`activeRunStates.length === 0`
  时组件 `return null`，输入框恢复原状，对 idle 态零影响。
- **折叠态永远一行**：固定槽位 `[图标] @agent [主状态 badge] [明细 snippet…] [+N] [elapsed] [⌄]`，
  其中只有明细 snippet 是弹性的（`flex-1 min-width:0 truncate`），其余全是 `shrink-0` 固定槽。
  阶段在 tool call / thinking / compacting / waiting 之间切换时只换文字、不增减元素、不换行、
  高度恒定。
- **主状态优先级**（`statusRank`）：`tool_running > compacting > thinking > starting > idle`。
  同时只显示一个主状态：正跑 tool 时 badge=工具名，否则才轮到 compacting/thinking。
- **tool badge**：多个 tool call 不堆叠，取 count 最高的工具名 + `×总数`（如 `Edit ×3`），
  完整逐项列表放展开区。
- **多 agent 折叠取谁**：按 `statusRank` 升序、同级按 `lastActivityAt` 新者优先取 top agent
  作为折叠行主体，末尾 `+N` 表示其余正在跑的 agent。
- **展开**：点折叠行就地向下展开（textarea 被推下，内容增长，不浮层、不盖历史消息），
  每个 in-flight agent 一行，按相同优先级排序；含 compaction 行（`Layers` / stale 时
  `AlertTriangle` + warning 配色）与逐项 tool badge。
- **主题适配**：全部用 token（`text-accent` / `text-text-secondary` / `border-border-subtle` /
  `bg-bg-hover` / `text-warning`），forza6 等主题的替换自动生效；带 `data-composer-activity`
  属性，便于后续主题做 poster 化定制。
- **取舍**：方案 A 去掉了旧 dock 的 click-to-jump（跳回触发 user message）。dock 浮在历史上方
  时该补偿有意义；A 常驻 composer 底部（永远在"现在"），点击改为就地展开/收起详情，跳转语义
  失去价值，故移除。


---

## 8. 已知边界 / 待跟进

1. ~~**codex `webSearch` / `fileChange` 缺 `tool_output`**~~ — 已修复(2026-05-08 follow-up)。driver 维护 `pendingFileChangeCounts: Map<itemId, number>` 和 `pendingWebSearchIds: Set<itemId>`,在 `item/started` 时记录,`item/completed` 时按记录数 emit 配对的 `tool_output`,`turn/completed` 时 clear 表。Late completed(配对早被 turn 端清掉)直接吞掉,避免在已 resolve 的 run 上诱发 phantom tool_output。
2. **`markRunThinking` 清 `detail`**:当前 UI 不消费 `detail`,但 DTO 语义上 steer 时丢了 `detail` 字段。未来若有 consumer 用 `detail` 需要回收。
3. **snippet 切口**:`slice(-200)` 不处理 UTF-16 surrogate / 半个英文单词的边界。CJK 无影响,英文偶尔切到半词。低优。
4. **mention-targeted dispatch 与 broadcast 默认**:已讨论但延后实现,见 §12。当前 user 消息按 conversation 全员广播,会导致"我 @Cindy 提问,正在干活的 Claude 也被打断重新 thinking"。延后理由:实现成本与回归面 vs 当下伤害不成比例,且对历史回放有二阶问题。触发条件与方案见 §12。

---

## 9. 测试覆盖

`packages/backend/tests/manager/lifecycle.test.ts`：

- `accumulates thinking/text deltas as a latest-window activitySnippet` — 验证 snippet 累积 + 尾窗 + kind 切换重置。
- `preserves the current direct-mode run when steering an active agent` — 验证 codex steer 不换 runId、保留 toolCallCounts。
- `defers turn_end cleanup until compaction reaches a safe boundary` — 验证 `pendingTurnEnd` + `compaction_finished` 触发的延迟 resolve。
- 旧 run `replaced` 终态广播 — 验证 startRun 覆盖时旧 runId 走终态。
- `sanitizes large tool_call inputs before raw agent_event broadcast` — 验证 raw `agent_event` 不持有大工具输入，同时不影响 tool counts。

`packages/backend/tests/drivers/codex.test.ts`：

- `pairs webSearch start with a tool_output on completion` — 验证 webSearch 配对。
- `emits one tool_output per fileChange entry on completion` — 验证 fileChange 按 `changes` 数等量配对。
- `clears pending tool counts on turn/completed to bound state across turns` — 验证 turn 边界清表、late completed 不复活。

`apps/desktop/src/renderer/lib/agentRunStateCache.test.ts`：

- `keeps per-conversation cache writes isolated` — 跨 conversation 不串。
- `does not let an older run replace a newer run for the same agent` — replace 顺序判定。
- `uses terminal tombstones to keep stale snapshots from reviving a run` — tombstone TTL。

---

## 10. 排查与验证入口

### 10.1 常见症状

| 症状 | 优先检查 |
|------|----------|
| thinking 只闪 1-2 个字符 | Codex driver 是否仍按 delta 发 `thinking`；`appendActivitySnippetBuffer` 是否按 `(key, runId, kind)` 累积；`activitySnippet` 是否为尾窗而不是单 delta |
| agent 已完成但 Activity Bubble 还在 | 后端是否发出 terminal `agent_activity`（`idle` / `failed`）；`turn_end` 是否落在 `compacting=true` 时且未经过 `compaction_finished` / `recordToolOutput` 重试；前端 snapshot 是否被 `refetchOnMount` reconcile |
| 怀疑跨 channel/thread 串流 | 对比 payload `conversationId`、WS frame `scope`、TanStack Query key `agentRunStatesKey(conversationId)`；thread 与父 channel 必须是不同 conversationId |
| 旧 runId 复活 | 查旧 run 是否先收到 `terminalReason: replaced`；前端 `terminalRunUpdatedAtByKey` tombstone 是否覆盖 snapshot 请求时间 |
| compaction 行长期 warning | 查是否收到 `compaction_finished`；watchdog 只提示不 kill runtime，必要时由用户显式 stop/restart |

### 10.2 日志

- 后端 activity JSONL：`<logDir>/agent-activity-*.log`，包含 `conversationId` / `agentId` / `runId` / `status` / `activitySnippet` / `compacting*` / `terminalReason`。
- backend 主日志：看 `agent: turn_end`、`agent: compaction_started`、`agent: compaction_finished`、`agent: tool_call`、`compaction has been running for 5min...`。
- CLI stderr/stdout 和 backend internal-route 日志：用于确认 agent 自己通过 `silverhand` 命令是否真正到达 backend；不要把 runtime 的 tool_use 意图误认为 Silverhand 已收到消息。

### 10.3 回归命令

```bash
pnpm --filter @silverhand/backend exec vitest run tests/manager/lifecycle.test.ts
pnpm --filter @silverhand/desktop exec vitest run src/renderer/lib/agentRunStateCache.test.ts
pnpm --filter @silverhand/backend typecheck
pnpm --filter @silverhand/desktop typecheck
```

并发跑这些命令时本机 IO/CPU 抢占可能让 lifecycle 里的 `waitForEvent` 超时；如果并发失败，先单独 rerun 失败项确认。

---

## 11. 修复时间线

- **2026-05-08 task #159**（@Cindy 实施，@Alice review）：
  - Snippet 闪烁（根因 D）→ accumulator buffer + 尾窗。
  - direct steer 换 runId（根因 B）→ `markRunThinking`。
  - 旧 run 无终态（根因 C）→ `replaced` enum + `publishTerminalRunState`。
  - turn_end 落在 compacting 中（根因 A）→ `pendingTurnEnd` + `tryResolveTurnEndAtBoundary` 三入口。
  - Compaction 提升为独立 run-state 字段并独立 UI 行。
  - Mount race → `refetchOnMount: 'always'`。
- **2026-05-08 follow-up**（@Alice 实施，@Cindy review）：
  - codex `webSearch` / `fileChange` 缺 `tool_output` → driver 加 per-itemId 计数 Map / Set，`item/completed` 时按记录配对 emit，`turn/completed` 时 clear 表，late completed 直接吞掉避免 phantom run。
- **2026-05-08 task #162**（@Cindy 实施）：
  - raw `agent_event` 大 payload 风险 → 在 fanout 前 sanitize `tool_call.input`，避免 Write/Edit/fileChange 大文本进入 WS replay buffer / Events 窗口；`agent_activity` 和 manager 内部状态机不受影响。

---

## 12. 延后决议：mention-targeted dispatch 与 broadcast 默认

> 状态：**讨论收敛 / 不实现**。本节记录已讨论的备选方案与延后理由,后续若决定推进,以本节为起点而不是从头讨论。

### 12.1 问题

用户在 channel 与 @A 来回聊了若干轮后,转头 `@B …`,会观察到正在干活的 A 的 activity bubble 被重置为"思考中" / runId 切换。原因：`ConversationMessageService.sendMessage` 给 user 消息选 recipients = `conversations.listAgents(targetConversationId)` 全员,逐个 `conversationManager.deliverMessage(...)`。在 ConversationManager 里:

- handle 不存在 → `inboxes.enqueue`,后续 `startIdleRecipientsBestEffort` 触发 spawn,spawn-time `drainInbox` 进入 `startRun`(新 runId)。
- direct-mode driver(codex)且 handle 已 busy → 直接写 stdin + `markRunThinking`(runId 不变,这是 §4.5 的修复)。
- gated driver(claude)且 handle 已 busy → push 到 `pendingDeliveries`,safe boundary 时 `flushPending` 写 stdin,再走 `startRun`(新 runId)。
- gated driver 且 handle idle → safe boundary 立刻 `startRun`(新 runId)。

加上 `startIdleRecipientsBestEffort` 一次性 auto-start 全部 idle 成员,语义上"群发"覆盖了"被点名"。Claude 这条路径只要落进 `startRun` 就会显式 publish 旧 run 的 `replaced` 终态再开新 run,UI 上就是 activity 重置。

### 12.2 备选方案：mention-targeted active deliver + broadcast catch-up

讨论中收敛的口径,**没有实现**：

1. **解析 `extractMentions(content)` ∩ conversation members → mention 集合**。
2. **active deliver**：mention 集合非空时只 `deliverMessage` 给集合内 agent 并 `auto-start` 集合内 idle 成员;集合为空时维持现广播(全员 active deliver + auto-start)。
3. **passive catch-up**：非 mention 集合内的成员**不写 stdin、不 `startRun`、不 auto-start**,但**仍要让 ta 能在以后看到这条历史**——通过新增 passive enqueue 路径,只 `inboxes.enqueue(conv, agent, messageId)`,不调 `deliverMessage` 的 active 部分。
4. **active-drain 钩子**：当后续一次 active deliver 真正落到一个 running 但有未 drain inbox 的 agent 上时,先 drain 旧 inbox 再 active write。这一条由 @Cindy 在讨论中补强:当前 `drainInbox` 只在 spawn / `session_init` 触发,running 中不会自动 drain,光靠 passive enqueue 不够。

### 12.2bis 其它考察过的改法

讨论早期还出现过两个备选,**都没采用**,记录在这里防止未来重新发明:

- **方案 A:claude/gated 也走 `markRunThinking`**(deliverMessage 在 gated safe boundary 写完 stdin 后不调 `startRun`,只切 status / 复位 lastActivityAt)。一行改动就能消除视觉重置。**不选**:它会让 runId 的语义从"一个 runtime turn"模糊化为"一段连续活跃期",`activitySnippet` 累积 buffer 的 runId 校验、`replaced` 终态广播、turn_end resolve 都要重新对齐;codex 与 claude 的 run 模型变得不再一致(codex `markRunThinking` 配 `turn/steer` 是协议级延续,claude 只是把两个独立 user turn 视觉上拼起来),后续维护负担大于一次性收益。
- **方案 B:前端 bubble key 不绑 runId,改绑 `(agentId, conversationId)`,startedAt 在"上一 run 终止后无空窗就继承"**。纯前端兜底,后端模型不动。**不选**:只能遮住视觉 reset,后端 `toolCallCounts`、`activitySnippet`、`startedAt` 仍按 runId 重置,UI 与底层数据出现"看起来连续 / 实际跳变"的语义裂缝;troubleshooting 时反而更难定位。如果未来想短期止痛(还没决定上 §12.2 主方案),方案 B 是低风险过渡选项,但要承认它是治标。

主方案仍是 §12.2 mention-targeted dispatch + passive catch-up + active-drain 钩子;A/B 不进延后清单。

### 12.3 历史可见的根因

agent spawn 时 stdin 只承载两块：`system_prompt` + L2 MEMORY/notes（启动后 agent 主动读）以及自己的未 delivered inbox 行（`drainInbox` 一次性 format 写入）。channel 历史**不会自动重放给 runtime**;DB/UI 层的"历史可见"和 runtime 层的"agent 知道"是两件事。所以 naive "未 mention 就直接丢"会让 B 第一次被 mention 时只看到那一条,缺前面 N 轮上下文。passive enqueue + active-drain 钩子是为这件事兜底。

### 12.4 二阶问题：drain 时的 token 爆炸

passive enqueue 修好了"看得到",没修"塞得动"。如果用户跟 A 聊了几百上千轮才第一次 @B,B 的第一次 stdin 写就要塞下整批历史,token 直接爆。需要配套：

- 截断策略（"只 drain 最近 N 条 + 'earlier messages omitted' 占位"）,或
- 折叠策略（前段用 summary tool 压成摘要 + 最近 N 条原文）,或
- 显式 user 控制（"include full history when waking new agent: yes/no"）。

任何一种都是独立的小设计,不应该跟 dispatch refactor 揉在一起。

### 12.5 延后理由

1. **当下伤害可控**：activity bubble 闪一下属于 UX 噪音,不是数据/语义错误。direct-mode/codex 的 runId 切换风险已被 §4.5 `markRunThinking` 修掉(toolCallCounts/startedAt 不丢);gated/claude 仍会因 `startRun` 走 `replaced` 终态而出现 activity 重置,但只是视觉重置,内部 turn 边界 / inbox / 消息持久化都正确。
2. **回归面大**：dispatch 是消息系统骨架,改一刀牵动 inbox 行为 / passive vs active 路径 / running-agent drain 时机 / startIdleRecipients 集合,任何一个边界没盖到都会出新 bug。
3. **二阶问题没有便宜解**：passive enqueue 配 drain 截断/折叠是必须的,但截断/折叠又会引入"agent 看到的历史 ≠ DB 真实历史"的语义复杂度,这是产品决策不是工程决策。
4. **更适合作为用户可选策略**：mention-targeted vs broadcast 在不同协作风格下有真实偏好差异（"开放群聊"型 vs "工单分派"型）,与其偷偷帮用户做选择,不如以后挂在 workspace/channel settings 里让用户挑。

### 12.6 触发再评估的条件

满足以下任一：

- token 成本投诉变多（"@A 一句话,所有人都被吵醒,跑了一圈"）。
- 用户反馈"我明明只问 X,Y 也跳进来抢答"成为常见痛点。
- 多 agent 协作场景从"探索性聊天"变成"明确分工流水线"——后者天然适合 mention-targeted。
- 实现 workspace/channel settings 时,顺便接入 dispatch 策略选项。

再评估时建议直接以 §12.2 + §12.3 + §12.4 为起点,不要重开讨论。

---

## 13. Schedule wake (`metadata.subtype = 'schedule_fire'`)

`ScheduleService` 在到点时把 wake 写到 owner agent 的 agent_home
primary `dm_channel`,**走的是普通的 `messages.insertForConversation`
+ `ConversationManager.deliverMessage` + `start`** —— 没有第二条 inbox
路径,也没有"特殊 wake 总线"。这条决策是 PR-1 锁的(见
`docs/cli-system.md` 与 `progress.md` 2026-05-09 PR-1
section),目的是让 schedule wake 在 run-state 维度上和任何用户消息
没有区别,Activity Strip / activity bubble / inbox 全部自动复用。

对 run-state 的影响:

- wake 消息 `from_kind = 'system'`,`metadata = { subtype:
  'schedule_fire', schedule_id, spec_kind, actual_fire_at,
  planned_fire_at, missed_count, next_fire_at }`。
- 投递方式:`deliverMessage` 把 inbox 行写好,然后 `start()` 唤起
  agent。如果 owner agent 此时 idle,直接走 spawn-time `drainInbox`,
  正常进入 `startRun`(新 runId);如果已经在跑,则按 driver 的现有规
  则(direct = 立刻写 stdin + `markRunThinking`,gated = `pendingDeliveries`
  + safe boundary `flushPending`)。
- §12 的 mention-targeted 讨论不适用 —— wake 永远只有一个 recipient
  (owner agent)。`from_kind='system'` 也不参与 mention 解析,不会
  误唤醒其他 channel 成员。
- Activity Strip 表现:wake 触发的 run 与正常 user-triggered run 走
  同一条 `agent_run_state` 路径。如果 wake 落在 agent 已经在干别的事
  的 `firing` 期内,gated 路径会出现 `replaced` 终态切 runId 的视觉重置
  (与 §11 已知现象一致),不需要单独处理。

PR-2 落地的 MCP 路由(`schedule` / `list_schedules` /
`cancel_schedule`)只动 schedule 自己的状态机,**不改任何
run-state 字段、不发任何 `agent_*` 事件**;UI 第一次看到 wake 是
agent_home dm_channel 收到那条 system 消息时的常规消息事件。

# Reactions — 设计探索

> Status: 2026-06-02 草案（@Alice）。来源诉求（@shiki）：有时一个简短的 ack，
> agent 也回一条消息会刷消息流；希望用 message-level emoji reaction 表达轻量确认，
> 不必发整条消息。
>
> 本 doc 是设计探索，不是落地清单。落地前需 @Cindy review（重点：isomorphism、
> migration、event 投递），并经 @shiki 拍板范围。

---

## 1. 目标与非目标

**目标**
- 给单条消息加/去 emoji reaction，作为**轻量确认/关注信号**（Slack/Discord 式）。
- Human 和 Agent **同构**：两者用同一条链路反应，渲染时聚合显示。
- Agent 能用 `silverhand message react` 代替"为了 ack 而发一条消息"，降低消息流噪音。
- Reaction 变化能实时广播给在场的 renderer。

**非目标（v1 不做）**
- 不做 reaction 通知/计入未读。reaction 是低优先级信号，不该制造 unread。
- 不做自定义 emoji / 图片 emoji。只接受 Unicode emoji。
- 不做 reaction 触发 workflow（如"👍 即 approve task"）。reaction 不进入任务状态机。
- 不做 per-emoji 的细粒度权限。能看会话即能 react。
- **v1 human UI 只做最小 chips**（@Cindy 2026-06-09 补、@Alice 采纳）：消息下方
  reaction chips + 点自己已有 reaction 取消。**emoji picker / hover 反应者列表
  后置**——否则「轻量 ack」会膨胀成一整套社交互动 UI。此项是零迁移成本的延后：
  reaction 走独立 `message_reactions` 表（§3.1），返回体给 renderer 的是聚合
  `{emoji, count, viewer_reacted}`（§4）；picker 只是换种方式产生 add 请求、
  reactor 明细只是多一个只读端点，两者都是纯 renderer + 只读查询增量，不动表结构/
  写链路/已发数据，想加随时加。

---

## 2. Slock 参照（@Cindy #task:802 调研）

`@slock-ai/daemon@0.55.3` 的 reactions：
- CLI：`slock message react --message-id <id> --emoji <emoji> [--remove]`。
- emoji 校验：trim 非空、无空白、长度 ≤ 16，否则 `INVALID_REACTION`。
- 路由：`/internal/agent-api/messages/<messageId>/reactions`，默认 POST(add)，`--remove` 走 DELETE，body `{ emoji }`。
- capability scope 里有独立的 `reactions` 开关。
- prompt 约束克制："Use sparingly：只在人明确要求或 reaction 是明确 acknowledgement 时用；
  不要每次 merge/deploy/task done 都自动发庆祝表情。"

**借鉴**：CLI 形态、add/remove 语义、emoji 校验、prompt 克制原则都直接采纳。
**差异**：Silverhand 走 `Principal` 同构模型 + conversation-scoped 路由 + WS event bus，
路由形态与 slock 的 `agent-api` 不同（见 §5）。

---

## 3. 核心设计判断

### 3.1 Reaction 不是消息（独立表，非 message metadata）
Reaction 是高频可变的多-actor 聚合数据。塞进 `messages.metadata`(JSON) 会有并发写覆盖、
无法按 reactor 唯一约束、无法索引的问题。**独立 `message_reactions` 表**，message 行不变。

### 3.2 Isomorphism — `reactor_kind + reactor_id` 两列合一（强制）
依据 `architecture-principles.md` §1 checklist #5：**禁止** `user_id` + `agent_id` 两列各占一边。
reaction 的反应者用 `reactor_kind ∈ {user, agent}` + `reactor_id`，与 AttachmentService 的
`createdByKind/createdById`、messages 的 `from_kind/from_*` 一脉相承。

Service 入口接收 `Principal`（`packages/backend/src/auth/principal.ts:25`），
在 route boundary 构造，service 内不解析身份、不写 `if (kind==='agent')` 业务分支
（checklist #1/#3）。Human 与 Agent 的差异若出现（v1 预计没有），走 `POLICIES` 表而非散落分支。

> 注意 `SystemPrincipal`：系统消息不应主动 react；route 层拒绝 `kind==='system'` 的 react 请求。

### 3.3 唯一性与幂等
`UNIQUE(message_id, reactor_kind, reactor_id, emoji)`。
- add：`INSERT ... ON CONFLICT DO NOTHING`（重复 react 同 emoji 幂等，不报错）。
- remove：`DELETE WHERE 四元组匹配`（不存在则 no-op，幂等）。
- 这样 CLI 重试、双击都安全。

### 3.4 toggle vs 显式 add/remove
采纳 slock 的**显式** add（POST）/ remove（DELETE），不做服务端 toggle。
toggle 在并发下语义不稳（两个 client 同时点会互相抵消）。renderer 自己根据
`viewer_reacted` 决定这次点击发 add 还是 remove。

### 3.5 viewer 视角聚合
列表查询时按 emoji 聚合成 `{emoji, count, viewer_reacted}`，`viewer_reacted` 依据
当前 viewer 的 `Principal`（renderer 永远是某个 user）判断。避免把全量 reactor 列表
打进 MessageDto——hover 再按需拉明细（v1 可不做明细，仅 tooltip 显示 count）。

> **viewer 必须贯穿到查询层（@Cindy review 补充）**：现 `MessageRepo.listWindowForConversation`
> 不带 viewer 参数，`messageRowToDto(row)` 也不知道 viewer。`viewer_reacted` 不能只在
> `messageRowToDto` 里算——要从 route/service 把 viewer principal 传进查询
> （`listWindowForConversation(..., { viewer })`）。agent `read-history` 若也返回 reactions，
> 需明确"agent 视角的 viewer_reacted"（= 该 agent 自己是否反应过），否则 public message list
> 与 agent history 的 `viewer_reacted` 语义会不一致。

### 3.6 closed / archived conversation 拒绝写入（@Cindy review 补充）
reaction 是**写操作**，必须和发消息一样拒绝 closed/archived 的 conversation。
注意现有 `canPostToConversation()` 只看 membership，**不看** `closed_at/archived_at`——
真正挡住发消息的是 `ConversationMessageService.sendMessage()` 内部的 closed/archived 检查。
ReactionService 必须自己复用同一套 closed/archived 校验，否则会出现"archived channel 不能发消息
但还能继续加 reaction"的漏洞。

---

## 4. 数据模型

新增 migration **v36 `message_reactions`**（紧接 migrations.ts:2356 现 v35 之后）：

```sql
CREATE TABLE message_reactions (
  id           TEXT PRIMARY KEY,
  message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  reactor_kind TEXT NOT NULL CHECK (reactor_kind IN ('user','agent')),
  reactor_id   TEXT NOT NULL,
  emoji        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE(message_id, reactor_kind, reactor_id, emoji)
);
CREATE INDEX idx_message_reactions_message ON message_reactions(message_id);
```

- `ON DELETE CASCADE`：消息删了 reaction 跟着没。
- 不加 `reactor_id` 的 FK：reactor 跨 user/agent 两个表，用 kind+id 软引用（与 messages.from_* 一致）。
- 不存 workspace/conversation：通过 `message_id → messages.conversation_id` 派生，避免冗余。

### 4.1 DTO（`packages/shared/src/api/dto.ts`，MessageDtoSchema ~841 行内追加）

```ts
reactions: z.array(z.object({
  emoji: z.string(),
  count: z.number().int().positive(),
  viewer_reacted: z.boolean(),
})).nullable(),   // null = 该消息无 reaction（与 attachments 同风格）
```

`messageRowToDto` 在组装时一并填充（见 §6 性能）。

---

## 5. 后端 API 与事件

### 5.1 路由（agent + human 同构，conversation-scoped）
新增 internal agent 路由（`packages/shared/src/api/paths.ts` internalPaths ~191）：

```
POST   /internal/conversations/:cid/agents/:aid/react-message    body {message_id, emoji}
DELETE 同上                                                       body {message_id, emoji}
```

human 侧用现有 `/api/*`（Bearer user principal）对称暴露：

```
POST   /api/messages/:id/reactions      body {emoji}
DELETE /api/messages/:id/reactions      body {emoji}
```

两条路由都在 route boundary 解析出 `Principal`，调用**同一个** service 方法：

```ts
// ReactionService（或并入 MessageService）
addReaction(principal, { messageId, emoji }): ReactionChange
removeReaction(principal, { messageId, emoji }): ReactionChange
```

route + service 层职责（checklist #3/#8）：
1. 解析 principal（已由 auth 中间件放进 context）。
2. 拒绝 `kind==='system'`。
3. 校验 emoji（§5.3）。
4. 校验 principal 可见/属于该 message 所在 conversation（复用现有 membership 校验）。
5. **拒绝 closed/archived conversation**（§3.6——复用 sendMessage 的 closed/archived 检查，
   不能只靠 `canPostToConversation()` 的 membership 判断）。
6. 调 service → 广播 event。

### 5.2 事件广播
经 `ScopeEventBus`（`packages/backend/src/ws/scope-event-bus.ts:76`）发到
`conversation:<cid>` scope，新增 event kind：

```ts
publishToScope(`conversation:${conversationId}`, 'message_reaction_changed', {
  message_id,
  emoji,
  op: 'add' | 'remove',
  reactor_kind, reactor_id,
  count,                 // 该 emoji 变更后的服务端聚合 count（权威值）
});
```

- **renderer 以 `count` 绝对赋值，不基于 `op` 做 +/-（@Cindy review 补充）**：WS 有 replay
  buffer，renderer 也可能 optimistic update，乱序/重放下 +/- 会漂移。收到 event 时直接把该
  emoji 的 count set 成 payload 的 `count`（`count==0` 则移除该 chip）。`viewer_reacted` 仅在
  `reactor_kind/reactor_id` 命中当前 viewer 时按 `op` 翻转（其余 reactor 不动 viewer flag）。
- **event 类型走 shared payload schema/type，不动 WS frame 的开放 kind 模型（@Cindy review 补充）**：
  现 `EventFrame.kind` 是开放 `string`（`packages/shared/src/ws-frames.ts`），**不要**为此改成严格
  union。要做的是新增一个 shared payload schema/type（仿 `TaskChangedEventSchema`），renderer 按它
  parse/use payload。

### 5.3 emoji 校验（采纳 slock，v1 用保守简单规则）
- trim 后非空、无内部空白。
- 长度上限：**v1 沿用 slock 的 char ≤ 16**（@Cindy review 拍板）。不自己发明"码点 ≤ 8"——
  ZWJ emoji 序列的长度边界很烦，保守简单规则即可；后面真要精确再引入 emoji parser。
- 仅允许 emoji 码点：用 `\p{Extended_Pictographic}`/`\p{Emoji_Component}` 系列正则
  （slock 用的就是 `^(\p{Extended_Pictographic}|\p{Emoji_Component})+$`，直接借鉴）。
- 失败返回稳定错误码（如 `invalid_reaction`），CLI/前端据此提示。

---

## 6. 性能注意（列表查询的 N+1）
消息列表（`message-repo.ts` `listWindowForConversation` ~169）默认拉一窗口（~200 条）。
**不要**每条消息单独查 reaction。两种方案：
- **A（推荐）**：一条 `SELECT ... WHERE message_id IN (<window ids>) GROUP BY message_id, emoji`
  + 一条判断 viewer_reacted，内存里 join 进各 MessageDto。
- B：列表时不带 reactions，renderer 对可见消息批量拉 `/reactions?ids=...`。增加一次往返，v1 不优先。

采纳 A：单次窗口查询补一次聚合查询，O(1) 额外往返。

---

## 7. CLI

`packages/cli/src/commands/message.ts` 新增 `react` 子命令（与 send/history/search 并列，
注册在 messageCommands 导出 ~316）：

```
silverhand message react --message-id <id> --emoji <emoji> [--remove]
```

- 默认 add（POST），`--remove` 走 DELETE（booleanFlags）。
- client 新增 `reactToMessage({message_id, emoji, remove})`，命中 §5.1 internal 路由。
- 错误透传：emoji 非法 → 退出码 1 + stderr JSON `{code:'invalid_reaction'}`。
- **同步更新** `docs/cli-system.md` 与 `packages/backend/src/drivers/platform-prompt.ts`
  （CLAUDE.md 硬约束：CLI 改动必须三处同步）。

---

## 8. Renderer

`MessageItem.tsx`（props ~30，action bar ~108）：
- 在 hover action bar 增加 reaction 入口（emoji picker popover）。
- message body 下方渲染 reaction chip 组：`[👍 3] [❤️ 1]`，自己反应过的 chip 高亮
  （`viewer_reacted`）。点已存在 chip = toggle（据 viewer_reacted 决定 add/remove）。
- chip 组件走主题 token（直角/圆角随主题，参照现有 task status chip 模式），不硬写色值。
- 数据：`MessageDto.reactions` 来自列表查询；WS `message_reaction_changed` 局部更新缓存。
- 可访问性：chip 带 aria-label（"👍, 3 reactions, click to react"）。
- v1 可不做 reactor 明细 tooltip；只显示 count。

---

## 9. Prompt 规则（关键——回应原始诉求）

诉求是"让 agent 用 reaction 代替刷消息"。需在 `platform-prompt.ts` 增加克制使用规则
（借鉴 slock 措辞，结合 Silverhand 的 etiquette）：

> 当你只是确认收到/已读、或表达轻量认同，且无新增信息时，**优先用
> `silverhand message react` 加一个 emoji，而不是发一条消息**。不要为了 ack 而刷消息流。
> 反过来，不要对每次 merge / deploy / task done 自动堆庆祝表情——只在 reaction 本身
> 就是有意义的确认信号时用。需要传达实质内容（结果、决定、阻塞）时仍发消息。

这条放在 "Conversation etiquette" 段，与现有 "Skip idle narration" 相邻，语义自洽。

---

## 10. 落地切片建议（供 review/排期）

按"后端正确性先打牢，再接入现有 message surface"重排（@Cindy review 微调）：

1. **S1 数据+服务**：v36 migration + `message_reactions` repo + ReactionService(add/remove/list)
   + closed/archived 校验 + emoji 校验 + 单测（isomorphism user/agent 各一、唯一约束、幂等、
   closed/archived 拒绝）。**这一片不接 message list/DTO**，先把写入正确性闭环。
2. **S2 路由+事件+读取面**：internal agent 路由 + human `/api` 路由 + WS event（含 shared payload
   schema）+ DTO `reactions` 字段 + 列表聚合（带 viewer principal 贯穿，§3.5/§6）+ read-history
   的 agent viewer 语义。路由层 ACL/principal/system/closed 拒绝测试。
3. **S3 CLI + prompt/docs**：`message react` 子命令 + client 方法 + cli-system.md
   + platform-prompt（CLI 命令 + §9 etiquette 规则）三处同步。
4. **S4 Renderer**：chip 组 + picker + WS 局部更新（count 绝对赋值）+ 主题 token + a11y。

S1/S2 是 @Cindy 的后端主场；S4 是我（renderer/desktop）；S3 跨层需两边同步。

---

## 11. 开放问题决议（@Cindy 建议 + 待 @shiki 终裁）
- **emoji 上限**：v1 用 slock 的 trim 非空 / 无空白 / char ≤ 16，不做码点 ≤ 8。**（Cindy 建议，已采纳进 §5.3）**
- **unread/notification**：完全不进。reaction 目标是降噪,不能反过来造通知。**（一致，确定）**
- **capability scope**：v1 不拆独立 `reactions` scope，能发消息即能 react。**（一致，确定）**
- **human `/api` 路由**：**本期就做**。否则 renderer 没法点 reaction，只做 agent 链路会把产品做半截。**（Cindy 建议，已采纳进切片 S2）**

以上 4 条 Cindy 与我意见一致，若 @shiki 无异议即作为 v1 基线锁定。

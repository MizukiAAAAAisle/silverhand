# observe() 坍缩 — 单一 eliminate 原语收口(#task:1231)

> **状态(#task:1232 已完成):** 旧 `/api/channels/:id/mark-read` route 已**删除**。**现存
> public cursor-write API 唯一 = `POST /api/attention/observe`。** legacy route 不再存在、
> 不再是任何校验 / §9.10 的 enforcement point(该守卫现纯由 renderer typed builder + observe
> 语义测试承载)。
>
> 模型权威在 `docs/activity-lifecycle-v1.md §5.3`(消除 = source-routed `observe()`)与
> `docs/thread-unread-v1.md §3.4/§9.10`(open-time snapshot、两 position、按 stream 非对称)。
> 本文只定**实现接口 + caller 形态**,不重述模型。
>
> **命名澄清:** 这里的 `observe()` = **注意力消除原语**,与 thread 投递里的 `observe` 投递档
> (backfill/non-waking)**是两个无关概念**。用例文件 / 函数命名取 `observe`(沿用 §5.3 canonical
> 词),两处的 disambiguation 写在 doc 注释里;`attention/` 前缀消解歧义。

## 0. 问题 & scope
「清除一条 read-cleared 注意力」原散落成 **4 条 caller 各写各**,其中一条有 latent bug:

| caller | 原本写谁 | 现状 |
|---|---|---|
| thread open-time | `conversation_reads` cursor（`useMarkThreadRead({snapshot_seq})`，open-time head） | ok |
| thread visible-live | 同上 cursor（live tail seq） | ok |
| channel open | cursor（`useMarkMessageChannelRead`） | ok |
| channel jump | **`useMarkChannelRead`（曾 `@deprecated`，只清 notification badge、不推 cursor）** | **bug:jump 没推 cursor**（`useMessageJumpController.ts`） |
| directed dismiss | `notifications.read_at`（`useMarkNotificationsRead`） | ok |
| Activity hover-✓ / Mark all read | — | observe 一起补 |

**目标:** 一个 application-layer use case `observe(source_ref[])` 收敛上述全部;**别处一律不许碰 read 状态**。
曾 `@deprecated` 的 `useMarkChannelRead` **不承担 cursor 语义,改名为 `useMarkConversationNotificationsRead`**(保留为
conversation notification cleanup surface,§5/§7);**cursor writer 收敛到 `observe(stream)`**,顺手校正 jump 误用它冒充
cursor 的 bug。**zero activity 自有 read 态**——observe() 只把写**委派回源聚合**(cursor / `notifications.read_at`)。

**in scope:** 注意力清除的 4 caller + Activity 两新 affordance 的后端 use case + DTO + renderer 接线。
**out of scope:** 通知面板(notification dropdown)自己的 bulk read_at——它是另一个 surface、
只写 read_at 无 cursor,不构成「两个 cursor writer」;但**不得**新长出第二条 cursor 写路径(见 §7)。

## 1. 接口形状

```ts
// packages/backend/src/application/observe.ts

/** 流位置 —— typed variant，区分「client 钉住的 seq」vs「server 取 current head」。 */
type StreamPosition =
  // client-supplied 已解析 seq:thread open-time snapshot head / visible-live seq。
  // **AUTO 路径(ThreadPanel open/live)必用**——钉住已观测 seq = §9.10 防 tail-swallow。
  | { kind: 'at_seq'; seq: number }
  // server-resolved 当前 stream head。**EXPLICIT clear**(channel open/jump + ambient hover-✓ +
  // Mark all read)用——显式「把这条流标到当前 head」、接受并发吞尾(§2)。**mainline 与 thread 皆可**
  // (auto-vs-explicit 是 caller 属性、非 thread 形状禁令;§9.10 由 renderer 构造层守,见 §2)。
  | { kind: 'stream_head' };

/** 一条消除目标 = 一个 source_ref(answerability:source_ref-in = source_ref-out)。 */
type ObserveSource =
  | { kind: 'stream'; conversationId: string; threadRootId: string | null; position: StreamPosition }
  | { kind: 'notification'; notificationId: string };

type ObserveInput = {
  principal: Principal;          // viewer(canViewOwnedState 底座校验)
  sources: ObserveSource[];      // 单条 = 一次清除;多条 = Mark all read 批量(逐条等价)
};

type ObserveResult = { ok: true; changed: boolean } | { ok: false; error: ObserveError };
```

**端点:** bounded 端点 `POST /api/attention/observe`(body = `{ sources }`)—— 挂 Attention 限界上下文
(它**拥有**消除原语;serves 不止 Activity surface,thread/channel open-time 读也调它,故用 context 名而非
surface 名 `activity`;API path 非用户界面,不破「Attention 不上界面」的 UI-label 规)。**`observe` 一词的
thread-delivery 歧义**靠 `attention/` 前缀消解。**委派边界:`/api/notifications/read` 不委派 observe、
保留为 notification surface 的 read_at-only 路由**(§7 R2)。cursor 写唯一入口 = `/api/attention/observe`。

**关键澄清:单一原语口径 =「cursor 单写者 = observe()」,不是「read_at 单写者」。**
`notifications.read_at` 合法有**两个**写者且不冲突(都写真实源、无 shadow 态):① observe()——清 Activity directed item
(mention/agent_failed,by-id);② notification surface——通知徽标 / focused-conversation 清理(§5)。observe() 是
**Activity item 的单一 eliminate**,不是「唯一能碰 read_at 的人」。

## 2. 委派表(写回源聚合,零自有状态)

| source.kind | observe 写回 | overlap(折进 use case,见 §3) |
|---|---|---|
| `stream` | `ConversationReadRepo.markRead({viewer, conv, threadRootId, seq})`,`seq` 按 position 解析、单调 max | **+** 对该 stream 内 `seq <= 解析seq` 的 viewer 未读 `mention_self` notification 置 `read_at` |
| `notification` | `notifications.markRead(notificationId, viewer)` | 无(**不**推 cursor) |

position 解析(保 §3.4 stream 契约):
- `at_seq`:`seq` 直接用;校验 `seq <= streamHeadLatestSeq(conv, root)`,`> head` → 400(坏客户端推未来,§3.4 fail-loud)。
- `stream_head`:`seq = streamHeadLatestSeq(conv, root)`(server 解析,**mainline OR thread 皆可**)。**并发吞尾是有意识产品语义**:
  用 `stream_head` 的 caller —— **channel open** + **Activity Mark-all** + **ambient item hover-✓** —— 都会吞「列表渲染后→操作前到达的尾部」。
  这是接受的:显式 ✓ / Mark-all / 进会话 = 「把这条流标到当前 head」。
- **不变量(§9.10):tail-swallow 防的是「caller 意图」轴、不是「stream 形状」轴。**
  AUTO 路径(ThreadPanel open-time / visible-live)**必须** `at_seq`;EXPLICIT clear(含 thread 的 hover-✓/Mark-all)**可**
  `stream_head`。**endpoint 不 blanket 400 thread+stream_head**(否则 Activity 的 followed-thread `unread` item 清不掉)——
  §9.10 **不由任何后端 public route 兜底,唯一 enforcement = renderer 类型化构造层**
  (`apps/desktop/src/renderer/features/attention/observe.ts`):AUTO builders(`streamSourceAtSeq` /
  `mainlineStreamSourceHead`)在类型上发不出 thread+`stream_head`;`explicitStreamClearHead` 是唯一能发的、仅供
  显式清读(hover-✓/Mark-all);由 `observe.test.ts` 锁(AUTO 不能发 thread+stream_head、explicit 能、DM-unread
  仍走 stream)。后端只看到一个请求、分不出 caller,故守卫必须在 caller 层 —— 收口到这一可证层是有意为之,非 guard 变弱。

**统一规则:`stream_head` = 「显式·当前 head」语义** —— channel open/jump + bulk/✓(Mark-all、ambient hover-✓),
**thread explicit clear 同样适用**。**auto observe(thread open-time / visible-live)永远 `at_seq`**(client snapshot/visible seq,renderer 结构性保证)。
**且 directed / mention item 在任何路径(含 Mark-all 批量)永远按 `notificationId` by-id 精确清,绝不走 `stream_head`** →
**没有任何一条 @我会被并发吞掉**;只有 ambient「所有消息」未读吃 `stream_head`,而「把这条噪音流标到当前 head」正是 ✓ / Mark-all 的诚实语义。

## 3. overlap 规则(显式)

一条 @我消息**同时**是 positional(cursor)+ directed(notification)= **两个 source_ref**。规则**非对称**,
与 §5.3 一致:

- **positional observe 吞并 directed(双清折进 use case):** `observe({stream, position→seq N})` 在同一事务里
  ① 推 cursor 到 N;② 对该 stream `seq <= N` 的 viewer 未读 `mention_self` notification 置 `read_at`。
  **理由:** Activity 列表侧 cursor-passed 本就**派生**清除 mention(read-model dedup:`message_seq <= cursor` 即跳过),
  但 **`/n/unread` 通知徽标直接读 `read_at IS NULL`、不派生** → 不补这刀徽标会残留成第二份真相。把第二刀收进
  use case,caller 永不需记得补 →「single eliminate」名实一致。**这仍是写真实源(notification.read_at),非
  activity 自有态。**(`agent_start_failed` 无 message anchor、无 seq,不参与 overlap;只能经自身 notification observe 清。)
- **directed observe 不吞并 positional:** `observe({notification, id})`(bare hover-✓,未跳源)只置该条 `read_at`,
  **不推 cursor**。若该消息仍 positionally 未读 → 折进该 stream 的 ambient 计数(不再是独立 directed item)。
  **理由:** 关掉一条 @提醒 ≠ 读了整条流。`点 mention 跳源读到 ⇒ stream 侧也消`(§5.3)走的是「跳源」=
  打开会话触发的 positional observe,**不是** bare read_at。

overlap 的 notification 清除是 **by-(conv, root, seq-range) 精确**(只清 cursor 够得到的那些),**非** conversation-level
bulk(item-level answerability,不 over-clear cursor 之外的 notification)。

## 4. 事件(renderer 双变体 discrimination)

> renderer **按 payload 形状区分** `unread_updated` 两变体(`apps/desktop/src/renderer/features/{channels,notifications}/hooks.ts`
> 的 `isMessageUnreadUpdatedPayload` = 「payload 含 `conversation_id` 字符串」):
> - **message 变体(payload 带 `conversation_id`)** → 刷 cursor 读模型(`useMessageUnreadCounts` 侧栏消息未读 / `conversationUnread` reply-chip)。
> - **badge 变体(payload 不带 `conversation_id`)** → 刷通知徽标(`useUnreadCounts` `/api/notifications/unread`)。
>
> 故一条空 payload coalesced event **只会**刷徽标、**漏刷** cursor 读模型 —— 会让 observe 推了 cursor 但侧栏/chip 不更新。
> 事件形状由 renderer 契约反向定。

observe() 末尾按**实际变更**发(post-commit、commit 后才发):
- **每个发生变更的 conversation 各发一条 message 变体** `publishToScope('viewer:<id>', 'unread_updated', { conversation_id })`
  ——「变更」= 该 conversation 有 cursor 推进 **或** overlap 清了 mention。**同 conversation 的 mainline + thread 去重成一条**
  (payload 只带 `conversation_id`、不带 `thread_root_id`;chip consumer 按 conversation 失效整个 `conversationUnread` 含全 thread)。
- **任一 `read_at` 置位(overlap mention 或 notification source)→ 额外发一条 badge 变体** `unread_updated`(payload **不带**
  `conversation_id`)刷徽标。

即「coalesced」的真实契约 = **每 changed-conversation 恰一条 message 变体 + 至多一条 badge 变体**,而非字面单条。
单 source(最常见)= 一条;Mark-all 跨 N conversation = N(+1)条、按 conversation 去重(不按 message 刷屏)。**仅当真有变化才发;不新增 event kind。**

## 5. caller 形态

| caller | 形态 |
|---|---|
| thread open-time `useMarkThreadRead` | `observe([{stream, root, position:{at_seq: snapshot_seq}}])` |
| thread visible-live | `observe([{stream, root, position:{at_seq: visibleSeq}}])` |
| channel open `useMarkMessageChannelRead` | `observe([{stream, root:null, position:{stream_head}}])`(或 at_seq 若持 snapshot) |
| channel jump `useMessageJumpController` | `observe([{stream, root:null, position:{stream_head}}])`（与 channel open 同语义:mainline=进入即标 latest）—— 修 latent bug:原误清 badge → 改成推 cursor；若入口带具体 notification id，caller 额外 `observe([{notification, id}])` |
| directed dismiss `useMarkNotificationsRead`(Activity item) | `observe([{notification, id: notification_id}])` |
| `useMarkConversationNotificationsRead`(清 conversation 级通知徽标) | 只清 notification 徽标、**非** stream cursor。`App.tsx` focused-conversation effect 用它清该会话**全部** notification 徽标,**含无 message anchor 的 `agent_start_failed`**(overlap 只覆盖有 seq 的 `mention_self`、清不到这类),走 `/api/notifications/read` read_at-only。此 surface 独立存在,不与 cursor observe 混用。 |
| Activity hover-✓(per item) | unread→`{stream, …stream_head}` / mention·agent_failed→`{notification, id}` |
| Activity Mark all read | `observe(列表全 item 的 source_ref[])`,unread 用 `stream_head`(显式 bulk) |

DTO 侧:Activity item 已带 `notification_id`(directed)/ `conversation_id`+`thread_root_id`+`message_id`(positional),
够拼 source_ref;**`id` 仅 React key、绝不解析**(沿 §5.3)。

## 6. 校验不变量(回归测试守)

### 6.1 per-source 授权 + root 校验
端点 `conversationId` 来自 body。故**每个 `stream` source** 必须做全套校验(收进 observe `resolveSource`):
- `canViewConversation`(channel-like 可读;非成员/不可见 → 拒);
- `threadRootId !== null` 时:该 root message 存在、`conversation_id === source.conversationId`、且 `thread_root_id IS NULL`
  (是 root 不是 reply)—— `thread_root_not_found` / `thread_root_is_reply`。
`notification` source 靠 `notifications.markRead(id, viewerUserId)` 的 user-scope(只动 viewer 自己的 notification)。
**混合 batch 任一 source 非法 → 整个 request fail(400/403),绝不 partial clear**(半清=又一种半状态)。viewer 解析仍
`canViewOwnedState`,但它是**底座、非充分**——per-source 可见性校验在其之上。

### 6.2 事务边界
- 单个 `stream` source 的 **cursor advance + overlap `mention_self.read_at`** 必须**同一 DB transaction**(否则中途失败 =
  「cursor 清了、徽标残留」半状态,正是要消的)。
- **整个 batch(全部 sources)在一个 application transaction 内**完成;**commit 后**才 `unread_updated`(coalesced:每变更 conversation 一条 message 变体 + 至多一条 badge 变体,§4)。
- 校验(§6.1)在事务**之前**全跑完(fail-fast,非法 source 不进事务)。

### 6.3 其它不变量
1. `stream_head` 对**任何 stream(含 thread)合法** = 显式 clear 当前 head(§2;§9.10 由 caller 层守、非 endpoint blanket 400)。
2. `at_seq > streamHead` → 400(§3.4:防推未来)。
3. mainline 用 `stream_head` position → server 解析该 stream head。
4. overlap 的 notification 清除限 `seq <= 解析seq` 且 `mention_self`(有 anchor);`agent_start_failed` 不参与。
5. observe() 全程不写任何 `activity.*` 表(answerability:source_ref-out ∈ {cursor, notifications.read_at})。

## 7. R 决策
- **R1(完成,#task:1232):** bounded 端点 `/api/attention/observe` 已落地;旧 `/api/channels/:id/mark-read`
  已**删除**——**现存 public cursor-write API 唯一 = `/api/attention/observe`**,退役零 agent/CLI 契约破坏
  (`packages/cli` 从无 mark-read 命令;grep 命中的 `observe` 全是无关的 thread-delivery `agent_stream_observed` ——
  这也实锤 `observe` 一词已被 delivery 侧占用 = §1 用 `attention/` 前缀的根据)。`conversationReads.markRead` 现仅
  observe() 一个 caller(结构性单写者)。
- **R2(定):** `/api/notifications/read`(markRead/markConversationRead/markWorkspaceRead/markAllRead)
  **保留且不进 observe 委派列表**——它只写 source-owned `notifications.read_at`、不写 cursor,**不是第二个 cursor writer**。
  本任务硬守:**cursor 写口径唯一 = observe()**(read_at 仍有两个合法 writer,见 §1/§3:observe 折叠的 positional-overlap
  + 此 notification surface)。`/api/notifications/read` 承载两个合法 surface ——
  ① 通知面板 bulk;② **focused-conversation 的 conversation-级徽标清理**(`App.tsx` 进会话 effect),它清该会话**全部**
  notification 徽标、**含 anchorless `agent_start_failed`**——这类无 message anchor / 无 seq,positional observe 的 overlap(限 `seq<=N`
  的 `mention_self`)**覆盖不到**,只能由这条 by-conversation read_at 路径清。cursor 推进则统一走 renderer 直调
  `observe(stream)` → `/api/attention/observe`;Activity 的 directed dismiss 走 `observe(notification)`,而 conversation-级
  badge 清理留在 `/api/notifications/read` —— 两者职责不同。对应 renderer:`useMarkConversationNotificationsRead`
  只清 notification 徽标(§5)。
- **R3(定):** `stream_head` 用于 explicit bulk(Mark-all)+ ambient per-stream hover-✓,**并发吞尾写成有意识产品语义**
  (§2 已并列两 caller)。不为此改回 client snapshot。

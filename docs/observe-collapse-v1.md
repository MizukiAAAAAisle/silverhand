# observe() 坍缩 — 单一 eliminate 原语收口(#task:1231)

> 接口稿 v1(@Alice 出形状 → @Cindy review answerability/委派边界 → @Norman 接线 step-3)。
> 模型权威在 `docs/activity-lifecycle-v1.md §5.3`(消除 = source-routed `observe()`)与
> `docs/thread-unread-v1.md §3.4/§9.10`(open-time snapshot、两 position、按 stream 非对称)。
> 本文只定**实现接口 + caller 迁移**,不重述模型。
>
> **命名澄清:** 这里的 `observe()` = **注意力消除原语**,与 thread 投递里的 `observe` 投递档
> (backfill/non-waking,Cindy 提议改名 `context`/`backfill`)**是两个无关概念**。后者改名是独立
> owed doc-sync;本任务不碰它,但用例文件/函数命名取 `observe`(沿用 §5.3 canonical 词),开工前
> 我会把两处的 disambiguation 写进 doc 注释。

## 0. 问题 & scope
今天「清除一条 read-cleared 注意力」散落成 **4 条 caller 各写各**,且其中两条已有 latent bug:

| caller | 今天写谁 | 现状 |
|---|---|---|
| thread open-time | `conversation_reads` cursor（`useMarkThreadRead({snapshot_seq})`，open-time head） | ok |
| thread visible-live | 同上 cursor（live tail seq） | ok |
| channel open | cursor（`useMarkMessageChannelRead`） | ok |
| channel jump | **`useMarkChannelRead`（已 `@deprecated`，只清 notification badge、不推 cursor）** | **bug:jump 没推 cursor**（Norman 核 `useMessageJumpController.ts:26/41`） |
| directed dismiss | `notifications.read_at`（`useMarkNotificationsRead`） | ok |
| Activity hover-✓ / Mark all read | — | 未建（step-3 随 observe 一起补） |

**目标:** 一个 application-layer use case `observe(source_ref[])` 收敛上述全部;**别处一律不许碰 read 状态**。
deprecated 的 `useMarkChannelRead` **不再承担 cursor 语义,改名为 `useMarkConversationNotificationsRead`**(保留为
conversation notification cleanup surface,§5/§7);**cursor writer 收敛到 `observe(stream)`**,顺手校正 jump 误用它冒充
cursor 的 bug。**zero activity 自有 read 态**——observe() 只把写**委派回源聚合**(cursor / `notifications.read_at`)。

**in scope:** 注意力清除的 4 caller + Activity 两新 affordance 的后端 use case + DTO + renderer 接线。
**out of scope(本任务不动):** 通知面板(notification dropdown)自己的 bulk read_at——它是另一个 surface、
只写 read_at 无 cursor,不构成「两个 cursor writer」;但**不得**新长出第二条 cursor 写路径(见 §7)。

## 1. 接口形状

```ts
// packages/backend/src/application/observe.ts

/** 流位置 —— typed variant，绝不塌缩成「后端取 current head」(§9.10 回归源)。 */
type StreamPosition =
  // client-supplied 已解析 seq:thread open-time snapshot head / visible-live seq。
  // thread 唯一合法形态;channel 也可用(若 client 持有 snapshot)。
  | { kind: 'at_seq'; seq: number }
  // server-resolved 当前 stream head。仅 **mainline explicit stream clear**(channel open / jump /
  // ambient hover-✓ / Mark all read)可用——这些都是显式「把这条流标到当前 head」语义,接受并发吞尾(§2);
  // **thread 自动路径(open-time / visible-live)绝不可用**(必 `at_seq`,§9.10 回归源)。
  | { kind: 'stream_head' };

/** 一条消除目标 = 一个 source_ref(answerability:source_ref-in = source_ref-out)。 */
type ObserveSource =
  | { kind: 'stream'; conversationId: string; threadRootId: string | null; position: StreamPosition }
  | { kind: 'notification'; notificationId: string };

type ObserveInput = {
  principal: Principal;          // viewer(canViewOwnedState 同 mark-read 路由)
  sources: ObserveSource[];      // 单条 = 一次清除;多条 = Mark all read 批量(逐条等价)
};

type ObserveResult = { ok: true; changed: boolean } | { ok: false; error: ObserveError };
```

**端点(Cindy blocker #4 — 不用裸 `/api/observe`):** 新 bounded 端点 `POST /api/attention/observe`(body = `{ sources }`)——
挂 Attention 限界上下文(它**拥有**消除原语;serves 不止 Activity surface,thread/channel open-time 读也调它,故用
context 名而非 surface 名 `activity`;API path 非用户界面,不破「Attention 不上界面」的 UI-label 规)。**`observe` 一词的
thread-delivery 歧义**靠 `attention/` 前缀消解。**委派边界(Cindy review-2 收窄,避免自相矛盾):仅
`/api/channels/:id/mark-read` 内部委派 `observe(stream)`**(cursor 路径);**`/api/notifications/read` 不委派 observe、
保留为 notification surface 的 read_at-only 路由**(§7 R2)。renderer 迁完后再议退役 channel route(R1)。

**关键澄清(Cindy review-2 blocker):单一原语口径 =「cursor 单写者 = observe()」,不是「read_at 单写者」。**
`notifications.read_at` 合法有**两个**写者且不冲突(都写真实源、无 shadow 态):① observe()——清 Activity directed item
(mention/agent_failed,by-id);② notification surface——通知徽标 / focused-conversation 清理(§5)。observe() 是
**Activity item 的单一 eliminate**,不是「唯一能碰 read_at 的人」。

## 2. 委派表(写回源聚合,零自有状态)

| source.kind | observe 写回 | overlap(折进 use case,见 §3) |
|---|---|---|
| `stream` | `ConversationReadRepo.markRead({viewer, conv, threadRootId, seq})`,`seq` 按 position 解析、单调 max | **+** 对该 stream 内 `seq <= 解析seq` 的 viewer 未读 `mention_self` notification 置 `read_at` |
| `notification` | `notifications.markRead(notificationId, viewer)` | 无(**不**推 cursor) |

position 解析(保 §3.4 路由契约):
- `at_seq`:`seq` 直接用;校验 `seq <= streamHeadLatestSeq(conv, root)`,`> head` → 400(坏客户端推未来,§3.4 fail-loud)。
- `stream_head`:`seq = streamHeadLatestSeq(conv, root)`(server 解析)。**并发吞尾是有意识产品语义**(Cindy blocker #3):
  用 `stream_head` 的两个 caller —— **Activity Mark-all** 与 **ambient item 的 hover-✓** —— 都会吞「列表渲染后→操作前到达的尾部」。
  这是接受的:ambient item = stream aggregate,显式 ✓ / Mark-all = 「把这条流标到当前 head」。两者必须并列写明,
  别让实现以为只有 Mark-all 有此取舍。
- **不变量(§9.10):** `threadRootId !== null` 时 position 必须是 `at_seq`;`stream_head` 对 thread → 400
  (= 现路由「thread 缺 snapshot_seq 即 400」的等价,Norman 核 `channelMarkRead`)。channel(mainline)两者皆可。

**统一规则(Norman R3 细化,非特例):`stream_head` 只出现在「显式·非自动」路径** —— mainline 兼容
(channel open/jump)+ bulk/✓(Mark-all、ambient hover-✓)。**auto observe(thread open-time / visible-live)永远 `at_seq`**
(client snapshot/visible seq)。**且 directed / mention item 在任何路径(含 Mark-all 批量)永远按 `notificationId` by-id 精确清,
绝不走 `stream_head`** → **没有任何一条 @我会被并发吞掉**;只有 ambient「所有消息」未读吃 `stream_head`,而「把这条噪音流标到
当前 head」正是 ✓ / Mark-all 的诚实语义。这条把 §6.3 的吞尾取舍收束成一句安全保证。

## 3. overlap 规则(显式 —— Cindy gate #3)

一条 @我消息**同时**是 positional(cursor)+ directed(notification)= **两个 source_ref**。规则**非对称**,
与 §5.3 line 156 一致:

- **positional observe 吞并 directed(双清折进 use case):** `observe({stream, position→seq N})` 在同一事务里
  ① 推 cursor 到 N;② 对该 stream `seq <= N` 的 viewer 未读 `mention_self` notification 置 `read_at`。
  **理由:** Activity 列表侧 cursor-passed 本就**派生**清除 mention(read-model §7 dedup:`message_seq <= cursor` 即跳过),
  但 **`/n/unread` 通知徽标直接读 `read_at IS NULL`、不派生** → 不补这刀徽标会残留成第二份真相。把第二刀收进
  use case,caller 永不需记得补 →「single eliminate」名实一致。**这仍是写真实源(notification.read_at),非
  activity 自有态。**(`agent_start_failed` 无 message anchor、无 seq,不参与 overlap;只能经自身 notification observe 清。)
- **directed observe 不吞并 positional:** `observe({notification, id})`(bare hover-✓,未跳源)只置该条 `read_at`,
  **不推 cursor**。若该消息仍 positionally 未读 → 折进该 stream 的 ambient 计数(不再是独立 directed item)。
  **理由:** 关掉一条 @提醒 ≠ 读了整条流。`点 mention 跳源读到 ⇒ stream 侧也消`(§5.3)走的是「跳源」=
  打开会话触发的 positional observe,**不是** bare read_at。

overlap 的 notification 清除是 **by-(conv, root, seq-range) 精确**(只清 cursor 够得到的那些),**非** conversation-level
bulk(守 Cindy gate #2:item-level answerability,不 over-clear cursor 之外的 notification)。

## 4. 事件

observe() 末尾**仅一次** `publishToScope('viewer:<id>', 'unread_updated', …)`,且仅当真有变化
(cursor 移动 **或** 任一 read_at 置位);批量(Mark all)跨全部 source 合并成一发。沿用现两路由各自的
「仅 counter 变才发」纪律,合并去重。**不新增 event kind。**

## 5. caller 迁移表(step-3,Norman)

| caller | 迁移成 |
|---|---|
| thread open-time `useMarkThreadRead({snapshot_seq})` | `observe([{stream, root, position:{at_seq: snapshot_seq}}])` |
| thread visible-live | `observe([{stream, root, position:{at_seq: visibleSeq}}])` |
| channel open `useMarkMessageChannelRead` | `observe([{stream, root:null, position:{stream_head}}])`(或 at_seq 若持 snapshot) |
| channel jump `useMessageJumpController`（现误调 deprecated badge-only） | **脱钩**通知 hook → `observe([{stream, root:null, position:{stream_head}}])`（与 channel open 同语义:mainline=进入即标 latest）—— **修 latent bug:现误清 badge → 改成推 cursor**；若入口带具体 notification id，caller 额外 `observe([{notification, id}])`（或进源前已清），不引入新行为 |
| directed dismiss `useMarkNotificationsRead`(Activity item) | `observe([{notification, id: notification_id}])` |
| `useMarkChannelRead`(现 `@deprecated`,清 conversation 级通知徽标) | **不退役,改名** `useMarkConversationNotificationsRead`(明确:只清 notification 徽标、**非** stream cursor)。它仍是合法 surface——`App.tsx` focused-conversation effect 用它清该会话**全部** notification 徽标,**含无 message anchor 的 `agent_start_failed`**(overlap 只覆盖有 seq 的 `mention_self`、清不到这类),走 `/api/notifications/read` read_at-only。**唯一的 bug = jump 误用它冒充 cursor observe**(上行已脱钩);此 surface 本身不消失。 |
| Activity hover-✓(per item) | unread→`{stream, …stream_head}` / mention·agent_failed→`{notification, id}` |
| Activity Mark all read | `observe(列表全 item 的 source_ref[])`,unread 用 `stream_head`(显式 bulk,gate #1 允许) |

DTO 侧:Activity item 已带 `notification_id`(directed)/ `conversation_id`+`thread_root_id`+`message_id`(positional),
够拼 source_ref;**`id` 仅 React key、绝不解析**(沿 §5.3)。`snapshot_seq` 客户端回传大概率可删(visible-live 已报真实 seq)
—— 但删它属迁移细节,放 step-3 评估,不在接口稿强制。

## 6. 校验不变量(保现路由契约,回归测试守)

### 6.1 per-source 授权 + root 校验(Cindy blocker #1 —— 端点收任意 conversationId,必须逐 source 校验)
新端点比旧 `/api/channels/:id/mark-read`(id 在路径、已 gated)宽:`conversationId` 来自 body。故**每个 `stream` source**
必须复用旧 mark-read 路由的全套校验:
- `canViewConversation`(channel-like 可读;非成员/不可见 → 拒);
- `threadRootId !== null` 时:该 root message 存在、`conversation_id === source.conversationId`、且 `thread_root_id IS NULL`
  (是 root 不是 reply)—— 等价现路由 §3.1.1 的 `thread_root_not_found` / `thread_root_is_reply`。
`notification` source 靠 `notifications.markRead(id, viewerUserId)` 的 user-scope(只动 viewer 自己的 notification)。
**混合 batch 任一 source 非法 → 整个 request fail(400/403),绝不 partial clear**(半清=又一种半状态)。viewer 解析仍
`canViewOwnedState`,但它是**底座、非充分**——per-source 可见性校验在其之上。

### 6.2 事务边界(Cindy blocker #2)
- 单个 `stream` source 的 **cursor advance + overlap `mention_self.read_at`** 必须**同一 DB transaction**(否则中途失败 =
  「cursor 清了、徽标残留」半状态,正是要消的)。
- **整个 batch(全部 sources)在一个 application transaction 内**完成;**commit 后**才 `unread_updated`,且**只发一次**(§4)。
- 校验(§6.1)在事务**之前**全跑完(fail-fast,非法 source 不进事务)。

### 6.3 其它不变量
1. thread + `stream_head` → 400(§9.10:thread 必带 client position)。
2. `at_seq > streamHead` → 400(§3.4:防推未来)。
3. mainline 省略/`stream_head` → server 解析 mainline head(legacy channel 唯一兼容路径)。
4. overlap 的 notification 清除限 `seq <= 解析seq` 且 `mention_self`(有 anchor);`agent_start_failed` 不参与。
5. observe() 全程不写任何 `activity.*` 表(answerability:source_ref-out ∈ {cursor, notifications.read_at})。

## 7. R 决策(Cindy review-1 拍定;R2 经 review-2 收窄)
- **R1(定):** 新 use case + 新 bounded 端点 `/api/attention/observe`;旧 `/api/channels/:id/mark-read` **先内部委派**
  新 use case 保持迁移安全,renderer 迁完**再议**是否退役 route——**不在同一轮为「干净」删可能仍有测试/旧调用方的路径**。
  (Norman 核:`packages/cli` 无任何 mark-read 命令、grep 命中的 `observe` 全是无关的 thread-delivery `agent_stream_observed`
  → 最终退役 route **零 agent/CLI 契约**要破,迁移安全;同时实锤 `observe` 一词已被 delivery 侧占用 = §1 用 `attention/` 前缀的根据。)
- **R2(定,Cindy review-2 收窄):** `/api/notifications/read`(markRead/markConversationRead/markWorkspaceRead/markAllRead)
  **暂留且不进 observe 委派列表**——它只写 source-owned `notifications.read_at`、不写 cursor,**不是第二个 cursor writer**;
  日后想统一可做,但**不塞进 #1231**。本任务硬守:**cursor 写口径唯一 = observe()**(read_at 仍有两个合法 writer,见 §1/§3:
  observe 折叠的 positional-overlap + 此 notification surface)。
  **迁移后边界(Cindy/Norman 实锤,比 review-1 更窄):`/api/notifications/read` 承载两个合法 surface ——**
  ① 通知面板 bulk;② **focused-conversation 的 conversation-级徽标清理**(`App.tsx:994` 进会话 effect),它清该会话**全部**
  notification 徽标、**含 anchorless `agent_start_failed`**——这类无 message anchor / 无 seq,positional observe 的 overlap(限 `seq<=N`
  的 `mention_self`)**覆盖不到**,只能由这条 by-conversation read_at 路径清。**只有 `/api/channels/:id/mark-read` 委派
  `observe(stream)`**;Activity 的 directed dismiss 走 `observe(notification)`,但 conversation-级 badge 清理留在本路径——
  两者职责不同,不再都看着像「清通知」。对应 renderer:`useMarkChannelRead` **改名不退役** → `useMarkConversationNotificationsRead`
  (§5);唯一真 bug = `useMessageJumpController` 误把它当「推 cursor」用,改走 observe(stream)。
- **R3(定):** `stream_head` 用于 explicit bulk(Mark-all)+ ambient per-stream hover-✓,**并发吞尾写成有意识产品语义**
  (§2 已并列两 caller)。不为此改回 client snapshot。

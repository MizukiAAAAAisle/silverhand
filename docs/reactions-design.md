# Reactions

消息级 emoji reaction 的领域契约。诉求:一个简短的 ack 也发一条消息会刷消息流;
用 message-level emoji reaction 表达轻量确认,不必发整条消息。本 doc 定义 reaction 的领域
不变量与投递语义;具体 route/DTO/CLI 签名以 code 为准(`packages/backend/src/**/react*`、
`packages/shared/src/api/reactions.ts`、`docs/cli-system.md` §3.6),它们是 enforcement,不在此复述。

---

## 1. 目标与非目标

**目标**
- 给单条消息加/去 emoji reaction,作为**轻量确认/关注信号**。
- Human 与 Agent **同构**:同一条链路反应,渲染时聚合显示。
- Agent 用 `silverhand message react` 代替"为了 ack 而发一条消息",降低消息流噪音(→ §7)。
- Reaction 变化实时广播给在场 renderer(→ §5.2)。

**非目标(v1 不做)**
- 不做 reaction 通知 / 计入未读。reaction 是低优先级信号,不制造 unread(与 §4 同族)。
- 不做自定义 / 图片 emoji。只接受 Unicode emoji(→ §5 emoji 校验)。
- 不做 reaction 触发 workflow(如"👍 即 approve task")。reaction 不进任务状态机。
- 不做 per-emoji 细粒度权限。

**权限口径 = 发消息同级写权限(单一定义)。** reaction 是**写操作**:human 用发送消息同级的写
权限;agent internal route 要求 `send_messages` capability;`read_messages` **不能**写 reaction。
v1 不拆独立 `reactions` capability scope。("能看会话即能 react"的旧措辞已废弃,以此为准。)

---

## 2. 数据模型

Reaction 是高频可变的多-actor 聚合数据,**独立 `message_reactions` 表**承载,message 行不变
(理由见 §3.1)。领域不变量:

- reactor 用 `reactor_kind ∈ {user, agent}` + `reactor_id` 两列合一表达身份(§3.2),不加 FK——
  reactor 跨 user/agent 两个表,用 kind+id 软引用(与 `messages.from_*` 一致)。
- 不存 workspace / conversation 冗余列:通过 `message_id → messages.conversation_id` 派生。
- `ON DELETE CASCADE`:消息删了 reaction 跟着删。
- 唯一约束 `(message_id, reactor_kind, reactor_id, emoji)` 保证幂等(§3.3)。
- DTO 给 renderer 的是聚合 `{emoji, count, viewer_reacted}`(§3.5),`null` = 该消息无 reaction。

---

## 3. 核心设计判断

### 3.1 Reaction 不是消息(独立表,非 message metadata)
塞进 `messages.metadata`(JSON)会有并发写覆盖、无法按 reactor 唯一约束、无法索引的问题。
独立表让写入不碰 message 行,也是 §4 freshness 排除的天然前提。

### 3.2 Isomorphism — `reactor_kind + reactor_id` 两列合一(强制)
依据 `architecture-principles.md` §1 checklist #5:**禁止** `user_id` + `agent_id` 两列各占一边。
与 AttachmentService 的 `createdByKind/createdById`、messages 的 `from_kind/from_*` 一脉相承。
Service 入口接收 `Principal`,在 route boundary 构造,service 内不解析身份、不写
`if (kind==='agent')` 业务分支(checklist #1/#3)。差异(v1 预计没有)走 `POLICIES` 表而非散落分支。

> `SystemPrincipal`:系统消息不应主动 react;route 层拒绝 `reactor kind==='system'` 的请求。
> **另一向**(v1 禁止):被 react 的**目标**若是 system row 也禁止
> (`target.from_kind !== 'system'`)——否则要为 system-event 聚合设计单行 chip,把轻量 ack
> 拖成 system-event UI 重构。v1 只允许 human/agent message 被 react。

### 3.3 唯一性与幂等
`UNIQUE(message_id, reactor_kind, reactor_id, emoji)`:add 幂等(重复 react 同 emoji 不报错),
remove 幂等(不存在则 no-op)。CLI 重试、双击都安全。

### 3.4 toggle vs 显式 add/remove
采纳**显式** add / remove,不做服务端 toggle。toggle 在并发下语义不稳(两个 client 同时点会
互相抵消)。renderer 根据 `viewer_reacted` 决定这次点击发 add 还是 remove。

### 3.5 viewer 视角聚合
列表查询按 emoji 聚合成 `{emoji, count, viewer_reacted}`,`viewer_reacted` 依据当前 viewer 的
`Principal` 判断。**viewer 必须贯穿到查询层**:不能只在 row→DTO 映射里算,要从 route/service
把 viewer principal 传进查询。agent `read-history` 返回 reactions 时,"agent 视角的
`viewer_reacted`" = 该 agent 自己是否反应过——否则 public message list 与 agent history 的
语义会不一致。避免把全量 reactor 明细打进 DTO;明细按需另拉。

### 3.6 closed / archived conversation 拒绝写入
reaction 是写操作,必须和发消息一样拒绝 closed/archived 的 conversation——用**与发送消息同一
套准入语义**(main line 与 thread 两路都要挡,含 thread parent + thread 本身)。注意:仅看
membership 的可见性判断挡不住已 archived 但仍是成员的会话,准入必须覆盖 closed/archived 状态,
否则会出现"archived channel 不能发消息、却还能加 reaction"的漏洞。

---

## 4. Freshness 排除(CAS keystone)

**reaction 写入既不分配 conversation message seq、也不推进任何 stream 的 freshness head、也不动
read-cursor / observed-boundary。** 这是本 doc 最硬的不变量。

freshness = 按 stream 维度的 seq CAS("conversation advanced from seq N"),stream 分 `main`
(`thread_root_id IS NULL`)与 `cluster`/thread(`id=root OR thread_root_id=root`)——「channel +
thread」即这两条 stream,两者皆不可推。

理由比"clean"更硬:reaction 目的是**降噪**;一旦推进 stream head,会 (a) 让所有 in-flight 的
agent `message send` 因一个 emoji 变 `message_stale`,(b) 在 freshness/未读语义里冒充"新内容"
——降噪器反成噪音放大器。§3.1 独立表已天然不写 message 行;广播只走 event bus 自有 event kind
(§5.2),**绝不借推 stream head 蹭 replay/freshness 基建**。同族覆盖 §1"不进 unread/通知":
reaction 不进任何投递 / 唤醒 / freshness 通道。

**必须 test-lock**:断言 reaction add/remove 不改变 `messages.seq`、`conversations.latest_message_seq`、
`conversation_stream_heads.latest_seq`——防止后人误把 reaction 当 message event 接进 CAS。

---

## 5. 后端 API 与事件

### 5.1 路由(agent + human 同构,conversation-scoped)
Agent 路由与 human 路由 **对称**:两条都在 route boundary 解析出 `Principal`,调用**同一个**
service use-case(add / remove 一对),不各写一份逻辑。准入次序固定:解析 principal → 拒绝
reactor/target 为 system(§3.2)→ 校验 emoji(见下)→ 校验 principal 属于该 message 所在
conversation → 拒绝 closed/archived(§3.6)→ 落库 → 广播 event(post-commit effect)。写与读聚合
(§6)分属不同 use-case,不混在一起。

**emoji 校验(保守简单规则):** trim 后非空、无内部空白、字符长度 ≤ 16(不自己发明"码点 ≤ 8"——
ZWJ emoji 序列长度边界很烦,保守即可);仅允许 emoji 码点
(`\p{Extended_Pictographic}`/`\p{Emoji_Component}` 系列)。失败返回稳定错误码。

### 5.2 事件广播
经 event bus 发到 `conversation:<cid>` scope(thread 共享父 channel scope),event 携带
`message_id`、`emoji`、`op`、`reactor_kind/reactor_id`、`count`,并**必须带 `conversation_id +
thread_root_id`**——transport 走扁平 scope,但 renderer 靠 thread 上下文把 chip 更新路由到正确
surface(主线 vs thread pane)。

- **renderer 以 `count` 绝对赋值,不基于 `op` 做 +/-**:WS 有 replay buffer,renderer 也可能
  optimistic update,乱序/重放下 +/- 会漂移。收到 event 时把该 emoji 的 count set 成 payload 的
  `count`(`count==0` 则移除该 chip);`viewer_reacted` 仅在 `reactor_kind/reactor_id` 命中当前
  viewer 时按 `op` 翻转。`snapshot_required` 时直接 invalidate 相关 message queries,不靠 replay 补。
- **event 走 shared payload schema/type,不动 WS frame 的开放 kind 模型**:`EventFrame.kind` 保持
  开放 `string`,**不要**为此改成严格 union;新增一个 shared payload schema(仿 `TaskChangedEventSchema`)
  供 renderer parse。

---

## 6. 性能(列表查询的 N+1)
消息列表默认拉一窗口(~200 条)。**不要**每条消息单独查 reaction:对整窗 message id 做**一次**
按 emoji 的聚合查询 + 一次 viewer_reacted 判断,内存里 join 进各 DTO——单次窗口查询只补一次聚合
查询,O(1) 额外往返,而非 O(N)。该聚合是独立读 use-case,不散在 message 读路径里 ad-hoc 拼。也要能
服务 thread-pull(`history --target thread:`)读到的消息。

---

## 7. Prompt 规则(回应原始诉求)

平台 prompt 的 etiquette 段(与"Skip idle narration"相邻,按 `docs/platform-prompt-design.md`
的段骨架 + 测试纪律落位,不按行号塞):

> 当你只是确认收到/已读、或表达轻量认同,且无新增信息时,**优先用 `silverhand message react`
> 加一个 emoji,而不是发一条消息**。不要为了 ack 而刷消息流。反过来,不要对每次 merge / deploy /
> task done 自动堆庆祝表情——只在 reaction 本身就是有意义的确认信号时用。需要传达实质内容
> (结果、决定、阻塞)时仍发消息。

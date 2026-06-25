# Activity Lifecycle — Attention bounded context (v1)

Status: **design, in_review**（#task:1227；shiki go 2026-06-25「重看 activity 产生→消除整链是否第一性」）。
Owner: 脊柱(数据模型/生命周期/领域分层)=Alice · UI 表面节=Norman · 边界+answerability gate review=Cindy。
本 doc 是 #1227 的 canonical 规范;与代码冲突时以本 doc 为准直至代码修正。挂 `docs/architecture-principles.md`(人/agent 同构 + bounded-context)与 `docs/core-design.md`(统一语言)。底座复用 #1226 `docs/thread-unread-v1.md` 的 per-stream read cursor。

> **本 doc 不交付 UI 细节**(§13 是 Norman 的占位锚)、不交付实现代码(只定契约与边界,沿用 `docs/use-case-layer-p0-spec.md` 的三层 + Effect 三分类)。

---

## 1. 问题与定位

`#1226` 修了 thread 未读不可发现,但暴露一个更深的问题(shiki):**activity「产生 → 消除」整条链路是否第一性?** 今天 human 的「等我看/等我处理」散落在 sidebar badge + SSE + 各处 cache,没有一个一等公民的入口,也没有一个统一、可证的生命周期。

**定位 = 补全 Human/Agent 同构(`architecture-principles.md`)。** Agent 早已 inbox 驱动(durable inbox row + drainChain,host owns inbox drain);human 还没有对称的「有一个队列在等我」。Activity = 给 human 这个对称面。**这是补全,不是新增机制。**

**第一性原理结论(三 agent 独立同构,2026-06-25 收敛):Activity 不是一种新数据,是 per-(viewer) attention/read 状态的纯投影。** 能从底层 source 推导的,绝不再造一份带 `is_read`/`is_done` 的状态 —— 这正是 `#1226` 那个 bug(server-scored 事实塞进会漂的乐观 cache)在 feature 层的同一条铁律。

---

## 2. 不变量速查(canonical,本 doc 全部结论的索引)

1. **Activity = 读侧(CQRS)投影,非写侧聚合**(§4)。不拥有 read/unread/claim/salience 这类派生事实。
2. **claim = (事件, viewer) 的关系**,非对象上的列;按基数分 **positional ∪ directed**(§5.1)。
3. **delivery ⊥ attention**(§5.2):attention 只**读** delivery/follow 作输入,**绝不回写** delivery/wake/drain。
4. **消除 = source-routed `observe(source_ref, position)`**(§5.3):写委派回**源聚合**,绝不翻 `activity.read_at`。
5. **eligibility = 导出函数 `enter()`**(§6),非 case 清单。
6. **overlap 去重 = per-(viewer, message)**(§7):一条 message 对一 viewer 至多一个 claim,按最高 salience 呈现,一致消除。
7. **sidebar 与 Activity 同源同 `enter()`,projection-specific 聚合**(§8):sidebar 不减 directed、Activity ambient 减 directed。
8. **建表准入测试:「它是用户的决定,还是派生事实?」**(§4.2)决定→可落自有聚合;派生→只能投影。
9. **answerability 测试**(§5.3):每个 item 必须有一条 **eliminate route**,且 source_ref-in(产生)= source_ref-out(消除);**out 不一定叫 observe**(read-cleared→`observe`、task→状态迁移)。答不上 = 凭空状态。
10. **read ⊥ triage**(§11):v1 只 read(source-routed);triage(done/snooze/archive)是唯一可被 Activity 拥有的 durable state,**仅 v2**,且命名为 triage 不叫 read。

---

## 3. 统一语言(ubiquitous language)

一个概念一个名,内部词与用户词显式分层(`core-design.md` 纪律)。

| 概念 | 名 | 层 | 说明 |
|---|---|---|---|
| 限界上下文 | **Attention** | 内部 | 读侧 context:eligibility / salience / dedupe / observe |
| 用户表面 / feature | **Activity** | 用户可见 | shiki 拍的全局名;渲染出来那个列表永远叫 Activity |
| 一条「未观察 + 对我有意义」的注意力诉求 | **claim** | 内部 | (事件, viewer) 关系,不落库 |
| 进不进 Activity | **eligibility / `enter()`** | 内部 | §6 导出函数 |
| 多显眼 / 排序权重 | **salience** | 内部 | 派生不落字段(§5.2) |
| 消除原语 | **`observe(source_ref, position)`** | 内部 | §5.3 |
| 来源引用 | **source_ref** | 内部 | 标识产生该 claim 的源聚合 + 位置 |

**硬规:`Attention` / `eligibility` / `claim` / `salience` / `source_ref` 是内部语言,绝不上界面。** 用户只见 **Activity**(列表)+ channel 控件 `所有消息 / 仅提及` + thread `Follow / Unfollow`。(Slack 是命名参考,**非规范源**。)

---

## 4. 领域分层(DDD / CQRS — 本 doc 的核心)

shiki 提问:Activity 是不是一个独立 DDD 领域事件,有自己的读和消除 use case?**答:是 bounded context(有自己的 use case + 统一语言),但不是被产生并持久化的领域事件/聚合。**

### 4.1 写侧源聚合(source of truth)vs 读侧 Attention context

- **真正的 domain event 已经存在**,不新增:`MessagePosted`、`Mentioned`、`TaskAssigned/StatusChanged`、`CursorAdvanced`。
- **Attention 订阅它们做投影,不存自己的副本。** 若「所有行为产生一条 activity 记录(带自己的 read/done)」= ① 把已有事实复制一份(双写一致性负担)② 给每条 activity 独立 read 状态(与源漂移)= `#1226` 的 bug 升一层。

| 层 | 谁 | 拥有 |
|---|---|---|
| **写侧源 context** | Messaging / ConversationReads(per-stream cursor)· Notifications(`read_at`)· Tasks(`task_status` / `task_assignee_*`,存于 `messages`)· **新** ChannelAttentionPreference | **真实 read/决定状态** |
| **读侧 Attention context** | `application/` 读模型 + use cases | **零自有 read 状态**;只投影 + 编排 source-routed 写 |

### 4.2 建表准入测试(Norman 结晶,canonical)

**问:「它是用户的决定,还是派生事实?」**
- **决定**(用户主动选的新事实,本就该有 owned state)→ 可落自有聚合:v1 `ChannelAttentionPreference`(ambient 档)、v2 triage(done/snooze/archive)。
- **派生事实**(read / unread / claim / salience,可从源算)→ 永远 source-routed / 投影,绝不落自有 state。

`activity.read_at` 之所以错:它本是派生事实,却想被当决定存。

**限定词(bounded-context 归属):「决定」归拥有那个概念的 context,不是谁碰到归谁。** `follow` 是用户决定没错,但它是 **delivery 的决定**(归 delivery context / `thread_followers`),不是 attention 决定 —— 所以 attention 只**读** follow 当 `enter()` 默认输入、**绝不写**它。attention 只拥有 **attention 决定**(ambient pref / v2 triage)。

### 4.3 物化的合法例外

为性能可把投影**物化**成 denormalized read-model 表(避免每次 union 现算),但它必须是**可从源重建、由同一个失效信号对账的派生读模型**,不是有独立写路径的权威 aggregate。**物化 ≠ 拥有状态。** v1 不需要(单 SQLite / 单 workspace,投影便宜),见 §15 证伪点。

---

## 5. 生命周期三相

### 5.1 产生 —— claim = (事件, viewer)

事件在某 viewer 的流里制造一个「未观察 + 对他有意义」的 claim。claim 按**基数**天然分两类(非硬拼):

- **positional**(订阅流里的未读):一个 cursor 压缩掉 N 条。来源 = per-stream `conversation_reads` 游标 vs `conversation_stream_heads`(`#1226`)。逼它进 per-item 表反而丢掉 cursor 的压缩。
- **directed**(天生 per-event):@我 / task-needs-my-action / DM。

**源映射(v1):**

| claim | 类 | 背书(read-state 源) | eligibility |
|---|---|---|---|
| DM 未读 | positional | DM stream cursor | **永远进**(directed-grade) |
| followed thread 未读 | positional | thread stream cursor | ambientPref=on(follow→默认 on) |
| channel 主线未读 | positional | mainline stream cursor | 仅 channel ambientPref=`所有消息` |
| @我(human @-mention) | directed | `notifications.read_at` | **永远进** |
| task needs-my-action | directed | `messages.task_status` / `task_assignee_user_id` 投影 | **永远进** |
| agent_start_failed(我的 agent) | directed | `notifications.read_at` | **永远进** |

> **canonical TARGET = (a) notification-backed directed claim(Cindy contract review 锁,2026-06-25):** human **@我** 的 directed claim,read-state = `notifications.read_at`,由 **Notification context 记录 human-mention 行**(今天 `NotificationKind = {mention_external, mention_self, agent_start_failed}`、emission 偏 agent 向、v1 only emits `mention_external`,故须**扩 emission 到 human-mention**)。这是 **Notification context 的工作、计入 #1227 scope,不是 Attention 拥有状态**。
> **不选 (b)`extractMentions` 投影作 canonical:** 它会把 directed 退化成 positional-with-mention-salience,与 §7 overlap / directed 消除谓词不是同一模型;**(b) 最多作迁移期 fallback,绝不写成 target**。directed 与 positional 解耦更干净、salience 天生高 —— (a) 是第一性选择。

### 5.2 分级 / 呈现 —— delivery ⊥ attention

- **salience(权重/排序)是派生,不落字段**:从 (来源 kind + event kind + recency) 算(DM/mention/task 天生高、follow 中)。
- **delivery ⊥ attention(硬不变量)**:attention 可**读** `thread_followers` 当默认输入(followed→strong);**绝不回写** delivery/wake/drain。决定性反例:human 在 Activity 侧调偏好,绝不能改 agent wake。
- v1 唯一会**写** attention state 的用户表面 = channel `所有消息 / 仅提及` → 只写 `ChannelAttentionPreference`,绝不碰 `thread_followers`。thread `Follow/Unfollow` 写的是 **delivery**,被 `enter()` 读作默认 strong。

### 5.3 消除 —— source-routed `observe()`

充要条件 = **人真的看到了 / 真的处理了**(不是 app fetch、不是后台标签划过、不是定时器)。

**单一原语 `observe(viewer, source_ref, position)`**:所有清除 affordance(开 thread / visible-live mark / 从 Activity 跳源 / `Mark as read`)统统降解成对它一次调用,**别处一律不许碰 read 状态**。它的写**委派回源聚合**:

| source 类 | 消除语义 | observe 写回 |
|---|---|---|
| positional(stream unread) | **read-cleared**(observe) | advance 对应 stream cursor |
| directed mention / agent_fail | **read-cleared**(observe) | 置 `notifications.read_at` |
| directed task-needs-action | **resolve-cleared**(act,**非** read) | **不适用 observe** —— task 离开 Activity 由 `task_status` 状态迁移驱动 |

**关键carve-out(schema 推出的正确性点):task 不是「读了即出」。** 读一眼没认领的 task 绝不该清它;它的消除谓词 = `task_status` 不再 needs-my-action(resolve-to-clear)。所以 v1「读了即出」**只对 read-cleared 来源成立**;task item **不给 `Mark as read` 语义**(给了也是 no-op),它的消失锚在 tasks 状态。

**answerability 测试(机械可证,Cindy gate):** 每个 Activity item 必须有一条 **eliminate route**,且能说出 **source_ref-in**(由哪个源产生)= **source_ref-out**(消除时写回哪个源)。**out 不一定叫 `observe`**:read-cleared item 走 `observe(source_ref, position)`;resolve-cleared task item 走 **task 源聚合的状态迁移**(`task_status`)。答不上 source-in=source-out = 不是投影 = 凭空状态。两头一夹(out 自动对、in 强制必填),**孤儿 read/triage-state 不可能存在**。

---

## 6. eligibility = 导出函数 `enter()`(非 case 清单)

```
enter(item, me) = directed(item, me)  OR  ( ambient(item) AND ambientPref(stream) == on )
```

- **`directed`**(DM / @我 / task-needs-my-action / agent_start_failed)→ **永远进**,压过一切(不受 channel 开关管)。
- **`ambient`**(我订阅的流里、没直接点我的未读)→ **仅当该流 `ambientPref == on` 才进**。
- **`ambientPref` 默认**:followed thread → on(由 follow=delivery 读作 default-strong);channel → off(只有设成 `所有消息` 才 on);非 followed thread / `仅提及` channel → off → 不进 Activity,留就地提示(Threads list 弱 dot / channel 内)。

每加一个表面只填参数,不加特例。

---

## 7. overlap:positional ∩ directed(per-(viewer, message) 去重)

@我的一条 message **同时**是 positional-unread(在流里、cursor 背书)和 directed(notification)→ **两个 source_ref**。三条硬约束:

1. **去重粒度 = per-(viewer, message):** 一条 message 对一 viewer 在 Activity 里**至多一个 claim**,按**最高 salience** 呈现(@我那条显示成 mention + 上下文,不显示成 ambient 未读)。
2. **一致消除:** 读了它(positional cursor 越过该 seq)⇒ directed claim 也消;点 mention 跳源读到 ⇒ stream 侧也消。**directed 消除谓词 = `notifications.read_at` OR `cursor 已越过该 message` 的派生**,不是两个独立 read_at 各记各。`observe()` 单 source 模型显式延伸成「一个事件可路由到多 source_ref 且彼此派生」。
3. **结算粒度 = claim,不在 thread 粒度:** 同一 thread「@我@seq10 + 非提及 ambient seq11-15」是**两条不同 message 的两个 claim**(directed@10 + ambient@11-15),不是一个 thread 行的双重计数 —— 去重防的是同一 message 出现两次,不是压掉 thread 内不同消息的独立 claim。

---

## 8. 聚合精度:sidebar vs Activity(防 bug)

**两个表面回答两个不同问题 → 两套聚合,这是特性不是要对齐的 bug。**

- **sidebar badge** 答「这儿还有没有我没读的?」→ **原始 positional 计数**(含 @我那条,它仍是一条未读,**必须算进**;减了会出现「badge=0 但躺着一条没读的 mention」= 漏数,产品上错)。`channel_unread = 主线 + Σ followed-thread unread`(`#1226` §3.5)。
- **Activity ambient 行** 答「有哪些不同的事要我处理?」→ **`positional \ directed`**(@我@10 已作 directed item 呈现,ambient 计数减掉它,否则同 message 两处出现 = §7 去重在计数层破功)。

**同一 source(cursor read-model)+ 同一 `enter()`,projection-specific 聚合。** sidebar roll-up 其实已是这层投影的雏形 → #1227 是把它抽成**唯一 scorer 并泛化 scope+policy**,`enter()` 落地直接**替换** sidebar 那段口径、不留两份(否则两 scorer 漂移)。**绝不为「对齐」把 sidebar 也减 directed**(badge 会漏未读)。

**worked edge(两不变量同时成立):** 某 thread 唯一未读 = 一条 @我@10 → sidebar badge = **1**(确实有一条没读)、Activity = **1 条 directed 行 + ambient 行不存在**(`positional\directed = 0`,无双重计数)。那条事在 Activity 里只出现一次、同时 channel 仍被 badge 标记。两头都对。

---

## 9. 数据模型 / API 面

### 9.1 写侧聚合

- **不变**:`conversation_reads`(per-stream cursor,`#1226` v51)· `conversation_stream_heads` · `notifications`(`read_at`)· `messages`(task_*)。
- **唯一新增写侧聚合 = `ChannelAttentionPreference`**(per viewer × channel 的 ambient 档:`所有消息 / 仅提及`)。它是 `enter()` 的 policy 输入,**不是 activity item、不被消除**。是「决定」→ 合法自有表(§4.2)。新增 migration(append-only)。

### 9.2 读侧:Attention context(`application/` + read-model)

沿用 `docs/use-case-layer-p0-spec.md` 三层。Attention 零自有 read 存储,只投影 + 编排:

- **`listActivity(viewer, scope)`** — query use case。union(positional unread via cursor read-model ∩ `enter()`)+(directed via notifications/tasks 投影),per-(viewer,message) 去重(§7),salience 排序(§5.2)。返回纯 DTO。
- **`observe(viewer, source_ref, position)`** — 消除 use case。source-routed(§5.3):stream→advance cursor、mention/agent_fail→置 `notifications.read_at`。task 不走它(resolve-cleared)。
- **`setChannelAttentionPref(viewer, channel, mode)`** — 写 `ChannelAttentionPreference`,**只此一处**写 attention state。

### 9.3 endpoint(具名,实现期定路径)

- `GET /api/activity?scope=…` → `ListActivityDto`(items[] + 分页 + salience 序)。
- `POST …/observe`(或复用既有 `mark-read` / notification read 路由,由 `observe()` 收口)—— **不新建 `activity.read` 写表**。
- `PUT …/channel-attention-pref`。

> CLI 若涉及(`packages/cli` 暂无 activity 命令)须同步 `docs/cli-system.md` + 平台 prompt(CLAUDE.md 纪律)。v1 预计纯 renderer↔backend,无 agent CLI 面。

---

## 10. 失效 / 对账信号

- **positional**:只由 viewer-scoped **`unread_updated`** 失效(复用 `#1226`)。
- **directed**:由 notification / task 相关事件失效。
- **message event** 可更新 reply_count / repliers 这类**可乐观维护**的事实,**绝不直接改 Activity unread**(§1 铁律)。
- 客户端**不靠 message event 猜 unread**、不扫一堆 conversation cache 拼全局 Activity:读 `listActivity` 这一处 server-scored 投影。

---

## 11. v1 / v2 边界

- **v1 = read,全程 source-routed**(§5.3)。清除模型 = **读了即出**(仅 read-cleared 来源;task 例外 = resolve-cleared)。两条清除路径都只写已有两套状态(stream cursor / `notifications.read_at`),**不引第三套**:① 跳源读到 → observe 推进;② 轻量 `Mark as read`(check icon)→ 同一 observe。
- **`Done / Snooze / Archive` = triage**,是另一根轴:**triage ⊥ read** —— triage 答「我处理完了吗」、read 答「我看过了吗」。正因正交,引入 triage 不替代、不影射 read state,read 侧 answerability 照样成立。**triage 是 Activity 唯一能拥有的 durable state,且仅 v2**,引入时明确命名 triage 不叫 read。
- **v1/v2 边界标记(防回退):** v2 做 triage 时,绝不能顺手实现成「activity 自己的 `read_at`」—— 那会把派生事实当决定存,直接打回 `#1226`。

---

## 12. 时序 / 迁移(与 #1226 的桥)

1. **doc 定 target(本 doc)→ Cindy review 过。**
2. **additive 实现(可在 doc 过后即起,不碰 `#1226`):** `ChannelAttentionPreference` 表(migration)+ **Notification context 补 human-mention emission(§5.1 (a),directed @我 背书)** + `listActivity` 读模型 + `setChannelAttentionPref` + endpoint。镜像 `#1226` step-1 的纯加性模式,各步 tree-green。
3. **`observe()` 坍缩(硬时序约束):** 把现有两条 mark-read 写路径(open-time snapshot + visible-live,在 Norman 的 `ThreadPanel.tsx`)收敛成单一 `observe()`。这一步**动 `#1226` 的 mark-read**,故 **必须等 `#1226` dogfood 过 + 关 task 才做**(in_review 期绝不碰)。届时 `snapshot_seq` 客户端回传大概率冗余可删(visible-live 已上报真实 observed seq);涉 DTO/CLI 同步 `docs/cli-system.md`。**这一步即 `#1226 → #1227` 的桥。**

---

## 13. UI 表面节(Norman owns)

### 13.0 原则

所有 UI 表面都是**同一 scorer 的投影**(§8、§9.2);UI **从不写 read/triage 状态**——每个清除 affordance 都降解成 §5.3 的 eliminate route(read-cleared→`observe()` / task→`task_status`)。表面只「呈现投影 + 把观察/决定路由回源」,无自有状态(§4.2)。

### 13.1 呈现表面(read projections — 在哪看见)

三个呈现表面,都是 `listActivity` / scorer 的投影,聚合各异(精度见 §8,**不在此重述**):

- **Sidebar channel badge** — 原始 positional roll-up(§8);`#1226` 已落、是 Activity 投影雏形,#1227 **泛化它、不平行新建**。
- **就地提示**(channel 流内 reply chip「N new」/ Threads list dot·sticker + 跳首未读)— `#1226` 已落。它是 **source-local locator,对所有 thread unread 都提供源内定位**(含会进 Activity 的 followed-thread unread);**对不进 Activity 的 ambient(§6:非 followed thread / `仅提及` channel)它是唯一提示面**——留原地、不进全局列表(firehose 防线)。
- **全局 Activity 列表** — v1 新表面(13.2)。

### 13.2 全局 Activity 列表(v1)

- **入口**:sidebar、Search 之上(shiki)。v1 UI per-workspace(数据模型全局、`workspace_id` 作 filter)。
- **收**:`enter() == true`(§6)= DM · @我(notification-backed directed,§5.1a)· task-needs-action · followed-thread ambient · `所有消息` channel 的 ambient。
- **每条 item**:源 icon + 来源标识(哪个 channel/thread)+ 预览 + 相对时间;**salience 分级**(§5.2)directed 视觉强于 ambient;**per-(viewer, message) 去重、取最高 salience**(§7)→ @我显示成 mention + 上下文、**不再**显示成 ambient 未读。
- **排序(v1 从简)**:directed 档置顶、档内 most-recent-first。
- **清除 = read-driven,降解为 §5.3 eliminate route**:
  - **read-cleared item(message / @我 mention)**:打开 / 跳源 → `observe`(推 cursor / 置 `notifications.read_at`);**`Mark as read`** = **hover 才显的 check icon、非常驻「Done」按钮**(常驻 + 「Done」字样会把 triage 心智带回)→ 同一 `observe`;**扫一眼 / hover ≠ 读**(不推 cursor,解「扫一眼就没」)。
  - **resolve-cleared task item(§5.3 carve-out)**:**不给 `Mark as read`**(无 read 语义、给了也 no-op);**打开 = 跳到 task 源但不清**;离开 Activity 锚在 `task_status` resolve。UI 主操作 = 「去处理 / 认领」,不是「标已读」。
  - **firehose 兜底**:列表顶「全部标已读」**= 对 read-cleared items 的批量 source-routed `observe(source_ref, position)`**(逐个/批量等价),**绝不新增 `activity.bulk_read_at` 或任何 Activity 自有状态**;task item 继续排除(无 read 语义)。
  - 列表**绝不直接写 read/triage 状态**——answerability 在 UI 侧的兑现(§5.3 / §14)。
- **空态**:caught-up。**v1 无 Done / Snooze / Archive**(triage = v2,§11)。

### 13.3 控件表面(write controls — 在哪设置)

- **channel `所有消息 / 仅提及`** = **v1 唯一会写 attention state 的表面** → 只写 `ChannelAttentionPreference`(§9.1)。`所有消息` = ambient on、`仅提及` = ambient off(但 @我 · task 经 directed **永远进**、不受此开关管,§6)。内部模型 = 一个 ambient on/off,用户措辞 = 所有消息 / 仅提及(弃用内部词)。位置:channel header 菜单 / 设置。**`静音` / Mute = v2**(§15)。
- **thread `Follow / Unfollow`** = 写 **delivery**(§5.2),**非 attention**;进不进 Activity 由 follow 派生。v1 二态(镜像 Slack)。**不做**「从 Activity 隐藏」第二控件(attention-only override = v2)。
- **边界**:attention-write 表面 = channel pref only;follow = delivery-write;**互不写对方**(§5.2 硬不变量)。

### 13.4 观察保真度(read-cleared 的「真看到了」)

第一性清除信号 = 人真看到 = per-item 可见。v1 用代理、且**显式声明为近似**(非悄悄糊弄):

- thread 开窗 → open-time stream head(粗:开 = 读了整条打开的 thread);pinned-at-tail + document 可见 → live 标 max-visible(细)。(`#1226` 已落)
- **v1.1**:per-item `IntersectionObserver` 精确标真正进入视口的 max-visible,替换 pinned-tail 代理。

代理只影响「标到哪个 seq」的精度,不影响正确性(forward-only + success-gated,§5.3)。task 不涉(resolve-cleared 与可见无关)。

### 13.5 命名 / 对外用词(§3)

- **对外只露**:**Activity** · **所有消息 / 仅提及** · **Follow / Unfollow** · **Mark as read**(read-driven,**不叫 Done**)。
- **内部、绝不上界面**:Attention · eligibility / `enter()` · salience · claim · `observe` / source_ref · `ChannelAttentionPreference`。

### 13.6 实现序(见 §12)

不重述时序:additive(列表读 `listActivity` + channel pref 控件)doc 过后可起;客户端 **`observe()` 坍缩 `ThreadPanel.tsx` 两条 mark-read = 我 lane**,**必须等 `#1226` dogfood 过 + 关 task**(§12 step-3)。

---

## 14. 验收 / answerability gate(Cindy review 锚)

Cindy 的 5 条硬标准 = 本 doc 的逐条验收:
1. Attention 是读侧 bounded context / projection,不拥有 read/unread/claim/salience(§4)。
2. Attention 只拥有 attention 决定:v1 `ChannelAttentionPreference`;follow 仍是 delivery 决定,只读不写(§4.2、§5.2)。
3. 每个 item 通过 answerability:有一条 eliminate route,source_ref-in = source_ref-out;**out 不一定叫 observe**(read-cleared→`observe(source_ref,position)` / task→`task_status` 状态迁移);overlap 按 per-(viewer,message) 去重(§5.3、§7)。
4. `observe()` 必须 source-routed,不写 `activity.read_at`(§5.3)。
5. sidebar 与 Activity 同源同 `enter()`,projection-specific 聚合(§8)。

**已拍(Cindy contract review,2026-06-25):** human **@我** directed claim = **(a) notification-backed,canonical TARGET** —— Notification context 补 human-mention 行(read-state=`notifications.read_at`),新增 emission **计入 #1227 scope**(§5.1、§12 step-2);(b) `extractMentions` 投影仅迁移期 fallback、非 canonical。

---

## 15. Out of scope / 证伪点

- **v2:** triage(done/snooze/archive)、channel 第三档 `静音`(应做成更宽的 conversation presentation / notification suppression,不为 Activity 强塞第三档 eligibility)、per-item `IntersectionObserver` 保真度。
- **证伪点(诚实标注):** 唯一会推翻「投影优先」的是 **fan-out 规模** —— 若哪天要给海量 viewer 预算 feed、实时投影算不动,才考虑 materialize per-user feed 并吃那个一致性代价。现在单 SQLite / 单 workspace,投影便宜,**不付这个代价**。规模到了再 revisit(届时仍按 §4.3:物化为可重建读模型,非权威 aggregate)。
- **Slack 是命名/形态参考,不是规范源。**

---

## 16. Pointers

- 人/agent 同构 + bounded-context:`docs/architecture-principles.md`。
- 统一语言 / 领域模型:`docs/core-design.md`。
- 应用层三层 + Effect 三分类:`docs/use-case-layer-p0-spec.md`。
- 底座 per-stream cursor + 未读读模型:`docs/thread-unread-v1.md`(`#1226`)。
- 设计讨论流水 / 历史决策:`.silverhand/agents/Z18wRZX6Uhsoa2tw/notes/inbox-design.md`。

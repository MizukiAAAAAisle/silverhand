# Activity Lifecycle — Attention bounded context (v1)

Status: **design, in_review**（#task:1227；shiki go 2026-06-25「重看 activity 产生→消除整链是否第一性」）。
Owner: 脊柱(数据模型/生命周期/领域分层)=Alice · UI 表面节=Norman · 边界+answerability gate review=Cindy。
本 doc 是 #1227 的 canonical 规范;与代码冲突时以本 doc 为准直至代码修正。挂 `docs/architecture-principles.md`(人/agent 同构 + bounded-context)与 `docs/core-design.md`(统一语言)。底座复用 #1226 `docs/thread-unread-v1.md` 的 per-stream read cursor。

> **本 doc 不交付 UI 细节**(§13 是 Norman 的占位锚)、不交付实现代码(只定契约与边界,沿用 `docs/use-case-layer-p0-spec.md` 的三层 + Effect 三分类)。

---

## 1. 问题与定位

`#1226` 修了 thread 未读不可发现,但暴露一个更深的问题(shiki):**activity「产生 → 消除」整条链路是否第一性?** 今天 human 的「等我看/等我处理」散落在 sidebar badge + event WebSocket + 各处 cache,没有一个一等公民的入口,也没有一个统一、可证的生命周期。

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
9. **answerability 测试**(§5.3):每个 item 必须有一条 **eliminate route**,且 source_ref-in(产生)= source_ref-out(消除);v1 所有 item 都 read-cleared → 统一走 `observe()`(委派 cursor / `notifications.read_at`)。答不上 = 凭空状态。
10. **read ⊥ triage**(§11):v1 只 read(source-routed);triage(done/snooze/archive)是唯一可被 Activity 拥有的 durable state,**仅 v2**,且命名为 triage 不叫 read。
11. **surfaced ≠ eliminated**(§5.3.1):anchored directed claim(`mention_self`)的 `read_at` 只能由 **active eliminate intent** 写,**绝不由 passive surface(toast render/auto-hide、conversation focus)写**。passive 写 = 凭空消除(#task:1243 根因)。
12. **Activity section 右侧 = 复用 chat 的完整 `ChannelView`/`ThreadPanel`,不复制**(§13.7,#1394):Activity 是 NavRail 顶层 rail(非 chat-sidebar 快捷版);唯一 selection SoT = `(workspace, channel, optional thread)`,workspace 从 conversation 派生。「无条件自动同步」= 单一组件权威的结构保证;需在 Activity 单独补一遍某能力 = 结构没改对。
13. **三档 = 一个 badge 的三级响度,不是三种 eligibility**(§6/§8,#task:1870):`所有消息 / 仅提及 / 静音` 只调 workspace badge 里 ambient 项的权重,`enter()` 的 ambient 判据仍是二值(effective 档 == `所有消息`),directed 永远压过一切。**workspace `静音` 是档位之上的独立 boolean 抑制器**,只在读时折叠成 `effective_mode`,**绝不回写各 channel 的 stored 档** —— 取消静音因此无损、上线无 backfill。
14. **badge 是 membership-scoped 投影 ⇒ 成员边是它的第四类变更源**(§8/§10,#task:1870):响度变化由三个推送型事件带绝对值送达,**成员边变化不发 badge 帧**,由客户端在既有领域事实(`workspace_channels_changed` / `viewer_workspaces_changed` / `snapshot_required`)上重取。客户端**不会随时间、也不会因 window focus 主动重取**这份 badge(全局 `staleTime: 5s` 只在挂载 / 失效时参与新鲜度判定,`refetchOnWindowFocus: false`,且这是一个 App 生命周期内常驻的 query),所以**漏一类 = 一直错到 remount / 重连 / 另一个失效触发器**,不是短暂不同步。

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
| channel 自己存的档 | **stored (mode)** | 内部 | `getStoredMode` / `storedChannelModeExpr`;per-channel 控件的读面 |
| 折叠 workspace 抑制器之后的档 | **effective (mode)** | 内部 | `effective_mode` / `effectiveChannelModeExpr` / `resolveEffectiveAttentionMode`;**`effective` 在本 context 只有这一个意思**(#task:1870) |
| workspace 级抑制器 | **suppressor** | 内部 | per-(viewer, workspace) boolean,压过该 workspace 全部 stored 档,不改写它们 |
| workspace 的分档加权计数 | **badge** | 内部 | 分档加权计数(§8),与 sidebar 的 raw positional 未读是两个口径。**#task:1939 起它不再显示在 workspace 行上**,只作折叠态(枝 / 整组)的唤醒门(§8 末「呈现」) |

**硬规:`Attention` / `eligibility` / `claim` / `salience` / `source_ref` 是内部语言,绝不上界面。** 用户只见 **Activity**(列表)+ channel 控件 `所有消息 / 仅提及 / 静音` + workspace `静音` + thread `Follow / Unfollow`。(Slack 是命名参考,**非规范源**。)

---

## 4. 领域分层(DDD / CQRS — 本 doc 的核心)

shiki 提问:Activity 是不是一个独立 DDD 领域事件,有自己的读和消除 use case?**答:是 bounded context(有自己的 use case + 统一语言),但不是被产生并持久化的领域事件/聚合。**

### 4.1 写侧源聚合(source of truth)vs 读侧 Attention context

- **真正的 domain event 已经存在**,不新增:`MessagePosted`、`Mentioned`、`TaskAssigned/StatusChanged`、`CursorAdvanced`。
- **Attention 订阅它们做投影,不存自己的副本。** 若「所有行为产生一条 activity 记录(带自己的 read/done)」= ① 把已有事实复制一份(双写一致性负担)② 给每条 activity 独立 read 状态(与源漂移)= `#1226` 的 bug 升一层。

| 层 | 谁 | 拥有 |
|---|---|---|
| **写侧源 context** | Messaging / ConversationReads(per-stream cursor)· Notifications(`read_at`)· Tasks(`task_status` / `task_assignee_*`,存于 `messages`)· **新** ChannelAttentionPreference + WorkspaceAttentionPreference | **真实 read/决定状态** |
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
- **directed**(天生 per-event):@我 / DM(task-needs-my-action = **v2**,见 §5.1 表后 carve-out)。

**源映射(v1):**

| claim | 类 | 背书(read-state 源) | eligibility |
|---|---|---|---|
| DM 未读 | positional | DM stream cursor | **永远进**(directed-grade) |
| followed thread 未读 | positional | thread stream cursor | `followed` AND 父 channel ambientPref==on(aggregate-floor,#task:1268) |
| channel 主线未读 | positional | mainline stream cursor | channel ambientPref=`所有消息`(默认即 `所有消息`,#task:1248) |
| @我(human @-mention) | directed | `notifications.read_at` | **永远进** |
| ~~task needs-my-action~~ | directed | — | **v2 — NOT a v1 Activity source**(见下) |
| agent_start_failed(我的 agent) | directed | `notifications.read_at` | **永远进** |

> **canonical TARGET = (a) notification-backed directed claim(Cindy contract review 锁,2026-06-25;emission 前提经现读源码修正 2026-06-25):** human **@我** 的 directed claim,read-state = `notifications.read_at`,源 = **既有的 `mention_self` notification**。**修正:** `mention_self` 今天已**无条件**为「会话成员被 @」而发(`conversation-message-service.ts` `notifyViewerMentionBestEffort`,每次 send 调用;含 reply-cluster——thread reply 落父 channel 会话,notification 的 `thread_root_id` 由 repo `LEFT JOIN messages` 派生,故 source ref 仍指向正确 thread)。所以原「v1 only emits `mention_external`、须扩 emission」是**过期前提**:#1227 **不新增 emission,只消费并锁定** `mention_self` 这个契约(characterization test 守 thread-reply @我 → `mention_self`、`conversation_id/message_id/source_*/thread_root_id` 正确、`read_at` NULL)。这是 **Attention 读侧消费 Notification context 既有事实,不是 Attention 拥有状态**。
> **不选 (b)`extractMentions` 投影作 canonical:** 它会把 directed 退化成 positional-with-mention-salience,与 §7 overlap / directed 消除谓词不是同一模型;**(b) 最多作迁移期 fallback / 防御,绝不写成 target**。directed 与 positional 解耦更干净、salience 天生高 —— (a) 是第一性选择。
>
> **task 不是 v1 Activity 源 —— 已从 v1 移除,降级为 v2(shiki 拍 2026-06-26)。** 曾经的 v1 谓词是「viewer 是 task 所在会话成员 且 (`assignee=viewer AND status∈todo/in_progress`) 或 (`status=in_review`)」。问题:它从 `task_status` 这个 **standing state** 投影,产出一个**只能由状态迁移清除、不能被观察清除**的常驻 item —— Activity 里**唯一**的 resolve-cleared 异类,等于把 task panel 的 In-review 列**镜像**进注意力队列,成了第二个 task panel。**根因 = eligibility 太泛 + 形态错(库存镜像而非事件)**,不是 chip 位置。而对 human viewer,(i) 支基本是死的(task 由 agent 认领,`task_assignee_user_id` 对 human 恒空),所以这条 kind 几乎 100% 来自 (ii) 的成员近似 —— 砍掉零 directed-claim 损失。
>
> **v1 收口:Activity 只收 read-cleared / notification / unread 这类可消除的 attention event;task 的库存与状态回 task panel**(task panel 的 nav count 角标承载「N 个待我复审」的 at-a-glance 信号)。task 相关消息若本身 @我 / 是 unread,仍经 mention/unread 路径进 Activity。
>
> **v2 re-entry 条件(终局,要进必须满足):task 以 *事件* 而非 *库存* 形态回归 —— 一条 notification-backed `task_needs_review(viewer)`(建模 reviewer 关系后定向到真正的 reviewer),read-cleared like a mention(`notifications.read_at`),且 task 离开 in_review 时派生消失(读模型只在 `status='in_review'` 时投影)。** 它走 notification 路径(本就 fan 到 `viewer:<id>`),**不**复活 `task_changed` 的 viewer-fan。守此收口的 characterization test 见 `backend/tests/routes/activity.test.ts`(task-bearing message 不产 `kind=task`、仍可经 unread 进)+ `backend/tests/routes/tasks.test.ts`(`task_changed` 不再 fan 到 viewer scope)。

### 5.2 分级 / 呈现 —— delivery ⊥ attention

- **salience(权重/排序)是派生,不落字段**:从 (来源 kind + event kind + recency) 算(DM/mention 天生高、follow 中)。
- **delivery ⊥ attention(硬不变量)**:attention 可**读** `thread_followers` 当 ambient 的 `subscribed` 预置(**necessary not sufficient**——followed 只是 thread ambient 进 Activity 的前置,ambient 还需父 channel pref==`all`,§6 aggregate-floor);**绝不回写** delivery/wake/drain。决定性反例:human 在 Activity 侧调偏好,绝不能改 agent wake。
- v1 会**写** attention state 的用户表面 = channel 三档 `所有消息 / 仅提及 / 静音` → 写 `ChannelAttentionPreference`,与 workspace `静音` → 写 `WorkspaceAttentionPreference`(#task:1870);两者都绝不碰 `thread_followers`。thread `Follow/Unfollow` 写的是 **delivery**,被 `enter()` 读作 ambient 的 `subscribed` 预置(necessary not sufficient;不单独决定 Activity)。
- **`静音` 不是 eligibility 开关(#task:1870)**:它把 channel 调到最低响度,但**不切断定向残余** —— 静音 channel 里 @我那条仍进 Activity、仍计入 workspace badge。**静音了 channel 的人,没有静音那个点名你的人。** 同理,human 侧任何档位组合(channel `静音` ∧ workspace `静音`)都**不影响 agent 的投递与唤醒**——这是本节硬不变量的最强形态,回归见 `backend/tests/routes/attention-badge.test.ts`「delivery ⊥ attention (§5.2)」。

### 5.3 消除 —— source-routed `observe()`

充要条件 = **人真的看到了 / 真的处理了**(不是 app fetch、不是后台标签划过、不是定时器)。

**单一原语 `observe(viewer, source_ref, position)`**:所有清除 affordance(开 thread / visible-live mark / 从 Activity 跳源 / `Mark as read`)统统降解成对它一次调用,**别处一律不许碰 read 状态**。它的写**委派回源聚合**:

| source 类 | 消除语义 | observe 写回 |
|---|---|---|
| positional(stream unread) | **read-cleared**(observe) | advance 对应 stream cursor |
| directed mention / agent_fail | **read-cleared**(observe) | 置 `notifications.read_at` |
| (v2) `task_needs_review` notification | **read-cleared**(observe,like mention) | 置 `notifications.read_at`;task 离开 in_review 仅作**派生消失**条件、**非** eliminate route |

**关键carve-out(schema 推出的正确性点;也是 v1 砍掉 task 的根据):task 不是「读了即出」。** 读一眼没认领的 task 绝不该清它;它的消除谓词 = `task_status` 不再 needs-my-action(resolve-to-clear)。这正是把 task 当 *库存镜像* 投进 Activity 会变成**永久常驻**的原因(Activity 其它 kind 都 read-cleared、它独是 resolve-cleared)——**故 v1 把 task 整个移出 Activity**(§5.1 carve-out),库存交回 task panel。**v2 若要回归,必须改成 read-cleared 的事件**(notification-backed `task_needs_review`,§5.1),而非给库存 item 强加 `Mark as read`(那是 no-op)。

**answerability 测试(机械可证,Cindy gate):** 每个 Activity item 必须有一条 **eliminate route**,且能说出 **source_ref-in**(由哪个源产生)= **source_ref-out**(消除时写回哪个源)。**v1(及 planned v2)所有 Activity item 都 read-cleared → 统一走单一原语 `observe(source_ref, position)`**(它委派到 stream cursor 或 `notifications.read_at`)。**没有 resolve-cleared 的 Activity item** —— resolve-cleared 属 task **库存**(在 task panel,不是 Activity item);v2 的 `task_needs_review` 是 read-cleared 事件,走 `notifications.read_at`,`task_status` 只作派生消失条件、非 eliminate route。答不上 source-in=source-out = 不是投影 = 凭空状态。两头一夹(out 自动对、in 强制必填),**孤儿 read/triage-state 不可能存在**。

### 5.3.1 surfaced ≠ eliminated(passive surface 禁写 directed `read_at`)

§5.3 的「人真的看到了」必须细化成**可守的实现红线**,否则 directed item 会被 UI 层「弹出来 / 在看这个会话」当成「已处理」凭空清掉(#task:1243 根因:`mention_self` notification 创建后毫秒级被 toast auto-read by-id 写 `read_at`,cursor 还停在该 seq 之前 → Activity 空但 badge 仍亮)。

**判别线 = 对「那条 directed claim」有显式 ack 或对其 source 真 visible-read,而非 app 层「弹了 / 正打开这个会话」。** 据此 anchored directed claim(`mention_self`)的 `read_at` 写者分两类:

- **active eliminate intent(允许写):**
  1. 可见读源 —— `observe(stream→N)` 的 positional 越过该 message seq(§7 overlap 同事务清 `seq<=N` 的 `mention_self`);
  2. 点 notification / Activity chip 跳到源并读到;
  3. Activity 行 hover-✓ by notification id;
  4. `Mark all as read`;
  5. 通知面板里对该条显式「标已读」。
- **passive surface(禁止写):** toast render、toast auto-hide/dismiss、conversation focus（仅打开/聚焦会话本身）。这些是「让你看见」的载体,不是「你已处理」的证据 —— 它们**一律不得**触碰 directed `read_at`。

**carve-out(勿过度收窄成「只有 observe 能写 read_at」):** `read_at` 合法有**两个**写者 —— observe overlap(positional 派生)与 notification surface 的**显式** mark-read(active intent #2/#3/#4/#5);锁的对象是 **passive caller**,不是后端路由本身。故 backend `POST /api/notifications/read{conversation_id}` **不变**(它服务「显式标整会话已读」= active,合法);要拆的是 renderer 里那些 passive 触发点对它的调用。

**anchorless 特例:** `agent_start_failed` 无 seq、observe 的 positional overlap 永远碰不到它(§7),故它的唯一 active eliminate 口 = Activity hover-✓ by id / 显式点击。摘掉 passive 写者后必须确认这条仍有覆盖路径(进回归),否则它会变成不可消除的常驻项。

**guard(Cindy 回归,4 条):** ①toast render 不发任何 read POST;②conversation focus 不写「cursor 尚未越过的 anchored mention」的 `read_at`(focus = passive,对 anchored mention 与 anchorless `agent_start_failed` 一视同仁都不写);③该 `mention_self` 在仅被 surface(弹过 toast / focus 过会话)后仍在 Activity;④`agent_start_failed` 经 hover-✓ / 显式点击确实被清除。

---

## 6. eligibility = 导出函数 `enter()`(非 case 清单)

```
enter(item, me) = directed(item, me)  OR  ( ambient(item) AND subscribed(item, me) AND ambientPref(parentChannel) == on )
```

- **`directed`**(DM / @我 / agent_start_failed;task-needs-my-action = **v2**,§5.1)→ **永远进**,压过一切(不受 channel 开关管)。
- **`ambient`**(我订阅的流里、没直接点我的未读)→ **仅当 `subscribed(item, me)` AND 该聚合 `ambientPref == on` 才进**。
- **`subscribed`**(delivery 预置):channel 主线 = 我是成员;thread = 我 `followed` 该 cluster;非 followed thread → 不进(留就地提示:Threads list 弱 dot / channel 内)。
- **`ambientPref` = channel-like 聚合的地板(aggregate-floor,#task:1268):** channel 主线**与其下所有 thread 共享父 channel 的** `ChannelAttentionPreference`。channel → on(默认 `所有消息`;#task:1248 起,旧默认 `仅提及`/off),用户显式设 `仅提及` 才 off。**关键:followed thread 的 ambient 不再由 follow 单方顶成 on——它需 `followed` AND 父 channel pref==on。** follow 是 **delivery 决定**,绝不在 Activity 这个 attention 表面反向覆盖用户显式的 attention 决定(`仅提及`)(§5.2 `delivery ⊥ attention`);follow 仍管 delivery(你照样收/可 pull 该 thread),只是不再强行进 Activity ambient。thread 里 @我经 directed 路径进,`仅提及` channel 里仍亮。**默认值在读时算、不落库**:无显式 `ChannelAttentionPreference` row 的 channel/其 thread 一律取 `所有消息`,无需 migration、无需给存量用户写 row。
- **三档接入不改这个函数的形状(#task:1870):** `ambientPref(parentChannel) == on` 精确读作 **`effective_mode(parentChannel, viewer) == 所有消息`**,其中 `effective_mode = workspace 抑制器 ? 静音 : stored_mode`。`仅提及` 与 `静音` 在 `enter()` 眼里**同为 off** —— 它们的区别只在 badge 的响度(§8),不在能不能进 Activity。这正是「三档 = 三级响度、不是三种 eligibility」的机械形态:**新增一档只改权重表,永远不给 `enter()` 加分支。**

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

**第三个面:workspace badge(#task:1870)。** channel 三档上线后,这个计数答的是第三个问题 ——「这个 workspace 里有多少件**按我设的响度**该吵我的事?」(**#task:1939 起它不再显示给眼睛、只答给唤醒门**,见本节末「呈现」):

```
badge(workspace, viewer) = Σ_{effective==所有消息} raw positional unread
                         + Σ_{effective∈{仅提及,静音}} effective directed claim
```

- **两项按 effective 档**分区,故 loud channel 里的 @我**只算一次**(它已在第一项的 raw 计数里,第二项只覆盖第一项跳过的会话)。
- **第二项的计数单位是「有效定向诉求」,不是 notification 行**。一条 `mention_self` 行本身不是一个诉求;诉求 = 四个合取项:未读 `mention_self` **∧** 有锚(所指 message 仍存在)**∧** 锚的 `seq` 高于 viewer 在**该 message 自己那条流**上的 cursor(§7.2 的「cursor 越过 ⇒ directed 也消」,`read_at` 不是第二权威)**∧** **per-message 至多一个**(同一 message 的多条 notification 行是一个诉求)。数行会让「badge 亮着但 Activity 空」和「一条 mention 值 2」都可达 —— 那是同一个问题被两张脸各答一半。
  **故它只定义一次**:`backend/src/repos/directed-claim-predicate.ts`。**Activity 列表 / workspace badge / per-channel `directed_unread_count` 三张脸原样内插它**,第四个合取项按脸形状表达(计数脸 `COUNT(DISTINCT n.message_id)`、建项脸按 `message_id` 键 Map),但**键必须相同**。谁复制半条规则,谁就制造一个数字不同的第二权威。
- **静音仍留定向残余**(第二项包含 `静音`):§5.2 的「静音 channel 不等于静音那个人」在算术上的形态。
- `mention_external` 与无锚的 `agent_start_failed` **不进** badge —— 前者不是本 workspace 的定向诉求,后者无 seq、其消除口另在 §5.3.1。两者都落在上面那条谓词之外**是构造性的**,不靠 badge 侧再补一句排除。
- **fail-closed 靠共享片段继承**:两项都套 `ROLLUP_UNREAD` / `liveConversationPredicate`,不各自重述 liveness,所以归档、退群不可能从任一项漏出去。
- **两项都以 membership 为定义域**(都 `JOIN conversation_users`):故 badge 有**两类**自变量 —— 响度(档位)与**成员边**。后者是第四类变更源,见 §10。
- **原始 positional 口径一个字不改**(sidebar badge、`unread_updated.workspace_unread_count`、`FavoriteRowDto.unread_count`):badge 是**同一 membership 的第二张脸**,不是替换。这也是为什么它走**自己的** `attention_badge_updated` 事件而不去重定义 `unread_updated`(§10)。

**呈现:容器不显示这个数字(#task:1939,shiki 2026-08-09 裁定;组级 2026-08-10 同裁)。** 上面那条算术不变,变的是它出不出现在 workspace 行上。

- **为什么**:badge 的定义域是 viewer 在该 workspace 的**全部成员 channel**,而 conversation star 是**独占显示**(`docs/list-sort-v1.md`)—— 被 star 的 channel 从 workspace 枝里移出、只在全局 STARRED 渲染。于是容器上的数字可以**指不到自己的 children**:折叠显示 `3`,展开却在这一枝里找不到那 `3`。这是**指向**错,不是精度错 ⇒ 降成一颗 dot 只是把错误指向的分辨率降低,所以**数字和 dot 都不显示**。
- **改成什么**:workspace 行不承载任何 unread 信号;这个计数**降级为不可见的唤醒门** —— **除保留当前选中行那条既有挂载门外**(#task:1889:持有打开 channel 的枝始终挂着、始终留那一行,与 unread 无关),**unread 的露出仅由 badge 非 0 唤醒**:门开时该折叠枝挂 channels / unread / modes 查询,并**临时露出**枝内 loud 的 channel 行,清零后自动收回。所以折叠枝的露出集 = {选中行} ∪ {loud 行},两条门各自独立。**不写 `expanded`**:#task:1901 的判据是那一位只能表达「你要它开着」,而这里的触发器是**别人的活动**,更没有资格写它。
- **两级折叠共用这一条门(2026-08-10 扩到组级)**:一级组头(WORKSPACES / DM)折叠时同样不许藏住 loud unread,判定**仍是同一个 badge 非 0**、不是第二套。组折叠时的挂载集 = {持有选中行的枝} ∪ {门开的枝},**正是组展开时本来就挂着的那一集**(展开态的挂载条件已含这两项)⇒ 扩到组级**不提高挂载量级**,也**不许因为组折叠去挂全组查询**。每枝内部走的仍是上一条那条路径(exclusive-home 排除 STARRED → 同一个 `channelRowBadge` 判 `loud` → 选中行与 loud 行去重),故两级只有**入口**不同,判定与露出集同源。
- **组头同样不显示任何 unread 数字 / dot**,理由与 workspace 行一字不差:容器层级越高,定义域越大,「指不到自己 children」的可能只增不减。**由此,露出本身也不得给容器新增任何可见信号** —— 某枝的门开而露出集为空时(下面「已知空转」那条),它在组折叠态必须**完全无形**;归属类附加行(同名 channel 的可辨识性)只能与该枝**真实露出的行同生灭**,否则「浪费一次查询」立刻退化成「显示有事却点不进去」,也就把那条空转成立的前提破掉。
- **门与叶子必须同源**:露出集 = 枝内 `channelRowBadge` 判为 `loud` 的行 —— 它正是本节算术的行级形态(`Σ(loud row badge) = badge_count`,by construction)。**不得引第二套 unread 判定**,否则同一个断裂被复制到下一层:门说「有事」而露出集按另一个口径算出空。
- **已知空转 + 它的前提**:starred 行**计入** badge 却**不在该枝渲染** ⇒ 某 workspace 唯一的 loud 来源正好是 starred 时,门会触发而露出集为空。因为容器此时**什么都不显示**,这只是一次浪费的查询、**不是谎报**;那条 loud 行仍在 STARRED 里、走**同一个** `channelRowBadge`(`FavoritesPanel`),所以「点亮它的行始终存在」仍然成立,只是**不再保证它在该 workspace 枝下**。**这个空转的无害性完全依赖「容器不显示任何信号」**—— 谁以后给 workspace 行**或组头**加回数字 / dot / 归属标签 / 任何可见 unread 信号,断裂立刻回来。
- **`muted_workspace_ids` 不受影响**:workspace 静音仍在该行显示 marker(§10 那枚淡 icon)。它答的是「我把这里调静了」,不是「这里有多少事」—— 移除的是数字,不是这个状态。
- **新鲜度**:门的新鲜度就是 badge 的新鲜度(§10:客户端不随时间、不随 window focus 重取,**漏一帧会一直错到 remount / 重连 / 另一个失效触发器**)。表现从「数字错」变成「折叠态(枝或整组)该露的行没露」,暴露面同级(旧行为里那个数字也是容器唯一的信号)⇒ §10 那四类变更源**一个都不能少**这条约束仍然全额承重。

---

## 9. 数据模型 / API 面

### 9.1 写侧聚合

- **不变**:`conversation_reads`(per-stream cursor,`#1226` v51)· `conversation_stream_heads` · `notifications`(`read_at`)。（`messages.task_*` 不再是 Attention 源 —— task 不进 v1 Activity,§5.1。）
- **Attention 恰好拥有两个写侧聚合,都是 per-viewer 的「决定」(§4.2),都不是 activity item、都不被消除:**
  - **`ChannelAttentionPreference`**(per viewer × channel 的 ambient 档:`所有消息 / 仅提及 / 静音`)。`enter()` 的 policy 输入 + badge 的权重输入。
  - **`WorkspaceAttentionPreference`**(per viewer × workspace 的 boolean 抑制器,#task:1870)。**不是第四档**:它压过该 workspace 全部 channel 档,但只在读时折叠(`effective_mode`),**不改写任何 stored 档** —— 故上线零 backfill、取消静音精确还原每个 channel 自己选的档。仅 `regular` workspace 可有此行(`agent_home` 是 DM,其未读是 directed-grade;DB trigger 兜底)。
  - 两者均为新增 migration(append-only)。

  第三档 `静音` 落在 `ChannelAttentionPreference.mode` 的 CHECK 里,不新开表 —— 它是同一个决定的第三个取值,不是新概念。

### 9.2 读侧:Attention context(`application/` + read-model)

沿用 `docs/use-case-layer-p0-spec.md` 三层。Attention 零自有 read 存储,只投影 + 编排:

- **`listActivity(viewer, scope)`** — query use case。union(positional unread via cursor read-model ∩ `enter()`)+(directed via notifications 投影:mention_self / agent_start_failed),per-(viewer,message) 去重(§7),salience 排序(§5.2)。返回纯 DTO。**task 不在 union 内(v1 移除,§5.1)。** directed 那半边**不自己判定**:内插 §8 那条有效定向诉求谓词(`repos/directed-claim-predicate.ts`),`agent_start_failed` 因无锚只能靠 `read_at` 消除,是显式的第二个分支。
- **`observe(viewer, source_ref, position)`** — 消除 use case。source-routed(§5.3):stream→advance cursor、mention/agent_fail→置 `notifications.read_at`。（v2 若 task 回归 = notification-backed `task_needs_review`,同样 read-cleared、走 `notifications.read_at` —— 即也经此原语,不是 resolve-cleared、不走 `task_status`。）
- **`setChannelAttentionPref(viewer, channel, mode)`** — 写 `ChannelAttentionPreference`。
- **`setWorkspaceAttentionPref(viewer, workspace, muted)`** — 写 `WorkspaceAttentionPreference`。**这两处是写 attention state 的全部**(#task:1870;原文的「只此一处」已随抑制器落地失效)。
- **badge 投影(`AttentionBadgeRepo`)** — §8 那条算术的唯一实现。它有三张脸(roll-up endpoint、per-workspace 热路径、事件 payload),**同一份 SQL,不允许任何一张脸自己再算一遍**;**也不允许第四张** —— 别的 read-model(如 favorites)不得再捎一份同一数字,那会是一个没人刷新的第二载体(#task:1875)。`GET /api/attention/modes` 每行捎的 `directed_unread_count` 是**同一诉求谓词的解释性投影**(解释这一行为什么还在贡献 badge),不是第二个 badge 源。

### 9.3 endpoint(具名,实现期定路径)

- `GET /api/activity?scope=…` → `ListActivityDto`(items[] + 分页 + salience 序)。
- `POST …/observe`(或复用既有 `mark-read` / notification read 路由,由 `observe()` 收口)—— **不新建 `activity.read` 写表**。
- `PUT /api/conversations/:id/attention-preference` —— channel 自己的 **stored** 档,**只有写面**。stored 档的读面**只有**下面那个批量 tier 读面(它同时带 `mode` 与 `effective_mode`);per-channel GET 已退役(#task:1876)—— 同一事实两个读面,迟早有一个面绕过批量读拿到一行 stored 档再与 `effective_mode` 打架。**写是 per-channel 的,因为决定是 per-channel 的**。
- `GET|PUT /api/workspaces/:id/attention-preference` —— workspace 抑制器(#task:1870)。
- `GET /api/attention/modes?workspace_id=` —— 一个 workspace 里全部 channel 的 `mode` + `effective_mode` 加 workspace `muted`,**批量一次**:控件是成组渲染的,per-channel GET 会把「为什么它灰着」变成 N 次往返。
- `GET /api/attention/badges` —— 全 workspace badge 冷启动 roll-up;**0 的 workspace 缺席**(absent ≡ 0),payload 只与「真的在吵」成正比。它另捎一个与 `by_workspace` **平级**的 `muted_workspace_ids: string[]`(#task:1877,rail 上的淡 muted icon 用它;absent ≡ 未静音):**不能挂进 `by_workspace`** —— 那张 map 以「badge 非 0」为键,而静音的 workspace 通常正好是 0、根本没有条目可挂,塞 0 进去会毁掉「keys ≡ 哪些在亮」这条语义。它也**不是第二个状态源**:静音仍只由抑制器行裁定,这里只是把它投到同一份 roll-up 上 ⇒ **workspace 级 `attention_pref_changed` 必须同时失效这张读面**(静音一个 0 徽章的 workspace 不改变任何数字 ⇒ 不会有 badge 帧可发,漏这次失效图标就永远不出现)。**两个成员都按 viewer 当前 membership 收口**:抑制器行只 FK 到 `users` / `workspaces`,把人移出 workspace 只删 `workspace_users`(与该 workspace 的 `conversation_users`)、**故意保留** pref 行 —— re-join 时既有静音决定自然恢复。所以「当前可见」这层收口发生在**读投影**(mute 投影自己 join `workspace_users`),不靠删除级联;单 workspace 那两张脸(`GET /api/attention/modes`、抑制器 GET)带 workspace id、已在路由被 `canViewWorkspace` 收口,跨 workspace 这张不带 id,谓词只能长在查询里。

> CLI 若涉及(`packages/cli` 暂无 activity 命令)须同步 `docs/cli-system.md` + 平台 prompt(CLAUDE.md 纪律)。v1 预计纯 renderer↔backend,无 agent CLI 面。

---

## 10. 失效 / 对账信号

Activity 是 **viewer-scoped read-model**,所以它的失效信号统一收敛到 **`viewer:<userId>`** scope —— renderer 只订阅一条 viewer scope,听到任一源变化即失效 `['activity']` query、重取投影(no-poll,同 `#1226` 模型)。**v1 两源**(positional + directed-notification):

- **positional**:viewer-scoped **`unread_updated`** 失效(复用 `#1226`,已在 `viewer:<id>` 上发)。
- **directed(notification)**:viewer-scoped **`notification`** 失效(`mention_self` / `agent_start_failed` 已在 `viewer:<id>` 上发)。

> **不再有第三源(task) ——** `task_changed` 的 viewer-fan(220b3af 为 global Activity task 行而设)已随 v1 砍 kind=task 一并删除(§5.1)。task 不是 v1 Activity 源,故无 viewer-scoped 消费者;`publishTaskChanged` 只发 conversation + `workspace:<wid>` scope(任务板)。v2 task 若回归走 notification 路径(本就 fan viewer scope,即上面第二源),**不**复活 `task_changed` 的 viewer-fan。regression lock 见 `backend/tests/routes/tasks.test.ts`(`task_changed` 不到 viewer scope)。

- **message event** 可更新 reply_count / repliers 这类**可乐观维护**的事实,**绝不直接改 Activity unread**(§1 铁律)。
- 客户端**不靠 message event 猜 unread**、不扫一堆 conversation cache 拼全局 Activity:读 `listActivity` 这一处 server-scored 投影。
- **channel / workspace attention pref 写入后**(#task:1870,取代原「PUT 不发任何 server event」的写法):PUT 发**两个 viewer-scoped frame,各司其职、互不替代** ——
  - **`attention_pref_changed`** = **纯身份**(`{workspace_id, conversation_id}`,workspace 级写时 `conversation_id: null`)。它失效那些「以 pref 为函数」的读面(Activity 列表、`GET /api/attention/modes`)。**payload 里绝不带新档位** —— 带了,事件就成了那些读面自己拥有的状态的第二权威。
  - **`attention_badge_updated`** = **绝对值**(`{workspace_id, badge_count}`)。因为客户端持有这份 badge 且**不会随时间或 window focus 自己重取**(全局 `staleTime: 5s` + `refetchOnWindowFocus: false`,常驻 query),**漏一帧会一直错到 remount / 重连 / 另一个失效触发器**,不是短暂错。
  - badge 的变更源分**两类,共四种**,少一种就是永久错数字:
    - **推送型(服务端主动发绝对值)三种**:① 消息/未读变动(与 `unread_updated` 同一 seam 共发,顺序上 `mention_self` 行必须先于 badge 计算落库);② pref 写入;③ 定向 notification 被读掉 —— 后两者**都不移动任何 cursor**,没有一个 `unread_updated` 会顺带捎上它们。
    - **重取型(客户端自行失效)第四种 = membership 边**:badge 两项都 `JOIN conversation_users`(§8),所以退群 / 被移出 / 重新加入会改变**定义域**而非响度 —— 退群那一刻 badge 应当下降,重新入群则可能把保留下来的定向 notification 重新纳入。**`added` 这一侧不能用「新 workspace 的 badge 必为 0 ⇒ 缺席即正确」打折**:#task:1877 起同一份 roll-up 还捎着 `muted_workspace_ids`,而抑制器行**故意比 membership 活得久** ⇒ re-join 会在数字仍为 0 的情况下让一个 id 重新出现,漏失效则 rail 的 muted icon 不恢复。这里**故意不造专用 backend 事件**(§12:一个领域事实,viewer-local 消费者自行收敛):已有的领域事实就是 channel 边的 **`workspace_channels_changed`**(`workspace:<wid>` scope,add / self-join / self-leave / 第三方移除四条写路径都发,且退出 channel 不会失去 workspace scope ⇒ 当事人收得到)与 workspace 边的 **`viewer_workspaces_changed`**(`viewer:<uid>` scope)。
    - **renderer 接缝(@Norman)**:在 `workspace_channels_changed`、`viewer_workspaces_changed` 以及 viewer/workspace scope 的 `snapshot_required` 上失效并重取 `['attention','badges']` 与 `['attention','modes',<wid>]`;**不要**等一帧 `attention_badge_updated`,它在成员边变化时不发。多失效是安全的(一次重取),漏失效是永久错数字。**`['favorites']` 不在这条清单里**:favorites 行不带 badge(#task:1875),它自己的 membership 与 `unread_count` 由既有的 removal / list 契约负责。
  - **原始 positional roll-up 仍然 pref-independent(§8)**:PUT **依旧不发** `unread_updated`。badge 骑自己的事件,正是为了不去动那个口径。

---

## 11. v1 / v2 边界

- **v1 = read,全程 source-routed**(§5.3)。清除模型 = **读了即出**(v1 Activity item 全是 read-cleared,无 task 例外——task 库存属 task panel、不在 Activity)。两条清除路径都只写已有两套状态(stream cursor / `notifications.read_at`),**不引第三套**:① 跳源读到 → observe 推进;② 轻量 `Mark as read`(check icon)→ 同一 observe。
- **`Done / Snooze / Archive` = triage**,是另一根轴:**triage ⊥ read** —— triage 答「我处理完了吗」、read 答「我看过了吗」。正因正交,引入 triage 不替代、不影射 read state,read 侧 answerability 照样成立。**triage 是 Activity 唯一能拥有的 durable state,且仅 v2**,引入时明确命名 triage 不叫 read。
- **v1/v2 边界标记(防回退):** v2 做 triage 时,绝不能顺手实现成「activity 自己的 `read_at`」—— 那会把派生事实当决定存,直接打回 `#1226`。

---

## 12. 时序 / 迁移(与 #1226 的桥)

1. **doc 定 target(本 doc)→ Cindy review 过。**
2. **additive 实现(可在 doc 过后即起,不碰 `#1226`):** `ChannelAttentionPreference` 表(migration)+ **锁定既有 `mention_self` 为 directed @我 源(§5.1 (a)——不新增 emission,补 characterization test)** + `listActivity` 读模型 + `setChannelAttentionPref` + endpoint。镜像 `#1226` step-1 的纯加性模式,各步 tree-green。
3. **`observe()` 坍缩(硬时序约束):** 把现有两条 mark-read 写路径(open-time snapshot + visible-live,在 Norman 的 `ThreadPanel.tsx`)收敛成单一 `observe()`。这一步**动 `#1226` 的 mark-read**,故 **必须等 `#1226` dogfood 过 + 关 task 才做**(in_review 期绝不碰)。届时 `snapshot_seq` 客户端回传大概率冗余可删(visible-live 已上报真实 observed seq);涉 DTO/CLI 同步 `docs/cli-system.md`。**这一步即 `#1226 → #1227` 的桥。**

---

## 13. UI 表面节(Norman owns)

### 13.0 原则

所有 UI 表面都是**同一 scorer 的投影**(§8、§9.2);UI **从不写 read/triage 状态**——每个清除 affordance 都降解成 §5.3 的单一 eliminate route `observe()`(委派 cursor / `notifications.read_at`)。表面只「呈现投影 + 把观察路由回源」,无自有状态(§4.2)。

### 13.1 呈现表面(read projections — 在哪看见)

三个呈现表面,都是 `listActivity` / scorer 的投影,聚合各异(精度见 §8,**不在此重述**):

- **Sidebar channel badge** — 原始 positional roll-up(§8);`#1226` 已落、是 Activity 投影雏形,#1227 **泛化它、不平行新建**。
- **就地提示**(channel 流内 reply chip「N new」/ Threads list dot·sticker + 跳首未读)— `#1226` 已落。它是 **source-local locator,对所有 thread unread 都提供源内定位**(含会进 Activity 的 followed-thread unread);**对不进 Activity 的 ambient(§6:非 followed thread / `仅提及` channel)它是唯一提示面**——留原地、不进全局列表(firehose 防线)。
- **全局 Activity 列表** — v1 新表面(13.2)。

### 13.2 全局 Activity 列表(v1)

- **入口**:**NavRail 顶层 `activity` section**(#1394——从早期的 chat-sidebar 折叠版升级为独立 rail;选中一条后右侧**复用完整 `ChannelView`/`ThreadPanel`、无 lite 路径**,布局与选中态契约见 `app-layout.md §1.1` 与本节 §13.7)。**v1 UI = global**(shiki 拍 2026-06-25「这里是用户所有要关注的入口」):一个 human 跨所有可见 workspace 的「等我处理」总队列,`GET /api/activity` 不带 `workspace_id`。`workspace_id` 仍是**可选** filter(数据模型本就全局,UI 日后若要 per-workspace 视图直接传)。global 的完整性三件套:①失效全 viewer-scoped(§10;v1 两源 = `unread_updated` / `notification` —— task_changed viewer-fan 已删,§5.1/§10);②列表行显示 workspace context(DTO 已带 `workspace_id`,renderer 用 workspace map 补 name,跨 ws 同名 channel 可区分,纯展示不放宽可见性);③跳源跨 workspace 稳定(DTO `workspace_id` + onJump 已支持)。
- **收**:`enter() == true`(§6)= DM · @我(notification-backed directed,§5.1a)· followed-thread ambient(**父 channel pref==`所有消息`**,§6 aggregate-floor)· `所有消息` channel 的 ambient。（task-needs-action = v2,§5.1，v1 不进。）
- **每条 item(行结构,shiki 拍 2026-06-26)**:**row1 where** = 源 icon + 来源标识(workspace 名前 `WorkspaceIcon`、channel/DM 名前复用现有主题化 identity primitive,不另造裸 icon)+ 相对时间;**row2 subject** = thread item 在 `thread_root_preview` 前加低响度 thread glyph(标识这是 root message,不改 row1 source 语义),非 thread item 则是 `preview`;**row3 reply** = `<sender avatar> <display_name>: <preview>`,sender 由 `listActivity` 从触发 item 的 **anchor message** server-resolve 出 `preview_sender:{kind,id,display_name,avatar_url}`(global 跨 workspace 列表拿不到 per-workspace member cache,**不能**让 renderer 回 message cache 拼 sender;`avatar_url`=与 `UserDto`/`AgentDto` 同款相对 cache-busted 路径,renderer 按 URL 经现有 avatar hook 解析)。**`preview_sender` 是 additive display-only 字段:不带 source_ref、不参与 §5.3 清除语义;`agent_failed`(无 message anchor)= null。** v1 暂不加 root sender。**salience 分级**(§5.2)directed 视觉强于 ambient;**per-(viewer, message) 去重、取最高 salience**(§7)→ @我显示成 mention + 上下文、**不再**显示成 ambient 未读。
- **`+N new` 未读计数 = quiet count token(row1 meta,shiki 拍 2026-06-26)**:某条流的 ambient 未读数。形态 = 中性墨色(`text-text-secondary`,**不开 accent tier**——否则 count 会比真 directed 信号还跳、偷 salience 预算)+ 极弱 hairline outline 成组(纯描边无 fill,与 sidebar 实心 unread badge 清晰区隔),**非裸散文字 / 非 badge / 非 button**。**纯展示**:不是独立 hit target(无 onClick/role/hover/tooltip),整行才是唯一点击区;不带 source_ref、不参与清除。与 §13.1 channel 流内 `#1226` reply chip 的 ink-text 呈现不同 = **同语义、不同宿主密度**:reply chip 在 inline 低密度行(已有 bordered 容器)、墨字足够;此处 row1 同时扛 workspace·channel·title·time,密度高 → 需 hairline 成组才扫得出是一个 count。
- **排序(v1 从简)**:directed 档置顶、档内 most-recent-first。
- **清除 = read-driven,降解为 §5.3 eliminate route**:
  - **read-cleared item(message / @我 mention)**:打开 / 跳源 → `observe`(推 cursor / 置 `notifications.read_at`);**`Mark as read`** = **hover 才显的 check icon、非常驻「Done」按钮**(常驻 + 「Done」字样会把 triage 心智带回)→ 同一 `observe`;**扫一眼 / hover ≠ 读**(不推 cursor,解「扫一眼就没」)。
  - **(v2) `task_needs_review` notification(§5.1,v1 不进 Activity)**:v1 task 库存只在 task panel;v2 若回归,它是一条 **notification-backed、read-cleared** 事件(走 `Mark as read` / `observe` → `notifications.read_at`,与 mention 同路),**不是**给 task 库存 item 强加无语义的标已读。
  - **firehose 兜底**:列表顶「全部标已读」**= 对 read-cleared items 的批量 source-routed `observe(source_ref, position)`**(逐个/批量等价),**绝不新增 `activity.bulk_read_at` 或任何 Activity 自有状态**。（v1 列表内全是 read-cleared item,无 task 例外要排除。）
  - 列表**绝不直接写 read/triage 状态**——answerability 在 UI 侧的兑现(§5.3 / §14)。
- **空态**:caught-up。**v1 无 Done / Snooze / Archive**(triage = v2,§11)。

### 13.3 控件表面(write controls — 在哪设置)

- **channel `所有消息 / 仅提及 / 静音`** = 写 attention state 的表面之一 → 只写 `ChannelAttentionPreference`(§9.1)。`所有消息` = ambient on、`仅提及` / `静音` = ambient off(但 @我 经 directed **永远进**、不受此开关管,§6);两者的差别在 workspace badge 的响度(§8),不在 eligibility。内部模型 = 一个三值档,用户措辞 = 所有消息 / 仅提及 / 静音(弃用内部词)。**位置:sidebar channel context menu only(仅 `kind==='channel'`,DM/thread 不显示;v1 不再常占 header,也不进 channel settings modal)** —— 它是 **per-viewer 个人 view-state**,不是 channel 级共享配置,放进 settings modal 会被误读成对所有成员生效(shiki/Cindy/Alice 2026-06-26 收敛);settings/gear 仍只承载 rename/archive 等共享配置。
- **workspace `静音`** = 第二个 attention-write 表面(#task:1870)→ 只写 `WorkspaceAttentionPreference`。它**不改写**任何 channel 的档,只在读时折叠成 `effective_mode`;被它压住的 channel 控件应显示自己的 stored 档并解释「被 workspace 静音」,而不是假装用户选了 `静音`。呈现由 @Norman 定。
- **thread `Follow / Unfollow`** = 写 **delivery**(§5.2),**非 attention**;它是 ambient 进 Activity 的 `subscribed` 预置(**necessary not sufficient**——followed thread 的 ambient 还需父 channel pref==`所有消息`,§6 aggregate-floor),follow 本身不单独决定 Activity。v1 二态(镜像 Slack)。**不做**「从 Activity 隐藏」第二控件(attention-only override = v2)。
- **边界**:attention-write 表面 = channel 档 + workspace 抑制器;follow = delivery-write;**互不写对方**(§5.2 硬不变量)。

### 13.4 观察保真度(read-cleared 的「真看到了」)

第一性清除信号 = 人真看到 = per-item 可见。v1 用代理、且**显式声明为近似**(非悄悄糊弄):

- thread 开窗 → open-time stream head(粗:开 = 读了整条打开的 thread);pinned-at-tail + document 可见 → live 标 max-visible(细)。(`#1226` 已落)
- **v1.1**:per-item `IntersectionObserver` 精确标真正进入视口的 max-visible,替换 pinned-tail 代理。

代理只影响「标到哪个 seq」的精度,不影响正确性(forward-only + success-gated,§5.3)。task 不在 v1 Activity(§5.1);v2 若回归是 notification-backed read-cleared,届时同走可见性代理。

### 13.5 命名 / 对外用词(§3)

- **对外只露**:**Activity** · **所有消息 / 仅提及 / 静音** · **Follow / Unfollow** · **Mark as read**(read-driven,**不叫 Done**)。
- **内部、绝不上界面**:Attention · eligibility / `enter()` · salience · claim · `observe` / source_ref · `ChannelAttentionPreference` / `WorkspaceAttentionPreference` · stored / effective mode · suppressor。

### 13.6 实现序(见 §12)

不重述时序:additive(列表读 `listActivity` + channel pref 控件)doc 过后可起;客户端 **`observe()` 坍缩 `ThreadPanel.tsx` 两条 mark-read = 我 lane**,**必须等 `#1226` dogfood 过 + 关 task**(§12 step-3)。

### 13.7 Activity section = NavRail 顶层（#1394 terminal state）

Activity 从「chat sidebar 里的折叠/快捷版」升级为 **NavRail 顶层 section**(与 `chat` 平级)。**这不是换入口,是纠正模型 + 删一层重复渲染**:把 §13.0「表面 = 同一 scorer 的纯投影、无自有状态」贯彻到底——旧的快捷版是一条违反该不变量的第二渲染路径。自适应布局(未选中=list 占满 / 选中=分屏三栏,由 route 派生非独立 flag;browse sidebar 隐藏、Activity list 取代且宽度独立可拖拽)见 `app-layout.md §1.1`。契约:

- **右侧复用 chat 的真正 `ChannelView` / `ThreadPanel`(同一组件同一 hooks,不复制)。** 所有 chat 能力(composer / thread / inline-search / jump-prime / mark-read / attachment / message-actions)经同一路径继承 → chat 改动**无条件自动同步**到 Activity。**这是单一组件权威的结构性保证,不是纪律要求。** 证伪器(Cindy review 锚):任何能力需在 Activity 里单独补一遍 = 结构没改对。
- **选中态 SoT = `(workspace, channel, optional thread)`,workspace 从选中 conversation 派生。** Activity 是跨 workspace global(§13.2),而 `ChannelView` / titlebar(ws name/path) / 所有 ws-scoped hooks 单 ws 作用域 → Activity section 复用 chat 的 channel/thread 路由参数形并**加 workspace 段**:`/activity/w/:wid/c/:cid?thread=<root>`。titlebar 与 ws-scoped hooks 读同一 route workspace → 跨 ws 选一条 activity,右侧 pane + workspace context 一起切,不留 desync。chat 与 Activity = 同一 selection SoT 的两个 navigator。
- **删除两条隐藏分支(重构的实质)**:① `sourceViewer` 降级 chrome;② `useActivitySource` 平行 docked-source 机。二者是旧快捷版的载体,改对后**不存在**(是删除,非被新分支替换)。
- **后端 / 读模型零改动预期**:`listActivity` 本就 global、DTO 带 `workspace_id`、跨 ws jump 稳定(§13.2 / §9),channel/thread 数据走既有 chat endpoints;`observe()` 清除因复用同一 `ChannelView` 而 **correct-by-construction** 与 chat 同路(§5.3 / §13.0),不需在 Activity 侧重对齐。实现中若发现缺 DTO 字段再补(owner: Alice)。
- **不变的**:§13.1 三呈现表面的聚合精度分工(§8)、§13.3 控件表面边界、§13.4 观察保真度、§13.5 命名 全部照旧。本节只改**「全局 Activity 列表」这一表面的宿主形态(sidebar → NavRail rail)+ 选中后右侧复用完整 surface**。

---

## 14. 验收 / answerability gate(Cindy review 锚)

Cindy 的 5 条硬标准 = 本 doc 的逐条验收:
1. Attention 是读侧 bounded context / projection,不拥有 read/unread/claim/salience(§4)。
2. Attention 只拥有 attention 决定:v1 `ChannelAttentionPreference`;follow 仍是 delivery 决定,只读不写(§4.2、§5.2)。
3. 每个 item 通过 answerability:有一条 eliminate route,source_ref-in = source_ref-out;v1 所有 item read-cleared → 统一 `observe(source_ref,position)`(委派 cursor / `notifications.read_at`);overlap 按 per-(viewer,message) 去重(§5.3、§7)。
4. `observe()` 必须 source-routed,不写 `activity.read_at`(§5.3)。
5. sidebar 与 Activity 同源同 `enter()`,projection-specific 聚合(§8)。

**已拍(Cindy contract review,2026-06-25;emission 前提现读源码修正 2026-06-25):** human **@我** directed claim = **(a) notification-backed,canonical TARGET** —— 源 = **既有 `mention_self`**(read-state=`notifications.read_at`),它今天已无条件为会话成员被 @ 而发(含 thread,`thread_root_id` 由 repo join 派生)。**#1227 不新增 emission**,只消费 + 加 characterization test 锁契约(§5.1、§12 step-2);(b) `extractMentions` 投影仅迁移期 fallback、非 canonical。

---

## 15. Out of scope / 证伪点

- **v2:** triage(done/snooze/archive)、per-item `IntersectionObserver` 保真度。
- **已出 scope(#task:1870,2026-08 落地):** channel 第三档 `静音` + workspace `静音`。原文把它列为 v2 并要求「做成更宽的 conversation presentation / notification suppression,不为 Activity 强塞第三档 eligibility」—— **那个约束被遵守了,不是被推翻:** 落地形态恰恰**没有**给 `enter()` 加第三种 eligibility,而是把三档变成同一个 workspace badge 的三级响度(§8),`enter()` 的 ambient 判据仍是二值(§6)。
- **证伪点(诚实标注):** 唯一会推翻「投影优先」的是 **fan-out 规模** —— 若哪天要给海量 viewer 预算 feed、实时投影算不动,才考虑 materialize per-user feed 并吃那个一致性代价。现在单 SQLite / 单 workspace,投影便宜,**不付这个代价**。规模到了再 revisit(届时仍按 §4.3:物化为可重建读模型,非权威 aggregate)。
- **Slack 是命名/形态参考,不是规范源。**

---

## 16. Pointers

- 人/agent 同构 + bounded-context:`docs/architecture-principles.md`。
- 统一语言 / 领域模型:`docs/core-design.md`。
- 应用层三层 + Effect 三分类:`docs/use-case-layer-p0-spec.md`。
- 底座 per-stream cursor + 未读读模型:`docs/thread-unread-v1.md`(`#1226`)。
- 可交付的现行合同以本文正文与 git history 为准；不再把某个 agent 的
  宿主机本地 note 路径当作可移植的文档链接或路径权威。

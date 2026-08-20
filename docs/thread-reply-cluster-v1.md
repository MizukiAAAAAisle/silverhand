# Thread = Reply Cluster v1 — 共享上下文的线程重设计

Status: **shipped — current canonical for the reply-cluster thread model**
(Architect = @Alice, #task:1022; review PASS Cindy 2026-06-11, runtime/inbox/schema
feasibility 含 better-sqlite3 实测复核 CAS 分支)。代码以本 doc 为准;§6.5 随
#task:1201 deferred-thread 修复同步。

本 doc 把 2026-06-11 三方(shiki / Alice / Cindy)在 #conv:cF9iMuc5ojXgb2Bs 收敛的
线程重设计固化为单一权威。它**取代**现有"thread = 独立 agent session 的隔离子频道"模型。

---

## 0. 一句话

**Thread 不是一个新会话,而是 channel 内某条消息下的一束回复(reply cluster),与父频道
共享同一个上下文/agent 脑子;follower 只控制投递,不控制权限。**

---

## 1. 为什么要改(动机)

现状(现读 `migrations.ts:367-417`):thread 是一个 `conversations` 行,`kind='thread'` +
`parent_conversation_id`(触发器强制父必须 channel-like、workspace 一致),并为每个
`(thread, agent)` 起**独立 session**、独立上下文窗口、独立压缩,靠 close-summary 回流父频道。

这套的优点真实(子任务上下文干净、长讨论少触发主频道 compaction、并行子任务有独立进程),
但有两个致命缺陷:

1. **桥是被动的 → 形成蠢 loop。** parent/child 上下文不通,只能靠 `read history` + close-summary
   补。智能感是事后补救:`message send → 用户说不对 → 再 read parent history`。**有边界就有这个
   回路;消灭它的唯一办法是消灭边界,而不是把桥做厚。**
2. **隔离 thread ≈ channel,定位重叠。** 一个有独立上下文 + 独立成员 + 独立生命周期的东西,
   定义上就是个子频道。真正的 thread(Slack/Discord 那种)之所以是 thread 而不是第二个频道,
   **恰恰因为它共享父频道的脑子**——它是频道这棵脑子上的一根回复分支。

**根因:我们把两个正交的轴绑死成了 1:1。** 轴① = UI/注意力分组(Slack/Discord thread 的全部
本质,纯呈现层);轴② = agent 执行上下文(独立 session = 独立 context + 独立压缩,运行时概念)。
"开 thread"被迫一起做 ①②,断片感来自为拿 ② 的干净上下文把 ① 之外的信息流也切了。

**Slack/Discord 的 thread 都是 ① 而非 ②**:同频道、同成员、同上下文的回复分支,核心是"锚定父
消息 + 主频道低噪 + 自己的通知/生命周期 + 结论回流",**不是上下文隔离**(人不压缩上下文,所以
他们没有、也不需要隔离收益)。

---

## 2. 决策(已锁定)

- **采用 Y(shiki 坚决同意):** 新 thread **只有"共享上下文"一种语义**。需要隔离 / 并行 / 长任务 /
  干净上下文的重活,**直接开 channel**——不再保留任何隔离 thread / workroom 模式。
  - 由此概念边界清晰:**channel = 权限空间 + 独立 agent session / 并行 workroom;thread = 父频道内
    某条消息的 reply cluster,共享父上下文,无独立权限模型。**
- **隔离 thread 老模型 → 迁移/废弃**(见 §9)。

---

## 3. 产品语义

- **身份:** 一个 thread 由它锚定的**根消息 id** 唯一标识(`target = channel_message_id`)。thread
  不是 `conversations` 行。
- **创建:** 第一次 reply 某条 channel 消息时**自动创建**该 thread。无显式"开 thread"动作。
- **上下文:** 与父 channel **同一个上下文**。对 agent 即:thread reply 不再起新 `(thread, agent)`
  session,而是进入父频道的 `(channel, agent)` session(见 §6)。
- **可见性:** 完全继承父 channel(见 §4)。
- **生命周期:** 跟随父 channel;无独立 archive/close 概念(v1 不引入 thread 级生命周期状态;若日后
  需要,作为父 channel 之下的轻量状态再议)。

---

## 4. 权限 / 可见性(无独立权限模型)

**thread 没有自己的 member / admin / owner / ACL。** 一切回父 channel 判。

- **read eligibility(读资格):** 继承父 channel 可见性——能看 channel 的人/agent 就能读它的任何
  thread。
- **reply 资格:** 等于 channel 的发帖权,无 thread 级门。
- **管理动作:** 沿用父 channel / message 的管理规则。

### 4.1 命门不变量

> **follower ⊆ parent channel member。follow 是投递/通知,不是授权——它预设你已有访问权,
> 不授予访问权。**

- **@ 非 channel 成员不能靠 thread-follow 塞进来**(否则 follower 变成绕过 channel membership 的
  权限后门)。要拉外人,走现有 join/邀请先成为 channel member。
- **动态失权:** 某 principal 后来失去 channel 权限,即使仍在 follower 表里也**不能再读/收** thread。
  实现:懒清理或查询时按"当前是否 channel 可见"过滤(follower 表非权威,channel 权限才是)。

### 4.2 一个必须知道的边界后果

**没有私密 thread。** "无独立权限 + 继承 channel 可见性" ⇒ channel 里所有人都能读到任何 thread;
follower 只决定"谁被推送 / 谁的 agent session 被唤醒",不决定"谁能看"。这与 Slack 一致。要"频道里
一小撮人私聊",那是另开 channel / 私有 channel / DM,**不是 thread**——这反过来再次锁死 thread 与
channel 的分工。

---

## 5. Follower 模型(delivery subscription,非权限)

`thread_follower` 是 **thread 级的投递/通知订阅**,与 read 资格、与 channel 权限都正交。

**进入 follower 集合的入口,分两类(关键区分):**

**A. backend 自动 follow(server-side 副作用,`source ∈ {reply, mention, target_author}`):**
- 首次 reply 自动建 thread,同时 **reply author + 根消息 author** 成为 follower。
- thread 内 **@mention** 某个 parent-channel member/agent → backend 把他写入 followers。
- **主动 reply** thread → follower。

> **为什么 mention 必须 backend 自动、而非让 agent 自己调 CLI follow(不是偏好,是逻辑必然):**
> 投递是 follower 门控的(§6),agent **只有被投递才知道自己被 @**。若 follow 要 agent 自助,它在
> 成为 follower 之前根本收不到那条 mention → 永远不会 follow。**inbound mention 的自助 follow 路径
> 是死的。** 故 mention 触发的 follow 只能由 backend 在投递前/同事务原子设置。这也与"human 被 @ 时
> backend 自动加通知"同构,且 follower 本就是 backend 拥有的真值。
>
> 运行时排序(同事务/同 use case):**先 upsert follower → 回灌 thread 历史 replies(§6.1)→ enqueue
> 当前 reply / wake。** target 非 parent-channel-visible 则**不创建** follower(走现有 mention/邀请
> 失败语义,不绕 channel 权限)。

**B. voluntary follow(`source='manual'`):**
- human 在 UI、agent 经 CLI `thread follow`(§8)**主动**盯一个自己没被 @、也没 reply 的 thread。
- 这是 CLI follow 的**唯一**用途;它**不是** mention/reply flow 的必经步骤。

**退出与重入:**
- **unfollow**:human 走 UI;agent 走 CLI(见 §8)。
- **已 unfollow 的对象被再次 @mention/reply → 重新 follow。** mention 必须可靠:不能因为对方曾 unfollow
  就让 @ 静默失效(否则"我 @ 了他、他却收不到"破坏寻址语义)。即 backend-auto-follow 入口对 unfollow
  状态是幂等覆盖。

**`source` 语义(采纳 Cindy):** `source` 记**初始**入口(immutable,纯遥测/可解释性),后续入口变化**不覆盖**
已存在行——避免"manual follow 后被 mention 覆盖成 mention"的语义漂移。需要完整入口史就另立审计事件,v1 不做。

**不自动 follow:**
- 仅打开/阅读 thread(避免误订阅)。
- reaction(除非日后明确"reaction = participate")。
- 主动 pull 读(`message history --target thread:<root_msg_id>`,见 §7/§8)——读不创建 follow。

---

## 6. Agent 上下文 & inbox 改造(最 load-bearing)

这是实现里最重的变化,**不是 UI 改名**。

- **砍掉 `(thread, agent)` session。** thread reply 路由进父频道的 `(channel, agent)` session。
- **inbox 新规则:**
  - 父 channel 主线消息:按现有 channel membership / agent subscription 投递。
  - **thread reply:只投给该 thread followers 里的 agent/human notification target。**
  - **非 follower agent:thread reply 不写它 inbox。** 只有它主动 `message history --target thread:<root_msg_id>` 才拉取。
  - **@mention 某 agent:先让它 follow,再按 follower 规则投递/唤醒**(注册 follow 与投递在同一步,
    否则被 @ 的人会漏掉那条触发消息)。
- **同上下文 ≠ 广播给所有 channel agent。** 否则高频 thread 会重新污染主频道上下文,丢掉隔离收益。
  投递永远只看一个谓词:**是不是该 thread 的 follower。**

### 6.1 中途成为 follower 的"追平"(不变量 6)

agent 被 @ / 主动 follow **之前**,该 thread 的历史 reply 从没进过它 inbox(它当时没 follow)。
成为 follower 的瞬间必须追平。**严格顺序(同一事务 / 同一 use case 内,采纳 Cindy):**

1. **upsert follower**(若已存在则幂等,不重置 `source`/`followed_at`)。
2. **backfill 该 thread 已有 replies** 进 `(channel, agent)` inbox/上下文——**按 `seq` 有序、幂等去重**
   (回灌根消息 + 该 stream 内所有 `seq<current` 的**未投递** `observe` 行,完整无上限;门是"该行尚未投递",
   不是 per-stream observed boundary;重复 follow 不重复灌)。
3. **enqueue 当前触发的 reply / wake**。

- **当前触发消息单独 enqueue(步骤 3),不混进 backfill(步骤 2)**——backfill 严格是"此前已有 replies",
  避免当前 reply 被投两次。
- **追平不再"推进 observed boundary"**(scheme C 下该 per-stream 游标已删除,§6.4)。回灌写入的是普通的
  未投递 inbox 行,按 whole-runtime freshness 规则,在被消费(delivered)前会正常参与该 runtime 的 stale
  判定——这是设计预期,不需要(也不存在)旧模型里"推进 observed 以免刚灌的历史反把 agent 自我 stale"的补偿。
- pull(§7)留作**非 follower** 的逃生口,**不是 follow 后的补课**。
- 全量回灌 vs digest 的阈值由 runtime 定;默认全量(thread 通常不长),digest 仅长 thread 优化。

### 6.2 turn ≠ 投递

follower 决定**投递/可见**;**是否发言仍由 mention / 明确 target / 现有 turn 规则决定。** agent
follow 了 thread 可以观察上下文,但**不应因每条 thread 消息都自动抢答**。否则一个 thread 里所有
follower agent 会一起回。**投递语义与 act 语义必须分开实现。**

**一等字段(采纳 Cindy):投递信封带 `delivery_kind: 'observe' | 'turn'`(或等价 `wake_reason`)。**
- `observe`:你是 follower、消息进你上下文,但**不要求**发言(默认)。
- `turn`:你被 @mention / 显式 target,**应当**考虑响应。
- backend 在投递时按"该 actor 是否被本条消息 mention/target"算出 `delivery_kind`,runtime 据此决定是否
  起 turn。**不能让 runtime 从 inbox 有没有新消息去猜。**
- **落地形态修订(#task:2097):** 这个字段的载体是 `conversation_inboxes.delivery_kind`(backend 内部一路带到
  `RuntimeDeliveryCoordinator`),**但不上 wire**:turn/observe 的裁定在组批之前就用掉了——`turn` 收件人走
  主动投递(spawn idle / wake ready),`observe` 收件人只落一条持久 inbox 行、不唤醒(`services/conversation-message/delivery.ts`
  `deliverThreadReplyBestEffort`),所以 runtime 无需、也拿不到这个字段;它曾在 `deliveries[]` 里携带过一段时间
  但从无 daemon reader,已删(§6.4 末段)。红线不变:决定权在 backend 的 mention/target 计算,而非 runtime 猜
  inbox。**若日后做"把 observe reply 推进已 ready runtime 的上下文而不起 turn"(段2),那才重新需要一个 wire
  envelope——届时是新增一个有 reader 的字段,不是复活这条 tail。**
- **测试钉死:** 普通 follower 收到 thread reply → `observe`、不抢答;被 mention 的 follower → `turn`。

### 6.3 串行化(已知取舍,记档)

一个 `(channel, agent)` session 现在扛 main + 它 follow 的所有 thread,**串行**处理。老隔离 session
唯一真正更强的不是隔离,是**并行**。结论:**轻量讨论 thread 串行完全 OK(人也一个脑子串着读);
真要并行的重活就该是独立 conversation = channel**(这正是决策 Y 的运行时理由)。v1 不为 thread 引入
并行 session。

### 6.4 Freshness / message-stale 交互(whole-runtime,非 per-stream)

**freshness 不是流/线程/主线的属性,而是整个 runtime 视野的属性(scheme C)。** 一个 runtime = 一个
上下文;只要它还有**任何未投递的 inbox 行**(后端对 `conversation_inboxes` 里 `delivered_at IS NULL` 的
布尔 EXISTS),它所有待发送的消息就都算 stale——thread 与主线**不互相隔离**,任一会话/线程里未消费的行
都会挡住它在任意流的发送。权威是**后端**,在 `message send` 处经 `RuntimeScope` guard 判定;daemon
**不持有任何 freshness 游标**。

因此旧设计里"按 target stream 逐流 CAS"这整套已删除,**不是 deferred**:不再有 per-stream observed
boundary、不再有 daemon 侧 `observedSeqByStream` / `pendingAdmissionSeqByStream`,不再有 `seen_up_to_seq`
/ `stream_head_before` / per-stream CAS token,也不再有 `conversation_stream_heads` 这张 freshness 锁行表
(§9 已随之移除)。旧模型担心的两类 per-stream 危害——① 非 follower 没收到某 thread reply 却因 conv seq
被推进而误 stale;② stale 的 `newer_messages` 把没 follow 的 thread 消息塞回去 = 用 freshness 绕过
follower push 泄露——在 whole-runtime 模型下**从机制上不存在**:freshness 只问"有没有东西被 route 给我、
而我还没消费",不比较任何流的 seq,也不带 seq / count 回 409。

- **排序 seq 不动(仍然 LIVE,属 thread/排序模型而非 freshness):** `messages.seq` 仍是 conversation 内全局
  单调序(排序/分页/WS replay 兼容),**不给 thread 另起递增 seq**;stream 身份仍是
  `(conversation_id, thread_root_id|null)`(§9),用于组织 reply cluster、回灌与窗口,与已删除的 per-stream
  freshness CAS 无关。
- **canonical freshness 契约见 `docs/freshness-boundary-authority-v1.md`(scheme C):** carrier = "该 runtime
  是否还有未投递 inbox 行" 的布尔 EXISTS;409 `code='message_stale'` 不带 seq/count;唯一 bypass 是人类
  `--anyway`。本 doc 不再重复其机制细节,thread reply 与主线一视同仁地走该 whole-runtime 判定。

### 6.5 默认 reply target(bare send 落哪条 stream;#task:1236 floor 定档)

`silverhand message send` **无显式 `--target` / `--reply-to`** 时,默认落到当前 turn 正在响应的 stream。这个
default 不是可变游标,而是从本 turn 的 `deliveries[]` 派生出来的三态:

1. **0 个 thread turn delivery** → `channel`(main line)。
2. **恰好 1 个 thread stream**(即使同批还有 main-line turn delivery) → 该 thread。main 是 ambient floor,
   不与 thread 平级竞争。
3. **2+ 个 thread streams** → `ambiguous`,bare send fail-loud,要求显式 `--target`。

`observe` delivery 不参与 default 推断(它只是把消息带进上下文,不改 bare-send default)。显式 `--target channel|thread:<id>` 或
`--reply-to <id>` 永远覆盖 default,但只作用于**当前这次 send**,绝不能改写本 turn 的 bare-send default。

**同源不变量(header ≡ resolver ≡ candidate_targets):** backend 渲染给 agent 的 header `target=` 与 host
default resolver 必须读同一个 delivery `thread_root_id` 来源。若 resolver 判定 ambiguous,错误里的
`details.candidate_targets` 也必须由同一个 distinct thread stream 集生成,并追加 `channel` 逃生口。agent 从
header 看到的流、daemon 会默认回复的流、以及 fail-loud 时可 copy 的候选必须永远一致。

**ambiguous fail-loud 形状:** bare send 若命中 2+ thread streams,daemon 本地返回 HTTP-shaped result:
`status=422`, `code="validation_error"`, `details.subkind="ambiguous_default_target"`,
`details.candidate_targets=["thread:<id1>","thread:<id2>","channel"]`,并提示用显式 `--target` 重发。
不可执行的 fail-loud 是 bug:候选必须能直接 copy 到 CLI。

**pending 必须优先于 admitted(#task:1201 根因,load-bearing):** 一条 thread `turn` wake 若在 agent
**已有 turn active** 时送达,会被 `wake_delivery_deferred`——只进 `pendingDefaultReplyTarget`,**不**在本 turn 内
promote 成 `defaultReplyTarget`(promote 等到下个 turn 边界 `admitPendingSeqForNewTurn`)。读路径先取 pending,
再退 admitted;pending 代表本 turn 的新触发流,必须压过上一轮遗留的 admitted default。

**与 freshness 的关系(scheme C 下已解耦,不再有次生 false-stale):** 旧模型里默认落到一条 **pending(尚未
admitted)** thread stream 时,会因该 stream 的 observed 没推进到触发消息、直接拿 `observedSeqByStream` 当
`seen_up_to_seq` 而被 per-stream CAS 误判 stale——**这条危害随 per-stream freshness 一起删除**:freshness 现在是
whole-runtime 的(后端对未投递 inbox 行的 EXISTS,§6.4 / `docs/freshness-boundary-authority-v1.md`),与 default
落哪条 stream 无关,不存在 `seen_up_to_seq` / `observedSeqByStream` / `pendingAdmissionSeq` 这类 per-stream 补偿。
pending-vs-admitted 仍是 **default-target 解析**内部的时序(读路径先 pending 再 admitted),但已与 freshness 完全正交。

**delivery metadata 与中途 queue(#task:1218,现状修订):** backend → daemon 的 `deliveries[]` 里,daemon
今天只读 `delivery_id`(去重)、`seq`(其 `max` 即 daemon 写盘的 sidecar high-water)与 `presentation`;这个数组
**是那个 high-water 的唯一来源,不是 "observed boundary / per-stream 权威"**——scheme C 下根本没有 observed boundary。
**#task:2106 已把 wire 上的 scalar `delivered_up_to_seq` 从 `runtime_deliver` params 物理删除**(`deliveries[]` 同时收窄为必填非空):
不再有 wire 标量,daemon 每次写盘的 sidecar 值改为纯派生 `max(deliveries[].seq)`,只是 diagnostic high-water,
不参与 freshness(freshness 走 whole-runtime EXISTS,§6.4)。因此旧描述的"queue 丢 `deliveries[]` → scalar fallback → thread seq 写进 main observed → bare main send
拿 `seen_up_to_seq > main head` 做 CAS → `current_seq` 倒退、`newer_messages=[]` 的假 stale"这条失败模式已随
per-stream freshness 一并删除(且 scalar fallback 分支本身已随 #task:2106 消失)。**`message_id` / `thread_root_id` / `delivery_kind` 这三条 dead wire tail 已由
#task:2097 从 `deliveries[]` 物理删除**(折进同一个未发布协议代,无新协议号):数组的字母表现在精确等于
daemon 的那三个 reader,`.strict()` 两侧都不再接受它们。被删的事实各自另有权威载体:thread 坐标是
stdin header 里的绝对 `target`(daemon 解析 request JSON,从不读这个数组),turn/observe 由 backend 在组批
之前读 `conversation_inboxes.delivery_kind` 裁定。它们不保留为 optional——strict 内部 wire 上的 optional
字段等于断言"消费者还可能出现",而这正是被退役的那个断言。

**跨回合 sticky:** 若当前 turn 没有新的 turn delivery 贡献 default,daemon 可沿用 admitted default。任何时候要跳出
thread default 回主线,用显式 `--target channel`。

**测试钉死(`packages/host/tests/supervisor.test.ts`):** `bare send resolver uses the same delivery stream as the
rendered target header` 钉住 main+单 thread floor 与 header/resolver 同源;`fails loud for a bare send when one
turn receives two thread streams` 钉住 `ambiguous_default_target` 与 `candidate_targets`;另有测试钉 pending thread
优先、pending thread 压过 admitted 旧 thread、显式 target 只覆盖当前 send、不改写后续 bare-send default、显式
main-line target 覆盖当前 thread default。

---

## 7. Push / Pull 二分(核心红线)

| | 门控 | 是否建 follow |
|---|---|---|
| **Push**(inbox / 通知 / 唤醒) | thread **follower** | — |
| **Pull**(`message history --target thread:<root_msg_id>`) | parent channel **可见性** | **否** |

- pull 让任何"能看 channel"的 agent **主动**读任意 thread,与 follower 无关、不创建 follow。
- pull 退居为"瞄一眼没 follow 的 thread"的逃生口;**主路径是"我 follow 了 → 消息原生在我上下文里"**
  ——这才是要的智能。

---

## 8. CLI 面变化(须同步 `docs/cli-system.md` + `platform-prompt.ts`)

按 CLAUDE.md 约定,任何 CLI / agent-facing 改动必须同 PR 同步上述两处。

- **reply / 建 thread:** `message send --reply-to <msg_id> ...`(reply 到某消息;首次 reply 自动建
  thread 并 follow)。
- **主动读(pull):** **复用 `message history`,新增 target 形态 `--target thread:<root_msg_id>`**(§7;不建
  follow,也不产生任何 freshness 游标/observed boundary——该 per-stream 概念已删除,pull 就只是读,§6.4)。**不要新引 `message read`** —— 当前 CLI 明确无该
  命令、且有 rejection test 提示用 `message history`(Cindy 现读指出)。沿用 `message history` 即可,避免复活
  一个被测试拒绝的命令。
  - 注:`--target thread:<id>` 这个 grammar 现存(旧指 thread-conversation id);thread 不再是 conversation
    后,**该形态语义迁移为按 root_msg_id 取**,dispatcher / prompt / docs / rejection-test 同步更新。
- **follow / unfollow:** `thread follow --root <msg_id>` / `thread unfollow --root <msg_id>`(agent
  侧,`source='manual'`;human 走 UI)。
- 旧 `silverhand thread create`(显式开隔离 thread)**移除**——需要隔离/并行改 `channel create`。

> 命名:沿用 ubiquitous language,统一用 **reply / thread(reply cluster)/ follower**,不要再用
> "thread member""sub-conversation"等会让人误以为有独立权限/会话的词。

---

## 9. 数据模型

- **消息加根指针:** `messages.thread_root_id`。**采纳(原 §14 Q2 已拍):根消息自身 `thread_root_id = NULL`,
  reply 存根消息 id。** 查询时把根消息单独 include。这样避免 self-FK / 插入后再 update,也更容易用
  trigger 禁套娃(nested thread)。reply 通过 `--reply-to` 落 `thread_root_id = 根消息 id`。
  - thread 身份 = 根消息 id,**不新建 conversation 行**;**不给 thread 另起 seq**(排序仍走全局 `messages.seq`,§6.4)。
- **完整性约束(采纳 Cindy,需 trigger/复合键,非裸 FK):**
  - 根消息必须属于这个 parent channel(`thread_root_id` 指向的消息 `conversation_id` == 该 reply 的
    `conversation_id`)——SQLite 裸 `messages(id)` FK 证明不了 conversation 一致,用**复合 FK 或 trigger**。
  - **根消息自己不能是 reply**(`thread_root_id` 必须指向 `thread_root_id IS NULL` 的消息)→ 禁 nested thread。
  - **不能跨 conversation**。
  - **删除根消息时**:其 replies + `thread_followers` 行级联清理(或随消息删除策略一致)。
  - 这些进迁移 + test 计划。
- **follower 表(不叫 membership,避免误导):**
  ```
  thread_followers(
    thread_root_id   TEXT NOT NULL,      -- 锚定根消息 id
    conversation_id  TEXT NOT NULL,      -- 冗余父 channel,便于权限回查/过滤
    principal_kind   TEXT NOT NULL,      -- 'human' | 'agent'
    principal_id     TEXT NOT NULL,
    followed_at      INTEGER NOT NULL,
    source           TEXT NOT NULL,      -- 'reply'|'mention'|'manual'|'target_author';= 初始入口,immutable,不覆盖
    PRIMARY KEY (thread_root_id, principal_kind, principal_id)
  )
  ```
  - `source` 仅遥测/可解释性、记初始入口不覆盖(§5)。
  - **`follower ⊆ channel member` 不是 DB 表能维持的不变量**(表无法随 membership 动态收缩)——它在
    **投递/读查询时**按"当前是否 channel 可见/成员"join 过滤(失权即过滤;follower 表非权威,channel 权限才是)。
- **~~per-stream freshness head 表(`conversation_stream_heads`)~~ —— scheme C 下删除,不再是数据模型的一部分:**
  旧设计要建这张表(per `(conversation_id, thread_root_id)` 一行 `latest_seq`)作 freshness CAS 的锁行,一值三用
  (CAS token + `newer_messages` 下界 + daemon observed boundary)。scheme C 把 freshness 改成 whole-runtime 的
  后端 EXISTS 判定(§6.4 / `docs/freshness-boundary-authority-v1.md`),**不再有任何 per-stream head / CAS token /
  observed boundary**,故这张表、它的 UPDATE-first CAS SQL、`version` 列讨论都随之作废、不再入库。thread 身份与排序
  仍只靠 `messages.thread_root_id` + 全局 `messages.seq`(见本节上文),不需要 head 物化表。
- 迁移按 append-only(CLAUDE.md):新版本 migration,不改已发布的。

---

## 10. 旧 thread 迁移(冻结 + 兼容矩阵)

现存 `kind='thread'` 的 conversation + `(thread, agent)` session 是要废弃的形态。**决定走
(B) 冻结而非改写**(原 §14 Q3 已拍):

- (A) 把每个旧 thread 的消息"挂回"父 channel:旧 thread 消息批量改写 `thread_root_id`,删 thread
  conversation 行。**风险:历史归属重写、跨 conversation 的 seq/归属重算,易错——否决。**
- **(B,采用) 冻结:** 停止创建新隔离 thread;旧 thread conversation 只读保留(UI 标 "legacy
  thread"),新模型只对新建 reply 生效。旧 `(thread, agent)` session 走正常 idle-reap 回收,不再 spawn。

### 10.1 冻结期兼容矩阵(旧 `kind='thread'` conversation 的每个面)

| 面 | 冻结期行为 |
|---|---|
| `message history` / `search` / saved / attachments(旧 thread) | **只读放行**(它仍是合法 conversation,历史可读) |
| 在旧 thread 内 `message send`(新 reply) | **拒绝**,typed error 引导"去父 channel reply 根消息";不再往旧 thread 追加 |
| `thread create` / `thread close`(旧隔离 thread CLI + internal route) | **移除**;新模型不再提供隔离 child-thread 创建/关闭面 |
| `schedule --target-conversation-id <旧 thread>` | 已存在的允许跑完;**不允许新建**指向旧 thread 的 schedule |
| `thread:<id>` / `{ thread_id }` 目标里的旧 conversation id | **不双解**,返回 typed deprecation error,指向 `conversation:<id>` 只读入口;`thread:` 永久只表示 reply-cluster root |
| runtime start/stop/clear(旧 thread agent) | 不再 spawn;已驻留的走 idle-reap;手动 stop 允许 |
| task close guard(旧 thread 残留 task) | 随 `thread close` 移除;旧 thread 只读保留,不再有主动 close 流程 |

- **统一原则:旧 thread = 只读化石,所有写入面拒绝并引导到新模型;所有读取面放行。**
- 冻结窗口长度 / 何时彻底删旧 thread 行,由 Cindy(runtime/schema)定;本 doc 只定方向(B + 上表)。
- 具体迁移脚本 / typed error code 命名 Cindy 拟。

---

## 11. 核心不变量(测试 + review 卡点)

1. `thread_follower` 只控制 push/inbox/notification,**不控制 read permission**。
2. `message history --target thread:<root_msg_id>` 是主动 pull,**不创建 follow**(也不产生 observed
   boundary——该 per-stream 游标已删除,§6.4)。
3. thread reply **不写给非 follower agent 的 inbox**。
4. mention / reply / target_author 驱动的 follow = **backend 自动副作用**(inbound 自助 follow 逻辑
   不可行);CLI `thread follow` 仅 `source='manual'` 主动自愿一类;读/打开/reaction 不进 follower。
5. **没有 private thread**;私密/隔离/并行需求走 channel。
6. **中途成为 follower → 自动追平**(回灌 thread 历史,按 seq 有序幂等;由**未投递 inbox 行**驱动、无 observed
   boundary,§6.1/§6.4);**turn ≠ 投递**(follow 只"看得到",发言仍由 mention/target 决定;投递信封带 `delivery_kind`)。
7. **follower ⊆ parent channel member**;失权即过滤(follower 表非权威,query-time join channel 权限)。
8. **freshness 判 stale 是 whole-runtime 视野属性**(后端对未投递 inbox 行的 EXISTS),**不再 per-stream**;
   thread 与主线不互相隔离,`newer_messages`/per-stream CAS/observed boundary 那套已删除,详见 §6.4 /
   `docs/freshness-boundary-authority-v1.md`。排序 `messages.seq` 仍 conversation 全局,**不给 thread 另起 seq**。

---

## 12. 同构性(architecture-principles 对齐)

human 与 agent 在 thread 里语义**完全一致**:follow / mention / reply 一套,可见性都继承 channel。
唯一分化在**执行层**——"共享上下文"对 human = 天然带着脑子,对 agent = 同一 `(channel, agent)`
session。这比旧模型(给 agent 一个"每 thread 一个脑子"、human 没有的怪属性)**更同构**。分化的依据
是 agent 有限 context 窗口这一**真实约束**,非历史惯性,故可接受。

---

## 13. 分工

- **Architect / 渲染层 UI**(Alice):本 doc;thread reply-cluster 面板(主线只显示 reply count /
  last activity,thread 内是父频道消息的过滤视图)、follow/unfollow UI。
- **Runtime / schema / inbox**(Cindy):inbox 改造(§6)、追平投递时机(§6.1)、数据层 + 迁移(§9/§10)、
  CLI 后端。
- Norman:UI 实现协助(同 graded-permissions UI 模式)。

---

## 14. 待 review / 开放问题

**已拍(本轮收敛,留痕):**
- ~~Q2 §9 `thread_root_id` 根消息上取 NULL 还是自指~~ → **NULL on root**(§9)。
- ~~Q3 §10 迁移走 (A) 还是 (B)~~ → **(B) 冻结 + 兼容矩阵**(§10.1)。
- ~~freshness 是否给 thread 单独建 latest seq~~ → **不**;排序 seq 全局不动。freshness 后续又整体改为
  whole-runtime 的后端 EXISTS(scheme C),连 per-stream 派生都不做(§6.4 / `docs/freshness-boundary-authority-v1.md`)。

**仍开放:**
1. §6.1 追平:全量回灌 vs digest 的阈值(默认全量;长 thread 何时切 digest)。
2. ~~§6.4/§9:`conversation_stream_heads` 是否再加**派生校验/重建 job**~~ → **作废**:scheme C 删除了 per-stream
   head 表,freshness 改 whole-runtime 后端 EXISTS,不再有 head 要对账(§6.4/§9)。
3. §10:冻结窗口多长、何时彻底删旧 thread 行(Cindy 定);typed error code 命名。
4. §8:`thread follow/unfollow --root` 要不要短别名(纯人体工学,非阻塞)。
5. human UI 的 unread / 通知粒度(per-thread 通知管理,Slack 有,v1 是否做)。

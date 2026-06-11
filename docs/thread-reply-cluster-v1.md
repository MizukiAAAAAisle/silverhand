# Thread = Reply Cluster v1 — 共享上下文的线程重设计

Status: **review PASS (Cindy 2026-06-11) — design frozen, implementation pending shiki greenlight**
(Architect = @Alice, #task:1022). Reviewer = @Cindy(runtime/inbox/schema feasibility,已 PASS,
含 better-sqlite3 实测复核 CAS 分支)。

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
   (以 agent 在该 stream 的 observed boundary 为起点,只灌它没见过的;重复 follow 不重复灌)。
3. **enqueue 当前触发的 reply / wake**。

- **当前触发消息单独 enqueue(步骤 3),不混进 backfill(步骤 2)**——backfill 严格是"此前已有 replies",
  避免当前 reply 被投两次。
- **追平要同步推进该 stream 的 observed boundary**(§6.4),否则刚灌进去的历史会被 freshness 当成"未观察"
  反过来把这个 agent stale 掉。
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
- **测试钉死:** 普通 follower 收到 thread reply → `observe`、不抢答;被 mention 的 follower → `turn`。

### 6.3 串行化(已知取舍,记档)

一个 `(channel, agent)` session 现在扛 main + 它 follow 的所有 thread,**串行**处理。老隔离 session
唯一真正更强的不是隔离,是**并行**。结论:**轻量讨论 thread 串行完全 OK(人也一个脑子串着读);
真要并行的重活就该是独立 conversation = channel**(这正是决策 Y 的运行时理由)。v1 不为 thread 引入
并行 session。

### 6.4 Freshness / message-stale 交互(per-target-stream)

旧 `message_stale` 是 **conversation 粒度的 raw seq CAS**(`conversations.latest_message_seq` + daemon 单值
observed)。旧模型成立因 thread 是独立 conversation。新模型 thread reply 写进父 channel 同一条消息流,
**若仍用 conv 粒度会两个错:** ① 非 follower 没收到某 thread 的 reply,但 conv seq 被推进 → 它在主线发言被
误 stale;② stale 的 `newer_messages` 会把它没 follow 的 thread 消息塞回去 = **用 freshness 绕过 follower
push、泄露 thread 内容**。

**契约(正式 v1 = per-target-stream;delivery-stream 只允许作实现 floor/迁移中间态,不写进产品语义):**

> **一条 send 只能被「同一 target stream 内、且对该 actor 可见/可投递」的更新判 stale;`newer_messages`
> 也只含这类更新。** `stream_key = (conversation_id, thread_root_id | null)`(`null`=主线)。

机制(排序与判新解耦,三方收敛 + Cindy slock-ai 调研 #task:1023 印证):
- **排序 seq 不动:** `messages.seq` 仍是 conversation 内全局单调序(排序/分页/WS replay 兼容)。**不给
  thread 另起递增 seq。**
- **per-stream head 物化 + `latest_seq` 当 CAS token(无独立 `version`,已拍):** 新表
  `conversation_stream_heads`(**结构化列 `thread_root_id`,NULL=main;不存编码字符串 `stream_key`**,见 §9 + blocker 修正)。
  `latest_seq` = 该 stream 最新消息的 **global seq**。同一 stream 内 global seq
  单调递增(全局 allocator 保证后插入更大)→ `latest_seq` 本身就是合法 CAS token,**一值三用**:CAS token
  + `newer_messages` 下界 + daemon observed boundary。语义源头仍是 `messages` 全局 seq + stream key
  (`MAX(seq) WHERE conversation_id=? AND thread_root_id <=> ?` 可重建 head,用于 backfill/校验)。`stream_key`
  字符串只在 API/daemon wire 层暴露,DB 边界一律用结构化 `thread_root_id`。
  - **不建独立 `version` 字段。** slock-ai 同样用"消息序号本身"做 per-target boundary、无独立 version。
    **注意(shiki 指正):slock 是有 reaction 机制的,但 reaction 被刻意排除在 freshness 之外**(只 POST/DELETE
    `/messages/:id/reactions`,不带 `seenUpToSeq`)——所以"系统里存在 reaction"本身**永远不构成**引入 version
    的理由。只有当我们**主动决定**让某种不推进 `latest_seq` 的变更(edit / 把 reaction 设计成"需重判")参与
    freshness 时,才需要独立 version。v1 不这么设计(对齐 `docs/reactions-design.md`:reaction 独立表、不进消息流),
    故单 `latest_seq` 足够,version 不预留。
- **发送事务(确定形态,单一 DB transaction,采纳 Cindy blocker#1):** allocator 与 stream-CAS 是两件事
  (今天在 `message-repo.ts:493-521` 挤成同一条 `latest_message_seq+1` UPDATE,新模型必须拆),但**必须包在
  一个事务里,CAS 失败整体 rollback**——不能像现有 `insertForConversationIfFresh` 那样 return stale 后仍提交
  (否则会把 `conversations.latest_message_seq` 空推进、留下 burned seq)。确定顺序:
  1. resolve target stream(reply→`thread_root_id=<root>`,否则 `main` 即 `NULL`)。
  2. **reserve global seq**:`conversations.latest_message_seq += 1` → `newGlobalSeq`(无条件全局 allocator)。
  3. **stream-head CAS,UPDATE-first(实测纠正二轮,见下方"为何 UPDATE-first"):**
     - **先做条件 UPDATE**(无论 `seenStreamSeq` 是 0 还是 >0,只要 head 行已存在):
       ```sql
       UPDATE conversation_stream_heads SET latest_seq = :newGlobalSeq
        WHERE conversation_id = :conv
          AND thread_root_id IS :rootOrNull   -- main 用 IS NULL;thread 用 = :root
          AND latest_seq = :seenStreamSeq;     -- changes()==1 → 成功
       ```
     - **UPDATE 命中 0 行且 `seenStreamSeq == 0`**(该 stream 尚无 head 行,典型=thread 首条 reply):**INSERT,冲突即放弃**
       ```sql
       INSERT INTO conversation_stream_heads(conversation_id, thread_root_id, latest_seq)
       VALUES(:conv, :rootOrNull, :newGlobalSeq)
       ON CONFLICT DO NOTHING;     -- 无需 conflict target;changes()==0 → 并发首 reply 已赢 → stale
       ```
     - **UPDATE 命中 0 行且 `seenStreamSeq > 0`** → head 被人推进 or 行缺失 → **stale**(不进 INSERT,绝不误插)。
     > **为何 UPDATE-first(纠正原"`seen==0`→INSERT / `seen>0`→UPDATE"两路径,sqlite3 + better-sqlite3 实测):**
     > v43 migration 给**每个已存在 conversation** backfill 了一条 main head(空会话 `latest_seq=0`)。原方案下 main 线
     > 首发(`seen==0`)会走 INSERT 分支 → 撞已存在的 main head 行 → `ON CONFLICT DO NOTHING` → `changes()==0` →
     > **误判 stale**(而旧 conv 级 CAS `WHERE latest_message_seq=0` 是成功的 → 回归)。UPDATE-first 把"行已存在"
     > 的所有情形(含 backfilled main-head-at-0)交给条件 UPDATE,只有 UPDATE 0 行 **且** `seen==0` 才认定 head
     > 真缺失 → INSERT。**并发首 reply / `seen>0` 缺行 → stale 的语义与原方案逐格一致**(见下方并发用例),只是多正确
     > 覆盖了 backfilled-main 这一格。两条 SQL 仍都不带 conflict target,partial-index 限制不相关。

  4. **CAS 失败(`changes()==0`)→ `throw` 让事务/savepoint rollback**(allocator 的 +1 一并回滚,无 gap);
     rollback 后再查该 stream 当前 `latest_seq` 组 stale 响应,`newer_messages` 用**同 stream + 同
     deliverability/follower filter** 拉。
     - **cut1 落地形态**(`message-repo.ts insertForConversationIfFresh`):allocator+CAS 包在一个 `db.transaction`,
       CAS miss 抛内部 sentinel `StreamCasMiss` → savepoint rollback(撤 +1)→ 捕获后返回 `{ok:false, currentSeq=
       该 stream head}`;service 再抛 `MessageFreshnessGuardError(threadRootId)` 回滚外层并组 `message_stale` 响应,
       `newer_messages` = `listAfterSeqInStream(conv, threadRootId, seen)`(follower deliverability filter 归 cut2)。
  5. CAS 成功(`changes()==1`)→ insert message(`seq=newGlobalSeq`, `thread_root_id=…`),提交。
  - 并发首 reply(都 `seen=0`):第一条 UPDATE 0 行 → INSERT 成功(`changes()=1`);第二条 UPDATE 0 行(head 已被首条
    推到 >0)→ `seen=0` 走 INSERT → 撞 partial unique → `DO NOTHING` → `changes()=0` → stale。(均 better-sqlite3 实测,
    cut1 测试 `message-repo.test.ts` 钉死。)
- **daemon observed 从单值 → map** `stream_key → observed_seq`(= 它读到的该 stream `latest_seq`)。send 带
  `(stream_key, seenStreamSeq)`;CAS 比的是同一 stream 的 head,而非 conv 全局 max。
- **`newer_messages` 用完全相同的 deliverability + stream filter**,不能 `listAfterSeq(conversation_id)`。
- **pull-read(§7)产生该 `thread_root_id` stream 的 observed boundary**(不创建 follow),否则"主动读完→
  reply"会被自己 stale(与 §6.1 追平同源:任何让历史进上下文的路径都要同步推进对应 stream 的 observed)。
  slock 同此:read/history + full stdin delivery 推进 boundary,busy notice 不推进。

净效果:消除跨 stream 误报 + 非 follower 误拦 + payload 泄露;thread-heavy 频道的假 stale 大幅下降。

> **实现期测试要求(Cindy review PASS 附带,卡点):** CAS 测试必须覆盖 main 与 thread 两组路径的全部分支——
> 首插、**并发首插(`seen=0` 第二条 → 0 changes → stale)**、CAS 成功、CAS stale、**`seen>0` 且 head 缺失 →
> UPDATE 0 行 → stale(不误插)**;并断言 `conversations.latest_message_seq` 在 CAS miss 后已 rollback(无 burned seq)。

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
  follow,但产生该 stream 的 observed boundary,§6.4)。**不要新引 `message read`** —— 当前 CLI 明确无该
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
- **per-stream freshness head(load-bearing,非可选缓存——它是 freshness CAS 的锁行,§6.4):**
  **DB 用结构化列 `thread_root_id`(NULL=main),不存编码字符串 `stream_key`**(采纳 Cindy blocker#2:
  `thread:<id>` 字符串无法自然 FK 到 messages,结构化列才能复用同一套 root-valid trigger):
  ```
  conversation_stream_heads(
    conversation_id  TEXT NOT NULL,
    thread_root_id   TEXT,                 -- NULL = main stream
    latest_seq       INTEGER NOT NULL      -- 该 stream 最新消息的 global messages.seq;= CAS token + 边界
  );
  -- 每 conversation 唯一 main head:
  CREATE UNIQUE INDEX uniq_stream_main
    ON conversation_stream_heads(conversation_id) WHERE thread_root_id IS NULL;
  -- 每 (conversation, thread) 唯一 head:
  CREATE UNIQUE INDEX uniq_stream_thread
    ON conversation_stream_heads(conversation_id, thread_root_id) WHERE thread_root_id IS NOT NULL;
  ```
  - `thread_root_id` 复用 §9 上面那套 root-valid trigger 约束(存在、同 conversation、root 自身
    `thread_root_id IS NULL`)。`stream_key='main'|'thread:<id>'` 只在 API/daemon wire 层编码/解码,DB 不见。
  - **SQLite UPSERT 落地(Cindy 实测起头 + 我两轮实测纠正):** CAS **不走** `ON CONFLICT … DO UPDATE`,改 **UPDATE-first**:
    先 `UPDATE … WHERE latest_seq=:seen`;命中 0 行**且** `seen=0` 再 `INSERT … ON CONFLICT DO NOTHING`;否则 stale。
    这样既绕开 partial unique index 的 conflict-target 限制(两条 SQL 都无 target),又正确覆盖 v43 给每个已存在
    conversation backfill 的 main head(空会话 `latest_seq=0`)——纯"`seen=0`→INSERT"会把它误判 stale。完整 SQL +
    实测结论见 §6.4 步骤 3。
  - **无 `version` 列**(原 §14 已拍 + Cindy slock 调研 #task:1023 印证:slock 也用消息 seq 做 per-target
    boundary、无独立 version;reaction 不参与 freshness)。仅未来 edit/reaction 要触发重判时才加。
  - `latest_seq` 语义源头 = `MAX(messages.seq) WHERE conversation_id=? AND thread_root_id <=> ?`,head 是其物化,
    可由该 query 重建(backfill / 校验 job)。
- 迁移按 append-only(CLAUDE.md):新版本 migration,不改已发布的。

---

## 10. 旧 thread 迁移(冻结 + 兼容矩阵)

现存 `kind='thread'` 的 conversation + `(thread, agent)` session 是要废弃的形态。**决定走
(B) 冻结而非改写**(原 §14 Q3 已拍):

- (A) 把每个旧 thread 的消息"挂回"父 channel:旧 thread 消息批量改写 `thread_root_id`,删 thread
  conversation 行。**风险:历史归属重写、跨 stream observed/freshness 重算,易错——否决。**
- **(B,采用) 冻结:** 停止创建新隔离 thread;旧 thread conversation 只读保留(UI 标 "legacy
  thread"),新模型只对新建 reply 生效。旧 `(thread, agent)` session 走正常 idle-reap 回收,不再 spawn。

### 10.1 冻结期兼容矩阵(旧 `kind='thread'` conversation 的每个面)

| 面 | 冻结期行为 |
|---|---|
| `message history` / `search` / saved / attachments(旧 thread) | **只读放行**(它仍是合法 conversation,历史可读) |
| 在旧 thread 内 `message send`(新 reply) | **拒绝**,typed error 引导"去父 channel reply 根消息";不再往旧 thread 追加 |
| `thread close`(旧 thread) | 允许(收尾用);**新模型无 thread close 概念**,不暴露给新 reply-cluster |
| `schedule --target-conversation-id <旧 thread>` | 已存在的允许跑完;**不允许新建**指向旧 thread 的 schedule |
| 内部 `--target thread:<旧 conversation id>` | dispatcher 双解:命中旧 thread-conversation → 旧读路径;否则按 root_msg_id(新语义,§8) |
| runtime start/stop/clear(旧 thread agent) | 不再 spawn;已驻留的走 idle-reap;手动 stop 允许 |
| task close guard(旧 thread 残留 task) | 沿用现有 `thread close` 的 open-task 拒绝逻辑,收尾后冻结 |

- **统一原则:旧 thread = 只读化石,所有写入面拒绝并引导到新模型;所有读取面放行。**
- 冻结窗口长度 / 何时彻底删旧 thread 行,由 Cindy(runtime/schema)定;本 doc 只定方向(B + 上表)。
- 具体迁移脚本 / typed error code 命名 Cindy 拟。

---

## 11. 核心不变量(测试 + review 卡点)

1. `thread_follower` 只控制 push/inbox/notification,**不控制 read permission**。
2. `message history --target thread:<root_msg_id>` 是主动 pull,**不创建 follow**(但产生该 stream
   的 observed boundary,§6.4)。
3. thread reply **不写给非 follower agent 的 inbox**。
4. mention / reply / target_author 驱动的 follow = **backend 自动副作用**(inbound 自助 follow 逻辑
   不可行);CLI `thread follow` 仅 `source='manual'` 主动自愿一类;读/打开/reaction 不进 follower。
5. **没有 private thread**;私密/隔离/并行需求走 channel。
6. **中途成为 follower → 自动追平**(回灌 thread 历史,按 seq 有序幂等,同步推进 observed boundary);
   **turn ≠ 投递**(follow 只"看得到",发言仍由 mention/target 决定;投递信封带 `delivery_kind`)。
7. **follower ⊆ parent channel member**;失权即过滤(follower 表非权威,query-time join channel 权限)。
8. **freshness 判 stale 只在「同一 target stream + 对该 actor 可投递」范围内**(`stream_key =
   (conversation_id, thread_root_id|null)`);`newer_messages` 用同一 deliverability+stream filter,
   **不得跨 stream 泄露**。排序 `messages.seq` 仍 conversation 全局,**不给 thread 另起 seq**。

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
- ~~freshness 是否给 thread 单独建 latest seq~~ → **不**;排序 seq 全局不动,freshness 改 per-stream
  派生(§6.4)。

**仍开放:**
1. §6.1 追平:全量回灌 vs digest 的阈值(默认全量;长 thread 何时切 digest)。
2. §6.4/§9:`conversation_stream_heads` 是 load-bearing 锁行(已定),是否再加一个**派生校验/重建 job**
   (拿 `MAX(messages.seq)` 对账 head,修迁移/异常导致的漂移)。
3. §10:冻结窗口多长、何时彻底删旧 thread 行(Cindy 定);typed error code 命名。
4. §8:`thread follow/unfollow --root` 要不要短别名(纯人体工学,非阻塞)。
5. human UI 的 unread / 通知粒度(per-thread 通知管理,Slack 有,v1 是否做)。

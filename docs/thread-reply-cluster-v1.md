# Thread = Reply Cluster v1 — 共享上下文的线程重设计

Status: **draft for review** (Architect = @Alice, #task:1022). Reviewer = @Cindy
(runtime/inbox/schema feasibility). Implementation gated on shiki.

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

**进入 follower 集合的入口:**
- 首次 reply 自动建 thread,同时 **reply author + 根消息 author** 成为 follower。
- thread 内 **@mention** 某个 parent-channel member/agent → 让他 follow。
- **主动 reply** thread → follow。
- UI/CLI **主动 follow**。

**退出:**
- **unfollow**:human 走 UI;agent 走 CLI(见 §8)。

**不自动 follow:**
- 仅打开/阅读 thread(避免误订阅)。
- reaction(除非日后明确"reaction = participate")。
- 主动 pull 读(`message read --thread`,见 §7)——读不创建 follow。

---

## 6. Agent 上下文 & inbox 改造(最 load-bearing)

这是实现里最重的变化,**不是 UI 改名**。

- **砍掉 `(thread, agent)` session。** thread reply 路由进父频道的 `(channel, agent)` session。
- **inbox 新规则:**
  - 父 channel 主线消息:按现有 channel membership / agent subscription 投递。
  - **thread reply:只投给该 thread followers 里的 agent/human notification target。**
  - **非 follower agent:thread reply 不写它 inbox。** 只有它主动 `message read --thread` 才拉取。
  - **@mention 某 agent:先让它 follow,再按 follower 规则投递/唤醒**(注册 follow 与投递在同一步,
    否则被 @ 的人会漏掉那条触发消息)。
- **同上下文 ≠ 广播给所有 channel agent。** 否则高频 thread 会重新污染主频道上下文,丢掉隔离收益。
  投递永远只看一个谓词:**是不是该 thread 的 follower。**

### 6.1 中途成为 follower 的"追平"(不变量 6)

agent 被 @ / 主动 follow **之前**,该 thread 的历史 reply 从没进过它 inbox(它当时没 follow)。
成为 follower 的瞬间必须追平:

- **(采纳)follow 时把该 thread 已有 replies 回灌进 `(channel, agent)` 上下文/inbox**,使被 @ 进来的
  agent **立刻"懂行"**。
- pull(§7)留作**非 follower** 的逃生口,**不是 follow 后的补课**。
- 回灌的投递时机 / 是否给"全量 replies vs digest"由 runtime(Cindy)定;digest 仅在 thread 过长时
  作为优化,默认全量(thread 通常不长)。

### 6.2 turn ≠ 投递

follower 决定**投递/可见**;**是否发言仍由 mention / 明确 target / 现有 turn 规则决定。** agent
follow 了 thread 可以观察上下文,但**不应因每条 thread 消息都自动抢答**。否则一个 thread 里所有
follower agent 会一起回。**投递语义与 act 语义必须分开实现。**

### 6.3 串行化(已知取舍,记档)

一个 `(channel, agent)` session 现在扛 main + 它 follow 的所有 thread,**串行**处理。老隔离 session
唯一真正更强的不是隔离,是**并行**。结论:**轻量讨论 thread 串行完全 OK(人也一个脑子串着读);
真要并行的重活就该是独立 conversation = channel**(这正是决策 Y 的运行时理由)。v1 不为 thread 引入
并行 session。

---

## 7. Push / Pull 二分(核心红线)

| | 门控 | 是否建 follow |
|---|---|---|
| **Push**(inbox / 通知 / 唤醒) | thread **follower** | — |
| **Pull**(`message read --thread <root_msg_id>`) | parent channel **可见性** | **否** |

- pull 让任何"能看 channel"的 agent **主动**读任意 thread,与 follower 无关、不创建 follow。
- pull 退居为"瞄一眼没 follow 的 thread"的逃生口;**主路径是"我 follow 了 → 消息原生在我上下文里"**
  ——这才是要的智能。

---

## 8. CLI 面变化(须同步 `docs/cli-system.md` + `platform-prompt.ts`)

按 CLAUDE.md 约定,任何 CLI / agent-facing 改动必须同 PR 同步上述两处。

- **reply / 建 thread:** `message send --reply-to <msg_id> ...`(reply 到某消息;首次 reply 自动建
  thread 并 follow)。
- **主动读:** `message read --thread <root_msg_id>`(pull;§7;不建 follow)。
- **follow / unfollow:** `thread follow --root <msg_id>` / `thread unfollow --root <msg_id>`(agent
  侧;human 走 UI)。
- **history 定位:** thread 历史按根消息 id 取(替换现有 `--target thread:<conv_id>`,因 thread 不再是
  conversation)。
- 旧 `silverhand thread create`(显式开隔离 thread)**移除**——需要隔离/并行改 `channel create`。

> 命名:沿用 ubiquitous language,统一用 **reply / thread(reply cluster)/ follower**,不要再用
> "thread member""sub-conversation"等会让人误以为有独立权限/会话的词。

---

## 9. 数据模型

- **消息加根指针:** `messages.thread_root_id`(= 该 thread 锚定的根消息 id;根消息自身该列为 NULL
  或自指,二选一,实现时定)。reply 通过 `--reply-to` 落 `thread_root_id = 根消息 id`。
  - thread 身份 = 根消息 id,**不新建 conversation 行**。
- **follower 表(不叫 membership,避免误导):**
  ```
  thread_followers(
    thread_root_id   TEXT NOT NULL,      -- 锚定根消息 id
    conversation_id  TEXT NOT NULL,      -- 冗余父 channel,便于权限回查/过滤
    principal_kind   TEXT NOT NULL,      -- 'human' | 'agent'
    principal_id     TEXT NOT NULL,
    followed_at      INTEGER NOT NULL,
    source           TEXT NOT NULL,      -- 'reply' | 'mention' | 'manual' | 'target_author'
    PRIMARY KEY (thread_root_id, principal_kind, principal_id)
  )
  ```
  `source` 仅遥测/可解释性;**权限判断永远回 parent channel/conversation 做,不读这张表当权威。**
- 迁移按 append-only(CLAUDE.md):新版本 migration,不改已发布的。

---

## 10. 旧 thread 迁移

现存 `kind='thread'` 的 conversation + `(thread, agent)` session 是要废弃的形态。两条可选,建议
**(B)**:

- (A) 把每个旧 thread 的消息"挂回"父 channel:为其根选一条锚点消息,旧 thread 消息批量改写
  `thread_root_id`,删除 thread conversation 行。**风险:历史消息归属重写,易错。**
- **(B,建议) 冻结而非改写:** 停止创建新隔离 thread;旧 thread conversation 只读保留一段(UI 标
  "legacy thread"),新模型只对新建 reply 生效。旧 thread 的 `(thread, agent)` session 走正常 idle-reap
  回收,不再 spawn。降低一次性迁移风险。

具体迁移脚本 / 兼容窗口由 Cindy(runtime/schema)定;本 doc 只定方向(B 优先)。

---

## 11. 核心不变量(测试 + review 卡点)

1. `thread_follower` 只控制 push/inbox/notification,**不控制 read permission**。
2. `message read --thread <root_msg_id>` 是主动 pull,**不创建 follow**。
3. thread reply **不写给非 follower agent 的 inbox**。
4. mention / reply / manual follow 是进入 follower 集合的入口;读/打开/reaction 不是。
5. **没有 private thread**;私密/隔离/并行需求走 channel。
6. **中途成为 follower → 自动追平**(回灌 thread 历史);**turn ≠ 投递**(follow 只"看得到",发言仍
   由 mention/target 决定)。
7. **follower ⊆ parent channel member**;失权即过滤(follower 表非权威)。

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

1. §6.1 追平:全量回灌 vs digest 的阈值。
2. §9:`thread_root_id` 在根消息自身上取 NULL 还是自指。
3. §10:迁移确认走 (B);冻结窗口多长。
4. §8:`thread follow/unfollow` 的确切 CLI 形态(按 root msg id 是否够,要不要短别名)。
5. human UI 的 unread / 通知粒度(per-thread 通知管理,Slack 有,v1 是否做)。

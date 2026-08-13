# Agent-scoped Session v1 —— DDD 目标模型与改造路径

Status: **design under review**（设计 @Alice，#task:2009；review gate @Cindy）。
产品语义权威 = **#task:2005 的 Acceptance Summary**；本 doc 是**技术目标模型的单一权威**，#task:2009 的 body
只保留可独立验收的 Acceptance Summary，不复制正文。

**事实来源纪律**：schema 断言只引 `packages/shared/src/db/migrations.ts`（`baseline-schema.ts` 是 v0 快照，
按它设计会把 v53/v54/v64 已删除的概念写回模型）；现网数据形态引 `~/.silverhand/embedded-server-backup-*`
的只读快照（app 运行时不得打开活动 DB）；SQLite 语义写进 doc 前实测。

---

## 0. 产品合同输入（#task:2005，已拍板，不重开）

`session_scope = conversation | agent` 创建时选定且**不可变**（切换 = 新建 Agent）。Agent-scoped：一 runtime /
一 vendor session / 一稳定 agent cwd / 全局 L1 `MEMORY.md`，**不创建 `agent_home`**、不加载 workspace L2。
消息 / ACL / task / file / unread / delivery **仍归 conversation**；认知与 steer 归 Agent。
每条投递的 header 带来源与语义 `target`（`#<ws>/<channel>`、`…/thread:<root>`、`dm:@handle`），
回复原样复用；**不存 canonical target 字符串**。

已拍板且本 doc 必须承载的三条边界：

- **Reference / recipient 边界**：reference 解析与 follower/recipient 扩张**只用 outbound target 的当前成员**。
  在 B 里引用 A-only 的人，**既不在 B 加人、也不向 A 投递**，且 unresolved **可观测**。
- **handle**：不可改名、不复用；但**内部身份用 principal `(kind,id)` 派生 pair key**，让内部身份与公开寻址解耦。
  （旧稿用「handle 可改名」当理由，是错的 —— 理由是解耦，不是可变性。）
- **删除**：参与者删除保留 DM 历史 / tombstone 语义；移除只阻断**将来**的操作，不追溯认知。

---

## 1. 根因（一句话）

`conversations` 一行混装「消息流身份 / 归属 / roster 策略」，`conversation_agents` 一行混装「成员边 + ACL 权威 /
runtime 身份」。症状全是**静默**：workspace-less 会话在 10 处 INNER `JOIN workspaces` 上整行消失；
`mention-cc.ts:228` 取不到 home `workspace_id` 即 `warn`+`return` 丢 CC；「一 agent 一 runtime」与
per-`(conversation,agent)` 的 `pid/status/cli_session_id` 直接冲突，且 ACL 判权压在 runtime 高频写面上
（`permissions.ts` / `permissions-registry.ts` 读同一行）。

---

## 2. 现网数据形态（先测量，再设计）

只读快照 `embedded-server-backup-20260813T053019Z`：

| 量 | 值 |
|---|---|
| `kind='dm_channel'` 行数 | **14**，成员基数**全部**是 (1 agent, 1 user) |
| 它们所在 workspace | **全部 `workspace_kind='agent_home'`**（7 个 home，无一在 regular workspace） |
| 同一 (human, agent) pair 的 dm 行数 | **4 / 3 / 2 / 2 / 1 / 1 / 1** |
| agent_home 内的 task | **39** |
| agent_home 内的 saved_messages | 0 |

两个结论直接改写了目标模型：

1. **`kind='dm_channel'` 今天不表示「与 X 的那个 DM」。** 同一对 (human, agent) 有 **4 条**这样的会话
   （标题是 "mac mini" / "pod ops" / "working with ai" 之类自由标题）。它表示的是「roster 固定为 home owner
   + 该 human 的私有会话」。⇒ **`UNIQUE(pair_key)` 的 DirectPair 无法承接这批行**（11 行会塌成 4 个 pair 键冲突），
   「P0-a 把现有 `dm_channel` backfill 成 DirectPair」在数据上不可行。DirectPair 只能是**新概念、只由新
   get-or-create 路径创建**。
2. **`agent_home` 今天就是 DM 的 task board**，持有 39 条按该 workspace 编号的 task。⇒ 「删掉 workspace 的
   `agent_home` 支」不是清理，是搬迁 14 条会话 + 39 条已编号 task 的迁移工程。

---

## 3. Context map

### 3.0 Thread 属于 Stream

v53 退役 `kind='thread'`、v54 删 `parent_conversation_id`。thread = 同一 conversation 内的 stream，键
`(conversation_id, thread_root_id)`。⇒ Thread 归 **Stream + DeliveryTarget**，继承根 conversation 的
placement 与 roster policy，不占 placement 唯一键。

### 3.1 聚合

- **Agent**（根）：`name` 全局唯一、不可复用、不可改；不可变 `session_scope`；profile / L1；Agent runtime 所有权。
  **不拥有一个代替它存在的 workspace。**
- **Conversation**（根）+ **两个正交的一等值**（§4.1 的核心修正）：
  - `Placement` = `Workspace(workspace_id)` | `DirectPair(endpoints)` | `AgentInbox(agent_id)` —— **住在哪**；
  - `RosterPolicy` = `open` | `fixed` —— **成员可变吗**。
- **Runtime**：拆成四件事，不是一个「DB runtime 聚合」（§4.3）。
- **Task**（根）：**全局身份 `tasks.id`**，归属一个 conversation（决定 ACL）+ 一个 Board（决定局部编号）（§4.5）。
- **Board**：task 编号 namespace 与聚合视图（§4.4）。**只管 task，且不是 ACL 单位**；file 已 conversation-owned，
  saved/favorite 是 user-owned read/write state，三者各自建模。
- **Delivery**：`DeliveryTarget` 值对象 + §0 的 reference/recipient 边界。

依赖单向：Runtime / Board 依赖 Agent / Conversation 的 ID，反向不成立；Placement 不引用 Runtime。

---

## 4. 目标持久化模型

### 4.1 `kind` 是两个概念的混装 —— 拆成 placement × roster policy

旧稿写「`dm_channel` 由 placement 表达后 `kind` 只剩一个值 ⇒ 删列」。**这是错的**：§2 证明现有 14 行
`dm_channel` 不会变成 DirectPair，它们的 `roster fixed` 语义没有别的载体，而 118 处代码 / 29 个文件读 `kind`
（含 `permissions.ts` 与 **wire 契约** `shared/src/api/conversation.ts:40 kind: z.literal('dm_channel')`）。
删掉判别式而 DirectPair 尚未存在 = 语义先被抹掉。

正确分解：

```sql
conversations:
  id, title(mutable), name NULL,                 -- name 仅 workspace placement 必填
  status, visibility, latest_message_seq, ...,
  placement_kind TEXT NOT NULL CHECK (placement_kind IN ('workspace','direct_pair','agent_inbox')),
  roster_policy  TEXT NOT NULL CHECK (roster_policy IN ('open','fixed')),
  workspace_id   TEXT NULL REFERENCES workspaces(id),
  inbox_agent_id TEXT NULL REFERENCES agents(id),
  endpoint_a_kind TEXT NULL, endpoint_a_id TEXT NULL,
  endpoint_b_kind TEXT NULL, endpoint_b_id TEXT NULL,
  pair_key TEXT NULL,                            -- 由 endpoints 规范排序派生
  CHECK (穷尽互斥弧：本支列非空、其余支列全 NULL),
  CHECK (placement_kind <> 'direct_pair'
         OR ((endpoint_a_kind, endpoint_a_id) < (endpoint_b_kind, endpoint_b_id)
             AND roster_policy = 'fixed')),
  CHECK (placement_kind <> 'agent_inbox' OR roster_policy = 'fixed'),
  CHECK (visibility = 'private' OR roster_policy = 'open')     -- ← 见下
CREATE UNIQUE INDEX … (pair_key)          WHERE placement_kind='direct_pair';
CREATE UNIQUE INDEX … (inbox_agent_id)    WHERE placement_kind='agent_inbox';
CREATE UNIQUE INDEX … (workspace_id,name) WHERE placement_kind='workspace';
```

`visibility` 的旧 CHECK 是 `visibility='private' OR kind='channel'`。**`roster_policy='open'` 才是它的忠实
改写**；旧稿写的 `placement_kind='workspace'` 会错误地允许「public 的固定 roster home DM」。

回填（**行为零变化**）：

| 现状 | placement | roster |
|---|---|---|
| `kind='channel'` | `workspace` | `open` |
| `kind='dm_channel'`（14 行，全在 agent_home） | `workspace` | **`fixed`** |
| 新的产品级 DM（`dm:@handle`） | `direct_pair` | `fixed` |
| Mentions | `agent_inbox` | `fixed` |

`kind` 因此**不删**，降级为**由 `(placement_kind, roster_policy)` 派生的只读 wire 兼容字段**，删除条件是
可观测的：wire epoch bump 后无客户端读它 + 29 个文件的读点清零。这是「有观测删除条件的短期桥」，
不是长期 shim。

### 4.2 DirectPair / AgentInbox：ACL **派生**自 placement，不投影成员行

旧稿让 endpoints 投影成 `conversation_agents` / `conversation_users` 行并用 `BEFORE INSERT/DELETE …
RAISE(ABORT)` 守。两个理由否掉它：

1. **拒绝型 trigger 无法保证「投影一定存在」** —— 它只能挡错误变更，挡不住漏建。
2. **它会把 actor 删除整个 abort。** 实测（sqlite 3.54.0）：`conversation_agents.agent_id … ON DELETE
   CASCADE` 的级联删除**会**触发子表 `BEFORE DELETE` trigger，`RAISE(ABORT)` 上抛后 `DELETE FROM agents`
   整条失败、agent 存活。而 `agent-repo.ts:571` 今天就是硬删 `DELETE FROM agents WHERE id = ?`。
   ⇒ 该设计不是 tombstone，是**让删除失败**。

目标形态：**participant set 由 placement 派生，单一权威、无投影**。

| placement | participants |
|---|---|
| `workspace` + `open` | `conversation_agents` / `conversation_users` roster 行（现状） |
| `workspace` + `fixed` | 同上，但 roster 变更 API 不可达（现有 14 行沿用现状） |
| `direct_pair` | **两个 endpoint 列**（无 roster 行） |
| `agent_inbox` | `inbox_agent_id` 一个 owner（无 roster 行） |

⇒ 存在性由 `NOT NULL` + 互斥弧证明；成员表在这两支**根本没有行**，所以既无双权威也无 cascade 冲突。
ACL 读面收敛到**一个** placement-aware `participantsOf(conversation)` 解析器（今天 `permissions.ts` 直接读
成员表，这是必须改的读点，而不是「20 个读者零改动」—— 旧稿这句是错的）。

配套三件（缺一不可）：

- **endpoint 不可变**：`BEFORE UPDATE OF endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id,
  pair_key ON conversations → RAISE(ABORT)`（CHECK 管不了 UPDATE 后仍自洽的整体改写）。
- **typed principal 校验**：endpoint kind ∈ {`human`,`agent`} 且 id 在对应表存在 —— 条件 FK 不可表达 ⇒
  `BEFORE INSERT` trigger 子查询校验，fail-closed。
- **endpoint identity 在 actor 硬删后存活（新增前置件 P0-e，**范围收在 endpoint 一侧**）**：endpoint 列是
  **历史 principal 坐标，不带 FK**（存在性由 lookup 派生；创建时由 trigger 子查询校验，删除是合法转移），
  并在删除事务内给该 endpoint 打 `endpoint_*_deleted_at`，使「对端已删」与「id 写错」可区分；actor 仍走**现有
  硬删流程**。survivor 对该 DM 得到**只读 ACL**（可读历史、不可发新消息），由 placement + endpoint tombstone
  派生，不写第二份状态。
  **明确不做**：把 `agents` / `users` 整体改软删。那会牵动全部 FK cascade、handle 唯一性、登录/list、
  `created_by`、agent teardown —— 本 feature 只需要 endpoint 侧的身份存活，全系统软删是另一个聚合的工程，
  不能当一个小前置件塞进 P0-e（@Cindy 第三轮 finding 5）。

### 4.3 Runtime：四件不同的东西，不是一行

旧稿「一 scope 一当前 slot」与 `UNIQUE(…, daemon_instance_id)` 自相矛盾（换 daemon 就有两行都自称当前），
而且把三种不同权威的字段并成了「DB runtime aggregate」。拆开：

| 关注点 | 权威 | 落位 |
|---|---|---|
| **slot identity**（这个 scope 的 runtime 名额） | DB | `agent_runtime_slots`：**按 scope 唯一**，不含 daemon id |
| **generation**（这一代的身份 + 抢占） | DB，**CAS** | slot 行上单调递增，`UPDATE … WHERE generation = ?` |
| **进程观测**（`status` / `pid` / liveness / 当前 daemon） | **daemon/supervisor**，DB 是 event projection | slot 行上明确标注为 projection 字段，不作判据 |
| **resume state**（`cli_session_id`） | 持久厂商状态 | 独立列，**不随进程退出清空** |
| **历史世代** | append-only | `agent_runtime_events`（不靠保留退出行来记历史） |

```sql
agent_runtime_slots:
  agent_id TEXT NOT NULL REFERENCES agents(id),
  conversation_id TEXT NULL REFERENCES conversations(id),   -- NULL ⇔ Agent scope
  generation INTEGER NOT NULL,
  claimed_by_daemon_instance_id TEXT NULL,   -- 观测：当前持有者
  observed_status TEXT NOT NULL,             -- 观测：daemon event 投影
  observed_pid INTEGER NULL,                 -- 观测
  cli_session_id TEXT NULL,                  -- 持久 resume state
CREATE UNIQUE INDEX … (agent_id)                  WHERE conversation_id IS NULL;
CREATE UNIQUE INDEX … (agent_id, conversation_id) WHERE conversation_id IS NOT NULL;
```

（**不能**写 `UNIQUE(scope_kind, conversation_id, agent_id)`：SQLite 下 NULL 互不相等 ⇒ agent scope 可重复插。）

**scope 一致性由 DB 证明**：`BEFORE INSERT/UPDATE ON agent_runtime_slots` 子查询 `agents.session_scope`，
`session_scope='agent'` 而 `conversation_id IS NOT NULL`（或反之）即 `RAISE(ABORT)`。

`agents: + session_scope` + **`BEFORE UPDATE … RAISE(ABORT)`** trigger（「schema 里没有 UPDATE 路径」不是约束）。

### 4.4 Board：只管 task 编号与聚合视图，**不管 ACL**

§2 测到：DM 的 task board 今天就是 `agent_home`，持有 39 条按该 workspace 编号的 task。

目标：**`Board = WorkspaceBoard | AgentBoard`**，且 **AgentBoard 是 new-row-only**：

- **legacy 保持 legacy**：旧 conversation-scoped Agent 的 `agent_home` workspace、它里面的 14 条固定 roster 会话、
  以及 39 条 task **原地不动**，继续是 WorkspaceBoard，直到该 Agent 自然被删除。**零搬迁、零重编号。**
- **新的 agent-scoped Agent 只创建 AgentBoard，不创建 home workspace**（#2005 只授权这一条）。
- ⇒ 这与 §4.1 的 DirectPair 结论**同构**：新概念只承接新行，旧行靠自然消亡退场（@Cindy 第三轮 finding 1）。

**Board **不是** ACL 单位**：一个 AgentBoard 会同时聚合该 agent 与**多个不同 human** 的私线 task，
若 ACL 取 board，另一位 human 就会看到别人的私线 task。⇒ **ACL 一律逐 task 从 `tasks.conversation_id` 派生**
（走 §4.2 的 `participantsOf`）；Board 只提供**编号命名空间 + 聚合视图**。owner 可见全板，viewer 只见其有权
的那些 task 行。

其余三个「归属」各自建模，不进 Board：

- file：`attachments.channel_id → conversations`，本来就 conversation-owned、**没有 workspace_id**；
- saved / favorite 是 user-owned state：`saved_messages.workspace_id NOT NULL` 是**冗余派生列**
  （conversation 已决定它），改为可派生 / 可空 + placement-aware 分组键；favorites 的
  `list_key='channels:'||workspace_id`（`favorites.ts:153`）同样按 placement 派生。

**旧稿的 `Board = Workspace | Conversation` 撤回**（要求 39 条 task 重编号，换来的只是新一层歧义）。
**Board 归属仍待 @shiki 确认**（§9）。

### 4.5 Task identity 是全局的，Board 只是局部编号

`tasks.id TEXT PRIMARY KEY` 已经是全局不可变身份；缺的不是一列，而是**把它提升为协议里的 canonical
address**。这在本 feature 里是**承重件而非可选改进**（@Cindy 第三轮 finding 6）：没有 ambient conversation 之后，
`task detail/edit/status <n>` 无从解析 —— 局部编号必须靠一个 board 才有意义，而 agent-scoped runtime 同时面对
N 个 target。

- **所有 task mutation 与跨会话引用最终解析到 `tasks.id`**；`#task:<n>` 只是**当前 board 的 shorthand**。
- **canonical 文法本身 out of scope**（@shiki 2026-08-14 02:11 裁定：Task 会升级为 `silverhand://` URI 的一等
  对象，但**协议设计与实现不进入本 feature**）。本 doc 只守两个接口条件：①`tasks.id` 是全局不可变 identity，
  agent-scoped 的 task mutation 不依赖 ambient board；②Board 只管治理 / ACL 边界 / 局部编号，**局部
  `task_number` 永不充当跨 conversation identity**。
  - 现状事实（供那张票用）：`REFERENCE_KINDS = ['human','agent']`，docblock 明写 containers 与 tasks 没有
    handle 可拼、继续用 `#conv:<id>` / `#task:<n>`；renderer 内部另有单冒号伪 scheme
    `silverhand-task:<n>` / `silverhand-task-bare:<n>`（不出现在纯文本读面）。⇒ **今天不存在 task URI**，
    且 task 是这套文法里唯一只有局部地址的一等对象（`#conv:` 已用不可变 id）。
  - 我留一条**待那张票裁**的异议（不阻塞本 feature）：#2000 把 `silverhand://` 定为 **principal 寻址轴**
    （写它 = 意图寻址 ⇒ 投递/唤醒），sigil 是**对象指针轴**（只导航）。把 task 放进寻址轴需要说明
    「引用 task」为什么不产生投递语义，否则两根轴的判据会重新混起来。
- **短形的可复制性按 placement 分档**：`#silverhand/task:42` 可复制（workspace name 是共享名字）；
  **私线短形 `dm:@handle/task:7` 是 reader-relative**（同一 task 在两端拼出两个地址）⇒ **一旦跨 principal
  或写入持久文本，一律序列化成 `#task:<id>`**。
- **全局 id 不豁免 ACL**：resolver 先做 live ACL 再返回，且「不存在」与「无权」必须是**不可区分**的同一种
  拒绝，否则 canonical ref 就成了 id 枚举探测面。
- 不新增全局自增数字（全局取号热点 + 泄露任务总量）；现有 opaque id 更稳。

---

## 5. 生命周期与外部副作用（saga，不是「同 tx」）

旧稿把 `Create Agent` / `start/stop/respawn` / `Delete` 标成「同 tx」。**代码上不可能**，撤回：
`create-agent.ts` 是 reserve INSERT → `agent_materialize` wire intent → ack 交叉核对 → L3a dependent-row tx →
失败 `flipToFailed`；`agent-deletion-resumer.ts` 是 durable intent + host purge + 带 retry generation 的
CAS finalize。OS 进程与 host IO 不能进 SQLite tx。

规则：**聚合内不变量同 tx；跨进程/跨主机后果一律 durable intent + 外部副作用 + ack/project + CAS finalize。**

| 流程 | durable intent | 外部副作用 | ack / project | finalize | 重试幂等键 |
|---|---|---|---|---|---|
| Create Agent(scope) | reserve 行（`agents.name` UNIQUE） | `agent_materialize` | 典型 ack 交叉核对 | dependent-row tx / `flipToFailed` | reserved row id |
| Start / respawn | slot 行 + `generation++` | daemon spawn | `observed_*` 投影 | CAS on `generation` | `(scope, generation)` |
| Stop / crash | slot 行状态意图 | daemon signal | 同上 | CAS | `(scope, generation)` |
| Delete Agent | 现有 durable deletion intent | host purge | purge count | CAS finalize（现状） | attempt id |
| **Mention CC** | source message（write-once，已持久） | 写入目标 inbox | —— | **写入即 receipt**（UNIQUE 挡重复） | **`(source_message_id, target_inbox_conversation_id)`** |

**Mention CC 的「commit 后可重试」旧稿是空口承诺**：`post-commit.ts` 的 effect 是 best-effort、失败只
`logger.warn`，**没有任何持久记录**⇒ commit 后崩溃即永久丢 CC（正是今天 `warn`+`return` 的同族缺陷，
只是换了触发条件）。

**上一版只写「由 source `message.id` 幂等重放」是不够的**（@Cindy 第三轮 finding 4）：source 行只证明
**输入存在**，不证明某个 `(source_message_id, target_agent)` 的副本**已经写过** ⇒ 崩溃后重放照样重复写。
恰好一次需要两半，缺一不可：**重放驱动**（source message，已有）+ **写入时可判定的 dedupe receipt**。

选定形态：**CC 消息行自带 `cc_source_message_id`，并建
`UNIQUE(cc_source_message_id, conversation_id)`（partial，仅 CC 行）**。⇒ receipt 就是**副本本身**，
重放的第二次写入被 DB 约束拒绝（幂等），**不新增 outbox 表、不新增 per-item 状态机**。
被否：只有 source replay 而无 UNIQUE（重复投递）；只有 receipt 表而无重放驱动（丢投递后无人重试）。

同 tx 的只有这些：DM get-or-create（conversation + endpoints，**无投影行**）、AgentInbox 创建、
roster join/leave、send message（message + stream head + follower/recipient plan）、board 内 task 取号。

---

## 6. 读模型与投递合同

- list / search / favorites / saved / task 全部 **placement-aware**（含 `list_key` 与 saved 的分组键）。
- **`agent_status` 必须扩，不能声称「保持现状」**：现在的 payload 是
  `{agent_id, status, cli_session_id?}`（`status-projector.ts:127…`），**没有** `focus` / `pending` / `queue`。
  #task:2005 要求「UI derives **authorized** busy/focus/pending state from one runtime」⇒ 新增字段是新 wire
  surface，要定版本。**授权投影按 viewer 逐字段裁**（@Cindy 第三轮小项 2 —— 一律只显示「本会话忙」会丢掉
  可解释性）：

  | viewer 对 focus conversation 的权限 | 可见内容 |
  |---|---|
  | 有 | **绝对 target**（`#ws/channel`、`thread:<root>`、`dm:@handle`）+ 排队深度 |
  | 无 | `focus='other'` + 排队深度 —— 知道「在别处忙」但**不泄露**该会话的 id / 标题 / 对端 |

  ⇒ 「忙」永远可解释，而会话身份不经 presence 侧漏。
- **Delivery invariant（#2005 已拍板，旧稿漏抄，现在是硬合同）**：reference 解析与 follower/recipient 扩张
  只用 outbound target 的**当前成员**；B-targeted 的 reference 指向 A-only 成员时**不在 B 加人、不向 A 投递**，
  且 unresolved **可观测**。（与 #task:2000 的四层投递模型不冲突：那里说的是「thread reply 的 follower 插入
  能扩张收件人」—— 扩张的前提是**该 principal 已是本 conversation 成员**。）
- unread / activity 契约不变（#1967 的 plan 常量与 join 钉序继续有效）。

---

## 7. 凭据与 CLI frame

### 7.1 principal 是一个判别联合，不是一个扁平 tuple

现状：全部 agent-facing API 挂 `/internal/conversations/:cid/agents/:aid/*`，token 按**路径**里的 `(cid,aid)`
验（`internal-agent.ts:73`；签发 `outbound-event-fanout.ts:1183`），`SILVERHAND_CONVERSATION_ID` +
`SILVERHAND_AUTH_TOKEN` **烘进磁盘 shim**（`spawn-prep.ts:46-63`）。一进程服务 N 会话时前提失效；
「一进程持 N 个 per-conversation token」被否（shim 是一次性烘盘、N 随 join 动态变）。

**上一版把 principal 统一成 `(agent_id, generation)` 是错的**（@Cindy 第三轮 finding 2）：
conversation-scoped 的同一 Agent 同时有 N 个 slot、各自的 `generation` 都可能等于 7 ⇒ 该 tuple **指不出哪个
slot**，而且会让 A 会话的 runtime 凭 live membership 去操作 B 会话，**破坏旧模型现有的隔离**。

目标是 **principal algebra**（一条路由、一个 verifier、**两种 target policy**）：

```
RuntimePrincipal =
  | AgentSlot(agent_id, generation)                       -- session_scope='agent'
  | ConversationSlot(conversation_id, agent_id, generation) -- session_scope='conversation'
```

| principal | target 判据 |
|---|---|
| `AgentSlot` | **live membership**（每请求查） |
| `ConversationSlot` | live membership **且** `target == slot.conversation_id`（隔离与今天等价） |

这不是两套 auth 权威，而是一个类型的两支：签发端由 slot 行决定签哪一支，verifier 先解构再套对应 policy。
**世代校验必须显式**：`AgentTokenStore` 是 per-process in-memory Map，只有显式 `revoke` / `revokeFor`，
**没有 generation 概念**（`auth/agent-token-store.ts`）。⇒ verifier 每请求把 token 的 generation 与
**live slot generation** 比较，不等即 401；`revokeFor` 退化为加速路径而不是正确性来源。

**路由代数**：终局是**一条**路由 `/internal/agents/:aid/*` + 上面这**一个** principal 类型（不是两条路由）。
过渡期旧 `/internal/conversations/:cid/agents/:aid/*` 作**桥**，删除条件可观测（无 runtime 在用它）。
「被移出会话就杀 runtime」从此是 **runtime lifecycle policy（按 `session_scope` 取值）**，不是 auth 机制 ——
两根轴分开，才能同时满足「conversation-scoped 行为不变」和「agent-scoped 只拒 target」。

### 7.2 全 CLI frame（#2005 要求「all authorized CLI message/task/file/schedule surfaces」）

没有 ambient conversation 之后，每个面都要显式携带目标；**只改 `message --target` 不够**：

| 面 | 目标寻址 | 额外 frame |
|---|---|---|
| `message send` / `history` / `search` / `react` | `--target`（channel / `thread:<root>` / `dm:@handle`） | —— |
| `task *` | **全局 `tasks.id`**（§4.5）；`create` 用 `--target`，board 由它派生（§7.2.1） | provenance = source message |
| `file upload/update/view` | conversation（attachment 本就 conversation-owned） | —— |
| `schedule create/list/cancel` | 目标 conversation | 触发时唤醒该 target |
| `thread follow/unfollow`、`member add`、`channel create` | 目标 conversation / workspace | —— |
| 任何写文件的工具动作 | —— | **绝对 workdir**（cwd = agent root，相对路径会静默写错） |

#### 7.2.1 task 的坐标：target ≠ board，且 origin 不是服务端能推出来的

「在 `dm:@shiki` 里被要求为频道 A 建 task」这句话里有两个必须分开的坐标，**只有一根是命令参数**：

1. **task target** = `#silverhand/A`（或 `#silverhand/A/thread:<root>`）—— **agent 显式传 `--target`**。
   它决定 `tasks.conversation_id`、task 事件的投递位置、讨论上下文与 ACL（§4.4）。
2. **board** = 由 target conversation 的 placement **派生**（`workspace` 支 → 该 WorkspaceBoard；
   其余支 → §9 裁定的 board）。**不提供 `--board`**：两根参数会互相矛盾，而 placement 已是唯一权威。

```bash
silverhand task create --target '#silverhand/A' --title '……' --body
```

`--target` **不排除 DM**：`--target 'dm:@shiki'` 建的是这条私线自己的 task（ACL = 私线参与者，
**不进** A 的 board）。能力完整，靠 target 区分意图，不靠模型猜「这句话属于哪」。

**command origin 审计承诺删除**（@Cindy 第三轮 finding 3 —— 上一版写「服务端从 delivery frame 自动记录」，
那是**虚构的 authority**）：Agent-generation token + `--target` 的 HTTP 请求到达时，server **无从得知**它是由
哪条投递引发 —— 静态 shim 里没有这个关联，同一 session 内多次 steer 更没有。「取最近一条消息」是猜。
⇒ 本设计**不承诺** command origin 审计。若将来要，只有一条合法形态：**agent 显式传不可变
`origin_message_id`，verifier 校验它确实是投递给该 principal 的消息**；不得由 server 推断。

**source message 的约束保留**：`source_message_id` 必须与 task 同 conversation。⇒ 在 DM 里为 A 建 task 有两条
合法形态：(a) body 自带上下文、source 留空；(b) 先向 A 发一条简短消息，再以那条 A 消息作 source。
**禁止**让 A 的 task 引用 DM 消息 —— 要么向 A 泄露私线内容，要么让 A 的成员永远看到不可访问的 provenance。

**mutation 一律解析到全局 `tasks.id`**（§4.5）：`task detail/edit/status` 在 agent-scoped runtime 下没有
ambient board 可依，局部 `#task:<n>` 只在「当前 board 已由 `--target` 给定」时可用。

同一 turn 内先收到 A 的消息、再被 steer 去别处时，**仍逐次显式复用收到的 `target`**；CLI 层可以提供复制便利，
但**不得**恢复 ambient `SILVERHAND_CONVERSATION_ID` 默认值 —— 那正是 steer 误投的成因。

### 7.3 cwd：三档确定性坐标（沿用 v64 invariant I1）

v64 已确立：workspace 不在 DB 里拥有路径，bundle 解析到终局确定性坐标
`<agent home>/workspaces/<workspace_id>`，每台 host 同一算法、无 DB 列无 registry。补齐缺口：

| RuntimeScope | cwd |
|---|---|
| `Agent(aid)` | `<agent home>` |
| `Conversation(cid,aid)` + workspace placement | `<agent home>/workspaces/<workspace_id>`（现状不变） |
| `Conversation(cid,aid)` + **workspace-less** | `<agent home>/conversations/<conversation_id>` |

进程 cwd 就是唯一被硬保证的 runtime base（`supervisor/index.ts:2142/2269/2281/5374`），claude/qoder 按
**cwd slug hash** 定址厂商 session（`session-migration.ts:117/128/144`）⇒ 复用 agent root 会把本应隔离的
workspace-less 会话并成一条 session；cwd 随会话变动会让 agent-scoped 分叉。

### 7.4 其余落位

**pidfile** `<root>/<daemonInstanceId>/<enc(cid)>-<enc(aid)>.json`（`runtime-pidfiles.ts:70-97`）⇒ 显式 scope
命名空间（`agent/<aid>.json` vs `conv/<cid>-<aid>.json`）；空 cid 产出 `-<aid>.json` 与 orphan reconcile 冲突。
**system prompt** 每 spawn 渲染，agent-scoped 不能再声明「cwd 就是工作区」。
**steer 降级** `drivers/index.ts:92 releaseProfile`，须读 live per-spawn 实例（qoder 在 `bindRuntimeVersion`
决议）；`one-shot`/`next-turn-batch` 无法中途接受跨会话 steer ⇒ **显式排队 + 顺序可见**，禁止静默丢。
**freshness** `spawn-prep.ts:54` 是单标量 `last-delivered-seq` ⇒ 必须 per-stream ledger。

---

## 8. 迁移 DAG

**migration version 单调 ⇒ 所有改 schema 的票串行落地**；能并行的只是编写。**没有任何一步允许先抹语义。**

```
P0-a placement × roster_policy（kind 降级为派生桥）
  ├─ P0-b AgentInbox（Mentions 迁离 workspace_id + CC dedupe UNIQUE）
  ├─ P0-c conversations.name（partial UNIQUE + 保留表）
  └─ P0-e endpoint identity 存活（endpoint 列去 FK + 删除事务打 endpoint tombstone；**不改全系统软删**）
        └─ P3 DirectPair（endpoints + 派生 pair_key + ACL 派生解析器）
              └─ P4 DeliveryTarget（含 §6 的 reference/recipient invariant）
P0-d runtime slot 拆分（slot / CAS / observation / resume + scope 一致性 trigger）
  └─ P1 RuntimePrincipal 判别联合 + /internal/agents/:aid/*（含世代比较与两种 target policy）
        └─ P2 session_scope + RuntimeScope 分派 + 三档 cwd + scope 化 pidfile
P0-g 全局 task identity 成为 canonical resolver（§4.5；task mutation 不再依赖 ambient board）
P0-f Board：AgentBoard（new-row-only；legacy agent_home 原地不动）（§9 裁定后）
  └─ P6 终局清理：删 kind 桥 + 删 workspaces 的 agent_home 支
        （前置：**零 legacy conversation-scoped Agent / 零 home / 零 home 内会话**，不是「读点清零」）
P5 端到端 slice ← 全部
```

**Falsifier**（逐票，缺一即不通过）：

- **P0-a** 行为零变化：14 行 `dm_channel` 仍私有、roster 仍不可变更、`kind` 派生值与迁移前逐行相同；
  非 workspace placement 的会话在 list/search/favorites/saved/task 全可见；`visibility` 无法被设成
  `public` + `roster_policy='fixed'`。
- **P0-b** agent 无任何 workspace 归属会话时 CC 仍投递成功；并发只一行；**在写入 CC 后杀进程、再重放 source
  message，第二次写入被 UNIQUE 拒绝 ⇒ 收件箱里恰好一条**（§5）。
- **P0-c** 改 `title` 不改 target 解析结果。
- **P0-e** 硬删一个 endpoint principal：**删除成功**（不是 ABORT）、DM 与历史保留、survivor 只读、
  endpoint 显示为 tombstone 而非「id 不存在」；**`agents`/`users` 的删除路径与今天逐格相同**（没有引入软删）。
- **P0-d** conversation-scoped 行为零变化（status SSE、`cliSessionId:null` 竞态等价于
  `outbound-event-fanout.ts:781`）；ACL 读面不再与 runtime 写同行；**换 daemon 后每 scope 仍只有一行 slot**；
  agent-scoped agent 插 conversation slot（及反向）被 DB 拒。
- **P1** 移出某会话后该 target 被拒而 runtime 存活；**generation++ 后旧 token 立即 401**（不依赖显式 revoke）；
  **`ConversationSlot` token 对 `target != slot.conversation_id` 一律拒**（即使 live membership 通过）——
  旧模型隔离逐格不变；旧路由行为不变。
- **P2** 跨多 workspace 工作后 vendor session 仍 resume 同一条；`UPDATE agents SET session_scope` 被 DB 拒；
  两套 pidfile 不互相 reconcile 掉。
- **P3** 并发同 pair 只一行；`UPDATE` endpoints / `pair_key` 被 DB 拒；endpoint kind/id 不合法被拒；
  DM 成员变更 API **不存在**；`participantsOf` 是唯一 ACL 解析入口（静态闸）。
- **P4** 任何持久字段或跨 principal 读面出现字面 `dm:@…` 即不通过；**B 中引用 A-only 成员：B 的 follower/
  recipient 不变、A 无投递、unresolved 可观测**。
- **P0-g** 无 `--target` 也能 `task detail/edit/status <global-id>`；跨 conversation 复制 canonical ref 后仍指向
  同一 task；**无权 viewer 拿到与「不存在」不可区分的拒绝**；局部 `#task:<n>` 仅在 board 已给定时可用。
- **P0-f** 39 条 legacy task **零搬迁零重编号**；**同一 AgentBoard 上另一位 human 的私线 task 不可见**
  （ACL 逐 task 由 `conversation_id` 判，不由 board）。
- **P6** 删 `agent_home` 支前：零 legacy Agent / 零 home / 零 home 内会话；删 `kind` 桥前：29 个文件 / 118 处
  读点清零。
- **P5** A 中 agent-scoped 工作 → B steer → `dm:@shiki` 回复 → A 继续，且同一 conversation 内另有
  conversation-scoped agent 同时工作；`agent_status` 对有权 viewer 给绝对 target、对无权 viewer 给
  `focus='other'` + 队列深度。

有利条件：`session_scope` 不可变 ⇒ **无 scope 转换器、无 per-item 迁移状态机**；两类靠 placement + slot 键
天然并存，现有 agent 永久 conversation-scoped。

---

## 9. 待人类裁定

**Board 归属**（§4.4）。三个方案，需 @shiki 裁一次：

| 方案 | DM 里建的 task 归谁 | 代价 |
|---|---|---|
| **A（我的）** `WorkspaceBoard \| AgentBoard`，AgentBoard **new-row-only** | 新 agent-scoped Agent 的私线 task 进它的 AgentBoard；legacy `agent_home` 原地不动 | **零搬迁、零重编号**；ACL 逐 task 由 `conversation_id` 判（board 不是 ACL 单位） |
| B（@Cindy 2026-08-14 02:02） `WorkspaceBoard \| DirectPairBoard(pair)` | 每条私线一个 board、各自从 1 编号 | 每对 principal 一个新编号空间；board 数量随 pair 增长 |
| C（@Cindy 早先） 只有 WorkspaceBoard，workspace-less 会话建 task 必须显式选 workspace | 不存在 DM-local task | CLI surface 不完整 |

A 与 B 的实质分歧只有一条：**「私线里的私人事项」是按 agent 聚成一个个人板，还是按 pair 各自成板。**
A 认为一个 agent 的私人待办天然是一份清单（且今天的 `agent_home` 就是这样存的）；B 认为 board 应与
conversation placement 同构。两者都支持 `--target 'dm:@handle'`，都不进 workspace 的 board —— 能力面相同，
差别是编号空间数量。**两者都不再决定 Task identity**（§4.5：identity 恒为全局 `tasks.id`），
也都不决定 ACL（恒为逐 task 的 `conversation_id`）。

**可复制的限定 / canonical task 地址**：@shiki 已裁定 Task 会升级为 `silverhand://` URI 的一等对象，
**但协议设计与实现不进入本 feature**（§4.5）。本 doc 只承担「identity 恒为全局 `tasks.id`、mutation 不依赖
ambient board」这两个接口条件；**不预写文法**。

---

## 10. 被否方案与其失效形态

| 方案 | 失效形态 |
|---|---|
| P0-a 就删 `kind` | 118 处读点 + wire literal 失去判别式，而 DirectPair 到 P3 才存在；14 行私有会话的 fixed-roster 语义无处落 |
| 把现有 `dm_channel` backfill 成 DirectPair | 实测同一 pair 有 4/3/2/2 行 ⇒ `UNIQUE(pair_key)` 直接冲突 |
| `visibility='private' OR placement_kind='workspace'` | 会允许 public 的固定 roster 会话；忠实改写是 `roster_policy='open'` |
| 无迁移地删 `workspaces` 的 `agent_home` 支 | 14 条会话 + 39 条已编号 task 无家；#2005 只授权「新 agent-scoped 不创建」。删除前置件是「零 legacy Agent/home/会话」，**不是**「`kind` 读点清零」 |
| 把 `agent_home` 直接降级成 AgentBoard（搬迁现有行） | 与「DirectPair 只承接新行」不同构；旧 home 还挂着 cwd / L2 / vendor session，降级即一次全量迁移 |
| principal token = 扁平 `(agent_id, generation)` | conversation-scoped 同一 agent 有 N 个 slot、generation 可同值 ⇒ 指不出 slot，且 A 的 runtime 能凭 live membership 操作 B，破坏现有隔离。正解是判别联合 + 两种 target policy |
| 「服务端从 delivery frame 自动记录 command origin」 | Agent token + `--target` 的请求到达时 server 无从关联投递；「取最近一条消息」是猜 ⇒ 虚构 authority。要么不承诺，要么显式可校验的 `origin_message_id` |
| Mention CC 只靠 source replay（无写入时 dedupe） | source 行只证明输入存在，不证明副本已写 ⇒ 崩溃重放重复投递。必须配 `(source_message_id, conversation_id)` UNIQUE |
| 为 CC 幂等新建 outbox / per-item 状态机 | 副本自带 source 键 + UNIQUE 已经足够；新表是不必要的持久状态面 |
| 把 `agents`/`users` 整体改软删当 P0-e 前置件 | 牵动全部 FK cascade、handle 唯一性、登录/list、`created_by`、teardown；本 feature 只需要 endpoint 侧身份存活 |
| Board 当 ACL 单位 | 一个 AgentBoard 聚合多位 human 的私线 ⇒ 另一位 human 会看到别人的私线 task。ACL 必须逐 task 由 `conversation_id` 判 |
| 局部 `task_number` 当跨 conversation identity | agent-scoped 无 ambient board ⇒ `task detail <n>` 不可解析；identity 必须是全局 `tasks.id` |
| `agent_status` 一律只显示「本会话忙」 | 失去可解释性；正解是按 viewer 权限分档（有权 → 绝对 target，无权 → `focus='other'` + 队列深度） |
| endpoints 投影成成员行 + 拒绝型 trigger | 保证不了投影存在；且实测 cascade 会触发子表 trigger ⇒ `DELETE FROM agents` 整条 ABORT，不是 tombstone |
| `Board = Workspace \| Conversation` | 要求 39 条 task 重编号，并新造一层歧义换取零收益 |
| 「一 scope 一 slot」但 UNIQUE 含 `daemon_instance_id` | 换 daemon 即有两行自称当前 |
| 把 `status/pid` 与 `cli_session_id` 当同一种 DB 权威 | 前者是 daemon 观测投影、后者是持久 resume state；混为一谈会在崩溃后清掉可 resume 的会话 |
| 靠保留退出行记历史 | authority 查询无法判断哪行当前；历史该进 append-only 事件表 |
| Create/start/delete 标「同 tx」 | 现网就是 reserve→materialize→finalize / durable intent→purge→CAS，OS 进程进不了 SQLite tx |
| Mention CC「commit 后可重试」而无重放判据 | `post-commit` 是 best-effort + `logger.warn` ⇒ 崩溃即永久丢 CC |
| 「generation 自增即旧 token 失效」而 verifier 不比较 | token store 是 in-memory Map、无 generation 概念，旧 token 继续有效 |
| 保留两套 auth 路由长期共存 | 永久双权威；正确形态是单路由 + 按 `session_scope` 取值的 lifecycle policy |
| 「wire 保持现有 `agent_status` 形状」 | 现 payload 无 focus/pending/queue，与「N 会话解释一个 runtime」矛盾 |
| `UNIQUE(scope_kind, conversation_id, …)` | SQLite 下 NULL 互不相等 ⇒ agent scope 可重复插 |
| 「schema 无 UPDATE 路径」当约束 | SQL 仍可 UPDATE，必须 trigger |
| 「一事务只写一个聚合」blanket rule | 留下 conversation 已建而 endpoints 未落的半状态 |
| `pair_key` 由 handle 派生 | handle 是公开寻址面；内部身份必须用 `(kind,id)` 与之解耦（#2005 原文） |
| workspace-less 会话复用 agent root 当 cwd | vendor storage 按 cwd 定址 ⇒ 本应隔离的 session 被合并 |
| 把 file/saved/favorite 塞进 Board | attachment 本就 conversation-owned 且无 workspace_id；saved/favorite 是 user-owned state |
| 单标量 seq 复用多流 | 静默漏投 / 重投 |
| `busy/focus` 投影当写权威 | 多流聚合写回会丢单流状态 |

---

## Acceptance

失败条件 = §5 的 saga 分档被降级为「同 tx」、§8 各票 falsifier 任一不通过、§10 任一被否形态出现。

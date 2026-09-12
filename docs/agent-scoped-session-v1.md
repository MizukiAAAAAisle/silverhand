# Agent-scoped Session v1 —— DDD 目标模型与改造路径

> TS backend 退役说明：文中的 `packages/backend` / `packages/server` 源码与测试坐标属于迁移期历史，已从当前仓库删除；现行控制面位于 `rust/crates`。迁移权威仍在 `packages/shared/src/db`，独立回归数据在 `rust/test-fixtures`，现行构建与验证见 [testing.md](testing.md)。

Status: **design under review**（设计 @Alice，#task:2009；review gate @Cindy）。
产品语义权威 = **#task:2005 的 Acceptance Summary**；本 doc 是**技术目标模型的单一权威**，#task:2009 的 body
只保留可独立验收的 Acceptance Summary，不复制正文。

**事实来源纪律**：schema 断言只引 `packages/shared/src/db/migrations.ts`（`baseline-schema.ts` 是 v0 快照，
按它设计会把 v53/v54/v64 已删除的概念写回模型）；现网数据形态引 `~/.silverhand/embedded-server-backup-*`
的只读快照（app 运行时不得打开活动 DB）；SQLite 语义写进 doc 前实测。

**已退役的一支（#task:2072，v84/v85）**：`agent_inbox` placement 连同 `conversations.inbox_agent_id`
及其拒绝码整代删除，现役 placement 字母表 = `{ workspace, direct_pair }`；mention CC 的落点是
「被提及 agent ↔ 提及者」的那条 direct pair。⇒ 本 doc 中所有 AgentInbox / `inbox_agent_id` 段落
（§3.1、§4.1、§4.2 末、§4.4、§5、§7、§9.3、备选方案表）**一律读作设计期记录，不是现役模型**；
现役 placement 权威是 `docs/placement-contract.md` §1。凡以 inbox 存在为前提的验收条目**作废**，
不是重新解释 —— 特别是「向 inbox 建 task 由 trigger 拒」：落地形态是 `tasks.board_key` 的互斥弧 CHECK
（`ws:%` ⇔ `workspace_id IS NOT NULL`），穷尽两支即可，从未需要那条 trigger。

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

| 量                                  | 值                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `kind='dm_channel'` 行数            | **14**，成员基数**全部**是 (1 agent, 1 user)                                  |
| 它们所在 workspace                  | **全部 `workspace_kind='agent_home'`**（7 个 home，无一在 regular workspace） |
| 同一 (human, agent) pair 的 dm 行数 | **4 / 3 / 2 / 2 / 1 / 1 / 1**                                                 |
| agent_home 内的 task                | **39**                                                                        |
| agent_home 内的 saved_messages      | 0                                                                             |

两个结论直接改写了目标模型：

1. **`kind='dm_channel'` 今天不表示「与 X 的那个 DM」。** 同一对 (human, agent) 有 **4 条**这样的会话
   （标题是 "mac mini" / "pod ops" / "working with ai" 之类自由标题）。它表示的是「roster 固定为 home owner
   - 该 human 的私有会话」。⇒ **`UNIQUE(pair_key)` 的 DirectPair 无法承接这批行**（11 行会塌成 4 个 pair 键冲突），
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
  - `Placement` = `Workspace(workspace_id)` | `DirectPair(endpoints)` | ~~`AgentInbox(agent_id)`~~（#task:2072 已退役，见页首）—— **住在哪**；
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
  workspace_id   TEXT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  inbox_agent_id TEXT NULL REFERENCES agents(id) ON DELETE CASCADE,   -- ← 见 §4.2 末
  endpoint_a_kind TEXT NULL, endpoint_a_id TEXT NULL,
  endpoint_b_kind TEXT NULL, endpoint_b_id TEXT NULL,
  pair_key TEXT NULL,                            -- 由 endpoints 规范排序派生
  -- 兼容读面：由 roster_policy 派生的 GENERATED 列，不是第二权威（见下）
  kind TEXT GENERATED ALWAYS AS
       (CASE WHEN roster_policy = 'open' THEN 'channel' ELSE 'dm_channel' END) VIRTUAL,
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

| 现状                                          | placement     | roster      |
| --------------------------------------------- | ------------- | ----------- |
| `kind='channel'`                              | `workspace`   | `open`      |
| `kind='dm_channel'`（14 行，全在 agent_home） | `workspace`   | **`fixed`** |
| 新的产品级 DM（`dm:@handle`）                 | `direct_pair` | `fixed`     |
| Mentions                                      | `agent_inbox` | `fixed`     |

`kind` 在 v69–v78 期间是 **SQLite GENERATED ALWAYS … VIRTUAL 兼容桥**，由
`roster_policy` 单向派生；它从来不是第二个可写权威。v79 在所有生产、wire 与测试读点改用
`placement_kind × roster_policy` 后删除该桥，不保留 TypeScript mirror、alias 或 wrapper。
过渡期由 DB 而非纪律证明单一权威：

- **单一权威由 DB 证明，不靠纪律**：实测 sqlite **3.53.2**（`better-sqlite3` 运行时；CLI 3.54.0 同）——
  `UPDATE … SET kind=…` 与 `INSERT (…, kind)` 都在**解析期**报 `cannot UPDATE/INSERT into generated column`。
  ⇒ 不存在「回填后漂移」这条失效路径。
- 过渡期旧读点可继续读取 VIRTUAL 生成列；v79 的静态闸要求终态读点为零，历史迁移 fixture 除外。
  （实测 `CREATE INDEX … (kind)` 通过 ⇒ 现有 `idx_conversations_workspace(workspace_id, kind, updated_at DESC)`
  可原样重建）⇒ P0-a 不需要为兼容读面改任何 repo。
- **派生式只读 `roster_policy`**，不读 `placement_kind`：`direct_pair` / `agent_inbox` 都是 `fixed` ⇒ 对旧客户端
  呈现为「私有、固定 roster 的会话」，与它们今天对 `dm_channel` 的理解一致；而 `workspace`+`fixed`（现有 14 行）
  仍派生出 `dm_channel`，逐行与迁移前相同。
- **但迁移不是 `ALTER TABLE ADD COLUMN`（@Cindy 第五轮 finding 2，采纳）**：我上一版拿「VIRTUAL 可 ALTER ADD」
  当迁移可行性证据，那只证明了「生成列可以后加」，证明不了本例 —— 本例是**同名的普通列 `kind TEXT NOT NULL`
  已经存在**：SQLite 没有 alter-column-to-generated，`ADD COLUMN kind` 会撞名，`DROP COLUMN kind` 也过不去
  （`visibility` 的表内 CHECK 直接引用 `kind`）。⇒ **P0-a 明确是一次 `conversations` table rebuild**，
  与 v64 同一套既有 idiom（`migrations.ts` 已有三次 `conversations_new` → `DROP` → `RENAME`，
  `foreignKeyEscape: true` + 迁移后 `foreign_key_check`）：新表带 placement × roster_policy 与生成列 `kind`，
  `INSERT … SELECT` 逐行回填两列派生值，`DROP TABLE conversations`，`RENAME`，再显式重建全部索引。
  生成列只是**终态**，不是迁移手段。
- **删除条件可观测且是一步 DDL**：wire epoch bump 后无客户端读它 + 29 个文件读点清零 ⇒ `DROP COLUMN kind`
  （届时不再有 CHECK 引用它 —— `visibility` 的 CHECK 在 P0-a 已改写为读 `roster_policy`）。
  在此之前它是「有观测删除条件的短期桥」，不是长期 shim；它的收敛**只依赖读点与 wire epoch**，
  与 `agent_home` 行的存亡无关（两件事独立，见 §8 与 §9.2）。

**P0-a 的 rebuild 验收面**（比「新列有了」严得多，因为 rebuild 的失效方式是**静默丢约束**）：

1. 重建后 `conversations` 的**全部** surviving column / column-level CHECK / table-level CHECK / FK / index /
   trigger 与预期 DDL 逐项相同（对 `sqlite_master` 的 `sql` 取规范化 **schema fingerprint** 并断言，
   不是抽查若干列）。特别点名：`visibility` 的 CHECK 必须从 `kind='channel'` 改写为 `roster_policy='open'`；
   三个 `idx_conversations_*` 必须全部重建（rebuild 会连带丢索引，这是最容易漏的一项）。
2. **数据逐行一致**：迁移前后按 `id` 全表比对所有保留列；并逐行断言派生的 `placement_kind` / `roster_policy`
   与 §4.1 回填表一致、`kind` 的派生值与迁移前**逐行相同**（14 行 `dm_channel` 仍是 `dm_channel`）。
3. `foreign_key_check` 迁移后为空（`DROP TABLE` 期间 FK 关闭 ⇒ 必须显式复验，否则孤儿无声）。
4. 写 `kind`（`UPDATE` / `INSERT`）在解析期被拒；`visibility='public'` + `roster_policy='fixed'` 被 CHECK 拒。

### 4.2 DirectPair / AgentInbox：ACL **派生**自 placement，不投影成员行

旧稿让 endpoints 投影成 `conversation_agents` / `conversation_users` 行并用 `BEFORE INSERT/DELETE …
RAISE(ABORT)` 守。两个理由否掉它：

1. **拒绝型 trigger 无法保证「投影一定存在」** —— 它只能挡错误变更，挡不住漏建。
2. **它会把 actor 删除整个 abort。** 实测（sqlite 3.54.0）：`conversation_agents.agent_id … ON DELETE
CASCADE` 的级联删除**会**触发子表 `BEFORE DELETE` trigger，`RAISE(ABORT)` 上抛后 `DELETE FROM agents`
   整条失败、agent 存活。而 `agent-repo.ts:571` 今天就是硬删 `DELETE FROM agents WHERE id = ?`。
   ⇒ 该设计不是 tombstone，是**让删除失败**。

目标形态：**participant set 由 placement 派生，单一权威、无投影**。

| placement             | participants                                                         |
| --------------------- | -------------------------------------------------------------------- |
| `workspace` + `open`  | `conversation_agents` / `conversation_users` roster 行（现状）       |
| `workspace` + `fixed` | 同上，但 roster 变更 API 不可达（现有 14 行沿用现状）                |
| `direct_pair`         | **两个 endpoint 列**（无 roster 行）                                 |
| `agent_inbox`         | `inbox_agent_id` 一个 owner（无 roster 行）—— **已退役，#task:2072** |

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

**AgentInbox 的删除路径（@Cindy 第四轮 finding 2；与 endpoint 恰好相反，必须分开写）**：inbox **有唯一 owner、
没有 survivor** ⇒ 它是 **Agent 聚合的一部分**，与 owner 同生共死，而不是历史坐标。

- `inbox_agent_id TEXT NOT NULL REFERENCES agents(id) **ON DELETE CASCADE**`（本支非空由互斥弧 CHECK 保证）。
- **这不是新语义，只是把今天的链条缩短一环**：今天 `workspaces.owner_agent_id … ON DELETE CASCADE`
  （`migrations.ts:1051`）→ `conversations.workspace_id … ON DELETE CASCADE` → messages 级联，删 agent 时
  Mentions 会话就是这样消失的。AgentInbox 不再挂 workspace，所以那条 cascade 必须由 `inbox_agent_id` 自己提供。
- **它不与 §4.2 的「endpoint 不带 FK」矛盾**：两者是不同的边 —— endpoint 是**历史 principal 坐标**
  （对端删除后 DM 必须存活）；`inbox_agent_id` 是**所有权边**（owner 删除后 inbox 无意义）。判据是「有没有
  survivor」，不是「要不要 FK」这种一刀切。
- **CC 副本反过来不能被 source 拖走**：CC 行的 `cc_source_message_id`（§5）是**历史坐标、不带 FK**，
  否则删掉源会话就会把别人收件箱里的既有通知一起删掉 —— 那是追溯改写认知，违反 §0 第三条。

### 4.3 Runtime：四件不同的东西，不是一行

旧稿「一 scope 一当前 slot」与 `UNIQUE(…, daemon_instance_id)` 自相矛盾（换 daemon 就有两行都自称当前），
而且把三种不同权威的字段并成了「DB runtime aggregate」。拆开：

| 关注点                                                    | 权威                                          | 落位                                                     |
| --------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------- |
| **slot identity**（这个 scope 的 runtime 名额）           | DB                                            | `agent_runtime_slots`：**按 scope 唯一**，不含 daemon id |
| **generation**（这一代的身份 + 抢占）                     | DB，**CAS**                                   | slot 行上单调递增，`UPDATE … WHERE generation = ?`       |
| **进程观测**（`status` / `pid` / liveness / 当前 daemon） | **daemon/supervisor**，DB 是 event projection | slot 行上明确标注为 projection 字段，不作判据            |
| **resume state**（`cli_session_id`）                      | 持久厂商状态                                  | 独立列，**不随进程退出清空**                             |
| **历史世代**                                              | append-only                                   | `agent_runtime_events`（不靠保留退出行来记历史）         |

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

目标：**`Board = WorkspaceBoard(workspace_id) | DirectPairBoard(pair_key)`**，且 **board 由 target
conversation 的 placement 派生**（`--board` 不存在）。

**上一版的 AgentBoard 已撤回**（@Cindy 第四轮 finding 4，我确认这是决定性反例、不是迁移偏好）：
`AgentBoard(agent_id)` 对 DirectPair **不是全函数** —— agent↔agent 的私线同时对应**两个** AgentBoard
（谁的板？取决于谁在调用 ⇒ board 变成 actor-dependent），human↔human 的私线**一个都没有**。
而「board 由 placement 派生、不提供 `--board`」是 §7.2.1 的承重不变量 ⇒ 两者不能同时成立，必须换 board。

派生表（**全函数，非法弧由 DB 拒**）：

| placement     | board                          | 说明                                                                                                                                                                                        |
| ------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace`   | `WorkspaceBoard(workspace_id)` | 含 `agent_home`（现有 14 行会话 **原地不动**，新建的 home 同样走这一支，§9.2）                                                                                                              |
| `direct_pair` | `DirectPairBoard(pair_key)`    | 每条私线一个编号空间，与 placement 同构；agent↔agent 与 human↔human 都只有一个解                                                                                                            |
| `agent_inbox` | **无 board**                   | Mentions 是通知读面，不是工作面 ⇒ 向 inbox 建 task 一律拒（trigger），不是「静默落到某处」。**该 placement 已退役（#task:2072）**：两支穷尽后由 `board_key` 的互斥弧 CHECK 承担，无 trigger |

**零搬迁在 B 下同样成立**（这是我原先反对 B 的唯一理由，已被「旧行保持旧形态、新概念只承接新行」消解）：
`agent_home` 永久属于 `workspace` placement ⇒ 它就是 WorkspaceBoard，现有 14 条会话与 39 条 task
**零搬迁零重编号**；DirectPairBoard 只承接新建的 DirectPair 会话。

编号落位（**一个 namespace 列 + 一条 UNIQUE**，不是每支一套）：

```sql
tasks:
  + board_key TEXT NOT NULL          -- 'ws:'||workspace_id | 'pair:'||pair_key
  workspace_id TEXT NULL REFERENCES workspaces(id) ON DELETE CASCADE,  -- 由 NOT NULL 放宽
  CHECK (穷尽互斥弧：board_key 前缀与 workspace_id 是否为 NULL 一致)
DROP INDEX uniq_tasks_workspace_number;                       -- (workspace_id, task_number)
CREATE UNIQUE INDEX uniq_tasks_board_number ON tasks(board_key, task_number);
-- board_key 由 target conversation 的 placement 在 INSERT 时物化；BEFORE UPDATE OF board_key → RAISE(ABORT)
-- BEFORE INSERT：target conversation 的 placement_kind='agent_inbox' → RAISE(ABORT)
```

`board_key` 对 legacy 行是 `workspace_id` 的**纯函数** ⇒ 回填后 `(board_key, task_number)` 与
`(workspace_id, task_number)` 逐行同解，39 条 task 的编号逐个不变。`tasks.workspace_id` 放宽为 NULL 只影响
「按 workspace 收窄」的读面（`idx_tasks_status_number` 不含 workspace_id，跨板 keyset 不受影响）。

**Board **不是** ACL 单位**：DirectPairBoard 天然只含该 pair 的 task，但这**不是**可以拿 board 当 ACL 的理由 ——
WorkspaceBoard 仍聚合多条会话、且未来的 board 形态可能再变。⇒ **ACL 一律逐 task 从 `tasks.conversation_id`
派生**（走 §4.2 的 `participantsOf`）；Board 只提供**编号命名空间 + 聚合视图**。

其余三个「归属」各自建模，不进 Board：

- file：`attachments.channel_id → conversations`，本来就 conversation-owned、**没有 workspace_id**；
- saved / favorite 是 user-owned state：`saved_messages.workspace_id NOT NULL` 是**冗余派生列**
  （conversation 已决定它），改为可派生 / 可空 + placement-aware 分组键；favorites 的
  `list_key='channels:'||workspace_id`（`favorites.ts:153`）同样按 placement 派生。

已撤回的两版：`Board = Workspace | Conversation`（要求 39 条 task 重编号）、`Board = Workspace | Agent`
（对 DirectPair 不是全函数）。**B 已由 @shiki 2026-08-14 02:41 裁定采用**（§9.1）。

### 4.5 Task identity 是全局的，Board 只是局部编号

`tasks.id TEXT PRIMARY KEY` 已经是全局不可变身份；缺的不是一列，而是**把它提升为协议里的 canonical
address**。这在本 feature 里是**承重件而非可选改进**（@Cindy 第三轮 finding 6）：没有 ambient conversation 之后，
`task detail/edit/status <n>` 无从解析 —— 局部编号必须靠一个 board 才有意义，而 agent-scoped runtime 同时面对
N 个 target。

- **所有 task mutation 与跨会话引用最终解析到 `tasks.id`**；`#task:<n>` 只是**当前 board 的 shorthand**。
- **canonical 文法本身 out of scope**（@shiki 2026-08-14 02:11 裁定：Task 会升级为 `silverhand://` URI 的一等
  对象，协议设计与实现另开票 = **#task:2011**）。本 doc 只守两个接口条件：①`tasks.id` 是全局不可变 identity，
  agent-scoped 的 task mutation 不依赖 ambient board；②Board 只管**编号命名空间与聚合视图**，
  **不管 ACL**（ACL 恒为逐 task 的 `tasks.conversation_id`，§4.4），局部 `task_number` 永不充当跨 conversation
  identity。现状事实、两轴（寻址 vs 导航）异议、以及 kind-derived addressability 这条前置约束**已全部移交
  #task:2011 的 body**，本 doc 不再复制。
- **全局 id 不豁免 ACL**：resolver 先做 live ACL 再返回，且「不存在」与「无权」必须是**不可区分**的同一种
  拒绝，否则 canonical ref 就成了 id 枚举探测面。
- 不新增全局自增数字（全局取号热点 + 泄露任务总量）；现有 opaque id 更稳。

---

## 5. 生命周期与外部副作用（saga，不是「同 tx」）

旧稿把 `Create Agent` / `start/stop/respawn` / `Delete` 标成「同 tx」。**代码上不可能**，撤回：
`create-agent.ts` 是 reserve INSERT → `agent_materialize` wire intent → ack 交叉核对 → L3a dependent-row tx →
失败 `flipToFailed`；`agent-deletion-resumer.ts` 是 durable intent + host purge + 带 retry generation 的
CAS finalize。OS 进程与 host IO 不能进 SQLite tx。

规则（判据是**后果能否原子提交**，不是「跨了几个聚合」）：**凡是 DB 内可原子提交的后果一律同 tx，
即使跨聚合**（CC 副本就是这一类）；**只有跨进程 / 跨主机的后果**才走 durable intent + 外部副作用 +
ack/project + CAS finalize。

| 流程                | durable intent                                 | 外部副作用                 | ack / project     | finalize                          | 重试幂等键                                              |
| ------------------- | ---------------------------------------------- | -------------------------- | ----------------- | --------------------------------- | ------------------------------------------------------- |
| Create Agent(scope) | reserve 行（`agents.name` UNIQUE）             | `agent_materialize`        | 典型 ack 交叉核对 | dependent-row tx / `flipToFailed` | reserved row id                                         |
| Start / respawn     | slot 行 + `generation++`                       | daemon spawn               | `observed_*` 投影 | CAS on `generation`               | `(scope, generation)`                                   |
| Stop / crash        | slot 行状态意图                                | daemon signal              | 同上              | CAS                               | `(scope, generation)`                                   |
| Delete Agent        | 现有 durable deletion intent                   | host purge                 | purge count       | CAS finalize（现状）              | attempt id                                              |
| **Mention CC**      | **副本行本身**（与 source message 同 tx 写入） | 唤醒 / 通知（best-effort） | ——                | 同 tx commit                      | **`(source_message_id, target_inbox_conversation_id)`** |

**Mention CC 的「commit 后可重试」旧稿是空口承诺**：`post-commit.ts` 的 effect 是 best-effort、失败只
`logger.warn`，**没有任何持久记录**⇒ commit 后崩溃即永久丢 CC（正是今天 `warn`+`return` 的同族缺陷，
只是换了触发条件）。

第三版改成「source replay + 写入时 UNIQUE receipt」，**仍不够**（@Cindy 第四轮 finding 3，我确认）：
重放要在**崩溃之后**重算一次收件人，而收件资格是**时变的** —— membership、handle 解析、placement、
inbox 是否存在都可能已经变了 ⇒ 重放写出的副本可能与 send 当时应得的那份**不是同一份**，而 UNIQUE 只能挡
「同一键写两次」，挡不住「算出了另一个键」。这不是幂等问题，是**权威时点**问题。

**最终形态（简化，不是加层）：CC 副本行在 source message 的同一事务内按 send-time plan 原子写入。**

- send 边界已经在同一 tx 内解析 reference 并算 follower / recipient plan（#2000 的硬约束：一次 send 一次解析）
  ⇒ **CC 的收件人集合就是那份 plan 的一部分**，与 source message 同生共死。目标 inbox 的 get-or-create 也进
  这个 tx（§5 末尾的「同 tx 清单」）。
- ⇒ **不需要 replay，也不需要 intent 表**：没有「commit 后还要再做一次决定」的窗口，因此没有可丢的东西。
  崩溃只有两种结果：整个 send 未提交（消息不存在），或 message + CC 副本一起存在。
- **post-commit 只剩唤醒 / 通知**：它现在只是**投递提示**而非事实创建 —— 丢了只延迟一次唤醒，收件人下次读
  inbox 就看到那条已在库里的副本（unread 由 §6 的既有账目派生，不依赖 post-commit）。
- `UNIQUE(cc_source_message_id, conversation_id)`（partial，仅 CC 行）**保留**，降级为并发/多写入路径的
  安全带与「恰好一条」的静态证明，不再承担正确性主责。
- **`cc_source_message_id` 不带 FK**（§4.2 末）：副本是收件人 inbox 里的独立事实，不随源会话删除消失。

被否：只有 source replay 而无写入时判据（重复投递）；replay + UNIQUE（重算收件人 ⇒ 权威时点漂移）；
为 CC 幂等新建 outbox / per-item 状态机（同 tx 已经足够，多一张表只是多一份可漂移状态）。

同 tx 的只有这些：DM get-or-create（conversation + endpoints，**无投影行**）、~~AgentInbox 创建~~（#task:2072
退役后 reserve 只写一行 `agents`）、roster join/leave、send message（message + stream head + follower/recipient
plan + **Mention CC 副本**）、board 内 task 取号。

---

## 6. 读模型与投递合同

- list / search / favorites / saved / task 全部 **placement-aware**（含 `list_key` 与 saved 的分组键）。
- **`agent_status` 必须扩，不能声称「保持现状」**：现在的 payload 是
  `{agent_id, status, cli_session_id?}`（`status-projector.ts:127…`），**没有** `focus` / `pending` / `queue`。
  #task:2005 要求「UI derives **authorized** busy/focus/pending state from one runtime」⇒ 新增字段是新 wire
  surface，要定版本。**授权投影按 viewer 逐字段裁**（@Cindy 第三轮小项 2 —— 一律只显示「本会话忙」会丢掉
  可解释性）：

  | viewer 对 focus conversation 的权限 | 可见内容                                                                            |
  | ----------------------------------- | ----------------------------------------------------------------------------------- |
  | 有                                  | **绝对 target**（`#ws/channel`、`thread:<root>`、`dm:@handle`）+ 排队深度           |
  | 无                                  | `focus='other'` + 排队深度 —— 知道「在别处忙」但**不泄露**该会话的 id / 标题 / 对端 |

  ⇒ 「忙」永远可解释，而会话身份不经 presence 侧漏。

- **Delivery invariant = §0 第一条**（此处不复述，只补一句与既有模型的关系）：它与 #task:2000 的四层投递模型
  不冲突 —— 那里说的「thread reply 的 follower 插入能扩张收件人」，前提是**该 principal 已是本 conversation
  成员**；§0 管的是「不是成员的 principal 不因被引用而获得投递」。
- unread / activity 契约不变（#1967 的 plan 常量与 join 钉序继续有效）。

---

## 7. 凭据与 CLI frame

### 7.1 principal 是一个判别联合，不是一个扁平 tuple

终态：全部 agent-facing API 只挂 `/internal/agents/:aid/*`。路径只绑定 agent identity；bearer 内的判别联合
绑定 runtime slot、generation 与 daemon custody。`SILVERHAND_CONVERSATION_ID` 只注入 ConversationSlot，
AgentSlot 没有 ambient conversation；领域目的地由显式地址或对象 identity 提供。

**上一版把 principal 统一成 `(agent_id, generation)` 是错的**（@Cindy 第三轮 finding 2）：
conversation-scoped 的同一 Agent 同时有 N 个 slot、各自的 `generation` 都可能等于 7 ⇒ 该 tuple **指不出哪个
slot**，而且会让 A 会话的 runtime 凭 live membership 去操作 B 会话，**破坏旧模型现有的隔离**。

目标是 **principal algebra**（一条路由、一个 verifier、两种 runtime scope）：

```
RuntimePrincipal =
  | AgentSlot(agent_id, generation, daemon_instance_id)                       -- session_scope='agent'
  | ConversationSlot(conversation_id, agent_id, generation, daemon_instance_id) -- session_scope='conversation'
```

| principal          | verifier 判据                                                                 |
| ------------------ | ----------------------------------------------------------------------------- |
| `AgentSlot`        | live AgentSlot 的 exact generation + daemon instance                          |
| `ConversationSlot` | live `(conversation_id, agent_id)` slot 的 exact generation + daemon instance |

verifier 不接 destination，也不做 membership：它只证明“这份 bearer 现在仍拥有哪一个 runtime”。目的地先由
DeliveryTarget / object id 解析，再由 placement participation 与 C″ reach 表授权。把 conversation 塞回 URL
会重新制造第三个坐标，已由 #task:2030 删除。

**「隔离与今天等价」在拆分后必须按事实读，不能按字面读，而事实是逐门不同的**（`origin/main` 逐门核过，
@Cindy 的 C 提案迫使我把它量清楚；ConversationSlot 凭据 → destination ≠ 凭据那条 conversation）：

| 门                                                                   | `origin/main`                                                                | 闸门                                                     | P4（**已裁定 C″**）                                        |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| `read-history` / `search`                                            | **已发布跨流**（含跨 workspace）                                             | 目标会话 membership                                      | 两支都保留跨流（改为按址）                                 |
| `channels list` / `workspaces list`                                  | **已发布跨 workspace 读**（`?workspace_id=`）                                | `canAgentAccessWorkspace` ＋ `read_messages`             | 同                                                         |
| `tasks/create`                                                       | **已发布跨流**（`conversation_id: B`）                                       | 目标 workspace membership                                | 两支都保留跨流（改为按址）                                 |
| `schedule create` 的 wake destination                                | **已发布跨流**（`target_conversation_id: B`）                                | 目标会话 membership ＋ 目标 workspace `manage_schedules` | 两支都保留跨流（改为按址）                                 |
| `message send`                                                       | 钉死 `principal.conversationId`                                              | ——                                                       | ConversationSlot 限自身 stream；AgentSlot 按 participation |
| `file upload`                                                        | 钉死 `principal.conversationId`                                              | ——                                                       | ConversationSlot 限自身 stream；AgentSlot 按 participation |
| `member add`                                                         | 钉死 `principal.conversationId`                                              | ——                                                       | ConversationSlot 限自身 stream；AgentSlot 按 participation |
| `channel create`（**fork source ＋ 随它派生的 workspace / roster**） | 钉死 `principal.conversationId`：input 只有 title / context / initial_prompt | ——                                                       | ConversationSlot 限自身 stream；AgentSlot 按 participation |

⇒ 把表里的规则无差别套到 destination 上会**回收上半已发货能力**（读三项 ＋ task filing ＋ schedule wake）；
而把 P4 的按址 reach 无差别给 ConversationSlot 则是**下半四门的新增写能力**（从未获批）。两头都不是「现状」。
（**订正**：我先前把 `conversation-routes.ts` 里 `agentListChannels` 的 `workspace_id` selector 误读成
`channel create` 有目标 workspace 字段 —— @Cindy 逐行核出。main 的 create 没有任何跨 workspace / 跨会话入口。）

**裁定（@shiki，2026-08-15，`#conv:QVI9x6vU_K1a9oN9` seq 1090 回「C」；边界口径见同频道 seq 1089/1091 = C″）。**
conversation-scoped runtime 的 reach = 上表右列，逐门不同：**已发布的
三项跨流保留，P4 新暴露的四门对 ConversationSlot 限自身 stream**；AgentSlot 七门一律按 participation。
即：既不回收上半已发货能力，也不新增下半四门的跨流写。**曾并列的 A（两支同判据，代价 = 下半四门新增能力）与
B（按字面回收上半）已被否决，不是开放项**；本节此前的「未裁定，留给 @shiki」口径作废，下游不得再据它把 A / B
当可选。

落地形态（裁定的一部分，缺一条就会退化成「一半 A 一半 B」的半状态）：

- reach 不进 resolver —— resolver 只答「哪条流 ＋ 这个 **agent** 能不能用」；
- 判定表**一处全枚举** `(operation, slot kind) → 目的地域 ∈ {own_stream, agent_participation}`，类型层穷尽
  （新增门必须补行）：`packages/shared/src/delivery-reach.ts` 的 `DELIVERY_REACH`；
- 在**解析之后、任何副作用之前**判（`dm:@handle` 的 pair 创建必须在其后，由同表的 `allocation` 关掉）：
  `packages/backend/src/application/delivery-reach.ts`，唯一调用点在 `resolveDeliveryTargetForRoute`；
- refusal 用**独立 code** `slot_out_of_scope`（此处 participation 已被证明 ⇒ 不构成 existence oracle）；
- 教学面全部**派生自同一张表、不抄写**：prompt 按 scope 渲（`platform-prompt.ts`）、CLI `--help` 与错误同源
  （`packages/cli/src/reach-help.ts`）；门禁 = `delivery-reach-slot-scope.test.ts` / `platform-prompt-reach.test.ts` /
  `help-reach-boundary.test.ts`。

这不是两套 auth 权威，而是一个类型的两支：签发端由 slot 行决定签哪一支，verifier 先解构再套对应 policy。
**世代校验必须显式**：`AgentTokenStore` 是 per-process in-memory Map，只有显式 `revoke` / `revokeFor`，
**没有 generation 概念**（`auth/agent-token-store.ts`）。⇒ verifier 每请求把 token 的 generation 与
**live slot generation** 比较，不等即 401；`revokeFor` 退化为加速路径而不是正确性来源。

**路由代数**：终局只有 `/internal/agents/:aid/*` + 上面这一个 principal 判别联合。没有 canonical/legacy
双挂载，也没有 conversation anchor 兼容桥；旧两族 anchored route 均不注册。
「被移出会话就杀 runtime」从此是 **runtime lifecycle policy（按 `session_scope` 取值）**，不是 auth 机制 ——
两根轴分开，才能同时满足「conversation-scoped 行为不变」和「agent-scoped 只拒 target」。

### 7.2 全 CLI frame（#2005 要求「all authorized CLI message/task/file/schedule surfaces」）

没有 ambient conversation 之后，每个面都要显式携带目标；**只改 `message --target` 不够**：

| 面                                                       | 目标寻址                                                                                                           | 额外 frame                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `message send` / `history`                               | `--target`（一条绝对地址：`#<ws>/<title>` / `#conv:<id>` / `dm:@handle`，可带 `/thread:<root>`）                   | ——                                                       |
| `message search`                                         | **不按址**：`--workspace-id` / `--conversation-id` 是**范围 selector**（可省 ⇒ 该 agent 有权的全部），不是投递地址 | 见 §7.2.2                                                |
| `message react`                                          | **不按址**：目标是 `--message-id` 这个对象，会话由它派生                                                           | ——                                                       |
| `task *`                                                 | **全局 `tasks.id`**（§4.5）；`create` 用 `--target`，board 由它派生（§7.2.1）；`list` 只有范围 selector（§7.2.2）  | provenance = source message                              |
| `file upload`                                            | `--target`（同 `message send` 的地址语汇）                                                                         | ——                                                       |
| `file update/view`                                       | **不按址**：目标是 `--attachment-id` 这个对象，conversation 由它派生（attachment 本就 conversation-owned）         | ——                                                       |
| `schedule create/list/cancel`                            | 目标 conversation（`create` 用 `--target-conversation <address>`，无默认）                                         | 触发时唤醒该 target                                      |
| `thread follow/unfollow`、`member add`、`channel create` | `follow/unfollow` 由 `--root` 对象派生 owner conversation；`member add` / `channel create` 用显式地址              | ——                                                       |
| 任何写文件的工具动作                                     | ——                                                                                                                 | **绝对 workdir**（cwd = agent root，相对路径会静默写错） |

#### 7.2.1 task 的坐标：target ≠ board，且 origin 不是服务端能推出来的

「在 `dm:@shiki` 里被要求为频道 A 建 task」这句话里有两个必须分开的坐标，**只有一根是命令参数**：

1. **task target** = `#silverhand/A`（或再带 `/thread:<root>`）—— **agent 显式传 `--target`**。
   它决定 `tasks.conversation_id`、task 事件的投递位置、讨论上下文与 ACL（§4.4）。
   （落地拼写注记：本节初稿写的 `#<workspace>/<title>` 简写**就是发货形态**，与 chat reference 同一个 `#` 语汇；
   另加 `#conv:<id>` 与 `dm:@handle` 两式，权威在 `packages/shared/src/delivery-target.ts`。
   P4-4 曾一度改用 `silverhand://conversation/…` URI，那是**未经裁定的实现擅改**，已按 @Cindy B2 恢复 —— 该 scheme
   是 #task:2000 的 **principal 寻址**语汇，投递目的地是另一根轴。）
2. **board** = 由 target conversation 的 placement **派生**（`workspace` 支 → 该 WorkspaceBoard；
   `direct_pair` → DirectPairBoard；`agent_inbox` → 无 board、由 trigger 拒，§4.4 —— 该支已退役，见页首）。
   **不提供 `--board`**：两根参数会互相矛盾，而 placement 已是唯一权威。

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

#### 7.2.2 collection 读面：默认 = 全部可见范围的并集，不是某个 ambient board

上一版只定了「单对象 mutation 解析到全局 id」，**漏了集合读面**（@Cindy 第四轮 finding 6）。现状逐个核过：

| 面                                | 今天的作用域                                                                                                                            | agent-scoped 目标                                                                                                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task list`                       | help 原文「the default is **the actor's current workspace**」（`commands/task.ts:312…`），由 token 路径的 conversation → workspace 推出 | **默认 = 该 agent 有权的全部 board 并集**；收窄只靠范围 selector `--workspace-id` / `--conversation-id` / `--status` / `--assignee` / `--mine`（**发货形态没有 `--target`**：集合读面没有投递目的地这根轴） |
| `message history`                 | 路径 conversation（`client.ts:198`）                                                                                                    | **`--target` 必填**（读一条流必须指名，没有"当前流"）；窗口用 `--before-seq` / `--after-seq` / `--around`                                                                                                   |
| `message search`                  | 路径 conversation（`client.ts:224`）                                                                                                    | **不按址**：`--workspace-id` / `--conversation-id` 是可省的范围 selector，省略 ⇒ 该 agent 有权的全部范围                                                                                                    |
| `channel list` / `workspace list` | 路径 conversation 推 actor 范围（`client.ts:206/213`）                                                                                  | 语义不变（本就是"我能看到什么"），但范围改由 **live membership 并集**派生                                                                                                                                   |
| `file view` / `update`            | 路径 conversation                                                                                                                       | **不按址**：`--attachment-id` 即目标，conversation 由 attachment 对象派生（attachment 本就 conversation-owned）                                                                                             |
| `file upload`                     | 路径 conversation                                                                                                                       | 写面 ⇒ **`--target` 必填**（同 `message send`）                                                                                                                                                             |
| `schedule list`                   | 同上                                                                                                                                    | 默认全部我拥有的 schedule + 每行带 target                                                                                                                                                                   |

两条规则（**读写不对称是刻意的**）：

- **读面默认放宽到并集，绝不静默收窄**：静默收窄的症状与 §1 的「INNER JOIN 整行消失」同族 —— agent 看不到
  自己有权的 task 却毫无报错。
- **每一行必须自带坐标**：`conversation_id` + board + 局部 `task_number` + 全局 `tasks.id`。并集读面里
  `#task:7` 会歧义（多个 board 各有 7 号）⇒ **agent 面的输出以全局 id 为主键**，局部编号只作显示。
- **mutation 反向 fail-closed**：需要唯一目标的写操作没有 `--target` 就报错，不猜。

### 7.3 cwd：三档确定性坐标（沿用 v64 invariant I1）

v64 已确立：workspace 不在 DB 里拥有路径，bundle 解析到终局确定性坐标
`<agent home>/workspaces/<workspace_id>`，每台 host 同一算法、无 DB 列无 registry。补齐缺口：

| RuntimeScope                                  | cwd                                                  |
| --------------------------------------------- | ---------------------------------------------------- |
| `Agent(aid)`                                  | `<agent home>`                                       |
| `Conversation(cid,aid)` + workspace placement | `<agent home>/workspaces/<workspace_id>`（现状不变） |
| `Conversation(cid,aid)` + **workspace-less**  | `<agent home>/conversations/<conversation_id>`       |

进程 cwd 就是唯一被硬保证的 runtime base（`supervisor/index.ts:2142/2269/2281/5374`），claude/qoder 按
**cwd slug hash** 定址厂商 session（`session-migration.ts:117/128/144`）⇒ 复用 agent root 会把本应隔离的
workspace-less 会话并成一条 session；cwd 随会话变动会让 agent-scoped 分叉。

### 7.4 其余落位

**pidfile** `<root>/<daemonInstanceId>/<enc(cid)>-<enc(aid)>.json`（`runtime-pidfiles.ts:70-97`）⇒ 显式 scope
命名空间（`agent/<aid>.json` vs `conv/<cid>-<aid>.json`）；空 cid 产出 `-<aid>.json` 与 orphan reconcile 冲突。
**system prompt** 每 spawn 渲染，agent-scoped 不能再声明「cwd 就是工作区」。
**steer 降级** `drivers/index.ts:92 releaseProfile`，须读 live per-spawn 实例（qoder 在 `bindRuntimeVersion`
决议）；`one-shot`/`next-turn-batch` 无法中途接受跨会话 steer ⇒ **显式排队 + 顺序可见**，禁止静默丢。
**freshness** 不按会话/流隔离，是**整个 runtime 视野**的性质：后端在 `message send` 处按 `RuntimeScope`
判「这个 runtime 还有没有未消费的 inbox 行」（EXISTS-guard），daemon 不参与、无 per-stream 边界；
`spawn-prep.ts` 的单标量 `last-delivered-seq` 无读者、不是 freshness 源（详见
`freshness-boundary-authority-v1.md`）。

### 7.5 prompt context：agent-scoped **没有 workspace L2 这个概念**

§0 写了「全局 L1 `MEMORY.md`、不加载 workspace L2」，但上一版**没有把它落到任何一张票上**（@Cindy 第四轮
finding 5）；第五轮她进一步指出我上一版写的「L2 正文不注入、但 frame 给 L2 路径、agent 按需读」**不是**「只有
L1」—— 那只是把同一个能力从 prompt 挪到 frame，`workspace memory index` 与 `memoryPath` 仍在。这条采纳：
**agent-scoped 的 workspace L2 / memory index / L2 路径能力整体删除**，不是改成手动加载。

现状核过：`host/src/daemon/prompt-context.ts` 是**按 workspace 键**渲染的 —— `memoryDirFor(options.workspace)`
取 `workspace.path` 后读 `<path>/MEMORY.md`（16KB cap，`MEMORY_INJECT_CAP_BYTES`）、`readMemoryNotesCatalog`
读 `<path>/notes/`、`buildWorkspaceMemoryIndexFromRuntimeStartOptions` 产出
`{label, memoryPath}[]`、`sessionContext` 再带单一 `conversationId` / `workspaceName` / `workspacePath`。
一进程服务 N 会话时「哪个 workspace 的 L2」根本无解 —— 这不是取值困难，而是这个概念在 agent scope 下不成立。

目标（`RuntimeScope` 派生的两种注入形态，各自封闭；**两列互不影响** —— #2005 只授权改 agent-scoped 那一列）：

| 注入项                                                                                | conversation-scoped                           | agent-scoped                                                  |
| ------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------- |
| L1 role prompt（`system_prompt.md`）                                                  | 注入（不变）                                  | 注入                                                          |
| **该 workspace 的 L2**：`memoryDirFor(workspace)` 下的 `MEMORY.md` + `notes/` catalog | 注入（**逐字节不变**）                        | **不存在**                                                    |
| **agent-global `MEMORY.md` + catalog**（新增载体，`<agent home>`）                    | **不注入** —— 现状没有这一项，本 doc 也不新增 | **注入（唯一的持久记忆）**                                    |
| `workspaceMemoryIndex`（`{label, memoryPath}[]`）                                     | 注入（不变）                                  | **空集，且 frame / header / 任何读面都不给 L2 路径**          |
| `sessionContext.workspaceName` / `workspacePath`                                      | 注入（不变）                                  | **不注入**（cwd = §7.3 的 agent home，与任何 workspace 无关） |

第三行是 @Cindy 第六轮 finding 1 收正的：我上一版把「L1 memory 两列都注入」与「conversation-scoped 逐字节
不变」同时写下，二者不能同真 —— 现行 `currentMemoryDir = memoryDirFor(options.workspace)` 只读**当前
workspace** 的 `MEMORY.md` / `notes/`，regular workspace 里的 conversation-scoped runtime 从来拿不到
agent-home 的 MEMORY。**agent-global L1 memory 是 agent-scoped 专属的新载体**（`agent_home` workspace 的 L2
恰好也落在 `<agent home>` 目录下，那是路径巧合，不是同一个概念）；#2005 的原话只授权「agent-scoped 只有
L1 / 要一个 L1 `MEMORY.md`」，没有授权改 conversation-scoped 的记忆层 ⇒ 不改。

推论，必须一起写下来：

- **agent-scoped agent 既不读也不写 workspace L2**。它的持久知识只有 L1；跨 target 的项目事实一律从**权威源**
  现取 —— 仓库与仓内 docs、任务板、频道 / thread 历史（`task detail`、`message history|search` 都已是显式带
  target 的读面，见 §7.2.2）。这与「L2 只放代码/docs/任务板都没有的东西」本来就一致：把 N 个 workspace 的 L2
  同时塞给一个 runtime，只会制造跨 workspace 的串味。
- **不给「按需读」留后门**：没有 `memoryPath`、没有 workspace memory index、header 不带 workspace 路径。
  agent 要在某个仓库里干活时，路径来自任务/消息正文或 `workspace list`（它已给 `agent_dir` 绝对路径与
  unavailable 判据 ⇒ 那是**工作区发现**，不是记忆注入，@Cindy 第六轮确认）—— 差别是：
  **它永远不会被当成「我该维护的记忆」**。
- **渲染必须是幂等纯函数**：形态只由 `RuntimeScope` 决定，不能出现「首次 spawn 不注入、respawn / compaction
  后又注入」的相位差 —— 那是最难发现的一类漂移。
- conversation-scoped 的注入路径**逐字节不变，一项都不加**（尤其不加 agent-global memory）。这不是过渡期
  让步：两种 scope 都是永久一等模型（§8 术语），当前 workspace 的 L2 就是 conversation-scoped 的正确形态。

落位：契约在 **P2**（与 `session_scope` / RuntimeScope 分派同票，因为都由 scope 派生），端到端在 **P5**。

---

## 8. 迁移 DAG

**migration version 单调 ⇒ 所有改 schema 的票串行落地**；能并行的只是编写。**没有任何一步允许先抹语义。**

```
P0-a placement × roster_policy（**`conversations` table rebuild**；`kind` 变 GENERATED VIRTUAL 派生列）
  ├─ P0-b AgentInbox（Mentions 迁离 workspace_id + owner cascade + CC 同 tx 写入 + dedupe UNIQUE）
  │     —— v71 落地，**#task:2072 v84/v85 整支退役**；CC 保留，落点改为提及者与被提及 agent 的 direct pair
  ├─ P0-c conversations.name（partial UNIQUE + 保留表）
  └─ P0-e endpoint identity 存活（endpoint 列去 FK + 删除事务打 endpoint tombstone；**不改全系统软删**）
        └─ P3 DirectPair（endpoints + 派生 pair_key + ACL 派生解析器）
              ├─ P4 DeliveryTarget（含 §0 的 reference/recipient invariant）
              └─ P0-f Board：board_key + DirectPairBoard（B 已裁定；legacy 原地不动）
P0-d runtime slot 拆分（slot / CAS / observation / resume + scope 一致性 trigger）
  └─ P1 RuntimePrincipal 判别联合 + /internal/agents/:aid/*（含世代比较与两种 target policy）
        └─ P2 session_scope + RuntimeScope 分派 + 三档 cwd + scope 化 pidfile + **L1-only prompt context**
P0-g 全局 task identity 成为 canonical resolver + **collection 读面并集化**（§4.5 / §7.2.2）
P6 终局清理：v79 `DROP COLUMN kind`（生产 / wire / 当前行为测试读点清零；Host 13 / Outbound 12 不再 bump）
      （**没有「删 agent_home 支」这一臂**：`agent_home` 是永久共存的 placement 家族，§9.2）
P5 端到端 slice ← 全部
```

（**P0-f 现在依赖 P3**：DirectPairBoard 的键就是 `pair_key`，所以编号空间不能早于 DirectPair 存在 ——
这是换掉 AgentBoard 后的拓扑变化。）

**Falsifier**（逐票，缺一即不通过）：

- **P0-a**（rebuild，判据全文见 §4.1 末的四条）行为零变化：14 行 `dm_channel` 仍私有、roster 仍不可变更、
  `kind` 派生值与迁移前逐行相同；**rebuild 后 schema fingerprint 与预期 DDL 逐项相同**（全部 column / CHECK /
  FK / 三个 `idx_conversations_*` / trigger 都在，`visibility` 的 CHECK 已改读 `roster_policy`）；
  **数据按 `id` 逐行全列比对一致**；`foreign_key_check` 为空；**任何 `INSERT`/`UPDATE` 写 `kind` 都被 DB 拒**
  （生成列，解析期报错）；`SELECT *` 仍返回 `kind`；非 workspace placement 的会话在
  list/search/favorites/saved/task 全可见；`visibility` 无法被设成 `public` + `roster_policy='fixed'`。
- **P0-b** agent 无任何 workspace 归属会话时 CC 仍投递成功；并发只一行；**在 source message 的 tx 内
  crash 注入：commit 前挂掉 ⇒ message 与 CC 副本都不存在；commit 后挂掉 ⇒ 两者都存在且收件箱恰好一条**
  （不存在「消息在、CC 丢」的中间态，也不需要重放）；**删除一个有 Mentions inbox 的 agent：删除成功
  （不被 FK 挡）、inbox 会话与消息随 owner 一起消失、不留孤儿行**；**删除 CC 的源会话不删除别人 inbox 里的副本**。
- **P0-c** 改 `title` 不改 target 解析结果。
- **P0-e** 硬删一个 endpoint principal：**删除成功**（不是 ABORT）、DM 与历史保留、survivor 只读、
  endpoint 显示为 tombstone 而非「id 不存在」；**`agents`/`users` 的删除路径与今天逐格相同**（没有引入软删）。
- **P0-d** conversation-scoped 行为零变化（status SSE、`cliSessionId:null` 竞态等价于
  `outbound-event-fanout.ts:781`）；ACL 读面不再与 runtime 写同行；**换 daemon 后每 scope 仍只有一行 slot**；
  agent-scoped agent 插 conversation slot（及反向）被 DB 拒。
- **P1** 移出某会话后该 target 被拒而 runtime 存活；**generation++ 后旧 token 立即 401**（不依赖显式 revoke）；
  C″ 三开四闭逐门保持，AgentSlot 七门按 live participation；两族 anchored route 均为 404，agent-global route
  不携带 conversation 坐标。
- **P2** 跨多 workspace 工作后 vendor session 仍 resume 同一条；`UPDATE agents SET session_scope` 被 DB 拒；
  两套 pidfile 不互相 reconcile 掉；**agent-scoped 的 spawn prompt 不含任何 workspace L2 正文，
  也不含任何 L2 路径 / workspace memory index / `workspacePath`（`workspaceMemoryIndex` 为空集），
  且 respawn / context reset 后重新渲染仍不含**（幂等，不是「第一次不注入」）；
  **agent-scoped 的 delivery frame / header 同样不携带 L2 路径**；
  **conversation-scoped 的 prompt 逐字节不变 —— 既不减该 workspace 的 L2，也不加 agent-global memory**
  （两项都算不通过：这一列本票不改，§7.5）。
- **P3** 并发同 pair 只一行；`UPDATE` endpoints / `pair_key` 被 DB 拒；endpoint kind/id 不合法被拒；
  DM 成员变更 API **不存在**；`participantsOf` 是唯一 ACL 解析入口（静态闸）。
- **P4** 任何持久字段或跨 principal 读面出现字面 `dm:@…` 即不通过；**B 中引用 A-only 成员：B 的 follower/
  recipient 不变、A 无投递、unresolved 可观测**。
- **P0-g** 无 `--target` 也能 `task detail/edit/status <global-id>`；跨 conversation 复制 canonical ref 后仍指向
  同一 task；**无权 viewer 拿到与「不存在」不可区分的拒绝**；局部 `#task:<n>` 仅在 board 已给定时可用；
  **`task list` 无参数时返回该 agent 有权的全部 board 并集**（不是某个 workspace），每行带
  `conversation_id` + board + 局部编号 + 全局 id；`message history/search` 缺 `--target` 时**报错而不是猜**。
- **P0-f** 39 条 legacy task **零搬迁零重编号**（`board_key='ws:'||workspace_id` 回填后 `(board_key,
task_number)` 与旧 `(workspace_id, task_number)` 逐行同解）；每条 DirectPair 私线**各自从 1 编号**且互不冲突；
  **agent↔agent 与 human↔human 的私线都恰好解析到一个 board**（AgentBoard 的反例不复现）；
  **向 `agent_inbox` 建 task 被 DB 拒**（该 placement 退役后此条作废，见页首）；`UPDATE board_key` 被拒；**同一 board 上无权 viewer 看不到不属于
  自己的 task**（ACL 逐 task 由 `conversation_id` 判，不由 board）。
- **P6** v79 一步删除 `kind` 生成列；生产 / wire / 当前行为测试读点为零，历史迁移 fixture 保留，favorites
  排序键原子改为 `conversation:<id>`，Host 13 / Outbound 12 不再 bump。**不存在「删 agent_home 支」这一臂**
  （§9.2）⇒ 任何以「conversation-scoped 或 `agent_home` 将来消失」为前提的验收条目出现即不通过。
- **P5** A 中 agent-scoped 工作 → B steer → `dm:@shiki` 回复 → A 继续，且同一 conversation 内另有
  conversation-scoped agent 同时工作；`agent_status` 对有权 viewer 给绝对 target、对无权 viewer 给
  `focus='other'` + 队列深度；**agent-scoped agent（没有 `agent_home` 行）在 owner 的 Agent 管理读面里仍可见**
  （§9.2 residual —— 该读面必须以 agent 为键，不是以「该 agent 有没有 home 容器」为键）。

有利条件：`session_scope` 不可变 ⇒ **无 scope 转换器、无 per-item 迁移状态机**；两类靠 placement + slot 键
天然并存，现有 agent 永久 conversation-scoped。**两种 scope 都是永久的一等模型**（@shiki 2026-08-14 02:41）⇒
「legacy」这个词在本 doc 里**只指两样东西**：①**旧数据行形态** —— 14 条固定 roster 的 home 会话与它们那 39 条
已编号 task（永不搬迁、永不重编号）；②**临时 bridge** —— `kind` 生成列（有可观测删除条件）。
它**从不指 conversation scope**，**也不指 `agent_home` 本身**（@Cindy 第六轮 finding 2：既然新的
conversation-scoped Agent 继续建 home，`agent_home` 就是**永久共存的 placement 家族**，不是待清理形态，§9.2）。
因此不允许任何一票以「conversation-scoped 会消失」或「`agent_home` 会消失」为前提。

---

## 9. 人类裁定记录（**已无未决项**）

### 9.1 Board 归属 = **B**（@shiki 2026-08-14 02:41「同意 B」，已裁定）

**`Board = WorkspaceBoard(workspace_id) | DirectPairBoard(pair_key)`**，模型见 §4.4，落位 P0-f。
两个被否形态留档于 §10：A（AgentBoard，我提出后自行撤回 —— 对 DirectPair 不是全函数）、
C（只有 WorkspaceBoard —— `--target 'dm:@handle'` 建不出东西）。三者**都不决定 Task identity**
（恒为全局 `tasks.id`）**也都不决定 ACL**（恒为逐 task 的 `conversation_id`）⇒ 这次裁定只定编号空间。

**canonical task 地址**：@shiki 已裁定 Task 升级为 `silverhand://` URI 的一等对象，协议设计在 **#task:2011**。
本 doc 只承担「identity 恒为全局 `tasks.id`、mutation 不依赖 ambient board」这两个接口条件；**不预写文法**。

### 9.2 新建的 conversation-scoped Agent **继续创建 `agent_home`**（已定，取保守读法）

@shiki 2026-08-14 02:41 裁定「agent-scoped 是长期并存的一等模型」⇒ conversation-scoped 不是 legacy、
不会自然消亡。上一版 P6 的前置件「零 legacy conversation-scoped Agent」因此**永远不成立**，必须重写。
我上一版据此推荐「两种 scope 都不再建 home」，**这一条撤回**（@Cindy 第五轮，我确认她对）：

- #2005 只授权了「**agent-scoped** 不创建 `agent_home`」；conversation-scoped 的创建路径不在授权范围内。
- `agent_home` 对 owner 是**管理 Agent 的视角**（@shiki 早先明说），不只是 DM / Mentions / board 的存储容器。
  「底层三件职责都已有一等载体」只证明它不再是**存储**必需，不证明那个**产品入口**该消失 ⇒
  按「未授权即不改」处理。
- 我原先的反对理由（「同一条 DM 会因 owner 的 scope 不同而有两种形态」）**不成立**：新 DM 一律是
  `direct_pair` placement、`workspace_id IS NULL`，与对端 agent 有没有 home 行无关。差异只在「owner 侧
  是否存在一个 home 容器」这一条。

⇒ 目标模型里 `agent_home` 是**永久共存的 placement 家族**，不是待清理项：**P6 删掉 home 删除臂**
（不留永不触发的清理票 —— 那是假承诺），只保留 `DROP COLUMN kind`，其前置件独立收敛于「读点清零 + wire
epoch」。residual（写在 P2 / P5）：**agent-scoped agent 没有 home 行** ⇒ 任何以「存在 home 容器」
为键的 owner-facing 读面必须改为以 **agent 本身**为键，否则 agent-scoped agent 在管理视图里整行消失
（与 §4.1 的 INNER JOIN 失效同一类症状）。

### 9.3 AgentSlot clear 行为审计 = **c2**（@shiki 2026-08-14 21:50，已裁定）

AgentSlot clear **不造 conversation system message**：当前 focus 只是展示状态，不是 action owner；为审计恢复
`agent_home` / AgentInbox 或把 focus 冒充归属，都会重新引入已删除的 conversation 权威。与此同时，它也不采用
c1 的“完全不记录用户行为”，因为 ConversationSlot 的同一动作已经保留 actor 审计，只有 AgentSlot 无人可查会
形成没有模型理由的审计强度不对称。

终态是独立的 **agent-level control audit fact**：至少记录 `agent_id`、exact runtime `generation`、
`actor_user_id`、`reason='session_cleared'` 与发生时间；不含任何 conversation / workspace / focus 坐标，且与
AgentSlot 的 exact-generation `cli_session_id=NULL` 在同一 DB 事务提交。`agent_runtime_events` 继续只表达 runtime
状态历史，**不兼任**“谁执行了 clear”的行为审计。ConversationSlot 维持既有 `session_cleared` system message，
两种 scope 的载体不同、行为事实强度一致。

---

## 10. 被否方案与其失效形态

| 方案                                                                               | 失效形态                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-a 就删 `kind`                                                                   | 118 处读点 + wire literal 失去判别式，而 DirectPair 到 P3 才存在；14 行私有会话的 fixed-roster 语义无处落                                                                                                                                                                 |
| 把 `kind` 保留成**普通列**（回填后靠代码维持一致）                                 | 第二个可写权威 ⇒ 只能靠纪律防漂移。正解是 GENERATED VIRTUAL 列：写它在解析期就报错，一致性由 DB 证明                                                                                                                                                                      |
| `Board = Workspace \| Agent`（AgentBoard）                                         | 对 DirectPair 不是全函数：agent↔agent 对应两个 board（actor-dependent）、human↔human 一个都没有 ⇒ 与「board 由 placement 派生、无 `--board`」不相容                                                                                                                       |
| 向 Mentions inbox 建 task（或让它静默落到某个 board）                              | inbox 是通知读面、无 board ⇒ 必须由 trigger 拒绝，而不是猜一个归属                                                                                                                                                                                                        |
| `inbox_agent_id` 不带 delete 语义                                                  | owner 删除后 inbox 无 survivor 也无家：要么 FK 挡住 agent 删除，要么留孤儿会话。正解 `ON DELETE CASCADE`（把今天经 `workspaces.owner_agent_id` 的那条 cascade 缩短一环）                                                                                                  |
| `cc_source_message_id` 带 FK                                                       | 删源会话会连带删掉别人 inbox 里已收到的通知 = 追溯改写认知                                                                                                                                                                                                                |
| CC 靠「source replay + 写入时 UNIQUE」                                             | 重放要重算收件人，而收件资格时变（membership / handle / placement / inbox 存在性）⇒ 可能算出另一个键，UNIQUE 挡不住。正解是与 source message 同 tx 按 send-time plan 原子写入                                                                                             |
| 把现有 `dm_channel` backfill 成 DirectPair                                         | 实测同一 pair 有 4/3/2/2 行 ⇒ `UNIQUE(pair_key)` 直接冲突                                                                                                                                                                                                                 |
| `visibility='private' OR placement_kind='workspace'`                               | 会允许 public 的固定 roster 会话；忠实改写是 `roster_policy='open'`                                                                                                                                                                                                       |
| 把「删 `workspaces` 的 `agent_home` 支」排进 P6（或任何票）                        | `agent_home` 是永久共存的 placement 家族（§9.2：#2005 只授权 agent-scoped 不建 home，conversation-scoped 的产品入口不在授权内）⇒ 那一臂的前置件永不成立 = 假承诺。`kind` 生成列的删除独立收敛于「读点清零 + wire epoch」，与 home 无关                                    |
| 顺手让 conversation-scoped 也不再创建 `agent_home`（我上一版的推荐，已撤回）       | 越过 #2005 的授权范围删产品入口；且我给的理由（DM 形态二分）不成立 —— 新 DM 一律 `direct_pair` + `workspace_id IS NULL`，与对端有无 home 行无关                                                                                                                           |
| 用 `ALTER TABLE ADD COLUMN … GENERATED … VIRTUAL` 迁移 `kind`                      | 同名普通列已存在：SQLite 没有 alter-column-to-generated、`ADD COLUMN` 撞名、`DROP COLUMN` 被引用它的 `visibility` CHECK 挡住。正解是 `conversations` table rebuild（v64 已有同一 idiom），生成列只是终态                                                                  |
| rebuild 时只断言「新列已存在」                                                     | rebuild 的失效方式是**静默丢约束/丢索引**（`DROP TABLE` 连带丢索引、FK 在迁移中是关的）⇒ 必须断言 schema fingerprint 全量、数据逐行、`foreign_key_check` 为空                                                                                                             |
| 把 conversation scope 当成 rollout 临时态 / 待收敛的兼容分支                       | @shiki 2026-08-14 02:41 明确它是永久并存的一等模型 ⇒ 任何以「它将来会消失」为前提的清理票都是假承诺（P6 上一版就踩到）。反过来也不许把 agent-scoped 实现成「conversation-scoped + nullable conversationId」                                                               |
| 把现有 `agent_home` 搬迁成新形态的 board（重编号 / 换键）                          | 与「DirectPair 只承接新行」不同构；旧 home 还挂着 cwd / L2 / vendor session，降级即一次全量迁移。正解是 `board_key` 让 `agent_home` 原地成为 WorkspaceBoard（它是永久家族，不是待迁形态）                                                                                 |
| principal token = 扁平 `(agent_id, generation)`                                    | conversation-scoped 同一 agent 有 N 个 slot、generation 可同值 ⇒ 指不出 slot，且 A 的 runtime 能凭 live membership 操作 B，破坏现有隔离。正解是判别联合 + 两种 target policy                                                                                              |
| 「服务端从 delivery frame 自动记录 command origin」                                | Agent token + `--target` 的请求到达时 server 无从关联投递；「取最近一条消息」是猜 ⇒ 虚构 authority。要么不承诺，要么显式可校验的 `origin_message_id`                                                                                                                      |
| Mention CC 只靠 source replay（无写入时 dedupe）                                   | source 行只证明输入存在，不证明副本已写 ⇒ 崩溃重放重复投递                                                                                                                                                                                                                |
| 为 CC 幂等新建 outbox / per-item 状态机                                            | 同 tx 原子写入已经没有「commit 后还要决定一次」的窗口；新表只是多一份可漂移状态                                                                                                                                                                                           |
| `task list` 等集合读面沿用 ambient workspace 默认                                  | agent-scoped 没有「当前 workspace」⇒ 静默收窄，agent 看不到自己有权的 task 且无红灯。正解：默认并集 + 每行自带坐标，收窄靠显式 flag                                                                                                                                       |
| agent-scoped 仍能拿到某个 workspace 的 L2（注入正文**或**只给路径 / memory index） | 一进程服务 N 会话时「哪个 workspace」无解；给路径只是把同一个能力从 prompt 挪到 frame，仍会出现「首次 spawn 与 respawn 形态不同」的相位漂移与跨 workspace 串味。正解：agent-scoped **没有 workspace L2 这个概念**，只有 L1；项目事实从仓库 / docs / 任务板 / 频道历史现取 |
| 顺手给 conversation-scoped 也注入 agent-global `MEMORY.md`                         | 现状 `memoryDirFor(options.workspace)` 只读当前 workspace 的 L2 ⇒ 加这一项就与「conversation-scoped 逐字节不变」直接冲突，而 #2005 只授权改 agent-scoped 那一列。两条不能同真时，改的是**方案**不是 falsifier                                                             |
| 把 `agent_home` 或 conversation scope 归入「legacy」                               | 新的 conversation-scoped Agent 继续创建 home ⇒ 它是永久共存的 placement 家族。「legacy」只指旧的 14 条固定 roster 会话 + 那 39 条 task 行，以及临时的 `kind` bridge                                                                                                       |
| 把 `agents`/`users` 整体改软删当 P0-e 前置件                                       | 牵动全部 FK cascade、handle 唯一性、登录/list、`created_by`、teardown；本 feature 只需要 endpoint 侧身份存活                                                                                                                                                              |
| Board 当 ACL 单位                                                                  | WorkspaceBoard 聚合该 workspace 全部会话的 task（含成员集合不同的会话）⇒ 取 board 判权即越权；board 形态本身还会演进（A→B 就换过一次）。ACL 必须逐 task 由 `conversation_id` 判                                                                                           |
| 局部 `task_number` 当跨 conversation identity                                      | agent-scoped 无 ambient board ⇒ `task detail <n>` 不可解析；identity 必须是全局 `tasks.id`                                                                                                                                                                                |
| `agent_status` 一律只显示「本会话忙」                                              | 失去可解释性；正解是按 viewer 权限分档（有权 → 绝对 target，无权 → `focus='other'` + 队列深度）                                                                                                                                                                           |
| endpoints 投影成成员行 + 拒绝型 trigger                                            | 保证不了投影存在；且实测 cascade 会触发子表 trigger ⇒ `DELETE FROM agents` 整条 ABORT，不是 tombstone                                                                                                                                                                     |
| `Board = Workspace \| Conversation`                                                | 要求 39 条 task 重编号，并新造一层歧义换取零收益                                                                                                                                                                                                                          |
| 「一 scope 一 slot」但 UNIQUE 含 `daemon_instance_id`                              | 换 daemon 即有两行自称当前                                                                                                                                                                                                                                                |
| 把 `status/pid` 与 `cli_session_id` 当同一种 DB 权威                               | 前者是 daemon 观测投影、后者是持久 resume state；混为一谈会在崩溃后清掉可 resume 的会话                                                                                                                                                                                   |
| 靠保留退出行记历史                                                                 | authority 查询无法判断哪行当前；历史该进 append-only 事件表                                                                                                                                                                                                               |
| Create/start/delete 标「同 tx」                                                    | 现网就是 reserve→materialize→finalize / durable intent→purge→CAS，OS 进程进不了 SQLite tx                                                                                                                                                                                 |
| Mention CC「commit 后可重试」而无重放判据                                          | `post-commit` 是 best-effort + `logger.warn` ⇒ 崩溃即永久丢 CC                                                                                                                                                                                                            |
| 「generation 自增即旧 token 失效」而 verifier 不比较                               | token store 是 in-memory Map、无 generation 概念，旧 token 继续有效                                                                                                                                                                                                       |
| 保留两套 auth 路由长期共存                                                         | 永久双权威；正确形态是单路由 + 按 `session_scope` 取值的 lifecycle policy                                                                                                                                                                                                 |
| 「wire 保持现有 `agent_status` 形状」                                              | 现 payload 无 focus/pending/queue，与「N 会话解释一个 runtime」矛盾                                                                                                                                                                                                       |
| `UNIQUE(scope_kind, conversation_id, …)`                                           | SQLite 下 NULL 互不相等 ⇒ agent scope 可重复插                                                                                                                                                                                                                            |
| 「schema 无 UPDATE 路径」当约束                                                    | SQL 仍可 UPDATE，必须 trigger                                                                                                                                                                                                                                             |
| 「一事务只写一个聚合」blanket rule                                                 | 留下 conversation 已建而 endpoints 未落的半状态                                                                                                                                                                                                                           |
| `pair_key` 由 handle 派生                                                          | handle 是公开寻址面；内部身份必须用 `(kind,id)` 与之解耦（#2005 原文）                                                                                                                                                                                                    |
| workspace-less 会话复用 agent root 当 cwd                                          | vendor storage 按 cwd 定址 ⇒ 本应隔离的 session 被合并                                                                                                                                                                                                                    |
| 把 file/saved/favorite 塞进 Board                                                  | attachment 本就 conversation-owned 且无 workspace_id；saved/favorite 是 user-owned state                                                                                                                                                                                  |
| 单标量 seq 复用多流                                                                | 静默漏投 / 重投                                                                                                                                                                                                                                                           |
| `busy/focus` 投影当写权威                                                          | 多流聚合写回会丢单流状态                                                                                                                                                                                                                                                  |

---

## Acceptance

失败条件 = §5 的分档被混淆（**跨进程/跨主机后果**被写成「同 tx」，或**纯 DB 内的后果**被拆成
best-effort post-commit）、§8 各票 falsifier 任一不通过、§10 任一被否形态出现。

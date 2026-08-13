# Agent-scoped Session v1 —— DDD 目标模型与改造路径

Status: **design under review**（设计 @Alice，#task:2009；review gate @Cindy）。
产品语义权威 = #task:2005；本 doc 是**技术目标模型的单一权威**，#task:2009 的 body 只保留可独立验收的
Acceptance Summary，不复制正文。

现状基线取自 `packages/shared/src/db/migrations.ts`（**不是 `baseline-schema.ts`** —— 第一版曾误把基线
当现行 schema，导致把 v53/v64 已删除的概念写回目标模型）。所有 `file:line` 引用均按当前 HEAD 复核。

---

## 0. 产品合同输入（来自 #task:2005）

`session_scope = conversation | agent` 创建时选定且**不可变**，两类可在同一 conversation 共存。
Agent-scoped：一 runtime / 一 vendor session / 一稳定 agent cwd / 全局 L1 `MEMORY.md`，**无 workspace L2、
无 `agent_home`**。所有会话经现有 steer 机制进同一认知流；header 带语义 target（`#<ws>/<channel>`、
`thread:<root>`、`dm:@handle`），回复时原样复用。DM = **非 workspace** 的固定 pair；Mentions = **无
workspace、无 counterpart** 的 agent-owned inbox。消息 / ACL / task / file / unread / freshness 按
conversation·stream 归属；runtime identity 按**显式 scope** 归属。能力按最齐全建设，灰度只控制哪些 agent
先用。

产品层已拍板、本 doc 不再重开：**DM 参与者删除走 tombstone、conversation 与历史保留**（消息是双方共同
产物，单方删除不得抹掉对方历史）。

---

## 1. 根因：一个聚合扛三种生命周期，一处混装两种

`conversations` 一行同时是：

1. **消息流身份**（持久，正确 —— 这是唯一应该留在这张表里的职责）
2. **归属与落盘**：`workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE`
3. **成员关系入口**：`kind` 值 `'dm_channel'` 用来区分 roster 语义

而 `conversation_agents` 一行同时是：

- **成员边 + ACL 权威**（`permissions.ts` / `permissions-registry.ts` 读同一行判权），以及
- **runtime 身份**（`status` / `pid` / `cli_session_id`，被 runtime 的写入点高频 churn）

⇒ **ACL 判权压在 runtime 高频写面上**。本轮暴露的全部故障都是这一耦合的**静默**症状：

- **workspace-less 会话类型上不可表达** ⇒ 全仓 `JOIN workspaces` 是 **INNER 10 / LEFT 0**
  （`conversation-repo.ts` ×3、`agent-repo.ts:673`、`saved-message-repo.ts:139`、`search-repo.ts` ×3、
  `read-model/favorites.ts:153`、`task-sql.ts:31`）⇒ 一行没有 `workspace_id` 的会话会从
  list / search / favorites / saved / task **整行静默消失**，没有任何报错。
- **`Mentions` 必须借 agent_home 的 `workspace_id`**：`mention-cc.ts:228` 取不到即 `warn` + `return`
  （**静默丢 mention CC**）；`:437` 用 title lookup 找 Mentions 会话，docblock 自认会并发出重复、靠取
  最老一条掩盖。
- **「一 agent 一 runtime」与 per-`(conversation, agent)` 的 `pid/status/cli_session_id` 直接冲突**：
  同一进程会被 N 行声明。

判据不是「更干净」：症状均为**数据消失或投递丢失且无红灯**，`if (scope === 'agent')` 这类补丁分支抓不住。

---

## 2. Context map：五个边界，单向依赖

### 2.0 Thread 属于 Stream，不属于 Conversation

**Thread 不是一行 conversation**：v53 退役了 `conversations.kind='thread'`，v54 删除了
`parent_conversation_id`。thread 是同一 conversation 内的 **stream**，键 `(conversation_id,
thread_root_id)`，落在 `messages` / `conversation_stream_heads` / `conversation_reads`。
⇒ Thread 归 **Stream + DeliveryTarget**，**继承根 conversation 的 placement**，不参与任何 placement 唯一键。
任何把 thread 写回 conversation `kind` 的目标模型都是逆转已完成的裁定。

### 2.1 聚合

- **Agent**（聚合根）：`name` 全局唯一且**永不复用**、不可变 `session_scope`、profile、L1 记忆、
  **Agent runtime 所有权**、agent-scoped 稳定 cwd。**不拥有一个代替它存在的 workspace。**
- **Conversation**（聚合根）+ **Placement**（穷尽联合，一等概念）：
  `Workspace(workspace_id)` | `DirectPair(endpoints)` | `AgentInbox(agent_id)`。
  Placement 必须是 **DB 可证明的互斥弧**，不是「nullable 字段 + 口头约定」。
- **Participation 按不变量分裂**：
  - `ChannelRoster` —— 可变，权威在 workspace membership；
  - `DirectPair endpoints` —— **不可变，承载会话身份**。
  收益：「DM 拒绝 member add」从守栏变成**类型事实 + DB 事实**。守栏会被绕过（`kind !== 'channel'`
  这类判断散在 `conversation-member.ts:242/758/864/1049/1290` 五处），类型与 trigger 不会。
- **Runtime**（独立聚合）：`RuntimeScope = Conversation(cid, aid) | Agent(aid)` + `daemon_instance_id`
  + `generation`；拥有 `status` / `pid` / `cli_session_id`，cwd 由确定性公式派生（§7.2）。
  `conversation_agents` 只留成员边 + ACL。per-conversation 的忙 / 焦点 / 队列是**读投影**。
- **Board**（§4.3）：task 编号命名空间与 ACL 的归属体，`Workspace | Conversation`。
- **Delivery**：`DeliveryTarget` 值对象生成 header 提示，并把 agent 原样回传的 target 解析成
  `(conversation_id, thread_root_id?)`；**解析完立即归一**，ACL / routing / delivery / session 不分叉。

### 2.2 依赖方向

Runtime / Board 依赖 Agent / Conversation 的 ID，反向不成立；Placement 不引用 Runtime；Delivery 只消费
ID 与 domain event。跨聚合一律经 application service。

---

## 3. 不变量与权威层

每条不变量都标出**由谁证明**。标错层是本设计第一版被打回的原因之一（把「schema 里没有 UPDATE 路径」
写成了 schema 约束）。

| 不变量 | 权威层 |
|---|---|
| Placement 穷尽互斥 | **schema CHECK 互斥弧** |
| `session_scope` 不可变（切换 = 新建 agent） | **`BEFORE UPDATE … RAISE(ABORT)` trigger**（先例：v51 的 root-invariant guard）。SQL 仍可 UPDATE ⇒ 「没有 UPDATE 路径」不是约束 |
| DirectPair 恰两端、端点不可变、ACL 成员 ≡ 两端 | **endpoint 列（唯一权威）+ 派生并物化的 `pair_key` + trigger 守 membership 投影** |
| AgentInbox 每 agent 至多一条、owner 是唯一成员 | partial UNIQUE + trigger |
| runtime slot 每 scope 至多一行 | **两个 partial unique index**（v51 注释已明示：nullable 列进 PK/UNIQUE 在 SQLite 下不 dedupe NULL） |
| channel `name` 在 workspace 内唯一、删后不复用 | partial `UNIQUE(workspace_id, name)` + 独立保留表（不用 nullable UNIQUE 当 tombstone） |
| task 编号在 board 内唯一 | 两个 partial unique index |
| freshness custody **per stream** | 每 stream 一条 ledger |
| runtime cwd 确定性、稳定、跨 scope 不碰撞 | **公式**（沿用 v64 invariant I1，无 DB 列、无 registry 查询） |
| token 只证明 agent 身份与世代；目标授权另算 | application service：**每请求 live 查 membership** |

---

## 4. 目标持久化模型

### 4.1 conversations —— 删掉 `kind` 这一列

`kind` 今天的定义域只剩 `('channel', 'dm_channel')`（'thread' 已于 v53 退役）。`dm_channel` 一旦由
placement 表达，这一列**只剩一个值 ⇒ 整列删除**。它的另一处承载是 `visibility` 的 CHECK
`visibility='private' OR kind='channel'` —— 那本来就是一个 placement 谓词，改写为
`visibility='private' OR placement_kind='workspace'`，语义等价且更准确（public 只对 workspace 会话有意义）。

```sql
conversations:
  id, title(mutable), name NULL,            -- name 仅 workspace 支必填
  status, visibility, latest_message_seq, spawned_by_agent_id, ...,
  placement_kind TEXT NOT NULL CHECK (placement_kind IN ('workspace','direct_pair','agent_inbox')),
  workspace_id     TEXT NULL REFERENCES workspaces(id),
  inbox_agent_id   TEXT NULL REFERENCES agents(id),
  endpoint_a_kind  TEXT NULL, endpoint_a_id TEXT NULL,
  endpoint_b_kind  TEXT NULL, endpoint_b_id TEXT NULL,
  pair_key         TEXT NULL,                -- 由 endpoints 规范排序派生并物化
  CHECK (穷尽互斥弧：本支列非空、其余支列全为 NULL),
  CHECK (placement_kind <> 'direct_pair'
         OR (endpoint_a_kind, endpoint_a_id) < (endpoint_b_kind, endpoint_b_id)),  -- 规范序
  CHECK (visibility='private' OR placement_kind='workspace')

CREATE UNIQUE INDEX … ON conversations(pair_key)         WHERE placement_kind='direct_pair';
CREATE UNIQUE INDEX … ON conversations(inbox_agent_id)   WHERE placement_kind='agent_inbox';
CREATE UNIQUE INDEX … ON conversations(workspace_id,name) WHERE placement_kind='workspace';
-- 已不存在（不要写回）：workspace_path（v64 连同 workspaces.workspace_path 一并删除）、
--                      kind、parent_conversation_id（v54）
```

互斥弧用**仓内既有先例**：`workspaces` 已有 `(workspace_kind='agent_home' AND owner_agent_id IS NOT NULL)
OR (workspace_kind='regular' AND owner_agent_id IS NULL)` 这一同形 CHECK。partial unique index 的先例是
v51 的 `conversation_reads` / `conversation_stream_heads`。

**endpoints 是唯一权威，membership 是它的投影。** 只存 `pair_key` 是不够的：UNIQUE 只证明字符串不重复，
证明不了「恰两端、端点不可变、ACL ≡ 两端」；而如果 pair 身份存在 endpoints、ACL 又独立存在成员表，就是
双权威。解法是让成员表成为**受 trigger 约束的投影**：

- `pair_key` 由两端不可变的 `(kind, id)` 规范排序**派生**并物化（不是与 endpoints 并列的事实）；
- `conversation_agents` / `conversation_users` 在 `direct_pair` 上由 `BEFORE INSERT/DELETE … RAISE(ABORT)`
  守：插入非 endpoint 成员、或删除 endpoint 成员，直接中止。

这样 ACL 读面**完全不分叉**（照旧读成员表，20 个读者无一需要改），而「恰两端 + 不可变」由 DB 证明。
`AgentInbox` 同构：owner 恰一条成员行、无 counterpart，同样 trigger 守。

`pair_key` **不能由 handle 派生**：#task:2000 只保证 handle 唯一且不复用，**不保证不可改名** ⇒ 改名后
持久键会静默指向错的人。派生源必须是不可变 id。

### 4.2 runtime

```sql
agent_runtimes(新):
  agent_id TEXT NOT NULL REFERENCES agents(id),
  conversation_id TEXT NULL REFERENCES conversations(id),   -- NULL ⇔ Agent scope
  daemon_instance_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL, pid INTEGER NULL, cli_session_id TEXT NULL,
  ...
CREATE UNIQUE INDEX … ON agent_runtimes(agent_id, daemon_instance_id)
  WHERE conversation_id IS NULL;
CREATE UNIQUE INDEX … ON agent_runtimes(agent_id, conversation_id, daemon_instance_id)
  WHERE conversation_id IS NOT NULL;

conversation_agents: 仅 (conversation_id, agent_id, joined_at)     ← 迁出 status/pid/cli_session_id
agents:              + session_scope CHECK IN('conversation','agent') + 不可变 trigger
workspaces:          删 workspace_kind 的 'agent_home' 支、owner_agent_id、
                     workspace_members_no_agent_home_* 触发器
```

**不要写 `UNIQUE(scope_kind, conversation_id, agent_id, daemon_instance_id)`**：SQLite 下 NULL 互不相等，
agent scope 的行可以无限重复插入 —— 这正是「一 agent 一 runtime」被静默破坏的形状。必须用上面两个
partial unique index。

**一行 = 当前 slot**（每 scope 至多一行）。退出后**保留该行**（`status='exited'`、`pid=NULL`），
以支撑 orphan reconcile 与世代比较；`generation` 是单调计数器，**每次 spawn 递增**。token 按
`(agent_id, generation)` 签发 ⇒ **generation 递增即旧世代 token 全部失效**，签发与撤销权威都是 Runtime
聚合，不需要额外的撤销表。

### 4.3 board —— task / file / favorite / saved 的归属

这些**不是**「只需改 JOIN 的投影」，它们有真实写面约束：`tasks.workspace_id NOT NULL` +
`UNIQUE(workspace_id, task_number)`（`task_number` 是 per-workspace 的 human/CLI 解析器），
favorites 的 list key 是 `'channels:' || c.workspace_id`（`read-model/favorites.ts:153`）。
⇒ 一个 workspace-less 会话既没有编号命名空间，也没有 favorites 键。

裁定：**Board = Workspace | Conversation**。

- `tasks` 改 `board_workspace_id NULL` / `board_conversation_id NULL` 互斥弧 + 两个 partial unique index；
- board ACL = 该 board 所属会话的参与者；
- provenance（source message → 至多一个 task）语义不变；
- favorites `list_key` 按 placement 派生（workspace 支的键不变，其余支各有前缀）。

编号命名空间对用户可见（`#task:N`）⇒ **待 @shiki 裁定**，见 §10。

---

## 5. Command 与原子性

**不写「一事务只写一个聚合」这种 blanket rule** —— 它会留下「conversation 建成而 endpoints / ACL 未落」
的半状态，并且和聚合内一致性要求自相矛盾。规则是：**聚合内不变量必须同 tx；跨聚合后果逐条定档。**

| Command | 原子性 | 幂等键 / 并发 | 禁止的 fallback |
|---|---|---|---|
| Create Agent(scope) | 同 tx | `agents.name` UNIQUE | 建隐藏 agent_home |
| Get-or-create DM | **同 tx**：conversation + endpoints + membership 投影 | `pair_key` UNIQUE，冲突读回 | 拆两 tx / title lookup / 取最老一条 |
| Create AgentInbox | **同 tx**：conversation + owner 成员行 | `inbox_agent_id` partial UNIQUE | `warn` + `return` 静默丢 |
| Join / leave | 同 tx | `(cid, aid)` PK | 对 DirectPair 生效（trigger 中止） |
| Send message | **同 tx**：message + stream head + follower/recipient plan | `(conversation_id, seq)` | 拆 tx（`applyThreadFollowEffects` 的同 tx follower + recipient plan 属同聚合一致性，语义不变） |
| Mention CC → inbox | **commit 后 domain event**（跨聚合、可重试） | 目标 inbox UNIQUE | 拉进发送 tx 扩大边界 |
| Resolve target and send | —— | 第一人称解析 | 字面 token 落库 |
| Deliver / steer / ack custody | per-stream ledger 内单调 | stream seq | 单标量 seq 覆盖多流 |
| Authorize agent op | 每请求 live membership | —— | 用凭据里的 cid 代替 membership |
| Start / stop / crash / respawn | 同 tx（slot 行 + generation） | `(scope, daemon_instance)` | 空 `conversationId` 冒充 agent key |
| Create task | 同 tx（board 内取号） | `(board, task_number)` | 跨 board 复用号 |
| Delete participant / ws / agent | 同 tx + tombstone | —— | 靠 FK cascade 抹历史 |

---

## 6. 读模型与投影（禁止投影反成权威）

- list / search / favorites / saved / task 全改 **placement-aware**（favorites 连 `list_key` 一起），
  workspace 名只是展示维度，不是过滤条件；
- member view = roster 投影；
- **一 runtime → N conversation** 的 `busy` / `focus` / `pending` 由 Runtime 聚合 + 各 stream 队列派生，
  wire 保持现有 `agent_status` 形状；混合 scope 时逐 agent 解析其 runtime scope，**读面不暴露 scope**；
- unread / activity 契约不变（#1967 的 plan 常量与 join 钉序继续有效）。

---

## 7. Runtime 与 adapter

### 7.1 凭据与 API 面（最硬的断裂）

现状：agent-facing API **全部**挂在 `/internal/conversations/:cid/agents/:aid/*`，中间件按**路径里的**
`(cid, aid)` 验 token（`routes/internal-agent.ts:73` `agentTokens.verify(token, cid, aid)`；签发
`runtime/outbound-event-fanout.ts:1183` `issue(conversationId, agentId)`），并且
`SILVERHAND_CONVERSATION_ID` + `SILVERHAND_AUTH_TOKEN` 被**烘进磁盘上的 shim 脚本**
（`spawn-prep.ts:46-63`）；`cli/src/env.ts` 的 docblock 明确 per-`(cid, aid)` token 即完整性边界、
CLI 不接受覆盖。⇒ **一个进程服务 N 个会话时，「conversation 属于凭据」这个前提失效。**

- **(a) 一进程持 N 个 per-conversation token**：shim 是一次性烘盘脚本，而 N 随 join / leave 动态变化 ——
  等于把凭据数量做成会话数的函数。**否**。
- **(b) ✅ principal 降为 Agent(generation)，conversation 降为操作参数**：新增
  `/internal/agents/:aid/*`，目标由 `--target` 给出，**授权改为每请求 live 查 membership**。

承重连带：token 只证明「我是该 agent 的这一代 runtime」，**不证明任何 conversation 权限**；某会话把该
agent 移出成员，只让该 target unauthorized，**不杀 runtime**（conversation-scoped 今天是杀）
⇒ **live ACL 是安全承重件**，不是优化。

### 7.2 cwd：三档确定性坐标（沿用 invariant I1）

v64 (`drop_workspace_local_binding_columns`) 已确立：regular workspace **不在 DB 里拥有工作目录**，它的
bundle 解析到一个**终局确定性 agent-centric 坐标** `<agent home>/workspaces/<workspace_id>`，每台 host
用同一算法算出，**没有 DB 列、也没有 registry 查询**（invariant I1）。同一 invariant 直接补齐缺口：

| RuntimeScope | cwd |
|---|---|
| `Agent(aid)` | `<agent home>` |
| `Conversation(cid, aid)` + workspace placement | `<agent home>/workspaces/<workspace_id>`（现状不变） |
| `Conversation(cid, aid)` + **workspace-less** | `<agent home>/conversations/<conversation_id>` |

三档都是纯公式、per-`(cid, aid)` 稳定且互不碰撞。这一格必须进模型而不是留给实现：进程 cwd 就是
`spawnCtx.workspacePath`（`supervisor/index.ts:2269/2281`），session cwd 是唯一被硬保证的 runtime base
（`:2142` / `:5374` + `ensureRuntimeStartWorkspaceCwd`），而 claude / qoder 的厂商 session 按 **cwd slug
hash** 定址（`session-migration.ts:117/128/144`）。因此：

- 若 workspace-less 的 **conversation-scoped** runtime 直接复用 `<agent home>` 当 cwd，多个 workspace-less
  DM 会 hash 到同一 slug ⇒ **本应隔离的 vendor session 被合并成一条**；
- 若 agent-scoped runtime 的 cwd 随当前会话变动 ⇒ 厂商 session 分叉，「一 agent 一 session」在厂商层不成立，
  DB 记账救不回。

对应地：workspace 路径在 agent-scoped 下退化为 **per-action frame 的绝对路径数据**，不再是进程身份。

### 7.3 其余落位

- **pidfile** 今天是 `<root>/<daemonInstanceId>/<enc(cid)>-<enc(aid)>.json`
  （`runtime-pidfiles.ts:70-97`）⇒ 必须**显式 scope 命名空间**（`agent/<aid>.json` vs
  `conv/<cid>-<aid>.json`）；空 cid 会产出 `-<aid>.json`，与 orphan reconcile 的扫描冲突。
- **system prompt** 今天每次 spawn 渲染到 `spawn-*/system-prompt.md`（per conversation）；agent-scoped
  下不能再声明「cwd 就是工作区」，否则相对路径会静默写到 agent root。
- **steer 降级**：`drivers/index.ts:92` `releaseProfile ∈ {native-steer, tool-boundary-steer,
  next-turn-batch, prompt-boundary, one-shot}`，**须读 live per-spawn 实例**（qoder 在
  `bindRuntimeVersion` 决议）。`one-shot` / `next-turn-batch` 无法中途接受跨会话 steer ⇒
  **显式排队 + 顺序对 agent 可见**，禁止静默丢。
- **freshness**：`spawn-prep.ts:54` 是单个 `last-delivered-seq` 标量 ⇒ 必须改 per-stream ledger，
  否则 A 流的 seq 会冒充 B 流的水位。

---

## 8. 迁移、共存与拆解

**真实约束**：已落库数据与现有 cascade 语义、厂商 session 的 cwd 定址、wire 兼容与 daemon 世代
（bump 按既有两轴规则）、**migration version 单调**。
**只是惯性**：`conversation_agents` 的现有形状、`dm_channel` 这个 kind 值、「diff 会很大」。
**有利条件**：`session_scope` 不可变 ⇒ **无需 scope 转换器、无需 per-item 迁移状态机**；两类靠 placement
+ runtime scope 键天然并存，现有 agent 永久 conversation-scoped。兼容读的删除条件：回填完成 + 该票
falsifier 通过即删，不留长期 shim。

### 8.1 DAG（migration 文件是串行化点）

四个前置件**都改 schema，落地必须串行**（version 单调、表重建互相冲突）。能并行的只是设计与实现的
**编写**，不是合并 —— 上一版把它们标成「可并行（文件面不重叠）」是错的。

```
P0-a Placement ─┬─ P0-b AgentInbox
                ├─ P0-c 稳定 name ──┐
                ├─ P3  DirectPair ──┴─ P4 DeliveryTarget ─┐
                └─ (Board，§10 裁定后)                     │
P0-d Runtime 迁出 ── P1 凭据 ── P2 scope+cwd+pidfile ──────┴─ P5 端到端 slice
```

`P0-d` 不依赖 placement（可排在 `P0-a` 前或后），但同样改 schema ⇒ 仍串行落地。
**按 vertical slice 收口，不按 backend / host / UI 横切。**

### 8.2 各票内容与 falsifier

- **P0-a Placement 显式化 + 删 `kind` + visibility CHECK 改写**（纯重构）：加 `placement_kind` 与互斥弧，
  全部回填为 workspace 支；10 处 INNER JOIN 改 placement-aware。
  **Falsifier**：非 workspace placement 的会话须在 list / search / favorites / saved / task 全部可见。
- **P0-b Mentions → AgentInbox**：不再借 `workspace_id`，删 title lookup，加 partial UNIQUE + owner trigger。
  **Falsifier**：agent 没有任何 workspace 归属会话时 CC 仍投递成功；并发只产生一行。
- **P0-c 稳定 `conversations.name`**：回填 + partial `UNIQUE(workspace_id, name)` + 保留表（删后不复用）。
  **Falsifier**：改 `title` 不改变 target 解析结果。
- **P0-d Runtime 搬出 `conversation_agents`**：建 `agent_runtimes`（两个 partial unique index +
  slot/generation），三列迁出，per-conversation 状态改投影。
  **Falsifier**：conversation-scoped 行为零变化（status SSE、`cliSessionId:null` 竞态等价于
  `outbound-event-fanout.ts:781`）；ACL 读面不再与 runtime 写同一行。
- **P1 Agent-generation 凭据 + `/internal/agents/:aid/*`**（§7.1b）。
  **Falsifier**：被移出某会话后该 target 被拒而 runtime 存活；旧路由行为不变。
- **P2 `session_scope`（+ 不可变 trigger）+ RuntimeScope 分派 + 三档 cwd + scope 化 pidfile**。
  **Falsifier**：跨多 workspace 工作后 vendor session 仍 resume 同一条；无 setter 且 UPDATE 被 DB 拒；
  两套 pidfile 不互相 reconcile 掉。
- **P3 DirectPair placement**：endpoints + 派生 `pair_key` + membership trigger。
  **Falsifier**：并发同 pair 只一行；改名不改身份；endpoint 之外的成员写入**被 DB 拒**（而不是被应用层拒），
  且 DM 成员变更 API **不存在**。
- **P4 DeliveryTarget 值对象**。
  **Falsifier**：任何持久字段或跨 principal 读面出现字面 `dm:@…` 即不通过。
- **P5 端到端 slice**：steer（含降级排队）、per-stream freshness、`busy/focus/queue` 投影、L1-only、
  prompt 口径。
  **Falsifier**：A 中 agent-scoped 工作 → B steer → `dm:@shiki` 回复 → A 继续，且**同一 conversation 内
  另有 conversation-scoped agent 同时工作**。

---

## 9. 被否方案与其失效形态

| 方案 | 失效形态 |
|---|---|
| 在 `(conversation, agent)` 上加 `if (scope==='agent')` | runtime 三列的写入点 × N 会话 ⇒ 同一 pid 被多行声明，crash 回收按行走会杀错 / 漏杀，且无红灯 |
| 保留 `agent_home` | Mentions 继续借它；10 处 INNER JOIN 继续过滤掉无归属会话 |
| 目标 schema 保留 `kind='thread'` | 逆转 v53/v54 已完成的裁定，并让 thread 重新争夺 placement 唯一键 |
| DM 只存 `pair_key` | UNIQUE 只证明字符串不重复，证明不了「恰两端、不可变、ACL ≡ 两端」；与成员表并列成双权威 |
| `pair_key` 由 handle 派生 | handle 唯一且不复用**但可改名** ⇒ 持久键静默指错人 |
| DM 唯一性靠应用层 get-or-create | `getOrCreateMentionsConversation` 已证会并发出重复 |
| `UNIQUE(scope_kind, conversation_id, …)` | SQLite 下 NULL 互不相等 ⇒ agent scope 可重复插同一行 |
| 把「schema 无 UPDATE 路径」当 schema 约束 | SQL 仍可 UPDATE；必须 trigger |
| 「一事务只写一个聚合」blanket rule | 留下 conversation 已建而 endpoints / ACL 未落的半状态 |
| workspace-less 会话复用 agent root 当 cwd | vendor storage 按 cwd 定址 ⇒ 本应隔离的 session 被合并 |
| 把 task / file / favorites 当纯投影 | `tasks.workspace_id NOT NULL`、`UNIQUE(workspace_id, task_number)`、`'channels:'||workspace_id` 是真实写面约束 |
| per-conversation token × N 装一进程 | §7.1(a)：凭据数量成为会话数的函数，而 shim 是一次性烘盘 |
| 单标量 seq 复用多流 | 静默漏投 / 重投 |
| `busy/focus` 投影当写权威 | 多流聚合写回会丢单流状态 |

---

## 10. 待人类裁定（唯一一项）

**workspace-less 会话中 task / file 的归属与编号命名空间**（§4.3）。

- 我的方案：**Board = Workspace | Conversation**。DM 里建的 task 归该 conversation，编号在该 board 内
  从 1 起 ⇒ `#task:N` 在 DM 与 workspace 之间**同号不同义**。
- 备选：**禁止**在 workspace-less 会话建 task（CLI surface 因此不完整）。

需 @shiki 裁定。（DM 的 tombstone + 保留历史已在 #task:2005 拍板，不属未决项。）

---

## Acceptance

失败条件 = §5「禁止的 fallback」列 + §9 全部被否形态，任一出现即不通过。

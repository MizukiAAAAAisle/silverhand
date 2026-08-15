# Silverhand — Architecture Principles

> 本 doc 锁定 silverhand "Human/Agent 同构"主线的架构约束。
>
> 本 doc 是 silverhand **后端**新功能 / 新 service / 新 DB 表 / 新 migration 必须遵守的约束清单，与 `core-design.md`（产品/数据模型权威）和鉴权模型权威（`auth-and-host-model.md` 身份/资源归属 + `graded-permissions-v1.md` 分级能力）平级。代码与本 doc 冲突时，以本 doc 为准。**（§11 是例外：compat / legacy / fallback shim 的退出条件是系统级约束，同样覆盖客户端 / renderer 的兼容 shim，不限后端。）**
>
> 任何提交前 review 都应当用 §1 checklist 检查；任何例外必须在设计稿里写明理由。

---

## 0. 一句话原则

> **Human 和 Agent 走同一个 service 方法。行为差异**只能**通过 `POLICIES` 表声明，不允许在业务代码里散播 `if (kind === 'user')` 分支。**

---

## 1. 设计期 checklist（强制）

设计任何"既可能由用户触发、也可能由 agent 触发"的功能时，按下表自检：

| # | 检查项 | 通过条件 |
|---|--------|---------|
| 1 | Service 方法签名是否对 user/agent 同一份？ | 入口接收统一的 `Principal`，不要 `sendUserMessage` + `sendAgentMessage` 两个方法 |
| 2 | 行为差异是否走 `POLICIES` 表？ | 新增 policy 字段而不是 `if (actor.kind === 'agent')` |
| 3 | Actor / Principal 是否在**路由 boundary** 构造？ | route handler 解析 token/header/url → 构造 actor → 调 service。Service 内不再解析身份 |
| 4 | 是否新增 actor union？ | **不要**。身份已统一到 `Principal`（`user` / `agent` / `system`，见 `packages/backend/src/auth/principal.ts`）；service 直接接 `Principal`，不要再引入 `*Actor` union（身份构造契约见 `auth-and-host-model.md` §3.5） |
| 5 | DB 字段是否区分 `*_kind + *_id` 两列？ | 参照 AttachmentService 的 `createdByKind:'user'\|'agent', createdById:string`。**不要**建 `user_id` + `agent_id` 两列各占一边 |
| 6 | Workspace member 关系是否只覆盖 regular workspace？ | `workspace_members` regular-only。**不要**为 `agent_home` 加 member 行；agent_home 的 agent 关系**只**走 `workspaces.owner_agent_id`（DB BEFORE INSERT trigger 兜底） |
| 7 | 是否新增"隐式信任 header"？ | **禁止**。新身份信息必须走 session token / URL 明示，不能让 caller 自填身份。内部路由已硬性 400 拒绝 principal header（见 `auth-and-host-model.md` §3.5） |
| 8 | 是否裸奔 attachment / 私有资源 GET？ | 必须在 **route 层**（不是 service 注释里）显式做 viewer + ACL 校验 |

---

## 2. POLICIES 表 —— 行为差异的唯一表达

当前已有的 5 个开关：

```ts
const POLICIES = {
  user:  { requireSenderMembership:false, allowTarget:false, autoStartIdleRecipients:true,  ccMentions:true,  resolveRun:false },
  agent: { requireSenderMembership:true,  allowTarget:true,  autoStartIdleRecipients:false, ccMentions:false, resolveRun:true  },
};
```

**新增行为差异的步骤**：
1. 先尝试加一个新 policy 字段（如 `allowAttachmentDelete:boolean`），让 user 和 agent 各填一个值
2. service 内改成读 `POLICIES[principal.kind].allowAttachmentDelete`
3. 不要写 `if (actor.kind === 'agent')` 业务分支
4. 如果差异**真的**无法用布尔/枚举开关表达（极少），在设计稿里写明理由再例外

---

## 3. Principal（当前统一身份主语）

身份已统一到单一 `Principal`（`packages/backend/src/auth/principal.ts`），旧的四个
`*Actor` union（`SendMessageActor` / `ChannelActor` / `TaskActor` / `ThreadActor`）已被折叠移除：

```ts
// packages/backend/src/auth/principal.ts
type Principal =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; agentId: string; conversationId: string }
  | { kind: 'system' };
```

**新功能不准发明新 actor union**，直接接 `Principal`。身份如何构造（每类路由的输入来源、内部路由拒绝 principal header）是 `auth-and-host-model.md` §3.5 的单一权威；本 doc 只引用不重述。

---

## 4. Workspace / Channel / DM 模型不变量

| 不变量 | 含义 |
|--------|------|
| `workspaces.kind ∈ {regular, agent_home}` | 没有第三种 |
| 每个 agent 有且只有一个 `agent_home` workspace | UNIQUE on `owner_agent_id` |
| `agent_home` 可以包含**多个** `dm_channel` | `Onboarding`（默认）+ `Mentions` + 未来更多。**不要**假设 "exactly one" |
| `WorkspaceDto.dm_channel_id` = default landing channel | **不**意味着唯一约束。措辞别再叫 "primary" |
| `WorkspaceDto.dm_channel_ids` = 全量 DM channel id 数组 | 给旧 caller 拿 secondary id 当 workspace id 时做 fallback |
| `workspace_members` 不接受 `agent_home` 行 | DB 层 BEFORE INSERT trigger 兜底 |
| 新建 agent 默认 dm_channel 标题 = `Onboarding` | 不再叫 `dm-<name>`；迁移过来的旧名保留不动 |

---

## 5. Migration 强约束（v16 模板）

涉及表结构改动的 migration runner 必须按 v16 同款实现：

```
outer txn:
  PRAGMA foreign_keys = OFF
  inner ops:
    PRAGMA legacy_alter_table = ON
    <migration SQL>
  PRAGMA foreign_key_check  ← 任何破洞 abort
  insertMigrationVersion
PRAGMA restore (foreign_keys=ON, legacy_alter_table 恢复原值)
```

**新写 migration 必须**：
1. 用 v16 runner 同款外 txn / 内 pragma 嵌套
2. commit 前跑 `foreign_key_check`，零破洞才允许提交
3. 失败路径恢复 pragma（不能让 process 残留 OFF）
4. 真实数据上线前用 `SILVERHAND_DIR=/tmp/silverhand-<feature>-dryrun-$(date +%s)` 做 sandbox dry-run

---

## 6. 反模式（出现就要打回 review）

- 新 service 方法以 `User` 或 `Agent` 开头（`sendUserMessage` / `agentJoinChannel`）
- service 内出现 `if (actor.kind === 'user')` 的业务分支（**ACL 例外，policy 才是惯例**）
- 新 route handler 自己解析 `X-Silverhand-User-Id` 当身份（应走 middleware）
- 新增 DB 表用 `user_id NOT NULL` 或 `agent_id NOT NULL`，而不是 `actor_kind + actor_id`
- 新写的 migration 没用 v16 runner、没跑 `foreign_key_check`
- `agent_home` workspace 上加 `workspace_members` 行
- 新建 dm_channel 时硬假设"agent_home → exactly one dm_channel"
- 新 route 在 service 注释里说 "caller has already passed auth"，但 route 实际没校验
- 新增 compat / fallback / 迁移过渡 shim，但注释/设计稿里没写「退出条件三件套」（守哪个具名契约 / 删除触发条件 / owner）（见 §11）

---

## 7. 鉴权硬约束（新功能必须守住的现状，不得回退）

> 以下曾是 PR-1~6 时期的已知漏洞，现已全部收口。它们在此保留为**约束**——新功能不得把任何一条重新打开。身份/资源归属模型见 `auth-and-host-model.md`，分级能力见 `graded-permissions-v1.md`；本节只引用不重述。

- **公开 `/api/*` 必须经身份校验**：session bearer（`user_token`）→ `auth_sessions` subject 解析出 `user` principal；无 principal 的请求落到 registration gate（`403 registration_required`），不再"本机任意进程可调用"。
- **身份不由请求方 header 声明**：内部路由（`/internal/agents/:aid/*`）对 `X-Silverhand-Principal` 硬性 **400 拒绝**，agent id 由 URL 绑定并必须与 live runtime-slot bearer 一致；目的地授权由显式地址/对象解析后的 participation + reach 判定。公开路由的 `user` 身份只由 bearer 中间件写入。旧的可伪造 `X-Silverhand-User-Id` 路径已关闭（见 `auth-and-host-model.md` §3.5）。
- **私有资源 GET 必须在 route/permissions 层做 ACL**：`GET /api/attachments/:id` 走 `canViewAttachment`（channel-scoped，公开分支仅限被持久化消息引用的字节），不再裸奔。
- **WS 订阅 scope 走真实 membership 校验**：`canViewWorkspace` / `canViewConversation` 现读 `workspace_users` / `conversation_users` 成员边，不再是 exists 占位。
- **身份/成员表已落地**：`users` + `workspace_users`（含 `role`）+ `conversation_users` 均已存在（v25）；多人模式在此基础上加层，不改归属语义。

新功能涉及任一点时**必须在设计稿里写明：是顺手强化、还是显式接受现状**——绝不允许无声回退。

---

## 8. Review 锚点

PR / 设计稿 review 时按以下顺序检查：
1. §1 checklist —— 8 项逐一过，违反需要解释
2. §6 反模式 —— 不能命中
3. §7 鉴权硬约束 —— 涉及到的必须显式回应，不得回退
4. 涉及鉴权 → 同时过 `auth-and-host-model.md`（身份/资源归属）+ `graded-permissions-v1.md`（分级能力）
5. 涉及数据模型 → 同时过 `core-design.md` §2
6. 涉及 spawn / 子进程 / runtime 生命周期 → 同时过 §9 AgentHost runtime boundary
7. 涉及 compat / legacy / fallback / 迁移过渡 shim → 过 §11 退出条件三件套（守哪个具名契约 / 删除触发条件 / owner）
8. 涉及 unread / workspace / channel / dm 的 visibility / projection / restore 改动 → 过 §12 可见性完整性 checklist(10 项)+ 每条 falsifier + §12.2 边界条款

---

## 9. AgentHost runtime boundary（control plane vs execution plane）

> Anchor for `docs/silverhand-daemon.md`.

### 9.1 两个 plane 的分工

| plane | 角色 | 例子 |
| --- | --- | --- |
| **control plane** | IM server：HTTP route、DB、ACL、消息分发、scheduler | `packages/backend` |
| **execution plane** | AgentHost：spawn agent CLI、stdin/stdout、文件系统访问、API key、本地 PATH | `packages/host`（daemon，承接 spawn / inbox-drain / run-state） |

**核心 invariant**：spawn agent CLI 是 execution plane 的事，**不是** control plane 的事。
agent spawn / inbox-drain / run-state 归 `packages/host`（daemon），backend 只记 runtime intent / state、不持有 OS process handle。

未来 remote / sandbox 形态：
- 云端 backend 不可能 spawn `claude` —— 没装、没用户 fs、没 API key；
- 沙箱内 daemon 持有真正的 user-side 运行时，向 IM 上报；
- Electron 客户端订阅 IM 广播，**自己也不 spawn** —— 它跟其它客户端等价。

### 9.2 设计期检查项（写新 service / route / 进程时过一遍）

- 这件事是 IM 语义（who-can-see-what / 持久化 / 投递）还是 host 语义（spawn / IO / fs / 进程生命周期）？答错就是把代码塞错 plane。
- 如果未来把 backend 部署到云端，这件事能放到云端跑吗？跑不了说明它属于 execution plane。
- 该功能需要的 OS 资源（pid、socket、子进程句柄、本地 fs path）有没有越过 IPC 边界泄漏到 backend 数据结构里？越过了就是把 host 的实现细节固化到 control plane 协议里。

### 9.3 边界条款（不能违反）

1. **agent-facing CLI 永远只暴露业务面**（message / task / channel / thread / workspace / file / schedule）。daemon 控制权（spawn / pid / version / token 颁发）属基础设施层，**不允许**写成 `silverhand host ...` 子命令。
2. **backend 记 `(conversation, agent)` runtime intent / state；不记 OS process handle**。handle 永远归 host。
3. **host 是真正的安全边界**：进程在哪个 host 上跑、能访问哪些 fs / API key，host 是 truth source。host 已被建模成一等公民并作为 runtime 协议端点参与 spawn；一切 runtime 归属都以 `agent.host_id` 为轴（cross-computer slice 2 起，workspace 成员可合法分布在不同 computer 上，`agent.host_id == workspace.host_id` 不再是任何层的前置条件。**workspace 没有 home computer**：`workspace-layout-relocation-v1.md` §7 退役了 `workspace_host_id`，agent 的 L2 bundle 是 `<agent home>/workspaces/<workspace_id>` 这个确定性 agent-centric 坐标，不由任何 DB 列或 registry binding 解析。agent 消息 header 携带 `computer=`、prompt 行为合同与 membership 入口同批启用）。
4. **CLI 不是秘密边界，backend token + ACL 才是**。任何"防止 agent 看见 X"的需求，应该走 backend authz，**不要**走"agent 看不见这个命令"的路径——agent 是有自主性的 actor，藏命令并不等同于授权拒绝。
5. **创建 host-placed 资源时,origin surface 必须显式带 host。** `POST /api/agents` 的 `host_id` 以及未来任何 optional `*_host_id` 都不能让 desktop UI 依赖 backend 的 0/1/N fallback。即使 picker 因为当前只有一个 host 而隐藏,desktop 也要发送当前 bound host id；backend fallback 只保留给无 origin-host 上下文的 API/remote caller,并在多 host 时 fail closed。**这一条只适用于真正 host-placed 的资源**：workspace 不是——`workspace-layout-relocation-v1.md` §7 退役了 `POST /api/workspaces` 的 host 与 path 输入,它是纯 control-plane 写,不带任何 placement 语义（对应的 `local_host_unbound` / `local_host_ambiguous` 也随之不再产出）。

### 9.4 spawn / inbox / run-state 的归属（当前实现）

| 关注点 | 归属 |
| --- | --- |
| spawn agent CLI | `packages/host` daemon（独立子进程） |
| inbox drain | daemon |
| run state record | daemon → backend 通过 event 上报 |
| backend ↔ daemon 通信 | `HostClient`（embedded 走 Unix socket，standalone 走 outbound WS）——已落地且**必需**，不是可选 |

backend 已不再自己 host ConversationManager；spawn / stdin-stdout / inbox-drain / run-state 全部归 `packages/host` daemon。backend 只记 `(conversation, agent)` 的 runtime intent / state，不持有 OS process handle。**host 是真正的安全边界**：控制面（backend 记 intent / 颁 token / 走 ACL）与执行面（daemon 持 pid / 跑进程 / 触碰 fs 与 API key）分离；spawn 的归属轴是 `agent.host_id`（事件周界同样只查 agent 归属 + conversation membership，不查 workspace host——cross-computer slice 2 起 workspace host 只表示 workspace 的 home computer，不再约束成员分布）。

---

## 10. 事件传输 / cursor 模型不变量 + 命名的非目标

> Anchor for `docs/event-ws-transport-v1.md`（机制权威）。本节只锁**不变量与命名的非目标**；mechanism（received/applied 两水位、satisfaction disposition、recovery class、ingestor）在 transport doc 单一 canonical，本节不重述、体检/其它 doc 只引用不 co-state。

### 10.1 单一 fanout seq 源 —— **命名的非目标：多节点**

cursor 模型的命根是一条等式：

> **`EventFrame.seq ≡ 该 scope 的 publish-log seq`**（per-scope 单调 +1、全序）。

这个全序当前是 **single-writer WAL**（backend 单进程串行 append）**白送**的，没有额外协调。client-authoritative cursor（server 永不静默推过 client 未见帧）、中央 ingestor、进程内 fanout **三者都建立在「单一 seq 源」这个前提**上。

**因此「单节点 / 无消息总线」是当前的显式非目标，而不是「性能上单节点够用」。** 失败模式必须写明才有牙：

- 多节点一上，两个 backend 各自对同 scope 发 seq → **同 scope seq 不再全序**；
- client 的 resume floor 指向的 seq 在另一节点是**别的帧** → 补帧 / 重放 / snapshot 全部错位；
- 结果是 **client-authoritative cursor 从根上被打穿**（correctness 前提消失，不是延迟/吞吐问题)。

**约束：** 任何引入第二个 seq writer 的方案（多 backend 节点、跨节点 fanout）**必须先**用共享有序 log 或 per-conversation sticky 把「单一 seq 源」这个前提还回来，再谈横向扩展。在那之前不允许按多节点假设设计传输/cursor 相关代码。

### 10.2 seq / id-space 命名规则 —— 跨 space 类型不可混用

系统里存在多条语义不同、**绝不可互相播种**的序号轴：

| 轴 | 语义 | 谁推进 |
|----|------|--------|
| **transport seq** | 某 WS scope 的 publish-log 位置（wire 连续性 / gap / resume floor） | transport（received/satisfied 两水位） |
| **message seq** | 某 conversation stream 里消息的持久顺序（history / freshness CAS / positional unread） | message repo（`messages.seq` / `conversation_stream_heads`） |
| **read seq** | 某 viewer 的 read/observe cursor 位置 | read model（observe / `notifications.read_at`） |

**约束：** 这三根轴**不允许**用一个裸 `number` 表达、不允许互相赋值播种。我们已经踩过 `stream_head_seq`（message 轴）被用去播种 transport cursor 的坑——那类 bug 的终态修法是**类型让它编译不过**，不是靠 review 眼力。S2（brand-typed `TransportSeq` / `MessageSeq` / `ReadSeq`）是这条规则的落地机制；在 S2 落地前，新代码至少要在命名 + 注释上显式标轴，禁止跨轴直传。

### 10.3 capability bucket 新增判据

agent 授权是 capability-based（见 `graded-permissions-v1.md`）。新增 capability 桶时的判据：

> **桶映射到「协调相关的动作类别」，不是映射到 endpoint。**

一个新 endpoint 默认落进**已有**的动作类别桶；只有当它代表一类**语义上独立、需要被单独授予/收回**的协调能力时才开新桶。否则 capability 模型会 rot 成 per-route flag（桶数 ≈ 路由数），失去「授权是粗粒度协调契约」的本意。加桶必须在设计稿里回答：这是哪一类协调能力、为什么现有桶盖不住、owner/admin 会不会真的想单独控制它。

---

## 11. Compat / legacy shim 的退出条件（合入 gate）

> 这轮 #1301 legacy 审计（#1303/#1304/#1305/#1310/#1311/#1312）清的所有东西，根因都是同一个：当初 shim 加进来时没写退出条件、没人知道何时能删，于是永久沉淀成债。本节把审计时**事后**用的 A/B/C 判据**前置成合入 gate**——治本，免下一轮考古。

**本节范围 = 系统级**（不限后端）：compat shim 在后端和客户端 / renderer 两个 plane 都会长（如 renderer 对历史 system-message 行的 fallback），退出条件对两边同样强制。

**约束：新增任何 compat / legacy / fallback / 迁移过渡 shim，必须在代码注释（或设计稿）里内联「退出条件三件套」，缺任一项不许合入：**

| # | 项 | 说明 |
|---|-----|------|
| 1 | **守哪个具名的真实契约** | 这层 shim 在保护哪个**具体的、真实存在**的契约？公开 API / 已落库的旧数据行 / 文档化的对外集成 / 对用户的承诺。答不出具名契约 = 它守的是「空」，现在就不该加（存量的立即删）。 |
| 2 | **删除的明确触发条件** | 什么**可观测事实**为真时这层就该删？e.g. `DB count(fossil)=0` / 旧 client 全部下线 / 全 workspace registry-bound / 某 migration version 之后。必须是可验证的谓词，不是「以后再说」。 |
| 3 | **owner** | 谁负责在触发条件满足时删它。无主的 shim 永远不会被删。 |

**退役时按 A/B/C 三桶处置（判据来源）：**

- **A 守空** → 触发条件本就满足或契约为空 → 现在就删，根本不该新增。
- **B 守可能不存在的 fossil 行** → 触发条件 = 对该 fossil 跑 DB count。count=0 → 删整条兼容分支 + 相关 DTO/API 判别式/字段；count≠0 的处置 = 有价值→迁移 / 可丢→同刀 destructive 删 / 既不能丢又无迁移目标才「保留」（last resort）。**legacy 数据存在本身 ≠ 清理否决项**——否则任何 legacy 都清不掉。
- **C 守活契约** → 它在活读，count=0 也不授权删（故不是 B）。按②删除触发条件能否满足，分两味：
  - **C1 永久前向兼容** → ②触发**永远不满足**。典型：**local-first 多 DB 下 renderer 对历史行的 fallback**——每个用户库都留着自己的旧 system-message 行、缺失字段（如 task audit 行的 `actor`）不可回填、任何**单库** count 都不授权删。这类是**永久兼容，不是 legacy debt**；②写明「永久（local-first 历史行）」并在代码里标 `// intentional forward-compat, not legacy`，防下一轮审计误删。
  - **C2 活迁移 seam / 活展示契约** → ②触发**可满足，但前置是「设计刀」而非某个 count 归零**。典型（已退役，留作范例）：`workspace_path`（一列背 create 输入 / daemon binding cache / 用户可见展示 path 三契约，曾被启动·恢复·Open-in-Finder 活读）——退役前提是先做设计动作把三契约拆开分别安置，不是等 count=0。②写明该**设计前置** + owner；前置达成前按 C 保留，绝不当死码删。该设计刀由 `workspace-layout-relocation-v1.md` §6/§7 完成（确定性 agent-centric L2 坐标接掉 daemon binding、展示 path 归 session cwd、create 输入随 plan-A epoch 原子一刀移除），刀落之后该列与其 DTO 字段才一次性删除——**这正是 C2 的正例：先做设计前置，再删，不是等 count=0，也不是当死码删**。

**失败模式（不钉这条会怎样）：** shim 加进来时没记录守什么、何时能删 → 半年后审计者面对一堆 compat 分支，分不清哪个是死化石、哪个还守着活契约，只能逐个 DB probe + 全链路 grep 重新考古（正是 #1301/#1303/#1311/#1312 花掉的力气）。退出条件把这份成本从「每次审计 O(n) 考古」降到「加入时 O(1) 写清楚」。

## 12. 可见性丧失 / 派生投影完整性（unread / workspace / channel / dm / archive / delete 域）

> **一条「可见性丧失」是跨派生面的领域事实,而非单一 surface 的属性。** archive、soft-delete、workspace-delete、membership 移除、dm-hide 均会 fan-out 至多张派生投影。正确修法为:一条领域事实 → 枚举全部 consumer → 各 consumer 按其语义清除或排除;不得仅在触发该事实的 surface 上打补丁。
>
> 本节是该域任何改动的**合入 gate**。§12.1 checklist 每条附一个 **falsifier**(用以证明该项未产生误判通过 / false-positive pass)。机制细节见 `activity-lifecycle-v1.md` 与 `core-design.md`(CQRS);本节只规定不变量与可机械核对的判据。(provenance:#1398/#1400/#1402/#1403/#1404/#1409/#1410/#1411/#1412/#1413。)

### 12.1 设计期 checklist(该域强制,每条附 falsifier)

| # | 检查项 | 通过条件 = falsifier(如何证明未误判通过) |
|---|--------|---------|
| 1 | **bounded context 归位** | 缺陷必须修在其归属层:lifecycle、projection-membership(favorites/roster)、read-attention(unread/Activity)、UI-cache、navigation-restore 各自独立。falsifier:若为修复一个 navigation 缺陷而改动 unread 清扫逻辑,即为归错层(见 #1413:archive 且存在 unread 只是触发条件,非缺陷归属层)。**CQRS 强约束:workspace-scoped 查询对 regular 与 DM 两 collection 不得 union**(唯一例外为全局 archived 恢复索引)。 |
| 2 | **改动任一投影前,须先枚举全部 consumer** | 对已知投影清单逐个裁定「排除或保留」:badge/rollup(含 `by_conversation`)、Activity 列表(含其 bool 投影,如 rail dot)、favorites 行(含 `viewer_sort.entries` 等嵌套)、roster、search、nav auto-restore 候选。falsifier:一条删除 / 归档事实后,以一个 whole-cache 断言证明该 id 在每张投影中均不残留;matcher 必须使用 delimited-segment(见 §12.1#10),不得使用 exact-only——exact-only 无法检测复合 id `workspace:<wsId>`(见 #1404 遗漏 favorites、#1409 遗漏 Activity 的 mention 路径)。 |
| 3 | **清除方式须按 query scope 分档**(独立于「枚举」的另一半) | 枚举完成后,清除方式分两档:**scoped query**(删除后将 404,如 per-ws `by_conversation`)必须 `removeQueries`,不得 refetch;**global query**(删除后不 404,如 favorites/Activity)必须使用本地 membership filter,不得 invalidate 整表(重量级 server-scored / ordered list 的整表 refetch 会 re-score 并 reflow 幸存项)。falsifier:删除后幸存项的顺序与身份保持不变(不止「被删项消失」)(见 #1404/#1409)。 |
| 4 | **consumer-split,不得就地收窄** | 同一 source list 的多个消费面各自读取独立投影,不得塌缩为单一开关:**auto(default/remembered/fallback)↔ explicit(jump/search/deeplink)**、**display ↔ control-plane**、**active ↔ union**。falsifier:控制面与显式面均不受 display scope 门控(见 #1398:Stop 按钮 enablement 曾被 display filter 门控,构成 fail-closed 缺陷)。 |
| 5 | **语义不同的轴不得混用**(同族三类,各有 incident) | 语义不同的两个概念不得塌进同一个门:**① `archive ≠ delete`**——archived 必须同时满足「显式可达」与「自动不可达」,两方向均须测试(见 #1413);**② `freshness(isFetching)≠ fact`**——背景 refetch 期间 `isFetching` 为真,不得据此驱动「最后 settled 事实」的展示门,falsifier:mock 一次背景 refetch,断言已 settled 值不被瞬时抹为 loading/undefined(见 #1376);**③ `advisory ≠ correctness`**——best-effort / 可自愈信号(如 mark-read epoch)不得升格为渲染门或 correctness 门,falsifier:该信号判定错误时,渲染与定位仍有界退出、不死锁(见 #1317)。 |
| 6 | **读路径校验为权威,写路径清理仅作 belt-and-suspenders** | 指向已隐藏对象的 stale pointer(`lastChannelByWorkspace` / cursor / cache)由读路径校验治理(读取时校验 active),不得依赖 archive 时的顺带 clear。falsifier:模拟一个未被清除或跨设备的 stale pointer,证明读路径将其拦截;若仅有 clear-on-write 而无读路径校验,则不通过(见 #1413)。 |
| 7 | **每个改动派生聚合的状态迁移必须 emit** | 任何改动 `ROLLUP_UNREAD`(或任一缓存聚合)的迁移都必须发出递减 / 更新事件。falsifier:逐条状态迁移断言其 emit;遗漏一条,则 in-place badge cache 只能在下次 refetch 时自愈(见 #1284/#1404;逐点补漏 anti-pattern)。 |
| 8 | **完整性网须选对档**(见 §12.3) | 按「载体形态 × blast-radius」选择,既不得一律采用 registry,也不得一律依赖命名约定。 |
| 9 | **不得夸大 chokepoint 的层级** | 必须准确声明其实际守护范围:cleanup-declaration chokepoint(强制「进入 registry 者必带 cleanup」)≠ query-definition chokepoint(key 由 registry 拥有、无法绕过)。falsifier:裸写 `useQuery` 而从不进入 registry 是否可绕过?若可,则它不是 definition chokepoint,注释与 residual 必须如实写明(见 #1412)。 |
| 10 | **测试保真度** | whole-cache / route conformance 测试必须 seed 真实嵌套字段与 composite id(如 favorites `viewer_sort.entries[].entity_id`、`workspace:<wsId>`);matcher 必须使用 delimited-segment(`split(/[:/]/).includes(id)`),不得使用 exact-only(遗漏复合 id)或 substring(误吃 preview)。falsifier:禁用被测的 cleanup,测试必须转红(以证其非误判通过,见 #1412/#1413)。 |

### 12.2 边界条款(不得违反)

1. **consumer-split:不得就地收窄共享 list。** 当一份 list 同时被自动入口与显式入口、或展示面与控制面消费时,过滤必须实现为每个消费者独立的投影(如 `activeTopLevel` 对 `allChannels`、`visible_*` 字段),不得在原 list 上就地收窄——否则控制面 / 显式面将被 display scope 门控,fail-closed 缺陷在上一层重现(见 #1398/#1413)。
2. **`archive ≠ delete`。** archived 对 owner 仍为一等可见对象:显式入口(jump/search/deeplink/Archived 面板)必须保持可达;自动落地(default/remembered/fallback/auto-select)必须排除。两者均为硬约束,缺任一条即为缺陷。
3. **一条领域事实 → 单一 handler 枚举清除全部 viewer-local 投影,不新增事件。** 反模式为:为每张投影发一个专用事件(导致耦合爆炸)。正解为:后端发出一条领域事实(如 `viewer_workspaces_changed(removed)`),renderer 以单一 handler 枚举所有受影响投影并逐个本地 cleanup(id-consuming filter,不 refetch、不重排幸存项)(见 #1404/#1409)。
4. **读路径校验为权威边界。** 见 §12.1#6。与 §12.1#1 的 absence / `?? 0` onset 语义治理同源:absence / stale 并非中性状态,而是一个被默认选中的语义,必须在读边界显式定义。

### 12.3 完整性网档次判据(载体形态 × blast-radius)

「防止遗漏一条 source / 投影」包含两半,不得将第二半视为已解决:①**declared → 必登记、必测**(穷尽 `switch{…default:never}` 或 `satisfies Record<Id,…>` 在新增 declared 值时编译失败)——此半可由类型层焊死;②**全新 same-kind source / projection 从未登记**——穷尽 switch 无法覆盖(其 key 落在已声明的 id 上)。堵住②的唯一方式,是将不变量做进构造并配以可枚举 registry。

**完整性网的强度取决于「归属」信息的载体形态:类型(编译期 `satisfies` / registry)> 源码 scan > 命名约定。** 选档判据如下:

| 缺口形态 | 正解档 | 例 |
|---|---|---|
| 一条事实 fan-out 至 N 个分散 carrier(多 cache,或单一读模型的多条组装路) | chokepoint / registry + 类型闭环 + whole-cache 不变量(新增一条未登记即编译或测试转红) | 见 #1410(Activity source registry)、#1412(viewer-local projection registry) |
| 单一漏斗 + 小型 pure fn + 少量分支,或 by-construction 版本将扰动一个既有 hardened 不变量 | 共享谓词 + falsification 测试 + 显式 residual(以命名将模型刻入变量,如 `channels`→`allChannels`) | 见 #1413(navigation restore resolver,其 precedence 被 #1082/#1145/#1300 锁定) |

**blast-radius 判据:** 当 by-construction 为零风险的 additive 层(新建 registry / 类型,不改动既有代码)时,即使成本相当或更低也应采用;当 by-construction 需重构一个既有 hardened 不变量(如 precedence-lock)时,将引入回归风险,应维持在 convention-floor 层级。不得为了防范尚未出现的分支而重构既有硬不变量。无论选择哪一档,residual 必须显式写在注释与测试中——不得使 by-convention 的代码呈现为 by-construction,以免后续读者误以为第二半已消除。

### 12.4 失败模式(未遵循本节的后果)

- **跨分散投影的逐点补漏(anti-pattern)**:仅修复触发该 feature 的一张投影,favorites / Activity / roster 各自残留(见 #1404/#1409)。
- **单个读模型内部多条组装路的逐点补漏**:`listActivity` 的 positional 路径有 `archived` 过滤而 directed 路径没有 → archive 后 ambient 项掉出但 @mention 残留(见 #1409)。审计粒度必须是「每条产生可见项的 query / assembly 路径」,而非「文件」。
- **误判通过(false-positive pass)的测试**:seed 遗漏真实嵌套字段(favorites `viewer_sort`),或 matcher 使用 exact-only / substring → 该字段或复合 id 误判通过「NOWHERE」断言(见 #1412/#1413)。
- **夸大 chokepoint**:将 cleanup-declaration 声称为 query-definition,使后续读者误以为 raw `useQuery` 亦被拦截(见 #1412)。

> **Review 时**:该域改动必须按 §12.1 十项逐条通过,且不得命中 §12.2 四条边界;新增 source / projection 必须能被 §12.3 的登记 / 测试机制在编译期或测试期捕获漏项;无法捕获者,应在加入 UI 前停止。

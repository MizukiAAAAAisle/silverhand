# Silverhand — Architecture Principles

> **Status**: 2026-05-09 整理。来自 PR-1 ~ PR-6 落地的"Human/Agent 同构"主线。
>
> 本 doc 是 silverhand **后端**新功能 / 新 service / 新 DB 表 / 新 migration 必须遵守的约束清单，与 `core-design.md`（产品/数据模型权威）和 `permissions.md`（鉴权模型权威）平级。代码与本 doc 冲突时，以本 doc 为准。**（§11 是例外：compat / legacy / fallback shim 的退出条件是系统级约束，同样覆盖客户端 / renderer 的兼容 shim，不限后端。）**
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
| 1 | Service 方法签名是否对 user/agent 同一份？ | 入口接收 `*Actor` union 或 `Principal`（Slice A' 后），不要 `sendUserMessage` + `sendAgentMessage` 两个方法 |
| 2 | 行为差异是否走 `POLICIES` 表？ | 新增 policy 字段而不是 `if (actor.kind === 'agent')` |
| 3 | Actor / Principal 是否在**路由 boundary** 构造？ | route handler 解析 token/header/url → 构造 actor → 调 service。Service 内不再解析身份 |
| 4 | 是否新增 actor union？ | **不要**。复用现有 `SendMessageActor` / `ChannelActor` / `TaskActor` / `ThreadActor`，最终目标是统一到 `Principal`（见 `permissions.md` §4） |
| 5 | DB 字段是否区分 `*_kind + *_id` 两列？ | 参照 AttachmentService 的 `createdByKind:'user'\|'agent', createdById:string`。**不要**建 `user_id` + `agent_id` 两列各占一边 |
| 6 | Workspace member 关系是否只覆盖 regular workspace？ | `workspace_members` regular-only。**不要**为 `agent_home` 加 member 行；agent_home 的 agent 关系**只**走 `workspaces.owner_agent_id`（DB BEFORE INSERT trigger 兜底） |
| 7 | 是否新增"隐式信任 header"？ | **禁止**。新身份信息必须走 token / URL 明示，不能让 caller 自填身份（见 `permissions.md` §4.2） |
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

## 3. 当前 Actor union（设计期请优先复用）

```ts
// packages/backend/src/services/*.ts
SendMessageActor  = user{userId} | agent{agentId}
ChannelActor      = user{userId} | agent{agentId, conversationId}
TaskActor         = user{userId} | agent{agentId, conversationId}
ThreadActor       = user{userId} | agent{agentId}
// AttachmentService: createdByKind + createdById（特殊：附件创建者天然不需要 conversation 上下文）
```

**新功能不准发明新 actor union**。要么复用，要么直接按 `permissions.md` §4 的 `Principal` 设计（如果 task #125 已合并）。

---

## 4. Workspace / Channel / DM 模型不变量（PR-6 后）

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

## 7. 已知漏洞（新功能要绕开 / 顺手补 / 显式接受）

⚠️ 这些坑 PR-1~6 没有修，详情和修复路径见 `permissions.md` §3。新功能涉及任一点时**必须在设计稿里写明：是顺手补、绕开、还是接受现状**：

- `/api/*` **无 Bearer 校验**（Slice B 修）
- `X-Silverhand-User-Id` 被 header 信任，可伪造（Slice A' 修）
- `GET /api/attachments/:id` **裸奔**：service 注释撒谎（Slice C 修）
- WS `canViewWorkspace` / `canViewConversation` 是 exists check 占位（Slice D 修）
- 没有 `users` 表，没有 `human_workspace_members` 表（远端/多人模式时再补）

---

## 8. Review 锚点

PR / 设计稿 review 时按以下顺序检查：
1. §1 checklist —— 8 项逐一过，违反需要解释
2. §6 反模式 —— 不能命中
3. §7 已知漏洞 —— 涉及到的必须显式回应
4. 涉及鉴权 → 同时过 `permissions.md`
5. 涉及数据模型 → 同时过 `core-design.md` §2
6. 涉及 spawn / 子进程 / runtime 生命周期 → 同时过 §9 AgentHost runtime boundary
7. 涉及 compat / legacy / fallback / 迁移过渡 shim → 过 §11 退出条件三件套（守哪个具名契约 / 删除触发条件 / owner）

---

## 9. AgentHost runtime boundary（control plane vs execution plane）

> Anchor for `docs/silverhand-daemon.md` (PR-1 落地 `#task:510`)。

### 9.1 两个 plane 的分工

| plane | 角色 | 例子 |
| --- | --- | --- |
| **control plane** | IM server：HTTP route、DB、ACL、消息分发、scheduler | `packages/backend` |
| **execution plane** | AgentHost：spawn agent CLI、stdin/stdout、文件系统访问、API key、本地 PATH | `packages/host`（PR-1 IPC skeleton；PR-2 起承接 spawn / inbox-drain / run-state） |

**核心 invariant**：spawn agent CLI 是 execution plane 的事，**不是** control plane 的事。
当前 `ConversationManager` 物理上还在 backend，是过渡形态，不是目标形态。

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
3. **host 是真正的安全边界**：进程在哪个 host 上跑、能访问哪些 fs / API key，host 是 truth source。`host_id` membership precondition（`agent.host_id == workspace.host_id`）已经把 host 建模成一等公民，PR-2+ 会把它从 ACL 字段提升为 runtime 协议端点。
4. **CLI 不是秘密边界，backend token + ACL 才是**。任何"防止 agent 看见 X"的需求，应该走 backend authz，**不要**走"agent 看不见这个命令"的路径——agent 是有自主性的 actor，藏命令并不等同于授权拒绝。
5. **创建 host-placed 资源时,origin surface 必须显式带 host。** `POST /api/agents` 的 `host_id`、`POST /api/workspaces` 的 `workspace_host_id` 以及未来任何 optional `*_host_id` 都不能让 desktop UI 依赖 backend 的 0/1/N fallback。即使 picker 因为当前只有一个 host 而隐藏,desktop 也要发送当前 bound host id；backend fallback 只保留给无 origin-host 上下文的 API/remote caller,并在多 host 时 fail closed (`local_host_ambiguous`)。

### 9.4 当前实现 vs 目标实现

| 关注点 | 当前实现 | 目标实现（PR-2+） |
| --- | --- | --- |
| spawn agent CLI | `backend/conversation-manager.ts`（同进程） | `packages/host` daemon（独立子进程） |
| inbox drain | backend | daemon |
| run state record | backend | daemon → backend 通过 event 上报 |
| backend → daemon 通信 | n/a | `HostClient` over Unix socket（PR-1 已经接好 ping/status/echo） |
| `hostClient` 必需性 | optional（PR-1） | required（PR-2） |

`packages/backend/src/conversation-manager.ts` 是技术债 anchor。新功能不要再往 CM 里堆 IM 语义，旧的 IM 语义遇到机会就往 backend 收。PR-2 真搬迁之前**不要做并行重写**——保持单一实现是真相源。

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
  - **C2 活迁移 seam / 活展示契约** → ②触发**可满足，但前置是「设计刀」而非某个 count 归零**。典型：`workspace_path`（一列背 create 输入 / daemon binding cache / 用户可见展示 path 三契约，且正被启动·恢复·Open-in-Finder 活读）——退役前提是先做设计动作把三契约拆开分别安置，不是等 count=0。②写明该**设计前置** + owner；前置达成前按 C 保留，绝不当死码删。

**失败模式（不钉这条会怎样）：** shim 加进来时没记录守什么、何时能删 → 半年后审计者面对一堆 compat 分支，分不清哪个是死化石、哪个还守着活契约，只能逐个 DB probe + 全链路 grep 重新考古（正是 #1301/#1303/#1311/#1312 花掉的力气）。退出条件把这份成本从「每次审计 O(n) 考古」降到「加入时 O(1) 写清楚」。

## 12. 历史

- 2026-05-04 ~ 05-05：mcp system 频道下 thread `bbUBIrwJO5ZNY1ww`（"统一 human/agent 共用业务到 application service 层"）通过 PR-1 ~ PR-6 完成首轮落地
- 2026-05-07：`permissions.md` 锁版 Slice A'/B/C/D 计划，task #125 是 Slice A' 实施
- 2026-05-09：本 doc 创建，把"同构"提升为后端设计期强制规则
- 2026-07-01：IM-终态三方架构 review 后加 §10（transport/cursor 不变量 + 单一 fanout 源非目标 + seq id-space 命名规则 + capability 桶判据）
- 2026-07-04：#1301 legacy 审计（#1303/#1304/#1305/#1310/#1311/#1312）收官后加 §11——把审计时事后用的 A/B/C 退役判据前置成合入 gate（compat/legacy/fallback shim 必带「退出条件三件套」）

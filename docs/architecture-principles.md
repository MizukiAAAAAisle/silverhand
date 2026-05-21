# Silverhand — Architecture Principles

> **Status**: 2026-05-09 整理。来自 PR-1 ~ PR-6 落地的"Human/Agent 同构"主线。
>
> 本 doc 是 silverhand 后端**新功能 / 新 service / 新 DB 表 / 新 migration 必须遵守的约束清单**，与 `core-design.md`（产品/数据模型权威）和 `permissions.md`（鉴权模型权威）平级。代码与本 doc 冲突时，以本 doc 为准。
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

## 10. 历史

- 2026-05-04 ~ 05-05：mcp system 频道下 thread `bbUBIrwJO5ZNY1ww`（"统一 human/agent 共用业务到 application service 层"）通过 PR-1 ~ PR-6 完成首轮落地
- 2026-05-07：`permissions.md` 锁版 Slice A'/B/C/D 计划，task #125 是 Slice A' 实施
- 2026-05-09：本 doc 创建，把"同构"提升为后端设计期强制规则

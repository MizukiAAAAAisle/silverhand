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

---

## 9. 历史

- 2026-05-04 ~ 05-05：mcp system 频道下 thread `bbUBIrwJO5ZNY1ww`（"统一 human/agent 共用业务到 application service 层"）通过 PR-1 ~ PR-6 完成首轮落地
- 2026-05-07：`permissions.md` 锁版 Slice A'/B/C/D 计划，task #125 是 Slice A' 实施
- 2026-05-09：本 doc 创建，把"同构"提升为后端设计期强制规则

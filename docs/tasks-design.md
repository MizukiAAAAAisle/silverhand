# Silverhand — Tasks 设计

> **Status**: Spec（2026-05-03 起草）。未实现；落地前如果与现实偏离，回这里改，不要让代码和文档分叉。
>
> 与 [`core-design.md`](./core-design.md) §6.2 对齐——该表原本把"Task board"标成 v2 不做；本 doc 是把它从 v2 提前到 v1.5 的提案。提案通过后 §6.2 相应行改标 "收编到 `tasks-design.md`"。
>
> 与 [`app-layout.md`](./app-layout.md) 的 UI 契约对齐——本 doc 定义"tasks 该有哪些视图 / 每个视图的行为"，具体排版 token 见 `design-new-theme.md`。

---

## 1. 为什么做

核心诉求：**多 agent 并行时防止重复劳动**。

silverhand 现在只有"消息"一个原语。当用户同时对 channel 里三个 agent 说"帮我修这个 bug"，三个 agent 会各自接手、各自写码、最后三份冲突的 diff。slock 用 task 系统把这个问题压住：任何工作开始前必须 claim，claim 用数据库原子写决定胜负，败者放弃。

silverhand 要继承这个机制，但**归属模型跟 slock 反过来**——slock 是 task 属于 channel（channel 级 task 板），silverhand 是 task 属于 session（channel 是聚合视图）。

---

## 2. 与 slock 的核心差异

| 维度 | slock | silverhand |
|------|-------|-----------|
| **task 归属** | channel 级（一个 channel 一张 task 板）| **session 级**（task 随 session message 走）|
| **task_number 编号空间** | channel 级唯一 | **channel 级唯一**（跨所有 session 连续，不按 session 重置） |
| **可见性** | channel 内 agent 看到 channel 全部 task | **channel 内 agent 看到 channel 全部 task**（跨 session 聚合） |
| **操作权** | channel 内 agent 都能 claim/update | **只有 task 所属 session 的 agent 能 claim/update**（跨 session 只读） |
| **创建** | `create_tasks` 在 channel 内建新 task-message | **`create_tasks` 在当前 session 内建新 task-message** |
| **Human UI** | slock 是 CLI-only，无独立 task UI | **NavRail 全局聚合 + channel 聚合 + session 视图，human 可在任一层操作** |

为什么归属在 session：silverhand 里 message 本来就挂在 session 上，task 作为 message 元数据自然跟着。channel 没有直接挂消息，让 channel 持 task 就要另造一条所有权链。

为什么编号空间在 channel：agent 在 session A 里读 task 板（聚合视图），看到的就应该是连续编号。否则聚合结果里到处 `#1 #1 #1` 来自不同 session，心智上崩坏；agent prompt 里引用 `#3` 也不再唯一。

为什么可见性 channel、操作权 session：把"防重复劳动"（靠**看得见**对方在干嘛）和"职责边界清晰"（靠**不能越权**操作别 session 的 task）拆开。跨 session 只读 = agent 看得到但 claim 会失败，system prompt 里讲清楚一次即可。

---

## 3. 数据模型

### 3.1 不新增表，扩 `messages`

Task 是 message 的元数据，不是独立实体。参考 slock `chat-bridge.js` line 3228 的 task suffix 渲染逻辑——task 行就是一条普通 message 多挂几列。

`messages` 表加以下列（migration 007_tasks 新增）：

| 列 | 类型 | 含义 |
|---|---|---|
| `task_number` | `INTEGER NULL` | 该 channel 内的 task 序号（从 1 起，单调递增；NULL = 该 message 不是 task） |
| `task_status` | `TEXT NULL` | `'todo'` \| `'in_progress'` \| `'in_review'` \| `'done'`；NULL = 非 task |
| `task_assignee_agent_id` | `TEXT NULL REFERENCES agents(id) ON DELETE SET NULL` | 当前 assignee（NULL = 未认领或已释放）|
| `task_assignee_user_id` | `TEXT NULL` | v2 多用户预留；v1 永远 NULL |
| `task_title` | `TEXT NULL` | 可选，task 的简短标题（用于 list 视图）；NULL 时用 `content` 首行兜底 |

**唯一性约束**：

```sql
CREATE UNIQUE INDEX uniq_task_number
  ON messages (
    -- 通过 session.channel_id 去重；SQLite 不支持 JOIN-based 索引，
    -- 所以落库时由 backend 通过 sessions 表查出 channel_id 再写
    -- 一列冗余 task_channel_id，保持索引纯物理列
    task_channel_id, task_number
  ) WHERE task_number IS NOT NULL;
```

实际落库形态：多一列 `task_channel_id TEXT NULL REFERENCES channels(id) ON DELETE CASCADE`。不是 task 时为 NULL，是 task 时等于 `sessions.channel_id`。这是**纯冗余列**，只为索引可行。插入 task 行时由 backend 在同一 transaction 里读 session 拿 channel_id 写进去，外部不可直接改。

> **为什么不另起 tasks 表而是冗余列**：task ≡ 一条 message 的一面，不是平行实体。另起表会产生"message 被 promote 为 task 时要不要复制？"的伪问题。冗余一列 `task_channel_id` 换来 index 可行，值得。

### 3.2 状态机

照搬 slock（`chunk-37O7EHYE.js` line 1397 的 "Valid transitions" 注释）：

```
 todo ──claim──▶ in_progress ──finish──▶ in_review ──approve──▶ done
                     │                         │
                     └── update to done ───────┘  (仅"trivial"或显式批准)
                     ▲
                     └── update back from in_review
```

- **claim 自动把 `todo` 推到 `in_progress`**（slock 1282 line 注释行为，照抄）
- **in_review** 的归属就是"交给 human 校验"——agent **不自行** 推到 `done`。human 在 task 视图点 approve 才是 `in_review → done`。
- **done 是终态**。unclaim 在 `done` 状态下被拒绝（改都改不了，再释放就没意义）。
- **non-assignee 禁止** update_status / unclaim（assignee-only）。human 例外——human UI 操作不受此限（见 §6.3）。

### 3.3 哪些 message 可以变成 task

- **只允许 session 顶层 message**。child session 本身是隔离的 conversation，但 child session 里的 message 也能成为 task——因为每个 session 都有自己的 task 流，child session 跟 parent session 在 task 系统里平等。
- **thread 内的 message 不能变 task**（v1 无"消息内嵌 thread"；child session 已经替代了 slock thread）。
- **system message 不能变 task**。onboarding / join / leave / rename / task 广播本身 = 事件通知，不是工作项。
- **agent 自己刚发的消息可以变 task**，但常见场景是 human 发一条活儿、agent claim。

### 3.4 系统消息广播

所有 task 变更都会往该 task 所属 session 插入一条 `from_kind='system'` 的消息，走现有的广播路径（同 §3.6 child session 的 `thread_anchor`、§2.6 的 system subtype）。subtype 新增：

| metadata.subtype | 文案示例 |
|---|---|
| `task_create` | `@alice created task #7 "fix login retry"` |
| `task_claim` | `@alice claimed task #7` |
| `task_unclaim` | `task #7 unclaimed (was @alice)` |
| `task_status` | `task #7 → in_review (by @alice)` |

跨 session 的 task 变更**不往别的 session 广播**。channel 里的其它 session 要感知变化，靠 `list_tasks` 返回实时查。`list_tasks` 无缓存，每次查库——多 agent 协作 push 模型下，"看错失新 task" 的代价低（下次聚合查询就能看到）。

---

## 4. 可见性与权限

### 4.1 规则

| 主体 | 能看到 | 能操作 |
|------|--------|--------|
| **当前 session 里的 agent** | channel 内所有 session 的 tasks（聚合）| **仅当前 session 归属的 tasks** 可 claim/unclaim/update_status |
| **当前 session 里的 agent** | 同上 | **仅当前 session** 可 `create_tasks`（不能代别的 session 建）|
| **Human（UI）** | 所有 channel 所有 session 的 tasks（全局聚合 + channel 聚合 + session 视图）| 任何 task 都可操作（status 变更、强制 unclaim 等）|

### 4.2 跨 session 只读的 agent 行为约定

Agent 在 session A 里调 `list_tasks`，返回条目里有 session B 的 `#5`。如果 agent 尝试 `claim_tasks({ task_numbers: [5] })` 而 `#5` 归属 session B，backend 返回结构化错误：

```json
{
  "success": false,
  "task_number": 5,
  "reason": "task belongs to session <sessionId>; you are in session <otherSessionId>",
  "owner_session": { "id": "...", "title": "..." }
}
```

Agent 看到 `reason` 应放弃并继续，不要反复试。这点写进平台 prompt（§7）。

### 4.3 为什么 human 不受 assignee-only 限制

因为 human 是"上帝视角"——human 点 `in_review → done` 是本设计的核心审批入口；human 强制 unclaim 一个卡死的 task 也是合理的运维操作。Agent 的 assignee-only 限制是防 agent 之间互相踩，不是防 human。

---

## 5. MCP 工具（agent 侧）

照抄 slock 的 5 个工具（`chat-bridge.js` line 1169-1430），schema 稍作调整以匹配 silverhand 的 session 归属语义。这 5 个工具暴露在 chat-bridge，HTTP 打到 backend 的 `/internal/agent/:agentId/tasks*`（见 §6）。

### 5.1 `list_tasks`

```ts
list_tasks({
  channel?: string,    // 不填 = 当前 session 所在 channel
  status?: 'all' | 'todo' | 'in_progress' | 'in_review' | 'done',
                       // 默认 'all'
})
→ {
  channel: string,
  tasks: Array<{
    task_number: number,
    status: TaskStatus,
    title: string,
    assignee?: { type: 'agent' | 'user', id: string, name: string },
    creator?: { type: 'agent' | 'user', id: string, name: string },
    message_id: string,
    session: { id: string, title: string },  // 关键：标注归属 session
  }>
}
```

**与 slock 差异**：每条 task 带 `session` 字段，agent 看到归属 session 标注就知道能不能 claim。

### 5.2 `create_tasks`

```ts
create_tasks({
  tasks: Array<{ title: string, body?: string }>,
  // 不接受 channel / session 参数——永远创建在当前 session
})
→ {
  tasks: Array<{ task_number: number, message_id: string, title: string }>
}
```

**与 slock 差异**：slock 的 `create_tasks` 可以传 `channel`，silverhand 去掉——因为归属语义是 session，当前 session 是唯一合法创建位置。跨 session 创建需要显式的"split task across sessions"语义，v1 不支持。

创建流程：
1. 在当前 session 插一行 message（from_kind=agent, from_agent_id=self, content=body||title）
2. 同一 transaction 分配 `task_number` = `MAX(task_number) + 1 FROM messages WHERE task_channel_id = ?`，写回 task_* 列
3. 插一条 subtype=`task_create` 系统消息
4. 返回 `task_number` 供 agent 后续 claim

### 5.3 `claim_tasks`

```ts
claim_tasks({
  task_numbers?: number[],        // 已是 task 的直接 claim
  message_ids?: string[],         // 普通 message → promote 到 task 并 claim
})
→ {
  results: Array<{
    success: boolean,
    task_number?: number,
    message_id?: string,
    reason?: string,              // 失败原因（已被别人 claim / 不属于本 session / 已 done 等）
  }>
}
```

**原子冲突解决**（照抄 slock）：

```sql
UPDATE messages
SET task_assignee_agent_id = :agent_id,
    task_status = CASE WHEN task_status = 'todo' THEN 'in_progress' ELSE task_status END
WHERE task_channel_id = :channel_id
  AND task_number = :task_number
  AND task_assignee_agent_id IS NULL
  AND task_status != 'done';
```

`changes()` === 1 → success；=== 0 → 查出当前状态、返回失败原因。后到 agent 直接放弃，不重试。

**Promote 路径**（message_ids 模式）：transaction 里先 `SELECT` 对目标 message 做校验（属于当前 session + 非 system + 非 thread + 未 task 化），再 UPDATE 填 task_* 列 + 分配 task_number + 写 task_assignee_agent_id。失败返回原因。

### 5.4 `unclaim_task`

```ts
unclaim_task({
  task_number: number,
})
→ { success: boolean, reason?: string }
```

只能在 task 属于当前 session 且当前 agent = assignee 时成功。成功后 `task_status` 回退到 `todo`。广播 `task_unclaim`。

### 5.5 `update_task_status`

```ts
update_task_status({
  task_number: number,
  status: 'in_progress' | 'in_review' | 'done',
})
→ { success: boolean, reason?: string }
```

Assignee-only。合法转换：

| from \ to | in_progress | in_review | done |
|---|---|---|---|
| `todo` | ✘（claim 自动走）| ✘ | ✘ |
| `in_progress` | — | ✔ | ✔（仅 trivial）|
| `in_review` | ✔（退回）| — | ✔ |
| `done` | ✘ | ✘ | — |

**平台 prompt 明示**："only set `done` for trivial tasks or after explicit approval. Otherwise stop at `in_review` and wait for human."

---

## 6. Backend API

### 6.1 Agent-facing（chat-bridge 背后调用）

所有 endpoint 以 `session_id + agent_id` 认证（chat-bridge 启动时已知）。

| Method | Path | 作用 |
|---|---|---|
| `GET` | `/internal/agent/:agentId/tasks?channel_id=&status=&session_id=` | list_tasks 支撑 |
| `POST` | `/internal/agent/:agentId/tasks` | create_tasks |
| `POST` | `/internal/agent/:agentId/tasks/claim` | claim_tasks（body: task_numbers / message_ids）|
| `POST` | `/internal/agent/:agentId/tasks/unclaim` | unclaim_task |
| `POST` | `/internal/agent/:agentId/tasks/update-status` | update_task_status |

所有写 endpoint 内部：（1）校验 agent ∈ session 当前成员；（2）DB 原子写；（3）插 system message；（4）走现有消息广播给 session 内其它 agent。失败返回结构化 reason。

### 6.2 Human UI-facing（renderer 调用）

| Method | Path | 作用 |
|---|---|---|
| `GET` | `/api/tasks?channel_id=&session_id=&status=&assignee=&cursor=` | 列表查询，支持不传任何过滤 = 全局聚合 |
| `POST` | `/api/tasks/:messageId/claim` | human 代 claim（可选：为自己 / 为某 agent）|
| `POST` | `/api/tasks/:messageId/unclaim` | human 强制 unclaim |
| `POST` | `/api/tasks/:messageId/status` | human 改 status（含 `in_review → done` 审批）|

Human 操作也写 system message（subtype 复用 `task_claim` / `task_unclaim` / `task_status`，但 metadata 里 `actor.type = 'user'`），agent 能看到"human 把 #7 推到 done 了"。

### 6.3 SSE 事件

现有 `/api/stream` 增加 event kind：

| kind | payload |
|---|---|
| `task_changed` | `{ channel_id, session_id, task_number, status, assignee, ... }` |

renderer 订阅后刷新所有 task 视图（NavRail 全局列表、channel tab、session 视图）。

---

## 7. Human 入口（UI）

实施后落地为两个层级（v1 取消 §7.3 的 session 级抽屉、§7.2 的 SessionsSidebar 标签页切换；详见 §7.5 实施备注）：

### 7.1 NavRail 新增 `tasks` section

在 NavRail（`chat` / `members` / `computers` 之外）新增第 4 个 top-level section：`tasks`。图标采用 lucide `CheckSquare`。

- 选中 `tasks` 时：
  - **不再有左侧 Sidebar 列**（取消原 "全局 Tasks Sidebar" 设计）；channel 过滤改为面板 header 下方的 chip strip
  - 主视图 = **四列 Kanban**：Todo / In progress / In review / Done
  - Channel chip strip：`All` + 按 active 数量倒序的 regular channels（前 10）+ 分隔条 + DM channels；每个 chip 后挂 active 数量 badge，无 active 任务的 chip 半透
  - 任一 chip 改变只影响主视图，不切换 NavRail 选中态
  - 点 task card → 跳回 `chat` section，自动 select 到该 task 所属 channel × session，并把消息流滚到对应 message（同 Saved 跳转行为）

### 7.2 Channel 级聚合（titlebar 入口）

在 Titlebar 当前频道动作区新增 `CheckSquare` 按钮（仅在 `chat` section + 已选 channel 时显示），右上角带 active 任务数量 badge。点击打开 **`ChannelTasksDialog`**（中央模态）：

- 布局与 §7.1 完全一致（四列 Kanban + chip strip），同一组组件，仅过滤器换成 session
- Session chip strip：`All` + 按 `created_at` 倒序的最多 5 个 session，加上当前选中的 session（即使被截断也强制可见）
- 默认 session filter = 当前打开的 session；每次重开 dialog 重新同步到当前 session
- 点 task card → 关闭 dialog + 跳到对应 message

### 7.3 ~~Session 级（主视图内）~~ — v1 不做

原计划在 SessionView 右侧加 `Tasks (n)` 抽屉，实施一轮后废弃：和 §7.2 入口职责重叠（人都已经在这个 channel 里了），且抽屉占用横向空间挤压消息流。Session 级筛选改在 §7.2 dialog 的 chip strip 中完成（默认就是当前 session）。

### 7.4 一致性：两个层级共用同一批组件

`KanbanColumn` / `TaskCard` / `Chip` 在 NavRail Tasks 与 ChannelTasksDialog 中共享样式与交互；状态修改都走 `useUpdateTaskStatus`（POST /api/tasks/:id/status），SSE `task_changed` 事件触发 React Query 失效。

### 7.5 与原始设计的差异说明（实施备注）

- 取消 §7.3 session 抽屉：上述空间挤压问题
- 取消 §7.2 在 SessionsSidebar 顶部加 Sessions/Tasks tab：channel 级 tasks 入口改放 titlebar，更靠近"频道动作"语义；侧栏保持单一职责（session tree）
- 全局 §7.1 的 "Tasks Sidebar" 也取消，统一收纳进面板内 chip strip——四列 Kanban 在大屏更直观，跨 channel 过滤的成本更低

### 7.4 一致性：三个层级共用同一批组件

- `TaskRow` 组件（单行渲染）
- `TaskStatusPill`（状态标签 + 可点击变换）
- `TaskListQuery`（React Query hook，不同 filter 参数复用）

避免三处各画一版。

---

## 8. Agent 平台 prompt 补丁

在 `core-design.md` §4.7 的平台 prompt 模板末尾增加一段（插在 `## Initial role` 前）：

```markdown
## Tasks (coordination primitive)

The channel has a task board that aggregates tasks across all sessions.
You see tasks from other sessions in this channel but can only act on
tasks in your current session.

- `list_tasks` — view the channel's task board (includes other sessions)
- `create_tasks` — create new task-messages in THIS session only
- `claim_tasks` — claim by task number (own session only) or promote a
  regular message to a task and claim it (own session only)
- `unclaim_task` — release your claim
- `update_task_status` — change status (todo/in_progress/in_review/done)

Rules:
1. **Claim before working.** If the claim fails (already taken, wrong
   session, already done), MOVE ON — do not retry, do not try to work on
   it anyway.
2. **Only operate on YOUR session's tasks.** You'll see other sessions'
   tasks in list_tasks output (marked with `session: <name>`), but
   claim/unclaim/update will fail if the task doesn't belong here. This
   is intentional — those are for that session's agents to handle.
3. **Stop at `in_review` for non-trivial work.** The human validates and
   moves it to `done`. Setting `done` yourself is only appropriate for
   trivial tasks or after explicit approval.
4. **Prefer claiming existing messages over create_tasks.** If the work
   already exists as a message, use `claim_tasks` with `message_ids` to
   promote-and-claim. `create_tasks` is for genuinely new subtasks.
5. **Don't create duplicate tasks.** Before calling create_tasks, check
   the current task board via list_tasks.
```

这段替换了原 §4.7 平台 prompt 里没有的内容——§4.7 现状没提 task 系统（因为 core-design §6.2 标成 v2）。实施时顺手补。

---

## 9. 边角 case

| 场景 | 处理 |
|---|---|
| Task 所在 session 被 close | task 保留，task_status 不变；human 仍可在 channel 聚合视图 / 全局视图看到；agent 端 `list_tasks` 依然列出，但在 closed session 里无 agent 可 claim → 事实上冻结。需要 human 介入才能 unclaim 或 done。 |
| Task 所在 session 被删除 | ON DELETE CASCADE → task 行一起删（含 message）。广播 `task_removed` 系统消息给 channel 其它 session（可选，v1 可略）。 |
| Agent 离开 channel（`leaveChannel`）| 该 agent 当前 assignee 的 tasks 自动 unclaim 回 `todo`。插 `task_unclaim` 系统消息，reason=`agent left channel`。 |
| Agent 被从 session 移除（mid-session）| v1 不支持 mid-session 改成员（见 core-design §2.5）——不会发生。 |
| 删除一条普通 message 时它已是 task | 走 `DELETE messages` 现状即可（ON CASCADE 一并清）。UI 确认框要提示 "This is task #7"。 |
| Task 的创建消息被 edit（v1 不支持 edit）| N/A。v1 message 只读。 |
| 两个 agent 同时 claim 同一 task | DB 原子 UPDATE 决出胜者，败者返回 reason=`already claimed by <agent>`。见 §5.3。 |
| Claim 用 message_id 去 promote 一个 thread 内 message | Backend 拒绝，reason=`thread messages cannot become tasks`。v1 子 session 替代 thread，本 case 实际是 "指向 child session 里的 message" → 同理拒绝（只能在 child session 自己的 session scope 里 claim） |
| Agent 跨 channel claim | `list_tasks` 只返回当前 channel；跨 channel 不可见也不可达。 |

---

## 10. v1 实现切片

拆成 4 个 PR，每个独立可合：

### PR-T1：DB + 后端基础

- migration 007_tasks：`messages` 加 5 列 + `task_channel_id` 冗余 + partial unique index
- `packages/shared/src/api/dto.ts`：TaskStatus 枚举、TaskSummary DTO、TaskChangedEvent
- `packages/backend/src/tasks.ts`：5 个 agent endpoint + 3 个 human endpoint
- 系统消息 subtype 扩展（`task_create` / `task_claim` / `task_unclaim` / `task_status`）
- 广播路径复用现有 `broadcastMessage` + SSE
- **不含 UI；测试用 curl 即可**

### PR-T2：chat-bridge MCP 工具

- `packages/chat-bridge/src/tools/tasks.ts`：5 个 MCP 工具
- 平台 prompt 补 §8 段（`packages/backend/src/drivers/platform-prompt.ts`）
- 集成测试：模拟一个 session 里的 agent claim / update_status，验证广播到 inbox

### PR-T3：Session 级 UI（抽屉）

- `apps/desktop/src/renderer/components/tasks/TaskRow.tsx`、`TaskStatusPill.tsx`、`TaskListQuery.ts`
- SessionView 右侧抽屉组件
- 点条目 scroll-to-message
- Human 点 status pill → 调 /api/tasks/:id/status

### PR-T4：Channel + NavRail 聚合

- NavRail 新增 `tasks` section（icon + 路由）
- Tasks List View（全局表格）
- SessionsSidebar 的 `Tasks` 标签页切换
- 跳转逻辑（从全局 task 点条目 → 回 chat section + 选中 channel/session + scroll-to-message）

---

## 11. 非目标（v1 明确不做）

- ❌ Task 依赖关系（`blocked_by`）——slock 没有，先不做
- ❌ Task 截止时间 / 提醒——等 core-design §6.2 的 `Reminders` 一起做
- ❌ Task label / priority / category——过度设计
- ❌ 跨 channel task 可见性
- ❌ Batch 操作（选中多条 human 一起改 status）——后续优化
- ❌ Task 移动（从 session A 到 session B）——破坏归属语义
- ❌ Task 编辑 title / body——v1 message append-only，task 亦然

---

## 12. 待决策

1. **NavRail 图标**：候选 ☑ / 📋 / ▢。倾向简单 checkbox glyph（单色 icon，跟现有 chat/members 风格一致）。
2. **Channel 聚合的标签页切换**（§7.2）——是在 SessionsSidebar 顶部加 toggle，还是切整屏 Tasks List？倾向前者（减少状态抖动），待实际做起来再看视觉。
3. **Human "代 claim 给某 agent"**（§6.2 `/api/tasks/:id/claim`）——v1 是否支持把 task 指派给**非当前 session 里的** agent？倾向不支持（assignee 必须是 task 所属 session 的成员），否则就变成了一个"跨 session 指派"后门。
4. **Done task 的清理策略**——长期累积会不会让聚合视图太吵？倾向"全局视图默认只看 Active，切 filter 才看 Completed"。session 级抽屉同理。
5. **Task 数量 badge**——抽屉 badge / sidebar entry badge 显示的是 `Active` 还是 `Unassigned`？倾向 `Unassigned`——它才是"需要有人来认领"的信号。

---

文档版本：2026-05-03 v1
下次更新：开始 PR-T1 前如有偏离，回这里改。

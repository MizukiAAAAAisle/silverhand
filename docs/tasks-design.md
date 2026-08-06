# Silverhand — Tasks 设计

Task 的领域契约:状态机、编号空间、claim mutex、可见性/权限模型。**本 doc 是语义 owner,代码是
enforcement**——运行时行为以 `services/task/` + tasks 路由 + renderer `features/tasks/` +
`docs/cli-system.md` 为准,冲突时以现行代码为事实、由本 doc 收敛。领域模型与三层会话结构见
[`core-design.md`](./core-design.md);tasks 的 UI 契约(视图行为)见本 doc §5。

---

## 1. 为什么做

核心诉求:**多 agent 并行时防止重复劳动**。当用户同时对 channel 里三个 agent 说"帮我修这个
bug",三个 agent 会各自接手、各自写码、最后三份冲突的 diff。task 系统把这个问题压住:任何工作
开始前必须 claim,claim 用数据库原子写决定胜负,败者放弃。

---

## 2. 归属与编号模型(核心设计判断)

| 维度 | 取向 | 为什么 |
|------|------|--------|
| **task 归属** | **session/conversation 级**(task 随 message 走) | message 本来就挂在 conversation 上,task 作为 message 元数据自然跟着;channel 不直接挂消息,让 channel 持 task 就要另造一条所有权链。 |
| **task_number 编号空间** | **channel 级唯一**(跨所有 session 连续,不按 session 重置) | agent 在聚合视图里读 task 板,看到的应是连续编号;否则到处 `#1 #1 #1` 来自不同 session,心智崩坏,prompt 里引用 `#3` 也不再唯一。 |
| **可见性** | channel 内 agent 看到 channel 全部 task(跨 session 聚合) | "防重复劳动"靠**看得见**对方在干嘛。 |
| **操作权** | **只有 task 所属 session 的 agent 能 claim/update**(跨 session 只读) | "职责边界清晰"靠**不能越权**操作别 session 的 task。可见性与操作权拆开:跨 session = 看得到但 claim 会失败。 |

---

## 3. 数据模型与状态机

### 3.1 不新增表,task ≡ message 的一面
Task 是 message 的**元数据**,不是独立实体:一条 message 带上 task 字段即成 task,否则就是普通消息。
**为什么不另起 tasks 表**——另起表会产生"message 被 promote 为 task 时要不要复制?"的伪问题;让
task 就是 message 的一个投影,promote 只是补齐元数据。channel 级 `task_number` 的唯一编号空间(见
§2)由 backend 在写入时保证,归属列外部不可直接改。

### 3.2 状态机(5 态 —— 本 doc 是语义 SSOT,`services/task/contracts.ts` 是 enforcement)

五个状态:`todo` · `in_progress` · `in_review` · `done` · `closed`。

**status transition graph** —— `task status` 动词能走的边,逐格镜像
`VALID_TRANSITIONS`(`services/task/contracts.ts`):

| from \ to | todo | in_progress | in_review | done | closed |
|---|---|---|---|---|---|
| **todo** | — | — | — | — | ✔ |
| **in_progress** | — | — | ✔ | ✔ | ✔ |
| **in_review** | — | ✔(退回迭代) | — | ✔ | ✔ |
| **done** | — | — | — | — | ✔ |
| **closed** | ✔ | ✔ | ✔ | ✔ | — |

**claim 不在这张表里。** `todo → in_progress` 只由 **agent 的 claim 命令**与 **human 的指派**产生——它们
是独立动词(claim = 原子占位 + 自赋 assignee;指派 = 原子派发),`task status` **不能**走这条边(故
`VALID_TRANSITIONS.todo === ['closed']`)。把这些状态副作用和 status transition graph 混进同一张
enforcement 表会让"合法转换"失真:这张表只描述 `task status`,claim / unclaim / 指派是另一组动词
(§4.4)。

语义:
- **`in_review` = 交给 human 校验**——agent **不自行**推到 `done`;human 在 task 视图 approve
  才是 `in_review → done`。非 trivial 工作停在 `in_review` 等 human。
- **`in_review → in_progress`**:收到 review 反馈后拉回迭代(非终态往回走的唯一合法边)。
- **`done` 不是终态**:`done → closed` 归档合法;但 done 不能直接回 in_progress/in_review
  (要复活先 `closed` 再 re-open)。
- **`closed` 可 re-open 到任意活跃态**(`closed → {todo, in_progress, in_review, done}`)——
  归档后需要重开时的回路。

**操作权(精确矩阵——`update_status` 与 `unclaim` 是两条不同规则)。** 两者默认都 **assignee-only**,
但 creator-self-stale 例外**只作用于 `update_status`,不作用于 `unclaim`**:

| 主体 | `update_status`(`updateStatusAgent`)| `unclaim`(`unclaimAgent`)|
|------|------|------|
| **当前 assignee**(`task_assignee_agent_id === self`)| ✔ | ✔ |
| **creator-self-stale**:自己创建、且**当前无主**(**两个 assignee 列都为 null**,见 §4.5;且 `from_kind='agent'` 且 creator 是 self)| ✔ —— 推进/收拾自己遗留的无主 task | ✘ `not_assignee`(unclaim 严格要求 assignee=self,无主 task 无从 unclaim)|
| 其它 non-assignee agent | ✘ `not_assignee` | ✘ `not_assignee` |
| **Human** | ✔(不受 assignee-only 约束,§4.3)| ✔ |

creator-self-stale 让 agent 能推进/关掉自己创建但没人接的 stale task,不必等 human;它是精确规则、
**只开在 `update_status` 上**(unassigned 的 task 本就没有 assignee 可 unclaim),不能只活在代码,也
不能比 enforcement 更宽。

### 3.3 哪些 message 可以变成 task
- **conversation 顶层 message 与 reply-cluster(thread)内的 message 都可成 task**。task 可归属主
  线,也可用 `--target thread:<root>` 归属到某个 reply-cluster(见 `cli-system.md`);编号仍走
  channel 级空间。
- **`thread_anchor` 系统消息不能变 task**(它只是 cluster 的锚,不是工作项)。
- **`from_kind='system'` 消息不能变 task**(事件通知,不是工作项)。
- agent 自己发的消息可以变 task,但常见场景是 human 发活儿、agent claim。

### 3.4 系统消息广播
Task 变更往该 task **所属 conversation** 插一条 `from_kind='system'` 消息走现有广播路径,让在场
成员即时看到。**跨 session 的 task 变更不往别的 session 广播**——channel 里其它 session 靠聚合
查询发现新 task:多 agent push 模型下"看错失新 task"代价低,下次聚合即可见,不值得为它建跨 session
推送。archive 是低噪音可见性操作,只发变更事件、**不**插入 chat system message。

---

## 4. 可见性与权限

### 4.1 规则

| 主体 | 能看到 | 能操作 |
|------|--------|--------|
| **当前 session 里的 agent** | channel 内所有 session 的 tasks(聚合)| **仅当前 session 归属的 tasks** 可 claim/unclaim/update_status(assignee-only,creator-self-stale 例外见 §3.2);**仅当前 session** 可创建 |
| **Human(UI)** | 所有 channel 所有 session 的 tasks(全局 + channel + session 聚合)| 任何 task 都可操作(status 变更、强制 unclaim 等)|

### 4.2 跨 session 只读的 agent 行为约定
Agent 在 session A 里 `list_tasks` 看到 session B 的 `#5`,若尝试 claim,backend 返回结构化失败
(reason = task 归属别的 session)。**agent 看到 reason 应放弃并继续,不要反复试。** 这点写进平台 prompt。

### 4.3 为什么 human 不受 assignee-only 限制
human 是"上帝视角"——`in_review → done` 是本设计的核心**审批入口**;强制 unclaim 一个卡死的
task 是合理运维。Agent 的 assignee-only 限制是防 agent 之间互相踩,不是防 human。这是
Human/Agent 同构模型下"同一操作、不同权限面"的一个实例,不是给 human 开的特例分支。

### 4.4 human 的指派是派发,清空与改状态仍各自独立(human 入口的精确合同)

human 把 `todo` 指派给某个 agent **就是在派发工作**,因此这一笔在同一事务里写 assignee **并**把 `todo`
顶成 `in_progress`;改派一个已经 `in_progress` / `in_review` 的 task 只换人,状态不动。human 的"清空
assignee"仍是**纯归属写**(不碰 `status` / `closed_at`),human 改 status 也只动 status、不要求有
assignee。三个动作各只有一条写路径:

| 动作 | 端点 | 写什么 | 拒绝条件 |
|---|---|---|---|
| 指派 / 改派 | `POST /api/tasks/:taskId/claim` `{agent_id}`(**必填**)| assignee(+ `todo → in_progress`)| `done` / `closed`(`task_done` / `task_closed`);assignee 非该 task conversation 成员 |
| 清空 assignee | `POST /api/tasks/:taskId/unclaim` | assignee 置空 | `done` / `closed`(同上) |
| 改状态 | `POST /api/tasks/:taskId/status` `{status}` | status(+ `closed_at`)| 与当前同态(`already_at_status`)|

五条判据:

- **`todo + assignee` 是无出口状态,所以不许产生。** `task status` 不走 `todo → in_progress`
  (§3.2,`VALID_TRANSITIONS.todo === ['closed']`),agent 的 `assignSelf` 又要求两个 assignee 列都为
  null ⇒ 被人工指派的 agent 既不能改状态也不能 claim。修法是让指派原子地完成派发,**不是**开放通用
  transition,也不是靠 `unclaim + claim` 绕。
- **派发只作用于 `todo`,其余状态一律只换人。** `in_review` 不许因为改派掉回 `in_progress`——那会把它
  从 human 的审批队列里挪走;`done` / `closed` 直接拒绝指派(下一条)。无主的 `in_progress` /
  `in_review` 不是死状态——`assignSelf` 只要求**两个 assignee 列都为 null** 且
  `status NOT IN ('done','closed')`(见 §4.5),别的 agent 照样能接。
- **也不许反向加半条不变量。** 不规定"`in_progress` 必须有 assignee":那要一次裁清 in_review/done/
  closed、any→any、历史脏数据与所有入口,是另一次完整状态机改造,不在 UI 里偷偷加。清空 assignee
  因此**不**回 `todo`。
- **终态的归属是冻结的,而且必须服务端拒绝。** human claim 与 agent unclaim 本来就拒
  `done`/`closed`,human 清空补齐这一格后规则是同一条:改派前先把状态挪出终态。UI 侧的只读
  gate 是体验,不是闸门——渲染与点击之间 task 可能被远端改成 `done`。
- **谁能让工作流"往回走"仍只有 agent 自己。** agent 自接 = 占位 + 开工(`todo` 顶成 `in_progress`;
  无主的 `in_progress` / `in_review` 保持原状态),agent 自释放 = 放弃 + 归还任务池(清 assignee
  **并**回 `todo`,§6 的"agent 离开 channel 自动 unclaim 回 todo"是同一含义)。human 的指派只前进
  一格(`todo → in_progress`),从不后退。
  因此 store 层是四个具名写:`assignSelf`(agent 自接)、`releaseToTodo`(agent 自释放)、
  `dispatchToAgent`(human 派发,带 `todo` 推进)、`clearAssignee`(human 清空,纯归属)。
  同名不同义的写不共用一条 SQL。
- **"先指定负责人、暂不开工"不是本模型的能力。** 若将来需要排期/计划语义,那是独立概念(计划 owner
  与执行 assignee 分开),不能靠复用 assignee 把 `todo + assignee` 请回来。

### 4.5 "无主"永远是两列都为 null(assignee 只有一个,列有两个)

`tasks` 有 `assignee_agent_id` 与 `assignee_user_id` 两列,schema CHECK 保证**最多一列非空**,DTO 只
暴露一个 `assignee`。live 代码只写 agent 列(human 的 `dispatchToAgent` / `clearAssignee` 还会把 user 列
清空),但 `assignee_user_id`
非空的行是**合法持久事实**——从旧模型迁移过来的。因此任何"这个 task 无主吗"的判据必须查**两列**:

- `assignSelf` 的 WHERE 两列都要求 null。否则 agent claim 会往一条 user-assigned 行上再写一个 agent
  assignee,直接撞 CHECK,以裸 SQLite 异常(500)冒出来,而不是 typed 失败。
- claim 落空后的分类(`readAssignment`)也读两列:任一非空 ⇒ `already_claimed`。只看 agent 列会把
  "被 human assignee 占着"报成 `task_done`——一句假话。reason 不必泄露/发明 agent id,generic
  "already assigned" 即可。
- `updateStatusAgent` 的 creator-self-stale 回退同理:它只服务**真正无主**的 task,不能因为 creator
  恰好是自己就越过一个 human assignee。

一句话:**"assignee 只有一个"是领域事实,"列有两个"是存储事实**;凡把后者当前者的地方都是 bug。

---

## 5. Human 入口(UI 契约)

Tasks 是 **NavRail 顶层 section**(与 chat/members/computers 平级)。落地为**两个聚合层级**,
共用同一批组件(五列 Kanban:Todo / In progress / In review / Done / Closed —— Closed 是归档终态列,
默认折叠 + 频道/session chip strip):

- **全局聚合**(NavRail `tasks`):跨所有 channel 的 Kanban;频道 chip strip 过滤;点 task card →
  跳回 chat section、自动 select 到该 task 所属 channel × session、消息流滚到对应 message
  (同 Saved 跳转行为)。chip 改变只影响主视图,不切 NavRail 选中态。
- **channel 级聚合**(titlebar 入口,仅在 chat + 已选 channel 时):打开中央模态,布局与全局一致,
  过滤器换成 session;默认 filter = 当前 session。

一致性:两级共用同一组件与同一 `task_changed` 失效路径,不各画一版。(session 级独立抽屉 v1 不做
——与 channel 入口职责重叠且挤压消息流。)

---

## 6. 边角 case(durable 行为规则)

| 场景 | 处理 |
|---|---|
| Task 所在 session 被 close | task 保留、status 不变;human 仍可在聚合视图看到;closed session 里无 agent 可 claim → 事实上冻结,需 human 介入。 |
| Task 所在 session 被删除 | `ON DELETE CASCADE` → task 行(含 message)一起删。 |
| Agent 离开 channel(`leaveChannel`)| 该 agent 当前 assignee 的 tasks 自动 unclaim 回 `todo`,插 `task_unclaim` 系统消息。 |
| 两个 agent 同时 claim 同一 task | DB 原子 UPDATE 决出胜者,败者返回 already-claimed reason(见 §2 操作权 + §4.2)。 |
| Claim 去 promote 一个 `thread_anchor` / 跨 session 的 message | 拒绝(thread anchor 不可成 task;跨 session 只能在其自身 scope claim)。 |
| Agent 跨 channel claim | `list_tasks` 只返回当前 channel;跨 channel 不可见也不可达。 |

---

## 7. 非目标(v1 明确不做)

- ❌ Task 依赖关系(`blocked_by`)
- ❌ Task 截止时间 / 提醒(等 core-design 的 Reminders 一起做)
- ❌ Task label / priority / category
- ❌ 跨 channel task 可见性
- ❌ Batch 操作(多条一起改 status)
- ❌ Task 移动(session A → B,破坏归属语义)
- ❌ Task 编辑 title / body(v1 message append-only)

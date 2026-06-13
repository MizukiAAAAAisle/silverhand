# P0 — Use-Case 层契约 + 事务边界 Spec

> Status: shipped (#task:961, accepted by shiki). Architect = @Alice. Reviewer = @Cindy.
> 本 spec 定**契约与边界**(不写实现代码),并作为应用层模式的长期参考——
> 后续 use case(P5–P13 等)与纵向轴均沿用此处的 Effect 三分类 + post-commit 队列。
> 本轮 domain-events 决策(三方收敛:不引入 domain-event 系统,只上 use case 的
> post-commit effect 队列)。

---

## 0. Scope / Non-goals

**做(P0 一刀):** 给两个真实的跨上下文业务动作建立 use-case 归属,把事务所有权理到正确的层,
解耦持久层里焊死的跨上下文策略。靶子:

- **AddConversationMember** — 把一个已是 workspace 成员的 agent/human 加进某个 channel/thread。
  (`routes.ts:1175-1323`,经 `:3595` / `:6954` 两处 route 调用。)
- **AddWorkspaceAgentMember** — 把一个 agent 加进 workspace(含 L2 seed + 能力默认集)。
  (`routes.ts:3059-3092`,`POST apiPaths.workspaceMember`。)

**不做(本轮明确排除):**
- 不引入 `BaseUseCase` / 通用 dispatcher / DomainEventBus / outbox 表。
- 不为名词一次性重排目录;DTO/routes 物理拆分是 P1,走同一套 context 缝。
- 不碰 channel-level permission(守住 workspace-only)。
- 不引覆盖率闸门。
- 不新增任何当前不存在的对外事件/副作用——只搬运现有逻辑,语义零破坏。

---

## 1. 三层契约

| 层 | 职责 | **不允许** |
|---|---|---|
| **Route(HTTP adapter,薄)** | 解析 body(zod)、解析 principal/身份、调用 use case、把 use-case 返回的具名错误(含 `forbidden`)映射成 HTTP status | 不写库、不开事务、不发事件、不调 runtime、不做跨聚合编排、**不做 target resolve / 授权判定** |
| **Use Case(应用层,新)** | 拥有一次业务动作的**编排**:target resolve + **授权策略判定** → 前置校验/precondition → pre-commit 外部 precondition → **开事务**(跨上下文 DB 事实)→ 收集 post-commit effect。返回纯数据 + 具名错误(不含 HTTP) | 不依赖 Hono `Context`、不拼 HTTP status、不直接 `events.publish`(只收集 effect) |
| **Repo(持久层)** | 只读写自己那张表/聚合,返回纯数据(含 `created` 这类持久化事实标志)。可在**单表内部**自开事务做批量原子写 | 不调别的 repo、不 seed 别的上下文的默认策略、不发事件、**不懂 host/placement 等业务规则** |

**授权判定归 use case(2026-06-09 采纳 Cindy review 约束①):** 授权是 application boundary,不一定要在 HTTP
adapter。route 只传 principal;use case 内部完成 **target resolve + auth policy**,返回 `forbidden` 具名错误,
route 映射成 403。判定函数仍是纯 policy fn(`canAddConversationMember`/`canGovernWorkspace`),由 use case 调用
——避免"route 读一次 conversation 拿 workspace_id、use case 又读一次"的双读/脏边界。

### 1.1 Adapter-leak 红线(采纳 Cindy review 约束③)

use case **不得** import 任何返回 Hono `Response` / 依赖 `Context` 的 route 内函数。两个现长在
`routes.ts` 的复用点必须先下沉成 HTTP-agnostic 形态,**否则就是把 adapter 漏进 application 层**:

- **`seedMemberAgentL2`** → 下沉到非-route 模块(workspace data-plane helper / application support),
  返回 typed result(`{kind:'ok'|'failed', code, status?}`),不碰 HTTP;route 与 use case 各自映射。
- **`resolveConversationMemberInput`**(现状直接返回 `c.json(...)` Response,`routes.ts:1256-1260`)→ 改成
  **pure resolver**:输入 `repos + dto`,输出 `{ok:true,value}` / `{ok:false,error:namedCode}`;HTTP 映射回 route。

---

## 2. Effect 分类(本 spec 的核心贡献)

一次业务动作里出现的"事情"分三类,**时机不同、失败语义不同**,必须分开:

| 类别 | 例子 | 时机 | 失败语义 |
|---|---|---|---|
| **① in-tx DB 事实** | `workspace_members` insert、`conversation_agents` addAgent、能力 seedDefaults、system message insert | 在**同一个 `db.transaction()`** 内 | 任一失败 → 整体回滚,无半状态 |
| **② pre-commit 外部 precondition** | L2 seed(daemon,`seedMemberAgentL2`)、placement 断言 | 事务**之前**,awaited,成功才进事务 | 失败 → 返回错误、**不写任何行** |
| **③ post-commit effect** | `events.publish('message'/'conversation_members_changed')`、`publishToScope('workspace_channels_changed')`、runtime delivery/stop | 事务**提交之后**,按序执行 | best-effort;失败**不回滚** DB 事实(可 log/重试),只影响"外部世界何时知道" |

### 2.1 排序铁律(load-bearing)

> **外部副作用相对 commit 的顺序,要让"两步之间崩溃"留下的是良性残留,而不是被破坏的不变量。**

- L2 seed 排在 commit **之前**(②):崩在 seed 与 insert 之间 → 多一个**孤儿 L2 目录**(幂等、
  `ensureProvisioned`、下次复用)= 良性。反之若 seed 放 commit 后崩了 → **有 member 行但没 L2** =
  破坏不变量。这正是 Cindy 在 `routes.ts:3059-3063` 钉的 red-line,本 spec 把它升格为通用判据,
  而不是单点注释。
- 事件/通知排在 commit **之后**(③):崩在 commit 与 publish 之间 → DB 事实在、UI 晚一拍刷新
  (下次 list/SSE 重连自愈)= 良性。反之若 publish 放 commit 前、事务回滚 → **phantom event**
  (前端以为加了、实际没加)= 破坏。

**判据一句话:precondition 在前、通知在后;残留要选可自愈的那一侧。**

### 2.2 为什么不需要 domain events(记档)

③ 的消费者目前**只有 WS/UI**(`scope-event-bus.ts` → `ws-connection.ts`),无任何后端 use case
订阅它们去驱动别的聚合,无 audit/outbox。所以 ③ 是 integration/application effect,不是 domain event。
本轮用 use case 局部的 **PostCommitEffect 队列**(见 §5)管好 ③ 即可。升级触发:后端出现聚合互订阅 /
审计回放 / 崩溃补发——到那天再引入 domain events。

---

## 3. 靶子一:`AddConversationMemberUseCase`

现状评估(现读 `routes.ts:1175-1323`):**事务纪律本身已对**——`db.transaction` 包住 `addAgent` +
system message insert(`:1280-1288`),publish 在事务关闭后(`:1289`)。问题是**整套编排(resolve →
precondition → idempotency → tx → publish)埋在一个 ~150 行的 route helper 里,离不开 Hono `Context`,
无法脱 HTTP 单测**。所以这刀主要是**可定位/可测试**,不是修 correctness。

### 对照表

| 逻辑项 | 留 Route | 进 Use Case | 留 Repo | commit 后发布 | 现状/搬运说明 |
|---|:--:|:--:|:--:|:--:|---|
| body 解析(zod)、principal 解析 | ✅ | | | | 已在 route |
| 授权:human=`canAddConversationMember`+`canGovernWorkspace('admin')`;agent=`canAddConversationMember`(`:1206-1230`) | | ✅ | | | **采纳约束①**:判定移进 use case(它已 resolve target 拿到 workspace_id),返回 `forbidden`;route 映射 403。policy fn 仍纯函数 |
| 加载 conversation + kind 守卫(channel/thread)+ closed 守卫(`:1192-1205`) | | ✅ | | | 现在在 route,搬进 use case;route 把具名码(`conversation_member_add_unsupported`/`conversation_closed`)映射成 422/409 |
| 解析成员输入 `resolveConversationMemberInput`(`:1256`) | | ✅ | | | 先改 pure resolver(§1.1,去掉 Hono `Response`),use case 调用、route 映射 HTTP |
| workspace-membership precondition `isMember`(`:1267`/`:1298`)→ `workspace_membership_required` | | ✅ | ✅(查询) | | 判定在 use case,查询走 repo |
| idempotency:`alreadyMember`(`getAgent`/`getUser`)(`:1276`/`:1307`) | | ✅ | ✅(查询) | | 搬进 use case |
| **事务**:`addAgent`/`addUser` + `insertForConversation`(system message)(`:1280-1288`) | | ✅(开事务) | ✅(纯写) | | use case 拥有 `db.transaction`,repo 只纯写 |
| `message`(system 入会消息)(`:1248-1252`) | | | | ✅ | 已是 post-commit,纳入 effect 队列 |
| `conversation_members_changed`(`:1232-1238`) | | | | ✅ | 同上 |
| `workspace_channels_changed`(scope publish)(`:1239-1246`) | | | | ✅ | 同上 |
| 返回 `membership.listMembers` | ✅(序列化) | ✅(取数) | | | use case 返回数据,route 包成 JSON |

**目标形态:** route 仅剩"解析 + 授权 + 调 use case + 把 `Result<…, NamedError>` 映射 HTTP"。

---

## 4. 靶子二:`AddWorkspaceAgentMemberUseCase`(load-bearing)

现状评估(现读 `routes.ts:3059-3092` + `workspace-repo.ts:413-442` + `agent-capability-repo.ts:75-91`):
**这刀同时治两个洞**——
- **漏进 route**:placement 断言 + L2 seed + 写库 三步编排散在 route handler(`:3064-3092`)。
- **沉进 repo**:`WorkspaceRepo.addMember()` 自开事务、并在事务内 `new AgentCapabilityRepo(db).seedDefaults()`
  (`workspace-repo.ts:430-431`)——把"能力默认策略"焊进了 workspace 持久层。`agent-capability-repo.ts:18`
  的注释明说这层耦合是 by `WorkspaceRepo.addMember`,正是要解的。

### 对照表

| 逻辑项 | 留 Route | 进 Use Case | 留 Repo | 时机 | 搬运说明 |
|---|:--:|:--:|:--:|:--:|---|
| body 解析、人类 governance gate | ✅ | | | — | `POST /api/workspaces/:id/members` 的入口是 admin；human role/remove 仍 owner-only。该小路径保留 route 授权,本刀聚焦 agent 分支 |
| 授权:入口 `admin` gate | ✅ | | | — | route |
| placement / host equality(`assertAgentMatchesHost` `:3068` + repo 内 `assertHostEqualityForMembership` `workspace-repo.ts:414`) | | ✅ | | **② pre-commit** | **采纳约束②**:host/placement 是 workspace placement policy,不是表级持久化前提。统一收进 use case 的 ② precondition,**从 `insertMembership` 移除** → 同时清掉 `WorkspaceRepo → AgentRepo/placement` 隐性领域依赖;route 映射 `placementErrorResponse` |
| **L2 seed**(daemon)`seedMemberAgentL2`(`:3074-3083`) | | ✅ | | **② pre-commit(awaited)** | 用 §1.1 下沉后的 HTTP-agnostic 版本;必须 seed 成功**才**进事务(§2.1 铁律);失败返回 typed code/status,不写行 |
| **事务**(use case 开):`insertMembership` + `if(created) seedDefaults` | | ✅(开事务) | ✅(各自纯写) | **① in-tx** | **关键改动**见 §4.1 |
| 持久化:`workspace_members` INSERT OR IGNORE,返回 `created` 标志 | | | ✅ `WorkspaceRepo.insertMembership()` | ① in-tx | 从 `addMember` 拆出,去掉对 AgentCapabilityRepo 的调用 |
| 策略:`created` 时 seed 默认能力集 | | ✅(决定调用) | ✅ `AgentCapabilityRepo.seedDefaults()` | ① in-tx | 策略归属回 use case;repo 只提供纯 seed 动作 |
| 返回 `member` | ✅(序列化 201) | ✅(取数) | | — | |
| (现状无 post-commit 事件) | | | | ③ | 当前此路径不发任何事件——**保持不变**,不新增 |

### 4.1 关键改动:解耦 `WorkspaceRepo → AgentCapabilityRepo`,事务上移

**现状(`workspace-repo.ts:413-442`):**
```
WorkspaceRepo.addMember(ws, agent):
  db.transaction:
    INSERT OR IGNORE workspace_members        # 持久化
    if changes>0: new AgentCapabilityRepo(db).seedDefaults()   # ← 跨上下文策略焊进持久层
    return row
```

**目标:**
```
WorkspaceRepo.insertMembership(ws, agent) -> { member, created }   # 纯持久化;无跨 repo 调用、无 host/placement 检查
AgentCapabilityRepo.seedDefaults(ws, agent)                        # 已是纯 seed 动作(无需改)

AddWorkspaceAgentMemberUseCase.execute(...):
  assertAgentMatchesHost(...) / host-equality      # ② pre-commit(从 repo 上移到此)
  await seedMemberAgentL2(...)  // 失败即返回,不写行   # ② pre-commit(HTTP-agnostic 版本)
  db.transaction(() => {                            # ① use case 显式持有 UoW
    const { member, created } = workspaceRepo.insertMembership(ws, agent)
    if (created) capabilityRepo.seedDefaults(ws, agent)   # 策略回应用层,仍同一事务
  })()
  return member
```

**不变量(一字不丢,见 §6):**
- 原子性:成员 + 能力仍在**同一事务**,部分失败整体回滚 →"member 必有 cap 集"成立(`agent-capability-repo.ts:80-81`)。
- no-silent-re-widen:只在 `created`(本次真正插入)时 seed → 重加已存在成员是 no-op,不覆盖被收窄过的集合(`workspace-repo.ts:424-429` / doc §2.3)。
- L2-seed-first:seed 成功才写行(`:3059-3063` red-line),由 §2.1 铁律承载。
- host equality:**移到 use case ② precondition**(采纳约束②);`insertMembership` 不再懂 host/placement,`WorkspaceRepo` 不再隐式依赖 `AgentRepo`/placement。

---

## 5. PostCommitEffect 机制(最小)

零新增基础设施。一次 use case 内:

```
type PostCommitEffect = () => void | Promise<void>;
```

- **UoW 在代码里可见(采纳约束④):** use case **显式**写
  `db.transaction(() => { ...; effects.push(...) })()`,**不**把事务藏进通用 helper(不要
  `runWithPostCommit(tx, effects)`)。
- 事务内**只收集** effect(push 闭包),不执行。
- 提交后调用一个**很薄**的 `runPostCommitEffects(effects, logger)`:只负责**按收集顺序**依次执行(可
  await)+ 统一 error-log。不是基类、不是 dispatcher。
- 任一 effect 抛错只 log、不影响已提交的 DB 事实(best-effort 语义,§2 ③)。
- effect 是**具体 action**——`publishMessage(msg)` / `publishConversationMembersChanged(...)` /
  `publishWorkspaceChannelsChanged(...)` / `deliverMessage(...)`,**不是**抽象 DomainEvent 类型。

> 注:better-sqlite3 事务是同步的,现有代码(如 `task-service.ts:421/424`)的 `await broadcast` 已天然
> 落在 `db.transaction()()` 之后 = 已是 post-commit。本机制把这个隐式属性**显式化、可复用**,
> 并覆盖 route 层那些"DB 写与 publish 交错、无事务包住"的散点。

---

## 6. 必须保留的不变量(回归清单)

重构后这些必须仍为真,作为测试 + review 卡点:

1. **member ⇒ cap 集**:新增 workspace 成员后,该 (ws, agent) 必有默认能力集;部分失败两者都不落。
2. **no-silent-re-widen**:重加已存在成员不重置被收窄的能力集。
3. **L2-seed-first**:无"有 member 行但 L2 未 seed"的半状态。
4. **host equality**:跨 host 的 (agent, workspace) 仍被拒。
5. **conversation 入会幂等**:重复加同一成员不重复发 system message / 不重复 publish。
6. **kind/closed 守卫**:仅 channel/thread 可加成员;closed 拒绝。
7. **授权语义**:human governance(admin / human-roster owner)、agent capability(view-equiv,
   `manage_conversation_members` 仍是 pending debt,本刀不改)行为不变。
8. **post-commit phantom-free**:事务回滚时不发任何事件。

---

## 7. Review 裁定(Cindy 2026-06-09 已 review,全部 resolved)

spec 方向 Cindy 通过;6 项原 open question 已裁定,4 条实现约束已并入正文(§1 授权、§1.1 adapter-leak、
§4 host equality、§5 helper 命名):

1. **host equality 归属** → **use case ② precondition**(不留 repo)。理由:host/placement 是 placement
   policy,非表级持久化前提;留 repo 会延续 `WorkspaceRepo → AgentRepo/placement` 隐性领域依赖,正是要清的。已并入 §4。
2. **`insertMembership` 返回** → `{ member, created }` 够用,不再多查一次。
3. **L2 seed 幂等/孤儿** → Cindy 现读 daemon handler 确认:`mkdir recursive` + `writeIfMissing`,已有文件保留;
   commit 失败留下孤儿 L2 目录可接受、重试路径良性。§2.1 判定成立。
4. **PostCommitEffect 执行器** → 用 `runPostCommitEffects(effects, logger)` 这种薄工具(只顺序执行 + log);
   **不要** `runWithPostCommit(tx, effects)`(会把 UoW 藏进通用 helper)。UoW 在 use case 代码里显式可见。已改 §5。
5. **human 分支** → 本刀不动,只切 agent 分支,不强行统一两条。确认。
6. **effect 顺序** → 保持现状 `message` → `conversation_members_changed` → `workspace_channels_changed`,
   不趁重构改消费顺序。确认。

**结论:补完上述后 spec 进入实现。第一刀仍只切 AddWorkspaceAgentMember + AddConversationMember,不扩 DTO、
不碰 channel permission。** 实现归属与启动时机等 shiki 拍。

---

## 8. 本轮明确不做

- 不引入全局 `DomainEvent` 类型 / dispatcher / outbox 表 / 订阅式 handler。
- 不一次性按名词重排目录;DTO/routes 物理拆分留 P1,与 use-case 分组**走同一套 context 缝**
  (一个上下文 = 一个契约模块 + 一个路由 + 一组 use case)。
- 不碰 channel-level permission。
- 不引覆盖率% 闸门。
- 不新增任何当前不存在的对外副作用。

---

_落地顺序提示:先 §4(load-bearing,治两个洞),再 §3(可测试性收口),P1 再按 context 拆 DTO/routes。_

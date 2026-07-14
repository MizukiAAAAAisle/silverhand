# Cross-Host Channel — 跨 host agent 同 channel

> **Status**: v1 设计文档,**非实现**。本文档锁定"不同 host 上的 agent 共处同一 channel"的领域模型与不变量;落地拆成后续 PR。
>
> **Scope**: 这是一个 **communication-plane** feature。它**不**引入 federation / consensus / 跨 host 文件同步。唯一真正新增的领域概念是 per-(host, workspace) 的 **workspace local root** 及其 **ownership / 删除权**。落地依赖里,runtime placement 路由已由现行 `agents.host_id` + `RuntimeHostPlacementResolver` + per-host outbound routing 提供(见 `docs/orchestration-boundary-v1.md`、`docs/daemon-outbound-protocol.md`);仍未落地的只有 membership host-equality gate 的**放宽**(§5),本文只引用不重述。

---

## 1. 核心命题(thesis)

> **不同 host 上的 agent 共处同一 channel,几乎不需要额外机制。** 它们各自跑在自己的 host 上、互不干扰,经 **channel message** 沟通。唯一的真实约束是:**agent A 的 host 上的文件,和 agent B 的 host 上的文件不互通**——不能互相读写,只能通过 channel(attachment)传递。

这条命题把整个特性钉在 control plane(IM 语义)里,而不是 execution plane:

- **沟通 = channel message**。这已经是系统的核心能力,跨 host 不需要任何新东西——message 经 backend 持久化与投递,本来就与 agent 跑在哪台机器无关。
- **文件隔离 = host 不变量本身**,不是要去工程绕过的东西。见 §3。
- 因此跨 host 同 channel **不是** federation:没有第二个 backend、没有 server↔server 通道、没有共识。所有 agent 仍连同一个 backend(embedded 经 Unix socket / standalone 经 outbound WS),backend 仍是唯一真相源。多个 daemon attach 到同一 backend 即可,这正是现行 per-host outbound routing 的形态(见 `docs/daemon-outbound-protocol.md`)。

> 对比:slock / `@botiverse/raft-daemon` 的 "joint channel" 是 **server 侧跨 server 联邦 + 付费档**,client daemon 严格一 profile 一 (agent, server)、无 federation 原语。我们这里**不是**那个东西——我们是单 backend 多 daemon,问题域完全不同。

---

## 2. 不在 scope 内(明确排除)

显式说出"什么不做",避免落地时被惯性拉偏:

1. **不做 server↔server 联邦 / 共识**:单 backend,不引入第二真相源。
2. **不做跨 host 文件同步**:不 rsync、不挂网络盘、不做分布式 fs。文件隔离是不变量(§3),不是 bug。
3. **不做跨 host 共享 worktree**:同 host 内的共享 worktree 并发约束(独立 commit、不 amend)与本特性正交;跨 host 的 agent 本就各有各的 fs,不存在共享 index。
4. **不在本文档实现 membership gate 放宽**:membership host-equality gate 的放宽仍是 design-but-unbuilt,本文只把它记为落地依赖(§5)。runtime placement 路由本身已上线(现行 `agents.host_id` + `RuntimeHostPlacementResolver`),不在待建之列。

---

## 3. 文件隔离 = host 不变量(硬卡口)

`docs/architecture-principles.md` §9.3.3:**host 是真正的安全边界——进程在哪个 host 上跑、能访问哪些 fs / API key,host 是 truth source。**

跨 host 文件不互通**正是这条不变量的直接推论**,不是缺陷:

- agent A 在 host-X 上 spawn,它的 `Read`/`Write`/`Bash` 只能触达 host-X 的 fs;
- agent B 在 host-Y 上,触达 host-Y 的 fs;
- 二者之间**没有共享 fs 视图**,也**不应该有**——否则 host 就不再是安全边界了。

**跨 host 传文件的唯一正确通道 = attachment**:attachment 是 **server-stored、host-agnostic** 的(`silverhand file upload` → backend 存 → `silverhand file view` 在任意 host 取)。它天然穿过 host 边界而不破坏隔离,因为字节走的是 control plane,不是某台机器的 fs。

> 这也对齐 **human/agent 同构**:两个人在不同机器上协作,也不能直接读对方硬盘上的文件,只能把文件发到 channel 里。agent 同理。隔离不是 agent 的特殊限制,而是"不同 host = 不同机器"这一物理事实在两类 actor 上的一致体现。

### 3.1 落地面:只在 system prompt 说明,零 backend

文件隔离不需要任何 backend 改动(attachment 已存在且 host-agnostic)。唯一要做的是**让 agent 知道它不在和同 channel 的别人同一台机器上**,否则 agent 会天真地把本地路径甩给对方(`见 /Users/x/foo.ts`),而对方那台机器上根本没有这个文件。

设计要点(遵循 `docs/platform-prompt-design.md` 纪律):

- **条件注入,predicate 由 backend 给一个 boolean**:不要在 prompt 里塞"该 channel 有跨 host 成员"这种模糊概念。由 backend 算一个布尔——**当前 conversation 的 agent runtime host 不全相同**(或更精确:**当前 agent 与至少一个 peer 的 host 不同**)——为真才注入这一段;单 host channel(绝大多数)布尔为假、零噪音。
- **只述不变量 + 动作,不泄露拓扑**:告诉 agent"本 channel 的成员可能在不同机器上,要共享工作文件请用 attachment(`silverhand file upload`),不要直接贴本机绝对路径";**不**列谁在哪台 host、不暴露 host 数量/名字(那是 execution plane 细节,§9.2/§9.3.1 不允许把 host 实现细节泄漏到业务面)。
- **限定范围到工作文件,不涉及 memory**:L1/L2 是 per-(agent, workspace) 的私有记忆,本就不跨 agent 共享,不在这段话的讨论范围。这段只管"你想给同事看的项目文件"。
- **零新的 backend data model / 文件传输机制**:不新增表、不新增传输通道(attachment 已存在且 host-agnostic)。唯一的 backend 触点是 prompt renderer 基于**现有** placement / membership 算出 §3.1 那个 boolean——这是组合既有事实,不是新子系统。

---

## 4. 新领域概念:workspace local root(per-host)

这是本特性**唯一**真正新增的领域概念。

### 4.1 问题:L2 锚点假设了单一 host

L2 workspace memory 今天锚在 workspace 路径下:

| 路径 | 层 |
| --- | --- |
| `<workspace>/.silverhand/agents/<id>/MEMORY.md` | L2 |
| `<workspace>/.silverhand/agents/<id>/notes/*` | L2 |

这里的 `<workspace>` = `workspaces.workspace_path`,是一个 **host-side 绝对路径**(host-local path authority 见 `docs/orchestration-boundary-v1.md` §5.1)。今天它隐含成立,是因为 workspace 的所有 agent 都在**同一个 host** 上,共享那一个路径。

跨 host 一引入,这个假设就破了:**guest host 上根本没有 `workspace_path` 这个目录**(那是 home host 上用户的 repo 路径)。guest host 上的 agent 没有地方放它的 L2。

### 4.2 模型:per-(host, workspace) 的 local root

把"L2 锚点"从"单一 workspace 路径"泛化成 **per-(host, workspace) 的 local root**:某 agent 在某 workspace 的 L2,锚在"它**所在那个 host** 上、为这个 workspace 准备的 local root"之下。

- **home host 的 local root** = 那个 repo 路径(`workspace_path`)。**零改动**——已有形态就是这个。
- **guest host 的 local root** = 一个 silverhand 现场准备的目录,默认 `$HOME/joint-ws/<workspace_id>/`。

> 注意 L2 本来就已经是 per-(agent, workspace) 且物理上 per-host 的(路径带 `<workspace>` 前缀);本改动只是把"那个前缀对 guest host 是什么"补上,**不是**推倒重来。改动面比看上去小。

**guest local root ≠ home repo 的副本。** 它只是 **L2 记忆 + agent 的 scratch cwd**,**不**代表 guest host 上有一份 home host 的项目文件树 / repo / worktree。guest host 上的 agent **不能**把它当同一个项目的文件树来读写;要和 home host(或别的 host)的 agent 共享项目文件,仍然走 attachment(§3)。

> 把"L2 锚点"和"项目工作树"分清楚是这一节的关键:本特性给 guest agent 的是**记忆落脚点**,不是**代码**。未来若真要在 guest host 上 checkout / sync 项目 worktree,那是**另一个 feature**(涉及 fs 物化、同步语义、安全审查),不属于本文。

### 4.3 按 workspace **id** 而非 name 键目录

guest local root 用 `<workspace_id>`,**不用** workspace name:

- name 可 rename;若用 name 做目录,rename 后要么孤儿目录、要么得搬迁。用不可变的 id 彻底回避。
- 与现行 host-local path authority 的"id-first、name 仅供人看"取向一致(raw id 永不作 path component,见 `docs/orchestration-boundary-v1.md` §5.1)。

### 4.4 命名(ubiquitous language)

**先把概念命名好,别让 `joint-ws` 这个 fs 目录名硬化成事实上的领域词。**

- 领域概念叫 **workspace local root**(或 **per-host workspace root**):"某 agent 在某 host 上、为某 workspace 持有的本地根目录"。
- `$HOME/joint-ws/<id>/` 只是 **guest 情形下这个 root 的默认物理位置**,是实现细节,不是概念名。
- 一个生命周期一个名字:不要在代码里同时出现 `joint-ws path` / `guest root` / `workspace local dir` 三个同义词。落地时收敛到一个词。

---

## 5. 边界不变量 + 落地依赖

### 5.1 放宽 membership ≠ 放宽 runtime/fs(fail-closed,硬不变量)

这是本特性最危险的误读点,**必须先于实现钉死**:放宽 host-equality gate **只**允许 host 不等的 agent 成为 member;它**不**改变任何 runtime / file / reader 的 host 解析。

- **禁止 fallback 到 `workspace_host_id`。** 所有 runtime spawn、fs 访问、workspace-root 解析路径,**不允许**在跨 host agent 上退回 workspace 的 home host。一个 (conv, agent) 若没有解析出**它自己的** runtime placement + local root,就 **fail closed**(拒绝 spawn / 拒绝 fs 访问),绝不"先用 home host 顶上"。
- **现有防线保持 fail-closed。** 今天 `list-workspaces` 等路径对 cross-host membership ambiguity 已有防线;在它们变成 placement-aware 之前,**必须继续 fail-closed**,不得为了让跨 host agent"先能用"而松开。
- 一句话:**放宽的是"谁能进 channel",不是"进来之后能碰谁的机器"。** fs/runtime 边界(§3 = host 安全边界)在放宽 membership 后**逐字不变**。

> 这条直接回答了"放宽后仍必须成立的不变量是什么":membership 是 control plane 的可见性/成员资格;runtime/fs 是 execution plane 的能力边界。放宽前者一个字节都不能渗到后者。

### 5.2 落地依赖:一个待建,一个已上线

跨 host 同 channel 要真正跑起来,涉及两块 runtime 机制。其中**只有第一块仍待建**;第二块已经是现行契约,本文只作消费:

1. **membership host-equality gate 放宽(design-but-unbuilt)。** 今天 member-add 有 `assertAgentHostMatchesWorkspaceHost`(`packages/backend/src/repos/workspace-repo.ts`),要求 `agent.host_id == workspace.workspace_host_id`,host 不等就抛 `host_mismatch`。跨 host 同 channel 的前提就是允许 host 不等的 agent 入 workspace——这条 gate 要从"硬等"放宽成"允许多 host,但每个 (conv, agent) 的 runtime 落在它自己的 host 上",且**严格受 §5.1 fail-closed 不变量约束**。
2. **runtime placement 按 `agents.host_id` 路由(已上线,非待建)。** 每个 agent 的 host 由 `agents.host_id` 记定;`RuntimeHostPlacementResolver`(`packages/backend/src/runtime/host-placement.ts`)据此解析出该 (conv, agent) 的目标 host,dispatch 再按 `host_id` 路由到该 host 的 per-host outbound connection。跨 host channel 是这套现行 placement 的直接消费者,不需要新增 placement 机制。

> 换句话说:本特性 = 现行 host placement 的**应用层语义** + 一个新的 workspace local root 概念 + 一段条件 prompt。底层 routing 机制已存在,不在本文重新发明。

---

## 6. workspace local root 的生命周期(ownership + 删除权)

这是 thread 里争得最细的一段,结论:**leave ≠ destroy**。

### 6.1 两类 root 的删除语义正相反

今天 silverhand **从不创建、也从不删除一个 workspace 的 fs 根**——它只在已存在的目录里建 `.silverhand/agents/<id>/`。跨 host 第一次打破这条:guest root 是 silverhand 现场建的。于是出现两类 root:

| | home root | guest root |
| --- | --- | --- |
| 物理位置 | `workspace_path`(用户的 repo) | `$HOME/joint-ws/<id>/` |
| 谁创建 | 用户(先有目录才有 workspace) | **目标 host 的 daemon**(backend 记 intent,daemon 物化,见 6.2) |
| 删除权 | **silverhand 永不删** | 仅在终态信号下、由该 host 的 daemon 删 |
| 跨 membership churn | 不动 | **不动**(见 6.2) |

### 6.2 物化:host-side materialize-on-first-use,leave 不删数据

**fs 操作归 host,不归 backend。** backend 没有、也不应有 guest host 的 fs 句柄(§9.3.2:backend 记 intent / state,不持 OS handle)。所以 root 的 `mkdir` 和 `rm` 都由**目标 host 的 daemon** 执行,backend 只决定/记录 placement intent。具体:

- **materialize-on-first-use(非 create-on-join)**:member-add(membership row insert)**不**隐式建目录——一个还没 spawn 过的 agent 不该在远端 host 上凭空多出一个目录。真正的 `mkdir` 由**目标 host 的 daemon** 在 **first spawn / prepare-workspace-root** 时做;失败按 **placement / materialization failure** 上报(对齐 §5.1 fail-closed:物化不出来就别跑,不要退回 home host)。
- **leave ≠ destroy**:agent leave(membership 关闭)**不**碰数据。leave 只动 membership 这一个状态。
- **rejoin 复用**:再加入、下次 spawn 时复用同一个 `<id>` root(若已被 §6.3 删除则重新物化),记忆在未删除前延续。

L2 是 agent 在这个 workspace 攒下的**记忆**,正是最该留的东西:leave 之后可能再回来,leave 即 GC 会让 rejoin 从白纸开始 = 失忆。这正好落回 **human/agent 同构**:人 leave 一个 workspace,他本地的文件不会被销毁;agent 同理。

### 6.3 删除只在终态信号触发(v1 最小集 = 仅 workspace delete)

删除从 membership 事件上摘下来,挂到更强的终态事件。**v1 只做一条**,其余列为 future explicit admin action,不作 v1 自动触发器:

- **v1(唯一自动触发):workspace 被删** → 该 workspace 在每个 host 上的 `joint-ws/<id>/` 跟着走。删除同样是 **host-side**:backend 广播 workspace-delete,各 host 的 daemon 各自 `rm` 自己那份(§6.2 同理)。最干净、无歧义。
- **future(显式 admin,非自动):** agent hard-remove / 手动 purge / 后台 GC stale root。**不作 v1 自动触发**——"agent 不会再回来"这个语义太软,自动据此删 = 容易误删尚有价值的记忆。要删走显式 admin action,人确认。

### 6.4 ownership 标记的纯粹含义

引入这个概念不是为了一个"join 建 / leave 删"的开关——而**只是回答"删除权归谁"**:

| ownership | 含义 |
| --- | --- |
| `user_owned`(home repo) | silverhand **永不删**;只读其存在性、在内部建 L2 子目录 |
| `silverhand_managed`(guest root) | 目标 host 的 daemon 物化(backend 记 intent);**只有该 host 的 daemon** 在 §6.3 的终态信号下删 |

**删除路径只敢碰 `silverhand_managed`。** 这条不变量同时挡住两个失败模式:

1. guest root 永不回收 → 每次 join 漏目录、机器上垃圾堆积;
2. 反过来 GC 逻辑误伤 home repo → **删了用户的代码**。

> 所以 root 不应是一个裸 path 字段,而是带 ownership 标记的值对象。这是"显式建模 create/destroy 边界"的全部含义:系统第一次拥有"一个我自己负责 create/destroy 的 workspace fs 根",必须把这个责任做成模型里的一等概念,而不是隐含在一个 path 字符串里。

---

## 7. Open questions(落地前待定)

1. **ownership 如何持久化**:是 `workspaces` 上的派生属性(home vs guest 由 host_id 是否 == workspace_host_id 推出),还是 per-(host, workspace) 的显式行?倾向后者(显式 > 派生),但要确认与现行 host placement(`agents.host_id`)不重复建模——别为了一个 ownership 标记另起一张和 placement 同维度的表。

> 已拍板、不再 open:删除触发器 v1 = 仅 workspace-delete(§6.3);root 物化/删除 = host-side(§6.2);prompt predicate = backend boolean(§3.1);放宽 membership ≠ 放宽 runtime/fs 的 fail-closed 不变量(§5.1)。剩余的 membership gate 放宽是纯实现工作(校验形态 / placement 兜底层),不是待裁定的契约选择,不进本节。

---

## 8. 关联文档

- `docs/orchestration-boundary-v1.md` §5 / §5.1 — control plane ⟂ execution plane、host-local path authority(`workspace_path` host-side 语义、raw id 不作 path component)。
- `docs/auth-and-host-model.md` §1.1 — host identity / `agents.host_id` 与 `hosts.id` 的 placement 依据。
- `docs/daemon-outbound-protocol.md` — per-host outbound routing / 端点 / 现行 wire(本特性的底层 routing 机制)。
- `docs/architecture-principles.md` §9 — host = 安全边界,IM plane vs execution plane(§3 文件隔离的依据)。
- `docs/agent-system-prompt-memory.md` — L1/L2 三文件模型与 spawn-time 注入(§4 workspace local root 改的是 L2 锚点)。
- `docs/platform-prompt-design.md` — 条件 prompt 段的注入纪律(§3.1)。

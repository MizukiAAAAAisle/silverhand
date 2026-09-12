# Rust backend infra — 证据矩阵 v1（阶段一）

> TS backend 退役说明：文中的 `packages/backend` / `packages/server` 源码与测试坐标属于迁移期历史，已从当前仓库删除；现行控制面位于 `rust/crates`。迁移权威仍在 `packages/shared/src/db`，独立回归数据在 `rust/test-fixtures`，现行构建与验证见 [testing.md](testing.md)。

Status: evidence only. **本文不定义任何 trait，不定义 crate/workspace 形状。**
Task: #task:2166 ｜ Owner: Lio ｜ Review: Cindy ｜ Worktree branch: `lio/rust-infra-contracts`（不改 main）

**取证基线（引用稳定性）**

- 仓库：`silverhand` monorepo（pnpm workspace）。
- 基线 commit：**`b654571e`**（"Remove retired layout migrations (#task:2164)"）—— 本文全部 `file:line` 均在此 commit 上取证。
- 路径约定：`db.ts` 等无前缀路径默认相对 `packages/backend/src/`；跨包引用写全（`packages/shared/src/…`、`packages/host/src/…`、`packages/cli/src/…`、`apps/desktop/src/…`）；`docs/…` 相对仓库根。
- 本文档在仓库内的稳定路径：`docs/rust-infra-evidence-matrix-v1.md`（branch `lio/rust-infra-contracts`）。
- 行号会随后续提交漂移；判断合同请以**引用的原文句子 + 符号名**为准，行号只作定位提示。

## 0A. 修订记录

**rev6（本次）**——代码终审的三条收尾修正：SQLite `synchronous` 与 deferred-read 的注释从本轮复盘改写为稳定合同与场景；`Secret<T>` 的负向 fence 从字面匹配改为按 derive 列表逐项结构比对 + 覆盖手写 impl，并用两次变异（跨行 `derive(Copy, Clone)`、手写 `impl Clone for Secret`）验证非空洞。task body 同时收敛为纯终态，不再复述轮次。

**rev5**——阶段二代码 review 的四条 blocker 修正（forward-only，未扩范围）。

| #   | Blocker                                                                                                    | 修正                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | D1 已决策 `FULL`，但代码与测试仍把 `NORMAL` 固化为绿                                                       | `SqliteSynchronous::Full`，配置测试断言 effective `2`，README 同步为当前值；#2165 历史报告保留"当时实验过 `NORMAL`"的测量并注明已被本任务决策取代                                  |
| 2   | read UoW 的核心不变量未被行为测试证明——原测试只证 RESERVED writer 不阻塞读，两条 SELECT 掉到不同快照仍会绿 | 补判定性测试：第一次 SELECT 建立快照 → 另一 pooled connection 提交 → 同一读事务的 count 与 latest 仍是旧快照 → 新事务能看到新行                                                    |
| 3   | "generic async closure 缺失是编译级证明"过度声明                                                           | 收窄：编译级只覆盖"端口不需要具体 driver 类型"；closure / tx capability 的缺失只由 API 形状 + 词法门保证，机械依赖方向需未来 crate boundary + visibility。未引入 compile-fail 框架 |
| 4   | `Secret<T>` 暴露了无用例支撑的 `Clone`/`PartialEq`/`Eq`                                                    | 全部删除（`PartialEq` 鼓励非恒时比较 token，`Clone` 让复制秘密成为默认）；负向门加入这三个 derive；将来具体 secret 需验证时走具名恒时校验器                                        |

错误 source-chain / HTTP 单点映射经复核 **PASS**，对 #2165 两个文件的修正无需回退。

**rev4**——阶段二交付记录（§9B）+ D1 裁定 `FULL` + D2 按 ECS 停服部署收窄。

**rev3**——async-tx 与 clock 的全局口径清理（八处 + 四处），详见下表第 2、5 行。

**rev2（回应 Cindy review）**——六条 blocker，5 条全接受、1 条接受主张并附一个具名新增关切。

| #   | Blocker                                                        | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 改了哪里                                               |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | "remote-only ⇒ 生成方向必须 TS-authoritative" 是错误推论       | **全接受，这是我的越界**。我把自己在 §13 列为可证伪的推论写成了正文硬禁令。remote-only 打包不运行 Cargo ≠ 合同生成不能在开发/CI/release 前置完成；Rust-authoritative 的 TS artifact 可预生成并提交/发布，remote-only 只消费成品 + drift gate 保单一权威。**infra 不再对权威方向表态**，只定义四条负向约束                                                                                                                                                                                                                                                                                                                                                                                | §7-3 重写；§8A 删除该禁令；§13 对应 falsifier 改写     |
| 2   | "同步性是真合同"定性过重；不要另开 rusqlite-vs-SQLx 第二场选型 | **接受**。重分类：repo 同步调用图 = 实现形状（惯性）；真合同 = 原子性/隔离性 + tx 内不得外部副作用 + post-commit 顺序。驱动选型收口为消费 #2165（SQLx 既定）。<br>**关于"async 闭包丢掉句法保证"这条关切（rev3 终态）**：首批答案就是 #2165 的 **semantic UoW**——application 只调用语义 UoW 方法、事务完全封在 SQLite adapter 内、**根本拿不到 generic async tx closure**，所以不存在"在闭包里捕获外部 capability"。我原先提的候选①（tx scope 类型不含 effect capability）**不成立**：Rust closure 可以捕获环境里的任何东西，限制 scope 参数不构成类型安全。该议题**不是阶段二 deliverable，也不是未闭合 blocker**，只在"真实跨 repo 原子编排出现且 semantic UoW 无法表达"时触发局部设计 | §3.6 / §3.7 / §8A / §9 / §10-S2 / §13 全部按此口径清理 |
| 3   | PostgreSQL 不再是当前扩张理由                                  | **全接受**（shiki 裁定：只要求 SQLite 收敛不外泄）。§3A 保留为边界审计；L5/per-tx pool 降级为审计观察，**不再是与驱动选型并列的最高优先 spike**；PG 生命周期猜测不得塑造本轮 port。当前 gate 收窄为：domain/application import closure 无 SQLite/SQLx/dialect/driver error；SQLite adapter 内部可选最简单正确形状                                                                                                                                                                                                                                                                                                                                                                        | §3A.2-L5 与 §3A.3 重写；§9-8 删除                      |
| 4   | shared 三刀不能自动变成前置工程                                | **全接受，含一处我的误读**。硬门 4"runtime validation 保持"是**不得丢失既有**校验；`ws-frames.ts` 本来就没有 zod，因此不构成违反——我据此强推补 schema 是过度解读。三刀改为 **triggered backlog**，每条写明触发条件                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | §6.4 重写为触发式 backlog；§8A 跨语言段改写            |
| 5   | Trait 判据过窄且应用不一致                                     | **全接受**。我把 gate 3 的"第二实现或测试替身"当成唯一合法性来源，机械套用，导致自相矛盾：`BlobStorage` 因"只有 local 实现"被判不抽，而 clock 因"9 个注入点"被判要抽。改用三判据（跨层所有权 / 必须隔离的副作用 / 已证可替换或可测，满足其一），再选最小语言形状，**不默认 Trait**。`BlobStorage` 改判为抽（真实 domain↔存储边界，且现存 `Response` 泄漏是独立证据）；clock 改判为具体 capability/函数，不建全局 `Clock` trait                                                                                                                                                                                                                                                           | §5.7 表格重写；§8A Trait 段改写                        |
| 6   | "真合同"与"迁移期兼容基线"需分开                               | **全接受，我文内确有矛盾**：§2.4 把 raw zod issues 判为惯性，§7 却说六种信封全部逐字永久保留。改为两档：**首阶段 parity freeze**（为行为等价逐字复刻）vs **长期业务合同**（被 schema/消费者/测试真实锁定的子集），后者可经显式产品迁移删除。错误 renderer 按 **endpoint contract** 组织，不预设恰好六个永久类型                                                                                                                                                                                                                                                                                                                                                                          | §2.4-1 / §2.5 / §7 重写                                |

**rev1**：阶段一首次交付（证据矩阵）。

## 0. 本文的作用与不作用

作用：把现有 TS backend 的**真实语义**取证成可审的矩阵，并把每条语义判成"真合同 / 内部惯性 / 已知缺陷"三类。只有"真合同"能约束 Rust 侧接口形状。

不作用：

- 不建 Cargo workspace，不自称基线。crate 组合与可运行 vertical slice 归 Toby lane；本文只产出 **integration seam 清单**（§10）。
- 不写 trait。阶段二才写，且**边界合法性来自三判据之一**：①**跨层所有权**（能力属于另一层，业务不该拥有）②**必须隔离的副作用**（碰进程外的世界）③**已证可替换或可测**。满足其一 → 需要边界；**再选最小语言形状，不默认 Trait**（具体类型 / 函数 / capability struct / trait 按需）。"没有第二实现"**不是**否决边界的充分理由；"有几个测试注入点"也**不是**建全局 trait 的充分理由。详见 §5.7。
- 不做 `packages/shared` 大拆包。shiki 已收敛：允许稳定单向合同耦合，硬门只有四条（§6.0）；清理项一律触发式（§6.4）。

**阶段二范围（rev3 定稿，shiki 收敛 + Cindy 划定）**：**只做"首个真实 slice 必需"的最小 infra 原型**。目标是**守住不可逆的依赖方向**，不是一次把 backend 设计完。

只做以下三项，各自都有明确的"不做"边界：

| #   | 做什么                                                                                                                                                | 明确不做                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | **事务只定依赖方向**：用一个**真实 operation** 证明 application 既不拿 tx handle、也不拿 generic async closure，而 adapter 内部能选对 root / deferred | **不**把 root/deferred 写进任何 repo / use-case 签名（它们是 SQLite adapter **私有能力**）；**不**设计全局事务框架 |
| 2   | **错误层次 + source chain**：做**一个代表性**的 domain → application → HTTP adapter 映射，证明 status 不进内层、infra source chain 不丢               | **不**碰 546 点全量映射表                                                                                          |
| 3   | **两条独立类型边界**：secret newtype 的 `Debug`/`Serialize` 负向门；domain/application 不依赖 SQLite/SQLx/方言/driver error。各做**最小可编译 proof** | **不**扩 config 框架、**不**扩 DB 框架                                                                             |

明确**不在本阶段闭环**、只保留证据与 `provisional` 标记的：完整 error 映射、取消 / 超时 / backpressure、config 与 observability 的全部细节、shared 三项清理、PG 相关一切、generated TS 子目录与 drift gate（**归 Toby lane，我只引用其最终结论**）。

**判断本阶段该做什么的唯一问法**：这条 infra 决定是否会形成**难以反转的依赖方向**？是 → 现在定；否 → 记进证据，留给触达它的那个 slice。

**分支纪律**：等 #2165 终审 PASS 后，把 `lio/rust-infra-contracts` **线性接到它的最终 commit** 上，再新增独立 infra modules/tests。**不另建第二个 Cargo root，不并行改 Toby 尚未收口的核心文件。**

## 1. 判据：三分类定义

| 类           | 定义                                                                                                                      | 对 Rust 的效力                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **真合同**   | 已落库数据、对外 wire 字节、被测试/客户端/文档锁定的字面量、部署与运维依赖（logrotate、Prometheus label）、文档化的不变量 | 必须复刻，逐字                                          |
| **内部惯性** | 内部命名、目录结构、TS 语言逃逸口、无人依赖精确值的常量                                                                   | 不得照抄，重新决策                                      |
| **已知缺陷** | 现状明确错误或机制根本缺席                                                                                                | 不得复刻；但"修它"若改变对外行为，须先经人类拍板（§11） |

**取证纪律**：矩阵每行带 `file:line`。机制"不存在"要显式写"不存在"——这比含糊描述更有价值，因为 Rust 侧最容易犯的错是把缺席当成"照抄即可"。

---

## 2. §1 错误语义

### 2.1 现状：没有分层，有六种并行机制

| 机制                                    | 代表                                                                                                         | 证据                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| 带 `code` 的 Error 子类                 | `ConversationError` / `ActorError` / `TargetError` / `PolicyError` / `AttachmentError` / `MessageStaleError` | `services/conversation-message/contracts.ts:191,223,235,247,261,286`                   |
| **同名重复类**（不同语义）              | `ActorError`（channel 域）                                                                                   | `services/channel-service.ts:207`，靠 `routes/responses.ts:16,23` 的 import alias 区分 |
| Result union（不抛）                    | `{ok:false, error:{code,message}}`                                                                           | `application/conversation-member.ts`（38 处）、`application/react-message.ts:39`       |
| kind-discriminated result               | `CreateAgentResult`                                                                                          | `application/create-agent.ts:110,134`                                                  |
| **application error 里塞 HTTP status**  | `SwitchAgentRuntimeError(code, status, …)`                                                                   | `application/switch-agent-runtime.ts:30-38`                                            |
| infra failure 结构体带 status+retriable | `DataPlaneFailure{code,message,status,retriable}`                                                            | `runtime/workspace-data-plane.ts:82-96`，status 表 `:80`                               |

唯一被真正围栏化的一层是**驱动层**：SQLITE_BUSY/LOCKED 前缀分类（`db-errors.ts:55`）、约束文本正则（`repos/sqlite-user-conflicts.ts:29-35`）、`repos/task-repo.ts:529`。三处都有"仅此一处"注释 + fence 测试。

### 2.2 对外 wire：六种信封并存（**实测计数，非设计目标**；分档见 §2.4）

| #   | 形状                                                                                                            | 代表证据                                                               | 谁锁定                                                  |
| --- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | `{error: <人话>, code?: <snake_case>}`（约 545 处）                                                             | `routes/responses.ts:350`、`routes/agents.ts:431-437`                  | 190 处 backend 测试断言具体 code                        |
| 2   | `{error:'invalid input', issues: <raw ZodIssue[]>}` 400                                                         | `routes/conversations.ts:465`、`routes/workspaces.ts:148`              | 仅锁 400，形状无测试 → 惯性                             |
| 3   | `{error, error_code}`（hosts，约 50 处）                                                                        | `routes/hosts.ts:194,289,308`                                          | shared `z.literal` + renderer 分支                      |
| 4   | `{error_code}`（auth，无 message）                                                                              | `routes/auth.ts:35,68`                                                 | `RegistrationGate.tsx:355,360`                          |
| 5   | 嵌套信封（唯一一处） `{error:{code:'conflict',message,details:{subkind:'message_stale',stale_event_id,…}}}` 409 | `routes/responses.ts:398-433`                                          | daemon 硬比较 `host/src/daemon/supervisor/index.ts:551` |
| 6   | `{success:false, code, reason?, capability?}`，**失败也可能 HTTP 200**                                          | `routes/tasks.ts:120,135,167`；schema `shared/src/api/task.ts:729-745` | shared schema + CLI                                     |
| 7   | 426 把 `error` 当机器码：`{error:'upgrade_required', reason:'client_too_old'}`                                  | `auth/desktop-api-epoch.ts:78-83`                                      | epoch 合同                                              |

`retriable` **从不出现在 HTTP body 上**。CLI 自己按 code/status 推导（`cli/src/errors.ts:398`）。

**WS 是独立 code 空间**：`{type:'error',code,message}`，封闭 5 值枚举 `auth_required|auth_failed|forbidden|invalid_frame|unknown_scope`（`shared/src/ws-frames.ts:159-168`），与 HTTP code 空间只有 `forbidden` 重叠。backend↔daemon 又是第三套 5 值枚举（`host/src/protocol.ts:1878-1884`）。

**CLI 消费逻辑**（决定"什么才是真合同"的关键）：`cli/src/errors.ts:241-267` —— CLI 只在 backend `code` 落在自己 9 值枚举（`:42-52`）内时才采信，否则**按 HTTP status 推导** exit class 与 retriable（`:384-395`）。结论：**HTTP status 比 code 更硬**。

### 2.3 映射点分布：散落

- `routes/responses.ts` 有 11 个映射器（`:36,87,110,151,217,260,285,334,443,464,508`），只覆盖 **14 / 546** 个错误响应点。
- 另有 4 张独立映射表：`routes/agents.ts:165`、`routes/users.ts:28`、`routes/internal-agent/delivery-target.ts:57`、`runtime/workspace-data-plane.ts:80`。
- 其余 **约 530 处 status 硬编码内联**，分布 31 文件（`conversations.ts` 109、`agents.ts` 84、`membership.ts` 50）。
- **无全局兜底**：root app 未注册 `app.onError` / `app.notFound`（已自查复核；`routes.ts:169` 的 `notFound` 是局部 helper，`routes/direct-pairs.ts:108` 等三处 `onError` 都是 `bodyLimit` 的局部选项）。未捕获异常走 Hono 默认 → **`500 text/plain "Internal Server Error"`**。

### 2.4 三分类

**真合同（分两档，rev2 修正）**

先分档，避免把兼容基线误当永久业务合同：

- **档 A — 长期业务合同**：被 schema / 客户端分支 / 测试真实锁定的形状。改动即静默破坏，Rust 必须逐字复刻，且长期保持。
- **档 B — 首阶段 parity freeze**：为首切行为等价而逐字复刻，但**没有**任何 schema/消费者锁定它。它是迁移期基线，不是永久承诺；可经**显式产品迁移**删除或改形，不需要永久保留。

| 项                                                                                    | 档    | 依据                                                                                                  |
| ------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------- |
| HTTP status 逐点复刻（含 413/415/426/429/502/503/504/507）                            | **A** | CLI exit class 与 retriable 的唯一来源（`cli/src/errors.ts:384-395`）                                 |
| `details.subkind:'message_stale'` + `stale_event_id`                                  | **A** | daemon 硬比较 `host/src/daemon/supervisor/index.ts:551`；`docs/freshness-boundary-authority-v1.md:58` |
| `capability_denied` + `details.capability`                                            | **A** | `docs/graded-permissions-v1.md:360`；构造点 `routes/responses.ts:491-501`                             |
| `DELIVERY_TARGET_REFUSAL_CODES` / `slot_out_of_scope` / `thread_suffix_not_supported` | **A** | `shared/src/delivery-target.ts:511,531,552` + 专测                                                    |
| 190 处测试锁定的 code 字符串                                                          | **A** | backend 测试断言                                                                                      |
| `error_code` 字段名（hosts / auth 面）                                                | **A** | shared `z.literal` + renderer 分支（`RegistrationGate.tsx:355,360`）                                  |
| tasks 面 `{success,code}`（含失败也可能 HTTP 200）                                    | **A** | `shared/src/api/task.ts:711,729-745,802,905`                                                          |
| WS 与 daemon 各自的封闭 code 枚举                                                     | **A** | `shared/src/ws-frames.ts:159-168`；`host/src/protocol.ts:1878-1884`                                   |
| `{error:'invalid input', issues: raw ZodIssue[]}` 的**形状**                          | **B** | 无 shared schema、无形状测试，仅 400 被锁（§2.4 惯性条同一事实）                                      |
| 未捕获异常的 `text/plain 500`                                                         | **B** | 无任何 schema；CLI 只按 status 推导。改动属产品决策（§11-1）                                          |
| `error` 与 `message` 双载同句                                                         | **B** | `routes/responses.ts:494-497`，无人依赖                                                               |

**结论**：档 A 是"不得动"，档 B 是"首切照抄、长期可删"。**不存在"恰好六种信封永久保留"这回事**——六种是当前的**实测计数**，不是设计目标。

**内部惯性（= 上表档 B 的同一批事实，从"该不该长期保留"角度看）**
首切照抄字节以保行为等价，但不进入长期合同，也不为它们设计任何长期抽象：

- `error` 与 `message` 双载同一句话（`routes/responses.ts:494-497`）。
- `{error:'invalid input', issues: zodIssues}` 把 raw zod issue 上线，无 shared schema、无形状测试。
- `not_addressable` 自注"wire 不可达，只为 service 合同"（`routes/responses.ts:271-282`）。

**已知缺陷（不得复刻）**

- `ActorError` 同名两份不同语义。
- `host_attach_pending` 在三套词汇表各自定义（`host-placement-errors.ts:33`、`workspace-data-plane.ts:61`、`create-agent.ts:110`）。
- `code` vs `error_code` 双字段名，renderer 用 `firstString(parsed,['code','error_code'])` 糊住（`api-error-message.ts:64`）。
- 字符串/结构判类型：`isRepoError` 只查 `typeof err.code === 'string'`（`routes/responses.ts:256-258`）；`err.name === 'BodyLimitError'`（`routes/conversations.ts:960` 等 3 处）；`message.includes('source_message_id')`（`task-repo.ts:529`）。
- 跨层碰撞：`DataPlaneFailureCode` 含 `not_found`/`forbidden`（`workspace-data-plane.ts:75-76`），落进 CLI 稳定枚举被直接采信 → 文件系统 miss 被渲染成 "resource not found"。
- 泄漏：`routes/users.ts:52`、`routes/responses.ts:531` 的 `{error: String(err)}`；`routes/agents.ts:1424` 把 `err.message` 放进 500。
- **无全局 onError → text/plain 500 → CLI 判 retriable=true**（`cli/src/errors.ts:391`）：**真 bug 被告知重试**。见 §11-1。

### 2.5 对 Rust 的结构性结论（不是 trait，是边界）

现状的病不是"缺一个统一错误类型"，而是 **546 个映射点各自决定对外形状**。

终局形态：内部按层保持具体错误（domain 按聚合、application 按 use case、infra 按驱动），**adapter 边界一次单向映射**，映射点收成一处。

**renderer 的组织轴是 endpoint contract，不是信封种类**（rev2 修正）。原因：信封种类是"当前恰好有几种"的实测统计，把它固化成 N 个永久类型会把迁移期基线写进设计；而 endpoint 的对外合同才是真正稳定的归属单位——同一 endpoint 的错误形状要一起演进，跨 endpoint 的形状相同只是巧合。首切要求是"每个 endpoint 的字节与今天一致"，不是"恰好存在六个 renderer"。

按 Cindy gate 2 记录三条禁令：不过早收成万能 `AppError`；不做字符串匹配判错；`anyhow` 不得穿过业务边界，source chain 不得为了日志方便丢弃。

---

## 3. §2 SQLite 连接 / 事务 / 迁移

### 3.1 连接与 pragma

| 项                                                  | 值                                                                         | 证据                                                           | 分类                       |
| --------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------- |
| 构造点                                              | `openDatabase`，`new Database(filepath)`，**无池，一进程一连接，读写共用** | `db.ts:36,41`                                                  | 真合同                     |
| `journal_mode`                                      | WAL                                                                        | `db.ts:45`                                                     | 真合同                     |
| `foreign_keys`                                      | ON 恒开（escape 段 try/finally 复位）                                      | `db.ts:46`、`:279-286`                                         | 真合同                     |
| `busy_timeout`                                      | 迁移期 **0**（fail-fast），runtime `?? 5000`                               | `db.ts:43-44,42,68`                                            | 值=惯性，"迁移期 0"=真合同 |
| `synchronous`/`cache_size`/`mmap_size`/`temp_store` | **从未设置**                                                               | pragma 全部出现点：`db.ts:44,45,46,68,265,279,280,284,285,436` | 惯性                       |
| 第二句柄                                            | `openDatabaseUnmigratedReadOnly`，只读不迁移，仅 pre-migration 探针        | `db.ts:96-98`                                                  | 真合同                     |

**"进程内单句柄"是机械强制的**：`BackendContext` 无 `db` 字段（`context.ts:76-93` 有长篇论证），唯一 spend 点 `persistence/root.ts:217`，gate 在 `tests/db-boundary/`。`docs/db-boundary.md:135` 原文——"that is a compile error, not a ledger row"。

**"单 writer"跨进程不成立且不被假设**：offline admin 另开连接、`busyTimeoutMs:0` + `txMode:'immediate'`，靠锁冲突立刻 `db_locked`（`admin.ts:49-62`）；迁移互斥是 mkdir 目录锁（`db.ts:472-485`）。代码三处明确拒绝把"通常只有一个 writer"当机制（`repos/conversation-persistence.ts:283`、`repos/user-persistence.ts:129`、`services/channel/ports.ts:110`）。

### 3.2 事务边界：UnitOfWork port，模式由 persistence 决定

业务层只调 `atomically(...)`；native `db.transaction(` 只许出现在 persistence surface（`docs/db-boundary.md:120-124`，gate `tests/db-boundary/transaction-boundary.test.ts`，台账 `inventory.ts:358-430`）。route 层零事务。

| 模式                                  | 语义                                                            | 代表证据                                                                                                                                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **immediate + root-only（嵌套即抛）** | 取写锁 = **隔离性**合同，不只是原子性                           | `repos/auth-uow.ts:44-49`、`conversation-persistence.ts:265-275`、`membership-persistence.ts:296`、`user-persistence.ts:134-141`、`agent-teardown-persistence.ts:122-135`、`adapters/runtime-fanout.ts:328-336`（共 7 处） |
| **deferred（允许嵌套 → savepoint）**  | 台账 reason 显式声明"设计为在 service tx 下作为 savepoint 运行" | `repos/message-repo.ts:1386`（台账 `inventory.ts:380`）、`observation-persistence.ts:116`、`agent-provisioning-persistence.ts:121`、`task-persistence.ts:94`                                                               |
| **exclusive**                         | 迁移、inbox 投递状态机                                          | `db.ts:273,297`、`conversation-inbox-repo.ts:188,234,309`                                                                                                                                                                  |

**为什么 root-only 断言存在（这是 Rust 侧最重要的一条）**：better-sqlite3 的嵌套 `.immediate()` 会**静默降级成 SAVEPOINT 且不取写锁**，从而使授权/custody 读失去隔离（合同原文 `runtime/persistence-ports.ts:336-352`）。TS 只能用 7 处运行时 `db.inTransaction` 断言来守。

事务回调**必须同步、不得 `await`**（`persistence-ports.ts:348`）。

### 3.3 必须同一 tx / 只能 post-commit（Cindy gate 4 要求的取证）

合同：事务内只做 DB，副作用收集成闭包、commit 后 drain（`application/post-commit.ts:11-34`）。排序铁律原文（`use-case-layer-p0-spec.md` §2.1）：**"precondition 在前、通知在后；残留要选可自愈的那一侧。"**

| 事实                                       | 时机                                                             | 证据                                                                    | 为什么不能挪                       |
| ------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------- |
| reply_count / threads_list_entry 绝对投影  | **tx 内**（insert 之后）                                         | `services/conversation-message-service.ts:286-305`                      | 必须与写同快照；读侧无一致性读设施 |
| 投递 recipients 枚举                       | **tx 内**                                                        | `:328-331`                                                              | 同上                               |
| L2 seed（member 行的前置）                 | **commit 前**                                                    | `use-case-layer-p0-spec.md` §2.1                                        | 有 member 行但没 L2 = 破坏不变量   |
| WS publish / unread frames / `resolveRun`  | **commit 后**                                                    | `:458,487,493`                                                          | commit 前发 = phantom event        |
| observe 的 DM/badge/notification           | tx 内 push 闭包，tx 外 drain                                     | `application/observe.ts:302,387`                                        | 同上                               |
| mention 行 → badge 顺序                    | commit 后且有序                                                  | `:475-487`                                                              | 顺序是人工维持的一致性手段         |
| daemon purge（外部进程 IO）                | **tx 之间**：tx1 写 intent → 锁外 IO → tx2 CAS complete          | `application/delete-agent.ts:162-164,199`                               | 远程 IO 永不在写锁内               |
| create-agent saga                          | 跨多 tx：L1 reserve → 锁外 materialize → L3a → L3b 补偿在另一 tx | `create-agent.ts:976-989,359,493`；竞态输了不补偿 `:1013-1016`          | 无分布式事务                       |
| blob 物理删除                              | commit 后，best-effort，永不抛                                   | `delete-agent.ts:367-377`                                               | 可自愈的一侧                       |
| 唯一"看似副作用"的豁免 `dispatchToAgent()` | tx 内                                                            | 台账 `inventory.ts:439-447` 声明它是纯 UPDATE（命名误导，挂豁免等改名） | —                                  |

失败补偿：**无回滚**，走补偿 UPDATE + 崩溃后 resumer 续跑（`index.ts:557-585`）；post-commit 单条失败只 warn、其余继续（`post-commit.ts:27-33`）。

### 3.4 迁移

| 项         | 事实                                                                                                 | 证据                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 组织       | **代码里的数组**，不是文件目录：baseline v44 + v45..v87 连续整数，顺序 = 数组顺序                    | `shared/src/db/migrations.ts:50`；`CURRENT_MIGRATION_STEP` `:4065` |
| 形状       | `{version,name,up,foreignKeyEscape?,precondition?}`；**无 `down`，不可回滚**                         | `migrations.ts:23-48`（14 条 escape、10 条 precondition）          |
| 台账       | `_migrations(version,name,applied_at)`；每步一个 **exclusive** tx，precondition+up+ledger 同 tx      | `db.ts:167-173,258-273`                                            |
| 执行       | 启动时自动；门 `allowSchemaUpgrade` 默认 false，standalone 默认 0 / embedded 默认 1                  | `db.ts:48-63,211-219`；`server/src/config.ts:22-24`                |
| 版本双轴   | 内部 step（细，用于比较）+ 对外 epoch（用于报文），epoch 69 / step 69-87 / `released:false`          | `db/schema-epochs.ts:101-108`；`db.ts:371-405`                     |
| 拒绝规则   | too-new、低于 baseline 44、低于支持下限 epoch 44、ledger 非 plan 前缀 → `schema_ledger_inconsistent` | `db.ts:379-397,187-204`；`schema-epochs.ts:153,166`                |
| "回滚"替代 | 迁移前整数据目录拷贝 `<data_dir>-backup-<utc>/`                                                      | `db.ts:222-245,428-448`                                            |
| 硬纪律     | **"Migrations are append-only. Never edit a shipped migration."**                                    | `CLAUDE.md` #6                                                     |

### 3.5 观测与测试 seam

- **命名语句 seam**：`prepareObserved(db, queryName, sql)`，名字须匹配 `/^[a-z][a-z0-9_.-]{1,95}$/`；慢阈值 100ms；outcome 把 busy/locked 单列。`observability/observed-statement.ts:52-70,10,9,269-275`。链式方法返回显式 `ObservedStatement`，"instrumentation cannot escape through `pluck`/`raw`/`expand`/`safeIntegers`/`bind`"（`docs/server-observability.md`）。
- **无 statement 缓存**：repo 每次现场 prepare。`.prepare` 共 231 处，其中 129 走 `prepareObserved` → **遥测覆盖约一半**（缺陷）。
- 测试：`openTestDb()` = 每次全新 `:memory:` + 跑全量 migration（**靠新建库隔离，不靠 tx 回滚**）；`tests/utils/db.ts:37-71`。E2E 通过 `testHooks.onDatabaseOpened` 拿服务器自己那条连接，**禁止开第二条**（`docs/db-boundary.md:71-76`）；并发测试反而故意开 rival writer 且双方 `busyTimeoutMs:0`。故障注入 `tests/utils/tx-fault.ts:21-56`。
- **strict fixture 是真概念**：`seedAllFixtureMemberships:false`；权限测试必须 strict，**不许 mock SQLite**，FK 真开着（`docs/testing.md:128-160,190-198`）。

### 3.6 三分类

**真合同**（rev2 修正：按**保证**书写，不按机制）：一进程一连接 / 一入口 / 一 spend 点；WAL + FK 恒开；迁移步原子 + ledger 必须是 plan 前缀 + append-only；**原子性 + 隔离性义务**（immediate root-only 是当前的实现机制，真正的合同是"授权读→CAS→审计写之间不得有并发写者改变参与关系或 slot 归属"，`runtime/persistence-ports.ts:336-352` 已按此书写）；**tx 内不得有外部副作用**；**post-commit effect 顺序**（precondition 在前、通知在后、残留选可自愈那侧）；远程 IO 永不在写锁内；句柄不在 context 上；`schema_ledger_inconsistent`/`migration_locked`/`db_locked` 错误码；备份目录名模式。

**内部惯性 / 实现形状**：`busy_timeout` 5000、慢阈值 100ms、每次重 prepare、迁移是 4086 行 TS 数组、auth UoW deferred vs admin immediate 的组合期选择、**repo 层与 authz 谓词的同步调用图**（这是 better-sqlite3 同步 API 的产物，不是对外承诺）、**"tx 回调必须同步"这一执行机制**（它是"tx 内无外部副作用"的当前**实施手段**，合同是后者——Rust 侧的实施手段改为 semantic UoW，见 §3.7-2）。

**已知缺陷**：无回滚（"回滚"=目录拷贝，崩溃循环每次留一份）；读侧无任何一致性读设施（read-model 与写共用连接、读不进 tx），一致性靠"写 tx 内算绝对投影 + post-commit 顺序"人工维持；`BackendRepos` 仍暴露具体 SQLite 类（`persistence/root.ts:44-51`），`docs/db-boundary.md` 自陈 "What the capability wall buys is **not** engine independence — it is the precondition for it."；关库不等 in-flight 写（`index.ts:853-859` 自认）；`prepareObserved` 覆盖约一半；测试 fixture 用测试专用 trigger 灌 membership，与生产写路径不同。

### 3.7 对 Rust 的结构性结论

1. **驱动选型不在本任务范围内**。SQLx 已由 #2165 的 vertical slice 跑通（SQLx `0.9.0` + bundled SQLite），本任务**消费**该结论，不另开第二场选型。repo 同步调用图不是目标；"use case 先异步取事实、再同步裁决"能保住纯 policy，这条我同意。

2. **"tx 内不得有外部副作用"——首批答案是 semantic UoW，我原来的候选①是错的（rev3 修正）**。
   背景（关切成立，但不是通用框架问题）：TS 里这条真合同过去靠"tx 回调必须同步"**句法性**兜住——`await fetch(...)` 在同步闭包里写不出来（`runtime/persistence-ports.ts:348`；`db-boundary.md` external-effect 静态扫描建立在此前提上）。
   **首批采用的答案（来自 #2165，更简单且更强）**：application **只调用语义 UoW 方法**，事务完全封在 SQLite adapter 内，application **根本拿不到 generic async tx closure**——没有闭包，就没有"在闭包里捕获 HTTP/daemon/blob capability"这件事。实例：`MessageUnitOfWork` 返回 application fact（`MessageCreatedFact`），不返回 transport DTO；durable payload 与 wire `ServerEvent` 各自从同一 fact 独立投影。**因此首批实现不公开 `atomically(async fn)`。**
   **我原候选①（"tx scope 类型不含 effect capability"）单独不成立**——Cindy 的纠正是对的：Rust closure 可以**捕获**环境里的任何东西，限制 scope **参数**提供什么，并不能阻止闭包捕获一个外部 client。所以它不能单独宣称类型安全。
   **降级为 provisional trigger（不在阶段二做 prototype）**：**触发条件 = 出现一个真实 use case 必须跨多个 repo 做原子编排、semantic UoW 无法表达**。届时就那个 slice 选 restricted tx scope / effect collector / architecture gate 之一，并对"闭包捕获"给出真实答复。

3. **root-only 的表达方式已收口**。#2165 用 SQLx 0.9 `begin_with("BEGIN IMMEDIATE")` 验 writer reservation，并验证 **non-zero depth 明确失败、不降级 savepoint**——TS 侧那 7 处运行时断言所守的坑，在 SQLx 下由驱动本身明确失败。阶段二**直接消费该结论**，设计 SQLite adapter 内部的 **root / deferred 两类能力**，不再自行验证驱动行为。

4. **transaction handle 不得扩散进 domain**（Cindy gate 4）：semantic UoW 形态天然满足——业务层连 tx 对象都见不到。

---

## 3A. §2b SQLite 收敛边界审计（rev2 已降级）

**rev2 范围声明**：shiki 裁定本轮只要求 **SQLite 收敛不外泄**，PostgreSQL **不再是当前扩张理由**。本节保留为**边界审计**——它记录既有 boundary 的资产与负债，用于避免无意倒退；但**不得用 PG 生命周期猜测来塑造本轮 port 形状**。

**本轮唯一的机械 gate**：domain / application 的 **import closure 里没有 SQLite / SQLx / 方言 / driver error**。SQLite adapter **内部**可选最简单正确的形状，不为假想的第二引擎付设计税。

原始合同文本仍是 `docs/db-boundary.md` §"The PostgreSQL seam: what exists, what is missing"（L226-254），自陈定位"**debt control and semantics locking, not migration proof**"（L9-11）。

### 3A.1 已达成的资产（Rust 必须守住，不得倒退）

| #   | 资产                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 证据                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| A1  | 五个 scope；**capability scope 是硬墙、无债务区**；zone 空掉后其 variant **从 TS 类型里删除**，重新加 = 编译错误而非 review 讨论                                                                                                                                                                                                                                                                                                                                                                                       | `db-boundary.md:13-19`                                     |
| A2  | native driver 类型、SQL 文本、`RunResult`/`lastInsertRowid` 只在 adapter（`db.ts`、`observed-statement.ts`）+ `repos/` + `read-model/` + `shared/src/db/`                                                                                                                                                                                                                                                                                                                                                              | `db-boundary.md:23-28`                                     |
| A3  | **application / service port 层对 SQLite concrete type 是干净的（已实测核对）**：`better-sqlite3` 的 import 在 `backend/src` 内只出现于 `db.ts`、`persistence/root.ts:53`、`adapters/unread-publish.ts:9`、`adapters/runtime-fanout.ts:39`。`services/conversation-message/ports.ts:8`、`services/user/ports.ts:5`、`application/membership-ports.ts:4`、`auth/ports.ts:5`、`auth/host-ports.ts:6`、`runtime/persistence-ports.ts:344` 里出现的 "better-sqlite3" **全是注释中声明"本文件不得命名它"**，无一是真 import | 本文自查                                                   |
| A4  | PRAGMA 只在 `db.ts` 出现（10 处：`:44,45,46,68,265,279,280,284,285,436`）                                                                                                                                                                                                                                                                                                                                                                                                                                              | 本文自查                                                   |
| A5  | driver 方言有**两个且仅两个具名权威**：`db-errors.ts`（result code，**前缀匹配本身是合同**，因为 SQLite 就地扩展 result code）+ `repos/sqlite-user-conflicts.ts`（constraint/trigger 文本）。原文 "no third file names a `SQLITE_*` code"，Gate 7 fence 到精确文件集                                                                                                                                                                                                                                                   | `db-errors.ts:1-30`                                        |
| A6  | **tx 模式对应用不可见**：`txMode:'deferred'\|'immediate'` 是 composition-time option，注释原文 "chosen at composition time and **invisible to the application contract**"；应用只见 `atomically(fn)`                                                                                                                                                                                                                                                                                                                   | `repos/auth-uow.ts:13-24,37`                               |
| A7  | **隔离义务已按"保证"而非"机制"书写**（本仓最关键的一条 PG-ready 表述）：原文 "A future pooled/PG adapter must supply an equivalent mechanism (for example SERIALIZABLE, or explicit row/advisory locks covering both participation and runtime-slot identities). **A plain READ COMMITTED transaction is insufficient.**"                                                                                                                                                                                              | `runtime/persistence-ports.ts:336-352`                     |
| A8  | 8 个 driver 能力在生产树**绝对为零**（extension loading、UDF/aggregate/virtual table、whole-db serialize/backup、`unsafeMode`、`defaultSafeIntegers`）。理由原文："engine-level powers no port can express"，且 `defaultSafeIntegers` 会静默改变应用读到的每个整数的类型                                                                                                                                                                                                                                               | `db-boundary.md:283-289`；gate `driver-capability.test.ts` |
| A9  | driver error 的处置规则成文：**在 persistence 边界翻译成 domain outcome**（参考实现 driver text in → `name`/`email`/`user_id` out，**不认识的原样透传**），caller 只对 outcome 分支                                                                                                                                                                                                                                                                                                                                    | `db-boundary.md:291-296`                                   |

### 3A.2 现有泄漏（标为"迁移时应纠正的现状"，Rust 不复刻）

| #   | 泄漏                                                                                                                                                                                                                                                               | 证据                                                                                                                                                                                                                          | Rust 侧处置                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | `BackendRepos` **命名具体 SQLite 类**，`hostTokens` 是具体 bundle                                                                                                                                                                                                  | `persistence/root.ts:44-51`；docblock 自陈 "this is **NOT** a swappable-engine seam yet…What this file buys today is that the CALL SITES stop naming concretes, which is the precondition for that swap, not the swap itself" | persistence bag 只出具名 port，不出具体类型                                                                                                                                                                                     |
| L2  | `conversation-repo` / `message-repo` **不在 Gate 5 concrete-importer allowlist** → 对它们的应用侧约束只有 review 边界，无机械保证                                                                                                                                  | `db-boundary.md:249-252`                                                                                                                                                                                                      | 这是最大的两个 repo；不得把它们留在"review boundary"档                                                                                                                                                                          |
| L3  | `SqliteContention` / `classifySqliteContention` 把**引擎名带进类型词汇**                                                                                                                                                                                           | `db-errors.ts:33,55`                                                                                                                                                                                                          | 引擎名只许存在于 adapter 内部；跨边界只出引擎中立 outcome（`Contention::{Busy,Locked}`）                                                                                                                                        |
| L4  | `db_locked` / `migration_locked` / `schema_ledger_inconsistent` 是 **wire 可见**且编码了 SQLite 的锁模型                                                                                                                                                           | `admin.ts:56-62`、`db.ts:187-204,477`                                                                                                                                                                                         | 这些 code 是 delivery contract（§7-13）**不能改名**；但语义必须重述为"写入被他方持锁拒绝"，与 `SQLITE_BUSY` 解耦，使 PG adapter 在不同并发模型下能产出同一 code                                                                 |
| L5  | 单连接假设被编进 UoW 组装：一个 scope 实例服务所有 tx。自陈原文 "better-sqlite3 is single-connection, so one scope instance can serve every transaction; a pooled engine would construct per-transaction ports bound to the transaction's connection here instead" | `repos/auth-uow.ts:28-30`                                                                                                                                                                                                     | **rev2 降级为审计观察，不是 spike**。理由：SQLx 本身就是池化驱动，它的 transaction API 直接决定 tx-scope 形状——port 从 tx 借用是采用 SQLx 的**自然结果**，不需要为它单独立项验证。记录在此只为说明"TS 侧那条组装期绑定不要照抄" |
| L6  | 约束文本正则，外加**一处未 fence 的字符串判断**：`message.includes('source_message_id')`                                                                                                                                                                           | `repos/sqlite-user-conflicts.ts:29-35`；`repos/task-repo.ts:529`                                                                                                                                                              | 后者是明确缺陷（§2.4），不得复刻。约束冲突走"具名 constraint → domain outcome"的表驱动映射                                                                                                                                      |
| L7  | 迁移 runner 与 plan 同居一个 shared 模块，plan 是 SQL 文本数组                                                                                                                                                                                                     | `shared/src/db/migrations.ts:50`                                                                                                                                                                                              | migration runner 属具体 adapter；plan 的 SQL 是引擎方言，PG 需独立 plan。**不要抽"通用 migration DSL"**——那正是被禁止的最低公分母 wrapper                                                                                       |
| L8  | **无一致性读设施**：读不进 tx，read-model 与写路径共用同一连接                                                                                                                                                                                                     | `read-model/index.ts:66-75`                                                                                                                                                                                                   | 这是 SQLite 单连接的副产品；池化下"反正是同一条连接"这个隐含前提消失 → Rust 必须**显式定义读路径的快照语义**，而不是继承它                                                                                                      |

### 3A.3 结论与判据（rev2 收窄）

现有 boundary 的**资产**是：call site 不命名 concrete + 引擎能力被枚举并归零 + 方言只有两个权威 + 隔离义务按保证书写。**负债**是：bag 仍出具体类（L1）+ 两个最大 repo 只有 review 边界（L2）+ 一处未 fence 的字符串判断（L6）。

**本轮门槛（唯一）**：domain / application 的 import closure 里没有 SQLite / SQLx / 方言 / driver error。A1–A9 作为参考资产保留，L1–L8 作为"不要照抄的现状"记录；**它们都不构成本轮的额外交付要求**。SQLite adapter 内部可选最简单正确形状。

**"不是假通用 wrapper" 的判据（保留，与 PG 无关）**：port 的方法名必须来自**领域动作**（`reserveNextSeq`、`claimTask`、`isParticipantHandleTaken`），不得来自 SQL 动作（`query`、`execute`、`beginTransaction`）。**若一个 port 的签名能原封不动服务任意 schema，它就是伪通用 wrapper，应当删除。** 同理，`atomically(closure)` 传递的是"这段工作必须原子且满足某条隔离义务"，不是"给我一个事务对象"。

**不做**：不实现 PG，不为 PG 预留形状，不把"同一套合同测试对两引擎跑绿"列为本轮 proof point。该 proof point 的定义（`db-boundary.md:252-254`）仅作为将来若重启 PG 议题时的参考。

---

## 4. §3 配置 / Secrets / 可观测性

### 4.1 配置：只有两层 `env > 编译期默认`

无配置文件层、无 CLI flag 层（`server/src/main.ts:19-23` 对任何非 `admin`/`--help` 参数直接 exit 1）。空字符串 = 未设置（`config.ts:139-149`）。`server-config.json`（`shared/src/config.ts:14-38`）**不是 env 的配置源**，是 embedded 运行时状态文件（0600）。

**启动时 fail-fast 的只有 7 个 server env**（`resolveStandaloneServerEnv` 在 mkdir/logger/listener 之前跑，`server/index.ts:123-124`）：`SILVERHAND_LISTEN`（默认 `127.0.0.1:8080`）、`SILVERHAND_DATA_DIR`（默认 `/var/lib/silverhand`）、`SILVERHAND_DISABLE_SIGNUP`、`SILVERHAND_LOG_LEVEL`、`SILVERHAND_MIGRATE`、`SILVERHAND_METRICS_LISTEN`（仅 loopback）、`SILVERHAND_EVENT_WS_ALLOWED_ORIGINS`。全部**手写 parser，无 zod**。metrics listener 先于公共 listener 绑定（`index.ts:173-181`，注释给了理由）。

启动打一行 `silverhand-server config resolved`，每项带 `source: 'default'|'env'`（`server/index.ts:133-166`）—— **这是"来源可审计"的对外承诺**。

**其余 env 是散落懒读、未文档化、非法值静默回退**（缺陷）：`SILVERHAND_AUTH_SESSION_TTL_DAYS`（`auth/config.ts:11`）、5 个 `SILVERHAND_PASSWORD_HASH_*`（`auth/password.ts:152,230-239`）、`SILVERHAND_MATERIALIZE_RECONCILE_THRESHOLD_MS`（`materialize-reconciler.ts:66-111`，**刻意 fail-soft**）、`SILVERHAND_DAEMON_NPM_SPEC`（`routes/hosts.ts:1101`，**每请求读**）。另：`SILVERHAND_LOG_LEVEL` 默认值分裂（standalone `info` vs embedded/CLI `warn`，`config.ts:20` vs `shared/logging.ts:6`），文档只写 `info`。

### 4.2 路径权威

唯一权威 = `shared/src/app-data-layout.ts:11-21`（自称 "the ONE app-data path authority"，纯函数、无 FS 探测、无 fallback）。`resolveServerDataPaths(dataRoot)` 决定 `silverhand.db`(+wal/shm)、`blobs/`、`server-config.json`、`logs/`（`:281-294`）。`startBackend` 不再收 root，只收 `dbPath` + `blobsRootDir` + `embeddedBootstrapPath`（`:341-352`）。合同文本 `docs/app-data-layout-v2.md` §3，guard 实测 `packages/host/tests/app-data-path-authority-guard.test.ts:359`。

**backend 侧刻意无 path 权威**：`runtime/workspace-data-plane.ts:32` + `backend/tests/dependency-guard-no-agent-host-fs.test.ts`。host 侧 runtime 权威是 `host/src/daemon/agent-materialize/handler.ts:143-145`（workspace-registry 已不是 path 权威）。

### 4.3 Secrets

| secret                                     | 存储                                                                                                                                             | 轮换                                                                                            | 分类                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| user session token                         | `randomBytes(32).base64url`，**DB 只存 sha256**                                                                                                  | TTL + revoke                                                                                    | 真合同                                                   |
| host token                                 | 同上；明文副本在 daemon `daemon-config.json`（0600）                                                                                             | **`rotate_token` + 60s grace**（`ws/host-token-rotation.ts:53-70`，10s timeout）                | 真合同                                                   |
| agent token                                | **仅进程内存 Map，从不落盘**（`auth/agent-token-store.ts:22-49`）                                                                                | 随进程                                                                                          | 真合同                                                   |
| embedded bootstrap token                   | 0600 文件（atomic `wx`），内存只留 hash，`timingSafeEqual`，一次性 unlink                                                                        | one-shot                                                                                        | 真合同                                                   |
| password                                   | argon2id，参数随 hash 存；**DB 里存了 `library:'@node-rs/argon2'` 并断言**（`auth/credential-types.ts:17`、`repos/auth-credentials-repo.ts:74`） | admin CLI reset；**`--password` 刻意不支持**，只有 `--password-from-file`（要求 0600 + unlink） | 真合同（含 library 断言 → 换 crate 需 migration 或放宽） |
| desktop `server-profile.bin`/`session.bin` | **0600 明文**，注释明说 V1 故意                                                                                                                  | —                                                                                               | 已文档化的 V1 限制                                       |

**无 keychain / safeStorage**（全仓零命中）。

脱敏 = `FORBIDDEN_LOG_FIELDS`（`shared/src/logging.ts:10-23`）：`payload,chunk,body,text,prompt,line,env,stdout,stderr,soft_directive` + 前缀 `env_`，每行 write 时递归剔除并加 `redactedFieldCount`（`backend/logger.ts:225,231`）。daemon 侧升级为**编译期字段白名单**（`host/src/daemon/daemon-logging.ts:1-52`）。用户可见地址一律 hash（`observability/delivery-target-log.ts:52-56`）。

**缺陷**：该清单**只覆盖内容隐私，不含 `token`/`password`/`secret`/`authorization`**——backend 侧靠人工纪律，且无 fence 测试。

### 4.4 日志

JSONL 一行一 JSON：`{ts,level,msg,...base,...fields}`，`base={pid,app}`（`backend/logger.ts:59-68,232-238,76`）。**三 sink，每次 boot 一个新文件**：`backend-<utc>.log`/`agent-<utc>.log`/`cli-<utc>.log`（`logger.ts:89-137`），同时写 stdout（`:241-244`）。**进程内无轮转**——外部 `logrotate` + `copytruncate`（`ops/observability/logrotate-silverhand`）→ **文件名模式是运维合同**。

两个逃生门：`alwaysWriteCategories`（`logger.ts:139-167`：`cli.invoke`、`cli.preflight_failure`、`event_ws.*`、`agent_audit.*` 无视 level）、per-`conversationId` debug 窗口（`:279-284`）。

真实事件：`routes.ts:199-207` `api: request start`、`:241-253` `api: slow request`、`observed-statement.ts:243-256` `db: slow statement`、`runtime/host-status-read-model.ts:262-270` `seed_exhausted`、`ws/ws-server.ts:184-215` `desktop_client_connected`（含 `admission_epoch`）。

**缺陷**：字段大小写混用——`routes.ts:201` 用 `requestId/elapsedMs`（camel），`cli-invoke-middleware.ts:88-101` 用 `request_id/http_status/duration_ms`（snake），新家族显式规定 snake + `<family>_event`（`workspace-address-log.ts:24,63`）。

### 4.5 Metrics 与 request 上下文

`prom-client` 自建 Registry，**仅当 `SILVERHAND_METRICS_LISTEN` 设置时才实例化**（`server/index.ts:167-169`）→ **embedded 完全无 metrics**（缺陷：桌面端观测只有日志）。7 个自定义指标 + default + ELU gauge（`observability/metrics.ts:44-115`）。

**基数禁令是硬合同**（`docs/server-observability.md:27-28`）："Metrics never use raw URL paths, host/user/agent/conversation ids, SQL text, or SQL parameters as labels." 强制手段：route 归一化未匹配落 `unmatched`（`routes.ts:261-264`）、close code 白名单折叠（`metrics.ts:218-229`）、`query_name` 正则校验（`observed-statement.ts:10,262`）。

**"缺席 = 未观测 = fail closed"**：未迁移的 repository "are **not silently reported under an `unknown` query label`"（`server-observability.md:23-25`）——宁可缺席也不伪造标签。配套 `freshness-boundary-authority-v1.md`§3.2/§6.3：一次拒绝恰好一条 WARN，且"The row's own write path logs NOTHING…A log after the insert would also be a lie on the two arms where the insert silently does not happen"。上升为语义规则见`architecture-principles.md` §12.2#4："**absence / stale 并非中性状态，而是一个被默认选中的语义，必须在读边界显式定义**"。

**request 上下文**：`AsyncLocalStorage`，载荷只有 `{requestId, method}`（`observability/request-context.ts:3-19`）；唯一注入点 `routes.ts:208-210`，唯一读取点 `observed-statement.ts:243-251`。`requestId` 是进程内单调计数 `api-<N>`（`:266-269`）——不是 UUID、不跨进程唯一、**不从请求头继承**。viewer/principal **不在** ALS，靠显式参数。CLI 面另起 `randomUUID`（`cli-invoke-middleware.ts:61-65`），daemon 命令用 frame id（`host-ws-server.ts:865`）——**三套 id 命名空间互不关联，无 span 传播**（缺陷）。

### 4.6 三分类摘要

**真合同**：7 个 server env 的名字/默认/校验语义 + fail-before-listen 顺序；`config resolved` 行带 `source`；`SILVERHAND_DATA_DIR` 单一状态单元布局与备份目录名；`/api/health`=liveness、`/readyz`=readiness+per-check 布尔；metrics 仅 loopback + `GET /metrics` + 指标名/label 集 + 基数禁令；JSONL 三 sink 的**文件名模式**（logrotate 依赖）与 `{ts,level,msg}` 骨架；always-write audit category；`FORBIDDEN_LOG_FIELDS`；token 只存 sha256；host token rotate + 60s grace；`--password` 不存在。

**内部惯性**：`ResolvedValue<T>` 形状、`api-<N>` 计数式 request id、ALS 只装两字段、`kind`/`action`/`category` 三种事件标记混用、`msg` 的 `"area: …"` 文风、每 boot 新文件、`prom-client` 具体实现。

**已知缺陷**：6 类 env 散落且未文档化、非法值静默回退；`SILVERHAND_LOG_LEVEL` 默认值分裂；日志字段大小写混用；禁记清单不含 `token`/`password`/`secret` 且 backend 无 fence 测试；embedded 无 metrics；无 trace/span 关联（HTTP→SQL 只靠进程内 requestId，HTTP→daemon/CLI 断链）。

### 4.7 对 Rust 的结构性结论

1. **logger/metrics 不抽 DI trait**（认同 Cindy gate 3）。真合同是**输出格式**（文件名模式、JSONL 骨架、指标名/label 集、基数禁令），不是注入形状。`tracing` + 一个满足输出合同的 subscriber layer 即可，测试直接断言输出。
2. **脱敏应从"字段名黑名单"升级为"类型不可表达"**。TS 的 `FORBIDDEN_LOG_FIELDS` 是运行时黑名单，且漏掉 token/password；Rust 侧按 Cindy 硬门：**secret 类型不得派生/暴露 `Debug` 或普通 `Serialize`**，日志字段结构化脱敏。这样"secret 进日志"从"靠纪律"变成"编译不过"。同时必须保留现有 `FORBIDDEN_LOG_FIELDS` 的内容隐私语义（那是独立的一层：非 secret 但不得记录的业务内容）。
3. **clock / id 按触达它的 slice 传最小具体 capability 或函数**，不由注入点数量推出全局抽象。现状证据在 §5.3；判据在 §5.7。

---

## 5. §4 Ports / DI / clock / id / 取消 / backpressure

### 5.1 已有 port/adapter（`adapters/` 目录名误导：里面是 DB 组装，不是外部依赖 adapter）

| 抽什么                         | 接口要点                                                                                                                                                                                            | 证据                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **文件系统** blob 存储         | `kind/put/serve(→web Response)/locate/delete/materializeAlias/deleteAlias`                                                                                                                          | `storage/blob-file-storage.ts:24-48`               |
| **server→daemon 帧传输**       | `activeConnectionCount/connectedHostIds/connectionIdForHost/getAttachment/sendCommand<K>(hostId,kind,params,{timeoutMs,expectedConnectionId})/close`；三实现 Standalone(WSS)/Composite/EmbeddedUnix | `runtime/outbound-frame-adapter.ts:44-96,122,177`  |
| **agent runtime 生命周期门面** | `start/stop/clearSession/stopAll/reapIdleRuntimes/deliverMessage/deliverPending/reconcileOnBoot/getAgentRunStates/resolveRun`                                                                       | `runtime/agent-runtime-host.ts:187`                |
| WS（human 客户端）             | `installEventWebSocketServer(server,ctx,opts)`                                                                                                                                                      | `ws/ws-server.ts:28`                               |
| in-process pub/sub             | `ScopeEventBus.publish/publishToScope/subscribeScope/replay/currentSeq`                                                                                                                             | `ws/scope-event-bus.ts:88`                         |
| 授权只读面                     | `AuthorizationReadPort` 18 方法，**全返回 `Pick<DTO>`/bool/id[]，无一返回 repo DTO**                                                                                                                | `authorization-ports.ts:98-161`（Gate 8 保其私有） |
| runtime 持久化 ports           | 10+ facet，driver-free                                                                                                                                                                              | `runtime/persistence-ports.ts:114-286`             |

全库 13 个 `*ports.ts`、约 50 个 `*Port`。**进程 spawn 完全不在 backend**（唯一 `child_process` 是 PATH 探测 `index.ts:6,1162`）；**backend 内 0 处 `fetch`**。

### 5.2 DI 现状

`BackendContext`（`context.ts:94`）= 每进程 capability bag，已刻意剔除 db handle。但仍是 **service-locator 形态**：58 文件引用、**115 处 `ctx: BackendContext` 形参**。services 本身是干净的构造函数注入 dep bag。组装根 `index.ts`：60 import、33 处 `new X(`，含 **4 处 `undefined as unknown as XService` 占位后赋值**（`:503-508,551`）+ 5 个 thunk late-binding（`:544,548,595`）—— TS 循环依赖逃逸口，属惯性，Rust 侧需显式决策（两阶段 builder / `OnceCell`）。

### 5.3 clock / id / random

| 项     | 事实                                                                                                                                                                                                                                                                                                                                              | 分类                                                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| clock  | **无全局 port**。`Date.now()` **131 处 / 52 文件**；注入点是零散 opt-in `now?: () => number`（`presence-registry.ts:31`、`agent-activity-sink.ts:32`、`delivery-coordinator.ts:378`、`materialize-reconciler.ts:131`、`runtime-fanout.ts:150,406`）+ `now?: number` 参数式（`host-token.ts:180`、`agent-runtime-host.ts:92`、`host-repo.ts:298`） | 惯性（半 seam）。**注入点数量不推出任何结论**：它只说明少数构件的测试需要控时间。Rust 侧按触达它的 slice 传最小具体 capability/函数，**不建全局 `Clock` 抽象**（§5.7） |
| id     | **无 port**。惯例 `randomBytes(12).base64url`（16 字符），**14 份各 repo 私有 `newId()` 复制**；token `randomBytes(32)`；`randomUUID()` 53 处                                                                                                                                                                                                     | **16 字符 base64url 格式是真合同**（地址语法依赖 `shared/src/delivery-target.ts:149-151`）；生成方式是惯性                                                             |
| random | `Math.random` **0 处**                                                                                                                                                                                                                                                                                                                            | 真合同（拒绝非密码学随机）                                                                                                                                             |

**seq 语义（`docs/brand-typed-seq-v1.md`，Rust 类型设计的直接输入）**：文档自称 ubiquitous-language 权威——"**When code conflicts with a name/semantic here, the code is the bug.**"

- 两条**真正独立**的 ordinal space：`MessageSeq`（DB `messages.seq`，`reserveNextSeq` 推进 `conversations.latest_message_seq`，**conversation-global**、持久、跨重启存活）与 `TransportSeq`（per-WS-scope 内存计数，**重启归零**）。**硬墙**："MessageSeq and TransportSeq never legitimately convert. A `TransportSeq → MessageSeq` flow is _always_ a bug."
- cursor 家族（`StreamHeadSeq`/`DeliverySeq`/`ReadSeq`）都只是"处于某角色的 MessageSeq"，**只有 `ReadSeq` 被 brand**（有唯一 mint boundary）。`TransportEpoch` 是 **string**（UUID），不是 number。
- raw number → brand 只有两条路：origin mint（各一个 authority）、反序列化边界的 validated decoder（"never a bare `as`"）。wire seq **必须服务端 mint/decode**。
- brand **不覆盖** stream-key mismatch（stream identity `(conversation_id, thread_root_id)` 是独立坐标）；也不覆盖 optionality collapse——规则是"no _unclassified_ `?? 0`"，每个 `?? 0` 必须归属 role accessor（`StreamHeadSeq` 空 stream 的 CAS token **就是 0**，"Do **not** 'fix' `message-repo.ts:1182`"）。
- 禁令：**`Date.now() as MessageSeq` banned**（pending message 走 `PendingMessage` + `tempId` + `createdAtLocal`，**不带 seq**）。

### 5.4 取消 / 超时 / backpressure（大量"不存在"）

| 项                                 | 事实                                                                                                                                                                                                                                                                                                                                                          | 分类                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| **入站 HTTP 超时**                 | **不存在**。`serve({fetch,hostname,port})`（`index.ts:754-755`）无 timeout；全仓 0 处 `requestTimeout`/`headersTimeout`/`server.timeout`/`hono/timeout`（已自查复核）                                                                                                                                                                                         | 缺陷                 |
| 出站 server→daemon 超时            | **存在且分级**：默认 30s（`ws/host-ws-server.ts:267`），具名覆盖 host-status 10s / proxy-config 10s / runtime-catalog 45s / data-plane 30s / purge 60s / mcp-probe 45s / materialize 60s / `runtime_exit` 投影 10s                                                                                                                                            | 真合同               |
| **取消原语**                       | **不存在**。backend 内 `AbortController`/`AbortSignal` **0 处**（已自查复核）。client 断开不中止任何工作                                                                                                                                                                                                                                                      | 缺陷                 |
| agent 运行"取消"                   | 不是取消，是 **kill 进程且在 daemon**：SIGTERM → 5s → SIGKILL（`host/src/daemon/supervisor/index.ts:136-141`）；backend 只发命令                                                                                                                                                                                                                              | 真合同（plane 分离） |
| 文件上传                           | **不可取消**，且 `Buffer.from(await file.arrayBuffer())` 全量进内存，**10MB 上限在 buffer 之后才查**（`routes/attachment-upload.ts:31,84`；`attachment-service.ts:29,135,232`）；预检只有 hono `bodyLimit`                                                                                                                                                    | 缺陷                 |
| 迁移                               | 不可取消，刻意 fail-fast（`busy_timeout=0`）                                                                                                                                                                                                                                                                                                                  | 真合同               |
| **backend→浏览器 WS backpressure** | **不存在**。`send()` 只查 `readyState !== OPEN` 然后 `ws.send(JSON.stringify(frame))`（`ws-connection.ts:362-385`）——不看 `bufferedAmount`（backend 内 0 命中，已自查复核）、无缓冲上界、不丢、不断连 → 慢客户端 = **无界堆增长**。已有的界只是入站 `maxPayload` 64KB、ping 30s/pong 5s → close 1008、per-scope ReplayBuffer 固定 200 条、shutdown 1.5s grace | 缺陷                 |
| **daemon→server backpressure**     | **存在且成文**：`OutboundWriteBuffer` **1024 帧 / 4MiB**，`runtime_output` 是**唯一可丢** kind，其他 kind 溢出返回 `'overflow'` 且调用方**必须关连接**（`host/src/daemon/outbound-write-buffer.ts:35-38,104-149`）；WSS 与 Unix socket 共用                                                                                                                   | 真合同               |
| 外部进程 stdin                     | 有 drain 等待（`supervisor/index.ts:4201-4217`）                                                                                                                                                                                                                                                                                                              | 真合同               |
| 外部进程 stdout                    | **无界 `on('data')` 累积**（`:3418-3427`），压力靠丢 `runtime_output` 释放                                                                                                                                                                                                                                                                                    | 缺陷（有缓解）       |

### 5.5 测试 seam

主 seam 是 **fixture factory，不是 mock 框架**。`buildTestApp()` 在进程内组装**真 Hono app + 真 repos + 真 services**，**唯一替换的依赖是 `AgentRuntimeHost` → `FakeConversationManager`**（显式 `implements`，接口加方法即 typecheck fail，不能 `as unknown as` 绕）。E2E 起真 `startBackend({mode:'standalone'})` + 真 daemon（`e2e/g2-harness.ts:10-22`）。

额外一层**机械化架构闸门**（非普通测试）：`tests/db-boundary/` 14 gate（import-ratchet、port-contract、private-port、transaction-boundary、sql-hazards、zone-surface、driver-capability——**8 个 driver 能力在生产树里绝对为零**）+ `dependency-guard-*` + 10 个 `guard-*`。

**直接约束 Rust 的一条**：`docs/testing.md:202` —— "任何要替换当前 TypeScript daemon 的实现（**含未来的 Rust daemon**）**必须先通过 driver-oracle 回归**才算 parity"，契约本体 `packages/host/tests/_fixtures/driver-oracles.ts`；"schema 权威仍是 `packages/host/src/protocol.ts`（zod），**不切二进制 framing**"。另有 `packages/host/tests/fixtures/wire/README.md:16-27`：104KB 字面 NDJSON 字节夹具，明确为"future re-implementations (**Rust daemon**, remote host agent)"准备的 zod-independent 验收门。

### 5.6 运行时依赖与可替换性

| 依赖                              | 用途                                                                         | 判断                                                                                                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **better-sqlite3** ^12            | 唯一 driver，**同步 API**，`transaction().immediate()` 取 writer reservation | 最深嵌入。同步调用图是**实现形状**，不是合同；驱动已由 #2165 定为 SQLx。需要看护的是事务义务（原子性/隔离性/root-only）与"tx 内不得外部副作用"——后者在 Rust 侧由 **semantic UoW** 实施（§3.7-2）。已有 import-ratchet 把 driver 锁在 `db.ts` 一处 |
| **hono** ^4 + `@hono/node-server` | 路由、`bodyLimit`、web `Response`                                            | 中等。但 `BlobFileStorage.serve()` 返回 web `Response`（`blob-file-storage.ts:27`）**把 HTTP 类型漏进 storage port** → Rust 侧必须切断                                                                                                            |
| **ws** ^8                         | 两个 WS server 共用同一 http server 的 upgrade                               | 中等偏深；`maxPayload`/close code/`terminate()` 语义在用                                                                                                                                                                                          |
| **@node-rs/argon2** ^2            | 密码 hash                                                                    | 浅但**有持久化耦合**（DB 存 `library` 字面量并断言）                                                                                                                                                                                              |
| **cron-parser** ^4                | 严格 5 字段 cron + 时区（拒 alias、Luxon 时区）                              | 浅偏中；用现有测试固定语义                                                                                                                                                                                                                        |
| **prom-client** ^15               | 可选 metrics listener                                                        | 浅                                                                                                                                                                                                                                                |
| **zod** ^3                        | **backend/src 0 处**，schema 全在 shared                                     | 属跨语言合同层，见 §6                                                                                                                                                                                                                             |

**backend 没有的**：HTTP client、S3/OSS SDK（`StorageKind` 预留 `'s3'|'oss'` 但只实现 local）、job queue、redis、ORM。

### 5.7 对 Rust 的结构性结论（rev2 重写判据）

rev1 用的是"没有第二实现或测试替身就不抽"，那是把一条**强启发式**当成了唯一合法性来源，并且我自己套用得不一致（`BlobStorage` 因只有 local 实现被判不抽，clock 却因 9 个注入点被判要抽）。改用三判据：

**判据（满足其一 → 需要一条边界）**

1. **跨层所有权**：这个能力属于另一层，业务代码不该拥有它。
2. **必须隔离的副作用**：它会碰进程外的世界（fs / 网络 / 子进程 / 时钟），必须被显式隔离才能推理。
3. **已证可替换或可测**：已有第二实现，或测试必须替换它。

**第二步才选语言形状**，且**不默认 Trait**：具体类型 / 自由函数 / capability struct / trait object，取最小的那个。Trait 只在需要**运行时多态**或**测试替换**时才用。

| 候选                          | 满足判据                            | 需要边界            | 最小语言形状                                                              | 说明                                                                                                                                                                                                              |
| ----------------------------- | ----------------------------------- | ------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite tx / UnitOfWork        | 1 + 2 + 3                           | 是                  | **semantic UoW 方法**（业务侧不见 tx 对象，也不见 generic async closure） | 跨层所有权是核心：业务只声明原子性与隔离义务。root / deferred 是 **SQLite adapter 私有能力**，不进任何 repo/use-case 签名                                                                                         |
| 外部 runtime / host transport | 1 + 2 + 3                           | 是                  | **trait**（真需运行时多态）                                               | `OutboundFrameAdapter` 已有三实现（Standalone / Composite / EmbeddedUnix）——三实现是硬举证                                                                                                                        |
| **blob storage**              | **1 + 2**                           | **是（rev2 改判）** | trait 或具体类型均可，取决于是否需运行时切换                              | 这是真实的 domain↔存储边界，**与实现个数无关**：业务不该依赖具体 FS。独立证据：现状 `serve()` 返回 web `Response`（`storage/blob-file-storage.ts:27`）——HTTP 类型已经漏进存储抽象，正说明这条边界失守时会发生什么 |
| **clock**                     | **3（仅此一条，且很窄）**           | 是（窄）            | **按触达它的 slice 传最小具体 capability / 函数；不建全局 `Clock` trait** | 判据只支撑"少数构件的测试需要控时间"，不支撑一个进程级时间抽象。注入点数量不是论据                                                                                                                                |
| id 生成                       | 3                                   | 是（窄）            | 具体函数 + 测试可注入的 seed/序列                                         | 测试须可预测（`docs/testing.md:196` 要求避免依赖 random id 字典序）。**16 字符 base64url 格式是合同**，生成方式不是                                                                                               |
| logger / metrics              | 2（但已被 process capability 覆盖） | 否                  | `tracing` + 满足输出合同的 subscriber layer                               | 真合同是**输出格式**，不是注入形状。不造镜像接口（§4.7-1）                                                                                                                                                        |
| cancellation                  | 2（语言已提供）                     | 否                  | tokio `CancellationToken`                                                 | 不建 port；但须显式决定 client 断开语义（§11-2）                                                                                                                                                                  |
| config                        | 1                                   | 是（窄）            | 启动期解析出的不可变具体类型                                              | 一次性 fail-fast 解析，之后只读；无需 trait                                                                                                                                                                       |
| secret                        | 1 + 2                               | 是                  | **具体 newtype**（不派生 `Debug` / 普通 `Serialize`）                     | 见 §4.7-2。这是类型能力，不是 DI 边界                                                                                                                                                                             |

---

## 6. §5 `packages/shared` ownership 与触发式 backlog

### 6.0 目标（shiki 已收敛）

允许稳定、单向的合同耦合；**不要求先拆干净 shared**；矩阵用于识别高风险泄漏，不是拆包清单。硬门只有四条：

1. **wire 单一权威**
2. **domain/DB 内部不泄漏**
3. **无 build cycle**
4. **runtime validation 保持**

### 6.1 现状事实

`packages/shared/package.json` 有 11 个 export 入口，但**实测 631 次 `from '@silverhand/shared'` vs 22 次 subpath → 96.7% 走 root barrel**。`src/index.ts`（47 行）`export *` **41 个模块**，传递可达 **1168 个符号**。

`./db/migrations`、`./db/baseline-schema`、`./db/schema-epochs`、`./reference-markdown`、`./app-data-layout` 是**已被刻意排除出 barrel**的——但 `index.ts:1-6` 的注释说理由是 Node-globals/parser 重量，**不是 ownership**。所以：**export map 里没有编码任何 ownership 边界**。

### 6.2 矩阵（要求的列；按 ownership 分组，只展开高风险行）

列定义：owner / consumers（B=backend, S=server, C=cli, H=host, DM=desktop-main, DR=desktop-renderer）/ runtime validation / generated-or-handwritten / migration destination。

**A. 高风险泄漏（硬门 2 的直接违反）**

| 模块                                                      | owner  | consumers                                                                                                      | runtime validation     | gen/hand                    | destination     | 泄漏证据                                                                                                                                                                                                                                  |
| --------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db/schema.ts` **Row 半**（28 个 `*Row`，L238-885）       | db     | **B only**（24 用，4 死：`TaskRow`/`AgentInboxRow`/`ConversationStreamHeadRow`/`WorkspaceAgentCapabilityRow`） | **无**（裸 interface） | hand                        | `rust-internal` | **`index.ts:11 export * from './db/schema.js'`** → `HostRow`(`:238`)、`UserRow`(`:347`)、`UserPasswordCredentialRow`(`:367`)、`AuthSessionRow`(`:375`)、`MessageRow`(`:643`)、`HostCredentialRow`(`:269`) 对 renderer/CLI/daemon 全部可见 |
| `db/migrations.ts`（4086 行 SQL DDL）                     | db     | **B only**（23）                                                                                               | 无                     | hand                        | `rust-internal` | `:50`；`:1 import { randomBytes } from 'node:crypto'`                                                                                                                                                                                     |
| `db/baseline-schema.ts`（645 行 CREATE TABLE）            | db     | **B only**（4）                                                                                                | 无                     | **generated（已不可再生）** | `rust-internal` | `:1-5`、`:9`                                                                                                                                                                                                                              |
| `db/schema-epochs.ts`                                     | db     | **B only**（13）                                                                                               | 纯逻辑                 | hand                        | `rust-internal` | `:101,232,298,369`                                                                                                                                                                                                                        |
| `conversation-title-audit.ts` / `workspace-name-audit.ts` | db     | **B only**（7 / 5）                                                                                            | 纯逻辑                 | hand                        | `rust-internal` | 后者 `:7` 直接导出 `WorkspaceNameAuditRow`（row 形状）                                                                                                                                                                                    |
| `handle.ts`                                               | domain | **B only**（2）                                                                                                | zod                    | hand                        | `rust-internal` | —                                                                                                                                                                                                                                         |

**B. 已是（或应是）跨语言 wire 合同**

| 组                                                                                                                                                                                                   | owner                          | runtime validation                                                                                  | destination                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `api/` 30 文件（每文件一个 bounded context，自带 `// AUTO-SPLIT … Bounded context:` 声明）                                                                                                           | wire                           | **zod**（除 `paths.ts`/`avatar.ts`/`principal-header.ts` 为纯数据/纯逻辑）                          | `wire-contract`                                                                                     |
| `db/schema.ts` **enum 半**（约 49 导出：`RuntimeKind`/`TaskStatus`/`ConversationStatus`/`AGENT_CAPABILITIES`/`ReasoningEffortToken`/`NotificationKind`…；B 170, DR 64, H 18）                        | domain                         | **zod**                                                                                             | `wire-contract`                                                                                     |
| `seq.ts`（brand 类型）                                                                                                                                                                               | wire                           | zod（4 schema + brand）                                                                             | `wire-contract`                                                                                     |
| `ws-frames.ts`                                                                                                                                                                                       | wire                           | **无 zod**（11 个 frame 全裸 interface：`ClientFrame:81`、`ServerFrame:170`），被 DR 31 + B 26 消费 | `wire-contract`（**现状无 runtime validation，非本轮硬门**——硬门 4 只禁"丢失既有"校验；见 §6.4-T2） |
| `api/paths.ts`（682 行裸字符串路由表，129 处 import，跨全部 6 消费者）                                                                                                                               | wire                           | **无**、无版本标签                                                                                  | `wire-contract`（需 parity oracle）                                                                 |
| `protocol-versions.ts`（5 数字唯一写点）                                                                                                                                                             | wire                           | 纯 `as const`                                                                                       | `wire-contract`                                                                                     |
| `desktop-server-api-epoch.ts`、`client-telemetry.ts`、`system-messages.ts`、`chat-limits.ts`、`runtime-catalog.ts`、`agent-home-workspace.ts`、`runtime-delivery-presentation.ts`、`driver/index.ts` | wire / domain / runtime-driver | 多数 zod（`driver/index.ts` 32 处，两端都校验）                                                     | `wire-contract`                                                                                     |

**C. TS-only（backend 不 import，Rust 不碰）**：`locator.ts`(DR 12)、`server-url.ts`(DM 11)、`tls-policy.ts`(DM 4)、`server-connection-profile.ts`(DM 14)、`host-diagnostics.ts`(DR 4)、`opencode-config.ts`(H 3)、`proxy-env.ts`(H 1)、`connect-command.ts`(H 14)、`cli-command-manifest.ts`、`platform-prompt.ts`、`mcp-config.ts`、`api/message-reference.ts`(H 1)。

**D. duplicate-both（两侧各自实现 + 测试/夹具保持一致）**：`delivery-target.ts`(683 行地址语法，B 26/C 22)、`conversation-title.ts`(B 69)、`workspace-name.ts`(B 63)、`reference.ts`、`reference-markdown.ts`、`address-segment.ts`、`display-name-charset.ts`、`mime.ts`、`delivery-reach.ts`、`logging.ts`、`markdown-escape.ts`、`app-data-layout.ts`、`config.ts`、两张 generated Unicode 表（`unicode-case-fold.ts` v16.0.0、`unicode-name-charset.ts`）。

**E. 结构性耦合事实（不是缺陷，但决定改造顺序）**：`api/` 的 DTO **依赖 `db/schema` 的 enum**——`api/host.ts:4-8`、`api/agent.ts:5-10`、`api/attachment.ts:4-8`、`api/message.ts:4-7`、`api/task.ts:4-8`、`api/workspace.ts:4-6`、`api/notification.ts:4-6`、`api/runtime.ts:4-6`、`api/message-author.ts:7`。即 **wire 层无法在不带上 enum 半的情况下抬升**。

### 6.3 已有 codegen（三处，都不跨语言）

`scripts/generate-case-fold-table.py` → `unicode-case-fold.ts:1`；`scripts/generate-name-charset-table.py` → `unicode-name-charset.ts:1`；`db/baseline-schema.ts:1-5`（一次性 replay v1..v44，header 声明已不可再生）。drift **guard**（非 generator）：`shared/tests/api-export-drift.test.ts` + `api-barrel-export-snapshot.json`（384 符号金账）、`backend/tests/migration-baseline.test.ts`。**全仓无 OpenAPI、无 `zod-to-json-schema`、无 `ts-rs`/`typeshare`/`schemars`。**

### 6.4 Triggered backlog（rev2：不是阶段二默认范围）

rev1 把三项清理写成"最小改造"，实际上会变成 infra 的前置工程。改为**触发式 backlog**——每条只在触发条件成立时才做，且都**不属于**本任务阶段二的默认范围。

先纠正我 rev1 的一处误读：**硬门 4"runtime validation 保持"= 不得丢失既有校验**。`ws-frames.ts` 本来就没有 zod，所以它**不构成对硬门 4 的违反**；据此强推补 schema 是过度解读。它仍然是一个真实的观测（无运行时校验的 wire 面），但属于独立的质量议题，不是本轮门槛。

| #   | 待办                                                                                                                                                                          | 触发条件                                                                                                               | 归属                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| T1  | `db/schema.ts` 切两半：enum/zod 半留 barrel，28 个 `*Row` 半移出 barrel，删 4 个死 Row（`TaskRow`/`AgentInboxRow`/`ConversationStreamHeadRow`/`WorkspaceAgentCapabilityRow`） | **真实 Rust slice 触达该数据面时**（即某个被 Rust 接管的聚合，其 Row 类型仍从 barrel 泄漏）。不为清理本身立项          | 届时由触达该聚合的 slice owner 承担 |
| T2  | `ws-frames.ts` 补运行时校验                                                                                                                                                   | **仅当**跨语言 parity 需要一个 schema-based oracle，且 NDJSON 字节夹具不足以覆盖 event-WS 面时                         | wire lane（非 infra）               |
| T3  | `api/paths.ts` parity artifact                                                                                                                                                | **需先与 Toby 的 manifest 统一**——是否首切、artifact 形状、谁生成，都归 wire/composition lane 决定；infra 不单方面开工 | 与 Toby 对齐后定                    |

`db/migrations.ts` / `baseline-schema.ts` / `schema-epochs.ts` 已不在 barrel，不动，destination 记为 `rust-internal`（将来随 DB 接管迁移）。

**infra 在 shared 上的唯一立场**（不扩张）：四条硬门作为**负向检查**存在——wire 单一权威、domain/DB 内部不泄漏、无 build cycle、runtime validation 不丢。矩阵是这四条检查的证据底座，不是改造工单。

---

## 7. §6 Composition 双形态（remote-only 硬约束）

Cindy 新增硬约束落成四条不变量：

| #   | 不变量                                                                        | 现有证据/依据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **DB / migration / SQLite runtime 只属于 backend process**                    | 已成立于 TS：`db.ts` 是唯一句柄入口，`import-ratchet` 把 better-sqlite3 value import 锁在 `db.ts` 一处。Rust 侧对应：SQLite crate 与 migration 只能被 backend binary link                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2   | **renderer / preload / shared TS 不 link、不运行时依赖 Rust native artifact** | 现状 renderer 只经 HTTP/WS 与 backend 通信；`shared` 的 Node 依赖仅 `node:crypto/os/path`（`migrations.ts:1`、`app-data-layout.ts:1-3`）。Rust 化后此条必须保持为零新增 native 依赖                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 3   | **生成的 TS artifact 必须能在无 Cargo 环境下被 remote-only 打包**             | **rev2 撤回原推论**。rev1 从本条推出"生成方向必须 TS-authoritative"，这是**错误推论**：remote-only 打包不运行 Cargo ≠ 合同生成不能在开发/CI/release 阶段前置完成。Rust-authoritative 的 TS artifact 完全可以预生成并提交/发布到一个明确的 generated 子目录，remote-only 只消费成品，单一权威由 **drift gate** 保证。已知既有决定（Toby lane）：**Rust wire DTO → 明确的 generated TS 子目录，运行时 build 不互调**。<br>**infra 在此只定义负向约束**：①remote-only 打包链不调用 Cargo；②产物不携带 native artifact；③无 build cycle（生成是单向的、离线的）；④runtime validation 不因生成而丢失。**权威方向本身归 wire / spike 结论，不由 composition 推导** |
| 4   | **配置 / bootstrap 不得假设 backend 与 Desktop 同进程或同机器**               | 现有两形态已在代码里分叉：`ServerMode` embedded/standalone（`shared/src/config.ts`）、`OutboundFrameAdapter` 的 EmbeddedUnix vs Standalone-WSS 两实现、embedded bootstrap token 是 one-shot 文件（`auth/embedded-bootstrap.ts:37-44`）、`server-connection-profile.ts` 是 remote 侧的 0600 profile。Rust 侧必须保持"embedded 是可选 sidecar"，而非默认耦合                                                                                                                                                                                                                                                                                                   |

**两形态的差集**（阶段二设计必须逐项对齐）：

| 能力                 | embedded（可选 sidecar） | remote-only                            |
| -------------------- | ------------------------ | -------------------------------------- |
| backend binary       | 有（sidecar 进程）       | **无**                                 |
| SQLite / migration   | 有                       | **无**                                 |
| Rust native artifact | 有                       | **无**                                 |
| 与 backend 的通道    | Unix socket + HTTP/WS    | **仅 HTTP/WS**（同一 contract）        |
| bootstrap            | one-shot 0600 token 文件 | `server-connection-profile.bin` + 登录 |
| metrics              | 当前无（缺陷 §4.5）      | 由远端 server 暴露                     |

**推论**：`desktop_api` epoch 的 426 双面 gate（REST + WS upgrade）在 remote-only 形态下是**唯一**兼容性防线 → 其地位比 embedded 形态更关键，不得弱化。

---

## 8. §7 Delivery contract 冻结清单（两档，rev2 修正）

**分档**（详见 §2.4 的档 A / 档 B 定义）：

- **档 A = 长期业务合同**：被 schema / 消费者 / 测试锁定，Rust 必须逐字复刻**且长期保持**。
- **档 B = 首阶段 parity freeze**：首切逐字复刻以保行为等价，但**不是**永久承诺，可经显式产品迁移删除。

下表按"改动即静默破坏"排序，全部为**档 A**，除标注者：

1. **HTTP status 逐点复刻**（含 413/415/426/429/502/503/504/507）—— CLI exit class + retriable 的唯一来源。
2. **各 endpoint 的错误响应字节**与今天一致。注意：这是**按 endpoint** 的要求，不是"保留恰好六种信封类型"——六种是当前实测计数，不是设计目标（§2.5）。其中 `{error,issues:rawZodIssues}` 与 text/plain 500 属**档 B**。tasks 面 `{success,code}`（含失败也可能 HTTP 200）属档 A（有 shared schema）。
3. **`details.subkind:'message_stale'` + `stale_event_id`**（daemon 硬比较）；`code='message_stale'` 是冻结字面量，**不带 seq、不带 count**（`freshness-boundary-authority-v1.md`）。
4. **190 处测试锁定的 code 字符串**；`error_code` 字段名在 hosts/auth 面。
5. **protocol 三轴独立 + 单一写点**（`shared/src/protocol-versions.ts`）；bump 是**原子三元组**，相对上一个 published tag 只能 0 或 +1——"**A +2 is not 'two breaking changes' — it is a skipped generation, and a bug**"（`desktop-server-api-epoch.md` §6）；426 + `UpgradeRequiredBody` **在 REST 和 WS upgrade 两处**；admission 先于任何 DTO 解码；豁免路径集合 `/api/health`、`/api/server/info`、`/api/hosts/connect-token/resolve`、`/api/hosts/connect`。
6. **`EventFrame.seq` per-scope 严格 +1（跨所有 kind）**；`epoch` = backend 进程启动 UUID；wire **不是 exactly-once**；resume floor = `applied` high-water，**永不 set-max**（"false-positive = a silent drop"）。scope 分区：`conversation:<id>` = message-stream（resume load-bearing）vs `conversation-side:<id>` = cursor-inert。
7. **两条 seq 空间的硬墙** + `ReadSeq` 单一 mint boundary + `TransportEpoch` 是 string。
8. **`OutboundWriteBuffer` 1024 帧 / 4MiB**，`runtime_output` 唯一可丢，其他 kind 溢出必须关连接。
9. **每帧重跑授权谓词**（`ws-connection.ts:315-333`）：omission fails closed，不是 revoke-list fails open。
10. **control/execution plane 分离**：backend 不 spawn、不持 process handle、**不读 `system_prompt.md`/`MEMORY.md`/`notes/*.md` 字节**——"full stop. No 'embedded shortcut', no transitional shim, no fallback path."（`orchestration-boundary-v1.md` §3.1）；backend 派生零 host-local path；id → path segment 只经 `assertSafeWorkspaceIdSegment`（`^[A-Za-z0-9_-]{1,64}$`），unsafe id **fails closed，永不 hash 修复**。
11. **配置**：7 个 env 名/默认/fail-before-listen 顺序；`config resolved` 行带 `source`。
12. **观测**：JSONL 三 sink 文件名模式（logrotate）、`{ts,level,msg}` 骨架、always-write category、`FORBIDDEN_LOG_FIELDS`、metrics 仅 loopback + 指标名/label 集 + 基数禁令、"缺席不得伪造 `unknown` label"。
13. **安全**：token 只存 sha256；agent token 永不落盘；host token rotate + 60s grace；`--password` 不存在；8 个 SQLite driver 能力在生产树绝对为零。
14. **迁移 append-only**；ledger 必须是 plan 前缀；epoch 支持下限 44。
15. **driver-oracle parity 门**（`testing.md:202` 明确点名未来 Rust 实现）+ 104KB NDJSON 字节夹具。

## 8A. §7b 禁止形态清单（出现即打回）

来源三类：Cindy 的 review gate（G）、仓库既有禁令（R）、本文取证得出（E）。

**错误**

- G 不得过早收成一个万能 `AppError`；domain/application error 保持具体，统一映射只**单向**发生在 adapter 边界。
- G 不得用字符串匹配判错（现存反例 `repos/task-repo.ts:529`、`err.name === 'BodyLimitError'` 三处）。
- G `anyhow` 不得穿过业务边界；不得为了日志方便丢弃 source chain。
- E 不得把 HTTP status 塞进 application error（现存反例 `application/switch-agent-runtime.ts:30-38`）。
- E 不得把 infra 错误码混进 domain 词汇（现存反例 `DataPlaneFailureCode` 含 `not_found`/`forbidden`）。
- E 不得同名两份不同语义的错误类型（现存反例两个 `ActorError`）。
- E 未捕获异常的 `text/plain 500` 属 **parity freeze（档 B）**：首切照抄，不得顺手改成 JSON 500 或引入 body 里的 `retriable`；但它**不是**长期业务合同，将来可经显式产品迁移改形（§11-1）。

**事务与 DB**

- G repository 不得自己偷偷开事务；transaction handle 不得扩散进 domain。
- R native transaction 不得出现在 persistence surface 之外（`docs/db-boundary.md:120-124`）。
- R **tx 内不得有外部副作用**；副作用一律 post-commit drain。
- **E** 首批实现**不得公开 generic async tx closure**（`atomically(async fn)`）。"tx 内不得有外部副作用"在 Rust 侧的实施手段是 **semantic UoW**：application 只调用语义方法、事务封在 adapter 内，因此没有闭包可捕获外部 capability。**注意**：单靠"tx scope 类型不含 effect capability"**不成立**——Rust closure 可捕获环境里的任何东西。只有当真实跨 repo 原子编排出现且 semantic UoW 无法表达时，才就那个 slice 局部设计 restricted scope / effect collector / architecture gate。
- R 不得合并 commit 与 drain 的 magic helper（"不要 `runWithPostCommit(tx, effects)`"，`use-case-layer-p0-spec.md` §5）——原子边界必须在调用处可见。
- R 远程 IO / 外部进程调用不得在写锁内。
- R 迁移 **append-only**，不得编辑已发布迁移（`CLAUDE.md` #6）。
- E 不得抽最低公分母 DB wrapper：port 方法名必须来自领域动作，不得来自 SQL 动作；**若一个 port 签名能原封不动服务任意 schema，它就是伪通用 wrapper**（§3A.3）。
- E domain / application 的 import closure 不得出现 SQLite / SQLx / 方言 / driver error（本轮唯一机械 gate）。
- E 引擎名不得出现在跨边界类型词汇里（现存反例 `SqliteContention`）。
- R 8 个 driver 能力在生产树保持绝对为零。

**Trait / DI**

- **G/E（rev2 重写）** 边界合法性来自三条之一：**跨层所有权 / 必须隔离的副作用 / 已证可替换或可测**。满足其一→需要边界；**再选最小语言形状，不默认 Trait**。"没有第二实现"**不是**否决边界的充分理由（反例 `BlobStorage`）；"有几个测试注入点"也**不是**建全局 trait 的充分理由（反例 clock）。
- G 若 `tracing` 已是 process capability，不得为了 DI 再造 logger/metrics 镜像接口。
- E 不得复刻 `BackendContext` 式 capability bag（115 处形参）作为默认依赖传递方式。
- E 不得复刻 `undefined as unknown as X` 占位 + thunk late-binding 这类循环依赖逃逸口。
- E 业务代码不得依赖具体文件系统或具体存储实现（`BlobStorage` 那条边界与实现个数无关）。

**配置与 secrets**

- G secret 类型**不得派生或暴露 `Debug`、也不得派生普通 `Serialize`**；日志字段必须结构化脱敏。
- E 不得把新配置项做成"散落懒读 + 非法值静默回退 + 未文档化"（现存反例 6 类 env，§4.1）。
- E 不得依赖字段名黑名单作为 secret 防线（现存黑名单不含 `token`/`password`/`secret`）。

**观测**

- R metrics 标签不得用 raw URL、host/user/agent/conversation id、SQL 文本或 SQL 参数。
- R 未命名的语句不得伪造 `unknown` label——**缺席优于伪造**。
- R 不得把 `/metrics` 暴露到公网 ingress；不得为容器网络改成 `0.0.0.0`。
- R 一次拒绝恰好一条 WARN；不得在"insert 静默不发生"的分支上记一条谎报的日志。

**跨语言 / composition**

- G/E wire 单一权威；Rust 的 domain/DB 类型不得通过 `packages/shared` 泄漏给 TS；不得引入 build cycle；**不得降低既有** runtime validation（"降低既有"= 把已有校验去掉，不等于"没有校验的面必须补上"）。
- G renderer / preload / shared TS **不得 link 或运行时依赖 Rust native artifact**。
- **E（rev2 改写，撤回原禁令）** infra **不对生成方向表态**。只有四条负向约束：①remote-only 打包链不调用 Cargo；②产物不携带 native artifact；③生成必须是单向、离线的（无 build cycle）；④生成不得使 runtime validation 丢失。Rust-authoritative + 预生成提交 + drift gate 满足这四条，因此不被禁止；权威方向归 wire / spike 结论。
- G DB / migration / SQLite runtime **只属于 backend process**；配置与 bootstrap 不得假设 backend 与 Desktop 同进程或同机器。
- R backend 不得 spawn 子进程、不得持 OS process handle、**不得读 `system_prompt.md`/`MEMORY.md`/`notes/*.md` 字节**（"full stop. No 'embedded shortcut', no transitional shim, no fallback path."）；不得派生 host-local path；unsafe id **fails closed，永不 hash 修复**。
- R 两条 seq 空间不得互转；`Date.now() as MessageSeq` banned；wire seq 必须服务端 mint/decode，raw number → brand 只有 origin mint 与 validated decoder 两条路。
- R protocol 版本 bump 必须是原子三元组，相对上一个 published tag 只能 0 或 +1。

**流程**

- G 两个 prototype 都不得自称基线；最终 crate 形状在 spike 结论后统一。
- R compat/fallback shim 若缺"守哪个具名契约 / 删除触发条件 / owner"任一项，不得合入。
- R prompt 文案不建测试；结构不变量最多 pin 顶层 heading 集合与顺序。

## 9. §8 Provisional 清单（形状由未验证的 crate 行为决定，禁止提前冻结）

| #   | 未定项                                                                                                                                                                                                                                                          | 它决定什么接口形状                                               | 最便宜的首个验证点                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| 1   | **事务义务的表达** —— **已由 #2165 回答，本任务消费不重做**：SQLx 0.9 `begin_with("BEGIN IMMEDIATE")` 验 writer reservation，**non-zero depth 明确失败、不降级 savepoint**；事务形状为 **semantic UoW**（application 不见 tx 对象、不见 generic async closure） | SQLite adapter 内部 **root / deferred 两类私有能力**的形状       | 已由 #2165 的 gate 给出，本任务不另立 spike |
| 2   | **argon2 crate 与 DB 里 `library:'@node-rs/argon2'` 断言的兼容性**                                                                                                                                                                                              | credential 读路径是否需要 migration / 放宽断言                   | 用现有 hash 串跨库 verify 一次              |
| 3   | **cron crate 的严格 5 字段 + 时区语义**（现状拒 alias、用 Luxon 时区）                                                                                                                                                                                          | schedule port 形状与错误码                                       | 用现有 schedule 测试向量跑 Rust 侧          |
| 4   | **WS 库的 backpressure 原语**（`bufferedAmount` 等价物、close code 控制、`terminate` 语义）                                                                                                                                                                     | 出站帧缓冲接口；能否把 `OutboundWriteBuffer` 语义抬升为双向      | 单连接慢消费者实验，量缓冲上界可观测性      |
| 5   | **HTTP 框架的 timeout / body limit / 早期拒绝顺序**                                                                                                                                                                                                             | 能否做到"admission 先于任何 DTO 解码"+ 上传 size 检查先于 buffer | 一个 426 + 一个超大 body 的请求路径实验     |
| 6   | **tracing subscriber 能否满足 JSONL 三 sink + 文件名模式 + always-write category + 字段脱敏**                                                                                                                                                                   | 是否需要自定义 layer（而非 trait）                               | 产出一行与现有 backend 日志逐字段可比的输出 |
| 7   | **metrics crate 与现有指标名/label 集/基数禁令**                                                                                                                                                                                                                | exporter 装配点                                                  | 抓一次 `/metrics` 与现有输出 diff           |

**rev2 删除**：原第 8 项（per-transaction scope 可行性）。理由见 §3A.2-L5——SQLx 是池化驱动，tx-scope 形状由其 transaction API 自然决定；且 PG 已不是本轮扩张理由。

**纪律（rev3 收窄）**：**只有被首个真实 slice 真正触达的项**才需要在阶段二原型里标 `provisional` 并写明"哪条 crate 行为一旦不同这个形状就要改"。其余各项**只留证据，不产生阶段二义务**——按 §0 的问法，它们不形成难以反转的依赖方向。

**唯一的未来 trigger（不是未闭合 blocker）**：出现一个真实 use case 必须跨多个 repo 做原子编排、且 semantic UoW 无法表达。届时就那个 slice 局部设计 restricted scope / effect collector / architecture gate，并对"Rust closure 可捕获环境"给出真实答复。**现在不设计、不做 prototype。**

## 9A. §8b 已消费的 #2165 结论（一手读取，非转述）

已获 ecosystem channel 访问权，**直接读取** #2165 的 Acceptance Summary（board `rust backend ecosystem spike`，assignee Toby，`in_progress`）。以下为本任务实际消费的部分。

### 9A.1 直接消费（不重做、不另立 spike）

| 项            | #2165 的结论                                                                                                                                                                                                                                                                              | 对本任务的效力                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 技术栈        | Tokio `1.53.1` / Axum `0.8.9` / SQLx `0.9.0` + bundled SQLite / tower-http `0.7.0` / tracing `0.1.44` + subscriber `0.3.23` / ts-rs `12.0.1`                                                                                                                                              | 既定输入，不再评估                                                                                                           |
| 事务形状      | **semantic UoW**：`MessageUnitOfWork` 返回 application fact（`MessageCreatedFact`），不返回 transport DTO；durable payload 与 wire `ServerEvent` 各自从同一 fact 独立投影；adapter 不 import/serialize `contracts::ServerEvent`                                                           | §3.7-2 的首批答案；阶段二第 1 项就按这个形状证明依赖方向                                                                     |
| root-only     | SQLx `begin_with("BEGIN IMMEDIATE")` 验 writer reservation；**non-zero depth 明确失败、不降级 savepoint**                                                                                                                                                                                 | §3.7-3；root/deferred 作为 **adapter 私有能力**                                                                              |
| wire 权威方向 | **ts-rs（Rust-authoritative）**，`tests/export_bindings.rs` 是唯一 export manifest，只导出 transport DTO；checked-in bindings + contract descriptor，CI regeneration/clean diff 检 drift；**无 Rust↔TS build cycle**；不整体镜像 `packages/shared`                                        | 我 rev1 那条"必须 TS-authoritative"的禁令**被事实推翻**（rev2 已撤回）。generated 子目录与 drift gate 归 Toby lane，我只引用 |
| remote-only   | 无 Cargo 的 Node-only PATH 下完成 typecheck/compose/audit/runtime；exact allowlist 仅 `client/client.mjs`、`client/contract.json`、`composition.json`；拒 backend/migration、Cargo/Rust、SQLx/SQLite/database、native artifacts；两形态比对相同 client bytes + descriptor + bindings hash | §7 四条负向约束**已被实测满足**。未证项：真实 Electron `.app` unpack/audit                                                   |

### 9A.2 由此产生的 infra 级待办（本任务或后续）

| #   | 事实                                                                                                                                                                                                                                                        | infra 侧含义                                                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | SQLite 收敛当前是 **source-text fence**（`tests/persistence_text_fence.rs`），Toby 自陈类型别名 / 间接 re-export / 新 module shape 可绕过，**不声称 module dependency closure 已证**；并指出生产应以 **crate dependency direction + visibility** 加强同方向 | **这正是本任务阶段二第 3 项**。我的 gate 措辞（import closure）就是 Toby 说的生产形态；阶段二用 crate 依赖方向 + 可见性把它变成机械保证，而不是文本扫描                                                              |
| I2  | ts-rs **只证明 static TS shape**；runtime validator 仍 provisional，现有 Zod 不删，需 Zod accepted/rejected fixture parity                                                                                                                                  | **同一 wire 形状会出现两个权威**：Rust（静态结构）+ Zod（运行时校验）。硬门 4"不得丢失既有 validation"因此还有一个**未闭合的方向**——不是补校验，而是防止两个权威分叉。归 wire lane，我在此登记                       |
| I3  | broadcast 容量 64；lag 明确 close `1013 + reconnect/resync`；endpoint 尚无 cursor handshake；commit→live crash gap 与 cursor replay-to-live 未实现                                                                                                          | 与我 §5.4 的取证吻合：TS 侧 backend→浏览器**无** backpressure，daemon→server 有 `OutboundWriteBuffer`（1024/4MiB）。spike 选了"lag 即断连 + resync"，这与 TS 现状是**行为变更**，属 §11-3 的产品决策，不在本阶段闭环 |

### 9A.3 我对照 TS 证据发现的两处差异

| #                               | 差异                                                                                                                                                                                                                                                                                                                                            | 证据 | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1 durability（已决定）**     | spike 实测 `synchronous=NORMAL(1)`，Toby 已明确"只用于证明可配置可观测，foundation 不得继承"。**补充证据（我这侧）**：现有 TS backend **从不设置 `synchronous`**（全部 pragma 出现点 `db.ts:44,45,46,68,265,279,280,284,285,436`），因此运行在 SQLite 默认 `FULL`。继承 `NORMAL` = 把已 ack 的写在断电/硬重启下变成可能丢失，相对今天是**降级** | 见左 | **shiki 已裁定：正式实现保持 `FULL`。** spike 里的 `NORMAL` 不得被继承。已从"待决策"转为"已决定"                                                                                                                                                                                                                                                                                                                                                                                               |
| **D2 migration 互斥（已收窄）** | SQLx 的 SQLite migration lock/unlock 是 **no-op**。TS 侧的互斥是 mkdir 目录锁（`db.ts:472-485`）                                                                                                                                                                                                                                                | 见左 | **shiki 补充部署事实后收窄**：**ECS 一律停服部署**——停旧服务 → 唯一进程执行 migration → 成功后再启动服务。因此这个 no-op **在 ECS 不构成缺口**，**不要据此要求 Rust 自带通用跨进程 migrator lock**。留下的只是一条**部署硬约束**：_单 migrator owner 由停服部署顺序保证_。<br>embedded / offline admin 是否需要本地锁，**等真实 bootstrap 路径触达时按并发可能性判断**，不是本阶段义务。`migration_locked` / `db_locked` 的既有兼容范围**留到对应 surface 迁移时核**，现在不为保留 code 扩框架 |

## 9B. §8c 阶段二交付：三项最小 infra 原型

实现落在 #2165 的 prototype 树内（`spikes/rust-backend/`），branch `lio/rust-infra-contracts` 已**线性接到** #2165 最终 commit `9136caa1`。未另建 Cargo root，未改 `composition/`、`contracts/`、`bindings/`。

### 9B.1 三项交付

| #                               | 实现位置                                                                                                                                                                                                                                                                                                                                                                                                                   | 证明方式                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 semantic UoW 依赖方向**     | `src/adapters/sqlite.rs`：新增 **adapter 私有** `enum TxMode { RootWrite, DeferredRead }` + 唯一的 `begin(mode)` helper，模式由操作语义决定。`src/application.rs`：新增 `MessageReadUnitOfWork` / `MessagePageFact` / `ReadLatestPage`，表达"总数与最新一行必须来自同一快照"这一**真实**需求（§3.3 的 list+count 一致性），从而让 deferred 有非虚构用途                                                                    | **编译级证明，且只覆盖这一条**：`tests/infra_transaction_direction.rs` 在不引入驱动的前提下实现两个端口——端口签名若出现连接 / 语句 / 行 / driver error 会编译失败。**不覆盖**：generic async closure 与 tx capability 的缺失目前只由 **API 形状 + 词法门**保证（application 若自定义一个 driver-free 的 `TxScope` 并交出 closure，该文件仍会编译）；机械依赖方向需未来 crate boundary + visibility。私有性门：`TxMode` 与 `begin` 均非 `pub`，application 层不出现任何事务能力名。**行为判定**（adapter 单测两条）：①持有 writer reservation 时 deferred 读仍在 25ms 内返回，而同时请求的 root 写以 `SQLITE_BUSY` 失败（对照项，使前半句非空洞）②**跨语句快照**——第一次 SELECT 建立快照后另一 pooled connection 提交新行，同一读事务的 count 与 latest 仍是旧快照，而新事务能看到新行（证明那次提交是真的）。第②条才是 `MessagePageFact` 存在理由的证明；只有第①条时，两条 SELECT 掉到不同快照仍会绿 |
| **2 error 层次 + source chain** | `src/application.rs`：`PersistenceFailure` 从**无 source 的 unit struct** 改为携带 `Box<dyn Error + Send + Sync>`（**类型擦除**：拿到 source chain，但应用层不因此获得任何驱动类型依赖）。`src/adapters/sqlite.rs`：`map_err` 改为 `PersistenceFailure::from_source`。`src/http.rs`：`AppError::Persistence` 携带 cause，在 `IntoResponse` 里**记一次**完整链路。`src/infra/error.rs`：`chain` / `describe` / `root_cause` | `tests/infra_error_source_chain.rs`：驱动细节经 `PersistenceFailure` → `CreateMessageError` 后仍是 `root_cause`；真实 HTTP 请求得到 500 且 body 恰为 `{"error":"internal server error"}`、**不含**任何 infra 原因；校验失败走 422（同一边界的另一臂）。源文本门断言 `application.rs` 与 `infra/error.rs` **不出现任何 transport 概念**（`statuscode` / `http` / `into_response` / `500`），这才使映射是单向的                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **3 两条负向类型边界**          | `src/infra/secret.rs`：`Secret<T>` newtype——**不派生** `Debug`/`Serialize`，也**不派生 `Clone`/`PartialEq`/`Eq`**（`PartialEq` 会鼓励对 token 做普通、非恒时的比较；`Clone` 让复制秘密成为默认；当前无 consumer 需要）；无 `Display`/`Deref`/`AsRef`；手写 `Debug` 只输出 `Secret(<redacted>)`；明文只经 `expose()` / `into_inner()`。将来某个具体 secret 若真需验证，按其语义提供**具名恒时校验器**                       | `tests/infra_secret_boundary.rs`：嵌套在 `derive(Debug)` 结构体里时明文仍不出现。负向门**按结构比对而非字面匹配**：空白归一化后提取每个 `#[derive(...)]` 列表并逐项精确比对（容忍顺序、换行、`serde::Serialize` 这类路径前缀），另断言不存在任何 `<Trait> for Secret` 的手写 impl（`Debug` 是唯一有意例外）。禁止集 = `Debug`/`Serialize`/`Deserialize`/`Clone`/`Copy`/`PartialEq`/`Eq`/`Display`/`Deref` + `AsRef` + `serde`/`ts_rs` 属性宏。**已用两次变异验证非空洞**：跨行 `#[derive(Copy, Clone)]` 与手写 `impl Clone for Secret` 都被判红。第二条门断言 `application.rs` 与 `infra/*` 不出现数据库技术名                                                                                                                                                                                                                                                                                       |

**durability 已落到可执行代码**：`SqliteSynchronous::Full`，配置测试断言 effective `2`，README 同步为当前值。#2165 历史报告保留"当时实验过 `NORMAL`"的测量记录并注明已被本任务的决策取代——文档写"不得继承"而 prototype 继续跑 `NORMAL`，后来者最容易继承错的恰恰是那一份。

**修复的一处真实缺口**（不是新增功能）：`PersistenceFailure` 原本是无 source 的 unit struct，adapter 里 `map_err(|error| { tracing::error!(...); PersistenceFailure })` —— **先记日志、再丢弃原因**。这正是 review gate 2 明令禁止的形态（"不得为了日志方便丢失 source chain"）：边界拿到了 status 却拿不到 cause。现在 cause 一直活到渲染点，日志也从"adapter 与边界各记一条"收敛为**一次拒绝恰好一条**。

### 9B.2 诚实边界（不夸大）

- **`Serialize` 的缺失是"无 impl + 源文本门"，不是否定 trait bound。** stable Rust 无法表达"此类型不实现 `Serialize`"。真正的编译级证明需要 compile-fail harness（新增 dev-dep），按本阶段"不扩框架"的口径**不做**，据实记录。
- **编译级证明只覆盖"端口不需要具体 driver 类型"。** generic async closure 与 tx capability 的缺失目前只由 **API 形状 + 词法门**保证；"整个 application 依赖闭包干净"在单 crate 内同样只有文本门。机械保证需要 crate 拆分 + visibility（与 #2165 的 I1 同一结论），**不在本阶段闭环**。
- 未做（按范围）：完整 error 映射表、取消 / 超时 / backpressure、config 与 observability 细节、通用事务框架、PG 相关一切。

### 9B.3 五条可复用判断（本轮实际踩到的）

1. **源文本门必须先剥注释再扫描。** 我的两个门都被自己的文档注释判成违规——`secret.rs` 的 doc 里写"这些 derive 被刻意省略"，`application.rs` 的 doc 里写"不暴露 transaction handle"。**gate 读的是代码，不是散文**；把注释算进来会让"写清楚为什么"变成违规行为，从而反向激励删注释。
2. **"没有第二实现所以不抽"确实是错的判据。** `Secret<T>` 只有一个实现、也不需要多态，但它承载的是一条**跨层所有权 + 必须隔离的副作用**边界，而它的最小语言形状是 **newtype，不是 trait**。反过来同样成立：**最小暴露面要连 derive 一起算**——`Clone`/`PartialEq` 看着无害，实际是"复制秘密"与"非恒时比较 token"的默认许可。
3. **行为测试必须能被它要防的退化证伪。** 我第一版"deferred 读不被 writer 阻塞"看着像在证明快照语义，实际只证明了不阻塞：**两条 SELECT 掉到不同快照它照样绿**。真正的判定性测试要让 writer 在两条语句之间提交。这是"决定性证据"与"看起来相关的证据"的分界，review 抓到的正是这一点。
4. **决策必须落到可执行的那一份。** D1 已裁定 `FULL`，但代码与测试仍把 `NORMAL` 固化为绿——文档写"不得继承"、prototype 继续跑 `NORMAL`，后来者复制的恰恰是代码。**"文档已说明"不等于"已修正"。**
5. **负向 fence 自己也要做变异验证。** 第一版禁止项写成字面 `derive(Clone`，而 `#[derive(Copy, Clone)]` 与手写 `impl Clone for Secret` 都能绕过——**它声称锁住的边界比它实际锁住的宽**。可靠形态是按结构比对（提取 derive 列表逐项精确匹配 + 覆盖手写 impl），并**故意注入一次绕过写法确认门会红**。这与第 3 条是同一件事的两面：正向测试与负向门都必须能被它们要防的东西证伪。

## 10. §9 Integration seam（与 Toby 的边界）

我不定 crate/workspace 形状。以下是两条 lane 必须对齐的接缝，阶段二各出一半：

| seam             | 我（合同侧）交付                                                                                                                            | Toby（组合侧）交付                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| S1 错误映射      | 按 endpoint 的 code→status→响应字节 **数据形状**与全量映射表内容；档 A / 档 B 分档                                                          | 表在哪个 crate、adapter 层装配位置                                                                     |
| S2 事务          | UnitOfWork **语义合同**：原子性 + 隔离义务（按保证书写）、post-commit 排序、**业务侧不见 tx 对象也不见 generic async closure** 这一依赖方向 | SQLx 事务类型的 crate 归属与装配；root/deferred 作为 adapter 私有能力的实现；#2165 slice 的既有结论    |
| S3 wire artifact | 需要被 parity 覆盖的**合同清单**（paths / event-WS frames / api DTO / NDJSON 夹具）及其判定标准                                             | **权威方向、manifest 形状、generated 子目录位置、drift gate 的挂载**——infra 不单方面决定（见 §6.4-T3） |
| S4 观测          | JSONL 字段合同 + 指标名/label 集 + 脱敏类型要求                                                                                             | subscriber/exporter 在启动序列里的装配点                                                               |
| S5 配置          | 7 个 env 的语义 + fail-before-listen 顺序 + `config resolved` 行格式                                                                        | 启动序列实现与 embedded/remote 两形态的 feature 边界                                                   |
| S6 composition   | §7 的四条不变量 + 双形态差集                                                                                                                | crate feature 划分，保证 remote-only 无 Cargo/native 依赖                                              |

**Acceptance 纪律**：两个 prototype 都不得自称基线。**crate / workspace 形状归 Toby lane**（#2165 已有可运行 slice）；infra 只交合同侧，并在 Acceptance 里列出上表六条 seam 的对齐状态。

## 11. §10 需人类拍板的产品决策（我不自行修）

| #     | 决策                                                   | 现状                                                                                                       | 修它的代价                                                                                                                                                            |
| ----- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | 未捕获异常的对外形状                                   | 无全局 onError → `500 text/plain "Internal Server Error"` → CLI 判 **retriable=true**（真 bug 被告知重试） | 改成 JSON 500 或改 retriable 语义都会**改变 CLI 行为与 exit code**。三选一：照抄（保留缺陷）／加 JSON 500（破坏 CLI 期望）／保留 text-plain 但改 CLI 分类（跨包改动） |
| 2     | client 断开是否中止进行中的工作                        | 不中止（无 `AbortController`）                                                                             | Rust 有天然取消能力；启用会改变上传/长读语义                                                                                                                          |
| 3     | backend→浏览器 WS 是否引入 backpressure                | 无界堆增长                                                                                                 | 引入 = 慢客户端会被丢帧或断连，是**用户可见行为变更**。`OutboundWriteBuffer`（1024/4MiB，`runtime_output` 唯一可丢）是现成的正确形状，可抬升为双向合同                |
| 4     | 上传 size 检查位置                                     | 全量 buffer 之后才查 10MB                                                                                  | 改成流式/前置 = 更安全，但错误码时机与信封可能变化                                                                                                                    |
| 5     | embedded 是否补 metrics                                | embedded 无 metrics，桌面端只有日志                                                                        | 新增观测面，无对外破坏，但要定 bind 语义（`/metrics` 仅 loopback）                                                                                                    |
| **6** | **SQLite durability policy（`synchronous`）—— 已决定** | 现有 TS 从不设置该 pragma → 运行在默认 `FULL`。#2165 spike 实测 `NORMAL(1)`，只为证明可配置                | **shiki 裁定：正式实现保持 `FULL`**，spike 的 `NORMAL` 不得继承。见 §9A.3-D1。本项已闭合，保留在此仅为记录决策来源                                                    |

## 12. §11 文档与代码已脱节（抽合同时的陷阱）

| #   | 文档说                                                                                   | 代码是                                                                                                                                                                                   | 结论                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | `architecture-principles.md` §3 L55-57：四个 `*Actor` union 已折叠移除                   | `SendMessageActor`（`services/conversation-message/contracts.ts:37`）、`TaskActor`（`services/task/ports.ts:47`）都活着；`TaskActor` 是**真独立 union**，带 `runtimeScope:'conversation' | 'agent'`                                                                                                               | 真合同是"身份统一到 Principal + 每 service 用**窄化**投影"；`runtimeScope` 是真实第二维度，Rust 必须建模 |
| 2   | §2 L39-42 POLICIES 字段清单                                                              | 代码是 `allowForeignStream`/`distributeExcludeSender`/…（`contracts.ts:159-175`），前两个名与语义都换了                                                                                  | **机制（policy 表驱动）是真合同，字段清单不是**                                                                        |
| 3   | §3 L61-63 `AgentPrincipal.conversationId: string`                                        | 实为 `string \| null`，另有 `ScopedAgentPrincipal`（`auth/principal.ts:19-27`）                                                                                                          | AgentSlot vs ConversationSlot 的真实区分，Rust 必须保留 nullable + scoped 两型                                         |
| 4   | `use-case-layer-p0-spec.md` 全部行号引用                                                 | `routes.ts` 只有 653 行，路由已拆 `src/routes/*.ts`（21 文件），use case 在 **`src/application/`**（不是 `src/use-cases/`）；`seedMemberAgentL2` 已被 typed `agent_l2_seed` intent 取代  | §1.1 的两条 adapter-leak 红线**其实已修完**，文档仍写成待办                                                            |
| 5   | `desktop-server-api-epoch.md` §5 说 CLOSED at epoch 2                                    | 代码已 3/3/3                                                                                                                                                                             | 机制是真合同，**数字只信 `protocol-versions.ts`**                                                                      |
| 6   | `architecture-principles.md` §10.2 L225"在 S2 落地前，新代码至少要在命名+注释上显式标轴" | S2 已落地（`shared/src/seq.ts` 有全部 brand + decoder，`ObservedSeq` 已删）                                                                                                              | 该过渡语句已失效                                                                                                       |
| 7   | `testing.md` L115 与 §12 L265 引 `core-design.md` 的后端架构 / CQRS 章节                 | `core-design.md` 全文无此内容；CQRS 实际权威是 `activity-lifecycle-v1.md` §4                                                                                                             | **不要去 `core-design.md` 找分层合同**                                                                                 |
| 8   | `testing.md` 分层表                                                                      | 缺 `packages/backend/tests/db-boundary/`（14 gate + `inventory.ts`/`scan.ts`/`sources.ts`/`zones.ts`）                                                                                   | 最重要的一层合同 gate 没进测试文档                                                                                     |
| 9   | `db-boundary.md` 声称的 port 化程度                                                      | 同文承认 `BackendRepos` "**names concrete SQLite classes**"                                                                                                                              | 原话："What the capability wall buys is **not** engine independence — it is the precondition for it." **不要高估现状** |
| 10  | `brand-typed-seq-v1.md` 正文仍留 `observedSeqByStream` 描述                              | 已被 `freshness-boundary-authority-v1.md` supersede（文首已标注，属有意）                                                                                                                | 只取 §1 thesis / §2 两空间表 / §3 brand 集 / §4 转换规则 / §5 role 表，**retired 行不是活合同**                        |

## 13. §12 Falsifiers（什么证据会推翻本文的核心判断）

rev2 已删除的判断不再列（六种信封永久保留、同步 SQLite 是架构假设、wire 权威必须留 TS、ws-frames 补 zod 是前置条件、per-tx scope 是 PG 不倒退必要条件——它们在 §0A 里已被撤回或降级）。

| 判断                                                                     | Falsifier                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP status 比 code 更硬                                                 | 若 CLI 改为优先采信 code（`cli/src/errors.ts:249` 的枚举扩到全集），则结论反转                                                                                                                                                                                                                                         |
| 某个形状属档 A（长期业务合同）                                           | 若能证明该形状的**全部**消费者（测试 + CLI 分支 + renderer 分支 + shared schema）都不依赖它，则降为档 B。需**逐项**举证，不得整体推断                                                                                                                                                                                  |
| 某个形状属档 B（parity freeze）                                          | 若发现任一 schema/客户端分支/测试锁定它，则升为档 A。档 B 名单必须可被单条推翻                                                                                                                                                                                                                                         |
| renderer 应按 endpoint contract 组织                                     | 若发现多个 endpoint 的错误形状实际由同一上游合同强制同步演进（例如同一 shared schema 覆盖），则该组的正确归属单位是那个 schema，不是 endpoint                                                                                                                                                                          |
| semantic UoW 足以表达所有需要的原子性（因此不需要公开 async tx closure） | 若出现一个真实 use case 必须跨多个 repo 原子编排、且无法用一个语义方法表达，则该判断被推翻——**这正是唯一的 trigger**，届时才就那个 slice 局部设计 restricted scope / effect collector / gate                                                                                                                           |
| root/deferred 可作为 adapter 私有能力隐藏                                | 若某个业务操作必须由 application 决定用哪一类（而非 adapter 能从操作语义推出），则该能力泄漏到签名上，隐藏失败                                                                                                                                                                                                         |
| application/service port 层对 SQLite 是干净的（§3A.1-A3）                | 若在 `application/` 或 `services/` 里发现任何 SQL 文本、`RunResult`/`lastInsertRowid` 使用或 PRAGMA 引用（`db-boundary.md` 自陈 use-case 层 "existing usage is pinned, per file, shrink-only"，即**存量不为零**），则 A3 须从"干净"降级为"仅 concrete type 干净、SQL 存量另计"——阶段二按 `inventory.ts` 台账逐文件核实 |
| `BlobStorage` 需要一条边界                                               | 若能证明业务层从不需要存储语义、只需一个由 adapter 完全拥有的内部细节（即没有任何 domain 判断依赖存储结果），则该边界可降级为 adapter 内部实现                                                                                                                                                                         |
| clock 不需要全局抽象                                                     | 若需要控时的构件在调用图上广泛分布（而非集中在少数构件），则窄传递的成本超过一个统一形状，结论反转。判据是**分布形态**，不是注入点计数                                                                                                                                                                                 |

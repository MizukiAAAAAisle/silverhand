# Silverhand — Runtime Input 目标模型设计（admission / steer / stale release）

> 状态：v8（§5 重写为 signal-only 单一正文释放面，shiki 拍板 thread
> MzSv_f1u0e0xbKmH seq 1205；v7 的 stale-event fetch 设计整体废弃）。此前：
> v7.7 B' 实测并入 §3.2；#task:1555 final PASS；#task:1557/#task:1558 已交付。本 doc 是 runtime 输入投递的**目标模型**语义 owner；现行行为以
> [`daemon-authoritative-delivery-v1.md`](./daemon-authoritative-delivery-v1.md) 与
> [`freshness-boundary-authority-v1.md`](./freshness-boundary-authority-v1.md) 为准，
> 本 doc 描述它们的演进终态与迁移路径。评审通过前不改生产代码。

---

## 0. 摘要

一句话：**daemon 在适合每个 driver 的边界释放输入，同一正文绝不经第二个输入面
再释放一次；freshness 只被可证明的 admission 证据推进。**

两种 ACK 严格分层（产品决定，2026-07-20）：

- **`runtime_delivery_consumed`（delivery custody 结算）**：daemon 成功把 batch 写入
  runtime input 即发出；backend 随即结算
  `delivered_at`。**与今天一致，不等 admission。**
- **admission evidence（freshness 推进）**：按 driver profile 定义的证据推进
  per-stream `observed`。它只负责 freshness，不反向控制 delivery 结算。

"恰好一次"指**逻辑 release**：每条 delivery 全局只有一个 release winner（边界注入
），由 backend 现有 inbox lease（`claimPending` owner token）裁决。本设计消灭的是**跨输入面的双曝光**
（409 正文 + 正式投递）；write 后 runtime 崩溃可能丢失 stdin 中 payload 而不重投，
是现行 `runtime_delivery_consumed` 一直接受的故障语义，维持不变（更强的 durable
delivery 是另一份产品合同，不夹进本次重构）。

三个模块（对应 shiki 拍板的三点）：

1. **Input admission**：daemon 持有 pending input，按 per-driver profile 在正确边界
   以有界 batch 注入；observed 只按 profile 定义的证据推进。
2. **Claude steer 支持**：分两步启用已实证的 `priority:"next"` mid-turn steer。
3. **Signal-only 409**：409 变 body-free 控制信号；正文只由正常投递面释放一次
   （§5，v8 定版）。

---

## 1. 问题（全部有当日实证）

2026-07-20 的三条事实链（日志与实验均在 #conv:ez34NLEgt1qUavRC 的排查线程内）：

- **P-A｜N 条积压 = N 个后续 turn（慢一拍）**。Qoder 把每个 stdin payload 排成一个
  独立后续 turn 逐条消费，不合并。实测：17:25 连续写入 seq 860/861 两个 payload，
  17:26 的 turn 只消费 860，861 等到 17:44 该 turn 结束后才进入模型。
- **P-B｜per-payload admission 越界**。`pendingAdmissionSeqByStream` 只存 high-water，
  Qoder 任一下次 activity 即整体晋升 observed——但真实语义是逐条消费，freshness
  observed 会提前越过尚未进入模型上下文的 seq。
- **P-C｜409 双曝光**。同一正文经两条通道到达模型：stale 409 的 `newer_messages`
  （同步决策上下文）+ 后续正式 turn 输入。去重判断被丢给 agent 自觉，失败模式是
  公开刷屏（当日实发）。

### 1.1 现状 delta（本设计的真实增量）

现有系统已经具备（不要重复设计）：

- daemon per-handle `deferredQueue`（#1417）：`gated` runtime 在 tool/compaction
  boundary 关闭期间持有 payload，boundary reopen 时整队合成一次 write。
- per-stream freshness admission gate（#1471）：mid-turn 交付的 seq 进
  `pendingAdmissionSeqByStream`，turn-start 时晋升。

本设计**真正新增**的只有三点：

1. **持有条件变更**：Qoder 即使 generic tool boundary 开放，也继续由 daemon 持有到
   该 driver 的 admission boundary（next-turn）；持有判据从 `gated` 单值变为
   per-driver profile（§3.2）。
2. **observed 证据化**："任意下次 activity 晋升整个 high-water"废止；observed 只按
   profile 定义的证据、按 `covered_seq_by_stream` 逐 stream 推进（§3.1/§3.3）。
3. **release 唯一性**：409 正文曝光面撤销；正常投递面是唯一释放面，由现有
   inbox lease authority 承载（§5）。

`runtime_delivery_consumed` 的时点与故障语义**不变**。

## 2. 目标模型总纲：两条正交合同

- **合同 A（admission）**：每个 runtime 如何**高效**且**可证明**地接纳输入。效率 =
  积压不随消息数放大为多个 turn；可证明 = observed 推进有 profile 定义的证据，
  **不虚构"模型已看到"**——系统承诺的上限是"在适合该 driver 的边界释放"，模型
  注意力不属于可证明合同。
- **合同 B（release）**：每条消息的正文只有一个逻辑 release winner，处理上下文随
  release 交接，不依赖 agent 自觉去重。

### 2.1 核心不变量

- **I1（证据推进）**：per-stream observed 只能由该 driver profile 定义的 admission
  证据推进（构造性边界写入或协议级证据，§3.2），按 batch 的
  `covered_seq_by_stream` 逐 stream 推进。"任意下次 activity"不是证据。
- **I2（send/inbound 同调度）**：daemon 已持有更早的 pending input 时，outbound
  `message send` 不得绕过它去 backend 换回同一正文的 409 曝光。
- **I3（单一逻辑 release）**：backend 是 durable custody owner，per-delivery
  release 事实以现有 inbox lease/`delivered_at` 为唯一权威；daemon 是 live runtime
  的注入顺序仲裁者。一条 delivery 只有一个 release winner（v8 起唯一竞争者就是投递面自身的 owner lease）。
- **I4（有界性）**：pending queue 与注入 batch 按条数与总 UTF-8 bytes 有界
  （单条正文 64KiB 上限由 #task:1550 保证），超界分多个 boundary batch 排出。
- **I5（无损排队）**：排队与 claim 阶段不丢消息、不清 delivery；消息始终按正常
  边界投递。（write 之后的故障语义见 §0/§6，维持现状。）

## 3. 合同 A：Input admission

### 3.1 状态与结算

```
backend inbox row（复用现有原语，不新增状态机）:
  pending (in_flight_owner=NULL)
    ──claimPending(owner)──▶ leased (in_flight_owner=token)
    ──write 成功──▶ delivered (markDelivered, delivered_at 结算, consumed 上报)
    ──失败/超时/替换──▶ rollbackInFlight(owner) 回到 pending

daemon 本地:  queued ──边界到达──▶ (claim) ──write──▶ written-awaiting-admission ──证据──▶ admitted
                                                       (仅存 batch id + covered_seq_by_stream，     │
                                                        不再持有正文/inbox row)               observed 推进
```

- consumed 在 **write 成功**时发出（现状不变）；backend 以现有 `markDelivered`
  结算。**不引入新的 delivery 状态**：排他性由现有 `claimPending` 的
  `in_flight_owner` lease 提供，回滚由 `rollbackInFlight` 提供。
- `written-awaiting-admission` 是 daemon 内存态，只承载 freshness 簿记；它不影响
  delivery custody，daemon 崩溃只丢 observed 的中间态（保守：不推进，CAS 仍拦截），
  不产生重投义务。
- write 前（queued/leased）的崩溃与连接替换：lease 回滚重投，无损（I5）。
- write 后 runtime 崩溃：payload 可能丢失，义务已结算，不重投；正文仍在 canonical
  history（现行接受语义，显式声明）。

### 3.2 Release profile（取代单值 `gated`；分类定版 2026-07-20）

五类固定 profile（不为每个 runtime 写临时判据）；**默认 fallback 是保守的
`next-turn-batch`**，只有 driver 证明支持 same-turn steer 才允许在 tool boundary
释放：

| Profile | 语义 | Runtime | admission 证据（observed 推进） | 状态 |
|---|---|---|---|---|
| `native-steer` | 新输入由 runtime 协议并入当前 turn | Codex（原生 turn/steer，立即交付） | **generation-boundary echo（countgame round-2 定版）**：`turn/steer`/`turn/start` 的 JSON-RPC 响应只是 transport ack（只承诺"并入 active turn"，不承诺在途/已排队生成会重新条件化——实测 ACK 落后已生成 send 300–600ms 仍放行了旧稿），**不产生任何证据事件**；payload uuid 经原生 `clientUserMessageId` 字段（0.144.4 schema 确认）随 steer 下发，codex 在 drain pending_input 入模型 history、构造下一次 sampling request 之前以 `item/started {type:'userMessage', clientId}` 回显——该回显才是 lifecycle/推进证据。echo 丢失时退化为 pendingAdmission 在 turn 边界结算（fail-closed） | 已定版 |
| `tool-boundary-steer` | 新输入在当前 turn 的下一个 tool boundary 并入 | Claude（B' 实测：默认即 steer、`priority` 无行为差异；**产品决定仍显式发送 `priority:"next"`**——声明意图并防未来默认行为变化，未文档化字段的维护成本随版本实测跟进；首帧带 priority 已探证正常；无 tool turn 自然退化为独立下一 turn） | write=released；`started(uuid)` 到达即按 payload 覆盖晋升 observed | **已启用**（B'，证据 notes/claude-ab-results）；`!compacting` 为迁移期保守 hold（未覆盖场景），非实证 guard，禁止重新共享化 |
| `prompt-boundary` | 协议显式暴露"可开启下一 prompt"的边界 | OpenCode（ACP `session/prompt` 生命周期） | **整批边界（构造性，#task:1565 定版，opencode 1.18.1 实测）**：client 侧单 in-flight prompt 是**正确性不变量**——实测 runtime 会静默排队第二条 prompt，且把两个 RPC 响应都攥到整段排队运行结束才一起返回（usage 合并），排队状态下"prompt 响应"不再是逐 turn 边界。mid-prompt 投递一律 defer 进 daemon 队列，prompt 响应（parsed `turn_end`）重开边界后合成一条 `session/prompt` 写入，写入即边界 admission（同 qoder 档构造性证据）。`session/cancel` 实测以 `stopReason:'cancelled'` 正常结算响应、会话可继续（无 wedge）。post-init 边界关闭走 defer 不 refuse——refuse 只留给 pre-init（`ready_for_drain` 每 run 一次，post-init refuse 会饿死行） | 已定版 |
| `next-turn-batch` | 无 steer、无 prompt admission 协议：等 turn 结束，积压合成一个 payload 作下一 turn 输入 | Qoder（`priority:"next"` 实测无效——headless handler 不读该字段，#task:1556，勿走 Claude 路径） | **构造性**（§3.4：write reservation + parsed `turn_end`） | FIFO 逐 turn 消费已由二进制 + 双黑盒实验证实（#task:1556） |
| `one-shot` | 不支持 live input | Cursor | 不适用 | 不在此模型内 |

术语澄清（gate 讨论定版）：现有 `outstandingToolUses === 0 && !compacting` 是
**transport-safe boundary**。它既**不是 next-turn boundary**（模型 thinking、
provider 排队、两个 tool 之间它都为 true，拿它当 Qoder 的释放判据正是 P-A 的
根源），也**不是 steer 类 runtime 的写入前置**（Claude 的 `priority:"next"` 与
Codex 的 `turn/steer` 都在 tool/turn 进行中写入，实验已证）。它的去向见 §3.2.1：
只保留给明确声明需要它的 legacy strategy。

规则：profile 由 driver 声明并附 falsifier 测试；不允许从 wire shape 相同推断语义
相同（Claude/Qoder 同为 stream-json，语义完全不同——已实证）。**没有可关联证据的
runtime 只记录 released/admitted-at-driver-boundary，不虚构"模型已看到"。**

**Action-snapshot 不变量（countgame round-2 定版，2026-07-21）**：
`observedSeqByStream` 不是"runtime 已接收输入的最新水位"，而是**当前模型生成
动作启动时的上下文快照**。动作一旦开始，快照锁定；期间所有 steer/投递只进
pending，不得改写当前动作随后 send 所携带的 observed。只有两类事件可推进：
(1) 能证明下一次模型生成动作已开始的 admission 证据；(2) 新 turn 的真实起点
（pending → observed 现有路径）。write/transport/RPC-ACK 一律只是投递证据。
false-stale（多吃一次 409）可恢复，false-fresh（旧稿穿门）不可恢复——方向性
不对称决定必须 fail-closed。

**词表（gate 用语，四概念互斥，禁止互相借义）**：
- **release**：daemon 把正文写给 runtime。只改变 custody（consumed/failed 结算
  面），永不改变 freshness。
- **action snapshot**：一次模型 generation 开始时锁定的 `observedSeqByStream`；
  该 action 后续所有 send 都必须携带它。
- **pending coverage**：snapshot 之后 release 的消息范围（per-stream high-water，
  `pendingAdmissionSeqByStream`）；只累计，不改当前 snapshot。
- **generation boundary evidence**：能证明后续一次模型 generation 已开始、且可
  把 pending 作为 precedent 的 runtime 事件；只有它能把 pending 合入下一
  snapshot。per-runtime 声明（§3.2 表），不从统一事件套用。

三条验收不变量：旧 action 在 release/ACK 后仍必须 stale（409）；声明的
generation boundary 之后 informed send 才能通过；custody consumed 永远不能
冒充 model observed。

### 3.2.1 Admission contract 接口（profile 的实现形态）

profile 不是更细的枚举，而是 driver 声明的**接口实例**。接口是三元组，且
**release/write 与 admission 是两个不同的时刻，不得混写**（Claude 的机制恰好是
"现在立即写、由 runtime 在未来的 tool boundary admission"——若 scheduler 等
tool boundary 才写，反而错过该边界再慢一拍）：

1. **scheduler release/write policy（何时写）**：Codex/Claude **立即写**；
   Qoder 等 parsed `turn_end`；ACP 等 ready-prompt；one-shot 等 next-spawn。
2. **runtime admission semantics（runtime 何时接纳）**：Codex 原生 steer 并入
   当前 turn；Claude 在当前 turn 的下一个 tool boundary 并入；Qoder 下一 turn
   整批；ACP 下一 prompt。
3. **normalized evidence（何以为证）**：`userMessage clientId` 回显（Codex，
   generation-boundary echo；RPC 回执只是 release ack）/ `started(uuid)`
   （Claude）/ 构造性 write-at-boundary（Qoder，凭 #1556 证实的 FIFO 语义）/
   prompt 生命周期（ACP）。

**payload composition 的 owner 拆分**：strategy 只声明 **batch selection /
cardinality**（能否合批、一批几条）与 **runtime wire encoder**（`turn/steer`
编码、`priority:"next"` user frame、合成 batch frame、单 prompt）；**scheduler**
拥有有界 snapshot 的选择、Silverhand meta/body 的合并，把一个已合成的 logical
payload 交给 driver 编码。driver 不理解 stream、`turn|observe` 或消息正文合并。

**Owner 划分写死**：driver strategy 拥有 admission 语义声明 / wire encoder /
normalized evidence；统一 scheduler 拥有 write policy 的执行、custody、有界
snapshot、消息合成与 freshness 映射。supervisor 不再持有统一 safe-boundary
判据，只与接口对话；`readyToEncode()` 回归 handshake readiness 本职，与
admission 分离。

**是否需要额外 write guard 也是 strategy 的一部分，没有全局地位**：Codex 在
active turn 中直接 `turn/steer`、Claude 实验就是在 tool 运行中写入
`priority:"next"`——对它们保留 `outstandingToolUses === 0` 会把已验证的 steer
能力重新阉割。Qoder 由 `turn_end` release 构造自然满足；ACP 由 prompt readiness
保证。旧谓词 `outstandingToolUses === 0 && !compacting` 只能以**显式的
`legacy-safe-boundary` 迁移策略**存在：已知 runtime 必须显式声明 strategy（当前
五个均可分类，无缺口）；未声明/未知 driver **fail closed**（不接受 live input，
按 one-shot / backend pending 处理），不猜 gated；`legacy-safe-boundary` 仅限
迁移过渡 commit，Phase 2 全部 driver 迁移完成后删除，不成为长期第六种能力——
它是 migration fallback，不是 semantic fallback。这同时修掉现状的名实不符
（deferred queue 注释写 "flushed at next turn_end"，实际任何 boundary reopen 都
flush，#1556 核实）。

### 3.3 Batch envelope 与合成语义

- batch envelope 携带 **`covered_seq_by_stream: Map<stream_key, max_seq>`**；observed
  是 per-stream map，admission 后逐 stream 推进各自覆盖值。
- **允许跨 stream 合并**进一个 payload（否则 Qoder 多 stream 退回 N-turn），admission
  粒度为整个 batch——证据到达即推进它覆盖的所有 stream。
- **mixed `turn|observe` 语义**：全 observe batch 末尾**不带** Respond 指令（标注
  context only）；混合 batch 的末尾指令按 msg_id 只引用 turn 条目；**observe 永不
  因合并被隐式升级为 turn**。
- 边界到达时对 pending queue 做**有界 snapshot**；snapshot 后到达的消息进下一批。
- 合成保留每条消息完整 meta header、附件快照、linked_task；不改写正文。

### 3.4 Qoder：write reservation + parsed `turn_end`（构造性 admission 定版）

实证基础（#task:1556，二进制控制流 + 两次独立黑盒实验，详见 Cindy 的
`notes/qoder-stdin-admission.md` 与 `qoder-stdin-probe.mjs`）：Qoder 后台 reader
持续读 stdin 入进程内 FIFO（当前 turn 执行中也读），主循环一次取一条完整
`submitMessage()` 到 terminal `result` 才取下一条；terminal `result` 已被
`parseStreamJsonLine()` 解析为 `turn_end` 且 supervisor 已消费——信号现成，缺的
只是释放策略。判据（gate 讨论定版）：

1. shared stream-json parser 已把 Qoder 的 terminal `result` 帧解析为 `turn_end`，
   以它为唯一的 next-turn boundary 信号。
2. 每次批量写入时**立即**设置 daemon 本地 **next-turn reservation**——不等 Qoder
   首个 thinking/text 才认为 turn active。reservation 覆盖 write 成功到首个
   activity 之间的空窗：只看 `inputTurnActive` 时，第二条消息可能趁空窗被写成
   另一个独立 turn（正是 P-A 的微观机制）。
3. reserved/active 期间的新消息只入 pending，不写 stdin。
4. 收到该 turn 的 `turn_end` 后：清 reservation → 对当时 pending 做有界 snapshot
   合成一个 payload 写入 → 随即再次 reserved。
5. runtime idle 且未 reserved 时到达的消息：立即把当前 pending 合成一批写入，
   开启下一 turn（同时 reserved）。

在此构造下（只在边界写入 + reservation 保证单批在途），write 成功即该 batch 唯一
对应下一 turn 的输入 ⇒ write 即 admitted，observed 随 write 按
`covered_seq_by_stream` 推进。

前置验证项：`turn_end` 帧解析的时序与丢失率。**缺 `turn_end` 的恢复必须
fail-closed（v5 gate P1-3）**：reservation 超时**不开门写入**（清 reservation
再写会直接重现 P-A），只保持 pending，等待真实 `turn_end`、runtime
exit-restart、或用户显式处理。（**状态注记：reservation-timeout 的诊断事件与
对应测试属后续项，Phase 2 实现未含**——当前实现依赖 turn_end/exit 清除与
runtime 终结安全网。）若发现 `qodercli` 有 lifecycle
等价帧或 payload UUID 回显，可作为增强证据，但不是前置条件。

**未知 driver 的保守 fallback 修正（v5 gate P1-3）**：`next-turn-batch` 作为
fallback 的前提是 driver 能可靠给出 terminal boundary（parsed `turn_end` 等价物）。
连 boundary 都没有的未知 driver，保守 fallback 是**拒绝 live input（按
`one-shot` 处理）**，不能假装 next-turn——没有边界信号的"等边界"等于永久扣留或
随机开门，两者都错。§3.2 的"默认 fallback = next-turn-batch"以此为条件。

## 4. 模块二：Claude steer 支持

实证（claude 2.1.210，脚本 `claude-steer.txt`，Lio/Cindy 独立复跑一致）：

- mid-turn 以 `priority:"next"` 注入的 user payload，在当前 turn 的下一个 tool
  boundary 进入模型，同 turn 继续执行并吸收新指令，单一 `RESULT` 收尾。
- `command_lifecycle` 帧按输入 `uuid` 携带 `queued → started → completed`：
  `started` = 该 payload 进入上下文的显式证据。
- `--replay-user-messages` 可观测进入上下文时刻，作为验收工具。

两步走：

1. **Step 1（instrument，只加观测）**：daemon 为每条 Claude 输入携带稳定 `uuid`，
   维护 **uuid → delivery/batch in-flight 映射**（进合同）；parser 解析
   `command_lifecycle` 上报诊断。A/B 验证：无 `priority` 默认行为、多条并发
   `priority:"next"` 顺序、无 tool call turn 的注入行为。
2. **Step 2（启用）**：验证通过后 live delivery 改发 `priority:"next"`；
   `started(uuid)` 接入 observed 推进（I1 的 Claude 增强证据）。consumed 语义不变，
   故 Step 2 只触及 freshness 布线，不触及 delivery custody。

Claude 保持 tool-boundary 写入（steer 有真实收益，不降级为 turn-boundary）。

## 5. 模块三：Signal-only stale 409（合同 B 定版 v8，thread `MzSv_f1u0e0xbKmH`）

> v8 重写（shiki seq 1205 拍板）：废弃 v7 的 stale-event fetch 设计（stale_events
> 表、专用 fetch 命令、fetch owner lease、custody 切换、continuation、
> response-loss 恢复臂全部否决）。根因判断：双曝光/大窗口是"消息等 boundary
> 才能进模型"的放大症状；机制应收敛到单一正文释放面，而不是给慢通道建第二
> 条精确补看通路。Qoder 的实时性等上游 steer 支持（#task:1568 已证实 headless
> 无非破坏介入点）。

### 5.1 核心合同：单一正文释放面

- **正文永远只由正常 inbox/admission 面释放一次。** 409 只发信号，不发正文，
  也不提供任何第二释放面（无 fetch、无 history-cancel）。
- 409 载荷（signal-only）：

```jsonc
{
  "subkind": "message_stale",
  "stale_event_id": "…",        // 纯关联 uuid（resolution 遥测），无持久表
  "stream_key": "main",
  "seen_up_to_seq": 12,
  "current_seq": 30,
  "hint": "wait for pending messages to arrive through normal delivery; then retry or discard"
}
```

- **daemon 收到 409 不推进 observed**（什么都没展示）。unseen 内容经正常投递
  到达、按该 runtime 的 admission 证据推进 observed 后，retry 才能过 CAS。
  steer runtime（codex/claude）当前 turn 内到达；boundary runtime（qoder）
  turn_end 后一个合批到达。uninformed retry 按设计再次 409。
- `--anyway`（force_send）仍是显式逃生口；`stale-resolve --resolution obsolete`
  处理"读后不必再发"。

### 5.2 Freshness universe ⊆ delivery universe（防 signal-only 死锁）

signal-only 的前提：**凡是推进 stream head（能造成 409）的消息，必须保证有
正常 delivery 可等**，否则移出 freshness universe。逐类合同（审计定版）：

| 消息类 | 处置 |
|---|---|
| 普通 user/agent 主线消息 | 已有全员 fan-out delivery ✓ |
| task/rename/workspace 通知 | 已有全员 delivery ✓ |
| agent 自己的消息 | send commit 推进 observed，天然豁免 ✓ |
| thread 差集（非 follower 的先前 replies） | 409 时物化与 follow-backfill 同身份的 observe delivery（幂等命中同一行），信号必有着落 |
| 成员加入/移除通知（含 workspace 级联） | 补全员 delivery（与 rename 同形） |
| 调度死目标 DM 通知 | 补 owner delivery |
| clear-session 审计消息 | 取消对被清 agent 的排除，全员 delivery |
| schedule_fire | **移出 freshness universe**：插入时不推 stream head（owner 自唤醒非频道话语；给全员补投递会造成 fire 唤醒全员的产品回归）。配套：CAS 由严格相等放宽为 `head <= seen`（exempt 行的 delivery 会把 owner 的 observed 推过 head；放宽方向安全——seen ≥ head 只多不少） |

### 5.3 最终一致性论证

1. 正文 durable 在 messages 表，任何时候可经 canonical history 读（自愿读，
   不入 release 账本）。
2. observed 水位永不越过未入模型的内容（409 不推、写失败不推、admission 才
   推）→ agent 无法在缺口上继续发言，除非显式 `--anyway`（有审计）。
3. 5.2 保证缺口必然由正常投递闭合 → 不漏；单一释放面 → 不重复。

## 6. 失败语义

| 故障点 | 后果 | 恢复 |
|---|---|---|
| daemon 崩溃（queued，未 claim） | 本地 pending 丢失 | backend row 仍 `pending`，重投 |
| claim 后、write 前崩溃 | row 停在 `*_claimed` | 超时/replacement 回滚 `pending`，重投 |
| write 成功后 runtime 崩溃 | stdin 中 payload 可能丢失 | **不重投**（义务已结算，现行语义）；observed 未推进的部分保守不动，CAS 仍拦截；正文在 canonical history |
| write 后 daemon 崩溃 | 丢失 written-awaiting-admission 簿记 | observed 保守不推进；delivery 已结算无重投义务 |

## 7. 迁移路径

1. **Phase 1 — Claude instrument**（独立、只加观测）：uuid 映射 + lifecycle 解析 +
   A/B 验证（§4 Step 1）。
2. **Phase 2 — admission profile + batch 合成 + observed 证据化**：`gated` 拆分为
   profile、Qoder next-turn batch（慢一拍在此消失）与构造性 admission（§3.4，含
   边界识别验证）、Claude steer 启用（§4 Step 2）、OpenCode 验证后定 profile、
   I1/I2 生效。**consumed 语义不动**，本阶段不触 delivery custody。
3. **Phase 3 — signal-only 409 + universe 对齐**（v8 定版，见 §5）：
   409 去正文化；thread 差集按需物化正常 observe delivery；成员/审计/DM 通知
   补全员 delivery；schedule_fire 移出 freshness universe + CAS 放宽为
   `head <= seen`。无新表、无新命令、无第二释放面。

**旧路径删除判据**：backend 按 daemon 声明的 capability 返回两种 response
contract（不是双写）；旧正文 409 与 #1554 分页语义，只有在观测证据表明无旧
capability daemon 活跃、或设定最低 daemon 版本门槛后才删除——时间经过不是删除
理由。

## 8. 测试矩阵（验收 falsifier）

| 合同/不变量 | Falsifier 测试 |
|---|---|
| I1 | Qoder：batch 只在确认边界写入，写入前 send 的 seen 不含 batch seq、写入后按 covered_seq_by_stream 逐 stream 推进；单 stream 同时至多一个 batch 在途。Claude：Step 2 后 `started(uuid)` 推进对应 payload。 |
| I2 | daemon 持有 pending 时 send → 本地 `pending_input`，backend 零请求。 |
| I3 | 每 delivery 恰好一个 release winner（inbox lease 唯一权威）；409 不构成第二释放面（零正文）。 |
| I4 | 超界 batch 分批排出的完整性（拼接无缺失/重复）。 |
| I5 | 边界到达即投递；claim 回滚 → 重投；signal-only 409 后正常投递闭合缺口。 |
| §3.1 | claim 后 write 前 daemon crash → row 回滚重投；**write 后 crash → 不重投且 observed 未越推**（显式断言现行语义 + 保守 freshness）。 |
| §3.3 | mixed stream batch：admission 后各 stream 推进各自覆盖值；observe-only batch 无 Respond 指令；混合 batch 指令只引用 turn 条目。 |
| §5.1 signal-only | 409 载荷零正文；daemon 收 409 后 observed 不动，uninformed retry 仍 409；正常投递 admission 后 retry 通过。 |
| §5.2 thread 差集 | 非 follower thread send 409 → 窗口行已物化为 observe delivery；成功 retry 的 follow-backfill 幂等命中同一行（无二次投递）。 |
| §5.2 universe | 各通知类消息（成员/审计/DM）→ 有全员 delivery，agent 不被永久卡 send；schedule_fire 不推 head，owner delivery 推过 head 后 CAS（`head <= seen`）仍通过。 |
| P-C 回归 | 复现原双曝光时序 → 正文只经正常 admission 出现一次（409 中零正文）。 |
| §3.4 fail-closed | 模拟 `turn_end` 丢失：reservation 超时不写入、pending 保持、诊断事件发出；恢复信号到达后正常合批。 |
| 迁移 | capability 协商矩阵：旧 daemon × 新 backend 收旧 contract；新 daemon 收 body-free。 |
| P-A 回归 | 积压 N 条 → 1 个 batch turn 全部进入。 |
| P-C 回归 | 复现双曝光时序 → 正文只经一个输入面出现。 |

## 9. Open items

- Qoder `turn_end` 信号已证实成且稳定（#1556 双实验各 turn 均产生 terminal
  result）；Phase 2 内仍需验证 reservation 状态机在 crash/restart 下的行为。
- OpenCode 多条 pending prompt 的 batching/ACK 语义实测（Phase 2 内）。
- Claude 无 `priority` 默认行为、并发 steer 顺序、无 tool turn 注入（Phase 1 内）。
- `pending_input` / `stale_event_expired` 等 CLI 错误码与 `docs/cli-system.md`
  同步（实施期）。
- batch 上界数值（条数/bytes）：Phase 2 用真实分布定，机制先行。
- 更强的 durable delivery（"runtime crash 前模型必见"）：**独立产品合同**，明确
  不在本设计范围。

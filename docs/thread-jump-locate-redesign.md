# #1317 重修设计 — thread 首条未读锚定(去 wall-clock、有界退出)

状态:**v3 / implemented**(@Alice 架构 PASS、@Cindy window-lock + 单一定义 blocking 均已收口;gate 全绿,in_review)。落地见 §6。作者 @Norman。
前情:原实现 `1c846fa` 已 revert(HEAD `dc149c2`),因把一个 best-effort 的 wall-clock epoch
升成"是否渲染 / 是否 locate"的 correctness 门,且 loader/locate/clearJump 成无终止闭环 → thread 永久转圈(P0)。

---

## 1. 两个 bug,别混

**(A) 原始需求 bug(#1317 要解的)**:进入 thread 时,有时没锚定到最早未读。
**(B) P0 回归(#1317 引入的)**:某些 thread 打开后消息永远转圈,不可读。

重修必须**同时**解 A、又不重蹈 B。下面先讲清各自根因。

### 1.1 A 的根因:locate 与 around-window 提交的竞态

jump-open 的数据路径:
- App 把首条未读 reply id 作为 `jumpMessageId` + `jumpPrimePending` 传给 ThreadPanel;
- controller `requestJump` → `primeAround(channelId, targetId, {threadRootId})`;
- `primeAround` fetch **around-window**(以 target 为中心),然后 **`setQueryData` 整表替换** cluster 缓存
  (`hooks.ts:798`),该 window 必含 target row;仅此 open 的权威窗口。
- 期间 cluster query 被 `enabled=false` 挂起(`clusterInitialFetchEnabled`),避免空缓存 latest fetch 抢跑 primeAround。

revert 后的 locate effect(`ThreadPanel.tsx:503`)**一拿到 `jumpMessageId` 就立即启动** rAF 轮询找
`#msg-<target>`,**不等 around-window 提交**。于是:
- **reopen** 时 React Query 对 disabled query 仍同步吐**上一次 open 的 stale 窗口**(`query.data` 不因 disabled 清空);
- 若 stale 窗口恰含 target → 立刻滚到 stale 位置、起 3s flash;primeAround 随后整表替换 → 布局重排 → 滚动漂走 → 锚定看着"没对准";
- 若 stale 窗口不含 target,且 primeAround 在 60 帧(~1s)内没提交 → 轮询耗尽 → `onJumped` → `clearJump` →
  jumpTarget 清空 → primeAround 之后才提交(含 target)但 jump 已没了 → **永远不锚定**。

→ A 是 **locate 跑在了错误(stale/空)窗口上**,本质是"locate 该等这次 open 的 around-window 落地"。

### 1.2 B 的根因:advisory 信号升 correctness 门 + 无终止闭环

`1c846fa` 用 `hasFreshWindow = windowFetchSucceededAt >= openedAt`(两个 `Date.now()` 跨组件比较)同时当
渲染门和 locate 门,而清 `jumpPrimePending` 的唯一出口(locate→onJumped→clearJump)又要 `hasFreshWindow`。
epoch 跨组件无 happens-before,小 thread prime 极快 / reopen / cache 都能让它恒 false → loader 永转、locate 永不启动、pending 永不清。

→ B 的教训(Alice 定性):**best-effort 信号(判错=漏 mark、下轮重试)绝不能复用成 correctness 门
(判错=thread 不可读);且任何门都必须有有界退出。**

---

## 2. 设计原则(复核三条,逐条对号)

1. **渲染门只看 committed 事实,零 wall-clock。**
2. **locate 用显式 prime 生命周期状态**(pending/committed/settled),**每条分支有界退出**,loader 绝无"既不渲染也不释放"第三态。
3. **锚定失败 graceful 退化到顶/底**,绝不退化成 loader 卡死。

关键手段:把 controller 里"prime 到底走到哪一步"从一个**布尔 `primePending`** 升成**显式三态**。
这是 committed 事实(controller 在 primeAround 的 `.then/.catch` 里确定性写入),不是 wall-clock。

---

## 3. Prime 生命周期状态机(controller,每个 attempt)

```
                       requestJump(target)
                            │
                            ▼
                       ┌─────────┐   primeAround fetch 在飞
                 ┌────►│ priming │   (query 挂起,防 latest 抢跑)
                 │     └────┬────┘
                 │          │ primeAround 结算(必然结算:网络 resolve/reject/abort)
                 │          ├──────────────► committed   (result.committed=true:around-window 已整表写入,含 target)
                 │          └──────────────► settled     (stale | aborted | not_found:本 open 无权威窗口)
                 │                                │
   新的 requestJump(attemptId++,旧 attempt 作废)  │
                 │                                │
                 └───────────── clearJump ◄───────┘   (locate 完成/放弃 → onJumped → 清 target+state=null)
```

- `priming`:fetch 在飞。**query 保持 disabled**(`enabled` 仍旧 gate 在 `state==='priming'`),防空缓存 latest 抢跑 primeAround。
- `committed`:`setQueryData` 已整表替换缓存为 around-window(必含 target)。**这是"本 open 窗口已就位"的 committed 事实**——不需要任何时间戳。
- `settled`:prime 无提交(stale/aborted/not_found)。本 open 没有权威 around-window;fallback。`not_found` 额外清 jumpTarget。
- `null`:无 jump,或已 `clearJump`。

**终止性证明**:`primeAround` 返回的 Promise 必然结算(fetchMessagesWindow 必 resolve/reject/abort),controller 的
`.then/.catch` 必把状态从 `priming` 推到 `committed` 或 `settled`。故 `priming` 不可能是终态。✓

**committed 是真·committed fact(@Alice 核实)**:`setQueryData` 整表写 around-window(`hooks.ts:798`)在 `primeAround`
resolve **之前**执行,controller 的 `.then` 里**之后**才落 `committed`——同一条异步链、单调推进。故任何看到
`phase==='committed'` 的 render,cache 必已含 around-window(含 target row)。这是"committed"作为渲染/locate 门的
底气:不需要任何时间戳去"猜"窗口到没到。

### controller API 变化(最小)

`useMessageJumpController` 把 `primePending: PrimePending | null`(布尔式)换成带状态:
```
type PrimePhase = 'priming' | 'committed' | 'settled';
// 暴露:primePhaseFor(conversationId, messageId): PrimePhase | null
```
- `requestJump`:置 `priming`。
- `.then(result)`:`result.committed` → `committed`;`stale`/`aborted` → `settled`(保 jumpTarget,给 fallback locate);
  **`not_found` → `null`(与清 jumpTarget 同处)**——not_found 已清空 jumpTarget,locate effect 会因 `jumpMessageId` null 早退、
  永不 `onJumped→clearJump`;若 phase 停在 `settled` 就成了无人消费的悬挂态(违反"无第三态"不变量,@Alice/@Cindy 硬性)。故直接打 `null`。
  **旧代码在 committed 时 `return` 保持 pending 布尔;新代码改为显式落 `committed`——但 committed 不等于解锁窗口(见下)。**
- `.catch`:AbortError / 其余错误 → `settled`(有界,§4.3 fallback)。
- `clearJump`:→ `null`(+ attemptId++,旧 attempt 的迟到 resolve 被 attemptId 守卫丢弃)。

**关键:一个 phase,三个派生消费,别再共用一个 `jumpPrimePending` 泛指(@Cindy blocking v1)。** 旧 `isPrimePendingFor`
的真实语义 = "窗口锁",它从 requestJump 一直 true 到 clearJump(committed 期也 true),正是**这个**让 `useThreadCluster`
的 query 全程 disabled、保护 primeAround 写入的 around-window 不被 latest refetch 覆盖。若把它收窄成 `phase==='priming'`、
committed 后就解锁,query 重新 enabled → RQ 可能因 stale/enable-transition 发 latest fetch 把 around-window clobber 掉,
locate 又对被覆盖的窗口找 target = 重新引入竞态。所以三条线必须拆开、各取所需:

| 消费 | 表达式 | 目的 |
|---|---|---|
| **window lock**(query enabled 抑制) | `phase==='priming' \|\| phase==='committed'` | 从 prime 开始到 clearJump 全程锁住 query,around-window 不被 latest 覆盖。**= 旧 `isPrimePendingFor` 语义,行为不变。** |
| **loader** | `phase==='priming'` | 只在 prime fetch 在飞时盖 loader;committed 必渲染行。 |
| **locate allowed** | `phase==='committed' \|\| phase==='settled'` | committed 时窗口仍被 lock 保护,target window 不会被抢走;locate 结束 clearJump 才解锁。 |

- controller 暴露:`primePhaseFor(conv, msg): PrimePhase | null`(喂 loader/locate),**并保留 `isPrimePendingFor` 但明确其含义 = window lock = `priming||committed`**(喂 query-disable)。这样 channel 主流 jump 的既有消费者(ChannelView/MessageList 也走 `isPrimePendingFor`)行为完全不变;它们同样有 committed-clobber 隐患,后续可按同一 phase 模型收敛(本次不强改,但命名不再误导)。

---

## 4. ThreadPanel 消费(三条线,各自有界退出)

App 下传 `jumpMessageId` + `jumpPhase`。ThreadPanel 从 `jumpPhase` 派生三条独立信号(§3 表):
**window lock** 喂 `useThreadCluster` 的 query-disable,**loader** 喂渲染,**locate allowed** 喂锚定。
不再用一个泛泛的 `jumpPrimePending` 同时喂三处。

### 4.0 window lock —— 保护 around-window(committed 期仍锁)

```
jumpWindowLocked = jumpPhase === 'priming' || jumpPhase === 'committed'
```
`useThreadCluster(channelId, rootMessageId, { jumpWindowLocked })`(即把旧 opt `jumpPrimePending`
更名 `jumpWindowLocked`,值 = lock)。committed 期 query 仍 disabled → primeAround 写入的 around-window
不会被 latest refetch clobber。`settled` / `null` 解锁 → fallback latest fetch 可以填面板(§4.3)。
解锁的真正时机是 `clearJump`(locate 完成/放弃后把 phase 打回 null)。

### 4.1 loader 门 —— 只看 committed 事实

```
showLoader = cluster.isLoading || jumpPhase === 'priming'
```
- `isLoading`:普通 open 的 latest fetch 在飞(disabled+无数据时 React Query 的 isLoading=false,故 priming 期不能靠它,需第二项)。
- `jumpPhase === 'priming'`:jump-open 正在 prime,**无条件盖 loader**(即使 reopen 有 stale 行也不渲染 stale)。
- **不再有 `hasWindow`/`hasFreshWindow` 项**——`hasWindow` 会在 reopen 时把 stale 行漏出来;`hasFreshWindow` 是被 revert 的 wall-clock。

有界退出:`priming → committed`(controller 必然推进)→ loader 落 → around-window(含 target,必有行,且仍被 lock 保护)渲染。
`settled` → loader 落 → 走 fallback(下)。普通 open → isLoading 随 fetch 结算落。**无第三态**。✓

> 注:普通 open 的 reopen 仍会短暂显示 stale 尾巴(既有行为,非本次范围);jump-open 的 stale 泄漏被上面第二项彻底堵住。

### 4.2 locate 门 —— 显式 phase 驱动,每分支有界

locate effect 依赖 `[jumpMessageId, jumpPhase, onJumped]`,以便 phase 推进时**重跑**:

```
locateAllowed =
    jumpPhase === 'committed'  →  true   // around-window(含 target)已就位且仍被 lock 保护,轮询必找得到、不会被 latest 抢走
  | jumpPhase === 'settled'    →  true   // fallback:对当前缓存(stale 或 latest fallback)尽力找,有界放弃
  | jumpPhase === 'priming'    →  false  // 窗口未定,绝不对 stale 窗口 locate(这是 A 的根因)
  | jumpPhase === null         →  false  // 无 jump
```

locate 执行(沿用 revert 版 rAF 轮询,已自带有界退出):
- `locateAllowed` 为 false → effect 早退(但 phase 变化会重跑)。
- 为 true → rAF 轮询 `#msg-<target>`:找到 → `scrollIntoView` + flash 3s → `onJumped`;
  60 帧(~1s)找不到 → `onJumped`(放弃)。
- 两条路都以 `onJumped → clearJump` 收尾 → phase→null、window lock 释放,jump 结束。**无"既不渲染也不释放"**。✓

因为 loader 门在 `committed` 已放行(around-window 有行、target row 已挂 DOM)且窗口仍被 lock 保护,locate 在 `committed`
一定能拿到**正确窗口的** DOM node——既无 revert 版"对 stale 窗口误锚",也无 doc-v1 的"committed 后被 latest clobber"。

### 4.3 锚定失败的 graceful 退化

- `settled`(prime 没提交)且 target 不在当前缓存 → 轮询 60 帧放弃 → `onJumped`。
- `committed` 但 target 意外未渲染(理论不该发生,§3 单调性已排除)→ 同样 60 帧放弃 → `onJumped`。
- 放弃后:**回落到真·线程尾**——若 `shouldResetToLatest`(窗口 mid-history / 有 forward live-gap)为真,调 `resetToLatest()`
  重取 tail 窗口;否则 `pinBottomRef=true` 滚当前窗口底。绝不停在半路 stale 滚动位、绝不卡 loader。
  (@Cindy 点 3:只设 `pinBottomRef=true` 滚当前窗口底,可能停在 mid-history/stale 窗口的底而非线程尾。)
- **pin 时机(@Alice 点 1)**:revert 版一拿到 `jumpMessageId` 就无条件 `pinBottomRef.current=false`(ThreadPanel:505)。
  新模型 priming 期 loader 盖着、不该动 pin——把置 false 挪到**真正开始 locate 时**(`locateAllowed` 为真,即 committed/settled),放弃分支再按上条收回 true。
- **committed 是唯一权威 locate(@Alice 点 2)**:`settled` 只对当前缓存尽力找一次,找不到直接退底部、**不 latch stale 滚动位**。
  `not_found` 已清 target 不进 locate;`settled` 剩下基本只有 primeAround 抛错的罕见 case,有界且退化明确。

---

## 5. mark-read 门:**不动**

`threadMarkReadSnapshot` 继续用 `windowFetchSucceededAt >= openedAt`。**这是它的原生 best-effort 场景**
(#1226):判错最坏漏一次 open-time mark,下轮 dep 变化(新 reply / refetch)自愈,低风险。
B 的错误是**把这个 epoch 挪去当渲染/locate 的 correctness 门**——重修**不复用**它到 §4 的任何门。
`primeAround` 仍旧 stamp epoch(`hooks.ts:807`)供 mark-read;§4 不读它。

---

## 6. 改动清单(落地时)

**phase enum 是唯一真相源,三条投影各自独立命名,永不复用一个泛化布尔(@Alice/@Cindy DDD 硬性)。**

1. `useMessageJumpController.ts`:`primePending` 布尔 → `primePhase` 三态;新增 `primePhaseFor(conv,msg)`;
   `requestJump/.then/.catch/clearJump` 按 §3 写状态。**保留 `isPrimePendingFor` 但其含义明确 = window lock**,
   实现委托到共享的 `jumpWindowLockedForPhase`(见 0.)——行为不变,喂 query-disable;channel 主流 jump 消费者不受影响。
2. `App`(各 jump 装配处):从 phase 派生并下传两条独立线——`jumpWindowLocked = jumpWindowLockedForPhase(phase)`(喂 query)
   + `jumpPhase`(喂 loader/locate)。**不再下传泛泛的 `jumpPrimePending`。** 注意有多个 jump surface(parent/secondary/thread/activity),都要接。
3. `useThreadCluster` opt:`jumpPrimePending` → `jumpWindowLocked`(值 = lock,ThreadPanel 传 `jumpWindowLockedForPhase(jumpPhase)`,行为等同旧 `isPrimePendingFor`)。
4. **`messageJumpPhase.ts`(新增,无 React 依赖的纯模块)**:`JumpPhase` 类型 + **window-lock/locate 两条 phase 投影的唯一定义**——
   `jumpWindowLockedForPhase(phase) = phase==='priming'||phase==='committed'` 与 `threadLocateAllowed(phase) = phase==='committed'||phase==='settled'`。
   controller 与 ThreadPanel 都 import 它,单元测试 `messageJumpPhase.test.ts` 直接挂在这两个函数上——**谓词全局唯一定义、测试挂在真身**(@Cindy blocking / @Alice 推荐)。
5. `threadMarkRead.ts`:`threadClusterShowsLoader` 签名 → `{ isLoading, jumpPhase }`,返回 `isLoading || jumpPhase==='priming'`(去掉 `hasWindow`/wall-clock freshness 项)。
   loader 项留在 render/mark-read 家族里;window-lock/locate 两条 phase 投影已迁到 `messageJumpPhase.ts`(4.)。
6. `ThreadPanel.tsx`:
   - loader 调用改用新签名;`useThreadCluster` 传 `jumpWindowLockedForPhase(jumpPhase)`;
   - locate effect 依赖加 `jumpPhase`,起头 `if (!threadLocateAllowed(jumpPhase)) return;`;
   - `pinBottomRef.current=false` 从"拿到 jumpMessageId"挪到"locateAllowed 为真时"(§4.3 点 1);放弃分支恢复 pin-bottom。
7. **删除**上一版遗留的 `threadLocateReady` / `hasFreshWindow` 相关(revert 已删大部分,确认无残留)。

## 7. 测试(node 纯函数层,无 RTL)

- `jumpWindowLockedForPhase`(`messageJumpPhase.test.ts`,即 query-disable 真身):priming→true;**committed→true**;settled→false;null→false。
- `threadLocateAllowed`(`messageJumpPhase.test.ts`):priming→false;committed→true;settled→true;null→false。
- `threadClusterShowsLoader`(`threadMarkRead.test.ts`):priming→loader;committed→不 loader;settled→不 loader;isLoading→loader。
  **回归**:committed + reopen(有 stale 行)→ 不再因 stale 行提前落 loader(改由 priming 盖住,committed 才放)。
- **锁边界断言(@Alice 点 3,`messageJumpPhase.test.ts`)**:`committed` 时 `jumpWindowLockedForPhase` 仍为 **true**(→ `useThreadCluster` 的 query 判定仍 disabled)——
  证明 committed 后 latest fetch clobber race 被这条锁堵死,而不只是"loader 会落"。committed 是"渲染放行"但"窗口仍锁"的组合态。
- controller phase 迁移(可在 hook 逻辑纯化后测):requestJump→priming;committed result→committed;
  stale/aborted/not_found→settled(且 not_found 清 target);clearJump→null;旧 attempt 迟到 resolve 被丢弃。
- **死锁不复现断言**:构造 priming→committed 序列,证明 loader 在 committed 必落、locate 在 committed 必允许——
  即"清 pending 不再依赖 locate、locate 不再依赖 wall-clock",闭环被打破。

## 8. 复核状态

三问(@Alice / @Cindy 均已判):
1. **渲染门只读 committed 事实、零 wall-clock** → §4.1:`isLoading || phase==='priming'`,phase 是 controller 确定性写入的生命周期,非时间戳。✅ Alice PASS(并核实 §3 committed 单调性)。
2. **locate 每分支有界终止、无第三态** → §3 终止性证明 + §4.2 两条路都 `onJumped`。✅ Alice PASS。
3. **锚定失败 graceful 退化到底部** → §4.3 放弃→pin-bottom。✅ Alice PASS。

**并入的 blocking(@Cindy,@Alice 定性背书)**:老 `jumpPrimePending` 一名扛两生命周期(window-lock + visual-locate-pending)——
这才是 #1317 更深病根,wall-clock 只是表层。v1 doc 把它收窄成 `priming` 砍掉了 window-lock → committed 后 latest clobber around-window。
**修正已并入(v2)**:phase enum 为唯一真相源,三条独立命名投影 `jumpWindowLocked`(=`priming||committed`) / `showLoader`(=`priming`) /
`locateAllowed`(=`committed||settled`),见 §3 表、§4.0、§6、§7 锁边界断言。committed = "渲染放行 + 窗口仍锁" 组合态。

**收尾 blocking(@Cindy,@Alice 背书 + 推荐更干净方案)**:v2 里 `jumpWindowLocked` 谓词有两处平行表达式(controller 内联 + `threadMarkRead.threadJumpWindowLocked`),巧合相等、易漂移。
**已按推荐方案收口(v3)**:抽独立无 React 依赖纯模块 `messageJumpPhase.ts`,`JumpPhase` + `jumpWindowLockedForPhase` + `threadLocateAllowed` 全部单一定义住此处,
controller / ThreadPanel 都 import 它,`threadJumpWindowLocked` 删除。单测 `messageJumpPhase.test.ts` 直接挂在共享谓词上——window-lock 谓词全局唯一定义、测试挂真身。gate 全绿(typecheck + 1371 tests)。

## 9. 遗留/权衡

- 普通 open reopen 的短暂 stale 尾巴:既有行为,不在本次消除(要消除需 open 时 clear cluster 缓存,成本与闪动权衡,单列)。
- `AROUND_MESSAGE_LIMIT` 若小于 target 到窗口边界的距离,around-window 仍含 target(以 target 为中心),不影响锚定;跨页更早 reply 的 locate 属 follow-up。

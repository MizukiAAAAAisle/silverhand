# Incident 2026-05-08 — Claude `--input-format stream-json` 空 stdin 启动死锁（误诊为「大 jsonl resume 慢」）

跟同一天的 codex init-watchdog incident **同根异源**（那份 codex 复盘已作为过程文档清理，结论留在下方对照与 git 历史）：

- 那次（codex）：npm wrapper 冷启动 10–22s + `thread/start` 往返撞 30s 线，确实是「冷启动慢」。
- 本 incident（claude）：**与启动慢、jsonl 体量、--resume 流程通通无关**。根因是 `claude --input-format stream-json` **必须**收到第一条真实 user message 才会发 `system.init`；silverhand 在 inbox 为空时 spawn 了 claude，于是 claude 永远不发 init，30s init watchdog 必然杀掉。

> **本次 doc rewrite（2026-05-08，#168）**：原诊断「大 jsonl resume 慢」是**错的**。在跑了完整四象限矩阵（jsonl 大小 × stdin 是否预热）实测 + 同一 session 历史日志对比之后，根因 100% 锁定到「空 stdin 启动死锁」。下文 §3 / §5 / §7 已按事实重写；旧版本只保留在 git 历史里。

---

## 0. 简明结论

- **根因**：claude `--input-format stream-json` 在收到第一条真实 user message 之前**永远不会**发 `system.init`。这与 jsonl 体量、是否 `--resume`、wrapper vs bundle 都无关，是 claude CLI 协议的刚性约束。
- **触发条件**：silverhand 用 `start()` 路径 spawn claude 时，如果该 (channel, agent) 的 inbox 当下为空（典型场景：用户点「重启 agents」但没有未投递消息），现有 `doDrainInbox` 在 `items.length === 0` 时直接 return 不写 stdin，于是 claude 永远 silent。
- **症状**：UI 显示 "connecting"，DB 写 `crashed`，30s 后 SIGTERM。
- **PR-A 三层 watchdog 不修这个 incident**：spawn 后 ~1.1s 收到 `system.hook_started` 帧 → manager 进入 post-protocol 阶段 → 30s 后 `reason=post_protocol` 触发 SIGTERM。retry-once 也救不了，因为第二次仍然空 stdin。
- **真修法**：driver `kickoffMode='requires_first_message'` + manager **deferred init watchdog**——claude empty-inbox spawn 后正常拿 pid 并标 `active`，但**不 arm init watchdog**；等真正第一条 user message 写入 stdin 时再 arm。task #167 跟踪实现。
- 旧 30s 单层 watchdog 部署版本本来就该被 P1（PR-A）三层 watchdog 替换，但 PR-A 也只是缓解 codex 那个 incident，对本 claude incident 是无效的；两件事必须分开看。

---

## 1. 用户可见的症状

UI 频道（`PxD4nCvw5mi-kbPG`）里点了「重启 agents」。codex agent (`hDl2uVMmgGs3tc_Z`) 1.2s 上线正常；claude agent (`Z18wRZX6Uhsoa2tw`) 一直停在 "connecting"，不点新动作就一直停那。

DB 实际状态：

```
sqlite> SELECT conversation_id, agent_id, status, cli_session_id
        FROM conversation_agents WHERE conversation_id='PxD4nCvw5mi-kbPG';
PxD4nCvw5mi-kbPG | Z18wRZX6Uhsoa2tw | crashed | ff971918-96ff-48ed-bf40-104cc386e096
PxD4nCvw5mi-kbPG | hDl2uVMmgGs3tc_Z | active  | 019df457-d889-7ff0-9c41-dd98abe019d8
```

---

## 2. 时间线（北京时间，对应 backend log UTC 10:05–10:06）

```
18:05:25  POST /channels/PxD4nCvw5mi-kbPG/agents/Z18…/stop  (mode=hard)
18:05:30  hard stop: control_request didn't exit, sending SIGTERM
18:05:30  agent process exited code=143  (SIGTERM)
18:05:30  POST /channels/PxD4nCvw5mi-kbPG/agents/hDl2…/stop
18:05:35  agent process exited code=0   (codex 正常退)
18:05:35  POST /channels/PxD4nCvw5mi-kbPG/agents/Z18…/start
          → spawn /Users/shiki/.local/bin/claude --resume ff971918-96ff-48ed-bf40-104cc386e096 …
18:05:35  POST /channels/PxD4nCvw5mi-kbPG/agents/hDl2…/start
18:05:36  agent: session_init received, hDl2…  status → active   ← codex OK
18:05:37  chat-bridge: started (pid 46060) for Z18…
18:05:37  chat-bridge: connected to MCP transport                ← bridge 一侧 OK
          ……（之后整整 30 秒，claude 完全 silent，
          没有 stream-json 事件，没有 stderr 输出，
          也没有 inbox: draining 日志—— inbox 空，drainInbox 无操作）
18:06:05  agent: session_init watchdog fired; killing child  elapsedMs=30000
18:06:05  agent process exited code=143  → DB 写 status=crashed
```

**关键缺失**：日志里**没有任何** `inbox: draining queued items into agent stdin`。这是诊断的入口——manager 的注释说 "schedule drainInbox immediately after spawn to prime stdin"，但因为 inbox 为空，drainInbox 是 no-op，**stdin 完全没被写过任何字节**。

---

## 3. 关键证据

### 3.1 实测：四象限矩阵 + 5 种 priming payload

@Alice 用 `/tmp/silverhand-claude-probe/probe.mjs` 模拟 silverhand 完整 spawn args（包含 `--input-format stream-json --output-format stream-json --verbose --model opus --system-prompt-file --mcp-config --strict-mcp-config`，`mcpServers={}` 跳过 chat-bridge），timeout 60s：

| 试验 | --resume | jsonl size | 预热 stdin | first stdout | first session.init |
|---|---|---|---|---|---|
| baseline-fresh | 无 | — | 无 | 1.12s | **从未到达** |
| A-tiny-empty | b615dfdf | 2 KB | 无 | 1.15s | **从未到达** |
| C-large-empty | ff971918 | 5.6 MB | 无 | 1.19s | **从未到达** |
| B-fresh-primed | 无 | — | `"ping"` | 1.09s | 1.19s ✓ |
| D-tiny-primed | b615dfdf | 2 KB | `"ping"` | 1.13s | 1.16s ✓ |

**关键观察**：
- 三种 jsonl 配置（无、2KB、5.6MB）+ 空 stdin 行为**完全一致**：~1.1s 内吐一条 `{"type":"system","subtype":"hook_started"}`，然后无限静默。**jsonl 体量是 red herring**。
- 任何 well-formed stdin user message → session.init 在 1.2s 内到达。

priming payload 进一步实测（`probe-payload.mjs`）：

| Payload 形态 | hook_started | system.init | assistant turn | 真实 API cost |
|---|---|---|---|---|
| `content: ""` | ✓ | ✓ | ✓ "pong" | $0.0099 |
| `content: []` | ✓ | ✓ | ✓ "Standing by..." | $0.12 |
| `content: null` | ✓ | ✗ | ✗ | $0（error_during_execution） |
| `{type:'user'}` (无 message) | ✓ | ✗ | ✗ | $0（永远 silent） |
| `{message:{role:'user'}}` (无 content) | ✓ | ✗ | ✗ | $0（error_during_execution） |

**关键观察**：claude 的 `system.init` 帧只在**真实 turn 开始**时才发；任何 well-formed user message → 真实 API 调用 + assistant 文本 + transcript 落盘 + UI 可见消息 + token 计费。**没有 no-op priming payload 可以让 claude 既走到 init 又不触发 chargeable turn**。

### 3.2 同一 session 的 with-inbox / without-inbox 对照

@Cindy 拉了同一个 `ff971918…` 5.6MB jsonl 在不同条件下的两次 spawn 历史日志：

| 时间 | 条件 | spawn 后行为 | 结果 |
|---|---|---|---|
| 09:47:46 | spawn 时 inbox 有 pending items | 1ms 后 `inbox: draining ... 345 bytes stdin` | 8.3s 收到 `session_init` ✓ |
| 10:05:35 | 用户点「重启 agents」，inbox 空 | 无 `inbox: draining` 日志 | 30s 后被 watchdog 杀 |

**关键观察**：同一份 jsonl、同一个 binary、同一组 args，**唯一变量是 spawn 时是否同步写了 stdin**。这把「jsonl 慢导致 init 慢」假设彻底排除掉。

### 3.3 jsonl 完好

```
$ wc -l ~/.claude/projects/-Users-shiki-workspace-silverhand/ff971918-…jsonl
3501 lines
$ jq -c . < .../ff971918-…jsonl > /dev/null   # 全部 parse 通过
$ tail -1 .../ff971918-…jsonl | jq .type
"last-prompt"
```

3501 行全部 well-formed JSON，尾部是正常 `last-prompt` 帧。**没有 SIGTERM 写坏文件**。

### 3.4 manager 侧 smoking gun

`packages/backend/src/conversation-manager.ts:1810-1811`：

```ts
const items = this.inboxes.listPending(handle.conversationId, handle.agentId);
if (items.length === 0) return;
```

`doDrainInbox` 在 inbox 空时直接 return，不写 stdin。但 `start()` 在 spawn 后立刻 `drainInbox(handle)`（cm:773），注释自述目的是「prime stdin so claude `--input-format stream-json` doesn't hang on the empty stdin race」。**这两段代码合在一起的现实效果是：empty inbox 路径下 priming 是 no-op，claude 必然 hang**。CLAUDE.md 里的注释把这个失败模式描述成「intermittent」，实测是 **deterministic**。

### 3.5 PR-A 三层 watchdog 在本 incident 上的行为推演

| 阶段 | 时刻 | 事件 | 三层 watchdog 反应 |
|---|---|---|---|
| 0s | spawn | manager arm `silenceTimer(30s)` + `preProtoCap(5min)` | — |
| ~1.1s | claude 吐 `hook_started` | `classifyInitProgress(line)` 返回 `protocol_ready`（任何 well-formed JSON object 都算） | clear silence + cap，arm `postProtocolTimer(30s)` |
| 1.1s ~ 31s | 完全 silent，stdin 无内容 | — | postProtocolTimer 倒计时 |
| ~31s | postProtocolTimer 触发 | `failInitWatchdog('post_protocol')` | SIGTERM |
| ~31s + 任何时刻 | retry attempt 1（仍然空 stdin） | 同上链路 | 第二次还是 ~31s 后撞 `post_protocol` |

旧版本日志短语是 `"agent: session_init watchdog fired; killing child"`，PR-A 落地后会变成 `"agent: init watchdog fired; killing child" reason=post_protocol`，elapsedMs 从 30000 变 ~31000，还会自动 retry 一次但同样失败。**reason label 改了、时长略变，但 incident 本身仍然发生**。

---

## 4. slock-ai 的对照

slock 反编译产物在 `/Users/shiki/.npm/_npx/277f35d2ed0078b9/node_modules/@slock-ai/daemon/dist/chunk-NM2MFLQ7.js`。slock 没有这个问题的两个原因：

1. **没有 spawn-time init watchdog**（同 codex incident 一致）：`RUNTIME_PROGRESS_STALE_MS = 15min`，且只在 `lastActivity ∈ {working, thinking}` 时生效，超时只 broadcast 不杀（chunk:3475, 5204-5223）。所以即使 claude 永远 silent，slock 也不会主动杀它。
2. **slock 的设计 implicitly 等第一条真实消息才用 claude**：claude agent 的「上线」是用户消息触发的，不是单独的「重启 agents」按钮。inbox 永远在 spawn 时已就绪。

silverhand 的「重启 agents」是新增 UX，slock 没有对应概念，所以这条死锁路径在 silverhand 是新引入的。

---

## 5. 修复方案：deferred init watchdog + driver `kickoffMode`

> **`active` 语义澄清**：当前代码里 `status='active'` 隐含两件事——(a) 有 live handle / pid / 可 stop，(b) `initObserved=true`（CLI 已发 session.init）。本修复将 (a) 与 (b) 解耦，只保留 (a) 作为 DB 不变量；(b) 在 claude armed 状态下显式不成立，并在代码注释 + lifecycle test 里写清楚。

### 5.1 driver 接口

```ts
// drivers/index.ts
type DriverKickoffMode =
  | 'self_inits'              // codex / cursor: 启动后能自走 RPC handshake，等 session_ready
  | 'requires_first_message'; // claude: session.init 与第一个真实 turn 绑定

interface Driver {
  // ... existing fields ...
  readonly kickoffMode: DriverKickoffMode;
}
```

- `ClaudeDriver.kickoffMode = 'requires_first_message'`
- `CodexDriver.kickoffMode = 'self_inits'`
- `CursorDriver.kickoffMode = 'self_inits'`（oneShot，不走这条路径但保持显式）

### 5.2 manager 状态机

新增 `AgentHandle.initWatchdogArmed: boolean`（默认在 spawn 时按下面规则赋初值）。

`start()` 在 spawn 之后：

```text
hasKickoffInbox = inboxes.listPending(...).length > 0

if (driver.kickoffMode === 'self_inits' || hasKickoffInbox) {
  // 当前 PR-A 行为不变：立刻 arm 三层 init watchdog
  handle.initWatchdogArmed = true
  startInitWatchdog(handle)
  // 后续 drainInbox / direct write 会立刻把 stdin 写进去
} else {
  // requires_first_message + empty inbox → armed 状态
  handle.initWatchdogArmed = false
  updateAgentRuntime({ status: 'active', pid: child.pid })
  publish('agent_status', { status: 'active', reason: 'awaiting_first_message' })
  // 不 arm init watchdog；等第一条真实消息再补
}
```

`drainInbox` 与 `deliverMessage` direct stdin 写入路径，在**真正写第一行 stdin 之前**做：

```text
if (!handle.initWatchdogArmed) {
  handle.initWatchdogArmed = true
  startInitWatchdog(handle)
}
```

`observeInitProgress` 在 `initObserved || initTimedOut` 短路之前再加一行：

```text
if (!handle.initWatchdogArmed) return  // armed 阶段 hook_started 不触发 post-protocol timer
```

### 5.3 不变量（armed claude）

- `handles.has(key) === true`
- `handle.child.pid` 是真实 pid
- `status === 'active'`
- `initObserved === false`
- `initWatchdogArmed === false`
- `cli_session_id` 不变（resume 路径下保留旧 id；fresh 路径下保持 null）

新增 lifecycle tests 至少覆盖：
1. claude armed 状态下 `isRunning(conv, agent) === true`
2. armed 状态下 `stop(hard)` 走正常 SIGTERM 路径，最终 `status='idle'`
3. armed 状态下进程异常退出 → exit handler 翻 `status='crashed'`
4. armed 状态下第一条 message 进 inbox → spawn 不被重复触发，drainInbox 写 stdin 并 arm watchdog
5. armed 状态下 `hook_started` 帧到达 → 不触发 post-protocol timer（regression guard）
6. armed → 第一条消息 → claude 8s 内发 `system.init` → `cli_session_id` 回填、`initObserved=true`、watchdog 清空

### 5.4 不需要做的事

- **不动 DB enum**（`status` 仍用现有 `idle/starting/active/crashed`）
- **不动 DTO**（`reason: 'awaiting_first_message'` 只在 ephemeral `agent_status` event 里携带，不持久化、不进 GET 响应；前端订阅事件即可决定 UI 展示）
- **不写假 pid / 假 status**（`active` 配合真实 pid，invariant 干净）
- **不 stdin priming**（实测验证 5 种 payload 全部产生 chargeable turn 或不发 init，无 no-op 路径）
- **不 lazy-spawn**（保留 spawn 即占资源的代价，换取首次消息零冷启动延迟；后续如果观察到 idle agent 内存压力再补 idle eviction 策略）

---

## 6. 调试小抄

报告「channel 里 claude agent 重启完一直 connecting」按这个顺序：

1. **DB 真实状态**：

   ```
   sqlite3 ~/.silverhand/silverhand.db \
     "SELECT conversation_id, agent_id, status, cli_session_id, pid
      FROM conversation_agents WHERE conversation_id='<channel-id>';"
   ```

   - `status='crashed'`、`cli_session_id` 任何值 → 大概率是本 incident（empty stdin 死锁），不分 resume / fresh。
   - `status='crashed'`、cli_session_id 空 → 全新会话也起不来 → 排除本 incident，看 launcher / system-prompt 这条线。

2. **关键日志检查点**：

   ```
   grep "<channel-id>.*<agent-id>" ~/.silverhand/logs/backend-<latest>.log \
     | grep -E "spawn|inbox: draining|session_init|watchdog|exited"
   ```

   命中本 incident 的 fingerprint：
   - 有 `spawn` 行（claude 启动）
   - **没有** `inbox: draining queued items into agent stdin` 行 ← 关键
   - 有 `session_init watchdog fired; killing child` 或新版的 `init watchdog fired; killing child reason=post_protocol`

   不是本 incident：
   - 有 `inbox: draining ...` 但仍超时 → 是真的启动慢（codex 那个 incident 或别的成因）
   - `code:"thread_not_found"` → 5/4 codex thread/resume 那个 incident

3. **chat-bridge 日志**（辅助确认 bridge 不是瓶颈）：

   ```
   tail ~/.silverhand/logs/chat-bridge-<channel-id>-<agent-id>.log
   ```

   - 看到 `chat-bridge: connected to MCP transport` 但**之后没有任何 tool 调用** → bridge 起来了，claude 自己没走到调 MCP，命中本 incident。

4. **不要去验 jsonl 体量**：本 incident 跟 jsonl 大小无关，浪费时间。

---

## 7. Follow-ups

- **task #167（@Cindy 实施）**：实现 §5 的 deferred init watchdog + `Driver.kickoffMode`，包含 §5.3 列出的 lifecycle test 覆盖。范围限制在 backend manager / driver / 测试，不动 DTO / DB / 前端。
- **task #168（@Alice 本次提交）**：本文档重写（已完成）。
- **桌面 app 重新打包发布**：把 `refactor/ws` 上的 PR-A（三层 watchdog）+ #167（deferred init watchdog）合在一起重新打包到 `/Applications/Silverhand.app`，旧 30s 单层 watchdog 才会真正退役。
- **CLAUDE.md 注释更新**：把「`claude --input-format stream-json` hangs **intermittently** if stdin starts empty」改成「**deterministically** hangs if stdin starts empty」，并指向本文档；说明现在的修复是 deferred watchdog + 不强制 stdin priming。
- **后续观察 idle 资源占用**：armed claude 进程常驻 ~200MB；如果出现「多 channel × 多 agent 全部 armed」的实际内存压力，再考虑 idle eviction（N 分钟无 stdin/stdout → 软停 + 下次消息重 spawn）。先不做。
- **UI 对 `reason=awaiting_first_message` 的渲染**：建议把 status row 显示成 `Online · waiting for message`，跟 `Connecting` / `Away` 区分开。前端单独做，不阻塞 #167 backend 落地。
- **不再追的方向**：jsonl 体量监控（无关）、stdin priming payload（已穷举，无 no-op）、silverhand 自管 claude history（用户已否决：成本太高、break 太多）。

---

## 附录：实验文件位置

`/tmp/silverhand-claude-probe/`：
- `probe.mjs` — 完整 silverhand-style spawn 探针，可控 `--resume <id>` / `--prime <text>` / `--timeout <ms>`，输出 timestamps + json 帧 + stdout/stderr 字节统计。
- `probe-payload.mjs` — priming payload 变体测试（empty-array / null-content / no-message / malformed / empty-string-text）。
- `*.log` — 各 cell 原始 detail 输出，含 first 50 stdout lines 样本。

复现时如需测 `--resume` 大 jsonl，直接用 `~/.claude/projects/-Users-shiki-workspace-silverhand/` 下任意现成 session id 即可（empty-stdin cells 不会写 jsonl，安全；primed cells 会触发真实 turn 并写入 transcript，注意 cost / 污染）。

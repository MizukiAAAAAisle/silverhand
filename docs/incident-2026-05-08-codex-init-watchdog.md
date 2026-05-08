# Incident 2026-05-08 — Codex `session_init` watchdog 30s 太严，npm wrapper 冷启动撞线

> **同根异源**：同一天的 [incident-2026-05-08-claude-resume-init-watchdog](./incident-2026-05-08-claude-resume-init-watchdog.md) 是 claude `--resume` 大 jsonl 撞同一根 30s 线——根因都是 §5 P1 三层 watchdog 还没打包发布。

跟 [incident-2026-05-04-codex-thread-resume](./incident-2026-05-04-codex-thread-resume.md) 是**两类不同问题**：

- 5/4 那次：`thread/resume` 完成前 Silverhand 抢跑 `turn/start`，命中 `thread not found`。
- 本 incident：codex `app-server` 进程冷启动从 spawn 到首个 `thread/started` 偶发超过 30 秒，触发 Silverhand 的 `INIT_WATCHDOG_MS=30s` 被 SIGTERM 杀掉，根本没机会发 `session_init`。

## 0. 简明结论

silverhand 的 30 秒 init watchdog 对 codex CLI 的冷启动太严：

- silverhand 当前用 `which codex` → `/Users/shiki/.npm-global/bin/codex`（npm 安装的 Node wrapper 脚本）。
- 这个 wrapper 启动一次 `--version` 实测耗时 **10–22 秒**（fnm Node 加载 + dyld + `require.resolve` + 再 spawn 真正的 codex 二进制）。
- 加上 codex 本身 `initialize` → `thread/start` 往返，整体 spawn 到 `thread/started` 的耗时擦着 30 秒水线，时不时擦过去就被 watchdog SIGTERM。
- 一旦失败，Silverhand 把 `conversation_agent.status` 写成 `crashed`，下一次用户消息进来再触发 spawn → 再撞超时，反复循环。

slock-ai 同一段流程**完全不设 spawn-time 超时**——它只有一个 15 分钟的 "runtime progress stale" 检测，且超时只发 trace 不杀进程。所以 slock 永远不会复现这个 bug。

一句话：**watchdog 用来兜 Claude 的 `--input-format stream-json` 空 stdin race，但被错套到了启动开销 10s+ 的 codex 上。**

---

## 1. 用户可见的症状

`unexpected message` channel 里 Cindy（codex）一直 `crashed` 起不来。点 "重启" 按钮也没用，看起来就是死了。

DB 一查：

```
sqlite> SELECT conversation_id, agent_id, status, cli_session_id FROM conversation_agents
        WHERE conversation_id='kCni85f7OisAvpSc';
kCni85f7OisAvpSc | Z18wRZX6Uhsoa2tw | idle    | b04130e0-...   | (Alice OK)
kCni85f7OisAvpSc | hDl2uVMmgGs3tc_Z | crashed |                | (Cindy 一直起不来，且没有 cli_session_id → 走 thread/start)
```

后台 backend log 里看到的就是连续 8 次"30 秒 watchdog 触发"：

```
15:18:59 spawn → 15:19:29 watchdog SIGTERM (30s)
16:15:04 spawn → 16:15:34 watchdog SIGTERM (30s)
16:18:59 spawn → 16:19:29 watchdog SIGTERM (30s)
16:21:18 spawn → 16:21:48 watchdog SIGTERM (30s)
16:22:43 spawn → 16:23:13 watchdog SIGTERM (30s)
16:24:06 spawn → 16:24:36 watchdog SIGTERM (30s)
16:26:08 spawn → 16:26:11 session_init received ✓ (3 秒成功)
```

第 9 次蒙过去之后 Cindy 正常上线。

每次失败都 **正好 30 秒** 被 SIGTERM——典型的 watchdog 杀，不是 codex 自己 panic。期间 `~/.silverhand/logs/chat-bridge-kCni85f7OisAvpSc-hDl2uVMmgGs3tc_Z.log` 完全没生成，说明 codex 还没走到 `thread/started` 那一步（chat MCP 是在 `thread/start` 返回后才被 codex 拉起）。

---

## 2. 排除项

按可能性从高到低逐个排除：

| 假设 | 排除依据 |
|---|---|
| `xhigh` reasoning effort 被 codex 拒掉 | LRJ / PxD 两个 channel 同样传 `xhigh` 工作正常；手动用相同 args 跑 `thread/start`，1 秒内返回 `reasoningEffort:"xhigh"`。 |
| chat-bridge 启不来 / MCP 配置错 | 手动复现里 `mcpServer/startupStatus/updated name=chat status=ready` 正常返回；端口 / auth / `ELECTRON_RUN_AS_NODE=1` 都对。 |
| proxy 没注入 | `app_settings.proxy_url='https://127.0.0.1:7897'`、`proxy_runtimes='codex'`，`expandProxyEnv` 把 `https://` 改写成 `http://` 注入 `HTTPS_PROXY/HTTP_PROXY` + socks5 `ALL_PROXY`；成功的进程里 `lsof` 能看到 `127.0.0.1:7897` ESTABLISHED。 |
| `thread/start` 本身有 bug | PxD 的 `thread/resume`（21MB rollout）也超时过一次再重试就成功；`thread/start` 和 `thread/resume` 都偶发被 watchdog 杀掉。 |
| Silverhand 这边的 RPC 顺序 | 跟 slock 一样：`initialize` → `initialized` notification → `thread/start`，silverhand 也是同一个顺序（`drivers/codex.ts:113-118, 168-178`）。 |

---

## 3. 关键证据：codex CLI 冷启动超时

### 3.1 wrapper vs 原生 bundle 启动耗时

```
$ time /Users/shiki/.npm-global/bin/codex --version
codex-cli 0.128.0
real  22.86s   (重跑：21.82s, 10.62s)

$ time /Applications/Codex.app/Contents/Resources/codex --version
codex-cli 0.128.0-alpha.1
real   0.62s   (重跑：25.88s)
```

- npm wrapper 每次都要 10s+：fnm Node 启动 + `require.resolve('@openai/codex-darwin-arm64/package.json')` + `spawn(binaryPath)` 再走一遍 dyld。
- 原生 bundle 偶发也会到 25s（单独的 codex 二进制冷启动也有抖动），但平均更快，去掉了 wrapper 这一层。

### 3.2 sample 抓栈

失败的 wrapper PID（`pgrep -f "node.*codex.*kCni"`）`sample` 出来的栈一段时间停在 `_dyld_start`，过几秒之后才进入 `uv_run` → `kevent` 等子进程退出。即整个 30 秒里相当一部分时间花在 dyld / 加载 Node 运行时本身，根本没到走 RPC 的那一步。

成功那次（16:26:08）spawn 到 `session_init` 只用 3 秒，说明 dyld / wrapper 并不是恒定慢——但 macOS 这一层有抖动，时不时擦过 30s。

### 3.3 watchdog 行为

`conversation-manager.ts:1336-1358` 的 `armInitWatchdog`：

```ts
this.handle.initWatchdog = setTimeout(() => {
  if (handle.initObserved) return;
  this.ctx.logger.warn(..., 'agent: session_init watchdog fired; killing child');
  handle.initTimedOut = true;
  this.publish(handle.conversationId, 'agent_init_timeout', { ... });
  handle.child.kill('SIGTERM');
  setTimeout(() => handle.child.kill('SIGKILL'), 5_000).unref();
}, timeoutMs);
```

`timeoutMs` 是模块顶部的常量 `INIT_WATCHDOG_MS = 30_000`（`conversation-manager.ts:44-53`，注释说原本是为 Claude `stream-json` 模式空 stdin 不发 `session_init` 的 race 准备的）。

watchdog 触发时 `initTimedOut` 优先级压过 `intentionallyStopped`，子进程 exit 后强制把 status 写成 `crashed`（`conversation-manager.ts:557-562`）。

---

## 4. slock-ai 的对照

slock 反编译产物在 `/Users/shiki/.npm/_npx/277f35d2ed0078b9/node_modules/@slock-ai/daemon/dist/chunk-NM2MFLQ7.js`。关键差异：

| 维度 | slock | silverhand |
|---|---|---|
| codex 可执行文件解析（macOS） | 优先 `/Applications/Codex.app/Contents/Resources/codex`（原生 bundle），找不到才回退 PATH（chunk:1589-1594） | `which codex` → npm wrapper（`runtimes.ts:11-23`） |
| `model_reasoning_effort` 注入 | 写在 `thread/start.params.config.model_reasoning_effort`，per-thread（chunk:1729-1730） | `-c model_reasoning_effort=...` CLI 顶层 override（`drivers/codex.ts:69-71`） |
| **spawn / session_init 超时** | **无硬超时**。仅有 `RUNTIME_PROGRESS_STALE_MS = 15 * 60_000` 的 progress-based 检测，且仅在 `lastActivity ∈ {working, thinking}` 时生效，超时也只发 trace + broadcast，不杀进程（chunk:3475, 5204-5223） | 30 秒硬超时 → SIGTERM（`conversation-manager.ts:44, 1336-1358`） |
| chat MCP `startup_timeout_sec` / `tool_timeout_sec` | 30 / 120（chunk:1710-1712） | 30 / 120（一致） |
| `initialize` → `thread/start` 顺序 | `queueMicrotask(initialize)` → 等结果 → `initialized` → `thread/start`（chunk:1781-1787） | 完全一致（`drivers/codex.ts:113-118, 168-178`） |
| sandbox / approvalPolicy / developerInstructions | `never` / `danger-full-access` / standing prompt（一致） | 一致 |

**slock 不会复现本 incident** 的根本原因就是它没 spawn-time watchdog，给 codex 多久都行。slock 不是修了这个问题——它就是没把这个限制加进来。

---

## 5. 建议改动（按优先级）

> **`session_init` 语义澄清**：当前代码里 `session_init` 是 driver 把
> 「Codex 已经返回 `thread/started` / `result.thread`」「Claude 已经发出
> 第一个 stream-json 事件」翻译出来的 *thread-ready* 信号，**不是**
> 「子进程还活着」也**不是**「app-server 已经能走 JSON-RPC」的信号。本
> incident 里 watchdog 把这三件事压缩成同一条 30s 水线，导致 dyld /
> wrapper 冷启动撞线被 SIGTERM。下面 P1 的三层 timer 就是要把这三个阶段
> 拆开。

### 优先级 1：三层 init watchdog（byte liveness + pre-protocol cap + post-protocol session）

把单一 `INIT_WATCHDOG_MS=30s` 拆成 driver-aware 的三段式状态机，由 `ConversationManager` 实现状态转换、driver 只提供识别函数和 timer 字段。

**状态机**

```
spawn
 ├─ arm  silenceTimer(initLivenessSilenceMs)   ─┐
 └─ arm  preProtoCap(initPreProtocolCapMs)     ─┤── pre-protocol stage
                                                │
   stdout/stderr byte 到达        → reset silenceTimer
   driver.classifyInitProgress(line) === 'protocol_ready'
                                  → clear silenceTimer + preProtoCap,
                                    arm sessionTimer(initPostProtocolMs)
                                                ─┐
   driver.classifyInitProgress(line) === 'session_ready'
                                  → clear ALL timers, mark ready
```

任一 timer 到期 → SIGTERM（保留 5s SIGKILL 兜底）+ 上报 `agent_init_timeout`，附 `reason: silence | pre_protocol_cap | post_protocol`。

**driver 接口（新增）**

```ts
interface DriverInitContract {
  initLivenessSilenceMs: number;   // codex 60s / claude 30s
  initPreProtocolCapMs: number;    // 5 min（防 stderr 噪音永生）
  initPostProtocolMs: number;      // 60s（统一三端，吸收 proxy 半瘫恢复期；
                                   //      原 30s 在 socks5 短暂拒连时偏紧）
  classifyInitProgress(line: string): 'protocol_ready' | 'session_ready' | null;
  classifyInitFailure?(reason: string): 'transient' | 'fatal';  // 协议层错误用
}
```

约束：
- `classifyInitProgress` 必须 side-effect-free，且 `session_ready` 隐含 `protocol_ready`（manager 收到 `session_ready` 时也清 pre timers，按转移图执行）。
- byte liveness 监听原始 `child.stdout/stderr.on('data')`（不走 readline），避免半行 JSON / stderr 进度条不刷新。
- driver 实现里 `classifyInitProgress` 单独走管线，不要把 initialize response 伪装成 `ParsedEvent` 发到 UI（Codex 这边 `parseLine()` 对 initialize response 仍返回 `[]`）。

**Codex 实现细节**

- `protocol_ready`：child stdout 上第一条 parseable JSON-RPC object（最常见就是 `initialize` 的 response，不论 result 还是 error），证明 dyld + wrapper + app-server stdio 都已通；
- `session_ready`：`thread/started` notification 或 `thread/start.result.thread.id` 出现。

**Claude 实现细节**

- `protocol_ready`：第一个非空 stream-json 事件；
- `session_ready`：`session_init` 事件。

**retry-once + cooldown（manager 内存态，不持久化）**

- `agent_init_timeout` 后**自动 respawn 一次**，第二次用 2× `initLivenessSilenceMs`；
- retry 计数挂在 manager 的 `Map<(conversationId, agentId), {attempt, cooldownUntil}>` 上而非 `AgentHandle`（respawn 会创建新 handle）；
- 连续 ≥3 次 init 失败 → 写入 `cooldownUntil = now + X min`，期间用户消息不会触发自动 spawn；最终状态仍是 `crashed`（不新增 DB enum / DTO 字段），用 `reason: init_cooldown` 标记 + UI/通知文案区分；
- fatal 不 retry：launcher resolution 失败 / spawn errno 这类是 manager-level fatal；driver 的 `classifyInitFailure` 只覆盖协议层错误（如 `thread_not_found`）。
- 用户手动 stop 不进入 retry 路径。

**UI 一致性**

retry 阶段 row 状态从 `starting` 直接转 `starting (retry 1/1, slow cold start)`，不闪 `crashed → starting`。

### 优先级 2：codex bundle 优先（macOS 默认）

跟 slock 对齐——`runtimes.ts` 在 macOS 上把 `/Applications/Codex.app/Contents/Resources/codex` 排在 `which codex` 之前，**不做版本号一致校验**：用户已经通过装 Codex.app 接受了这个 binary，按版本号匹配只会让稍微不同的 release 静默退回慢路径。如果出现 alpha schema 不兼容，应该改 driver 同时 hold 两种行为，而不是退回 wrapper。

顺带把 `runtimes.ts` 里 `probeVersion` 的 3s 超时拉到 30s——wrapper 本来就要 10–22s，3s 探测会把已安装的 runtime 误报成 `version: null`（detection 本身不是本 incident 的成因，但同根，一起修）。

### 优先级 3：`-c model_reasoning_effort` verified-keep

经验证 `/Applications/Codex.app/Contents/Resources/codex --help`，bundle alpha（`0.128.0-alpha.1`）和 npm CLI（`0.128.0`）都通过 codex-rs 的 config 层支持 `-c key=value` 顶层 override，行为一致。当前 spawn-per-channel 模型下 `-c model_reasoning_effort=...` 与 `thread/start.params.config.model_reasoning_effort` 行为等价；driver 不变。

仅当未来切到 thread 复用 / 多 thread per process 时再一起改成 thread params。

---

## 6. 调试小抄

报告"channel 里某个 codex agent 起不来"时按这个顺序：

1. **DB 状态**：

   ```
   sqlite3 ~/.silverhand/silverhand.db \
     "SELECT conversation_id, agent_id, status, cli_session_id, pid
      FROM conversation_agents WHERE conversation_id='<channel-id>';"
   ```
   - `status='crashed'`、`cli_session_id` 空 → 走 `thread/start` 路径，新建 thread；高概率撞本 incident。
   - `status='crashed'`、`cli_session_id` 非空 → 走 `thread/resume`；先排查 [incident-2026-05-04-codex-thread-resume](./incident-2026-05-04-codex-thread-resume.md)，排除后再看是不是 watchdog 撞线。

2. **backend log 看是不是 watchdog 杀的**：

   ```
   grep "<channel-id>.*<agent-id>" ~/.silverhand/logs/backend-<latest>.log \
     | grep -E "spawn|session_init|watchdog|exited"
   ```
   - 失败间隔 **正好 30 秒**、连续 `agent: session_init watchdog fired; killing child` → 命中本 incident。
   - 失败有 `code:"thread_not_found"` → 不是本 incident，是 5/4 那个。

3. **chat-bridge 日志在不在**：

   ```
   ls ~/.silverhand/logs/chat-bridge-<channel-id>-<agent-id>.log
   ```
   - 文件不存在 → codex 还没走到 `thread/start` 返回那一步（chat MCP 在那之后才拉起）。
   - 文件存在但内容停在 `chat-bridge: started` → codex 已经起来，问题在更后面（不是本 incident）。

4. **手动验证 codex 启动耗时**：

   ```
   time /Users/shiki/.npm-global/bin/codex --version
   time /Applications/Codex.app/Contents/Resources/codex --version
   ```
   wrapper 经常 10s+ 就是本 incident 的诱因；如果两个都很快，说明今天 macOS 没抖动，重试几次大概率能蒙过去。

5. **临时绕过**：让用户在 channel 里多发几次唤醒消息，watchdog 触发后会重新 spawn——总有一次能蒙在 30 秒以内（这次第 9 次蒙过去了）。

---

## 7. Follow-ups

- **PR-A（task #163, @Cindy）**：实现 §5 P1 三层 watchdog + driver `classifyInitProgress` hook + retry-once / cooldown，附 focused tests。约束：driver 接口 side-effect-free，retry/cooldown 全部走 manager 内存态，不动 DB enum / DTO。
- **PR-B（task #164, @Alice）**：`runtimes.ts` macOS 上把 `/Applications/Codex.app/Contents/Resources/codex` 排在 `which codex` 之前（不做版本号校验）；`probeVersion` 超时 3s → 30s。
- **Doc rewrite（task #165, @Alice）**：本次 §5/§7 改写 + `session_init` 语义澄清（§5 顶部 callout）。
- **持续观察**：PR-A 落地后跟踪 `agent_init_timeout` 事件分布——按 `reason: silence | pre_protocol_cap | post_protocol | init_cooldown` 统计，确认三层 timer 的常量取值合理；如果 `pre_protocol_cap` 频繁触发，说明 wrapper 比预期更慢，需要把 P2 bundle 路径作为强约束推动用户安装 Codex.app 而不是 npm 全局。

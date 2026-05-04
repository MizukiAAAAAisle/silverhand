# Incident 2026-05-04 — Codex thread/resume "thread not found"

跟同一天的 [agent-shutdown](./incident-2026-05-04-agent-shutdown.md) 和 [agent-silent-turn](./incident-2026-05-04-agent-silent-turn.md) 是**第三类独立问题**：

- shutdown：进程挂死 / 孤儿
- silent-turn：模型选择 turn_end 不回话
- **本 incident：Codex 启动时报 `thread not found`**——最终确认是 Silverhand 在 Codex resume ready 前抢跑投递 inbox，不是 Codex 磁盘 thread 真丢

## 0. 简明结论

`cli_session_id` 和 Codex `threadId` 很多时候是同一个字符串，但语义不同：

- `cli_session_id`：Silverhand DB 里保存的“上次 runtime 会话 id”。对 Codex 来说，它只是下次启动时的 **resume 目标**。
- `threadId`：当前 `codex app-server` 进程里已经确认加载完成的 Codex thread。只有这个 id 才能安全用于 `turn/start` / `turn/steer`。

本 incident 的 bug 是 Silverhand 以前把两者过早等同：

```ts
this.threadId = io.spawnCtx.cliSessionId
```

这会让 spawn-time inbox drain 在 `thread/resume` 返回前抢跑发 `turn/start <旧 id>`。但新的 Codex 进程此时还没把旧 thread load 进内存，所以返回 `thread not found`。

修复后的 restart 流程：

1. Silverhand 发现旧 `cli_session_id`，启动 `codex app-server --listen stdio://`。
2. `CodexDriver.bindIO()` 只把旧 id 用作 `thread/resume` 的目标，不先设为可用 `threadId`。
3. `thread/resume` 返回 `result.thread.id` / `thread/started` 后，driver 才设置 `threadId` 并 emit `session_init`。
4. `SessionManager` 收到 `session_init` 后再 drain inbox，用户消息这时才变成 `turn/start`。

一句话：**restart 时先恢复 Codex thread，等 Codex 明确 ready 后，Silverhand 才投递用户消息。**

---

## 1. 用户可见的症状

silverhand 重启之后，Cindy（codex 跑的 agent）首次被唤醒时 chat 里出现：

```
@Cindy 启动失败：thread not found: 019deef8-0c47-76e3-8666-58fd1edbe65b
```

之后再发一句话，Cindy 能正常起来回话。看起来"自愈"了，但用户不知道刚才那条系统消息意味着什么。

**已确认的复现路径**：

- `pnpm dev` ↔ release dmg 互切。
- 同一份 release dmg 重启。
- **两份不同 build 的 release dmg 之间切换**（即使两边都是 Spotlight / Finder 启动、env 应当一致）。

→ 触发条件比一开始想的宽：只要 Silverhand 重启后首次唤醒 Codex agent 时有 pending inbox，spawn-time drain 就可能早于 `thread/resume` 完成。

---

## 2. 实际发生的事 — task #15 是按预期工作的

时间线（取一次 release 启动后的复现）：

```
19:14:01.661  warn: parsed error event from CLI
              { code:"thread_not_found", fatal:true,
                message:"thread not found: 019deef8-..." }
              ↓ classifyCodexError 命中 → handleFatalRuntimeError
              session_agents.status   → 'crashed'
              session_agents.pid      → null
              session_agents.cli_session_id → null   ← task #15 的关键清理
              ↓ 自动 post 系统消息 "@Cindy 启动失败: ..."
19:14:15.717  bridge restarts → 这次 cli_session_id 已经被清掉
              → driver 走 thread/start 而不是 thread/resume
              → 新 thread 019def43-... 创建成功
现在状态     EXDa7fp2 | active | pid 46851 | cli_session_id=019def43
```

所以 task #15 的恢复链路是完整的。后续排查确认：**触发 `thread not found` 的不是 codex 丢了磁盘 thread，而是 Silverhand 在 Codex resume handshake 完成前提前投递了用户消息**。

---

## 3. dev 看起来"没事"是漏报

同一份 SQL：旧的 dev backend log 里也有 `thread not found`，但**只有 plain warn，没有 `code:"thread_not_found", fatal:true`**：

```
17:44:59  dev (pid 56597)   {kind:"error", message:"thread not found: 019dee73-..."}
                            ← 没 code/fatal，classifyCodexError 还没合进来
18:22:38  dev (pid 90355)   同上
19:14:01  release (pid 46161) {kind:"error", message:"thread not found: 019deef8-...",
                              code:"thread_not_found", fatal:true}
                            ← release 是新打的，含 task #15
```

dev 跑的是 task #15 之前的旧 build，所以错误事件被 swallow，cli_session_id 不被清，下一次 spawn 还是 `thread/resume <旧 id>`，再次失败、再次被 swallow，循环。**dev 看起来"安静"是因为它根本没识别错误**，不是因为 codex 在 dev 模式下 resume 成功。

→ **第一件该做的事：确认 dev 也跑当前 main 的 backend build**，否则 dev 的诊断信号永远比 release 弱一截。

---

## 4. 根因：spawn-time inbox drain 早于 Codex thread/resume ready

数据本身没真丢，且后续用同一个 id 直接打 `codex app-server` 可以恢复：

- **磁盘 rollout 文件在**：`~/.codex/sessions/2026/05/04/rollout-2026-05-04T01-52-06-019deef8-...jsonl`
  - meta 段：`originator: silverhand`，`source: vscode`，`cwd: /Users/shiki/workspace/silverhand`，`cli_version: 0.128.0`
- **codex state DB 里 row 在**：`~/.codex/state_5.sqlite` `threads` 表
  - `archived=0`，`source=vscode`，`cwd=/Users/shiki/workspace/silverhand`，`cli_version=0.128.0`
- **直接 resume 成功**：手工启动 `codex app-server --listen stdio://` 后发送 `thread/resume`，`019deef8-...`、`019def43-...`、`019def7b-...`、`019def89-...` 都返回正常 `result.thread`。

所有近期 Cindy 创建的 thread 都是 `source=vscode` / `cli_version=0.128.0`，cwd 全部匹配 silverhand 给 codex 传的 spawn cwd。

silverhand 这边发的请求（`packages/backend/src/drivers/codex.ts:380-398`）：

```ts
{
  method: 'thread/resume',
  params: { threadId, cwd, approvalPolicy:'never', sandbox:'danger-full-access',
            developerInstructions, model? }
}
```

不带 `originator` / `source` / 任何"客户端身份"字段。

真正的问题在 `SessionManager.start()` 的启动顺序：

1. `CodexDriver.bindIO()` 以前把 `this.threadId = io.spawnCtx.cliSessionId`。
2. `SessionManager.start()` 在 `bindIO()` 后立刻执行 spawn-time `drainInbox()`，这是为了兼容 Claude 空 stdin 不发 `session_init` 的行为。
3. 对 Codex 来说，此时 `thread/resume` 还没有返回，新的 app-server 进程还没有把旧 thread load 到 core `thread_manager`。
4. 但 `encodeStdinMessage()` 已经看到 `this.threadId` 有值，于是把 queued inbox 写成：

```json
{"method":"turn/start","params":{"threadId":"019deef8-...","input":[...]}}
```

5. Codex app-server 的 `turn/start` 走 `load_thread()`，只查当前进程里已经 loaded 的 thread；此时 resume 尚未完成，所以返回：

```text
thread not found: 019deef8-...
```

因此这个错误不是 `thread/resume` 对磁盘 thread 的失败，而是 **resume 尚未完成时，Silverhand 过早发起了 `turn/start`**。用户手动重新启动 agent 能恢复，是因为 task #15 把 stale `cli_session_id` 清掉后，第二次不再 resume 旧 id，而是直接 `thread/start` 新会话。

### 和 slock-ai 的对比

本机的 slock 不是出现在 `npm ls -g` 里的普通全局包，而是 `npm exec @slock-ai/daemon@latest` 留下的 npx cache：

```
~/.npm/_npx/277f35d2ed0078b9/node_modules/@slock-ai/daemon
version: 0.44.2
```

对应 agent 工作区里的 `.slock/slock` wrapper 会直接执行这个缓存里的 `dist/cli/index.js`。

Slock 的 Codex driver 也走 `codex app-server --listen stdio://` + `thread/resume` / `thread/start`，并且同样在 `handleThreadReady()` 收到 `result.thread` / `thread/started` 后才 emit `session_init`、再启动 initial turn。

关键区别在调度层：

- Slock 启动时把 wake message 作为 `ctx.prompt` 交给 Codex driver；driver 的 `startInitialTurn()` 只有在 `handleThreadReady()` 之后才会发 `turn/start`。
- Slock 没有 Silverhand 这种“spawn 后立即统一 drain inbox 到 stdin”的路径。
- Slock 的 busy delivery 会调用 `encodeStdinMessage(..., {mode:'busy'})`，而 Codex busy mode 在没有 `activeTurnId` 时返回 `null`，不会退化成 `turn/start`。
- Silverhand 的 bug 正好来自相反组合：通用 spawn-time drain + Codex driver 预置旧 `cli_session_id` + `encodeStdinMessage()` 在没有 active turn 时发 `turn/start`。

所以本次修复和 Slock 的稳定行为是一致的：**首条 wake / inbox 消息必须等 Codex thread ready 之后再发**。

两边的实现方式不同：

- Slock：调度层不做 pre-ready drain，initial prompt 由 driver 在 ready 后发。
- Silverhand：保留通用 spawn-time drain 以兼容 Claude，但 Codex driver 在 ready 前返回 `null`，让 inbox 留在队列里等 `session_init` 后再投递。

### 已被排除的假设

| 假设 | 状态 | 依据 |
|---|---|---|
| dev 和 release 之间 env（`VSCODE_*` / `TERM_PROGRAM`）不同导致客户端身份不一致 | **不成立**（至少不是唯一原因）| 现象在两份不同 build 的 release dmg 之间切换时同样出现，两份 release 启动方式相同、env 应当一致 |
| codex state DB 里 row 被删 / archive | 排除 | row 在，`archived=0` |
| rollout 文件被删 | 排除 | 文件在 |
| cwd 不匹配 | 排除 | rollout 和 spawn 用的 cwd 都是同一个绝对路径 |
| cli_version 跨版本 | 排除 | 创建 / resume 都是 0.128.0 |
| codex `thread/resume` 只依赖 per-process memory | 排除 | 0.128.0 上游实现会通过 `LocalThreadStore.read_thread()` 从 sqlite/rollout 读 history；手工 app-server resume 已验证成功 |

---

## 5. 缓解措施

### 已实现

**本次修复 — Codex resume 期间不再把旧 `cli_session_id` 当作 ready thread id**：
- `CodexDriver.bindIO()` 仍然用 `cliSessionId` 构造 `thread/resume`，但不再预置 `this.threadId`。
- 在 app-server 返回 `thread/resume`/`thread/start` 的 `result.thread` 或 `thread/started` 之前，`encodeStdinMessage()` 会返回 `null`。
- `SessionManager.drainInbox()` 看到 `null` 会保留 inbox，不标记 delivered；等 `session_init` 后再 drain。

效果：重启 app 后第一次唤醒 Codex agent 时，不会再在 resume 尚未完成前抢跑 `turn/start <旧 id>`。

**Task #15 — 把 fatal "thread not found" 转成可恢复**：
- `packages/backend/src/drivers/codex.ts:449` `classifyCodexError` 把 `/thread not found/i` 标记为 `{code:'thread_not_found', fatal:true}`
- `packages/backend/src/session-manager.ts:823` `handleFatalRuntimeError` 在收到 `code='thread_not_found'` 时清掉 `cli_session_id`、status → `crashed`
- 用户再发一句话 → 下次 spawn 因为没 `cli_session_id` 走 `thread/start` → 新 thread

效果：不再卡死。现在它应该只作为真正 unexpected `thread not found` 的兜底，而不是正常重启路径的一部分。

### 没做的（按 ROI 排序）

1. **改善"@Cindy 启动失败"的措辞**（最便宜、最该先做）
   - 现在裸抛 `thread not found: <uuid>`，用户看不懂。
   - 改成："Cindy 启动时遇到旧会话恢复错误，已清理并可重新启动。如果问题持续，请保留这条错误消息。"
   - 实现位置：`session-manager.ts` `handleFatalRuntimeError` 里 `crashNotificationRecorded` 那段的 system message 文案（按 `reason` 分支处理）。
   - 价值：即使未来出现真正 stale thread，也让用户知道下一步。
   - 成本：单 PR，一段 if-else 文案。

2. **codex thread resume 失败时静默重建（不报系统消息）**
   - 如果 `thread/resume` 真的失败，可以考虑**不写 chat 系统消息**，只在 backend log 留警告，UI 上可选地在 agent 卡片角标短暂提示"上下文已重置"。
   - 风险：如果用户依赖 codex 的 long-running thread context 做接续工作，会以为还接着上次说，但其实 codex 那边已经没记忆了——静默会让这种 mismatch 更难发现。
   - 价值：提升日常 UX。
   - 成本：低，但要权衡上面的风险。建议至少在 UI 上保留"上下文已重置"的可见线索。

3. **绕开 resume —— 默认每次 spawn 都 `thread/start`，自己回放历史**
   - 实现：silverhand 维护自己的 message history（已有），spawn 时把最近 N 条作为 context preamble 注入 stdin / `developerInstructions`，不依赖 codex 端 thread 持久化。
   - 价值：把上下文恢复完全收回 Silverhand 控制。
   - 代价：codex DB 里 thread 数量膨胀；preamble 长度需要管理（compaction 触发 / token 成本）。
   - 适合时机：暂时降级为长期架构选项；当前 incident 已由启动竞态解释。

4. ~~**保持 dev / release env 一致以减少 thread 丢失概率**~~（**已废弃**——env 假设被复现否定）
   - 原方案：让 release 注入 `TERM_PROGRAM=vscode` 之类伪装 env，让 codex 把 release 也认成"vscode 客户端"。
   - 否定证据：现象在两份不同 build 的 release 之间（启动方式相同、env 一致）也会发生。env hack 即便有效也不能根治。
   - 不要再追这条。

---

## 6. 调试小抄

报告"切换后 Cindy 起不来"时，按这个顺序：

1. `sqlite3 ~/.silverhand/silverhand.db "SELECT session_id, status, pid, cli_session_id FROM session_agents WHERE agent_id='<cindy-id>';"`
   - 如果 `status='crashed'` 且 `cli_session_id` 不为空 → task #15 没生效，backend 跑的是旧 build。
   - 如果 `status='crashed'` 且 `cli_session_id=NULL` → task #15 生效了，让用户再发一句话即可恢复。

2. `grep "thread_not_found" ~/.silverhand/logs/backend-<latest>.log`
   - 有 `code:"thread_not_found", fatal:true` → 已经被识别、清理路径已走。
   - 只有 plain `{kind:"error", message:"thread not found: ..."}` → backend 是 task #15 之前的旧 build。
   - 如果错误前一两行出现 `inbox: draining queued items into agent stdin`，且没有 `agent: session_init received` → 命中本 incident 的启动竞态，检查 CodexDriver 是否包含本次修复。

3. `sqlite3 ~/.codex/state_5.sqlite "SELECT id, source, cwd, archived, cli_version FROM threads WHERE id='<failing-thread-id>';"`
   - 没记录 → codex 那边真没这个 thread（少见）。
   - 有记录 → 再用手工 `codex app-server` 发 `thread/resume` 验证；如果手工能恢复，优先查 Silverhand 的启动投递顺序。

4. ~~比较 dev 和 release 启动 codex 时继承的 env~~ —— 已被新证据否定（两份 release 之间也复现），不必再查这条。

---

## 7. Follow-ups

- 优先级 1：回归验证 release app 重启后首次唤醒 Codex agent：应先 `session_init`，再 drain inbox，不再出现 `thread not found`。
- 优先级 2：实现 §5 的友好错误文案，保留真正异常时的可理解提示。
- 优先级 3：让 dev backend 跟 release 用同一份 main build，消除诊断信号差。
- 持续观察：记录每次"thread not found"，尤其看错误前是否还有 pre-init inbox drain；如果没有，再重新调查真正的 Codex resume 失败。

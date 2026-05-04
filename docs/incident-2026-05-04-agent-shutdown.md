# Incident 2026-05-04 — Agent shutdown / resume / reconcile

事故起因：用户在 release dmg 里跟两个 agent 聊天 → 关掉 release 切到 `pnpm dev` 验证一个无关问题 → 发"ok 全部 done"以为 task 会被关 → Alice 说"全部关闭"但实际没动 task → 切回 release 又发了一句话 → **没人回复，UI 显示两个 agent 都在 "connecting"** → 找日志查根因。

排查下来发现是**三个独立但互相放大的 bug**，写在这里，避免再踩。

---

## 1. 用户可见的症状

1. 切换 dev↔release 之后，session 里的 agent 永远卡在 "connecting"，发消息没人回。
2. `ps aux | grep -E "claude|codex|chat-bridge"` 能看到上一次启动留下的子进程**全部还活着**，etime 跟启动时间对得上，没人收尸。
3. backend log 里反复出现 `agent: parsed error event from CLI` + `event.message: "thread not found: <uuid>"`（codex 报的）。
4. `session_agents` 表里 `status = 'starting'`、`pid = <早就该死的数字>`，跟实际进程状态完全脱节。

只看 1+4 容易误判成"agent 启动慢 / 没启动"。真正的链路要把 2、3 加进来才能拼出来。

---

## 2. 根因（按发现顺序）

### Bug B — `--resume` 后 status 不会翻 `active`，init-watchdog 也不会救

**位置**：`packages/backend/src/session-manager.ts` 的 `handleParsedEvent` 和 `startInitWatchdog`。

**机制**：`session_init` 这条 CLI 事件在 claude `--input-format stream-json` 下**每个 turn 起头都会再发一次**，且 session_id 跟首发一样。所以需要去重，只让首发触发"status → active / clearWatchdog / drainInbox"这套副作用。

旧实现用 `handle.cliSessionId === ev.sessionId` 判定"是不是同一次 init"。看上去合理——但 `handle.cliSessionId` 在 `start()` 里是从 DB 预加载的（用于 `--resume <id>` 把上一次的会话拣回来）。**resume 场景下，预加载值跟首发 init 的 id 完全相同**，dedup 直接 break：

```ts
case 'session_init':
  if (handle.cliSessionId === ev.sessionId) break;  // ← resume 时这里直接退出
  // 永远到不了：status 翻 active、clearInitWatchdog、drainInbox
```

更糟，watchdog 自身也用 `cliSessionId` 判定"init 是不是已经到了"：

```ts
// startInitWatchdog 的 timer 回调里
if (handle.cliSessionId !== null) return;  // resume 时一开始就非 null → 直接 return
```

→ 任何 `--resume` 启动都会让这个 30s 的"init 没来就杀进程"的兜底失效。CLI 真挂死时 silverhand **完全察觉不到**。

**用户侧后果**：所有 agent resume 之后 status 永远是 `starting`，UI 渲染成 "connecting"。codex 那种 resume 失败的 case 还会在后台一直挂着（watchdog 不杀），变成下一轮的孤儿源头。

### Bug A — `before-quit` 不 await + `stop(hard)` 不等 child exit

**位置**：`apps/desktop/src/main/index.ts` 的 `before-quit` handler 和 `packages/backend/src/session-manager.ts` 的 `stop()`。

**机制 1**：Electron 的 `before-quit` 事件**不会 await handler 返回的 Promise**——除非你显式调用 `event.preventDefault()`。旧代码：

```ts
app.on('before-quit', async () => {
  if (backend) {
    await backend.close();   // ← Electron 不 await，主进程已经在退出了
    backend = null;
  }
});
```

`backend.close()` 内部会调 `sessionManager.stopAll()`，理论上对每个 handle 走一遍 control_request → SIGTERM → SIGKILL。但 Electron 主进程根本不等这个 await，直接进入 `will-quit` → `process.exit`。

**机制 2**：就算等了，`stop(hard)` 自己也是**立刻 return** 的：

```ts
// 旧实现
setTimeout(() => { sigterm; setTimeout(SIGKILL, 5_000).unref(); }, 5_000).unref();
// 函数到此返回，timer 是 unref'd，主进程没别的 keep-alive 时直接被丢
```

`.unref()` 的语义是"不阻止 event loop 退出"。所以两个 timer 在主进程关闭时被无条件丢弃，SIGTERM/SIGKILL 永远不会发出。

**用户侧后果**：你 quit silverhand → 子进程（claude/codex/chat-bridge）变成孤儿继续跑。这次事故里 `ps` 看到的 5 个存活进程就是这么来的。

### Bug C — `reconcileOnBoot` 只改 status 不杀孤儿

**位置**：`packages/backend/src/session-manager.ts` 的 `reconcileOnBoot`。

**机制**：reconcile 是 backend 启动时跑的"DB 跟现实对齐"步骤——把所有还挂着 `starting/active` 的 row 翻成 `idle`，因为这些 row 必然是上一次 backend 没收尾干净留下的。

旧实现就一句 SQL 更新：

```ts
this.sessions.updateAgentRuntime(sa.session_id, sa.agent_id, {
  status: 'idle',
  pid: null,         // ← 旧 pid 直接被遗忘，从不探活、从不收尸
});
```

跟 Bug A 联手：A 留下孤儿 → C 把记录里的 pid 抹掉 → 下次 `start()` spawn 一份**新的副本** → 孤儿还在霸占 CLI 端的会话状态（codex 的 thread server-side 是独占的）→ 新进程 `--resume` 同一 thread 拿到 `thread not found` → 新进程也跟着废，循环加深。

**用户侧后果**：每次 dev↔release 切换都会让 codex agent 失去 thread 状态，silverhand 这边毫无察觉、不报警、不重试。

---

## 3. 三个 bug 的放大链

```
正常用户流程：
  用户 quit app
    → A：before-quit 不 await，子进程没被 SIGKILL 完整 → 留孤儿
  用户重新打开 app
    → C：reconcile 看到 stale row，只改 status 不查 pid → 孤儿继续跑
    → 用户触发交互，spawn 新副本 → 跟孤儿争用 CLI 共享状态
  新 spawn 的 agent 用 --resume 接回旧 thread
    → B：dedup 把首发 init 当成"已经 init 过了"跳过 → status 永远 starting
    → 同时 watchdog 也被 dedup 旁路掉 → CLI 真挂死时不会被收
  用户看到的：UI 一直 connecting，发消息没人理。
```

**单独存在时各自的危害**：

- B：任何 resume 都中招（dev↔release 跟它无关），UI 都会显示 connecting。
- A：每次 quit 都会留孤儿，但要 C 才会让孤儿"挡住"新进程。
- C：单独存在没事（孤儿如果是真死了，reconcile 抹掉 pid 是对的）。

**修一条不够**——B 不修，UI 永远显示 connecting；A/C 不修，codex 永远失忆。

---

## 4. 修复

### Bug B 修法

`AgentHandle` 加显式 `initObserved: boolean` 字段，dedup 和 watchdog 都改用这个 flag，跟 `cliSessionId` 完全解耦：

```ts
case 'session_init':
  if (handle.initObserved) break;       // ← 不再用 cliSessionId 比较
  handle.initObserved = true;
  handle.cliSessionId = ev.sessionId;
  this.clearInitWatchdog(handle);
  // ...status 翻 active、drainInbox

// watchdog 回调里
if (handle.initObserved) return;        // ← 同样改用 flag
```

`cliSessionId` 维持原语义（codex `thread/resume` 仍然要靠它）。

### Bug A 修法

两处一起改：

**`apps/desktop/src/main/index.ts` 的 `before-quit`**：

```ts
let isShuttingDown = false;

app.on('before-quit', event => {
  if (isShuttingDown) return;          // 防递归（app.exit 可能再 fire 一次）
  event.preventDefault();              // ← 关键：拦截默认 quit
  isShuttingDown = true;
  const watchdog = setTimeout(() => app.exit(1), 15_000).unref();
  void shutdown().finally(() => {
    clearTimeout(watchdog);
    app.exit(0);                        // 用 exit 不用 quit，避免再触发 before-quit
  });
});
```

**`packages/backend/src/session-manager.ts` 的 `stop(hard)`**：

```ts
// 监听 child exit，stop 等到它真的死了再 return
const exited = new Promise<void>(resolve => {
  if (h.child.exitCode !== null || h.child.signalCode !== null) return resolve();
  h.child.once('exit', () => resolve());
});

// timer 不再 .unref()，由 try/finally 显式清理
const sigtermTimer = setTimeout(() => h.child.kill('SIGTERM'), 5_000);
const sigkillTimer = setTimeout(() => h.child.kill('SIGKILL'), 10_000);

try { await exited; }
finally { clearTimeout(sigtermTimer); clearTimeout(sigkillTimer); }
```

新契约：**`stop(hard)` resolve 就保证 child 已经 exit**。`stopAll()` 自动继承这个保证。

### Bug C 修法

reconcile 时对每个非空 pid 先探活，活着就 SIGKILL：

```ts
if (sa.pid !== null && sa.pid > 0) {
  try {
    process.kill(sa.pid, 0);              // 探活，dead 则抛 ESRCH
    process.kill(sa.pid, 'SIGKILL');      // 还活着 = 孤儿，强杀
    killed += 1;
    this.ctx.logger.warn({ ..., pid }, 'reconcile: SIGKILL\'d orphaned agent process from prior boot');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      this.ctx.logger.warn({ ..., err }, 'reconcile: failed to kill orphan pid');
    }
  }
}
this.sessions.updateAgentRuntime(...);   // 一并翻 idle、清 pid
```

`cli_session_id` **不动**——下次 `start()` 仍然能用它发 `--resume`。

---

## 5. 验证

### 自动测试（`packages/backend/tests/manager/lifecycle.test.ts`）

新加 5 条回归：

| 测试名 | 覆盖 bug |
|---|---|
| `flips status to active on first init even when cli_session_id is preloaded (resume)` | B (status 翻转) |
| `still fires when the resumed CLI never re-emits init` | B (watchdog 守门) |
| `hard stop does not resolve until the child has exited` | A (stop 新契约) |
| `SIGKILLs an orphan whose pid is still alive` | C (探活+收尸) |
| `silently flips status when the recorded pid is already dead` | C (ESRCH 静默) |

`pnpm test` 196/196 通过；`pnpm typecheck` 全 4 个 workspace 通过。

### 手动验证（release dmg）

打 dmg 后建议跑这几遍：

1. **reconcile 路径**：装完打开 → 进任意有历史的 session。预期：UI 不再卡 connecting；backend log 开头能看到 `reconciled stale session_agents from prior boot count=N killed=M`。
2. **B 修复**：在那个 session 发一句话触发 spawn。预期：agent 状态从 connecting → active（不再永远 connecting），claude resume 应该能正常拣回上下文。
3. **A 修复**：发完消息 agent 在跑的状态下 Cmd-Q quit。预期：app 在 0–10 秒内退出（不秒退也不卡死）；quit 后 `ps aux | grep -E "claude|codex|chat-bridge"` 没有 silverhand 启的孤儿。
4. **C 修复（可选）**：故意强杀 Silverhand 主进程（Activity Monitor → Force Quit），跳过 before-quit → 重启 → 看 backend log 是否有 `SIGKILL'd orphaned agent process from prior boot`。

---

## 6. 调试小抄（如果未来再遇到类似症状）

按这个顺序查：

1. `sqlite3 ~/.silverhand/silverhand.db "SELECT * FROM session_agents WHERE status != 'idle';"` —— 看哪些 row 卡在 `starting/active`。
2. `ps -p <pid> -o pid=,etime=,command=` —— 那个 pid 还活着吗？
   - 活着且 etime > backend 启动时间 → **孤儿**，落到 Bug A/C 域。
   - 死了 → reconcile 没跑 / 状态没翻，落到 Bug B 域或 reconcile 实现 bug。
3. `tail -50 ~/.silverhand/logs/backend-<latest>.log` —— 找几个关键事件：
   - `reconciled stale session_agents from prior boot` —— 启动时该有，没有就是 reconcile 没被调用。
   - `agent: session_init received, status → active` —— 正常 spawn 后该有，没有就是 Bug B 类问题。
   - `agent: parsed error event from CLI` + `thread not found` —— 说明 codex thread 状态丢了，多半是孤儿在抢。
   - `hard stop: control_request didn't exit, sending SIGTERM/SIGKILL` —— 说明 stop 走到了 fallback 路径，CLI 不响应正常关停。
4. `tail -50 ~/.silverhand/logs/chat-bridge-<sessionId>-<agentId>.log` —— agent 自己有没有调过 `send_message` / `update_task_status`。"agent 没回"也分两种：
   - bridge log 完全没新条目 → agent 进程级问题，回到第 3 步。
   - bridge log 有 `tool: send_message ok` 但 chat 里没消息 → backend → renderer 路径问题，跟本 incident 无关。

---

## 7. 仍未做（follow-ups）

- **进程组管理**：当前杀 agent CLI（claude/codex）后，期望 chat-bridge 子进程靠 stdin EOF 自退。如果将来发现 chat-bridge 不肯退，需要 spawn 时用 `detached: true` 拿到独立 process group，stop 时 `process.kill(-pgid, 'SIGKILL')` 整组干掉。
- **PID recycle 兜底**：reconcile 现在只探活不验身。理论上有概率 SIGKILL 一个不相干的进程（旧 pid 被复用）。当前接受这个风险，因为 silverhand 重启间隔通常以秒-分钟计，macOS 的 pid 不会那么快回卷。如果未来真撞到，可以加一步 `ps -p <pid> -o command=` 校验 cmdline 含 `claude` / `codex` / `silverhand`。
- **Bug B 的"漏发 chat 回复但有效完成 task"问题不在本次修复范围内**：本次事故里 Alice 在 dev 跑时声称"全部关闭"但其实只发了 send_message + 一个 Edit，没调 `update_task_status`。这是 prompt/policy 层面的弱点（agent 把"全部 done"理解成"我们聊完了"而不是"标 done"），跟生命周期无关，需要单独处理。

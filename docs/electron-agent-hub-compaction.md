# 上下文压缩（Compaction）设计

> 配套文档：`electron-agent-hub.md`（主设计）
> 本文专门讨论压缩机制——"agent 上下文窗口接近上限时如何处理"。

---

## 1. 基本概念

### 1.1 压缩是什么

LLM 有上下文窗口上限（Claude Sonnet 4.6 是 200k tokens，Opus 4.7 是 1M）。一个长会话的对话历史会逐步逼近这个上限。**压缩（compaction）** 指的是：把早期消息总结成一段紧凑的 summary，替换原始内容，让 context 重新有空间。

代价：**agent 失去逐字的早期记忆**，只剩自己写的总结。

### 1.2 压缩的物理边界

压缩的对象永远是 **一个 CLI 进程内的 context window**。所以：

- "频道压缩"不存在——频道是消息存储，不是 context
- "用户压缩"不存在——用户不在 context 里
- 任何"跨进程共享 context"也不存在——每个 CLI 进程都是独立的封闭系统

只要弄清"谁拥有独立的 context window"，就知道"谁在压缩"：

| 模型 | 谁拥有 context | 谁压缩 |
|------|---------------|--------|
| Slock | 每个 agent 一个长 session | 每个 agent 各自压缩 |
| 本项目 | 每个 session 一个 CLI 进程 | 每个 session 各自压缩 |

---

## 2. 参考实现：Slock 的三层分工

Slock 的核心设计思想：**daemon 自己不做任何压缩**，全靠底层 CLI 自带的能力，daemon 只做"观察 + 协调"。

### 2.1 第一层：CLI 内部算法（黑盒）

每个 coding agent CLI 都自带压缩：
- Claude Code、Codex、Cursor、Gemini 都有
- 接近 context limit 自动触发
- 用同一个模型自家的 summarizer 做总结
- agent 看到的是"我有一段过去的总结"

为什么 daemon 不自己实现：
1. CLI 自家的 summarizer 跟自家模型是协同训练的，质量比 daemon 写一个好
2. 不同 CLI 协议不同，daemon 自己做要写 N 套
3. 涉及 token 计算、model context window、消息边界等内部状态，外部很难做对
4. 一旦 daemon 自己做，就要承担"压缩出错丢信息"的责任——现在 CLI 担着

grep 整份 daemon 代码找不到任何"主动压缩"的调用。

### 2.2 第二层：daemon 解析事件 + 协调状态

每个 driver 把 CLI stdout 里的压缩信号翻译成统一事件：

```js
// Claude driver (chunk-KFVDXO5Y.js:1315)
if (event.subtype === "status" && event.status === "compacting") {
  events.push({ kind: "compaction_started" });
}
if (event.subtype === "compact_boundary") {
  events.push({ kind: "compaction_finished" });
}

// Codex / Cursor / Gemini 各自类似翻译
case "CompactionBegin":  →  compaction_started
case "CompactionEnd":    →  compaction_finished
```

`handleParsedEvent` 收到事件做四件事（`chunk-KFVDXO5Y.js:4184`）：

```js
case "compaction_started":
  this.startCompactionWatchdog(agentId, ap);                      // ① 启动看门狗
  this.broadcastActivity(agentId, "working", "Compacting context", ...);  // ② 推 UI
  ap.gatedSteering.compacting = true;                             // ③ 暂停 stdin 投递
  ap.isIdle = false;                                              // ④ 不接新消息
  break;

case "compaction_finished":
  this.clearCompactionWatchdog(ap);
  this.broadcastActivity(agentId, "working", "Context compaction finished", ...);
  ap.gatedSteering.compacting = false;
  ap.isIdle = false;
  break;
```

#### 看门狗（COMPACTION_STALE_MS = 5 分钟）

- 5 分钟没收到 finish 事件 → 标 "still running; no finish event observed"
- **不杀进程**——CLI 压缩是黑盒，事件可能延迟或丢，但不能因为一个事件丢了就让 session 卡死
- 兜底：如果进程**正常 exit(0)** 时还在 compacting → 推断完成（`finishCompactionIfActive` `:3351`）
- 兜底：如果 **turn_end** 时还在 compacting → 同样推断完成（`:4208`）

#### gatedSteering：压缩期的关键协调

压缩期间 agent 正在"换脑子"，**这时候往 stdin 注入新消息会出问题**。`gatedSteering.compacting = true` 让 `deliverMessage` 把新消息塞进 inbox 而不是立即写 stdin，等 `compaction_finished` 后再批量喂。

### 2.3 第三层：MEMORY.md 把知识从 context 卸到文件系统

最关键的一层。daemon 知道压缩会丢上下文，所以在 system prompt 里教 agent 主动持久化（`chunk-KFVDXO5Y.js:989`）：

```
### Compaction safety (CRITICAL)

Your context will be periodically compressed to stay within limits.
When this happens, you lose your in-context conversation history
but MEMORY.md is always re-read. Therefore:

- MEMORY.md must be self-sufficient as a recovery point.
  After reading it, you should be able to understand who you are,
  what you know, and what you were working on.
- Before a long task, write a brief "Active Context" note in MEMORY.md
  so you can resume if interrupted mid-task.
- After completing work, update your notes and MEMORY.md index
  so nothing is lost.
- Keep MEMORY.md complete enough that context compression preserves:
  which channel is about what, what tasks are in progress,
  what the user has asked for, and what other agents are doing.
```

加上 system prompt 引导的 `notes/` 目录写法：
- `notes/user-preferences.md` — 用户偏好
- `notes/channels.md` — 各频道用途总结
- `notes/work-log.md` — 重要决策与已完成工作
- `notes/<domain>.md` — 领域知识

这套机制成立的物理基础：
- agent cwd = `~/.slock/agents/<agentId>/`
- MEMORY.md 在这里
- 每次 CLI 启动会自动读 cwd 下的 MEMORY.md（Claude Code 等的原生约定）
- "压缩丢了 context" ≠ "丢了知识"——知识在文件，下回合重读

---

## 3. 我们模型的差异

### 3.1 压缩压力显著降低

Slock：1 agent = 1 长 session，所有频道消息都进同一上下文 → context 长得很快 → 压缩频繁。

我们：1 session = 1 个具体任务的对话 → context 通常用不满 → **多数 session 永远不会触发压缩**。

实际意义：本项目里压缩从"必须深度处理的核心问题"降级为"长 session 的偶发情况"。设计上仍要支持，但优先级可以低。

### 3.2 压缩边界从 agent 改成 session

```
Slock:                           本项目:
┌────────────────────┐           ┌────────────────────────────┐
│ Channel            │           │ Channel "my-frontend"      │
│  ├ @reviewer-bot ──┤ context A │  ├ Session "refactor"  ── ─┤ context A
│  ├ @debugger-bot ──┤ context B │  ├ Session "fix CSS"  ── ──┤ context B
│  └ @docs-bot ──────┤ context C │  └ Session "migrate" ── ───┤ context C
└────────────────────┘           └────────────────────────────┘
   N agent = N context              N session = N context
   每个 agent 各自压缩                每个 session 各自压缩
```

物理上没变，只是"谁拥有 context"的概念改了。

### 3.3 MEMORY.md 改放 channel 级

| | Slock | 本项目 |
|---|---|---|
| 位置 | `~/.slock/agents/<agentId>/MEMORY.md` | `<channel.workspace_path>/.agent-hub/MEMORY.md` |
| 归属 | per agent | **per channel** |
| 读取者 | 该 agent 所有重启 | 该 channel 所有 session |
| 写入者 | 同上 | 同上 |
| 跨 session 知识共享 | 不需要（同一 context）| **靠这个**（不同 session context 隔离）|

**为什么 channel 级**：
- session 太短（任务级），写在 session 里下次 task 就丢
- 同一 channel 多 session 之间需要共享背景（"这个项目用了 react 18"、"用户偏好 4 空格缩进"）
- channel = 项目，项目级笔记是最稳定的粒度

---

## 4. 在本项目里如何实现

### 4.1 Driver 层：事件解析

跟 Slock 完全一样，每个 driver 在 `parseLine` 里识别本 CLI 的压缩信号 → 翻译成统一事件 `compaction_started` / `compaction_finished`。

直接抄 Slock 的实现细节即可：
- Claude: `system.status=compacting` / `system.compact_boundary`
- Codex: `contextCompaction` 事件
- Cursor: `CompactionBegin` / `CompactionEnd`
- 其他 CLI 升级时跟随更新

### 4.2 SessionManager 层：状态机

```ts
type SessionRuntimeState = {
  isCompacting: boolean;
  compactionStartedAt: number | null;
  compactionWatchdog: NodeJS.Timeout | null;
  pendingMessages: Message[];   // 压缩期暂存
};

function handleEvent(sessionId: string, ev: ParsedEvent) {
  const st = runtimeStates.get(sessionId);
  switch (ev.kind) {
    case 'compaction_started':
      st.isCompacting = true;
      st.compactionStartedAt = Date.now();
      st.compactionWatchdog = setTimeout(
        () => markCompactionStale(sessionId),
        COMPACTION_STALE_MS
      );
      db.insertEvent({ session_id: sessionId, kind: 'compaction_started', ... });
      broadcastSse(sessionId, { type: 'status', status: 'compacting' });
      break;

    case 'compaction_finished':
      st.isCompacting = false;
      clearTimeout(st.compactionWatchdog);
      st.compactionWatchdog = null;
      db.insertEvent({ session_id: sessionId, kind: 'compaction_finished', ... });
      broadcastSse(sessionId, { type: 'status', status: 'idle_or_working' });
      flushPendingMessages(sessionId);   // 把缓冲的消息批量喂进去
      break;

    case 'turn_end':
    case 'process_exit_clean':
      if (st.isCompacting) {
        // 兜底：推断已完成
        forceFinishCompaction(sessionId, 'inferred from ' + ev.kind);
      }
      break;
  }
}

const COMPACTION_STALE_MS = 5 * 60_000;
```

### 4.3 stdin 投递的 gating

```ts
function deliverUserMessage(sessionId: string, content: string) {
  const st = runtimeStates.get(sessionId);

  // 写库 + 推 UI 立刻发生（用户不应该等）
  const msg = db.insertMessage({ session_id: sessionId, role: 'user', content });
  broadcastSse(sessionId, { type: 'message', msg });

  // 但写 stdin 要等
  if (st.isCompacting) {
    st.pendingMessages.push(msg);
    return;       // 等 compaction_finished 时 flush
  }

  writeToStdin(sessionId, msg);
}
```

### 4.4 UI 反馈

session 处于 compacting 时：
- 发送框可输入（消息会写进 DB），但显示"agent 正在压缩上下文..."提示
- 发送按钮可点（消息入队），但提示"将在压缩完成后送达"
- 状态指示器（旁边的小灯）显示橙色 "compacting"

---

## 5. MEMORY.md 在 channel 级的细节

### 5.1 文件位置

```
<channel.workspace_path>/.agent-hub/
├── MEMORY.md            # channel 级长期记忆（agent 读写）
└── notes/               # 详细笔记
    ├── user-preferences.md
    ├── codebase.md
    ├── work-log.md
    └── ...
```

注意是放在**用户绑定的 workspace_path 内**（`.agent-hub/` 子目录），不是放在 Electron 的 userData 里。这样：
- 用户用 git 管理 workspace 时，可以选择是否把 `.agent-hub/` 加入 .gitignore
- 一份 workspace 等价于一份"项目记忆"，跨设备同步直接用 git/iCloud
- 删除 channel 不会丢笔记（用户可以决定要不要删 `.agent-hub/`）

### 5.2 谁读谁写

**读**：每个 session 的 CLI 启动时，CLI 自动读 cwd 下的 MEMORY.md（这是 Claude Code / Codex 的原生约定）。我们什么都不用做，因为 cwd 就是 `channel.workspace_path`。

**写**：agent 主动写。System prompt 里教它什么时候写。

### 5.3 跨 session 并发写入冲突

这是个 **真问题**。同 channel 两个 session 同时改 MEMORY.md 会丢更新（last-write-wins）。

几种缓解方案：

| 方案 | 优点 | 缺点 |
|------|------|------|
| 不管 | 简单 | 偶发丢更新 |
| chat-bridge 加 `update_memory(diff)` 工具，server 端串行化 | 安全 | 多一个工具，agent 要学新调用方式 |
| 文件锁（flock） | 原生 | agent 不会处理锁错误 |
| **不让 agent 直接写 MEMORY.md，只能调工具** | 最安全 | 偏离 Claude Code 的原生约定（它习惯直接 Write） |

**v1 建议**：不管。压缩冲突的概率本来就低（多个 session 同时压缩 + 同时改 MEMORY.md 才会冲突）；真出问题再加锁。

**v2 可选**：提供一个 `append_memory(section, content)` 工具，server 端用文件锁串行化追加。agent 用这个工具替代直接 Write。但要小心别让两条路径并存。

### 5.4 system prompt 调整

Slock 的 prompt 是 agent 视角的"per-agent MEMORY.md"。我们要改写成 channel 视角：

```
### Compaction safety (CRITICAL)

Your context will be periodically compressed... [同 Slock 前半]

This MEMORY.md is shared across all sessions in this channel/project.
Other sessions may read it; respect that:
- Use it for project-level facts (codebase conventions, user preferences,
  active major decisions), NOT for the play-by-play of your current task.
- For task-specific scratch notes, use ./notes/<task>.md instead and link
  from MEMORY.md if the result is worth preserving.
- Do not delete sections written by other sessions; mark them stale instead.
```

---

## 6. 开放问题

### 6.1 是否需要"agent 主动触发压缩"工具

目前压缩完全被动（CLI 自己决定）。一些场景下 agent 可能想主动触发：
- 长任务结束后，主动总结归档，下次回来轻装上阵
- 用户说"忘掉前面，重新开始" → agent 想清掉 context

Slock 不提供。Claude Code 有 `/compact` 命令但需要 stdin 注入。**v1 不做**，按需再加。

### 6.2 是否暴露 read_channel_history 给 agent

我们目前的设计原则是"agent 不感知 channel"。但如果两个 session 想协作（"我去看看另一个 session 在干什么"），就需要给 agent 提供跨 session 读历史的能力。

权衡：
- 加了之后，"channel 不暴露给 agent"这条原则就破了
- 不加，跨 session 协作只能靠 MEMORY.md 异步沟通

**v1 建议不加**。如果用户反馈"我希望 agent 能看到隔壁 session 在干嘛"，再加 `read_channel_history(channel_hint?, limit)` 工具，刻意只允许"读 channel 内所有 session 的最近 N 条"，不让 agent 知道 channel name 也不让定位特定 session。

### 6.3 压缩失败/超时的处理

5 分钟看门狗只是"通知用户压缩可能挂了"，不杀进程。如果 CLI 真的卡死了：
- session 永远 compacting，新消息一直入队
- 用户体验上看起来像"agent 睡死了"

**建议**：超过 watchdog 时间后，UI 提供"强制重启 session"按钮，等价于 `kill + spawn --resume`。resume 会触发 CLI 重新加载状态，往往就解开了。

### 6.4 压缩对 SSE 推送的影响

压缩期间 CLI 可能依然在 stdout 输出（比如压缩进度），但不应该把这些当 assistant 回复推给用户。

**建议**：
- 压缩期间收到的 stdout 事件标记 `during_compaction: true`
- 默认 UI 不显示，"高级模式"或 events panel 才显示
- 压缩完成后 CLI 可能会**继续完成被打断的回合**（Slock 的 `assistant_continuation` 状态），这部分要正常推给用户

---

## 7. 关键代码定位（Slock 备查）

| 概念 | 文件:行 |
|------|---------|
| Claude driver 解析 compacting | `chunk-KFVDXO5Y.js:1315` |
| Codex driver 解析 compaction | `chunk-KFVDXO5Y.js:1731` |
| Cursor driver 解析 compaction | `chunk-KFVDXO5Y.js:2106` |
| Gemini driver 解析 compaction | `chunk-KFVDXO5Y.js:2411` |
| 看门狗超时常量 | `chunk-KFVDXO5Y.js:2714` `COMPACTION_STALE_MS` |
| 事件 dispatch | `chunk-KFVDXO5Y.js:4184` `handleParsedEvent` |
| 看门狗启停 | `chunk-KFVDXO5Y.js:3960-3990` |
| 进程 exit 时的兜底 | `chunk-KFVDXO5Y.js:3351` |
| turn_end 时的兜底 | `chunk-KFVDXO5Y.js:4208` |
| Compaction safety prompt | `chunk-KFVDXO5Y.js:989` |
| MEMORY.md 初始化 | `chunk-KFVDXO5Y.js:3174` `buildInitialMemoryMd` |

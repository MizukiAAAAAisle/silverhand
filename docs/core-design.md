# Silverhand — Core Design

> 这是 silverhand（即本 Electron Coding Agent Hub）的**产品 + 数据模型权威文档**。
>
> 多轮对话形成的所有共识、设计权衡、隐含约束都写在这里。代码与本文档冲突时，**以本文档为准**，代码必须改回来。
>
> 写作规则：每条决策旁边记一句"为什么"。新决策追加节，旧决策不改写（可"作废"标注）。
>
> **新功能 / 新 service / 新 DB 表 / 新 migration 设计前必读**：[`architecture-principles.md`](./architecture-principles.md)（Human/Agent 同构强制 checklist + 反模式）。鉴权细节见 [`auth-and-host-model.md`](./auth-and-host-model.md)（身份/资源归属）与 [`graded-permissions-v1.md`](./graded-permissions-v1.md)（分级能力）。

---

## 1. 产品前提

### 1.1 我们在做什么

一个桌面应用，让多个 AI coding agent（Claude Code / Codex / Cursor / Gemini 等 CLI agent）在**同一个会话里协作对话**。

### 1.2 核心价值

> **多 agent 在同一上下文中协作**——这是这个 app 存在的唯一理由。
>
> 如果只能 1v1，用户直接开 terminal 跑 `claude` / `codex` 就够了，不需要本应用。

典型场景：

| 场景 | 体现 |
|------|------|
| 角色分工 | claude 负责架构规划、codex 负责代码 review、gemini 负责文档撰写 |
| 多 agent 比对 | 同一个问题让 claude 和 codex 都答一遍，对比观点 |
| 接力 | claude 做完高层设计，codex 接着写实现 |
| 守卫 | 一个 agent 干活，另一个旁观，发现问题打断 |

### 1.3 单机本地为主，多人协作是加成

> **多机文件 ≠ 多人协作**。文件读写本质局部，跨机器要么靠 git（半同步、有冲突）、要么靠云容器（脱离本地工作流）。本应用**不试图解决跨机器文件协作**。

形态定位：**local-agent + multi-human**：
- Agent 跑在某台机器上（v1 = 本机）
- 多个用户都可以加入聊天、看上下文、发消息
- 但实际文件操作只发生在 agent 所在机器
- 其他用户来"参与讨论 / 围观决策"，不参与"动手敲代码"

---

## 2. 实体模型

### 2.1 ER 总览

```
Host (computer | sandbox)              ← 物理 / 虚拟宿主，v1 只有 1 个 (this machine)
  └─ Agent (name, runtime, host_id, agent_home path)
                  ▲
                  │ (n:m via workspace_members)
                  ▼
Workspace = "项目室"
  ├─ name (UNIQUE)
  ├─ kind: 'workspace' | 'dm'
  ├─ description?
  ├─ workspace_path (NOT NULL，未填时自动生成)
  ├─ workspace_host_id (v1 implicit = this machine)
  ├─ git_url? (元数据)
  └─ workspace_members → [agent_id, ...]

Channel = "一次会话 / 多 agent 协作的对话线程"（DB 表名：conversations）
  ├─ workspace_id, title
  └─ conversation_agents → [(agent_id, cli_session_id, pid, status), ...]
            ↑
            channel 创建时从 workspace.members 快照而来

Message
  ├─ channel_id（conversation_id）
  ├─ from_kind: 'user' | 'agent'
  ├─ from_agent_id (nullable, from_kind='agent' 时填)
  ├─ from_user_id  (nullable, v2 多用户用，v1 implicit local user)
  ├─ content, seq, created_at
```

### 2.2 Host

| 字段 | 含义 |
|------|------|
| `id` | 自生成 |
| `kind` | `computer` \| `sandbox` |
| `name` | 给用户看的标识，computer 默认 = `os.hostname()` |
| `metadata` | JSON：OS、架构、CPU、sandbox URL 等 |

**为什么需要**：agent 必须知道自己跑在哪。v1 只有 1 个 computer host（本机），但模型层为 v2 sandbox / 多机预留。

### 2.3 Agent

| 字段 | 含义 |
|------|------|
| `id` | 自生成 |
| `host_id` | 该 agent 跑在哪个 host 上 |
| `name` | 用户起的（"claude-planner"、"codex-reviewer"）|
| `runtime` | `claude` \| `codex` \| `cursor` \| `gemini` |
| `model` | 可选，特定模型（如 `sonnet-4-6`）|
| `agent_home` / L1 path | agent 全局 home（通常由 agent_home workspace 的 `workspace_path` 表示）；`system_prompt.md` 文件定义这个 agent 的"身份/角色" |

**为什么需要 Agent 一等公民**：
- 同一个 runtime 可以有多个 agent 实例，每个有不同身份（claude-planner vs claude-debugger）
- Agent 是跨 channel 复用的对象（一个 claude-planner 可以加入 N 个 channel）
- Agent 持有 memory（见 §4），memory 跨 channel 累积

**为什么 workspace 不在 agent 上**：agent 是身份，workspace 是任务上下文。一个 agent 可以在 0 / 1 / N 个 workspace 上工作。绑死违反这个直觉。

### 2.4 Workspace（含 DM）

| 字段 | 含义 |
|------|------|
| `id` | 自生成 |
| `name` | UNIQUE 字符串（DM 的 name = `@<agent.name>`）|
| `kind` | `workspace` \| `dm`（默认 `workspace`）|
| `description?` | 可选 |
| `workspace_path` | NOT NULL，未填则后端默认生成 |
| `workspace_host_id` | v1 implicit |
| `git_url?` | 纯元数据，不自动 clone（v1）|
| 关联：workspace_members | 该 workspace 内的 agent 成员 |

**Workspace 生成规则**（创建 workspace 时）：

```ts
if (!input.workspace_path) {
  workspace_path = path.join(
    os.homedir(),
    '.silverhand',
    'workspaces',
    sanitize(workspace.name),    // workspace.name 是 UNIQUE，可作目录名
  );
}
fs.mkdir(workspace_path, { recursive: true });
```

**为什么 workspace 一定要有（不允许 nullable）**：agent CLI 必须有 cwd。"纯聊天"场景对应 workspace 是个空目录，不是没目录。后端始终保证 `workspace_path` 非空，UI 上"留空"只是触发自动生成。

**DM 是特殊 workspace**：
- `kind = 'dm'`
- 必须恰好 1 个 agent 成员
- name 自动 = `@<agent.name>`，受 UNIQUE 约束保护"一个 agent 同一时间只有一个 DM"
- workspace_path 同样可选，规则一致
- UI 上 DM 单独列在 `DIRECT MESSAGES` section，跟 `WORKSPACES` 平级

**为什么 DM 不另起一套表**：
- 数据 + 路由 + UI 完全可以复用
- 用户心智上"DM = 1 对 1 的频道"是对的
- 只多一个 `kind` 字段就能区分

**Workspace 的 workspace_host_id 隐含约束**：workspace 的所有 member agent 必须跑在同一个 host 上（即 `workspace_host_id`），否则跨机器 cwd 不通。v1 只有 1 host 自动满足。

### 2.5 Channel（多 agent 协作单元，DB 表名：conversations）

| 字段 | 含义 |
|------|------|
| `id` | 自生成 |
| `workspace_id` | 所属 workspace |
| `title` | 用户起的（"修复 login bug" / "v2 架构讨论"）|
| `status` | channel 自身的状态聚合 |
| 关联：conversation_agents | 该 channel 启动了哪些 agent CLI 进程 |

**为什么 channel 上没有 agent_id**：因为一个 channel 对应**多个** agent。Channel 是一次"协作回合"，不是"1v1 对话"。

**conversation_agents 表**：

| 字段 | 含义 |
|------|------|
| `channel_id` | |
| `agent_id` | |
| `cli_session_id` | 底层 CLI 的 session id（resume 用）|
| `pid` | 当前活进程 PID（idle 时 NULL）|
| `status` | `starting` / `active` / `idle` / `crashed` |
| `joined_at` | |

`cli_session_id` 是 **resume handle**，不是 agent 记忆本身。Stop / Restart
默认保留它，因此下一次启动会 resume 同一个底层 CLI session；Clear session
只清这个字段，让下一次启动使用 fresh CLI session。MEMORY.md / notes /
messages / inbox delivery row 都不随之删除。

**channel.members = workspace.members 的快照**：
- channel 创建那一刻，复制当时的 workspace.members 进 conversation_agents
- 之后 workspace 加 / 减成员**不影响**已有 channel（避免 mid-channel 改 spawn 集合）
- 只影响新建 channel

**为什么快照而非 live join**：mid-channel spawn / kill agent 进程 + system prompt 注入 + 历史消息回放 = 一坨工程复杂度，价值不高。要新成员就新开 channel。

### 2.6 Message

| 字段 | 含义 |
|------|------|
| `id`, `channel_id`, `seq`, `created_at` | 标准 |
| `from_kind` | `user` \| `agent` |
| `from_agent_id` | nullable，`from_kind='agent'` 时填 |
| `from_user_id` | nullable，v2 多用户区分发送者；v1 implicit 单用户 |
| `content` | 文本 |
| `metadata` | JSON：tool_call 引用、附件、引用消息等 |

**消息是 channel-scoped**：换 channel 就是另一条对话流。Workspace 不直接持消息。

---

## 3. 多 agent 协作机制

### 3.1 消息分发（stdin push 为主，HTTP pull 为兜底，对齐 slock-ai）

> **调研更正**（2026-05-01，覆盖 04-30 的初版结论）：早期我把 `check_messages` 的 tool 描述当成了主路径，写成了"纯 pull"。实际重读 daemon 源码（`chunk-RNEIFBXW.js` line 4540-4640 + gated steering 状态机 line 4310-4400）后确认：**slock 是 push 为主，pull 为兜底**。下面写新版，旧版废弃。

#### 三档投递梯度（同一 stdin 通道，不同 payload 复杂度）

| 档位 | Payload 形态 | Agent 视角 | 触发场景 |
|------|------------|----------|---------|
| **A. Push 完整内容** | 把整条新消息包成伪 user message 写 stdin：`{"type":"user","message":{"content":[{"type":"text","text":"New message received: <发件人><正文>...Respond as appropriate."}]}}` | 直接读到完整消息内容，立即 reply | direct mode + inbox 非空 + driver.encodeStdinMessage 成功 |
| **B. Push 短提示** | 写一行 ASCII：`[System notification: You have N new messages waiting. Call check_messages to read them when you're ready.]` | 读到提示后**自己调 `check_messages` MCP 工具**走 HTTP 拉正文 | 上面 A 的 encode 失败 / driver 不支持 direct push / 边缘 case |
| **C. 不 push** | 什么都不写到 stdin | 消息留 inbox，等下次 spawn 时作为 `runtime_start.startup_delivery.text` 交给 daemon，或 agent 自发 check | agent 进程不在跑 / Claude gated 模式但当前不在 safe boundary |

**关键理解**：A 和 B **共用 stdin 通道**，区别只是 payload 复杂度。"fallback" 不是切换到别的通道，是**降级 payload 复杂度换可靠性**——A 失败的可能原因（formatting、字符转义、长度、driver 对 busy 模式只支持简单字符串），B 一行 ASCII 几乎不会失败。完整内容 push 的好处是**省一次 HTTP round-trip**（agent 不需要再调 check_messages 拉正文），所以是默认快路。

#### Claude 的 gated steering 特例

Claude Code 在 turn 进行中，stdin 不是任何时刻都能塞东西的（会污染 thinking block 等）。slock 维护一个 `gatedSteering` 状态机：

- 跟踪 `outstandingToolUses`（当前未完成的 tool call 数）和 `compacting`（是否在压缩上下文）
- "Safe boundary" = `outstandingToolUses === 0 && !compacting`，即**两次 tool call 之间**
- 消息进 inbox 时，**不立即 push**；状态机检测到 safe boundary 时调 A 档一次性把整批 inbox push 出去
- 没到 boundary 时（gated 分支 return），消息留 inbox 等下个 boundary

所以 `busyDeliveryMode` 的 `gated`（Claude）vs `direct`（codex 等）不是"全推/降级推"，而是"**等机会推/立刻推**"。两者最终都走 A 档。

#### Lifecycle lock 与 Clear session

ConversationManager 对每个 `(conversation, agent)` 维护一个 lifecycle queue，
串行化 `start` / `stop` / `clearSession`，也覆盖 init timeout retry 和
oneShot auto-start。锁的边界在 lifecycle 公共方法外层；锁内编排使用
`startUnlocked` / `stopUnlocked`，避免 clear 这类复合动作自排队。

Clear session 是 per-agent destructive action，顺序固定：

1. 如果进程正在跑，先 hard stop，等待进程真正退出。
2. 把 `conversation_agents.cli_session_id` 置 `NULL`。
3. 广播 `agent_status`，写一条 `session_cleared` system audit。
4. audit 投递给同 conversation 的其它 agent，跳过被清 agent。

它不自动 restart；用户显式 Start/Restart 后，新进程因为 `cli_session_id=NULL`
不会带 `--resume`。`conversation_inboxes` pending row 保留，下一次 start 会照常
drain，所以清 session 不会丢尚未送达的用户意图。

#### `check_messages` 工具的真实定位

不是 agent 周期 poll 用的（slock 的 system prompt 明示 `New messages arrive automatically — you do not need to poll or wait for them`），而是：

1. **B 档的拉取动作**：agent 收到短提示后用它拉正文
2. **agent 主观觉得"我可能漏看了"的安全网**：长 tool chain 中段用户提了关键问题但还没到 safe boundary，agent 可以主动 check
3. **piggyback channel**：每次 `send_message` 的响应里也带 `recentUnread`——agent 发完顺便看一眼新消息

#### 我们的 v1 实现

**用户/其它 agent 发消息**：

1. Backend INSERT `messages` 行（`from_kind` ∈ `user` / `agent` / `system`）
2. Backend 把消息 ID append 到 channel 内**每个其它 agent** 的 inbox 队列（SQLite 表 `agent_inboxes`，task #13 落实）
3. 对每个 agent，根据 driver 模式投递：
   - **direct（codex 等）**：立刻调 A 档 push
   - **gated（Claude）**：进 gated 状态机等 safe boundary，到了再 A 档 push
   - agent 不在跑：不 push，等 spawn

**Agent 发消息**（通过 `send_reply` MCP 工具）：

1. chat-bridge 启动参数 `--channel-id` + `--agent-id`，backend 知道 from 谁
2. POST `/internal/agent/<agentId>/send` → 写 messages 行 + 分发给 channel 内其它成员（同上 push 流程）
3. 响应体 piggyback 该 agent 自己 inbox 的未读

**Agent 从"睡"到"醒"**：

- Agent 进程不在跑时，新消息只写 messages + inbox，不 spawn
- 当 channel 被打开 / 用户指名某 agent / 用户指定 "wake all members" 时，ConversationManager 才 spawn
- spawn 时 server 只把当前未 ack 的 inbox 格式化成
  `runtime_start.startup_delivery.text`；daemon 按 driver 语义决定
  streamed stdin write 或 oneShot initial input（C 档的延迟交付）
- 之后回到 A 档实时 push

**v1 不实现 B 档**。失败处理策略：A push 失败 → 重试一次 → 仍失败则记日志 + 进程级 stop 重新 spawn（C 档 `startup_delivery` 延迟交付兜底）。等真碰到 driver encode 不稳的 case 再补 B。

#### 已知代价

- **Agent 在长 tool chain 中段不可达（Claude）/ 必须等当前一步结束（其它）**：这是 CLI turn 模型的硬限制，任何分发协议都解决不了。用户想"立刻打断"必须走 §3.2 的打断通道，不是消息通道。
- **gated 状态机调试复杂**：Claude 的 safe boundary 检测涉及 thinking block / compaction / tool call 嵌套，slock 都遇到过 bug（源码中有 `toolBoundaryFlushDisabled` 应急开关）。我们抄实现时把这套状态机一起抄，遇到问题先 fallback 成 "等 turn 结束再投递"。

### 3.2 打断（soft + hard 两层）

UI 提供两个不同语义的按钮 / 快捷键，背后走不同机制：

#### Soft：追加新指令打断当前思路

场景：用户看到 agent 走偏，想"等等，换个方向"。不希望 agent 完全停，希望它把新指令并进上下文继续推进。

- **Claude**：走 §3.1 的 A 档 push（实际就是 gated steering）。Claude 内部到 safe boundary 时会读到追加的 user message，下一步 reasoning 就会考虑新输入。
- **Codex 等 direct mode**：直接 stdin write 一条新 user message，agent 当前一步结束就读到。
- **本质**：跟"用户追加一条普通消息"完全相同的代码路径，只是 UI 上长得像"打断"。

#### Hard：终止当前 turn

场景：用户认为 agent 完全跑偏，要立刻停下，不接受任何 partial output。

- **Claude（首选）**：走 control protocol —— 往 stdin 写 `{"type":"control_request","request":{"subtype":"interrupt"}}`，Claude 立即终止当前 turn，输出 `turn_end` 事件，进程不退出
- **Claude（fallback）/ Codex（待确认）**：走进程级 SIGTERM → 5s 内不退就 SIGKILL（slock 的 `stopAgent` 实现，`chunk-RNEIFBXW.js` line 3766-3780）
- **Hard 打断后**：进程退出 / turn 终止，conversation_agents.status 变 `idle`，inbox 中尚未投递的消息保留，下次 spawn 时通过 C 档 `startup_delivery` 重新交付

#### Codex 的 hard 打断（开放）

Codex CLI 有没有等价的 control_request interrupt？slock 源码里对 codex 没看到这条，似乎 stop 直接走 SIGTERM。这块在做 codex driver 时验证；目前先按"只有 SIGTERM"实现。

### 3.3 防回声 / 反无限对话

**调研结论**（2026-04-30）：slock-ai **没有任何机械防回声机制**，完全靠 agent system prompt 自律。

我们 v1 同款策略：

- System prompt 明示规则（见 §4.7）
- 不强制 @mention
- 不限制连续 agent reply 轮数
- 信任 prompt 引导，跑起来出问题再加机械限制

**v1 兜底**（如果实际跑出失控）：每个 session 设 turn 上限——例如连续 N 个 agent reply 没用户消息就强制 pause，等用户介入。**不预先实现**，观察后再说。

### 3.4 chat-bridge 启动参数

每个 (conversation, agent) 对应一个 chat-bridge 子进程：

```
chat-bridge \
  --conversation-id <conversation.id> \
  --agent-id   <agent.id> \
  --server-url http://127.0.0.1:<port> \
  # auth-token via env SILVERHAND_AUTH_TOKEN
```

> 已废弃：之前提的 `--auth-token` 走 argv。v1 决策走 env，避免 `ps` 看到。  
> 已废弃：早期用 `--channel-id`；切到 canonical conversations schema 后改为 `--conversation-id`，内部路由统一走 `/internal/conversations/:conversationId/...`。

### 3.5 上下文压缩处理（observer 角色，不自己压）

> **调研结论**（2026-05-01，slock-ai daemon `chunk-RNEIFBXW.js` line 4470-4500、line 4254-4282、line 1045-1052）：slock 不做任何 server-side 上下文压缩，压缩完全是各 agent CLI 内部行为（model 接近上下文窗口上限时自动触发）。slock 只做 observer + 副作用协调。**v1 同款。**

#### slock 的具体做法

**Driver 解析压缩事件**（每个 driver 各识别自己 runtime 的事件，统一映射成 `compaction_started` / `compaction_finished`）：

- Claude：JSON-RPC `subtype: "status", status: "compacting"` / `subtype: "compact_boundary"`
- Codex：`case "contextCompaction"`
- Kimi：`StepBegin/CompactionBegin` / `CompactionEnd`

**ConversationManager 收到事件后做四件副作用**：

1. **广播 UI**：`broadcastActivity('working', 'Compacting context')`，让用户看到状态
2. **暂停 stdin push**：`gatedSteering.compacting = true` —— 压缩期间新消息进 inbox 不投递（不打扰 agent）；`compaction_finished` 后恢复，inbox 等下个 safe boundary 一次性 flush
3. **Trajectory 落盘**：`flushPendingTrajectory(agentId)` —— 把待写的观察日志先 sync，免压缩中崩溃丢
4. **Watchdog**：`COMPACTION_STALE_MS = 5 * 60_000` —— 5 分钟超时不报错，只 broadcast `"still running, no finish event observed"`，UI 给状态显示

#### 跨 agent 不协调

N 个 agent 进程独立运行，各有自己的 context window，独立触发压缩。slock 不做跨 agent 同步。一个 channel 里 claude 在压、codex 在工作、gemini idle —— 三者互不干扰。

#### MEMORY.md 是压缩的"安全网"（关键设计）

slock 不信任 model 内置压缩能无损保留所有信息（合理——压缩本质损失性）。它在 system prompt 里强力要求 agent 把"恢复所需的一切"写进 MEMORY.md，并保证：

- 启动时第一件事就是读 MEMORY.md
- 压缩后第一件事也是重读 MEMORY.md（这是 model 自己的行为，slock 靠 prompt 强化）

这把 "压缩损失" 问题转化成了 "agent 自律维护 MEMORY.md" 问题。**§4.7 平台 prompt 模板里必须有 Compaction safety 段落**——这是整套压缩方案能 work 的前提。

#### 不压缩 chat history（messages 表）

slock 完全不动 messages 表。投递过的消息留在 db 里供 history 检索。压缩 *消息事实层* 是反模式——压缩的是 *agent context window 内的 LLM 历史*，那是 agent 自己的私事。**v1 同款：messages 表是 append-only 事实层，永不裁剪。**

#### v1 实现要点

- Driver 接口加 `parseLine` 输出 `compaction_started` / `compaction_finished` 事件类型（task #10）
- ConversationManager 把这两个事件接到 gated steering 状态机的 `compacting` 标志（task #11）
- 5 分钟 watchdog 抄过来，超时只广播状态，不强行 kill
- DB schema 不需要为压缩加任何字段（messages append-only，trajectory 是 driver 调试日志，可后期再说）


### 3.6 Thread —— 消息 reply-cluster

> **UI 呈现见 [`app-layout.md` §7](./app-layout.md#7-thread);本节是领域模型 owner。**

Thread 是**消息的 reply-cluster**,不是独立会话:在某条消息下展开的子讨论,每条 reply 都是
**父 channel 里的一条普通 message**,靠 `messages.thread_root_id = <root message id>` 归属到
某个 root。它不新增 conversation 行、不 spawn 独立进程——与父 channel 共用同一个 CLI 上下文与
投递管线。

#### 核心规则

- **归属**:reply 用 `thread_root_id` 指向 canonical root message;root 自身 `thread_root_id
  IS NULL`。主 channel 列表只显示 main stream(`thread_root_id IS NULL`),root 消息带 reply
  徽标;展开才按 root 过滤加载该 cluster。
- **一层封顶**:reply 归一到 canonical root,不允许 reply 之上再 reply 成树(写死)。cluster 不是
  导航树节点,channel sidebar 不展示。
- **锚定**:human 在某条消息上发起 thread 时写一条 `thread_anchor` 系统消息,把 cluster 绑定到
  被引用的 root;agent 以 `target: thread:<root>` 回复既有 cluster。
- **freshness / 投递**:main 与 cluster 是同一 conversation 上的两条 stream(`main` =
  `thread_root_id IS NULL`;cluster = `id=root OR thread_root_id=root`)。二者**共用该 conversation
  的全局 seq 分配空间**(seq 不按 stream 重置),独立的是各自的 **freshness head 与 read cursor**;
  成员与准入边界仍是同一个 channel 的。
- **隔离需求**:需要真正隔离的上下文或并行长任务时,**新建 channel**,而不是 thread——thread 只
  做同 channel 内的话题归类。

> **历史 fossil**:早期 `kind='thread'` child conversation 模型(`parent_conversation_id` /
> `create_thread` / `close_thread`)已冻结为只读——schema 保留列与 enum、历史行可读,但不再 spawn
> 或写入,`resolveChannelId` 只认 `channel|dm_channel`。新代码一律走上面的 reply-cluster 模型。


## 4. Memory / Notes —— 两层知识

> **2026-06-12 — 移除 workspace Consensus（L3）**：原 L3 `CONSENSUS.md`
> 概念已删除。实践中 agent 很少主动编辑这个共享文件，且"看似共享、实则
> 混淆多个 agent 各自记录"。每个 agent 自己的 L2 `MEMORY.md` / `notes/`
> 已足够；需要全员强制遵守的约定应落在代码或 docs，而非一个被注入的共享
> prompt 文件。下文为现行两层模型（#task:1086 / #task:1087）。

### 4.1 两层结构（核心思想：分层 + DM 为塑造层）

| 层级 | 内容 | 谁拥有 | 谁可写 | 通过什么场景塑造 |
|------|------|--------|--------|-----------------|
| **L1: Agent Global** | agent 的全局身份 / 角色定义（`system_prompt.md`）+ DM 记忆 | agent | 该 agent（在 DM 中）+ 用户（管理界面）| **DM** |
| **L2: Per-Workspace Per-Agent Memory** | 该 agent 在该 workspace 内的局部知识（`MEMORY.md` + `notes/`）| (workspace, agent) | 该 agent 在该 workspace 工作时 | **Workspace onboarding + 该 workspace 内的对话** |

> **关键设计（D2.g 校准，2026-05-27）**：角色定义只从 L1
> `system_prompt.md` 读取；L2 不再承载一份 workspace-scoped
> `system_prompt.md` 拷贝。Workspace 之间的差异化知识进入各自
> L2 `MEMORY.md` / `notes/`，全局身份和工作风格仍通过 DM 修改 L1。
>
> **DM 是塑造 L1 的专用场所**：DM 的 cwd **直接** = `~/.silverhand/agents/<id>/`（agent 全局 home），所以在 DM 里 agent 对自己 MEMORY 的更新等于更新 global，未来新 workspace 继承到这个新版本。

### 4.2 文件存储完整图

> 所有 silverhand 应用数据统一放 `~/.silverhand/`，不走 Electron 的 userData。这样 (1) 用户能直接 `cd` 进去看；(2) 跨 Electron 重装 / 切机器都能保留；(3) 跟 agent CLI 自己的 `~/.claude/` `~/.codex/` 形成对称结构。

```
~/.silverhand/
├─ silverhand.db                 ← 主数据库
├─ server-config.json            ← embedded server URL + child-session limits（mode 0600；shared auth_token retired in Stage C.6）
├─ agents/
│  └─ <agent-id>/                ← L1：agent 全局 home（真实文件，唯一权威源）
│     ├─ identity.json           ← {name, runtime, model, host_id}
│     ├─ system_prompt.md        ← L1：全局身份模板（daemon spawn 时读取）
│     ├─ MEMORY.md               ← 全局记忆（agent 在 DM 中迭代）
│     └─ notes/                  ← 全局笔记
└─ workspaces/                   ← workspace 自动生成 workspace_path 的默认根目录
   └─ <sanitized-workspace-name>/
      └─ ...（同 <workspace> 结构）

<workspace>/                     ← workspace.workspace_path
├─ <用户的代码 / 项目文件>...
└─ .silverhand/
   └─ agents/
      ├─ <agent-id>/             ← L2：per-workspace 拷贝
      │  ├─ MEMORY.md            ← L2：workspace 内累积的 agent 记忆
      │  └─ notes/
      └─ <agent-id-2>/...

<os.tmpdir()>/silverhand/<spawn-id>/       ← 每次 spawn 的运行时临时文件
├─ system-prompt.md              ← daemon 由 L1 + L2 MEMORY + session ctx 合成
└─ bin/silverhand                ← 每次 spawn 的 CLI shim
```

**为什么 `<workspace>/.silverhand/` 下没有 `channels/` 目录**：channel 的 system-prompt + shim 是每次 spawn 临时合成的、只在 runtime 生命周期内有用，可以从 typed `runtime_start.options` + daemon-local L1/L2 文件重算。写进 workspace 会污染用户目录（git status 看到、文件浏览器看到）、channel 多了会堆积成一大堆无关内容。改放 OS tmp，spawn 前写、进程退出清，出错残留也由 OS 定期清理。**真正持久化的是 SQLite 里的 conversations / messages 行**——文件系统只负责跑起来。

**那既然可以重算，为什么还落盘？** 不是为了我们自己持久化，而是因为 **agent CLI 的 argv 接口强制要求文件路径**：

- `system-prompt` 为了跨 runtime 兼容，统一走 `--system-prompt-file <path>`（claude 支持 inline `--system-prompt`，但不是所有 runtime 都有）
- `bin/silverhand` shim 必须以 PATH 前缀形式暴露给 child process
- 落盘还顺便提供一个调试锚点：agent 行为异常时可以直接 `cat` 出实际喂进去的 prompt

换句话说，这些 /tmp 文件是**"给 child process 传参的一次性媒介"**，不是 silverhand 的状态。生命周期 = 从 spawn 前写入到进程退出，退出后残留只等 OS 清理。`os.tmpdir()` 的语义（跨重启不保证、定期清）刚好匹配。

**DM 例外**：DM workspace 的 `workspace_path` **直接** = `~/.silverhand/agents/<agent-id>/`。也就是说 DM 没有自己的 `<workspace>/.silverhand/agents/<id>/` 嵌套——agent 在 DM 中的 cwd 就是它的 global home，所有读写都直接落到 L1。

### 4.3 Workspace 创建后的对话式 onboarding（关键流程）

> **设计原则**：onboarding 不是表单，而是 workspace 内的第一段对话。这跟整个 app 的"对话即一切"理念一致——用户对 agent 角色的塑造，本身就是一种"跟 agent 说话"。

#### 创建步骤（无表单 onboarding）

用户填完 workspace 基础信息（name + 可选 description + 可选 workspace_path + 选成员 agents）点确认后，系统完成：

1. INSERT workspace 行
2. 计算 workspace_path（未填时按 §2.4 规则生成）并存入 server DB
3. daemon-host materialize：mkdir workspace_path、mkdir `<workspace>/.silverhand/agents/`
4. daemon-host 对每个成员 agent seed L2 (`<workspace>/.silverhand/agents/<id>/MEMORY.md` + `notes/`)，不复制 L1 `system_prompt.md`
5. 自动建一个 channel（title = `Onboarding`），spawn 所有 member agent 的 chat-bridge
6. Backend 自动 INSERT 一条 `from_kind='system'` 的 message 进这个 channel（platform 写的"开场白"），所有 agent 通过 `check_messages` 收到

> 第 6 步要求 message 表支持 `from_kind='system'`。Schema 中加这个枚举值。

#### 系统 onboarding 消息模板

```markdown
Welcome to channel **<channel.name>**.

Members joining this workspace:
- **<agent-A.name>** (<runtime>) — currently configured as:
  > <agent-A 的 L1 system_prompt 第一段，截断 200 字符>
  Memory: <MEMORY.md 字数 / 最近修改时间，或 "empty">
- **<agent-B.name>** (<runtime>) — ...

Each agent has been seeded with their global identity. The user can now
talk to you to refine your role for *this* workspace — e.g. "claude, in this
workspace focus on architecture review only" / "codex, your job here is to
write tests".

When the user gives durable workspace guidance, update your own
`./.silverhand/agents/<your-id>/MEMORY.md` or notes. Global identity /
role changes belong in your L1 `system_prompt.md`.

There is no "onboarding done" signal — when the user starts asking you to
work, just start working.
```

#### 流程要点

- **没有"完成"状态**：onboarding channel 跟普通 channel 没本质区别，第一条消息是 system 而已。用户什么时候开始下达正经任务，onboarding 就什么时候自然结束。
- **角色塑造由 agent 自己写文件**：用户说"你做架构师"，agent 用 Write 工具改 L1 `system_prompt.md`（通常在 DM 中完成）。Backend 不解析、不强制 JSON 格式。
- **用户可以跳过**：如果用户对默认设定满意，直接开始问问题就行——agent 该 reply 还是 reply。
- **workspace 差异化例**：用户在 DM 中把 claude 塑造成"通用规划师"（写入 L1）。在 workspace `react-frontend` onboarding 时，对 claude 说"这个项目的前端约束是 X"——claude 自己改该 workspace 的 L2 MEMORY/notes。在 workspace `code-review-pool` onboarding 时，对 claude 说"这里重点记录 code review 规则"——又一份独立 L2 memory。角色身份仍来自同一份 L1。

### 4.4 L1 ↔ L2 同步（仅一个方向、一个时机）

| 方向 | 时机 | 触发方式 |
|------|------|---------|
| **L1 → L2 全量** | 不存在 | —— |
| **隐式自动同步** | 不存在 | —— |
| **重置 / 提升** | 走对话——用户在 DM 中跟 agent 说"忘掉你在 workspace X 学的"或"把你在 workspace X 的设定记到 global"，agent 自己执行文件操作 | 不需要专门 UI |

DM 不参与同步——DM 直接操作 L1（cwd = global home）。

### 4.5 .silverhand/ 目录约定

```
<workspace>/.silverhand/
└─ agents/<id>/             ← L2（DM 中此层不存在，cwd 就是 L1）
   ├─ MEMORY.md
   └─ notes/
```

> channel 级的临时文件（每次 spawn 合成的 system-prompt + CLI shim）放 `<os.tmpdir()>/silverhand/<spawn-id>/`，见 §4.2。不进 workspace。

### 4.6 不引入 memory MCP 工具

> 设计决策：**不引入** memory-related MCP 工具。
>
> 理由：所有 coding agent CLI 都已自带 Read/Write/Edit 文件工具。再加一层 MCP 抽象只增加复杂度（MCP 调用 → backend HTTP → 写文件），且语义不清。slock-ai 也是同样选择（调研于 2026-04-30）。

### 4.7 System prompt 合成机制

每次 daemon-host 处理 `runtime_start` 时，使用 server 传来的 typed
metadata（`agent.home_dir`、`workspace.path`、session/members/driver/env
policy）在本机读取 L1/L2，并把最终 system prompt 写到
per-spawn tmp 目录的 `system-prompt.md`。Server 不读取、不缓存、不传输
`system_prompt.md` / `MEMORY.md` bytes，也不准备 spawn
目录、cwd 或 child env。合成逻辑：

```
[平台层 prompt — silverhand 注入的协作教育，包含 Critical rules / Startup sequence / Compaction safety / Etiquette]
  ↓
[Initial role — L1 `<agent.home_dir>/system_prompt.md`，daemon 本机读取]
  ↓
[Active Workspace Memory — L2 `<workspace.path>/.silverhand/agents/<id>/MEMORY.md`，16KB cap]
  ↓
[Session 上下文 — workspace name、thread parent、conversation members、memory index 路径]
```

Initial inbox 不拼进 system prompt；spawn-time 未投递消息通过
`runtime_start.startup_delivery.text` 作为独立 intent payload 进入 daemon。

#### 平台层 prompt 模板（基于 slock 全文研读，2026-05-01）

> 要点：slock 的 system prompt 不是"几条提醒"，而是一份完整的**操作手册**——明示了 agent 必须遵守的关键规则、启动后必须执行的步骤、压缩安全策略、协作礼仪、记忆管理结构。我们要把同等覆盖度的内容塞进平台 prompt，不能只丢一句"互相礼貌点"。

```markdown
You are <agent.name>, an AI agent in silverhand — a desktop hub where
multiple coding agents collaborate with the user in shared channels.

## Who you are

Your workspace and your MEMORY.md persist across turns. You will be
started, put to sleep when idle, and woken up again when there is new
work. Think of yourself as a colleague who is always available,
accumulates knowledge over time, and develops expertise through
interactions in this workspace.

You are in workspace "<workspace.name>" (kind=<workspace|dm>).
Other members in this channel:
<list of other agents with name + role hint>
The human user is also present.

## CRITICAL RULES (must)

- Communicate ONLY through the `send_reply` MCP tool. Never print chat
  content to stdout — it will not reach the user or other agents.
- Read your MEMORY.md at channel start, before doing any work.
- When you receive `from_kind=system` messages (platform announcements),
  treat them as informational. Don't reply unless they explicitly request
  it (e.g. an onboarding message asking for your role definition).

## Startup sequence

1. Read `./.silverhand/agents/<your-id>/MEMORY.md` first. This is your
   recovery anchor — everything you need to know about who you are in
   this workspace and what's been happening.
2. If your initial input contains a concrete incoming message, decide
   whether it needs an early acknowledgment. If yes, send a brief one
   via `send_reply` before deep context-gathering.
3. Process the message(s), then reply via `send_reply`.
4. Complete ALL the work the message implies before stopping. If it's
   multi-step (research → code → test), do all steps, report results,
   then stop. New messages will arrive automatically while you're alive
   — you do not need to poll.

## Workspace & Memory

Your home in this workspace: `./.silverhand/agents/<your-id>/`
- `system_prompt.md` — your role definition (already loaded above)
- `MEMORY.md` — what you've learned in this workspace. The entry point /
  index. Read at startup, update when you learn something durable.
- `notes/` — detailed knowledge files (one per topic). Reference from
  MEMORY.md so future-you can find them.

### What to memorize (observe and record proactively)

1. User preferences — how they like things done, conventions, patterns
2. Project context — tech stack, architectural decisions, conventions
3. Domain knowledge — terminology, best practices specific to this work
4. Work history — decisions made and why, what worked / failed
5. Workspace context — what this workspace is about, ongoing tasks
6. Other agents — who else is here, their specialties, how to work with
   them effectively

Suggested file layout:
- `notes/user-preferences.md`
- `notes/project.md`
- `notes/work-log.md`
- `notes/<domain>.md`

Update notes proactively. Don't wait to be asked.

## Compaction safety (CRITICAL)

Your context will be periodically compressed by the runtime to stay
within model limits. When that happens you lose your in-context
conversation history but **MEMORY.md is always re-read on startup and
after compaction**. Therefore:

- MEMORY.md must be self-sufficient as a recovery point. After reading
  it, you should know who you are, what you know, and what you were
  doing.
- Before a long task, write a brief "Active Context" note in MEMORY.md
  so you can resume mid-task if compaction interrupts you.
- After completing significant work, update notes and the MEMORY.md
  index so nothing is lost.
- Keep MEMORY.md complete enough that compression preserves: which
  workspace this is, what's in progress, what the user has asked for, what
  other agents are doing.

## Multi-agent etiquette

- Messages you receive carry a `from` field (user / agent name / system).
  Use it to know who's talking.
- Don't echo or restate what another agent already said.
- If another agent already answered well, stay quiet unless you have
  something genuinely new to add.
- Respect ongoing back-and-forth: if the user is in a focused exchange
  with one specific agent, don't barge in unless explicitly addressed.
- Reply via `send_reply` only when you have content. Silence is OK.
- Send brief progress updates for multi-step work ("step 2/3..."), but
  keep them concise. Don't flood chat.

## Initial role

<Initial role — agent's L1 system_prompt.md appended here>
```

#### DM 场景的特例

DM 平台 prompt 在结构上一致，但 §"Workspace & Memory" 段做调整：

- cwd 直接 = `~/.silverhand/agents/<your-id>/`，所有写都落 L1 global
- 加一段说明："You are in a DM. Updates to your MEMORY.md and notes will affect your global identity in all future workspaces."

#### 为什么平台 prompt 要这么长？

可能感觉这一坨"啰嗦"。但 slock 的实际 system prompt 也是这个量级（~3-4K tokens），且每一段都有具体落地的副作用——少了哪段，agent 就会在那个维度出 bug：

- 没有 Critical rules → agent 把 reply 打到 stdout 而不是 send_reply
- 没有 Startup sequence → agent 不读 MEMORY.md，每次"失忆"
- 没有 Compaction safety → 上下文压缩后 agent 不知道自己是谁
- 没有 Etiquette → 多 agent 一起 reply 同一个问题，回声爆炸

**v1 把 slock 的对应内容抄过来，等真跑起来发现某段多余再删。**

---

## 5. v1 用户操作流（最终）

1. **首次启动 → 引导建第一个 Agent**
   - "给你的第一个 AI 助手起个名字" → 选 runtime（claude / codex 等）→ （可选）写 system prompt → 保存
   - 后端/daemon 自动建 `~/.silverhand/agents/<id>/{system_prompt.md, MEMORY.md, notes/, identity.json}`
2. **建 Workspace**
   - 表单：名称（unique）+ 描述（可选）+ 工作目录（可选，留空自动生成）+ 勾选成员（agents，至少 1 个）
   - 提交后系统完成：server 建 workspace 行并记录 workspace_path → daemon materialize `.silverhand/agents/<id>/` + L2 MEMORY/notes → 自动建一个 `Onboarding` channel → 自动 INSERT 一条 `from_kind='system'` 的开场白消息（见 §4.3）
   - 用户进 workspace 看到的就是已经在跑的 onboarding channel，可以直接对话塑造各 agent 角色
3. **建后续 Channel**（在某 workspace 内）
   - 标题
   - **不选 agent**——channel.members 自动 = workspace.members 快照
4. **聊天**
   - 用户消息进 messages 表，广播给所有 conversation_agents
   - 每个 agent 回复 via send_reply，标记 from_agent_id，其他 agent 通过 check_messages 看到
5. **DM**（替代流程）
   - Sidebar `DIRECT MESSAGES` section 点 + → 选一个 agent → 自动建 `kind='dm'` workspace（name=`@<agent.name>`），workspace_path 直接指向 `~/.silverhand/agents/<agent-id>/`
   - DM 没有 onboarding 消息（cwd 就是 L1，没有"塑造本 workspace 角色"的概念；要塑造就直接说话即可）
   - 之后跟 workspace 一样使用，但 agent 在 DM 中对 MEMORY/notes 的更新等于更新 global

---

## 6. v2 演进展望（不实现，仅声明方向）

### 6.1 架构演进

| v1 | v2 |
|----|----|
| 单 host (this machine) | 多 host：computer + sandbox（云容器、e2b 等）|
| 单用户 implicit | 多用户：users 表 + workspace_humans 关联 + message.from_user_id |
| 无群聊邀请 | UI "邀请用户加入 workspace" |
| 无防回声机械限制 | 如有需要：连续 N 轮无人介入 → pause |
| Embedded backend | 可切 remote backend（同 schema，加 auth middleware）|
| 仅本地 workspace | git_url 支持自动 clone（"加入此 workspace"按钮）|

### 6.2 slock-ai 已有但 v1 跳过的协作功能（2026-05-01 全文研读 system_prompt 后归档）

> 这些是 slock 的 system prompt 中明确教 agent 使用的功能，每一项都是一组 MCP 工具 + 数据模型 + UI。我们 v1 不实现，但记录在案以免遗忘 / 未来对齐。

| 功能 | slock 怎么用 | 我们 v1 是否需要 | 排到 v2 时的代价估计 |
|------|------------|--------------|----------------|
| **Threads（消息嵌套讨论）** | `target=#workspace:<msgId-shortId>` 表示 thread；可在 workspace / DM 内开 thread；`thread unfollow` 退订 | **已收编进 §3.6 Thread**。v1 落地为**消息 reply-cluster**（同 channel 内按 `thread_root_id` 归类的子讨论，一层封顶）；早期设想的"独立子进程 / 子会话 / close_thread 回流"方案已废弃为只读 fossil（见 §3.6） | —— |
| **Task board（任务板）** | 任务是带 `[task #N status=...]` 后缀的特殊消息；工具：`list_tasks`、`create_tasks`、`claim_tasks`、`unclaim_task`、`update_task_status`；状态：todo / claimed / in_review / done；slock 强制 "claim before work" | **v2**。多 agent 并行协作的核心原语，但 v1 用普通消息聊任务也能凑合 | 大：tasks 表 + 状态机 + 5 个 MCP 工具 + UI 任务板视图 + 防 race claim 逻辑 |
| **Reminders（提醒/调度）** | 工具：`schedule_reminder`、`list_reminders`、`cancel_reminder`；支持一次性 / 定时 / 周期；daemon 负责到点投递 | **v2**。"提醒我下周一问 codex 那个问题"这种场景需要它，但 v1 用户可以自己设系统闹钟 | 中：reminders 表 + 调度器（cron-like）+ 3 个 MCP 工具 |
| **Attachments（附件）** | 工具：`upload_file`、`view_file`；附件以 ID 形式挂在消息上；支持 mime sniffing / 图片预览 | **v2**。code review 给截图 / 贴日志文件场景需要，v1 用户用 path 引用本地文件代替 | 中：attachments 表 + 文件存储路径 + 2 个 MCP 工具 + UI 上传/预览 |
| **Read history（消息历史检索）** | 工具：`read_history`，支持 `before/after/around` 分页；`search_messages` 全文搜索 | **v1.5 / v2**。Agent 接活时想了解"这个 workspace 之前在干嘛"会用到。v1 时 agent 可以靠 cwd 里的文件 + MEMORY.md 凑合 | 小：messages 已有 seq + ts，加查询路由 + 1 个 MCP 工具即可 |
| **Profile / Avatar** | 工具：`profile show`、`profile update --avatar-file`；agent 有自己的头像 | **v2**。UI 美化项 | 小：agents 表加 avatar_path，UI 显示 |
| **Discovery 工具** | `list_server`：列出 workspace + agent + human；`workspace members`：列出某 workspace/DM/thread 成员 | **v1.5**。多 workspace 多 agent 后 agent 需要"发现"其他 workspace 与同事。v1 单 workspace 起步可以跳 | 小：1-2 个 MCP 工具，纯查 |
| **Runtime profile control（daemon 控制 agent）** | 特殊 system prompt 段 + `runtime_profile_migration_done` 工具；用于 daemon 灰度 / 升级 | **不需要**。这是 slock 内部 ops 机制，跟产品功能无关 | —— |
| **Skills（agent 技能管理）** | 类似 npm 的 skill 安装机制 | **不需要**。各 agent CLI（claude / codex）自己已有技能/MCP 生态 | —— |
| **特殊 message 渲染 token** | `@name` / `#channel` / `task #N` / `#channel:msgId` 在消息里自动渲染成可点击链接 | **v2**。需要时再做 markdown render 增强 | 小：renderer 端的 message 渲染插件 |

---

## 7. 非目标（v1 明确不做）

- ❌ 跨机器同步同一份 workspace 文件（违反 §1.3 形态定位）
- ❌ Memory 走专门 MCP 工具（用 Read/Write 即可）
- ❌ Agent 跨 workspace @mention 别 workspace 的 agent —— 违反 workspace 隔离
- ❌ Workspace mid-channel 加减 member（要新建 channel）
- ❌ 真实的 turn-taking 协议（信 system prompt 引导即可）
- ❌ Thread 嵌套超过 1 层（写死，§3.6）

---

## 8. 已废弃 / 修正过的设计（备查）

| 旧 | 新 | 改的原因 |
|----|----|---------|
| 1 workspace = N 1v1 channel | 1 workspace = N 多-agent channel | 多 agent 协作是产品核心，不能让 channel 退化成 1v1 |
| Workspace.workspace_path optional | NOT NULL（后端自动生成兜底）| Agent CLI 必须有 cwd |
| Agent 绑 workspace | Agent 不绑 workspace | Agent 是身份不是任务，workspace 跟 workspace 走 |
| Project + per-host workspace binding | 砍掉 Project 这层 | 跨机器文件协作非目标，过度设计 |
| `--auth-token` argv 注入 | env `AGENT_HUB_AUTH_TOKEN` | 避免 `ps` 暴露 token |
| `.agent-hub` 目录名 | `.silverhand` | 跟 app 名统一 |
| Memory 在 workspace 级别 | Memory 分两层（L1 agent-global / L2 workspace-instance）| Agent 身份要跨 workspace 复用又要支持 workspace 内角色反转，单层 memory 做不到 |
| L2 用 symlink 指 L1（隐式共享）| L2 只存 workspace-scoped MEMORY/notes；L1 `system_prompt.md` 是唯一角色源 | 角色身份要全局一致且由 DM 塑造；workspace 差异化知识放 L2，避免 prompt 分叉 |
| DM 跟普通 workspace 一样有独立 workspace_path | DM workspace_path = `~/.silverhand/agents/<id>/`（直接落 L1）| DM 是塑造 agent 全局身份的专用场所，写到独立 workspace 就跟 workspace 没区别了 |
| 应用数据放 Electron `userData` | 全部放 `~/.silverhand/`（db / config / agents / workspaces）| 用户能直接 `cd` 进去看；跟 `~/.claude` `~/.codex` 形成对称；跨 Electron 重装保留 |
| Workspace 创建有强制 onboarding 表单（preview + 按钮编辑 system_prompt / 清 MEMORY）| 创建后自动 post 一条 `from_kind='system'` onboarding message；global role 写 L1，workspace 知识写 L2 MEMORY/notes | 与"对话即一切"的产品理念一致；表单步骤是 UI 工程量也是用户的认知负担 |
| Message.from_kind = `user` \| `agent` | Message.from_kind = `user` \| `agent` \| `system` | onboarding 开场白 / 后续 platform 公告需要一个非用户非 agent 的来源 |
| Channel 运行时文件放 `<workspace>/.silverhand/channels/<channel-id>/` | 放 `<os.tmpdir()>/silverhand/<spawn-id>/` | channel 的 system-prompt + CLI shim 是每次 spawn 临时合成、可重算，写进 workspace 会污染用户目录 + 堆积旧 channel 残骸 |
| 消息分发方案待定（stdin vs pull 二选一） | 04-30 误判为"纯 pull + piggyback"，05-01 重读 slock 源码后改正：**stdin push 为主（A 档完整内容 / B 档短提示降级）+ HTTP pull 兜底 + spawn 时 inject**。详见 §3.1 | 第一次只看了 chat-bridge 工具描述，没追到 daemon 的 deliverNotificationToAgent + gated steering 路径，错把兜底当主路径 |
| 没有打断机制 / "需要时加 SIGINT" | 显式两层：soft（追加新指令走 §3.1 A 档 push）+ hard（Claude control_request interrupt → SIGTERM fallback） | 用户实际需要"换方向"和"立刻停"两种语义，slock 也是这套（control 协议 + 进程信号） |
| Server-side 上下文压缩 / chat history 裁剪 | 全部不做，跟随 slock：压缩是 agent CLI 内部行为，silverhand 只 observer + push 暂停 + watchdog；messages 表 append-only 永不裁剪 | 压缩本质损失性，由 model runtime 自己决定最合适；server 介入会双重压缩 / 触发不一致 |
| §4.7 平台 prompt 模板"几条 etiquette 提醒" | 完整操作手册（Critical rules / Startup sequence / Workspace & Memory / Compaction safety / Etiquette / Initial role），抄 slock 的覆盖度 | 单靠几句礼貌话不够：少了 startup sequence agent 不读 MEMORY、少了 compaction safety 压缩后 agent 失忆、少了 critical rule agent 把 reply 打到 stdout |
| 子话题用 slock-style thread（消息归类）| §3.6 Thread：v1 落地为**消息 reply-cluster**（同 channel `thread_root_id` 归类，一层封顶）；早期设想的真隔离子进程 / 父子双向通信 / close_thread 回流方案已废弃为只读 fossil（见 §3.6） | slock thread 不隔离 agent 上下文（同进程订阅多 workspace），是 slock 单进程模型下的妥协；早期一度想做真隔离子进程，v1 最终收敛为同 channel 内的 reply-cluster，避免多进程/跨会话通信的复杂度 |

---

## 9. 待决策（开放）

1. **Agent system_prompt 编辑入口**：v1 是否在 CreateAgentDialog 里暴露这个字段？还是先用 driver 默认 prompt + 隐藏字段，让用户后期在 DM 中通过对话塑造？
2. **跨 agent 共享的全局 KB**？比如所有 agent 都读得到的"用户偏好"？倾向 NO，可加 agent 之间互相 @ 的机制代替。
3. **Workspace 默认位置**：当前 = `~/.silverhand/workspaces/<workspace-name>/`。要不要支持用户级别的 default 根目录配置（"我的所有 workspace 都建在 ~/code/silverhand/ 下"）？
4. **Workspace 改名 / workspace 改路径**：v1 实现还是直接禁用（要改就建新 workspace 迁移）？倾向后者，复杂度低、用户也理解。 → **2026-05-02 翻案**：决定允许改名，方案见下面 §10。workspace 改路径仍禁用。
5. **Onboarding channel 的特殊性**：是不是要给它一个 `metadata.kind='onboarding'` 标记，让 UI 在 channel tab 上显示个小标签？还是完全跟普通 channel 一视同仁？倾向后者，越少特殊状态越好。

---

## 10. Deferred design — Workspace 设置 / 改名 / archive

> 2026-05-02 起记录。Sidebar 顶部的 workspace info 区准备加 settings 菜单（rename / archive / delete），但先把方向钉死，避免后面改名造成 agent 记忆与现实脱节。

### 改名机制（决定走方案 b）

- **不**采用 "name 永久不可变" 或 "prompt 只用 ID" 的方案——人类指代频道用名字，agent 自然会把名字写进 MEMORY.md。
- **采用**：允许改名，但**改名时由 backend 自动给 workspace 所有 root open channel 投一条 `from_kind=system` 消息**：`Workspace renamed from #X to #Y. Update any references in your MEMORY.md and notes.`
  - 这条消息走和 "@xxx joined / left" 一样的广播路径（参考 `provision.ts:joinWorkspace/leaveWorkspace`）。
  - 利用平台 prompt 的现有规则——system 消息显式 ask for action 时 agent 会响应——agent 自己会把 MEMORY 里的旧名替换成新名。
  - 不主动重写 MEMORY.md（背离 "agent 自治" 原则；也不可靠）。
- 实现位置：新增 `PATCH /api/workspaces/:id` 端点；在路由里调一个新的 `renameWorkspace(workspaceId, newName, opts)` provision helper。

### Archive

- 当前后端只有 `DELETE /api/workspaces/:id`（硬删，工作区文件保留）。Archive 是软删——workspace 在 sidebar 折叠到 "Archived" 分组，channel 不再启动 agent，但历史消息仍可读。
- 数据模型补一列 `workspaces.archived_at INTEGER NULL`（迁移）。`listForWorkspace` / sidebar 默认过滤掉 archived。
- archive 时：
  - 写 `archived_at`
  - 把所有 root open channel 标 `closed_at`（如果还没关）
  - `conversationManager` 停掉所有正在跑的 agent（按 workspace 过滤；当前只有 `stopAll()` 全停的 API，需补 `stopAllForWorkspace(id)`）
  - 不发 system 消息（workspace 已死，发了也没人读）
- unarchive：清 `archived_at`，但不自动重启 channel。

### Settings 菜单（UI）

- ChannelsSidebar 顶部 header：workspace name + workspace path 副标题（已实现），右侧加一个齿轮 icon。点击弹出 dropdown：
  - Rename workspace… → 输入框 dialog → `PATCH /api/workspaces/:id`
  - Archive → 确认 dialog → `POST /api/workspaces/:id/archive`
  - Delete → 二次确认 dialog（"This will permanently delete the workspace; workspace files at `<path>` are kept on disk."）→ `DELETE /api/workspaces/:id`
- 三项都仅对 `kind=workspace` 显示。DM workspace 随 agent 生命周期管理，不暴露这些操作。

### 暂不做的原因

- 想先把 workspace 协作模型（成员同步、onboarding 触发）跑顺，看实际使用中改名 / archive 的频率到底多高。如果低，齿轮菜单的优先级会被推后。

---

## 11. Deferred design — Attachments（图片 / 文件）

> 2026-05-04 起记录。完整 spec 见 [`attachments-design.md`](./attachments-design.md)；这里只钉方向。

- **资源模型**：新增 `attachments` 表，`workspace_id` 鉴权 + `channel_id` 溯源，per-workspace hash 去重；`messages` 表加一列 `attachments TEXT(JSON)` 存 `[{id, filename}]` 引用，不冗余元数据。
- **API**：`POST /api/channels/:cid/attachments`（multipart 上传，反查 workspace）+ `GET /api/attachments/:id`（流字节，**不返路径**，保 storage 抽象）。
- **local/remote 同构**：DB 只存 `storage`(枚举) + `storage_key`(后端逻辑 key)，不存绝对路径或完整 URL。local 模式 blob 落 `~/.silverhand/attachments/<id>`；切到 s3 时新行写 `storage='s3'`，旧 local 行继续工作，message / chat-bridge / renderer 零改动。
- **chat-bridge MCP**：照搬 slock 的 `upload_file` / `view_file` / `send_message(attachment_ids)` 三件套。**绝不接受 base64**——上传与发消息解耦。
- **stream-json 不污染**：附件以文本提示 `[id:xxx — use view_file]` 注入 inbox drain，driver 的 `parseLine` / `encodeStdinMessage` 不动。agent 自己决定是否调 `view_file` 拉图（节省 token）。
- **local 零拷贝**：chat-bridge `view_file` 在 local 模式下经 `GET /internal/attachments/:id/locate` 拿 backend 存储路径直接读盘；remote 模式自动降级到 HTTP+缓存。agent 端代码两种模式相同。

### 暂不做的原因

- 现有 v1 场景（单机单 user 多 agent）纯文本管道够用，多人贴图协作的需求要等远端后端落地后才真正显现。先把 schema 钉死避免未来翻表，但实现可以排到 workspace settings / tasks 之后。

---

文档版本：2026-04-30 v1（§10 增补 2026-05-02；§11 增补 2026-05-04；术语重命名 2026-05-05；MCP 工具名/chat-bridge 参数/DB 字段同步 hard cutover 2026-05-06）
下次更新：开始 task #10 / #11 / 附件 实现前如有偏离，回这里改。

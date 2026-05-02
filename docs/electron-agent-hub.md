# Electron Coding Agent Hub — 设计文档

> 一个把 Claude Code / Codex / Cursor / Gemini 等 CLI agent 聚合成"AI 协作面板"的 Electron 桌面应用。
> 灵感来自 `@slock-ai/daemon` 的进程编排思想，但模型重构为 **Channel + 多 Session** 两层结构。

> **配套文档**
> - [`electron-agent-hub-compaction.md`](./electron-agent-hub-compaction.md) — 上下文压缩（Compaction）专项设计

---

## 0. 背景与参考

### 直接参考：`@slock-ai/daemon`

源码位置：`~/.npm/_npx/277f35d2ed0078b9/node_modules/@slock-ai/daemon/dist/`（npx 缓存）

**值得借鉴的设计**：

1. **进程模型**：CLI 子进程 + 独立的 chat-bridge MCP 子进程，控制面（WS）和数据面（HTTP）解耦
2. **stdin 投递 + stdout 解析**：用 stdin 喂 prompt、解析 stdout 拿元事件（`session_init` / `tool_call` / `compaction_*` / `turn_end`），不解析 agent 自然语言回复
3. **MCP 作为 agent 唯一对外出口**：发消息也走工具调用而非 stdout，避免"agent 心声误发"
4. **session 跨进程持久化**：进程退出，sessionId 缓存在内存（"idle agent"），下次消息来 `--resume` 重启
5. **agent 工作目录隔离**：每个 agent 一个独立 cwd（`~/.slock/agents/<agentId>/`），里面有 `MEMORY.md` + `notes/`，是 agent 的"家"
6. **Driver 抽象**：每个 runtime（claude/codex/cursor/gemini/kimi/copilot）一个 driver 实现 `spawn()` / `parseLine()` / `encodeStdinMessage()`

**主动放弃的设计**：

- "1 agent = 1 长 session、所有频道共享上下文"——本项目用 channel + 多 session 替代
- 多机 daemon + 云服务端——本项目单机 Electron
- 社交模型（@mention 别的 agent、多用户）——v1 单人

---

## 1. 目标 / 非目标

### v1 目标
- 桌面应用（Electron + React/Vue）
- 同时管理多个 coding agent CLI（Claude Code 优先，Codex / Cursor 次之）
- **Channel + 多 Session** 两层结构（核心差异化）
- 本地 SQLite 持久化（消息、会话、附件元数据、任务、提醒）
- 内嵌本地 HTTP server，作为 chat-bridge MCP 工具的后端
- UI 实时反映：消息流、工具调用、文件改动事件

### v1 非目标
- 多机协同 / 云同步
- 多用户 / 权限系统
- agent 互相对话
- 给 agent 暴露"频道"概念（频道是 UI 组织单位，不进 agent prompt）

---

## 2. 整体架构

```
┌──────────────────────────────── Electron App ─────────────────────────────┐
│                                                                            │
│  ┌──────────────┐                          ┌─────────────────────────┐    │
│  │  Renderer    │   IPC (electron contextBridge)   │  Main Process   │    │
│  │  (React UI)  │◄────────────────────────►│                          │    │
│  │              │                          │  ┌────────────────────┐  │    │
│  │ ChannelList  │   SSE stream             │  │ Local HTTP Server  │◄─┼───┐│
│  │ SessionTabs  │◄─────────────────────────┤  │   (Hono on 127.0.  │  │   ││
│  │ MessageView  │                          │  │    0.1:<port>)     │  │   ││
│  │ EventPanel   │                          │  └─────────┬──────────┘  │   ││
│  └──────────────┘                          │            │             │   ││
│                                            │  ┌─────────▼──────────┐  │   ││
│                                            │  │  SessionManager    │  │   ││
│                                            │  │  - spawn/stop CLI  │  │   ││
│                                            │  │  - stdin/stdout    │  │   ││
│                                            │  │  - session lifecyc.│  │   ││
│                                            │  └─────────┬──────────┘  │   ││
│                                            │            │             │   ││
│                                            │  ┌─────────▼──────────┐  │   ││
│                                            │  │  SQLite (better-   │  │   ││
│                                            │  │  sqlite3, WAL)     │  │   ││
│                                            │  └────────────────────┘  │   ││
│                                            └────────┬─────────────────┘   ││
└─────────────────────────────────────────────────────┼─────────────────────┘│
                                                     │ spawn child_process  │
              ┌──────────────────────────────────────┼──────────────────────┘│
              ▼                                      ▼                      ▼
  ┌────────────────────┐               ┌────────────────────┐   ┌────────────────────┐
  │  Claude Code CLI   │               │  Codex CLI         │   │  chat-bridge.js    │
  │  (subprocess)      │               │  (subprocess)      │   │  (MCP stdio srv)   │
  │                    │               │                    │   │                    │
  │  stdin◄─prompt──   │               │  ...               │   │  HTTP POST ────────┘
  │  stdout─events──►  │               │                    │   │  127.0.0.1:<port>
  │  --mcp-config──────┼──spawn─────────────────────────────┼──►│  /internal/...
  └────────────────────┘               └────────────────────┘   └────────────────────┘
```

### 进程角色

| 进程 | 职责 |
|------|------|
| **Electron Main** | 跑本地 HTTP server、SQLite、SessionManager；spawn agent 子进程 |
| **Electron Renderer** | UI；通过 IPC 调用 Main，通过 SSE 接事件流 |
| **Agent CLI 子进程** | 真正的 Claude Code / Codex / ... 一个 session 一个进程 |
| **chat-bridge 子进程** | MCP stdio server，由 agent CLI 通过 `--mcp-config` 拉起；HTTP 调本地 server |

### 通信方式

- **UI ↔ Main**：Electron IPC（`ipcMain`/`ipcRenderer` + `contextBridge`）做命令调用，HTTP+SSE 走事件推送（也可以全用 IPC，但 SSE 用现成代码更轻）
- **Main ↔ Agent CLI**：`child_process.spawn` + stdin/stdout pipe
- **Agent ↔ chat-bridge**：MCP over stdio（CLI 自带能力）
- **chat-bridge ↔ Backend**：HTTP 到 `<server_url>/internal/...`，带 `X-Auth-Token`
  - `server_url` **必须可配置、运行时注入**，不写死本地
  - 默认 `http://127.0.0.1:<random_port>`（嵌入式 Main server）
  - v2 可指向远程（`https://hub.example.com`），同一份 chat-bridge 二进制不变

**为什么 chat-bridge 要走 HTTP 而不是直接 IPC**：因为它是 agent CLI 的子孙进程，拿不到 Electron IPC channel；也不能让它直接连 SQLite（并发写问题、schema 耦合）。HTTP 是干净的进程边界。**而且 HTTP 天然支持本地/远程同协议**——这正是为远程后端预留的关键扩展点。

---

## 3. 核心设计：Channel + 多 Session

### 模型对比

| 维度 | Slock 原版 | 本项目 |
|------|-----------|--------|
| 顶层概念 | Agent | Channel |
| Session | 1 agent = 1 长 session | 1 channel = N 个 session |
| 上下文 | 全局共享，所有频道消息进同一窗口 | 每 session 独立窗口 |
| 跨频道关联 | agent 自然知道（同一上下文） | 需要 agent 显式翻笔记 |
| 上下文压力 | 高，重度依赖 compaction | 低，session 天然隔离 |
| 并行能力 | 串行（一个 agent 一次只跑一个回合）| 并行（多 session 同时跑）|

### 概念定义

**Channel**
- 用户视角的"工作区/项目"，类似 Cursor 里的一个 workspace 或 IDE 里的一个 project
- 字段：name、description、`workspace_path`（绑定一个本地目录作为 cwd）、默认 runtime/model
- 一个 channel 长期存在

**Session**
- 一次具体的 agent 对话/任务，对应底层 CLI 的一个 `session_id`
- 字段：title、runtime、model、`cli_session_id`、status、所属 channel
- 短期或中期存在；可归档；可恢复（`--resume`）
- **一个 channel 内可以有多个 session 并行**（用户开多个标签页）

### 关键决策

1. **cwd 在 channel 级**：同一 channel 的所有 session 共享 `workspace_path`
   - 优点：用户感知简单——"这个项目里跑的所有任务"
   - 风险：并行 session 编辑同一文件冲突
   - 缓解（未来）：可选启用 git worktree per session（每开 session 自动 `git worktree add`）

2. **session 显式创建**：用户点"新会话"按钮才创建，不自动路由
   - 优点：意图清晰、可命名（"修复 login bug"）、好归档
   - 类似 Claude.ai / Cursor 的 thread 模型

3. **MEMORY.md 在 channel 级**：每个 channel 一份长期记忆，所有 session 共享
   - 路径：`<workspace_path>/.agent-hub/MEMORY.md`
   - 因为 session 太短了（任务级），记忆放 session 上没意义
   - 跨 session 共享笔记等价于"项目级记忆"

4. **不给 agent 暴露 channel 概念**：agent 视角里只有"当前 session" + "用户"
   - `send_message` 直接发到当前 session 的人类用户
   - `read_history` 读自己 session 的早期消息
   - channel 是 UI 组织单位，agent 不需要知道
   - **这是相对原版的大幅简化**：去掉 `list_server` / `leave_channel` / 跨频道概念

---

## 4. 数据模型（SQLite）

```sql
-- 启用 WAL 模式以支持并发读
PRAGMA journal_mode = WAL;

CREATE TABLE channels (
  id              TEXT PRIMARY KEY,             -- nanoid
  name            TEXT NOT NULL UNIQUE,
  description     TEXT,
  workspace_path  TEXT NOT NULL,                -- 绑定的本地目录（cwd）
  default_runtime TEXT NOT NULL DEFAULT 'claude',
  default_model   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,             -- nanoid
  channel_id      TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  runtime         TEXT NOT NULL,                -- 'claude' | 'codex' | 'cursor' | ...
  model           TEXT,
  cli_session_id  TEXT,                         -- 底层 CLI 的 session_id（resume 用）
  status          TEXT NOT NULL,                -- 'starting'|'active'|'idle'|'archived'|'crashed'
  pid             INTEGER,                      -- 当前活着的子进程 PID（仅 active）
  cwd             TEXT,                         -- 默认 = channel.workspace_path
  worktree_path   TEXT,                         -- 未来：若启用 git worktree
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_sessions_channel ON sessions(channel_id, updated_at DESC);
CREATE INDEX idx_sessions_status  ON sessions(status);

CREATE TABLE messages (
  id           TEXT PRIMARY KEY,                -- nanoid
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  channel_id   TEXT NOT NULL,                   -- 冗余，按 channel 查方便
  role         TEXT NOT NULL,                   -- 'user'|'assistant'|'system'|'tool'
  content      TEXT NOT NULL,
  metadata     TEXT,                            -- JSON: tool_call_id, model, finish_reason...
  seq          INTEGER NOT NULL,                -- session 内单调递增
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_messages_session ON messages(session_id, seq);
CREATE INDEX idx_messages_channel ON messages(channel_id, created_at DESC);

CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,               -- nanoid
  message_id    TEXT REFERENCES messages(id) ON DELETE SET NULL,
  session_id    TEXT NOT NULL,
  filename      TEXT NOT NULL,
  mime_type     TEXT,
  size_bytes    INTEGER,
  storage_path  TEXT NOT NULL,                  -- 本地落盘路径，建议 <appData>/attachments/<id>
  created_at    INTEGER NOT NULL
);

CREATE TABLE session_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                    -- 'tool_call'|'tool_output'|'file_change'
                                                -- |'session_init'|'compaction_started'|'compaction_finished'
                                                -- |'turn_end'|'shell'|'stderr'
  payload     TEXT,                             -- JSON
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_events_session ON session_events(session_id, id);

CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL,                    -- 'open'|'in_progress'|'done'|'cancelled'
  number      INTEGER NOT NULL,                 -- 频道内自增编号 #1 #2 ...
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE reminders (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  fire_at      INTEGER NOT NULL,
  title        TEXT NOT NULL,
  payload      TEXT,
  status       TEXT NOT NULL,                   -- 'pending'|'fired'|'cancelled'
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_reminders_pending ON reminders(status, fire_at);
```

存储位置（macOS）：`~/Library/Application Support/<AppName>/agent-hub.db`

---

## 5. 服务端 API

### 5.0 Backend 抽象与可配置 server URL

**核心原则**：chat-bridge 不假设后端在哪里。它只知道：
- 一个 `server_url`（可以是 `http://127.0.0.1:54321` 也可以是 `https://hub.example.com`）
- 一个 `auth_token`
- 自己服务于哪个 `session_id`

这三样都通过启动参数注入：
```
chat-bridge \
  --session-id <sid> \
  --server-url <url> \
  --auth-token <token>
```

**v1（本地）**：`server_url` = Main 进程内嵌 server 的地址（`http://127.0.0.1:<random_port>`），SessionManager spawn chat-bridge 时把当前端口塞进去。

**v2（远程）**：`server_url` 切到云端域名，chat-bridge 代码零改动；变化的只是后端实现（不再是 Main 内嵌的 Hono server，而是真实的远程服务）。

### 5.0.1 配置层级

```
ServerConfig {
  url:           string;     // http(s)://host:port，必填
  auth_token:    string;     // 必填
  mode:          'embedded' | 'remote';
  // remote 模式专属
  user_id?:      string;
  refresh_token?: string;    // 如果未来用 OAuth
  ca_cert_path?: string;     // 自签 CA
}
```

存在 `<userData>/server-config.json`（mode 0600）。
- **embedded** 模式：app 启动时拉起内嵌 server，写 url + 随机 token 进配置
- **remote** 模式：用户从设置面板填远程 URL + 登录获取 token；内嵌 server 不启动

UI 里有"后端"切换面板：embedded（默认）/ remote。切换后所有新 spawn 的 chat-bridge 都拿新配置。

### 5.0.2 已运行 session 的迁移问题

如果用户在 session 跑到一半切了后端：
- 已 spawn 的 chat-bridge 还指着旧 url（启动参数已固化）
- **策略**：切后端只影响"将来"。当前 session 要么继续用旧后端跑完，要么用户主动 stop+resume 切到新后端
- 同样地，远程后端必须能识别 `cli_session_id` 并支持 resume——所以**远程后端的 schema 必须和本地 SQLite 对齐**（这就是为什么 schema 设计要往"将来能搬上云"考虑）

### 5.0.3 网络与安全（remote 场景）

| 关注点 | 本地 | 远程 |
|--------|------|------|
| 传输 | HTTP | **必须 HTTPS** |
| 认证 | 单 token（机器本地，0600）| token + 用户身份（多用户）|
| Token 生命周期 | 启动时随机生成 | 短 token + refresh，或 OAuth |
| CORS | 不需要（同机）| 严格白名单 |
| 速率限制 | 不需要 | 必须 |
| 附件存储 | 本地文件系统 | 对象存储（S3/R2）|

**v1 不实现这些**，但**所有 API 都要为远程预留**：
- 所有路径不假设"single user"——`/internal/session/:sid/...` 已经隐含 session 唯一可定位
- 不在 URL 暴露用户隔离逻辑（让远程版加 middleware 解决）
- 附件下载用 `attachment_id` 而非文件路径，远程才能改成签名 URL
- chat-bridge 的所有 fetch 必须使用注入的 base URL，**禁止硬编码**

### 5.0.4 远程模式下的 UI ↔ Backend

UI 部分一样可配置：
- embedded：UI 调 `http://127.0.0.1:<port>/api/...`
- remote：UI 调 `https://hub.example.com/api/...` + 用户 token

UI 这条线 v1 也走 HTTP（不用 IPC），就是为了和 chat-bridge 对称——**两条客户端（UI、chat-bridge）共用同一组 server，只是认证 token 不同**：
- UI token = 用户登录态
- chat-bridge token = session 范围的短令牌（remote 模式下由 backend 在启动 session 时签发）

### 5.1 UI 调用（Renderer → Backend）

也可以用 IPC 替代，下面为统一性都用 HTTP 描述。

**Channel**
- `GET    /api/channels`
- `POST   /api/channels`                              `{ name, workspace_path, ... }`
- `PATCH  /api/channels/:id`
- `DELETE /api/channels/:id`

**Session**
- `GET    /api/channels/:id/sessions?status=`
- `POST   /api/channels/:id/sessions`                 `{ title, runtime, model? }` → spawn CLI
- `POST   /api/sessions/:id/messages`                 `{ content, attachment_ids? }` → 写 stdin
- `GET    /api/sessions/:id/messages?since_seq=`
- `GET    /api/sessions/:id/events?since_id=`
- `POST   /api/sessions/:id/stop`                     SIGTERM CLI，标 idle
- `POST   /api/sessions/:id/resume`                   重新 spawn + --resume
- `POST   /api/sessions/:id/archive`
- `DELETE /api/sessions/:id`                          软删 / 硬删

**实时推送**
- `GET    /api/sessions/:id/stream`                   SSE：消息、事件、状态变化
- `GET    /api/channels/:id/stream`                   SSE：channel 下所有 session 的状态变化（用于侧边栏未读/活动指示）

**Workspace**
- `POST   /api/workspaces/scan`                       `{ path }` → 文件树
- `GET    /api/workspaces/file?path=`                 读文件内容
- `GET    /api/runtimes`                              探测本机已安装的 CLI（沿用 detectRuntimes 思路）

### 5.2 Agent 调用（chat-bridge → Main）

所有路径前缀 `/internal/`，要求 `X-Auth-Token: <token>` 头。
chat-bridge 启动时通过 `--auth-token` 拿到 token。

**核心通信**
- `POST /internal/session/:sid/send-reply`
  - `{ content, attachment_ids? }`
  - agent 回复当前 session 的人类用户
- `POST /internal/session/:sid/upload`               (multipart) → 返回 `attachment_id`
- `GET  /internal/session/:sid/receive`              拉自上次以来的新人类消息（`check_messages` 工具）
- `GET  /internal/session/:sid/history?limit=`       读自己 session 的历史

**附件**
- `GET  /api/attachments/:id`                        下载（也带 token 校验）

**Tasks**（channel 级）
- `GET  /internal/session/:sid/tasks?status=`        返回当前 channel 的任务
- `POST /internal/session/:sid/tasks`                创建
- `POST /internal/session/:sid/tasks/:tid/claim`
- `POST /internal/session/:sid/tasks/:tid/status`    `{ status }`

**Reminders**（session 级）
- `POST /internal/session/:sid/reminders`            `{ fire_at, title }`
- `GET  /internal/session/:sid/reminders`
- `POST /internal/session/:sid/reminders/:rid/cancel`

**Runtime**
- `POST /internal/session/:sid/session-init`         CLI 拿到 session_id 时回报（也可由 Main 解析 stdout 写入，二选一）

> 设计原则：URL 里强制带 `:sid`，chat-bridge 启动时已经知道自己服务于哪个 session（启动参数注入），任何调用都是这个 session 视角。token 仅做"是不是本机合法 chat-bridge"的认证，session 隔离靠 URL。

---

## 6. SessionManager 内部行为

### 6.1 创建 session

```ts
async function createSession(channelId, opts) {
  const channel = db.getChannel(channelId);
  const session = db.insertSession({
    id: nanoid(),
    channel_id: channelId,
    title: opts.title,
    runtime: opts.runtime,
    model: opts.model,
    cli_session_id: null,
    status: 'starting',
    cwd: channel.workspace_path,
  });
  await spawnCliForSession(session);
  return session;
}
```

### 6.2 spawn CLI（以 Claude 为例）

```ts
async function spawnCliForSession(session) {
  const driver = getDriver(session.runtime);

  // 写 standing prompt + MCP 配置到 cwd 下临时目录
  const slockDir = path.join(session.cwd, '.agent-hub', session.id);
  await fs.mkdir(slockDir, { recursive: true });
  await fs.writeFile(path.join(slockDir, 'system-prompt.md'),
    driver.buildSystemPrompt(session));
  await fs.writeFile(path.join(slockDir, 'mcp.json'),
    buildMcpConfig({
      sessionId: session.id,
      serverUrl: serverConfig.url,        // ← 从配置读，不硬编码
      authToken: serverConfig.authToken,  // ← 同上
    }));

  const args = driver.buildArgs(session, { mcpConfigPath, systemPromptPath });
  if (session.cli_session_id) args.push('--resume', session.cli_session_id);

  const proc = spawn(driver.binary, args, {
    cwd: session.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...driver.envOverrides() },
  });

  db.updateSession(session.id, { pid: proc.pid, status: 'active' });
  attachStdoutParser(session, proc, driver);
  attachExitHandler(session, proc);

  // 如果是 resume，立刻喂个 wake prompt（如果有积压消息）
  // 否则等用户发第一条消息再喂
}
```

### 6.3 stdin 投递用户消息

```ts
async function deliverUserMessage(sessionId, content) {
  const session = db.getSession(sessionId);
  const msg = db.insertMessage({ session_id: sessionId, role: 'user', content, ... });
  broadcastToSseSubscribers(sessionId, { type: 'message', msg });

  let proc = activeProcs.get(sessionId);
  if (!proc) {
    // session idle，重启
    await spawnCliForSession(session);  // 会带 --resume
    proc = activeProcs.get(sessionId);
  }

  const driver = getDriver(session.runtime);
  const encoded = driver.encodeStdinMessage(content, session.cli_session_id);
  proc.stdin.write(encoded + '\n');
}
```

### 6.4 stdout 事件解析

```ts
function attachStdoutParser(session, proc, driver) {
  let buf = '';
  proc.stdout.on('data', chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const events = driver.parseLine(line);
      for (const ev of events) handleEvent(session.id, ev);
    }
  });
}

function handleEvent(sessionId, ev) {
  switch (ev.kind) {
    case 'session_init':
      db.updateSession(sessionId, { cli_session_id: ev.sessionId });
      break;
    case 'assistant_message':       // 注意：依赖 driver 是否吐这个
      db.insertMessage({ session_id: sessionId, role: 'assistant', content: ev.text });
      // 但更可靠的"assistant 回复"是通过 send-reply 工具进 DB
      break;
    case 'tool_call':
    case 'tool_output':
    case 'file_change':
    case 'shell':
      db.insertEvent({ session_id: sessionId, kind: ev.kind, payload: ev });
      break;
    case 'turn_end':
      db.updateSession(sessionId, { status: 'idle' });
      break;
    case 'compaction_started':
    case 'compaction_finished':
      db.insertEvent({ session_id: sessionId, kind: ev.kind, payload: ev });
      break;
  }
  broadcastToSseSubscribers(sessionId, { type: 'event', event: ev });
}
```

> **关于 assistant 回复怎么入库**：参考 Slock 的设计，agent 回复**不是从 stdout 解析**，而是通过 `send-reply` 这个 MCP 工具显式写入。这样 stdout 就只承担"遥测"角色，避免误把 agent 的思考/解释当回复。

### 6.5 进程退出

```ts
proc.on('close', code => {
  activeProcs.delete(session.id);
  if (code === 0) {
    db.updateSession(session.id, { status: 'idle', pid: null });
    // 留着 cli_session_id，下次消息来 resume
  } else {
    db.updateSession(session.id, { status: 'crashed', pid: null });
    broadcastSessionStatus(session.id, 'crashed', { exitCode: code });
  }
});
```

### 6.6 App 启动时 reconcile

```ts
function onAppStart() {
  // 上次没干净退出的 session 全标 idle
  db.updateSessionsBulk({ status: 'active' }, { status: 'idle', pid: null });
  // 启动 reminder 调度器，扫 pending reminders 装 setTimeout
  scheduleAllPendingReminders();
}
```

---

## 7. MCP 工具集（chat-bridge）

参考 Slock 但大幅简化。删掉跨频道社交相关，保留生产力相关。

| 工具 | 说明 | 对应 HTTP |
|------|------|-----------|
| `send_reply` | 给当前 session 的用户回复 | POST `/internal/session/:sid/send-reply` |
| `check_messages` | 拉自上次以来的新用户消息（busy 模式下用） | GET `/internal/session/:sid/receive` |
| `read_history` | 读自己 session 的历史 | GET `/internal/session/:sid/history` |
| `upload_file` | 上传附件 | POST `/internal/session/:sid/upload` |
| `view_file` | 下载附件到本地 | GET `/api/attachments/:id` |
| `list_tasks` | 当前 channel 任务 | GET `/internal/session/:sid/tasks` |
| `create_task` | 新建任务 | POST `/internal/session/:sid/tasks` |
| `claim_task` | 认领任务 | POST `.../claim` |
| `update_task_status` | 改任务状态 | POST `.../status` |
| `schedule_reminder` | 设定时提醒 | POST `/internal/session/:sid/reminders` |
| `list_reminders` / `cancel_reminder` | 管理提醒 | GET / POST `.../cancel` |

启动参数：
```
chat-bridge --session-id <sid> --server-url http://127.0.0.1:<port> --auth-token <token>
```

---

## 8. UI 草图

```
┌──────────────────────────────────────────────────────────────────────┐
│ ☰ Agent Hub                                              [+] [⚙]    │
├────────────┬─────────────────────────────────────────┬───────────────┤
│ CHANNELS   │ CHANNEL: my-frontend                    │ EVENTS        │
│            │ ┌───────────────────────────────────┐   │               │
│ #frontend●3│ │ ⊞ refactor login    │ + new │ ▾  │   │ 14:23 tool_call│
│ #backend  1│ │ ⊞ fix CSS bug                     │   │   read_file   │
│ #infra     │ │ ⊞ migrate to react 19  (idle)     │   │ 14:23 tool_out│
│ #playground│ └───────────────────────────────────┘   │ 14:24 file_chg│
│            │                                          │   src/Login.t.│
│ + new      │ [user]      帮我看下 Login.tsx 的报错  │ 14:24 ...     │
│            │                                          │               │
│            │ [claude]    我看到错误是 ...            │               │
│            │             [tool: read_file]           │               │
│            │                                          │               │
│            │ [user]      改一下吧                    │               │
│            │                                          │               │
│            │ [claude]    已修改，运行了测试通过 ✓   │               │
│            │             [tool: write_file]          │               │
│            │             [tool: shell: npm test]     │               │
│            │                                          │               │
│            │ ┌──────────────────────────────────┐    │               │
│            │ │ 输入消息...                       │    │               │
│            │ │                          [Send] │    │               │
│            │ └──────────────────────────────────┘    │               │
└────────────┴─────────────────────────────────────────┴───────────────┘
```

- **左**：channel 列表，圆点 = 该频道有 session 处于 active
- **中上**：当前 channel 下的 session tabs，可新建可切换
- **中下**：选中 session 的对话流（消息 + 内嵌 tool call summary）
- **右**：当前 session 的事件流（详细工具调用、文件变更、shell 输出）

---

## 9. 与原版 Slock 的差异总结

| 维度 | Slock | 本项目 |
|------|-------|--------|
| 部署形态 | 服务端（云） + 多机 daemon | Electron 单机 |
| 通信骨架 | WebSocket 控制面 + HTTP 数据面 | 进程内 + localhost HTTP（chat-bridge）|
| 上下文模型 | 1 agent = 1 长 session | 1 channel = N 短 session |
| Agent 视角 | 自己是"群里的 AI 同事"，知道频道 | 自己是"这个 session 的 AI"，不知道频道 |
| 跨频道关联 | 天然有（同一上下文） | 显式（写笔记/翻历史） |
| 持久化 | 服务端数据库 | 本地 SQLite |
| Workspace | `~/.slock/agents/<id>/` 隔离的家 | `<channel.workspace_path>` 真实项目目录 |
| MEMORY.md | per-agent | per-channel |
| 多用户 | 是 | 否 |
| Agent 互联 | 是（@mention 别的 agent）| 否（v1） |
| MCP 工具数 | 17 个 | ~11 个 |

---

## 10. 实施路线图（建议）

**M1 - 骨架可运行（1 周）**
- Electron + React + TS 工程
- SQLite schema + 基础 CRUD
- HTTP server (Hono)
- 写死一个 channel + 一个 session，能 spawn `claude` 并显示 stdout
- 没有 MCP，纯 stdout 回显

**M2 - Claude Code 端到端（1 周）**
- Driver 抽象 + Claude driver
- chat-bridge 子进程 + `send_reply` + `check_messages` + `read_history` 三个工具
- session_init / turn_end 事件解析，DB 持久化
- 用户发消息 → stdin 投递 → assistant 回复入库 → UI 展示
- session 跨进程退出 + resume

**M3 - UI 完善（1 周）**
- channel 管理（创建、绑定 workspace）
- session 多标签 + 切换
- 事件面板（tool_call / file_change 实时显示）
- 附件上传/下载

**M4 - 多 runtime（1-2 周）**
- Codex driver（注意要 `git init`）
- Cursor driver
- runtime 自动探测 + 模型选择 UI

**M5 - 任务与提醒（1 周）**
- tasks CRUD + 工具集成
- reminders 调度器（参考 ReminderCache）

**M6 - 体验打磨**
- 全文搜索（FTS5）
- 导出/备份
- 快捷键
- 主题
- (Optional) git worktree per session

---

## 11. 开放问题

1. **本地 ↔ 远程后端的迁移**：用户在 embedded 模式下积累的 channel/session/历史，未来切到 remote 模式时怎么办？
   - 选项 A：本地数据始终留本地，remote 模式独立账号
   - 选项 B：提供"上传到远程"的迁移工具
   - 选项 C：始终双写（本地 SQLite 当 cache，远程当 source of truth）—— 复杂度高
   - 倾向 A + 后期加 B

2. **远程模式下 chat-bridge 的网络可靠性**：本地 HTTP 几乎不会失败，远程会遇到超时/断网/限流。
   - chat-bridge 的工具调用要加重试（参考 Slock 的 `executeRetrySafeSendRequest`）
   - 工具返回的 error 要让 agent 知道是"网络错"而不是"业务错"，否则 agent 会以为操作失败而误重试

3. **并发文件写冲突**：同 channel 多 session 同时改文件怎么办？
   - 短期：UI 警示 + 用户自觉
   - 长期：`worktree_path` 字段已经预留，可加"隔离 session"开关，自动 `git worktree add`

2. **assistant 回复来源**：纯 `send_reply` 工具 vs 部分解析 stdout？
   - 倾向纯工具（更干净），但要在 system prompt 里强力强调
   - fallback：turn_end 时如果整个回合没调用 `send_reply`，自动把整个回合的"非工具调用文本"作为一条 assistant 消息记下来（保命兜底）

3. **MCP 工具暴露给 agent 的认知边界**：要不要让 agent 知道"我在哪个 channel"？
   - 当前设计：不知道。简化心智模型
   - 反例：如果 agent 想跨 session 协作（比如自己开个子任务），就需要知道
   - 建议 v1 不开放，v2 评估

4. **agent 主动开新 session**（"我去后台跑个测试"）：
   - 需要新工具 `spawn_subsession`，在同 channel 下开 session
   - 父 session 怎么拿到子结果？工具调用同步返回 ID，之后主动 `read_session_history(sid)`？
   - v1 暂不做

5. **stdin 协议差异**：每个 driver 的 `encodeStdinMessage` 格式不同（Claude 是 streaming JSON，Codex 是另一套），这层抽象的稳定性取决于上游 CLI 不大改协议。Slock 的 driver 写法是好范本，直接抄 + 跟随升级。

6. **本机 server 端口冲突**：用 `0.0.0.0:0` 让 OS 分配端口，写 `<userData>/server-port` 文件，Electron 启动时读出来传给 chat-bridge。

7. **chat-bridge 怎么打包**：
   - 跟主程序一起打包（`extraResources`），路径用 `process.resourcesPath` 解析
   - 用 Node `--experimental-sea-config` 单文件打包，或者直接 `electron-rebuild` + `node_modules` 全打包

---

## 12. 关键依赖（建议）

| 用途 | 选型 |
|------|------|
| Electron 框架 | electron@latest |
| 打包 | electron-builder |
| 前端 | React + Vite + TanStack Query |
| 后端框架（Main 内） | Hono |
| 数据库 | better-sqlite3（同步、快、Electron 友好） |
| MCP SDK | @modelcontextprotocol/sdk |
| ID 生成 | nanoid |
| 进程通信增强 | electron-store / 自己写 |
| 日志 | pino + electron-log |

---

## 13. 风险

- **agent CLI 协议变化**：每次 Claude Code 升级要回归测试 driver。建议固定测试场景集
- **stdin 投递的回合边界**：busy 状态下 stdin 注入可能干扰当前回合；参考 Slock 的 `gated` / `notification` 模式
- **Electron 主进程压力**：所有 agent stdout 解析都在 Main，session 一多可能卡 UI。如果出问题，把 SessionManager 拆到 utility process（`utilityProcess.fork`）
- **token 泄露**：HTTP server 只绑 127.0.0.1 + 0600 token 文件 + 进程 env 注入，避免命令行 `--auth-token` 出现在 `ps` 里（macOS 上 ps 默认看不到别人的进程参数，但 env 更安全）

---

附：原 daemon 关键代码定位（备查）

| 概念 | 文件:行 |
|------|---------|
| WS 客户端 | `chunk-KFVDXO5Y.js:4384` `DaemonConnection` |
| 消息分发 switch | `chunk-KFVDXO5Y.js:4750` `DaemonCore.handleMessage` |
| Agent 进程管理 | `chunk-KFVDXO5Y.js:3133` `AgentProcessManager` |
| stdin 投递 | `chunk-KFVDXO5Y.js:4312` `deliverMessagesViaStdin` |
| Driver 抽象 | `chunk-KFVDXO5Y.js:1261` (Claude driver `spawn`) |
| MCP server | `chat-bridge.js:537` `new McpServer` |
| Runtime 探测 | `chunk-KFVDXO5Y.js:4630` `detectRuntimes` |
| 工作目录 | `~/.slock/agents/<agentId>/`（`DATA_DIR` `:2637`） |

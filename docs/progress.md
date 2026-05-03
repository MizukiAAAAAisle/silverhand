# 实施进度

> 状态记录：每完成一个里程碑就追加一段。早于"今天"的内容只读、不改写。

---

## 2026-04-30 — M1 骨架完成

### 落地

- **Monorepo**：pnpm workspace（`apps/*` + `packages/*`），Node 24 / pnpm 10
- **`packages/shared`**：API DTO（zod）、SQL migrations、Driver 接口、ServerConfig schema、API path 常量
- **`packages/backend`**：Hono server + better-sqlite3（WAL）+ CORS + `startBackend({ dbPath, serverConfig }) → { url, port, close }`；零 Electron 依赖（远期可搬到云端）
- **`packages/chat-bridge`**：`@modelcontextprotocol/sdk` 的 `McpServer` + `StdioServerTransport`；`send_reply` / `check_messages` / `read_history` 三个 dummy 工具；HTTP 调 backend 的 `BackendClient`；`parseArgs` 接 argv + env
- **`apps/desktop`**：electron-vite + React 18；main 进程启动时拉起 backend、把 server URL 写回配置；preload 通过 `contextBridge` 暴露 `window.agentHub`；renderer 当前仅显示 backend mode/url/token/health 验证打通
- **配置**：`<userData>/server-config.json`（mode 0600，首次启动 `randomUUID()` 生成 token）；server URL 不暴露给用户；token 通过 env 注入 chat-bridge
- **启动脚本**：`scripts/dev.sh`（`pnpm dev`）—— 自动检查 node_modules、补装 Electron 二进制（pnpm 默认拦 postinstall）、按 stamp 文件判断是否需要 `electron-rebuild`、最后 `electron-vite dev`

### 验证

- `pnpm -r typecheck` 全过
- `pnpm dev` 能拉起 Electron 窗口；backend 监听 `127.0.0.1:<random>`；renderer 通过 `fetch /api/health` 拿到 `{ ok: true, mode: "embedded", ts: ... }`

### M1 调试踩过的坑（备忘）

| 现象 | 根因 | 修法 |
|------|------|------|
| `Error: Electron uninstall` | pnpm 拦 postinstall，Electron 二进制没下载 | `dev.sh` 增加首次自动跑 `node_modules/electron/install.js` |
| `__filename is not defined` | main 进程被当 ESM 加载 | 去掉 `apps/desktop/package.json` 的 `"type": "module"`，main 走 CJS |
| `Could not dynamically require ".node"` | `better-sqlite3` 被 bundle 进 main | `externalizeDepsPlugin` 只读 desktop 自己的 `package.json`；把 backend 的 runtime deps 显式加到 desktop |
| 空白窗口 | HTML 里写死的 CSP `script-src 'self'` 拦了 Vite HMR 的 inline script | 删 CSP meta；生产环境改用 `session.webRequest` 注入 |
| `window.agentHub` undefined | preload 输出从 `.mjs` 变成 `.js` 后 main 仍按 `.mjs` 加载 | 改回 `index.js` |
| renderer `Failed to fetch` | 跨域：renderer 在 `localhost:5173`、backend 在 `127.0.0.1:<port>` | backend 加 `hono/cors` |

---

## 下一阶段（M2 起点）

按文档第 10 节的 M2 + UI 工作并行推进：

### Track A：Driver + Session 端到端（核心通道）

1. `packages/shared/src/driver/claude.ts` —— Claude driver 实现（buildArgs / parseLine / encodeStdinMessage / buildSystemPrompt）
2. `packages/backend/src/session-manager.ts` —— spawn + stdin/stdout pipe + lifecycle + SSE 事件广播
3. chat-bridge 的 `send_reply` 真正写库 + 通过 SSE 推到 renderer
4. session 跨进程 resume

### Track B：UI（本阶段开始）

参考 `docs/design-new-theme.md` 的主题契约（CSS vars + `[data-theme]` + Tailwind v4 `@theme inline`）：

5. **主题系统基础**：`styles/global.css` + `styles/themes/<name>.css`，定义 §3 的全部 token；`useAppearance` hook；settings 占位
6. **Layout 骨架**：3 列布局（channel list | session tabs+messages | event panel）
7. **API 集成**：先把 channel/session CRUD 的 UI 接到 backend 的 stub 路由上
8. （Track A 完成后）真实的消息流 + 工具调用展示

---

## 2026-04-30 (晚) — 主题系统 + UI 骨架

### 决策

- **主题**：起手 `warm-coral`（暖米白底 + 珊瑚色 accent），token 定义照搬 `webskill-repos/api-anything` 项目的 `warm-coral.css`
- **UI 库**：shadcn/ui pattern（Radix + CVA + Tailwind），但不跑 shadcn-cli，组件按需手写到 `components/ui/`，className 直接用我们的 token（不维护 shadcn 的 `--background` `--primary` 那套别名）
- **Tailwind v4**：通过 `@tailwindcss/vite` 接入；`@theme inline { --color-bg-base: var(--bg-base); ... }` 把每个 token 暴露成 `bg-bg-base` / `text-text-primary` 这种工具类
- **状态管理**：TanStack Query（v5）用于所有服务端数据；本地 UI 状态走 `useState`
- **路由**：不用 React Router，view 状态用本地 state

### 落地

- **依赖**：`tailwindcss@4` `@tailwindcss/vite` `@tanstack/react-query@5` `clsx` `tailwind-merge` `class-variance-authority` `lucide-react@1` `@radix-ui/react-{slot,dialog,popover,tabs,select,tooltip,dropdown-menu}`
- **`renderer/styles/global.css`**：`@import tailwindcss` + 主题文件 + 完整 `@theme inline` 映射 + 全局 element 样式（scrollbar、selection、button cursor）
- **`renderer/styles/themes/warm-coral.css`**：完整 token 契约（背景 9 色 / 文本 6 色 / accent 4 色 / 语义 3 套 / 边界 4 / shadow / radius / fonts / motion）
- **`renderer/lib/cn.ts`**：`cn()` = `twMerge(clsx(...))`
- **`renderer/lib/api.ts`**：`api(path, init)` —— 自动注入 `Authorization: Bearer <token>` 和 backend URL
- **`renderer/lib/queryClient.ts`**：QueryClient 单例，staleTime 5s、不 refetchOnFocus
- **`renderer/hooks/useAppearance.ts`**：localStorage 持久化主题选择，写 `data-theme` 到 `<html>`
- **`renderer/settings/types.ts`**：`ThemeId` 联合类型 + `DEFAULT_APPEARANCE`
- **`renderer/components/ui/button.tsx`**：第一个 shadcn-style 组件，CVA variants（`default` / `soft` / `ghost` / `outline` / `danger`）+ sizes（`sm` / `md` / `lg` / `icon`），全用主题 token
- **3 列布局**：
  - `Sidebar.tsx` —— `Agent Hub` 标题 + 设置按钮 + `CHANNELS` section（带 + 按钮、空状态）+ 底部用户区
  - `SessionView.tsx` —— 频道标题 + 新会话按钮 + session tabs（active/idle/crashed 状态点）+ 中央消息流占位
  - `EventPanel.tsx` —— 右侧 280px，TanStack Query 实时拉 `/api/health` + backend info
- **`vite` alias**：`@/*` → `src/renderer/*`（`tsconfig.web.json` 的 `paths` 同步）
- **CJS main 与 preload 兼容**：preload 输出 `index.js`（去 `"type": "module"` 后），main 加载路径已对齐

### 验证

- `pnpm --filter @silverhand/desktop typecheck` 通过
- `pnpm dev` 启动，三栏布局可见，主题色正确，TanStack Query 拉到 `/api/health` 显示在右栏

### 下一步

- task #9：channel/session CRUD 端到端（backend 真实路由 + Sidebar/SessionView 接 mutation）
- 然后才进 Track A（Driver + SessionManager）

---

## 2026-04-30 (晚 +1) — Sidebar Members tab

参考用户给的 agent-city 截图，给 Sidebar 顶部加了 Channels / Members 两个 icon tab：

- 抽出 `sidebar-shared.tsx`（`SidebarSection` + `SidebarRow`，含 status 点 `active`/`idle`/`crashed`）
- `ChannelsPanel.tsx` —— 复用 SidebarSection 渲染频道列表
- `MembersPanel.tsx` —— 三个 section：
  - **AGENTS**：通过 TanStack Query 拉 `/api/runtimes`，显示 4 个运行时（claude / codex / cursor / gemini）+ 安装状态
  - **HUMANS**：占位 `local (you)`
  - **COMPUTERS**：占位 `this machine`
- `Sidebar.tsx` 包含 tab 切换逻辑（icon-only 双列按钮）

> v1 是单机单用户，HUMANS / COMPUTERS 都是占位；为 v2（remote / 多机）预留视觉位置，免得后期改结构。

---

## 2026-04-30 (晚 +2) — Channel/Session CRUD 端到端 + 真实运行时检测

### Backend

- `repos/channel-repo.ts` —— SQLite CRUD（list/get/create/update/delete）
- `repos/session-repo.ts` —— SQLite CRUD（listForChannel/get/create/delete），新建时 `status='idle'`、`pid=null`，cwd 跟着 channel 的 workspace_path
- `runtimes.ts` —— `which <binary>` + `<binary> --version` 真实探测；DETECT_BINARIES 映射：`claude` / `codex` / `cursor-agent` / `gemini`
- `routes.ts` —— `GET/POST/PATCH/DELETE /api/channels`、`GET/POST /api/channels/:id/sessions`、`DELETE /api/sessions/:id`，全部走 zod 校验
- **去掉 nanoid**：v5 是 ESM-only，main 进程是 CJS 加载会报 `ERR_REQUIRE_ESM`；改用 `crypto.randomBytes(12).toString('base64url')`（16 字符 url-safe ID）

### Renderer

- **shadcn-style 组件**：`components/ui/dialog.tsx`（Radix Dialog 包装 + 主题 token 化）、`components/ui/input.tsx`（Input + Textarea + Label）
- **`features/channels/hooks.ts`**：TanStack Query hooks —— `useChannels` / `useCreateChannel` / `useDeleteChannel` / `useSessionsForChannel` / `useCreateSession`
- **`features/channels/CreateChannelDialog.tsx`**：表单 = 名称 + 工作目录（带"浏览"按钮，调 IPC `dialog:pickDirectory` 打开 Electron 原生 folder picker）
- **`features/channels/CreateSessionDialog.tsx`**：表单 = 标题（runtime 暂硬编码 claude）
- **`App.tsx`**：channel/session 数据从 hook 拉，自动选第一个 channel；创建后 invalidate 对应 query；session 跟随 channel 切换重置
- **IPC**：`apps/desktop/src/main/index.ts` 加 `dialog:pickDirectory` handler；`preload/index.ts` + `preload/api.d.ts` 同步加 `pickDirectory(options?)`

### 验证

- `pnpm -r typecheck` 全过
- `pnpm dev` 启动后 curl 测试：
  - `GET /api/channels` → 空数组
  - `POST /api/channels` → 创建成功，返回 channel DTO
  - `GET /api/channels` → 1 项
  - `GET /api/runtimes` → 真实探测 `claude 2.1.122` + `codex 0.125.0` 已装、cursor + gemini 未装

### 下一步

进 Track A：
- task #10 Claude driver（`packages/shared/src/driver/claude.ts`）
- task #11 SessionManager（`packages/backend/src/session-manager.ts`）—— spawn + stdin/stdout pipe + lifecycle，让"创建 session"按钮真正拉起 claude 子进程

---

## 2026-04-30 (晚 +3) — 数据模型大重构（写入 core-design.md）

经过多轮对话，发现 task #9 用的 channel + 单 agent session 模型与产品核心目标（多 agent 协作）不符。重新对齐后产出 **`docs/core-design.md`** 作为产品权威文档，本进度文档不再重复模型细节。

### 关键决策摘要

1. **多 agent 协作是产品核心**——session 必须支持 N 个 agent 共享同一对话流（否则 1v1 不如直接开 terminal）
2. **Agent 是一等公民**：name + runtime + system_prompt + host_id；身份跨 channel 复用
3. **Channel 内嵌 workspace**：workspace_path NOT NULL，未填时后端自动生成在 `<userData>/silverhand/workspaces/<channel-name>/`
4. **DM = 特殊 channel**（`kind='dm'`）：复用一套表 + 路由 + UI
5. **Memory 在 agent 级别**：`<userData>/silverhand/agents/<id>/{MEMORY.md, notes/}`，通过 symlink 进入每个 workspace 的 `.silverhand/agents/<id>/`
6. **Consensus 在 workspace 级别**：`<workspace>/.silverhand/CONSENSUS.md`，所有 channel member agent 共享
7. **不引入 memory 类 MCP 工具**：用 agent 自带 Read/Write/Edit 即可（slock-ai 也是这么做的）
8. **防回声靠 system prompt 自律**（slock-ai 调研结论：他们也没机械防护），失控再加机械限制
9. **目录名 `.agent-hub` → `.silverhand`**（跟 app 名一致）

### 工程影响（待执行）

| 模块 | 改动 |
|------|------|
| `shared/db/migrations.ts` | 新建 v2 migration：加 `hosts` / `agents` / `channel_members` / `session_agents`；改 `channels`（加 `kind` `workspace_host_id`，`workspace_path` 改 NOT NULL）；改 `sessions`（删 `agent_id` `cwd` `worktree_path` `runtime` `model`）；改 `messages`（加 `from_kind` `from_agent_id` `from_user_id`，删冗余 `channel_id`）|
| `shared/api/dto.ts` | 新增 Host/Agent/SessionAgent DTO；ChannelDto 加 kind；SessionDto 不再带 agent_id |
| `backend/repos` | 新增 HostRepo / AgentRepo / MembershipRepo；改 ChannelRepo 加 workspace 自动生成 + .silverhand 目录初始化；改 SessionRepo 用 session_agents |
| `backend/runtimes.ts` | 保留（建 agent 时要用） |
| `backend/routes` | 加 `/api/hosts` `/api/agents` `/api/channels/:id/members` `/api/channels/:id/sessions/:sid/agents`；改 channel 创建逻辑加 workspace 兜底 |
| `renderer/features` | 拆出 agents feature；CreateChannelDialog 加成员选择、workspace 改 optional；新增 CreateAgentDialog；MembersPanel 改成显示真实 agent 列表 |
| **dev DB** | wipe 重建，目前 demo channel 数据丢失 |

### 下一步

执行 schema 重构（按上表），完成后再进 Track A（driver / SessionManager）。

---

## 2026-05-01 — Schema + CRUD 重构落地（task #13 完成）+ 子 session 设计写进文档（§3.6）

### 文档先行

跟用户多轮对话后，把 slock-style thread 的"消息归类 + 投递过滤"模式收编成更干净的 **§3.6 子 session（child session）**：真隔离子进程 / 父子双向通信 / close_session 强制 summary 回流 / 硬限 1 层嵌套。完整决策文档化于 `core-design.md` §3.6 + §6.2 的 thread 行改写 + §8 deprecated 表新增一行。

### Schema（dev DB wipe，写干净的单 v1）

- 新表：`hosts` `agents` `channel_members` `session_agents` `agent_inboxes`
- `channels` 加 `kind`（'regular'|'dm'）+ `workspace_host_id` + `dm_agent_id`，`workspace_path` NOT NULL
- `sessions` 删 agent_id/cwd/worktree_path/runtime/model；加 `parent_session_id`(FK self) / `spawned_by_agent_id` / `closed_at` / `close_summary`
- `messages` 删 role/channel_id；加 `from_kind`('user'|'agent'|'system') / `from_agent_id` / `from_user_id`
- 删 v1 没用的 `tasks` `reminders` `attachments`（推迟到 v2）

### Backend repos

- `host-repo.ts`：`ensureLocal()` 启动时自动创建 'local' host
- `agent-repo.ts`：CRUD
- `membership-repo.ts`：channel↔agent 关系
- `message-repo.ts`：每 session 自增 seq
- `channel-repo.ts` 拆成纯 DB insert + 独立的 fs 工具函数 `initWorkspaceDir` / `seedAgentL2` / `ensureAgentL1Dir`
- `session-repo.ts`：`insert()` 内置子 session 校验（max_depth / cross_channel / parent_closed / concurrent / cooldown）；`close()` `listChildren()` `countActiveChildren()` `addAgent()` `listAgents()` `removeAgent()`
- 新 `provision.ts`：`provisionChannel()` 编排 mkdir + DB insert + member 加入 + L1↔L2 seed + 自动建 Onboarding session + 系统开场消息；`provisionDmChannel()` 给 agent 创建时自动开 DM（workspace = L1 dir）

### Backend routes

- `/api/hosts` / `/api/agents` / `/api/agents/:id` (DELETE)
- `/api/channels/:id/members` GET/POST，`/api/channels/:id/members/:agentId` DELETE
- `/api/sessions/:id` GET，`/api/sessions/:id/agents` `/api/sessions/:id/messages` `/api/sessions/:id/children`，`/api/sessions/:id/close` POST
- `/api/channels/:id/sessions` POST 接受 `parent_session_id` + `context_summary` + `member_agent_ids[]`
- 子 session 限额错误统一映射 4xx：`max_depth_exceeded`→400 / `concurrent_limit`→429 / `spawn_cooldown`→429

### ServerConfig

加 `child_sessions: { max_concurrent_per_parent | null, spawn_cooldown_seconds | null, max_depth: 1 }`，v1 默认 null（不限）

### Renderer

- 新 `features/agents/`：`hooks.ts`（useAgents / useCreateAgent / useChannelMembers / useAddChannelMember）+ `CreateAgentDialog.tsx`
- `MembersPanel` 改成显示真实 agent 列表 + 创建按钮
- `features/channels/CreateChannelDialog`：workspace 改 optional（留空后端自动生成在 `~/.silverhand/workspaces/<name>`）+ 初始 member 多选 + 删掉 default_runtime（runtime 在 agent 上）
- `features/channels/CreateSessionDialog`：member 从频道 member pool 多选；新增 parent_session_id + context_summary 字段（子 session 模式）
- `SessionView`：tabs 改成树状（child indent + ↳ 前缀 + 关闭线划过）；header 当选中顶层 session 时多个"子会话"按钮
- `App.tsx`：新增 child session dialog + 把 SessionDto 的 parent_session_id/closed_at 透传给 SessionView
- `sidebar-shared.tsx` 的 `SidebarSection` 加 `action` slot（让 MembersPanel 注入自己的 dialog 触发按钮）

### 验证

- `pnpm -r typecheck` 全过
- 数据流符合 core-design §2.1 ER + §3.6 子 session 约束
- Dev DB 之前已经 wipe（`~/.silverhand/` 不存在），下次 `pnpm dev` 启动会自动按新 schema 建库 + 创建 'local' host + 建 workspaces 根目录

### 下一步

进 Track A：
- task #10：Claude driver（含 compaction 事件 + control_request interrupt + buildSystemPrompt 合成 §4.7 平台模板 + L2）
- task #11：SessionManager（spawn / §3.1 A+C 投递 / Claude gated steering / §3.2 两层打断 / §3.5 compaction observer / chat-bridge send_message 路由 / 跨进程 resume）
- chat-bridge 工具更新：`send_message(target?)` / `spawn_child_session` / `close_session`（task #11 范围内）

---

## 2026-05-01 (晚) — UI 重构 + Claude driver（task #10 完成）

### UI 调整（用户反馈）

1. **4 列布局**：之前主区把 session tabs 放在顶部，违反 IDE 直觉。改成 4 列：`Channels Sidebar | Sessions Sidebar (tree) | Session View (messages) | Event Panel`。会话父子关系靠侧栏树展示，主区只有消息流。
2. **删掉"新子会话"独立按钮**：违反 §3.6 设计——子 session 入口只有两个，agent 通过 MCP `spawn_child_session`，或 human 在某条消息上 replay（task #11 实现）。`CreateSessionDialog` 仍保留 `parentSessionId` + `contextSummary` 字段，作为未来 message 右键菜单的复用入口。
3. **扁平化 UI**：删掉所有非必要 box-shadow（sidebar 选中行的 shadow-sm 等）；主题 token `--shadow-popover` / `--shadow-modal` 大幅压低；`--shadow-button` 设为 none。只有真正"浮在内容上的卡片"（modal）保留极轻 shadow。

新文件：`SessionsSidebar.tsx`。`SessionView.tsx` 简化（去 tabs / 去 header 按钮）。CSS 加 `--sessions-sidebar-width: 240px`。

### Claude driver（`packages/backend/src/drivers/claude.ts`）

调研：
- 翻 `~/.npm/_npx/.../@slock-ai/daemon/dist/chunk-RNEIFBXW.js` 拿到 buildArgs / parseLine / encodeStdinMessage 全套
- `strings` 翻 Claude Code 二进制 (`~/.local/share/claude/versions/2.1.123`) 拿到 `control_request` 真实格式：`{type:"control_request", request_id:<uuid>, request:{subtype:"interrupt"}}`

实现：
- **架构决策**：driver 实现挪到 `packages/backend/src/drivers/`（用了 `node:crypto` + `NodeJS.ProcessEnv`，不能放 shared 里污染 renderer typecheck）。`packages/shared/src/driver/index.ts` 只留类型契约（`ParsedEvent` `McpConfigFile` `McpServerConfig`）
- **`Driver` 接口**：`kind` `binary` `busyDeliveryMode`('gated'|'direct') `supportsNativeStandingPrompt` `mcpToolPrefix` `buildArgs` `applyEnv` `buildSystemPrompt` `encodeStdinMessage` `encodeInterruptControl` `parseLine`
- **`buildPlatformPrompt`**：抄 §4.7 完整模板（Critical rules / Startup sequence / Workspace & Memory / Compaction safety / Channel consensus / Multi-agent etiquette / **Sub-sessions when to spawn** / Initial role），注入 agentId/agentName/runtime/mcpToolPrefix + L2 system_prompt 内容
- **ClaudeDriver**：
  - `buildArgs`：`--dangerously-skip-permissions --allow-dangerously-skip-permissions --verbose --permission-mode bypassPermissions --output-format stream-json --input-format stream-json --model sonnet|<model> --disallowed-tools EnterPlanMode,ExitPlanMode,ScheduleWakeup,Cron... --system-prompt-file <path> --mcp-config <path> --strict-mcp-config [--resume <id>]`
  - `applyEnv`：删 `CLAUDECODE`（防嵌套）
  - `encodeStdinMessage`：`{type:"user", message:{role:"user", content:[{type:"text", text}]}, session_id?}`
  - `encodeInterruptControl`：`{type:"control_request", request_id:<uuid>, request:{subtype:"interrupt"}}`
  - `parseLine`：覆盖 `system.{init|status:compacting|compact_boundary}` / `assistant.{thinking|text|tool_use}` / `user.tool_result` / `result.{success|error_during_execution|error_max_*}` → 输出统一的 ParsedEvent；`turn_end` 带 sessionId

### 验证

- `pnpm -r typecheck` 全过
- 手写 12 条 parseLine fixture（含 init / compaction / text / thinking / tool_use / tool_result / turn_end / 各种 error / 空字符串 / 非 JSON / 未知 type）—— **12/12 通过**

### 下一步

task #11 SessionManager：
- spawn lifecycle：用 detectRuntimes() 找 binary 路径 → driver.buildArgs/applyEnv → spawn → pipe stdin/stdout/stderr → driver.parseLine → 落 session_events + SSE 广播
- §3.1 A+C 投递：当前 turn 时根据 driver.busyDeliveryMode 决定（gated 等 safe boundary，direct 直推）；spawn 时从 inbox 拼初始 prompt
- §3.2 两层打断：soft = 投一条 directive 消息走 encodeStdinMessage；hard = encodeInterruptControl + SIGTERM (5s) → SIGKILL
- §3.5 compaction observer：接 compaction_started/finished，UI 广播 + 暂停 push + 5min watchdog
- chat-bridge 重写：`send_message(target?)` 走 internal route 写到目标 session 的 messages 表 + 触发 SessionManager 投递；`spawn_child_session` / `close_session` 走 internal route 调 SessionRepo
- 跨进程 resume：从 session_agents.cli_session_id 恢复
- 临时文件：mcp.json + system_prompt.md 写到 `<os.tmpdir()>/silverhand/<session-id>/`

---

## 2026-05-01 (晚 +2) — task #11 SessionManager 全套完成

按 5 个 phase 落地，每完成一段 typecheck pass 再下一段：

### Phase 1：基础设施

- **`event-bus.ts`** —— `SessionEventBus` 包 EventEmitter，`publish(sessionId, {kind,payload})` / `subscribe(sessionId, fn)`。挂在 `BackendContext.events`
- **`GET /api/sessions/:id/stream`** SSE 端点：长连接 + 30s heartbeat ping + onAbort 清订阅；通过 hono `streamSSE`
- **`spawn-prep.ts`** —— `prepareSpawnFiles({sessionId, agentId, systemPromptText, chatBridge})` 写 `<os.tmpdir()>/silverhand/<sid>/<aid>/{system-prompt.md, mcp.json}`，返回路径 + cleanup
- **§4.7 Session Context 段补全**：`platform-prompt.ts` 增加 `renderSessionContext(channelName/kind/sessionTitle/otherMembers/isChildSession/parentSessionTitle)`，输出"## This session"段。Driver 接口拆 `DriverPromptContext`（无路径） vs `DriverSpawnContext`（有路径）
- **`BackendContext.chatBridgeLauncher`**：host 注入；apps/desktop 用 `node_modules/.bin/tsx + packages/chat-bridge/src/cli.ts`

### Phase 2：SessionManager spawn + inbox drain

- **`session-manager.ts`** —— 类，实例挂 `BackendContext.sessionManager`，握有 ChannelRepo/AgentRepo/SessionRepo/MessageRepo/InboxRepo
- `start(sessionId, agentId)`：组 `DriverPromptContext` → `driver.buildSystemPrompt` → `prepareSpawnFiles` → `spawn(binary, driver.buildArgs(spawnCtx), {cwd: workspace_path, env: driver.applyEnv(process.env)})` → `readline` 包 stdout → 每行 `driver.parseLine` → `handleParsedEvent` 分发；同时 `session_agents.status` 走 `idle → starting → active`，`pid` 跟着进程
- `handleParsedEvent`：`session_init` 落 `cli_session_id` + 触发 inbox drain；`tool_call` `outstandingToolUses++`；`tool_output` `--`；`turn_end` 清零 + flush；`compaction_started/finished` 切 `compacting` flag + 启停 5min watchdog；所有事件原样 `publish('agent_event', {agent_id, event})` 给 SSE
- 子进程退出：`status` 设 `idle`（intentional/exit 0）或 `crashed`，pid=null，handle map 删除，watchdog 清，spawn-prep cleanup
- **`InboxRepo`** —— `agent_inboxes` CRUD：`enqueue` / `listPending(sid, aid)` JOIN messages / `markDelivered`
- **inbox drain**：`session_init` 时拉 pending → `formatInboxBatch(items, agentNameById)` 拼成 "You have N messages waiting…[from @x]\n…\n---\n[from @y]\n…" → `driver.encodeStdinMessage` → `child.stdin.write` → `markDelivered`

### Phase 3：投递 + 控制

- **`deliverMessage(sid, aid, messageId)`**：handle 不在 → `inboxes.enqueue`；存在 + `direct` 或 `isSafeBoundary` → 立刻 `writeUserMessage`；存在 + `gated` 中段 → 进 `pendingDeliveries`，`turn_end`/`compaction_finished` 时 `flushPending` 一次性 combined push
- **soft / hard interrupt**：`stop(sid, aid, mode='soft'|'hard', directive?)` —— soft 写一条 directive user message；hard `intentionallyStopped=true` → `encodeInterruptControl` 写 stdin → 5s 后 SIGTERM → 再 5s SIGKILL（unref 不阻塞退出）
- **`POST /api/sessions/:id/agents/:aid/{start,stop}`**：UI 控制；stop body 接 `{mode, directive}`
- **5min compaction watchdog**：`COMPACTION_STALE_MS = 5 * 60_000`；超时只 `publish('compaction_stale', {agent_id, elapsed_ms})` + warn log，不 kill（slock 同款）

### Phase 4：chat-bridge 接通

- **`internalPaths`** 重写：`agentSendMessage` / `agentSpawnChild` / `agentCloseSession`，路径 `/internal/sessions/:sid/agents/:aid/...`；删 v1 没用的 `receive` `history` `sessionInit`
- **`createInternalRouter`** 三个真路由：
  - `send-message`：`resolveTarget(current, target, sessions)` 校验 self/parent/child 可达性 → `messages.insert(from_kind='agent')` → `distributeMessage` 给其它 session_agents → `events.publish('message', ...)`
  - `spawn-child`：members ⊆ 父 channel → `sessions.insert(parentSessionId, spawnedByAgentId, spawnCtx)` 走限额校验（429/400 映射）→ `addAgent` × N → 两条 seed message（system context + agent initial_prompt）
  - `close`：校验 `closed_at===null` + `countActiveChildren===0` → `sessions.close` → `!posted_to_parent && parent` 时往父投 system summary（同走 distribute）→ stop 全部成员
- **chat-bridge 工具替换**：`send_reply`/`check_messages`/`read_history` → `send_message({content, target?})` / `spawn_child_session({title, members, context_summary, initial_prompt})` / `close_session({summary, posted_to_parent?})`，每个 tool 描述详细写明何时用
- **`args.ts`** 加 `--agent-id`；`BackendClient` 重写为 `sendMessage`/`spawnChildSession`/`closeSession` 三方法 + 通用 `post<T>`
- **`AgentSendMessageInputSchema` / `AgentSpawnChildInputSchema` / `AgentCloseSessionInputSchema` / `SendMessageTargetSchema`** 写进 shared，前后端共用

### Phase 4J：Onboarding 自动 spawn 全部 member

- `provisionChannel` / `provisionDmChannel` 在写完 system 开场白后：
  1. 对每个 member `sessionManager.deliverMessage(onboarding.id, agent.id, msgId)` → 进 inbox（agent 还没起来）
  2. fire-and-forget `sessionManager.start(onboarding.id, agent.id)`
- 子进程 `session_init` 时 inbox drain 把 system 开场白当首条 user message 灌入

### Phase 5K：Crash 恢复

- `SessionManager.reconcileOnBoot()`：扫 `session_agents.status IN ('starting', 'active')` 全部置 `idle` + `pid=null`，`cli_session_id` 留着；下次 `start()` 会用它做 `--resume`
- `startBackend` 启动时调一次
- 不做自动 re-spawn（§3.1：spawn 必须 user 触发，避免重启就跑 N 个 agent 烧 token）

### 验证

- `pnpm -r typecheck` 全过（每 phase 完成都跑一遍）
- E2E 还需要 UI 接 SSE + 加"wake agent"按钮（下个 UI 任务），目前可 curl 验证：
  - `POST /api/channels` 建 channel 后 → backend 自动 spawn 全部 member
  - `curl -N -H "Authorization: Bearer ..." /api/sessions/<sid>/stream` 看 SSE 事件流

### 下一步

- UI 接通：SSE hook + 消息流渲染 + "wake/sleep agent" 控件 + 显示 agent_status / compaction_stale 提示
- 跑通真实 onboarding 验证 agent 行为（看 platform prompt 是否产生预期 startup sequence）
- Codex driver（task: 新增）—— v1 多 runtime 第二个

---

## 2026-05-02 — UI / 协作模型 / 真 bug 修复一波

### UI 完善

- **Composer**：从 `⌘+Enter` 改成 **Enter 发送 / Shift+Enter 换行**，IME 安全（`onCompositionStart/End` + `e.nativeEvent.isComposing` 双重保护，避免中文候选选词被当 send）。Send 按钮改成 icon-only，绝对定位 `bottom-2 right-2` 嵌在 textarea 右下角（textarea `pr-12 resize-none`）。Stop 状态做了又拆掉——IM 设计里 stop 不应在 composer 出现。
- **DM vs 频道分组**：sidebar 把 channels 按 `kind` 拆成 `DM` 和 `CHANNELS` 两个 collapsible group。`SidebarSection` 新增 `collapsible`/`defaultExpanded`，header 变成可点的 chevron 按钮（不带 hover bg，只 hover text）。`ChannelGroup` 取代 `ChannelsPanel`，按 kind 选 icon（`MessageSquare` / `MessageCircle`），DM 显示名 strip 掉 `dm-` 前缀。
- **`SessionView` / `SessionsSidebar` / `CreateSessionDialog` 接 `channelKind` prop**：
  - DM：隐藏 `AgentStrip`（单 agent 冗余），隐藏 manage-members 按钮（DM 成员固定）。
  - DM 的 `CreateSessionDialog`：去掉成员选择，只显示 hint，`member_agent_ids` 自动 = `[dmAgentId]`。
  - 普通频道：成员选择从 chip-toggle 改成 **dropdown + chips**——已选的展示成可移除 chip，候选放 `<select>` 里（已选的过滤掉），选中后下拉自动复位。
- **SessionsSidebar header**：channel name 下方加 `workspace_path` 副标题，长路径用 `dir="rtl"` + `truncate` 让省略号吃掉前缀（`…/silverhand/foo`）；hover 看完整 `title`。

### 协作模型 bug 修复

- **`POST/DELETE /api/channels/:id/members` 之前只动 `channel_members` 一行**——加成员后既不 seed L2，也不同步到现有 session。导致后加进来的 agent 看不到 MEMORY.md（"doesn't exist yet" 现象的根因），且根本不在任何 session 的 `session_agents` 里，发消息也收不到。
- 新增 `joinChannel(channelId, agent, opts)` provision helper：persist `channel_members` → `ensureAgentL1Dir` + `seedAgentL2`（继承 L1 即 DM 中塑造的 MEMORY）→ 加到所有 root open session（child session 是显式子集，不强制同步；closed 也跳过）→ 每个 session 投一条 `@xxx joined` system 广播 → spawn 新 agent。幂等。
- 新增 `leaveChannel(channelId, agent, opts)`：先 `sessionManager.stop` hard 干掉运行中进程 → `removeAgent` from 所有 root session → 删 `channel_members` → 给剩余成员投 `@xxx left`（仅 open session）。**不删 L2 文件**，agent 重新加入时 MEMORY 还在。
- routes `POST/DELETE /api/channels/:id/members` 全部走新 helper。

### Onboarding 命令式重写

- 之前 `ONBOARDING_BODY` 是描述性 "Welcome to #foo. Members: ..."——agent 按 platform prompt 规则（"system 消息默认是 informational，不回复"）正确选择沉默。
- 仿 `@slock-ai/daemon` 的 onboarding 调性，重写为**每个 member 一条**专属 system 消息：`Onboarding task (system-triggered): You (@xxx) just joined #foo. ... 1) send one short greeting via mcp__chat__send_message. 2) Stop after greeting.`
- DM 的 onboarding 同样改成命令式（"You are now in your personal DM... send one short greeting and ask what role I want you to play."）。
- `ONBOARDING_BODY` 签名从 `(channelName, members)` 改成 `(channelName, recipient, others)`，provisionChannel 循环每个 member 各 insert 一条带个性化 body 的 system 消息。

### 启动机制 / 平台 driver 一致性

- **chat-bridge launcher 改用 `npx tsx`**（packaged 时走 `node + dist/cli.js`），不再硬指向 `packages/chat-bridge/node_modules/.bin/tsx`——pnpm hoisting 布局是变量，先前的硬路径 packaged build 直接失效，且首次出问题时表现是 agent 永久沉默（claude 无 MCP，回复全是 plain text 不可见）。对齐 slock-ai。
- `assertLauncherResolvable()`：absolute path → `existsSync`；bare name → POSIX `which` / Windows `where`（`execFileSync` 不开 shell）。boot 时直接 fail，不要等到第一次 spawn 才 ENOENT。
- platform prompt 加 **Communication style** 段：default 1-2 句、no filler ack、no idle narration、no echoing tool calls。Slock 不通过 disallowed-tools 屏蔽 `ToolSearch` / `WebFetch` / `WebSearch`——这些是合法工具，话痨问题用 prompt 治。先前提议加进 `--disallowed-tools` 已撤回。

### 真 bug：spawn-time stdin 不 prime 导致 claude 偶发 hang

- 现象：新建 channel → backend 正常 spawn claude → chat-bridge 正常 connect MCP → 但 claude 90+ 分钟不吐 `session_init`，inbox 里 onboarding 消息永远不被 drain，UI 看 agent 状态死在 `starting`。
- 根因（对比 `@slock-ai/daemon:1334-1360` 找到）：slock spawn 完**同步**写第一条 user message 到 stdin；silverhand 等 `session_init` 才 drain inbox。claude 在 `--input-format stream-json` 模式下 stdin 起手为空时偶发死锁——可能在等 stdin 上的 first input 才完成 init。slock 永远 prime 所以从不 hit；silverhand 的"agent 没起来时进 inbox"路径偶发 hit。
- 修法：`AgentHandle` 加 `drainChain: Promise<void>` 串行化；`drainInbox` 拆成 scheduler + `doDrainInbox`（实际工作）；`start()` 在挂完 `child.on('exit')` 后立刻 `drainInbox(handle)`（fire-and-forget + log）。`session_init` handler 里的 `drainInbox` 保留为兜底，chain 保证不会双写同一条。
- 附带没做但记下：`session_init` watchdog（30s 没收到就 `crashed` + 通知 UI）+ auto-start filter 对 `starting` 加老化判断 + UI 区分 `starting` / `active`——root cause 不是 claude 是这次的 silverhand 顺序错，watchdog 优先级降为 P2。

### 文件级日志

- 新增 `packages/backend/src/logger.ts`（`createFileLogger({dir, alsoConsole, base})` → JSONL `<dir>/backend-<utc>.log`）和 `packages/chat-bridge/src/logger.ts`（同 schema 写 `chat-bridge-<sid>-<aid>.log`）。
- main 进程通过 `SILVERHAND_LOG_DIR` env 把日志目录传给 chat-bridge 子进程。
- session-manager / chat-bridge 给所有关键路径加 log（`deliver: ...` 三分支、inbox drain、agent stderr、handleParsedEvent 的 session_init / tool_call / turn_end / compaction / error、tool 调用前后、HTTP 失败 + body）。直接救了上面一系列 bug 的定位。

### 文档

- `docs/core-design.md` 新增 §10 "Deferred design — Channel 设置 / 改名 / archive"，钉住改名走 system-message 广播方案（让 agent 自己更新 MEMORY 里的旧名引用）；archive 暂不做但记下数据模型 + 关停步骤。§9 待决策第 4 条标"翻案"指向 §10。

### 验证

- `pnpm -r typecheck` 全过；`./scripts/test.sh` 99/99 全过（每个改动后跑）。
- 用户手动验证：spawn-time prime 修复后，新建 channel onboarding 不再 hang，agent 都能正常回复。
- DM 改造、sidebar 分组、composer 新交互全部 UI 实测过。

### 下一步

- `session_init` watchdog（P2 兜底，防 claude 真出 bug 时 silverhand 看不见）。
- `PATCH /api/channels/:id` 改名端点 + 自动广播 system 消息（§10 方案）。
- archive 端点 + sidebar `Archived` 折叠分组。
- 仍未做：Codex driver。



## 2026-05-02 — UI 重设计 spec（doc-only）

### 落地

- 新增 `docs/app-layout.md`：定义全套 UI 重构方案——markdown message 渲染、消息 hover/timestamp、Save（全局 sidebar 入口 + 平铺列表 + 跳回锚点）、Reply 触发 child session（split view，父 channel 发件 agent 自动入选，core-design §3.6 的 human 触发分支）、自绘 titlebar（macOS hiddenInset + traffic-light 占位，channel info 从 sessions sidebar 顶部迁过来）、sidebar 宽度可拖拽 + localStorage 持久化、events panel 改独立 dev-only window（macOS 应用菜单切换 + pin）。
- `CLAUDE.md` 授权 doc 列表追加 `app-layout.md` 和 `design-new-theme.md`，明确两文档分工：theme 管 token，layout 管布局/交互。

### 关键决策

- **system 消息识别 onboarding**：复用现有 `messages.metadata` JSON 列写 `subtype: 'onboarding'`，不加 schema column。其他 subtype（`join` / `leave` / `child_summary` / `reply_quote`）同理。
- **Save 不分 category**：单一全局列表，schema 不预留 tag 字段；将来要加做新表。
- **child session human-trigger 默认成员 = 仅发件 agent**：跟 core-design §3.6 "spawn 必须想清楚拉谁" 一致；后续可通过 channel-level Manage Members 加；child 内单独管理 v1 不做。
- **Reply 引用走结构化 quote**：第一条 system message 带 `quoted_message_id` metadata，UI 渲染成可点的"跳回原消息"按钮，不仅仅是文本引用。
- **child session pane 同时只允许一个**：sidebar 切换不同 child = 替换 pane（v1 直接替换 + confirm）；硬限 1 层嵌套（core-design §3.6 已写死）。
- **Events Panel 完全移出主窗口**：普通用户不需要感知 process/event；走 macOS 应用菜单 → Developer → Show Events Window，独立 BrowserWindow 可 `alwaysOnTop` pin 住。
- 文档分工：`design-new-theme.md` 只管 token（颜色、间距、排版），`app-layout.md` 只管布局结构 + 交互流程，互不重复。

### PR 切分

7 个 PR 串行（PR1 → PR2 是依赖链；PR3-7 之间彼此不阻塞，按编号顺序最稳）：
1. markdown + message hover/timestamp
2. saved_messages migration + system metadata.subtype 注入
3. Save 后端 + Sidebar Saved 入口 + Saved List View + 跳回锚点
4. POST /messages/:id/reply + provisionChildSessionFromReply + Split view UI
5. 自绘 titlebar（macOS 优先，Win/Linux 后续）
6. useResizableWidth hook + Sidebar 拖拽 + localStorage
7. Events 独立 window + 应用菜单切换 + pin

### 验证

- 文档 only；无代码改动，无 typecheck/test 必要。下次落 PR 时再跑 `pnpm typecheck` + `./scripts/test.sh`。

### 下一步

- 进 PR1：装 react-markdown + remark-gfm + rehype-highlight + dayjs，新建 `components/chat/{Markdown,MessageItem,SystemMessage}.tsx`，替换 `SessionView.tsx` 里的 `MessageBubble`。



## 2026-05-02 (晚) — UI 重设计 7 个 PR 全落地 + 一波 polish

### 落地（PR1 → PR7）

- **PR1 markdown + 消息渲染**：装 react-markdown / remark-gfm / rehype-highlight / dayjs，新增 `components/chat/{Markdown, MessageItem, SystemMessage, useRelativeTime, useMessageLayoutMode}.tsx`，替换旧 `MessageBubble`。link 走 `window.agentHub.openExternal`（main 进程 http(s) 白名单）；code block 带 copy 按钮。消息 hover 框 = `border-2 border-accent + bg-bg-floating`；action bar（Reply/Save）只在 hover 时露。
- **PR2 metadata.subtype + saved schema**：迁移 v2 加 `saved_messages` 表（`UNIQUE(message_id)`，FK CASCADE）；provision 路径 4 处 system 消息插入加 `metadata.subtype`（`onboarding` / `join` / `leave`）。`SystemMessage` 折叠依据 `subtype`，老数据用 content 前缀 `inferSubtype` 兜底。
- **PR3 Save 后端 + Sidebar 入口 + 跳回**：新增 `GET /api/saved`、`POST/DELETE /api/messages/:id/save`、`SavedMessageRepo`（JOIN 出 channel_name + session_title + agent_name）；renderer 新增 `features/saved/hooks.ts`（useSavedMessages / useSavedMessageIds / useToggleSave，全部共享 `['saved']` query key 让 count 实时更新）。Sidebar 顶部加 `Saved` 入口，count 内联在标题后；点 item → `handleJumpToMessage` 跳到对应 session 并闪烁 1.6s。
- **PR4 Reply → 子 session + split view**：`POST /api/messages/:id/reply` 写 child session + `reply_quote` system 消息（denormalized snapshot：`quoted_content` / `quoted_from_kind` / `quoted_agent_name` / `quoted_created_at`）；`findOpenReplyChild(parentId, quotedMessageId)` 复用同源 reply。renderer 拆 `App.tsx` + `SplitPane`，子 pane 在右、X 关闭。子 session 顶部用紧凑 header `Reply — #parent · view in session`，原文 `<QuotedMessagePreview>` 卡片放在消息流上方。jump back 也关闭 child pane。
- **PR5 自绘 titlebar**：mac `titleBarStyle: 'hiddenInset'` + `trafficLightPosition: { x: 12, y: 11 }`；新建 `components/layout/Titlebar.tsx`，channel info **从 sessions sidebar 顶部迁过来**且左 pad = `var(--sidebar-width)`，与 SessionsSidebar 列对齐。More menu = Copy Workspace Path / Delete Channel（destructive 红字）；Members + Create Session 也搬上来；workspace path inline 排在 icons 后（不甩到最右），rtl 截断保留路径尾部。SessionsSidebar 整个 header 删除。
- **PR6 sidebar 拖拽 + 持久化**：新增 `hooks/useResizableWidth.ts`，localStorage round-trip + 镜像到 CSS var（让所有 `var(--sidebar-width)` 消费方自动响应，无需 prop 下钻）。drag 监听 `document` 而不是 splitter 元素本身——4px 命中区太薄，pointer 出区会丢事件。新增 `components/layout/VerticalSplitter.tsx`（4px 主体 + ±6px 透明命中区）。约束：Sidebar 200–360、SessionsSidebar 200–400。SplitPane 既有 0.25–0.75 不动。
- **PR7 Events 独立 window**：删 `<EventPanel />`；抽 `components/dev/EventStream.tsx`。新增 renderer entry：`events.html` + `events/main.tsx` + `events/EventsApp.tsx`（共享 `lib/api` / `useAppearance` / queryClient）。vite config 加 `events: ...html` input。main 进程 `showEventsWindow()` 单例（480×720，关掉重开新建），`Menu.setApplicationMenu(buildAppMenu())` 加 `View → Developer → Show Events Window` `⌥⌘E`。

### 关键决策 / 修复

- **`session_init` 每个 turn 都触发**（root cause 查清楚）：claude `--input-format stream-json` 在每次 user 消息进来时都会发 `{type:'system', subtype:'init', session_id}`，并不是只在 process 启动时一次；同 process 内 session_id 复用。`drivers/claude.ts:120` 不区分首次/后续，`session-manager.ts:373` 因此每 turn 都跑全套（status flip / publish / log / `drainInbox`）。修复：在 `case 'session_init'` 顶部加 `if (handle.cliSessionId === ev.sessionId) break;`——同 id 视作 turn 边界，no-op；id 变了才走全套。顺手堵了"刚 deliver 的 inbox row 又被 drain 一次"的小窗口。
- **child session pane 高亮父消息**：child `ActiveSessionView` 通过新 prop `onReplyQuoteResolved` 把 `quoted_message_id` 报给 App；App 存 `highlightedParentMessageId` 再下钻给父 pane 的 `MessageList`，`MessageItem` 接 `highlighted` prop 强制 hover 框（但不露 action bar）。child 关闭自动清。
- **Reply 复用机制 = `findOpenReplyChild`**：用 SQLite `json_extract(metadata, '$.subtype')` + `'$.quoted_message_id'`，同 parent + 同源 message + 未关闭即复用，避免 reply 同一条消息时无限新建 child。
- **legacy 数据兼容**：老 reply_quote 没 snapshot 字段，`QuotedMessagePreview` 通过 `useMessage(quoted_message_id)` 走 `GET /api/messages/:id` 兜底（`staleTime: Infinity`，message 写后不变）。
- **Manage Members 改 popover（不是 dialog）**：`ManageMembersPopover` 用 Radix Popover + Radix Select（shadcn 风格），布局 = 顶部添加成员 selector + AGENTS section + HUMANS section（占位，data model 暂无人类成员概念）。空候选 **不 disable selector**，下拉打开里给 hint——disable 是阻断式设计。`align="start"` + 260px。
- **Events 窗口的 Pin 也搬到 window titlebar**（不放系统菜单）：preload 加 `agentHub.setWindowAlwaysOnTop(pinned)`，main 进程 `window:setAlwaysOnTop` IPC 用 `BrowserWindow.fromWebContents(event.sender)` 拿 sender window，自带泛用性。Pin 按钮：off = `PinOff` 灰；on = `Pin` accent + tinted bg。
- **agent strip 移进 session header**：原来在 header 下面占一整行，现在 `ml-auto` 收到 header 右侧，跟 X close 按钮挤一起。chip 缩到 `px-1.5 py-0.5`、status label 降到 `text-[10px]`，溢出直接 `overflow-hidden` 不换行。
- **Channel Rename 暂未做**：spec §2 的 More 菜单列了 Rename / Manage Members / Copy / Delete，实际只做了后三个——backend 没 PATCH /api/channels/:id 端点也没现成 UI 复用，列入"下一步"。

### Schema / 端点变化

- 迁移 v2：`saved_messages(id, message_id UNIQUE, session_id, channel_id, agent_id, created_at)`，全 FK CASCADE。
- 新增 endpoints：`GET /api/saved`、`GET /api/messages/:id`、`POST /api/messages/:id/save`、`DELETE /api/messages/:id/save`、`POST /api/messages/:id/reply`。
- 新增 IPC：`window:setAlwaysOnTop`、`shell:openExternal`（已有，本次 PR1 加的）。

### 数据清理

- 老 reply duplicate `phqOhdRauIHfaJrz` 删了（PR4 reuse 逻辑没生效前的 leftover；FK CASCADE 顺手把 2 条 message 也清了）。

### 验证

- `pnpm typecheck` 全过；`./scripts/test.sh` 99/99 全过（每个 PR 完成后跑）。
- 用户手动验证：所有 7 个 PR + post-PR polish 都 UI 实测过；session_init 修复跑过完整 spawn → reply → close cycle。

### 下一步

- **Channel Rename**：`PATCH /api/channels/:id` + name uniqueness check + Titlebar More 菜单加项 + 弹个改名输入。
- **平台范围 = macOS**（明确写到 `app-layout.md` §0/§2/§11）：v1 不支持 Win/Linux，**主线代码不要再加 `process.platform !== 'darwin'` 兼容分支** —— 现在代码里残留的 `titleBarStyle` / `trafficLightPosition` 三元已经是无害的（值为 `undefined`），但新代码（min/max/close 自绘按钮、自绘 titlebar fallback、frame:false 等）一律不写。后面要补 Win/Linux 时开新分支统一处理。
- **session_init watchdog**：P2 兜底，和上一阶段同样的事项继续 carry over。
- **archive endpoint + sidebar Archived 折叠分组**：carry over，仍未做。
- **Codex driver**：carry over，仍未做。



## 2026-05-02 (晚 +1) — Channel Rename

### 落地

- **Backend**：`PATCH /api/channels/:id` —— `UpdateChannelInputSchema`（同 create 的 name 校验：1–64 字符 + `[a-zA-Z0-9_-]+`）；`ChannelRepo.rename(id, name)` 写 DB；DM channel（`kind='dm'`）一律拒（400）；同名冲突 409；同名 no-op 200 直接返回。改名成功后，对 channel 下每个**未关闭的 root session** 插一条 `system` 消息（`metadata.subtype='rename'` + `old_name` + `new_name`），通过现成 `sessionManager.deliverMessage` 投递给所有在场 agent —— 在线的当作普通入站消息，离线的进 inbox。同时 `events.publish('message', ...)` 让 SSE 也有动静。子 session 不广播（snapshot 语义；它们的对话历史里出现新 channel 名会很突兀，且多数情况下子 session 寿命短，不值得搅）。
- **Renderer**：
  - `useRenameChannel` mutation —— PATCH + 成功后 invalidate `['channels']` 和该 channel 的 sessions key（让 messages 列表也刷新出 system 通知）。
  - `RenameChannelDialog`（`features/channels/`）—— 复用 Dialog/Input 组件，输入框前 prefill 当前名称、autoFocus；客户端做一遍同样的 regex 校验避免无谓 round-trip；改成同名直接关闭（不发 PATCH）。
  - `Titlebar`：More 菜单顶部加 `Rename channel…` 项（DM 隐藏），保留 separator 逻辑——只要 Rename + Copy workspace path 至少有一项就在 Delete 上方画 separator。
  - `App.tsx`：新增 `renameChannelOpen` state；`onRenameChannel` 仅当 `selectedChannel` 存在时透传给 Titlebar。
- **Tests**：5 个新用例（rename success + 广播 + 投递、409 dup、400 invalid name、400 DM 拒绝、no-op same name 不广播、404 unknown id）。`HttpHelper` 加 `patch()` 方法（顺手把 jsonReq 提取出来给 POST/PATCH 复用）。

### 验证

- `pnpm typecheck` 全过；`./scripts/test.sh` 105/105（原 99 + 6 rename，含 HttpHelper 改造未触发回归）。

### 下一步

- **session_init watchdog**：carry over P2。
- **archive endpoint + sidebar Archived 折叠分组**：carry over。
- **Codex driver**：carry over。




## 2026-05-02 (再晚) — Reply → Thread 概念重命名

### 动机

"Reply" 在 IM 心智里是"回复某条具体消息"，但我们这里实际语义是"在某条消息上单独开一个 session 讨论"，跟 IM 单条 reply 不一致。Slack/Discord 把这个交互叫 **Thread**，更贴切也更易懂。统一后命名层次更干净：UI 概念 `Thread` ↔ 底层实现 `child session`（保持原名，因为 `spawn_child_session` MCP 工具走同一机制但**不算 Thread** —— 没有 anchor）。

### 改动范围

- **UI 文案**：按钮 `Reply → Thread`、header 徽标 `Reply → Thread`、`↳ replying to → ↳ thread from`、session title 前缀 `Reply: → Thread:`、onboarding 文案 "joined a reply sub-session" → "joined a thread"
- **API**：`POST /api/messages/:id/reply → /thread`；`apiPaths.messageReply → messageThread`
- **代码标识符**：
  - 目录 `features/reply/ → features/thread/`，`useReplyToMessage → useStartThread`
  - 文件 `replyQuote.ts → threadAnchor.ts`，函数 `findReplyQuote/readQuotedMessageId → findThreadAnchor/readAnchorMessageId`
  - 组件 props `onReply/onReplyCreated/onReplyQuoteResolved` → `onStartThread/onThreadCreated/onThreadAnchorResolved`
  - repo 方法 `findOpenReplyChild → findOpenThreadChild`，SQL `subtype='reply_quote'` → `'thread_anchor'`
- **DB**：migration v3 `rename_reply_quote_to_thread_anchor` —— `UPDATE messages SET metadata=json_set(metadata,'$.subtype','thread_anchor') WHERE subtype='reply_quote'`。pre-v1 直接改写既有行，无需双读兼容。
- **不动**：`child_session` schema/字段/配置项、`spawn_child_session` MCP 工具、`parent_session_id` —— 这些是底层机制，Thread 只是触发它的一种入口。
- **Docs**：`app-layout.md` §7 整段改名 + 加命名说明；`core-design.md` §3.6 第 1 条交叉引用更新（写明 agent spawn 跟 human Thread 的产物差异：thread_anchor 的有无）。

### 验证

- `pnpm typecheck` 全过
- `./scripts/test.sh` 105/105，无回归

## 2026-05-02 (再再晚) — Thread 按钮显示 reply 数

### 动机

消息上的 `Thread` 按钮在已经存在 thread 的情况下没有任何视觉提示，用户只能 hover 或者打开 thread 才知道里面有内容。改成已存在 thread 时按钮变成 `<count> Reply`（持久可见），跟 Slack 的 thread badge 心智一致；count = thread 内非系统消息数（不含 anchor + onboarding seed）。

### 后端

- `SessionRepo.listOpenThreadsForParent(parentId)` —— 单 SQL：`sessions JOIN messages` 拿 `thread_anchor` 行 + 子查询 `COUNT(*) WHERE from_kind != 'system'`。命中现有 `idx_sessions_parent` + `idx_messages_session`，避免 N+1。
- `GET /api/sessions/:id/threads` —— 返回 `{ threads: [{child_session_id, anchor_message_id, reply_count}] }`。
- 新 SSE event kind `thread_updated`（payload: `{parent_session_id, child_session_id}`）从 4 个写路径推到父 session 的 stream：
  - `POST /api/messages/:id/thread`（thread 创建后）
  - `POST /api/sessions/:id/messages`（target 是 child 时）
  - `POST /internal/.../send-message`（target 是 child 时）
  - `POST /internal/.../close`（child 关闭时，无条件 publish——badge 要消失）
- 关闭 thread 的 publish 放在 `posted_to_parent` 分支外面，因为不论是否写 child_summary，badge 都该消失。

### 前端

- `useSessionThreads(sessionId)` —— React Query + 监听 parent stream 上的 `thread_updated` 事件做 invalidate。`enabled` 只在 SessionView 是 parent pane（`onThreadCreated` 存在）时打开 —— child pane 不能开 grandchild，没必要 fetch。
- `useSessionStream` known events 加上 `thread_updated`。
- `SessionView` 拿到 `threads` 后 `useMemo` 出 `Map<anchor_message_id, ThreadSummary>` 传给 `MessageList` → `MessageItem`。每条消息 O(1) 查询 threadInfo。
- `handleStartThread` 短路：如果 `threadByAnchor.get(msg.id)` 命中就直接 `onThreadCreated(existing.child_session_id)`，跳过 POST 网络往返。
- `MessageItem` 新增 `threadReplyCount?: number` prop。`ActionButton` 加 `alwaysVisible` + `hovered` props 做 per-item 可见性控制 —— `{count} Reply` badge 在 thread 存在时常驻可见，Save 仍然 hover-only。Action bar wrapper 不再用整体 opacity gate。

### 性能要点

- 一次 SQL 拿全部 summaries，零 N+1
- SSE 驱动 invalidation，零轮询
- Map 查询 O(1)
- 子 session view 跳过整个 fetch
- 已存在 thread 的"打开"操作跳过 POST，纯本地状态切换

### 测试

- repo 4 用例：基础形状、关闭 thread 排除、agent-spawn 的 child（无 anchor）排除、空 parent
- route 2 用例：404、端到端 0 → 2 reply 计数变化

### 验证

- `pnpm typecheck` 全过；`./scripts/test.sh` 111/111（原 105 + 6 新）


## 2026-05-02 (深夜) — Codex + Cursor driver 落地

### 调研：和 slock-ai 三个 driver 的对比

调了 `@slock-ai/daemon` 的 claude / codex / cursor driver。以 claude 为基准对比：

**Claude — 几乎一致**
- 都是 `claude --input-format stream-json --output-format stream-json --system-prompt-file <path> --mcp-config <path> --strict-mcp-config`
- 同样删 `CLAUDECODE` env、同套 disallowed tools、同 `--resume <id>`
- `parseLine` 几乎逐字段相同（system/init、assistant blocks、user/tool_result、result）
- 我们多一层 `encodeInterruptControl()` 用 `control_request` 主动打断；slock 直接走信号
- slock spawn 时立即 `proc.stdin.write(ctx.prompt)` 当 kickoff；我们没"initial prompt"概念，统一用 inbox + drainInbox 喂第一条

**Codex — 协议形态完全不同**
- 不是 stream-json 而是 `codex app-server --listen stdio://` + JSON-RPC 2.0
- 必须先 `initialize` → `initialized` → `thread/start`（或 `thread/resume`）握手才能发首轮
- standing prompt 走 RPC 参数 `developerInstructions`，不是 CLI flag
- MCP 不接受 `--mcp-config <path>`，只能用 `-c mcp_servers.chat.command=<json>` 串内联
- 中途投递走 `turn/steer`（活跃 turn）或 `turn/start`（idle）；`busyDeliveryMode = 'direct'`
- `mcpToolPrefix = 'mcp_chat_'`（codex 用 `_` 分隔）
- 必须 cwd 是 git repo，否则启动失败 → 自动 `git init`
- 驱动天然 stateful：threadId / activeTurnId / requestId / 流式 item id 集合都得跟着 handle 走

**Cursor — 一次性进程**
- `cursor-agent --print` 模式 = 单次执行，处理完 prompt 就退出，没有 stdin 持久通道
- 没有 `--system-prompt` 之类的 flag，standing 指令必须串到 positional prompt 里
- MCP 配置写到 `<workspace>/.cursor/mcp.json`
- 输出格式 `stream-json` 跟 claude 同结构（system/init / assistant blocks / result）
- slock 标 `supportsStdinNotification = false` + `busyDeliveryMode = 'none'`，靠 daemon 重启来送新消息

### 改动

**Driver 接口（`packages/backend/src/drivers/index.ts`）**
- `busyDeliveryMode` 多一档 `'none'`
- 新增 `oneShot: boolean`：true 表示进程跑完一轮就退出（cursor）
- `encodeStdinMessage` / `encodeInterruptControl` 返回 `string | null` —— null = 没法走 stdin（一次性 driver / 无打断协议）
- `DriverSpawnContext` 新增两字段：
  - `chatBridge: McpServerConfig` —— 不走 temp `mcp.json` 的 driver（codex 内联、cursor 写 `.cursor/mcp.json`）需要拿到原始 launcher
  - `initialPrompt: string` —— 一次性 driver 的 kickoff 文本（spawn 前同步 drain 出来的 inbox）
- 新增可选 `bindIO(io)` 钩子：spawn 后调一次，给 codex 启 JSON-RPC 握手用
- `getDriver(kind)` 改成工厂模式（codex 实例 stateful，不能共享单例）

**`drivers/codex.ts` —— 新文件**
- 完整 JSON-RPC 2.0 状态机：在 `bindIO` 里 `initialize`，response 后发 `initialized` + `thread/start|resume`，`thread/started` 后宣布 `session_init` 并发首轮 `turn/start`
- 把 `pendingInitialPrompt` 从 `spawnCtx.initialPrompt` 抽出来：spawn 时 inbox 非空就拿来当 kickoff，empty 则建好 thread 等下一条
- `parseLine` 处理 RPC response、`thread/started`、`turn/started`、`item/agentMessage/delta`、`item/reasoning/{summaryText,text}Delta`、`item/started`/`item/completed`（reasoning / agentMessage / commandExecution / contextCompaction / fileChange / mcpToolCall / webSearch）、`turn/completed`、`error`
- 流式 item id 集合用来去重 `item/completed` 和已 streamed delta 的双发

**`drivers/cursor.ts` —— 新文件**
- `oneShot = true`、`busyDeliveryMode = 'none'`
- spawn 前在 workspace 写 `.cursor/mcp.json`
- argv 末尾的 prompt = `<systemPromptText>\n\n---\n\n<initialPrompt>`；inbox 空时塞默认"stand by"占位以免 cursor-agent 报空 prompt
- `parseLine` 几乎复用 claude 的 stream-json 解析

**`SessionManager` 配套**
- 把 chat-bridge launcher 提到 spawn 前组装一次，同时塞进 `prepareSpawnFiles` 和 `spawnCtx.chatBridge`
- 一次性 driver：spawn 前同步 `inboxes.listPending` → 格式化进 `initialPrompt` → spawn → 进程起来后立刻 `markDelivered`，跳过 post-spawn drain
- spawn 后调 `driver.bindIO?.({ writeLine, spawnCtx })`
- 一次性 driver 的 `child.on('exit')`：如果是非主动停止 + inbox 还有积压 → 立刻 `start()` 自动重启，不然消息会沉底
- `deliverMessage`：
  - agent 不在跑 + 一次性 driver → 入 inbox 后立即 `start()`
  - agent 在跑 + `busyDeliveryMode === 'none'` → 入 inbox（exit handler 兜底重启）
- `writeUserMessage` / `doDrainInbox` 容忍 `encodeStdinMessage` 返回 null（一次性 driver 误走到这条路只 warn，不丢消息）
- `stop(hard)` 容忍 `encodeInterruptControl` 返回 null —— 直接进 SIGTERM 倒计时

### 验证

- `pnpm typecheck` 全过
- `./scripts/test.sh` 111/111（claude 路径回归无破坏）

### 已知遗留

- 没新增 codex / cursor 单测：仍只覆盖 claude lifecycle。后续要补 codex 的 JSON-RPC mock + cursor 的 oneShot 重启逻辑
- cursor 的 `--resume` 实测没人用过；session id 持久化逻辑沿用现有 `cli_session_id`，未来如果 cursor session 语义跟 claude 不一致需要分开处理


## 2026-05-02 (深夜 +1) — codex 接入修复 + per-agent proxy 设置### codex spawn 起来后两轮修复

**第一轮 — env 传参格式错**

stderr：`invalid type: string ..., expected a map in mcp_servers.chat.env`。codex 的 `-c key=value` 用 TOML 语法解析值，array/string 通过 JSON.stringify 能round-trip（TOML 兼容），但 map 必须 inline-table（`{k = "v"}`）—— `JSON.stringify({k:"v"})` 出来的 `{"k":"v"}` 被拒。

修法：每个 env key 单独 `-c mcp_servers.chat.env.<KEY>=<JSON.stringify(value)>`，绕开 map 语法。本地 probe 验证 child MCP 能正确收到 env。

**第二轮 — driver pre-thread race 的两个 bug**

1. `doDrainInbox` 之前对 codex 的 race（`session_init` 还没到，`encodeStdinMessage` 返回 null）报 warn，其实是良性 —— inbox items 没被消费，session_init handler 会重新 drain。降级成 info "deferred"。
2. `deliverMessage` 直接路径在同一窗口会调 `writeUserMessage` → null encoding → 默默丢消息。改成先 encode 试一下，null 就回退到 inbox enqueue，让 session_init drain 兜底。

### 防火墙 / proxy 问题（不是 bug，是环境）

接通 codex 后还是收不到回复。stderr 满屏 `403 Forbidden, url: wss://chatgpt.com/backend-api/codex/responses` —— 是公司云壳防火墙拦了 ChatGPT websocket。codex 内部会重试 5 次然后回退 HTTPS（实测我自己 probe 能跑通），但用户场景下 codex 直接 exit 0。

**slock 为什么能跑通**：slock daemon spawn codex 时也是 `...process.env` 透传，没做特殊代理。区别在于用户启动 slock 那个 shell 里 `export http_proxy=...` 了，pnpm dev 那个 shell 没 export。

### per-agent proxy 设置

短期：直接 export proxy env 再 pnpm dev 即可。

长期方案落地：

- **Migration v4**：新表 `app_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)`，flat KV
- **`SettingsRepo`** + 常量 `SETTINGS_KEYS.PROXY_URL` / `PROXY_AGENT_IDS`
- **路由** `GET/PUT /api/settings`：白名单校验 key
- **`SessionManager.applyProxySetting(env, agentId)`**：spawn 前读 `proxy_url`，非空 **且** agentId 在 `proxy_agent_ids` allowlist 里才注入 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`（含小写）。空 allowlist = 没人享受 proxy（明确 opt-in）
- **前端 `SettingsDialog`**：URL 输入框 + agent 多选 checkbox 列表 + 全选/全不选快捷；URL 空时 checkbox 禁用；保存时只持久化"当前还存在的 agent ids"，已删 agent 不留痕
- 入口：`NavRail` 底部齿轮（替换原 `alert('TODO: settings')`）

per-agent 的 opt-in 粒度（不按 runtime）是因为：codex 需要 proxy 不代表所有 codex agent 都需要；用户可能有些 agent 跑本地 model 不需要走代理。

### codex reasoning_effort（待实现）

调研：slock daemon 这块只是字段透传。slock 的"web 上调 effort"是 slock.ai 云端做的，daemon 代码里看不到 UI 实现。

slock 的字段透传：
- 字段名 `reasoningEffort`（per-agent string，不强校验）
- 传给 codex：JSON-RPC `thread/start.params.config.model_reasoning_effort = <value>`（与 `~/.codex/config.toml` 的 `model_reasoning_effort = "..."` 同义）
- 传给 copilot CLI：`--effort <value>`
- 不传则用 codex 自己 config.toml 默认（用户当前 `xhigh` 推理一次 ~22s）

我们要做的话：
- `agents` 表加 `reasoning_effort TEXT NULL`
- codex driver `buildThreadRequest` 里有就塞进 `params.config.model_reasoning_effort`，没有就不动
- 前端 agent 创建/编辑表单：runtime=codex 时显示 select（low/medium/high/xhigh）；其他 runtime 隐藏
- 顺带可以把 `model` 字段的 UI 也补上（目前 NULL，根据 runtime 显示对应可选 model 列表）



## 2026-05-02 (深夜 +2) — Agent CRUD + Profile 管理页

### 数据模型（migration v5）

- `agents` 加 `display_name TEXT NOT NULL DEFAULT ''`（人类可改的标签）+ `reasoning_effort TEXT`（codex 用，NULL = 走 codex config 默认）。回填 `display_name = name`。
- `name` 留作不可改的句柄 —— 改它会牵动 `dm-<name>` 频道名、@mention 历史、L2 文件路径。`display_name` 解决"我想给 agent 起个'前端搭子 🎨'之类的标签"。
- 新建 agent UI 仅采集 `name + runtime`；`display_name` 默认等于 name，model / description / reasoning_effort 全去 profile 页慢慢调。

### 后端

- `AgentRepo.update(id, partial)` —— 部分更新；`null` 与 `undefined` 区分（前者清字段，后者跳过）
- `AgentRepo.listRuntimeSessions(id)` —— 一次 SQL JOIN session_agents/sessions/channels，吐 `{session_id, channel_id, channel_name, channel_kind, session_title, status, pid, closed_at}`，驱动"在哪些 session 里跑" + delete-impact 的 running 列表
- `MembershipRepo.listForAgent(id)` —— 该 agent 所在的所有频道
- `InboxRepo.countPendingForAgent(id)` —— 累加每个 session 的待投递
- `SettingsRepo.getProxyAgentIds()` / `removeProxyAgentId(id)` —— 服务端清理 proxy 白名单（之前删除 agent 后死 id 残留）
- `agent-workspace.ts`：`buildAgentWorkspaceDto(l1Dir)` —— 读 L1 的 system_prompt.md / MEMORY.md（每个 64KB hard cap，超长尾部省略）+ notes/ 目录列表（按 mtime DESC）

### 路由

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/agents/:id` | 单个 DTO |
| PATCH | `/api/agents/:id` | 部分更新；改 runtime 时若有 starting/active session_agent → 409 `agent_busy_change_runtime` |
| GET | `/api/agents/:id/workspace` | L1 文件预览 |
| GET | `/api/agents/:id/runtime-state` | 该 agent 的所有 (session, agent) 行 |
| POST | `/api/agents/:id/stop` | hard-stop 所有 starting/active 的 session_agent，返回 `{stopped: N}` |
| GET | `/api/agents/:id/delete-impact` | 删除前预览（DM 频道、regular 频道列表、running、l1/l2 路径、proxy 白名单） |
| DELETE | `/api/agents/:id` | body 必须 `{confirm: true}`；流程：stop running → leaveChannel(每个 regular, wipeL2:true) → 删 DM 频道 → agents.delete → rm -rf L1 → 清 proxy 白名单 |

`leaveChannel` 加 `wipeL2?: boolean` opt —— 默认保留（rejoin 时复用 MEMORY），删除 agent 时传 true。

### 前端

- 新 main pane 模式：Members section 选中某 agent 时主区渲染 `<AgentView agentId={..}>`，点击"Open"行可一键跳回 chat 区对应的 session
- `features/agents/`：
  - `AgentView.tsx` —— 容器；header + 2 列（profile / workspace）+ 下方 runtime 表
  - `AgentHeader.tsx` —— 头像 + display_name + meta + 右侧 [Stop] [Delete]（Restart 暂不做，等以后放进 session 级控件）
  - `AgentProfileCard.tsx` —— display_name / description 可编辑（blur 提交）；handle 锁死只读；runtime + model + reasoning_effort（codex only）下拉 / 输入；runtime 在 has-running 时 disabled + 提示
  - `AgentWorkspaceCard.tsx` —— L1 路径 + Copy / Reveal in Finder；system_prompt + MEMORY 默认展开；notes 列表默认折叠
  - `AgentRuntimeTable.tsx` —— 每个 (session, agent) 行：channel / session / status pill / pid / Open
  - `DeleteAgentDialog.tsx` —— 强确认弹窗：拉 delete-impact 渲染影响列表（DM 内容、regular 频道、running 数、inbox、L1/L2 路径、proxy 白名单），需要在输入框敲 `delete` 才解锁红色按钮
- `useStopAgent` / `useDeleteAgent` / `useAgent` / `useUpdateAgent` / `useAgentWorkspace` / `useAgentRuntimeState` / `useAgentDeleteImpact` 全套 hook
- `MembersPanel` 加 `selectedAgentId / onSelectAgent` props；行 selected 状态对齐
- `CreateAgentDialog` 精简到 name + runtime 两项
- 新 IPC：`shell:showItemInFolder`（preload `window.agentHub.showItemInFolder(path)`）+ main 端走 `shell.showItemInFolder`

### 验证

- `pnpm typecheck` 全过
- `./scripts/test.sh` 129/129（原 111 + 18 个新增 / 改造的 agent 路由 & repo 测试）：display_name 默认 / update 部分写 / 锁 runtime 行为 / runtime-state 形状 / Stop 数量 / delete-impact 计数 / DELETE 全流程含 proxy 清理 + DM 消失 + regular 频道保留

### 下一步

- Codex driver 还没测试覆盖（一次性 driver + JSON-RPC 路径）
- session_init watchdog（P2 兜底）
- archive endpoint + sidebar Archived 折叠分组
- AgentView 的 Restart：等 session 级控件落地后从那边触发
- 入口扩展：channel members popover 里点 agent 也跳到 AgentView？目前只有 Members section 一个入口

## 2026-05-03 — 前端路由

### 路由方案

`react-router-dom@^6` + `HashRouter`（Electron `file://` 下 BrowserRouter 会出问题）。所有路由都落到同一个 `<App />`（catch-all `path="*"`）使其常驻挂载，避免 dialog/refs 在导航时 reset；URL 解析走自定义 hook。

URL scheme：

- `/` → 重定向到 `/chat`
- `/chat` → 默认 chat，无 channel 自动重定向到第一个
- `/chat/saved` → Saved 视图
- `/chat/c/:channelId` → 选中频道（含 DM）
- `/chat/c/:channelId/s/:sessionId` → 选中 session
- `/chat/c/:channelId/s/:sessionId/t/:childSessionId` → 同时打开 Thread 子 pane
- `/members` / `/members/:agentId` → 成员区
- `/computers` → 电脑区

### 实现

- 新增 `apps/desktop/src/renderer/router.ts`：
  - `routes` —— 所有 URL 模板的单一来源
  - `routePatterns` —— `useMatch` 用的 pattern 常量
  - `useRouteState()` —— 用 `useMatch` 解析当前 URL，返回 `{ section, chatView, channelId, sessionId, childSessionId, agentId }`
  - `useNav()` —— `toChannel` / `toSession` / `toThread` / `toMembers` / `toComputers` / `toChatSaved` 等带类型的导航 helper
- `main.tsx`：包 `<HashRouter>`，唯一 `<Route path="*">` 渲染 `<App />`
- `App.tsx` 大改：
  - 删掉 `useState` 管的 `view / appSection / selectedChannelId / selectedSessionId / openChildSessionId / selectedAgentId`，改从 `useRouteState()` 读
  - 所有 `setSelectedX` 调用改成 `nav.toX(...)`
  - 自动选首个 channel / 上次 session 的 effect 改成 `nav.go(..., { replace: true })`，避免 history 污染
  - `lastSessionByChannel` ref、`jumpTarget` / `highlightedParentMessageId` / dialog open state 仍走 useState/ref（属于纯瞬态，不上 URL）
  - 新增 effect：URL 里的 `channelId` 不存在时（外部窗口删了 / 坏书签）`replace` 回 `/chat`
  - 新增 effect：URL 里 `:childSessionId` 的 parent 不是 `:sessionId` 时把 `/t/...` 段去掉
- `NavRail` 保持 presentational，不耦合 router；`onChange` 在 `App` 里走 `nav.toChat/toMembers/toComputers`

### 验证

- `pnpm typecheck` 全过
- 未做 UI 端手动验证（Electron 窗口需用户启动），所有交互逻辑保持原有 contract，仅替换 state 读写源

### 下一步

- DM 想要更短的 URL（`/dm/:agentName`）可在 `useRouteState` 里加一层映射
- jumpTarget 目前在内存里，刷新会丢；如果要持久化可以加 `?jumpMessage=...` query
- Settings dialog 也可以做成路由（`/settings/...` 子 tab）让用户能直链到某个 settings 面板

## 2026-05-03 (后续) — Settings 改成路由页面

把原 `SettingsDialog` 拆成 `features/settings/SettingsPage.tsx`，URL `/settings`。`AppSection` 加 `'settings'`，NavRail 底部 Settings 按钮的 active 态由路由判断（不再走单独的 `onOpenSettings`）。`router.ts` 加 `routes.settings` / `routePatterns.settings` / `nav.toSettings()`。`SettingsDialog.tsx` 删除。

页面布局参照 `SavedListView`：sub-header（标题 + 副说明）+ 居中 max-w-2xl 的 form + 底部保存按钮。保存成功后短暂显示 "已保存" 提示（1.5s）。

之后想加更多 settings 子 tab 就在 `/settings/:tab` 下分路由即可。

## 2026-05-03 (后续 +1) — Proxy 代理改成 runtime 维度

之前 proxy 是按 agent_id 白名单（`proxy_agent_ids`），用户实际诉求是按 runtime 维度——同一个 runtime 的所有 agent 共享同一套 proxy 决策（codex 都走代理；claude 都不走）。

### 改动

- 后端 `app_settings` key 改名：`proxy_agent_ids` → `proxy_runtimes`，存逗号分隔的 runtime kind（如 `codex,cursor`）
- `SettingsRepo`：删 `getProxyAgentIds` / `removeProxyAgentId`；加 `getProxyRuntimes()`，用 `RuntimeKindSchema.safeParse` 过滤掉未知/旧的脏值（旧 `proxy_agent_ids` 值若被读到也会被丢弃）
- `SessionManager.applyProxySetting(env, runtime)` —— 第二个参数从 agentId 改成 runtime 字符串；spawn 路径 (`session-manager.ts:229`) 传 `agent.runtime`
- `routes.ts`：删 `settings.removeProxyAgentId(id)`（runtime 不会被删除，allowlist 不再需要跟着 agent 生命周期清理）；delete-impact 的 `proxy_allowlisted` 字段去掉
- DTO：`AgentDeleteImpactDtoSchema` 去掉 `proxy_allowlisted`
- 前端 `DeleteAgentDialog`：去掉 "Will be removed from the proxy allowlist" 行
- 前端 `SettingsPage`：勾选项从 agent 列表换成 runtime 列表（claude / codex / cursor / gemini，硬编码与 `RuntimeKindSchema` 同步）；写回时按固定顺序 join 避免无意义 churn

### 数据迁移

不写 SQL 迁移——`app_settings` 是 KV，旧 `proxy_agent_ids` 行残留无害（不会被任何代码读）。用户重新打开 Settings 配置一次 runtime allowlist 即可。如果以后想清理可以加一行 startup `DELETE FROM app_settings WHERE key = 'proxy_agent_ids'`。

### 验证

- `pnpm typecheck` 全过
- `pnpm test` 128/128（删了一条 "strips agent id from proxy allowlist on delete" 旧测，原来 129 条）









## 2026-05-03 (后续 +2) — Tasks 系统（PR-T1 ~ PR-T4）

实现 silverhand 自己的多 agent 任务协调原语。背景：slock-ai 的网站上有 tasks 概念，原型是"channel-level task list + agent claim"。silverhand 引入了 channel/session 两级，于是把 task 的可见性 / 操作性拆开（channel 级可见 read-only、session 级可操作 claim/update），其他保持一致。

设计文档：`docs/tasks-design.md`。

### 数据模型（PR-T1）

不新增表，扩 `messages`：

- migration v7 `tasks`：`messages` 加 6 列 `task_number / task_status / task_assignee_agent_id / task_assignee_user_id / task_title / task_channel_id`
- `task_channel_id` 是冗余字段（可从 session 反查），用于支撑 partial unique index `uniq_messages_task_number(task_channel_id, task_number) WHERE task_number IS NOT NULL` —— `task_number` 在 channel 维度递增、唯一
- 一条消息既是 message 也是 task：避免 join、SSE 投递路径不变

### 后端（PR-T1）

- `packages/backend/src/tasks.ts`：service 层，所有事务都集中在这里
  - `createTasksByAgent` —— 单事务 `SELECT MAX(task_number) + 1` + insert 多条，避免并发抢号
  - `claimTasksByAgent` —— 原子 `UPDATE ... WHERE task_assignee_agent_id IS NULL AND task_status != 'done'` + `changes()` 检测 race；也支持 promote-and-claim（直接传 messageId 把已有消息升格成 task）
  - `updateTaskStatusByAgent` —— `VALID_TRANSITIONS` 表约束状态机，跨 session 操作直接拒绝
  - `humanClaim / humanUnclaim / humanUpdateStatus` —— 不受 assignee-only 限制（详见设计文档 §4.3）
- 4 个 agent endpoints + 3 个 human endpoints，挂在 `/api/tasks/*` 与 `/internal/sessions/:sid/agents/:aid/tasks*`
- 事件：每次状态变更广播 `task_changed` SSE 事件 + 一条系统消息（`subtype: task_create | task_claim | task_unclaim | task_status`），系统消息走现有 inbox fanout 让离线 agent 也能感知
- 测试：`packages/backend/tests/routes/tasks.test.ts` 8 条，覆盖 create / claim race / promote / cross-session reject / update status rules / human approval / SSE / inbox fanout

### MCP 工具（PR-T2）

- `packages/chat-bridge/src/server.ts`：新增 5 个 MCP tool（`list_tasks / create_tasks / claim_tasks / unclaim_task / update_task_status`），描述详细写明 silverhand 特有的"channel 可见、session 可操作"约束
- `packages/backend/src/drivers/platform-prompt.ts`：在 `## Tasks (coordination primitive)` 段写入 5 条硬规则（claim 前先 list；想干就先 claim；干完推 in_review 让 human approve；不要瞎跨 session 操作；不要在 done 上反复 toggle）

### UI（PR-T3 ~ PR-T4）

经过几轮反复设计，最终落地为两个层级，具体差异见 `docs/tasks-design.md` §7.5。

- **NavRail Tasks section**：`apps/desktop/src/renderer/components/layout/TasksSection.tsx` —— 单栏布局，header 下方 channel chip strip（`All` + 前 10 个 regular channel 按 active 数量倒序 + 分隔条 + DM channels），主视图四列 Kanban
- **Titlebar Tasks 入口**：`Titlebar` 在 chat section + 选中 channel 时显示 `CheckSquare` 按钮（带 active 数量 badge），点击打开 `ChannelTasksDialog`（`apps/desktop/src/renderer/components/tasks/ChannelTasksDialog.tsx`）—— 中央模态、四列 Kanban、session chip strip（默认当前 session）
- 共享组件：`KanbanColumn` / `TaskCard` / `TaskStatusPill` / `useTasks` / `useUpdateTaskStatus`
- Kanban 设计要点：modal 高度固定 `h-[80vh] max-h-[760px]`，但每列 `items-start` 自适应内容高度（避免 empty 时大空盒），空态显示 `No <status> tasks`
- SSE：`useSessionStream` 加入 `task_changed` 事件；React Query 失效粒度选择"整个 `tasks` 树都失效"——简单且任务列表本身很小

### 中间走过的弯路

- 一开始按设计文档做了 `TaskDrawer`（SessionView 右侧抽屉）和 SessionsSidebar 的 Sessions/Tasks tab 切换，用户 review 后觉得：
  - Drawer 跟 channel 入口职责重叠、还挤压消息流空间
  - SessionsSidebar 加 tab 把侧栏"语义混杂"了
- 改成现在的"titlebar 入口 + 中央 dialog + chip strip 切 session" 后干净很多。废弃的 `TaskDrawer.tsx` 已删

### 验证

- `pnpm typecheck` 全过（4 个 workspace）
- `pnpm test` 136/136（新增 8 条 task 测试）
- UI 在浏览器中由用户人工 review 通过

# App Layout & Interaction Spec

定义 silverhand desktop 客户端的**布局结构、消息渲染、交互流程**。视觉 token（颜色、间距、圆角等）见 [`design-new-theme.md`](./design-new-theme.md)；本文不重复 token，只引用。

整体架构、数据流、process 模型见 [`core-design.md`](./core-design.md)。本文聚焦"用户能看见和操作的部分"。

> **Status**: 2026-05-02 起草。各小节标 `Status: Spec` 表示未实现；标 `Status: Done @ <PR#>` 表示落地（PR 落地后回填）。

---

## 0. 设计原则

1. **IM 直觉优先**：参考 Slack / Discord 的核心心智模型——左侧 workspace 列表、中间 channel 列表 + 消息流、消息可 hover/save/thread。不引入任何"agent runtime"概念到普通用户视野（events、debug、process status 都属于开发者面板）。
2. **窗口就是工具**：主窗口给最终用户；调试用的 Events Panel 拆成独立窗口（可 pin 到最前）。
3. **状态最小化持久层**：用户偏好（sidebar 宽度、sidebar 显隐、theme）走 `localStorage`，跨进程/跨重启的领域状态走 SQLite，不混。
4. **拒绝乐观跳层**：每个交互都从一个明确的"当前位置"出发——currentWorkspace × currentChannel × currentThread（最多一层）。`Saved` 视图是一个例外的"fly-out"，进入后退出回到上次的 channel。
5. **平台范围 = macOS**：v1 只目标 macOS，渲染 / 布局 / 自绘 titlebar 都按 mac 优先打磨。**不要为 Win/Linux 写兼容分支**（`frame: false`、自绘窗控按钮、平台 sniff fallback 等等都不要），后面如果要支持，开新分支统一处理，避免主线代码到处 `process.platform !== 'darwin'` 污染。

---

## 1. 整体布局

```
┌──────────────────── Custom Titlebar (drag region) ───────────────────────────┐
│  [traffic-lights] [WS] [CH] workspace-name  ⋯  [icons] workspace-path …       │
├────┬──────────┬──────────────┬─────────────────────────┬────────────────────┤
│    │          │              │                         │                    │
│ Nav│          │              │   Parent ChannelView    │  Thread View       │
│Rail│ Sidebar  │  Channels    │   (markdown messages,   │  (only when a      │
│icon│  (work-  │  Sidebar     │    composer)            │   thread was       │
│col │  spaces  │  (channel    │                         │   spawned)         │
│    │  + Saved)│   tree)      │                         │                    │
│    │          │              │                         │                    │
└────┴──────────┴──────────────┴─────────────────────────┴────────────────────┘
        ↑resize     ↑resize                  ↑split-resize (only when thread open)
```

- **NavRail（最左 icon 列）**：宽度固定 `--nav-rail-width: 48px`，不可拖拽。Top-level section 切换：`chat` / `members` / `computers`。底部一个 settings 按钮（独立 action）。当前 section 决定后面三列显示什么——见 §3。
- **Titlebar**：跨整个窗口宽度。`-webkit-app-region: drag`，按钮 `no-drag`。macOS 用 `titleBarStyle: 'hiddenInset'` + 自绘内容。红绿灯右侧固定放 workspace/channel 两个 sidebar toggle。**Win/Linux 暂不支持**（v1 平台仅 macOS，详见 §0 与 §11），无需为其做兼容处理。
- **Sidebar / Channels Sidebar**：宽度可拖拽，显隐和宽度都 `localStorage` 持久化。每个可见 sidebar 有右边一条 4px 的 splitter（hover 时变色）。仅在 NavRail = `chat` 时显示；两列都隐藏时进入 chat-only zen，但 NavRail 作为 section 切换器常驻，titlebar toggle 仍是恢复 sidebar 的唯一入口。
- **Main view（Parent + Thread split）**：默认只有 parent 占满；user 在某条 message 上点 Thread 后才出现 right pane。thread 永远只有一个（再点 Thread 替换当前 thread + 用户确认）。
- **Events Panel** 不再嵌入主窗口（见 §8）。

CSS variable 仍保留 `--titlebar-height` 和 `--nav-rail-width`（不可主题化的全局常量），其他与 sidebar 相关的 var (`--sidebar-width` / `--sessions-sidebar-width`) 改为内联 style 由 hook 控制。

颜色梯度（NavRail → Channels → Sessions → Chat 的纵向色阶）由 theme 决定，详见 `design-new-theme.md` §9。导航 row 的 default / hover / selected 状态机详见 `design-new-theme.md` §10。

---

## 2. Titlebar

**Status**: Spec → PR5

布局（左到右）：

| 段 | 内容 | 区域 |
|----|------|------|
| traffic-lights + sidebar toggles | native traffic lights；右侧约 12px 放 workspace / channel 两个独立按钮 | mixed：空区 drag，按钮 no-drag |
| workspace name | 当前选中 workspace 的 name；ellipsis | drag |
| more icon | `⋯` 按钮，菜单：Rename / Manage Members / Copy Workspace Path / Delete Workspace | no-drag |
| icons slot | 预留：theme toggle、help、events window 切换（debug 用，最终走 menu） | no-drag |
| workspace_path | 右侧 ellipsis + `dir="rtl"`（保留路径尾部） | drag |

> `trafficLightPosition: { x: 12, y: 11 }` 负责红绿灯安全区；toggle group 使用 `--titlebar-sidebar-toggle-left` / `--titlebar-controls-safe-width`，按钮必须带 `no-drag`，避免吃掉原生拖拽/双击最大化。  
> **Toggle 视觉**（task #171 改）：状态用图标形状表达，不用激活背景色。Workspace toggle 用 `PanelLeft`（visible）↔ `PanelLeftDashed`（hidden）；Channel toggle 用 `Columns2`（visible）↔ `Square`（hidden）。两个按钮使用不同 lucide 家族，便于一眼区分；hover 仅淡化背景，移除原 `bg-row-selected` 选中态。  
> **More 菜单的 Rename / Delete** 沿用 ChannelsSidebar 现有逻辑（移过来即可），不是新功能。  
> **Manage Members** 在 DM workspace 下隐藏（同现状）。  
> 没有 workspace 选中时，titlebar 仍显示 traffic-lights + sidebar toggles + 空 drag 区。

**main 进程改动**：

```ts
new BrowserWindow({
  // ...
  titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
  trafficLightPosition: { x: 12, y: 11 },
});
```

> **平台范围**：v1 仅支持 macOS。Win/Linux 上自绘 titlebar 没必要做、也不需要兼容代码——
> 不要为 `process.platform !== 'darwin'` 加 `frame: false` 之类的分支，
> 后面要补再统一开新分支处理（详见 §11）。

参考 `/Users/shiki/workspace/webskill-repos/api-anything/electron/src/renderer/src/components/MainTitlebar/`。

---

## 3. Sidebar（workspaces 列，NavRail 右侧）

**Status**: 现状已有 workspace 分组 + Saved 入口 + 宽度持久化。原顶部 "Agent Hub + ⚙" 头条已移除（settings 入口下沉到 NavRail 底部）；workspaces/members tab toggle 已移除（members 是 NavRail top-level section，不在 Sidebar 内）。

结构（自上而下）：

```
┌─ Sidebar (workspaces) ┐
│ ★ Saved               │  ← 全局唯一入口；选中时 main view 切到 SavedListView
├───────────────────────┤
│ DM ▾                  │  ← collapsible group header（整行可点击，详见下）
│   @claude             │
│ WORKSPACES ▾   +      │  ← group header 右侧的 + 是独立 action（不触发折叠）
│   #project-x          │
│   #refactor           │
├───────────────────────┤
│ ◯ local               │  ← 底部 footer（user 标识占位）
└───────────────────────┘
```

- **Sidebar 仅在 NavRail = `chat` 时显示**。NavRail = `members` / `computers` 时，本列被相应的 MembersPanel / ComputersPanel 替换（仍占同样的 `--sidebar-width`，仍用 `--bg-channels-sidebar` 底色）。
- 显隐是全局 layout preference：`silverhand:layout.workspace-sidebar-visible` / `silverhand:layout.channel-sidebar-visible`（task #171 改成 per-key 简单 `'1'/'0'`），不随 workspace 切换。titlebar 按钮和 `⌘⇧\` / `⌘\` 双向同步；隐藏时 splitter 也跟着卸载。
- **Slide 动画**（task #171）：每个 sidebar 是 `.sidebar-slot`（layout/`flex-basis` + `width` 收缩到 0）+ 内层 `.sidebar-surface`（paint/`transform: translate3d` 滑出）的两层结构，240ms `cubic-bezier(0.32, 0.72, 0, 1)` apple-feel 缓动。状态机在 `useSidebarPane`：四态 `closed → opening → open → closing → closed`，open 走 `flushSync` + 双 rAF（保证从 -100% 起跑），close 走 setTimeout 240ms 后卸载 surface；rapid toggle 自动 cancel 旧 timer/rAF；reverse mid-closing 直接翻回 `open` 让 CSS 反向插值。隐藏的 surface 加 `inert` 属性 + `aria-hidden="true"`，移出 a11y 树并禁焦。`prefers-reduced-motion` 同时关 CSS transition 和 JS 状态机的延迟（短路到同步 mount/unmount）。
- Saved 是**全局唯一入口**（不分 workspace），点击进入 §6 的 Saved List View。
- 选中 Saved 时 ChannelsSidebar 隐藏或灰显（待定，倾向**整体改成 list 视图**，workspace sidebar 仍然显示让用户能切回去）。
- **Group header 整行可点击**（含 chevron + label + count），右侧的 `+` action 是独立按钮——避免点错触发折叠。

**宽度持久化（PR6）**：

- 新建 `apps/desktop/src/renderer/hooks/useResizableWidth.ts`
- 宽度 localStorage key：`silverhand.layout.sidebar-width` / `silverhand.layout.channels-sidebar-width` / `silverhand.layout.split-ratio`
- 显隐 localStorage key（task #171 收敛）：`silverhand:layout.workspace-sidebar-visible` / `silverhand:layout.channel-sidebar-visible`，每个独立的 `'1'`/`'0'`，global，不 per-workspace。
- min/max：`Sidebar` 200–360；`ChannelsSidebar` 200–400；split ratio 0.25–0.75
- splitter：4px 可点击区，hover 时变 `--accent`，drag 时整个文档加 `cursor: col-resize` + `user-select: none`。slot/surface 宽度通过 `var(--sidebar-width)` / `var(--channels-sidebar-width)` 引用，drag 期间 CSS var 改值不会触发 transition（CSS 规范），所以 resize 不需要额外抑制。

---

## 4. ChannelsSidebar（中列）

**Status**: 现状基本可用；本节小改。

变化：

1. **顶部 workspace info block 删除**——内容已迁移到 titlebar（§2）。ChannelsSidebar 顶部只保留 `+` 新建会话按钮和（regular workspace）`Manage Members`。
2. channel tree 当前实现保留：top-level + thread indent。thread 节点状态：`closed` 删除线 + 灰；`active` 绿点；`crashed` 红点。
3. 选中 thread 时左侧高亮**也包括其 parent**（视觉提示"你正在看一对"）——split view 下两边各对应一个高亮节点。
4. 显隐是全局 layout preference：`silverhand:layout.channel-sidebar-visible`（task #171 改成独立 key），titlebar 按钮和 `⌘\` 双向同步；隐藏过程走 §3 的 slot/surface slide 动画，结束后 splitter 卸载。workspace + channel 都隐藏时不做 hover 边缘弹出，NavRail 仍常驻。

---

## 4.5 Context menus

**Status**: Done @ task #170

右键菜单使用 Radix `@radix-ui/react-context-menu`，不使用原生菜单。菜单 token 统一收敛到 `components/menus/AppContextMenu.tsx`：

- 容器：`min-w-[180px] rounded-md border border-border bg-bg-floating p-1 text-xs text-text-primary shadow-lg`
- item：左侧固定 `size-3.5` icon slot，label `flex-1 truncate`，hover 使用 `data-[highlighted]:bg-bg-hover`
- separator：`my-1 h-px bg-border-subtle/60`

同文件也导出 `AppDropdownMenu`，用于需要点击打开但应共享同一套 token 的 action menu，例如 ChannelView header 的 `MoreHorizontal`。

### Workspace row

所有 workspace 行一致，包括 regular workspace、DM workspace、archived workspace。DM workspace 也有 `workspace_path`（agent workspace path），不做 disabled 分支。

| Item | Icon | 行为 |
|---|---|---|
| Open in Finder | `FolderOpen` | `window.agentHub.showItemInFolder(workspace_path)` |
| Copy path | `Copy` | `navigator.clipboard.writeText(workspace_path)` + toast |

### Channel row

| Item | Icon | 行为 | 范围 |
|---|---|---|---|
| Pin / Unpin | `Pin` / `PinOff` | `pinChannel.mutate({ channelId, pinned: !pinned })` | top-level channel / dm_channel；thread 隐藏 |
| Archive / Restore | `Archive` / `ArchiveRestore` | `archiveChannel.mutate({ channelId, archived: !archived })` | top-level channel-like：`channel`（regular workspace）或 `dm_channel`（agent_home/DM）；thread 隐藏（#task:1145） |
| Copy name | `Copy` | `navigator.clipboard.writeText(channel.title)` + toast | channel / dm_channel / thread 全部可用 |

Thread 行本批只提供 `Copy name`，不扩展 pin/archive 语义，保持 top-level-only 规则。

### ChannelView header More

ChannelView 头部的 `MoreHorizontal` 点击菜单继续保持 dropdown 交互，不改成右键；但样式迁到 `AppDropdownMenu` 同一套 token。条目为 Rename / Archive / Restore，组织行为按 channel-like 同构（`canRenameChannel` / `canToggleArchive`：top-level `channel` 或 `dm_channel`，只拒 thread；rename 另需「未 closed」）——DM channel 与 regular channel 走同一套入口（#task:1145）。

归档当前主选 channel 时，主面板按 sidebar 顺序做 **neighbor-aware 兜底选择**：优先选下一条 active top-level，否则上一条，都没有则清空到 workspace 空态（纯函数 `lib/archive-fallback.ts#pickFallbackAfterArchive`，单测覆盖）。只有归档「主面板正在看的那条」才移动选择；secondary 面板归档 / restore 不抢主选（#task:1145）。

### Archived Channels 面板

全局 Archived 是跨 collection 的恢复索引（含 regular `channel` 与 agent_home `dm_channel`，#task:1144/#task:1145）。Workspace 过滤 dropdown 按 **Workspaces / DMs 两组**分组（镜像 Message Search 的 workspace filter）：regular 组用 `W` glyph，DM 组用 agent avatar（`dmWorkspaceIcon`，dropdown scope 图标专用）。列表行本身仍统一 `#` channel glyph（DM 是 channel-like，不另给图标），靠 "DM <agent>" 文字上下文区分。点击 archived DM 行经 `archivedRowOpenTarget` 跳到该 DM 的 agent_home workspace + dm_channel（不沿用当前 workspace 上下文）；`useArchivedChannelsForWorkspace` 对 regular / dm 都 enable，目标 workspace 才能加载 archived 列表并解析出会话（#task:1145）。

---

## 5. Message Rendering

**Status**: Spec → PR1（含 markdown）+ PR2（onboarding metadata）

### 5.1 Markdown 渲染方案

- **`react-markdown` + `remark-gfm` + `rehype-highlight`**
- `dayjs` + `dayjs/plugin/relativeTime` 用于时间显示
- 安全：**不装 `rehype-raw`**，`react-markdown` 默认不渲染原始 HTML（`skipHtml` 行为）。Agent 输出包含 `<script>` 也只渲染为 escape 文本。
- 链接：自定义 `a` 组件用 preload 暴露的 `shell.openExternal`，永远不在窗口内导航。
- 代码：
  - `inline code`：默认 `<code>` 样式（细灰底）
  - 代码块：`<pre>` 包 `rehype-highlight` 高亮，右上角 hover 出现 `Copy` 按钮（写到 clipboard）
  - 长代码块默认折叠到 `max-height: 320px` + 渐变蒙层 + `Show more` 按钮（v1 可不做，先全展开）

```ts
// components/chat/Markdown.tsx
<ReactMarkdown
  remarkPlugins={[remarkGfm]}
  rehypePlugins={[rehypeHighlight]}
  components={{ a, code, pre }}
  skipHtml
>
  {content}
</ReactMarkdown>
```

### 5.2 三种消息形态

#### A. user 消息

- 右对齐气泡（保留现状）
- header：`you` + 相对时间（hover 显完整时间）
- body：markdown（user 输入也支持 markdown，方便贴代码）
- hover：整行 bg = `--bg-hover`，外圈 1px `--border-subtle`，左下出现 `Thread` `Save`

#### B. agent 消息

- 左对齐气泡
- header：`@<agent-name>` + 相对时间
- body：markdown
- hover：同 user
- 头像：v1 不做（agent 还没有头像系统），用名字色块代替（首字母 + accent 色）

#### C. system 消息

**关键变更**：从居中 italic 改成**左对齐 secondary**，根据 `metadata.subtype` 区分行为：

| subtype | 行为 |
|---------|------|
| `'onboarding'` | 默认显示 1 行（`line-clamp: 1`）+ ▸ icon；点击展开全部 |
| `'join'` / `'leave'` | 单行不可折叠（一般本来就一行） |
| `'child_summary'` | 类似 onboarding，可折叠（summary 可能长） |
| `null` / 其他 | 默认全显（保守） |

- 左对齐，无气泡，文字 `--text-muted`（约一档 secondary）
- 点击行任意位置切换展开
- onboarding 展开后也保留 secondary 颜色，跟普通 message 区分

### 5.3 时间显示

- 用 `dayjs(created_at).fromNow()` → "3 分钟前" / "刚刚" / "昨天"
- `title` 属性挂完整 `YYYY-MM-DD HH:mm:ss`，hover 由浏览器原生 tooltip 显示
- 列表里每分钟刷一次（轻量 setInterval + state version bump，或直接 `react-query` 的 `refetchInterval` 不适合这场景，自己 hook）

### 5.4 Thread / Save action bar

- hover message 时绝对定位浮在左下（不挤压 layout）
- icon button：`↩ Thread` / `★ Save`（save 后 icon 变实心 + active 色）
- 点击外的空间不消费 hover 状态

---

## 6. Save 功能

**Status**: Spec → PR3（依赖 PR2 的 saved_messages 表）

### 6.1 数据模型（PR2）

```sql
CREATE TABLE saved_messages (
  id          TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  channel_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  saved_at    INTEGER NOT NULL,
  UNIQUE(message_id)
);
CREATE INDEX idx_saved_messages_saved_at ON saved_messages(saved_at DESC);
```

设计取舍：
- **不加 category 列**——你的反馈是 saved 是单一全局列表，不分组；如未来要加 tag/category，再加新表 `saved_message_tags`，不污染主表。
- **UNIQUE(message_id)**：同一条 message 只能 save 一次；二次点击 = unsave（DELETE）。
- channel_id 和 workspace_id 冗余存以便 GET /saved 时一次 JOIN 拿全。

### 6.2 后端 API

```
POST   /api/messages/:id/save     → 201 { saved: true }
DELETE /api/messages/:id/save     → 204
GET    /api/saved                 → SavedMessageDto[]
                                    （含 message body、workspace name/id、channel name/id、sender name、saved_at）
```

### 6.3 前端：Saved List View

进入条件：左 sidebar 顶部点 `★ Saved`。布局：

```
┌─ Saved (123) ─────────────────────────────────────────────────────┐
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │ #project-x · @claude · 2 小时前                       ★ ✕ │   │  ← unsave 按钮
│  │ ───────────────────────────────────────────────────────── │   │
│  │ Markdown 渲染的消息内容...                                  │   │
│  │ 跳转到对话 →                                                 │   │  ← 链接
│  └────────────────────────────────────────────────────────────┘   │
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │ @gpt · 昨天                                            ★ ✕ │   │
│  │ ...                                                        │   │
│  └────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
```

- 平铺列表，最新的在上
- 每条卡片显示：workspace · sender · 相对时间，body 用 markdown，底部 `跳转到对话` 链接
- 点击跳转：切到该 channel（同时切 currentWorkspaceId/currentChannelId），并 scroll + flash highlight 到对应 message id
- "跳转锚点"实现：MessageList 给每个 `<li>` 加 `id={'msg-' + m.id}`，跳转时 `document.getElementById(...)?.scrollIntoView({block: 'center'})`，再加 200ms `bg-warning/30` 闪烁

---

## 7. Thread

**Status**: Shipped as reply cluster.

UI 概念仍叫 **Thread**：在某条消息下展开子讨论。它不再创建
`kind='thread'` child conversation；thread reply 是父 channel 中的一条普通
message，写入 `messages.thread_root_id = <root message id>`。

### 7.1 后端 API

- 主 channel 消息窗口：`GET /api/channels/:id/messages` 只返回 main stream
  (`thread_root_id IS NULL`)；返回体带 `reply_counts_by_root` sidecar，用于根
  message 的 reply 徽标。
- Thread 面板消息窗口：
  `GET /api/channels/:id/messages?thread_root_id=<root_message_id>`，返回根消息
  + 该 root 下的 replies，复用 `ConversationMessagesDto`。
- Human 在 thread 中回复：
  `POST /api/channels/:id/messages` body 带
  `reply_to_message_id: <root_or_reply_message_id>`。后端将 reply 归一到 canonical
  root。
- Agent CLI 对应：`silverhand message send --reply-to <message_id>`、
  `message history --target thread:<root_message_id>`、
  `thread follow|unfollow --root <root_message_id>`。

旧 `kind='thread'` conversation 是只读 fossil：可通过 `/api/threads/:id/...`
读取历史；写入、自动 spawn、agent `thread create/close` 已冻结/下线。若需要隔离
上下文或并行长任务，创建新的 channel，而不是 thread。

### 7.2 前端

- Message row 的 reply count / Thread affordance 打开右侧 `ThreadPanel`
  (`?cluster=<root_message_id>` 作为过渡期 URL 参数，避免和 legacy `/t/:threadId`
  命名冲突)。
- `ThreadPanel` 固定 pin 根消息，replies 列表读取
  `?thread_root_id=<root>`，底部 composer 发送
  `reply_to_message_id=<root>`。
- 主 channel 列表不内联 thread replies；新 reply 通过 WS 更新根消息的
  `reply_counts_by_root` 徽标，面板内按 root 过滤 append。
- Channel sidebar 不展示 thread children；thread 不是导航树节点。

---

## 8. Events Panel → 独立 Window（dev-only）

**Status**: Spec → PR7

### 8.1 动机

普通用户不需要看 events——会冲淡 IM 心智，且 events 只有"接 backend SSE 然后 dump JSON"这种 raw 价值，是开发/调试场景。

### 8.2 实现

- App.tsx 删 `<EventPanel />`
- main 进程：
  - `createEventsWindow()`：新建 BrowserWindow（标准 frame，size 480×720，`alwaysOnTop: false`）
  - 加载 `events.html`（renderer 新建 entry：`apps/desktop/src/renderer/events/main.tsx`）
  - 单例：已开就 focus，关了再开重新建
- macOS 应用菜单（`Menu.setApplicationMenu`）：
  ```
  View
  └─ Developer
     ├─ Show Events Window     ⌥⌘E
     └─ Pin Events Window      （checked toggle，调 win.setAlwaysOnTop）
  ```
- 冷启动默认关；窗口开/关状态不持久化
- Events Window 内部：复用现有 `EventPanel.tsx` 内容（拆出 reusable 部分），通过 preload 接 SSE → 直接 render

backend SSE 现状已经是订阅 + multicast，无需改动。

---

## 9. 落地 PR 顺序

| # | 名称 | 阻塞下一项 | 大致改动 |
|---|------|-----------|---------|
| 1 | 文档（本文 + progress） | — | docs only |
| 2 | PR1 markdown + message UI | 是 | renderer chat 组件重写；新依赖 |
| 3 | PR2 saved_messages migration + system metadata | 是 | shared/migrations + provision.ts |
| 4 | PR3 Save 功能 | — | backend route + UI Saved view |
| 5 | PR4 Thread / child session | — | backend provision + UI split + new endpoint |
| 6 | PR5 Custom titlebar | — | main BrowserWindow + Titlebar.tsx |
| 7 | PR6 Resizable sidebars | — | hook + Sidebar wrappers |
| 8 | PR7 Events 独立窗口 | — | main + new renderer entry + menu |

PR3 / 4 / 5 / 6 / 7 之间互相不阻塞，可以并行 review；按 PR# 顺序完成最稳。

---

## 10. 一致性约定（写代码时反复对照）

- **CSS color/spacing 永远走 token**，不写裸色值（`design-new-theme.md` §3）
- **Markdown 容器最大宽度** 与现有气泡保持一致（`max-w-[75%]`），避免在宽屏 workspace 里横到 2000px 难读
- **每条 message 必须有稳定 DOM id**（`msg-<id>`），用于 saved view 跳转 + 未来 anchor 复制
- **thread 永远只有一层**（schema + UI 双重保险）；UI 在 Thread button 上根据 `parent_conversation_id != null` 隐藏
- **dev-only feature 的入口** 只在 macOS 应用菜单 → Developer 子菜单下；不出现在用户视野中其他地方
- **Header variant 只能"显隐 / 重排" chrome，绝不替换或新造主题化 identity 原语。** 同一个组件用 mode/variant prop 渲染不同密度的 header（如 `ChannelView.sourceViewer` 的 Activity docked 源面板）时,凡带 `data-*` theme hook 的 identity/control 原语（channel `#` = `data-conversation-hash`、列表频道图标 = `data-channel-icon` 等）**必须复用 canonical header 的同一个 primitive**；variant 只决定「是否展示 / 布局 / action 集合」,**不替换、不新造**那段 DOM。理由:「同组件不同 mode」只保护两个 mode *共享的那段 markup*——某个 mode 自己新增/替换的元素逃出共享路径,就会绕过主题 hook，在带 sticker 配方的主题（forza6）下画成通用 glyph、像换了一套图标语言（#task:1227 dogfood 实例:`sourceViewer` 初版用裸 lucide `Hash` 替掉 `#`,只在 forza6 暴露）。mode 应是**减法**(gate 掉控件)或复用现有 themed 原语,不在分支里发明新视觉原语。data-hook 侧细则见 `design-new-theme.md`。
- **每个 PR 完成后追加 `docs/progress.md`** 一段，记下：动机、关键决策、踩坑、验证（typecheck / test / 手测）

---

## 11. Open questions（v1 之后再决定）

- Saved 是否需要 search / filter？（v1: 不做；列表 < 50 条够用）
- Thread 内的成员管理 UI 在哪？沿用 workspace-level Manage Members，还是 thread 自己一个？（v1: 不做"thread 内单独管理"，workspace 加成员自动出现在所有未关闭 channel 里——验证现状逻辑是否如此）
- titlebar 在 Win/Linux 的窗控按钮（min/max/close）什么时候补？v1 **仅支持 macOS**，暂不为 Win/Linux 出窗控/自绘 titlebar；要支持时再开新分支统一处理（不要现在就加 `process.platform !== 'darwin'` 兼容代码污染主线）。
- 多 thread 并发：spec 写"只允许一个 thread pane"，但 sidebar tree 仍然能切换不同 thread——这两个语义要对齐（建议：sidebar 切换 thread 等价于 `setOpenThreadId(targetId)`，永远只显示一个 pane）

# App Layout & Interaction Spec

定义 silverhand desktop 客户端的**布局结构、消息渲染、交互流程**。视觉 token（颜色、间距、圆角等）见 [`design-new-theme.md`](./design-new-theme.md)；本文不重复 token，只引用。

整体架构、数据流、process 模型见 [`core-design.md`](./core-design.md)。本文聚焦"用户能看见和操作的部分"。

> **Status**: 2026-05-02 起草。各小节标 `Status: Spec` 表示未实现；标 `Status: Done @ <PR#>` 表示落地（PR 落地后回填）。

---

## 0. 设计原则

1. **IM 直觉优先**：参考 Slack / Discord 的核心心智模型——左侧 workspace 列表、中间 channel 列表 + 消息流、消息可 hover/save/thread。不引入任何"agent runtime"概念到普通用户视野（events、debug、process status 都属于开发者面板）。
2. **窗口就是工具**：主窗口给最终用户；调试用的 Events Panel 拆成独立窗口（可 pin 到最前）。
3. **状态最小化持久层**：用户偏好（sidebar 宽度、theme）走 `localStorage`，跨进程/跨重启的领域状态走 SQLite，不混。
4. **拒绝乐观跳层**：每个交互都从一个明确的"当前位置"出发——currentWorkspace × currentChannel × currentThread（最多一层）。`Saved` 视图是一个例外的"fly-out"，进入后退出回到上次的 channel。
5. **平台范围 = macOS**：v1 只目标 macOS，渲染 / 布局 / 自绘 titlebar 都按 mac 优先打磨。**不要为 Win/Linux 写兼容分支**（`frame: false`、自绘窗控按钮、平台 sniff fallback 等等都不要），后面如果要支持，开新分支统一处理，避免主线代码到处 `process.platform !== 'darwin'` 污染。

---

## 1. 整体布局

```
┌──────────────────── Custom Titlebar (drag region) ───────────────────────────┐
│  [traffic-lights]  workspace-name  ⋯   [icons]      workspace-path …         │
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

- **NavRail（最左 icon 列）**：宽度固定 `--nav-rail-width: 52px`，不可拖拽。Top-level section 切换：`chat` / `members` / `computers`。底部一个 settings 按钮（独立 action）。当前 section 决定后面三列显示什么——见 §3。
- **Titlebar**：跨整个窗口宽度。`-webkit-app-region: drag`，按钮 `no-drag`。macOS 用 `titleBarStyle: 'hiddenInset'` + 自绘内容。**Win/Linux 暂不支持**（v1 平台仅 macOS，详见 §0 与 §11），无需为其做兼容处理。
- **Sidebar / Channels Sidebar**：宽度可拖拽，`localStorage` 持久化。每个有右边一条 4px 的 splitter（hover 时变色）。仅在 NavRail = `chat` 时显示。
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
| traffic-lights 占位 | 80px padding（macOS） | drag |
| workspace name | 当前选中 workspace 的 name；ellipsis | drag |
| more icon | `⋯` 按钮，菜单：Rename / Manage Members / Copy Workspace Path / Delete Workspace | no-drag |
| icons slot | 预留：theme toggle、help、events window 切换（debug 用，最终走 menu） | no-drag |
| workspace_path | 右侧 ellipsis + `dir="rtl"`（保留路径尾部） | drag |

> **More 菜单的 Rename / Delete** 沿用 ChannelsSidebar 现有逻辑（移过来即可），不是新功能。  
> **Manage Members** 在 DM workspace 下隐藏（同现状）。  
> 没有 workspace 选中时，titlebar 只显示 traffic-lights + 空 drag 区。

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
- Saved 是**全局唯一入口**（不分 workspace），点击进入 §6 的 Saved List View。
- 选中 Saved 时 ChannelsSidebar 隐藏或灰显（待定，倾向**整体改成 list 视图**，workspace sidebar 仍然显示让用户能切回去）。
- **Group header 整行可点击**（含 chevron + label + count），右侧的 `+` action 是独立按钮——避免点错触发折叠。

**宽度持久化（PR6）**：

- 新建 `apps/desktop/src/renderer/hooks/useResizableWidth.ts`
- localStorage key：`silverhand.layout.sidebar-width` / `silverhand.layout.channels-sidebar-width` / `silverhand.layout.split-ratio`
- min/max：`Sidebar` 200–360；`ChannelsSidebar` 200–400；split ratio 0.25–0.75
- splitter：4px 可点击区，hover 时变 `--accent`，drag 时整个文档加 `cursor: col-resize` + `user-select: none`

---

## 4. ChannelsSidebar（中列）

**Status**: 现状基本可用；本节小改。

变化：

1. **顶部 workspace info block 删除**——内容已迁移到 titlebar（§2）。ChannelsSidebar 顶部只保留 `+` 新建会话按钮和（regular workspace）`Manage Members`。
2. channel tree 当前实现保留：top-level + thread indent。thread 节点状态：`closed` 删除线 + 灰；`active` 绿点；`crashed` 红点。
3. 选中 thread 时左侧高亮**也包括其 parent**（视觉提示"你正在看一对"）——split view 下两边各对应一个高亮节点。

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

**Status**: Spec → PR4（依赖 PR2）

参考 [`core-design.md` §3.6](./core-design.md#36-thread--取代-slock-thread-的真隔离方案)。原方案只支持 agent 通过 MCP 工具 spawn；本节扩展 **human 可以从 UI 触发**。

> 命名说明：UI 概念叫 **Thread**（IM 中广泛使用的"在某条消息上展开子讨论"的术语）。底层落到 `conversations` 表的 child channel 上 —— 所有 Thread 都是 child channel，但 agent 通过 `spawn_child_session` MCP 工具自己开的 child channel **不是 Thread**（没有 `thread_anchor`）。

### 7.1 后端 API

```
POST /api/messages/:id/thread
  Body: {}  （目前无参数；将来可加 initial_prompt override）
  Returns: { child_session_id: string }
```

实现要点（对应 `routes.ts` 中 `POST /api/messages/:id/thread` 路由）：

1. 找到原 message + 其 channel + workspace
2. 拒绝条件：
   - 原 channel 已 `closed_at != null` → 409
   - 原 channel 已经是 thread (`parent_channel_id != null`) → 400（硬限 1 层）
3. 幂等：同源 message 已有未关闭 thread → 复用（`findOpenThreadChild`）
4. INSERT `conversations`：`parent_channel_id = 原 channel.id`，`spawned_by_agent_id = null`（human spawn 标识；schema 已允许 null），`title = "Thread: " + 截短(原 message body, 50)`
5. members：默认**只拉发件 agent**（如果原 message `from_kind='agent'` 且 `from_agent_id` 非空）。如果原 message 是 user 发的，先用父 workspace 的 default agent（dm_agent_id 或第一个 member）兜底——这个 case 实际是"我（user）想就自己刚才说的话开个 thread"，需要 v1 时具体测下手感。
6. 写两条初始消息：
   - **第一条 system（带 metadata）—— thread anchor**：
     ```
     content: 'Quoted from #<workspace> · @<sender>:\n\n> <quote 原 body, 截断>'
     metadata: {
       subtype: 'thread_anchor',
       quoted_message_id: <id>,
       quoted_channel_id: <channel.id>,
       quoted_workspace_name, quoted_content, quoted_from_kind,
       quoted_from_agent_id, quoted_agent_name, quoted_created_at,
     }
     ```
     UI 渲染时识别 metadata，把锚点变成"跳回原消息"按钮。snapshot 字段冻结原消息内容/时间，原消息后续编辑不影响 thread 锚点。
   - **第二条 system（onboarding）**：
     ```
     content: imperative onboarding 文案，例如：
       'Onboarding task (system-triggered): You (@<agent>) just joined a thread in #<workspace>.
        Context: the user wants to dig deeper into the quoted message above.
        1) Read the quoted message.
        2) Send one short greeting via mcp__chat__send_message acknowledging the topic.
        3) Then await user input.
        You can call mcp__chat__send_message with target='parent' to ask the parent channel for context if needed.
        Call close_session(summary) when this thread reaches a conclusion.'
     metadata: { subtype: 'onboarding' }
     ```
7. **不主动 spawn thread 进程**——等用户在 UI thread pane 第一次发消息或显式 start 时再 spawn（同 §3.6 第 5 步）。
8. 返回 `child_session_id`。

后续追加 member：复用现有 `Manage Members` 对话框（PR4 顺便扩展使其支持 thread，或 v1 阶段只能从 workspace level 加，加进 workspace 后 thread 自动可见）。**MVP 版本只允许默认成员**，"后加 member" 留 v1.1。

### 7.2 前端

- App.tsx 新增 state `openThreadId: string | null`
- `MessageItem.onStartThread` → POST `/thread` → `setOpenThreadId(child_session_id)` + 切到该 workspace 下也包含 thread 的 channel list
- Main view 改成：
  ```tsx
  <SplitPane
    left={<ChannelView channel={parent} />}
    right={openThreadId ? <ChannelView channel={thread} onClose={() => setOpenThreadId(null)} /> : null}
    defaultRatio={0.5}
    storageKey="silverhand.layout.split-ratio"
  />
  ```
- 关闭 thread（点 thread 头部的 ✕，或 thread 自己 close_session）→ split 收回，parent 占满
- thread 已经在 ChannelsSidebar tree 里也能看到（缩进显示），点击 sidebar 里的 thread 等价于触发 `setOpenThreadId(id)` + parent 自动选中
- 同一时间只允许一个 thread pane：再点别的 message 的 Thread，提示"关闭当前 thread 才能开新 thread"或直接替换（v1 暂定**直接替换**+ confirm）

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
- **thread 永远只有一层**（schema + UI 双重保险）；UI 在 Thread button 上根据 `parent_channel_id != null` 隐藏
- **dev-only feature 的入口** 只在 macOS 应用菜单 → Developer 子菜单下；不出现在用户视野中其他地方
- **每个 PR 完成后追加 `docs/progress.md`** 一段，记下：动机、关键决策、踩坑、验证（typecheck / test / 手测）

---

## 11. Open questions（v1 之后再决定）

- Saved 是否需要 search / filter？（v1: 不做；列表 < 50 条够用）
- Thread 内的成员管理 UI 在哪？沿用 workspace-level Manage Members，还是 thread 自己一个？（v1: 不做"thread 内单独管理"，workspace 加成员自动出现在所有未关闭 channel 里——验证现状逻辑是否如此）
- titlebar 在 Win/Linux 的窗控按钮（min/max/close）什么时候补？v1 **仅支持 macOS**，暂不为 Win/Linux 出窗控/自绘 titlebar；要支持时再开新分支统一处理（不要现在就加 `process.platform !== 'darwin'` 兼容代码污染主线）。
- 多 thread 并发：spec 写"只允许一个 thread pane"，但 sidebar tree 仍然能切换不同 thread——这两个语义要对齐（建议：sidebar 切换 thread 等价于 `setOpenThreadId(targetId)`，永远只显示一个 pane）

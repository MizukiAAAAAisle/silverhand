# App Layout & Interaction Spec

定义 silverhand desktop 客户端的**布局结构、消息渲染、交互流程**。视觉 token（颜色、间距、圆角等）见 [`design-new-theme.md`](./design-new-theme.md)；本文不重复 token，只引用。

整体架构、数据流、process 模型见 [`core-design.md`](./core-design.md)。本文聚焦"用户能看见和操作的部分"。

> 本文只保留跨表面的交互原则与布局约束；组件结构、路径、尺寸、CSS var、localStorage key 与实现状态以代码、测试与 task board 为准。

---

## 0. 设计原则

1. **IM 直觉优先**：参考 Slack / Discord 的核心心智模型——左侧 workspace 列表、中间 channel 列表 + 消息流、消息可 hover/save/thread。不引入任何"agent runtime"概念到普通用户视野（events、debug、process status 都属于开发者面板）。
2. **主窗口只给最终用户**：agent-runtime 调试面（events、process status）不嵌入主窗口、不进普通用户视野；开发者面若存在，与产品 UI 物理分离。
3. **状态最小化持久层**：用户偏好（sidebar 宽度、显隐、theme）走前端本地存储，跨进程/跨重启的领域状态走 SQLite，不混。
4. **拒绝乐观跳层**：每个交互都从一个明确的"当前位置"出发——currentWorkspace × currentChannel × currentThread（最多一层）。`Saved` 视图是一个例外的"fly-out"，进入后退出回到上次的 channel。
5. **平台范围 = macOS**：v1 只目标 macOS，渲染 / 布局 / 自绘 titlebar 都按 mac 优先打磨。**不要为 Win/Linux 写兼容分支**（`frame: false`、自绘窗控按钮、平台 sniff fallback 等等都不要），后面如果要支持，开新分支统一处理，避免主线代码到处 `process.platform !== 'darwin'` 污染。

---

## 1. 整体布局

```
┌──────────────────── Custom Titlebar (drag region) ───────────────────────────┐
│  [traffic-lights] [SB] workspace-name [archived] [icons]                     │
├────┬───────────────────────┬─────────────────────────┬───────────────────────┤
│ Nav│ Sidebar               │   ChannelView           │  ThreadPanel          │
│Rail│  (tools + STARRED +   │   (main line:           │  (only when a         │
│icon│   workspaces, each    │    messages, composer)  │   reply-cluster       │
│col │   with its channels)  │                         │   is open)            │
└────┴───────────────────────┴─────────────────────────┴───────────────────────┘
        ↑resize                          ↑split-resize (only when thread open)
```

- **NavRail（最左 icon 列）**：宽度固定、不可拖拽。Top-level section 切换：`chat` / `activity` / `tasks` / `members` / `computers`，底部一个独立 settings 按钮。当前 section 决定后面几列显示什么——`chat` 见下方 browse 模式，`activity` 见 §1.1，`tasks` 见 [`tasks-design.md` §5](./tasks-design.md)，`members` / `computers` 见 §3。
- **Titlebar**：跨整个窗口宽度，drag 区 + no-drag 按钮，macOS 走 hiddenInset + 自绘内容。**Titlebar chrome 是 section-aware 的**：**chat/browse mode** 在红绿灯右侧放 sidebar toggle；**activity mode 不显示 toggle、左 offset 独立于 chat sidebar state**（见 §1.1，别拿本条泛化覆盖 §1.1）。
- **Sidebar（唯一 browse 列）**：宽度可拖拽，显隐和宽度都持久化。**仅在 NavRail = `chat`（browse 模式）时显示**；隐藏时进入 chat-only zen，但 NavRail 作为 section 切换器常驻，titlebar toggle 仍是恢复 sidebar 的入口。**`activity` section 不显示这条 browse sidebar**——由 Activity list 列取代（§1.1）。
- **Main view（ChannelView + ThreadPanel split）**：默认只有主消息流占满；user 在某条 message 上点 Thread 后才出现 right pane（该 message 的 reply-cluster）。ThreadPanel 永远只有一个（在另一条 message 上点 Thread 替换当前 cluster + 用户确认）。

纵向色阶（NavRail → Sidebar → Chat）与导航 row 的 default/hover/selected 状态机由 theme 决定，详见 `design-new-theme.md`。

---

## 1.1 Activity section（NavRail = `activity`）

Activity 是 NavRail 顶层 section，与 `chat` 平级（不再是 chat sidebar 里的折叠/快捷版）。**该模式下不显示 chat 那条 browse sidebar**——Activity list 取代它。布局是**自适应的、由 route 派生**（不是独立 `isSplit` UI flag）：

- **未选中 item**（bare `/activity`，含 caught-up 空态）→ Activity list **占满** NavRail 右侧剩余空间；右侧**不挂** ChannelView / SplitPane（不摆空 pane，也不带回「未选中也有 conversation surface」的隐性状态）。
- **选中 item** → 分屏：Activity list（此时收成左列）| 完整 ChannelView | optional ThreadPanel。

即 **split ⟺ route 带 channel**，与 chat「thread pane 仅在某 message 上点 Thread 后才出现」是**同一条渐进披露原语**（§1）：Activity-list→ChannelView 之于 ChannelView→ThreadPanel。

```
未选中（bare /activity）                选中（route 带 workspace + channel）
┌────┬────────────────────────┐        ┌────┬──────────┬──────────────┬───────────┐
│ Nav│  Activity list         │        │ Nav│ Activity │ ChannelView  │ Thread    │
│Rail│  占满右侧（含空态）      │   →    │Rail│ list     │ （完整，与    │ （完整，   │
│icon│  排序/过滤/选中          │  点选  │icon│ 左列·可   │  chat 逐像素/ │  仅 thread │
│    │                        │        │    │ 拖拽·min  │  逐功能一致） │  打开时）  │
└────┴────────────────────────┘        └────┴──────────┴──────────────┴───────────┘
                                              ↑ 与 chat 同一组件同一 hooks
```

铁律（本 section 的存在理由 = 删一层重复渲染，不是加一个入口）：

- **右侧复用 Chat 的真正 `ChannelView` / `ThreadPanel`——同一组件、同一 hooks，不复制。** composer / thread / inline-search / jump-prime / mark-read / attachment / message-actions 全经同一路径继承 → chat 侧任何改动 Activity 自动跟。**「无条件自动同步」是单一组件权威的结构性保证，不是纪律要求。** 判据：任何 chat 能力若需要在 Activity 里单独补一遍，即结构没改对。
- **选中态 SoT = `(workspace, channel, optional thread)`，且 workspace 从选中的 conversation 派生。** Activity 是**跨 workspace 的全局队列**，而 ChannelView / titlebar(ws name) / 所有 ws-scoped hooks 都是**单 workspace 作用域**。故 Activity section 复用 chat 的 channel/thread 路由参数形，**并带 workspace 段**；titlebar 与 ws-scoped hooks 读同一 route workspace → 跨 ws 选一条 activity，右侧 pane 与 workspace context **一起**切，不留 desync。chat 与 Activity = 同一 selection SoT 的两个 navigator。
- **Activity route 恰有两形，没有 workspace-only 中间态。** 合法形只有 bare `/activity`（未选中）与「带 workspace + channel」（选中）。**「有 workspace 无 channel」不是合法 selection state**——它会造出一个「无 activity item 对应、workspace 非从 conversation 派生」的第三态（titlebar 显示 workspace name/settings/member、ws-scoped query 以为有 workspace，但内容区仍是全屏 list），直接违反上一条「workspace 从选中 conversation 派生」+「未选中 = 纯 global list」。route 解析对 Activity **只认这两形**；手写非法路径至多降级成 activity section + 无 workspace/无 channel（或 normalize 回 bare `/activity`），**绝不产生 workspace selection**。
- **删除的两条隐藏分支（重构的实质）**：① `sourceViewer` 降级 chrome；② 平行 docked-source 机。二者是旧「快捷版」的载体，改对后不再存在——不是被新分支替换，是被删除。
- **Activity list 列本身 = 全局 scorer 的纯投影**：只负责选中 / 排序 / 过滤，**不拥有任何 message/thread 渲染**。空态 = caught-up。
- **Activity list 宽度 = Activity 自己的 resizable + min-width + 独立持久化的 layout preference**（分屏时生效）。**绝不复用 chat 的 workspace-sidebar 可见态或宽度语义**——那会把 chat browse state 泄进 Activity，与 Titlebar blocker 同类。min-width 保证 list row（where / subject / reply 三行 + count token）基本元素可读。
- **Titlebar chrome 必须 section-aware，绝不读 chat 的 browse-sidebar 可见态来给 Activity 布局。** Activity mode 下：**不显示 browse sidebar toggle**（该模式没有 browse sidebar，控件不该暴露）；**offset 跟随 Activity list 的实际（可拖拽）宽度、独立于 chat 的 workspace-sidebar state**——未选中（list 占满）时无 workspace title；选中后 workspace name 对齐到 ChannelView 列正上方；**拖拽改变 Activity list 宽度时 offset 必须同步**。否则用户在 chat 收起过 workspace sidebar 后进 Activity，titlebar 会按错误 offset 偏移——这是 chat-only UI state 泄进 Activity layout，违反本节「Activity 下无 browse sidebar、Activity list 取代它」的契约。
- **隐藏一个控件 ≠ 停用它背后所有 mutation path——browse-sidebar 的每条控制入口（可见 toggle *与* 键盘 chord）必须同处 `chat` section 边界。** Titlebar 里那个 sidebar toggle 只是 browse-sidebar 状态的**可见**入口；键盘 chord（`⌘\`）是**第二条隐藏入口**。只把可见 toggle 做成 section-aware、却让键盘 chord 无条件挂在全局，Activity mode 下用户仍能改 chat browse-sidebar 的 visible preference，回到 chat 时布局突变——与上一条 Titlebar blocker 同源（hidden control state 被 Activity 面的残留入口触达）。铁律：凡 `chat` 独占的 browse-sidebar 控制，gate 在 `appSection === 'chat'`——键盘 chord **gate 的是注册**（disabled section 不注册监听，chord 保持自由、不 stray `preventDefault`），不是在 handler 里 early-return。**判据：一个控件被 section 隐藏时，枚举它所有 mutation path（toggle / 快捷键 / 命令 / 深链）确保每条都被同一 section 边界挡住，别只挡可见的那条。**
- **Titlebar entry 分两轴，别混进一个 gate——browse-sidebar chrome = section-scoped（chat 独占）⊥ workspace-scoped action = workspace-presence-scoped（section 无关）。** browse-sidebar toggle 只在 `chat` 有意义（Activity 无 browse sidebar），gate 在 `appSection === 'chat'`；但 workspace-scoped action（Tasks drawer、Workspace settings 等）只看「有没有选中的 workspace」——Activity 选中态 workspace 从 conversation 派生（SoT），这些 action 必须可用；bare `/activity` 因无选中 workspace 自然隐藏。**把 workspace action 绑到 section 轴 = category error**（同类 action 不一致就是 tell）。正确谓词看「conversation-showing context」：`((chat && channel view) || activity) && selectedWorkspace`。这条与上一条键盘 chord 是**一对对称失败**：上一条 = Activity 该隐藏的 browse 控件残留 mutation path（多了）；本条 = Activity 该保留的 workspace action 被 chat-only gate 误删（少了）；同一 root = section 轴与 workspace-scoped-action 轴混用。（注：create-channel 入口是 browse-sidebar action、Activity 无 browse sidebar，**真** chat-only，不在此列。）

`chat` 保持 browse 模式不动；要去一个没有 activity 的 channel → 切回 `chat`。

---

## 2. Titlebar

布局（左到右）：traffic-lights + sidebar toggle（**chat/browse mode only**；activity mode 不显示，见 §1.1）→ workspace name（ellipsis）→ `Archived` pill（仅归档 workspace）→ workspace-scoped action icons（Tasks / Manage Members / Workspace settings）。空区 drag，按钮 no-drag（避免吃掉原生拖拽/双击最大化）。**titlebar 不显示 workspace 的本地路径**——workspace 不承载项目目录，agent 的工作目录是按 id 算出的派生坐标、不是用户决定的产品概念（[`workspace-layout-relocation-v1.md` §3.5](./workspace-layout-relocation-v1.md)，#task:1809 已删该 slot 与 rtl-ellipsis 配方）。

- **Toggle 视觉**：**只有一个**（两栏合并成一棵树后，第二个 toggle 连同它的列一起退役——为单栏再留一套图标家族会读成「有个控件不见了」）。状态用图标形状表达，不用激活背景色：实心 panel = 展开，虚线 panel = 收起；hover 仅淡化背景，不带选中态底色。
- **Action icons**：Tasks（打开 workspace-wide tasks drawer，带活跃数 badge）/ Manage Members / Workspace settings。**Manage Members 与 Workspace settings 在 DM workspace 下隐藏**；Rename 与 Delete workspace 住 Workspace settings 对话框内，titlebar 不另开 `⋯` 菜单重复它们。
- 没有 workspace 选中时（chat/browse mode），titlebar 仍显示 traffic-lights + sidebar toggles + 空 drag 区。（activity mode 的 titlebar chrome 见 §1.1。）
- **平台范围**：v1 仅支持 macOS。Win/Linux 上自绘 titlebar 没必要做、也不需要兼容代码，别为 `process.platform !== 'darwin'` 加分支（见 §0）。

---

## 3. Sidebar（唯一 browse 列，NavRail 右侧）

**一棵树，不是两栏**（#task:1889）：channel 是 workspace 的 children，同一列里展开。结构（自上而下）：工具行（`Search` / `Saved` / `Archived`）→ STARRED 组 → WORKSPACES 组（每个 workspace 行下挂它自己的 channels）→ DM 组。settings 入口在 NavRail 底部；members 是 NavRail top-level section，不在 Sidebar 内。

- **Sidebar 仅在 NavRail = `chat` 时显示**。NavRail = `members` / `computers` 时，本列被相应的 MembersPanel / ComputersPanel 替换（仍占同样宽度、同底色）。
- **一个 splitter、一个 collapse pane。** 显隐与宽度都是全局 layout preference，不随 workspace 切换；titlebar 按钮和键盘 chord（`⌘\`）双向同步，隐藏时 splitter 也跟着卸载。宽度经 CSS var 引用，drag 改值不触发 transition；splitter 是窄可点击区，hover 变色，drag 期间整个文档加 col-resize + 禁选中。
- **只有一级缩进，且不留常驻折叠沟。** 全树两条 glyph 列，相距一个 16px 缩进步：**外列**（工具行、三个组头 STARRED / WORKSPACES / DM、workspace / DM 头行、STARRED 行）与**内列**（只有 workspace / DM 下面的 channel 行）。树结构上有四层，但**逐层缩进不做**——这一列本来就窄，阶梯会把宽度花在留白上、读起来层级过多。唯一那一步花在 channel 上：组头本身已经由排印（全大写、字距、更小、muted、尾随计数）读作标签，而 workspace 行与 channel 行同尺寸、同字重、同色、同高且都可点，同列时一个 workspace 与它下面九个 channel 会读成一条平铺的长串；缩进 channel 之后，每个 workspace 的子集就是一个有边界的块。代价是已接受的：同一个 channel 在 STARRED 里比在父下更靠外——那正是「缩进 = 深度」，在 STARRED 里它的父就是那个组。
- **icon↔三角原位替换属于每一个 disclosure 行，按能力划分而不是按 kind。** 凡是自己带 `aria-expanded` 的行——三个组头 STARRED / WORKSPACES / DM，以及 workspace / DM 头行（同一个 `WorkspaceHeaderRow`，regular 与 DM 只差图标）——平时显示语义 icon 或身份图标，hover / keyboard focus 时原位换成**实心的折叠三角**（`components/icons/DisclosureTriangle.tsx`；折叠向右、展开向下），因此折叠控件不额外占一列，顶部三项与组头同列。三角是填充而非描边：填充形状每像素的视觉重量高于描边，所以它的外形刻意比同槽的 2px 描边字形小一圈（24 网格里约 11×9、形心正落在中心），否则 hover 态会比静止态更重。开合关系是「实心三角 = 可开合的铰链、方向即状态」，chevron 更像「下面还有内容」的滚动提示；Members / Computers / Settings 那几个面板组头**不可折叠**，只有 icon + label、没有折叠字形（lucide caret 只是 `SidebarSection` 里「可折叠但没有 icon」的兜底分支，今天无 consumer）。组头 hover **只做这一次图标替换**：不加背景、不加边框、不变字色。三个组头 icon 是同一族的等重描边字形——`Star` / lucide `MessagesSquare`（DM）/ lucide `LayoutGrid`（WORKSPACES）；均不带 `data-workspace-icon`（那是 workspace 实例的主题化贴纸，组头不是实例）。WORKSPACES **不用 `W` 字形**：字母紧挨着以它开头的那个词说不出新东西，且下面每个常规 workspace 行的贴纸本身就是 `W`，同列读两遍。`LayoutGrid` 是唯一不带外框方形的候选——下一行的 `MessagesSquare` 与工具行的 `Archive` 都是方框，14px 下第三个方框会读成同一个词。DM 用**复合**双气泡而不是单枚 `MessageSquare`：单枚方角气泡是 **thread** 的字形（`ThreadIcon`），两个概念靠「单 vs 双」分开。手绘椭圆气泡试过并被否（观感，shiki 2026-08-08）。
- **hover 才显示的右侧 action，揭示范围是它管辖的那个子树，不是它自己那一行。** 组头（排序 / `+`）取整组，workspace / DM 头行（channel 排序 / `+ New channel`）取整枝（该头行 ∪ 它自己的 channel 行）——常驻会让几份 chrome 与行争视线，而这是「安排一次」的控件；你是读列表时才想起它，不是读标题时，`+` 在指针往下移向 channel 的一刻消失就得重新瞄准。两级 scope 各自独立：hover 一个 workspace 不会让同组别的 workspace 一起亮。键盘那一半用 `:has(:focus-visible)`（不是 `focus-within`，Chromium mousedown 就上焦点），菜单开着时用 `:has([data-state=open])` 钉住。侧栏之外的 panel（Members / Computers）保留常驻 `+`。
- **叶子行的身份图标永不替换；头行不铺 hover 底色。** channel / STARRED 这些叶子行的图标不是铰链，永远保持不动。workspace / DM 头行相反：它唯一的动作就是折叠，身份由名字承担，所以 hover / keyboard focus 时原位换三角（见上一条）。静止字色是 `--text-secondary` 而不是 muted——muted 是组头**标签**的重量，头行穿上它就比自己的 channel 子行还淡，读成一个不可按的标题（shiki「可点击提示不强」，2026-08-08）。常驻三角是被否掉的另一个做法：它要单开一列，要保住那唯一的一级缩进就得让每个 channel 再右移 12px。底色仍然不铺：`.sidebar-row-border` 的状态涂装（forza6 下是柠檬底 + 投影）不参与，改用只保留描边宽度、不带状态的 `.sidebar-row-gutter`。填充留给唯一的选区：当前打开的 channel。
- **workspace 头行 = 折叠开关**：不导航、不改高亮、不改 titlebar 上下文。**首屏默认只展开三个一级组头（STARRED / WORKSPACES / DM），workspace / DM 分枝默认折叠**——未经操作的树读作一份 workspace 清单，而不是所有 workspace 的所有 channel；下面那条懒挂载因此在第一帧就生效，而不是等用户手动折叠。之后折叠态逐 workspace 持久化。children 按展开态**懒挂载**——折叠的 workspace 不挂载它自己的 channels / unread / modes 查询。（这不等于「该 workspace 零请求」：STARRED 订阅**全部可见 workspace**的 scope，且其中的 regular channel 会拉取父 workspace 的 attention modes。）**唯一例外 = 你正在看的那一枝**：见下条。
- **折叠任何一层容器时，当前打开的那条 channel 行都留在屏上**——workspace / DM 分枝如此，STARRED / WORKSPACES / DM 三个组头也如此（`SidebarSection` 的 `selectionPath`）。守的是「选中行必须始终在侧栏可见」：否则主面板显示着某个 channel、侧栏零高亮。**留的是那一片叶子本身，不是通往它的整条链**：中间那一行会是「唯一动作是折叠、而折叠已经不能改变任何东西」的假控件，何况你在哪个 workspace 由 titlebar 承担。被否的另一种做法是「含选中项的 ancestor 不可折叠」：同一个假控件问题，且推到所有 ancestor 后 WORKSPACES 组头会几乎永久不可折。留下的那一行不降级——同样的缩进、填充与右键菜单；但没有拖拽、没有排序入口、也不出「New channel」空态，因为折叠态唯一还允许说的事情是「你在这里」。选中的是 starred 会话时，WORKSPACES / DM 那边渲染零行：它已被排除进 STARRED，由 STARRED 折叠态那一行承担。代价是持有选中的那一枝的三条查询（channels / unread / modes）在折叠态仍挂着 = 上一条懒挂载的唯一例外，有界：全树至多一枝持有选中，且正是缓存已热的那个 workspace。**「持有」按 exclusive-home 之后的成员资格判，不按父 id 相等判**（`branchHoldsSelectedRow`）：选中的是 starred 会话时，那一行已经不是父枝的成员，父枝零行 ⇒ 不进这条例外、照常不挂载。
- **高亮只有一档，归会话**：FILL = 当前打开的那个 channel，侧栏选区状态就等于 `selectedChannelId`；**workspace / DM 头行永不高亮**。`/chat/w/:id`（无 channel）时侧栏零高亮，入口改由行内 `+ New channel` 承担。**导航不展开任何分枝**（reveal-on-navigate 已删，#task:1889 / #task:1901）：打开一条 channel 时，若它的父分枝是折的，就只显示父头行 + 那一条行（上一条），要看兄弟频道自己点开一次。存储里的展开位因此只记「我要它开着」，不记「我去过这里」——旧写回让默认折叠随使用衰减回全展开。
- **折叠头徽章**：折叠时保留聚合未读徽章，展开后撤掉；mute 标记两态常驻。徽章不带点击跳转。
- channel 列表只展示 top-level channel-like（`channel` / `dm_channel`），**不含 thread 节点**——thread 是父 channel 里的 message reply-cluster、不是导航树节点（§7）。同一 workspace 下是**单一平铺组**（viewer sort + 每父独立的手动拖拽序），不做 pin 分段、也不做 thread 缩进层级；归档 channel 不进树，归 §4.5 的全局 `Archived`。
- **STARRED 是独立组，只装会话**；starred 会话必须先从其父的 `channels` 组里排除，再交给排序/拖拽，否则同一行出现两次。折叠头徽章不因搬家做减法。
- **Slide 动画**：sidebar 收起/展开走 apple-feel 缓动的两层结构（layout 层收缩 + paint 层 transform 滑出），rapid toggle 自动 cancel 旧动画、reverse mid-closing 直接翻回展开。隐藏的 surface 加 `inert` + `aria-hidden="true"`，移出 a11y 树并禁焦。**`prefers-reduced-motion` 同时关 CSS transition 和 JS 状态机的延迟**（短路到同步 mount/unmount）。
- Saved 是**全局唯一入口**（不分 workspace），点击进入 §6 的 Saved List View；期间 sidebar 仍显示让用户能切回去。
- **Group header 整行可点击**（含折叠三角 + label + count），右侧的 `+` action 是独立按钮——避免点错触发折叠。

---

## 4.5 Context menus

右键菜单一律用 Radix context-menu，**不使用原生菜单**；所有菜单 token 收敛到单一共享组件（容器 / item / separator），并另导出一套共享 token 的 dropdown 供「点击打开」的 action menu（如 ChannelView header 的 more 菜单）复用。

- **Workspace / DM 头行**：只有 Notifications（mute 仅 regular workspace——DM 是 directed-grade，结构上不可 mute）⇒ DM 头行没有右键菜单。**容器没有 Star**（#task:1900）：Star 只属于会话，含义唯一 = 搬进全局 STARRED。容器曾用同一个词表示「组内置顶」，一是同一枚图标按行的类型给出两种结果，二是它在已有 manual 拖拽的列表上加了第二套排序权威——且置顶是在排序之后套上去的，把未加星的行拖到加星行之上会静默弹回。容器顺序 = `f(mode, rank)`。菜单结构住单一共享组件（`WorkspaceContextMenu`）；无可用 action 时不渲染空菜单。**没有 Open in Finder / Copy path**——workspace 不承载本地路径（§2、[`workspace-layout-relocation-v1.md` §3.5](./workspace-layout-relocation-v1.md)）。
- **Channel row**：Star（**单向**——树里的 channel 列表已把 starred 会话排除，没有 Unstar 状态可达）、Notifications、Archive/Restore（top-level channel-like `channel` / `dm_channel`，member-gated）；Copy name 全部可用。（sidebar 只列 channel-like、无 thread 行——见 §3。）
- **STARRED row**：Unstar（唯一的取消入口——父列表已不持有该行）、Notifications、Copy name。**没有 Archive**：归档是容器侧的组织动作，而 starred 行是「搬走的那一份」，在这里归档会让行同时从两处消失。
- **ChannelView header more**：保持 dropdown 交互（不改右键）。Rename / Archive / Restore 按 channel-like 同构（`channel` / `dm_channel`；rename 另需未 closed）——DM channel 与 regular channel 走同一套入口。
- **归档兜底选择**：归档当前主选 channel 时，主面板按 sidebar 顺序做 **neighbor-aware 兜底**：优先下一条 active top-level，否则上一条，都没有则清空到 workspace 空态（纯函数 + 单测覆盖）。只有归档「主面板正在看的那条」才移动选择；secondary 面板归档 / restore 不抢主选。
- **Archived 面板**：全局 Archived 是**唯一的归档索引**，一个视图覆盖归档 workspace 与归档 channel（#task:1890）。两段固定顺序 **Workspaces → Channels**（还原 workspace 是还原其内部 channel 的前提），段为空时整段不渲染；两段共用同一组筛选（workspace / archived date）。归档 workspace 段读 `useWorkspaces` 的 raw 集合（`archived_at !== null`，无新接口），行上给 Open（等价于旧 sidebar `ARCHIVED` 分组的选中）与 Restore；还原是非破坏动作，不加确认。channel 段含 regular `channel` 与 agent_home `dm_channel`：workspace 过滤 dropdown 按 Workspaces / DMs 两组分组（镜像 Message Search）；列表行统一用 `#` channel glyph（DM 是 channel-like），靠 `@<agent>` 文字上下文区分（#task:1156）。点击 archived DM 行跳到该 DM 的 agent_home workspace + dm_channel（不沿用当前 workspace 上下文）。

---

## 5. Message Rendering

### 5.1 Markdown 安全契约

Markdown 渲染是**安全边界**，以下为不可回退的契约：

- **绝不启用 raw-HTML 渲染**（不装 rehype-raw，默认 skip-HTML）。Agent 输出即使包含 `<script>` 也只渲染为 escape 文本，永远不作为实际 DOM 注入。
- **链接经 `shell.openExternal` 打开，永远不在窗口内导航**（自定义 `a` 组件走 preload 暴露的能力，不产生 in-window navigation）。
- 代码块支持高亮 + hover 出现 Copy 按钮。

### 5.2 三种消息形态

#### A. user 消息

- 右对齐气泡；header `you` + 相对时间（hover 显完整时间）；body markdown（user 输入也支持 markdown，方便贴代码）。
- hover：整行高亮 + 细边框，左下浮出 `Thread` `Save`。

#### B. agent 消息

- 左对齐气泡；header `@<agent-name>` + 相对时间；body markdown；hover 同 user。
- 头像：v1 不做，用名字色块代替（首字母 + accent 色）。

#### C. system 消息

**左对齐 secondary**（非居中 italic），无气泡、文字偏 muted，点击行任意位置切换展开。根据 `metadata.subtype` 区分行为：

| subtype | 行为 |
|---------|------|
| `'onboarding'` | 默认 clamp 到 1 行 + ▸ icon；点击展开全部（展开后仍保留 secondary 色，区分普通 message） |
| `'join'` / `'leave'` | 单行不可折叠（一般本来就一行） |
| `'child_summary'` | 类似 onboarding，可折叠（summary 可能长） |
| `null` / 其他 | 默认全显（保守） |

### 5.3 时间显示

相对时间（"3 分钟前" / "刚刚" / "昨天"），hover 显示完整绝对时间。

### 5.4 Thread / Save action bar

- hover message 时**绝对定位浮在左下，不挤压 layout**（无布局位移）。
- icon button：`Thread` / `Save`；save 后 icon 变实心 + active 色（二次点击 = unsave）。
- 点击 action 之外的空间不消费 hover 状态。

---

## 6. Save 功能

**数据模型取舍**：saved = 单一全局扁平列表，不分组、无 category 列（未来要 tag/category 再加新表，不污染主表）；唯一性 = 每个 user 对同一条 message 至多一条 saved 记录，二次点击 = unsave。

**Saved List View**：左 sidebar 顶部点 `★ Saved` 进入，平铺列表最新在上。每条卡片显示 workspace · sender · 相对时间，body markdown，底部「跳转到对话」链接。点击跳转：切到该 channel（同时切 currentWorkspace/currentChannel），scroll + flash highlight 到对应 message——依赖 §9 的稳定 `msg-<id>` DOM 锚点。

---

## 7. Thread

UI 概念叫 **Thread**：在某条消息下展开子讨论。**它不是 `kind='thread'` 的 child conversation**——thread reply 是父 channel 中的一条**普通 message**，靠 `messages.thread_root_id = <root message id>` 归属到某个 root。主 channel 列表只显示 main stream（`thread_root_id IS NULL`），root 消息带 reply 徽标；点开右侧 ThreadPanel 才按 root 过滤加载 replies。

**thread 永远只有一层**：reply 归一到 canonical root，不允许 reply 之上再 reply 成树。Channel sidebar 不展示 thread children，thread 不是导航树节点。

旧 `kind='thread'` conversation 是只读 fossil（历史可读，写入 / 自动 spawn / agent thread create/close 已冻结）；需要隔离上下文或并行长任务时，创建新 channel，而不是 thread。

> 领域模型（`messages.thread_root_id`、reply-to 归一、cluster 语义）的权威是 [`core-design.md`](./core-design.md)；本节只描述其 UI 呈现。

---

## 9. 一致性约定（写代码时反复对照）

- **CSS color/spacing 永远走 token**，不写裸色值（`design-new-theme.md`）。
- **Markdown 容器最大宽度** 受可读行宽约束、与消息气泡一致，不随窗口横铺满宽——宽屏 workspace 里超长行难读。
- **每条 message 必须有稳定 DOM id（`msg-<id>`）**，用于 saved view 跳转 + 未来 anchor 复制——跨 message list 唯一且稳定，是这些跳转/锚点能力的统一依赖。
- **thread 永远只有一层**（schema + UI 双重保险）；UI 在 Thread button 上按 thread-root 归属隐藏二次分层入口。
- **Header variant 只能"显隐 / 重排" chrome，绝不替换或新造主题化 identity 原语。** 同一组件用 mode/variant prop 渲染不同密度的 header 时，凡带 `data-*` theme hook 的 identity/control 原语（channel `#` hash、列表频道图标等）**必须复用 canonical header 的同一个 primitive**；variant 只决定「是否展示 / 布局 / action 集合」，**不替换、不新造**那段 DOM。理由：「同组件不同 mode」只保护两个 mode *共享的那段 markup*——某个 mode 自己新增/替换的元素逃出共享路径，就会绕过主题 hook，在带 sticker 配方的主题下画成通用 glyph、像换了一套图标语言。mode 应是**减法**（gate 掉控件）或复用现有 themed 原语，不在分支里发明新视觉原语。data-hook 侧细则见 `design-new-theme.md`。

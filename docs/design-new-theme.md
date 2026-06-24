# 新主题制作指南

如何在 Electron 客户端里加入一套**完全不同视觉语言**的主题（不是 light/dark 切换，而是另起一套配色 + 排版 + 节奏的风格）。

读完 [`design-warm-literary-minimal.md`](./design-warm-literary-minimal.md) 再看本篇 —— 主文档定义了 warm-literary 这套基线的**所有规则**（饱和度上限、卡片两态、岛屿、浮层、选中色拆分等）。本文只讲**怎么把那些规则映射到一套新的 token 值上**，不重复设计原理。

---

## 1. 主题在代码里的位置

```
electron/src/renderer/src/
├── styles/
│   ├── global.css                  # 入口：@import tailwind + 各主题；@theme inline 暴露 var；非主题化常量（titlebar-height）；全局 element 样式
│   └── themes/
│       ├── warm-literary.css       # :root + [data-theme='warm-literary']（默认主题，避免 FOUC）
│       └── shadcn.css              # [data-theme='shadcn']
├── hooks/
│   └── useAppearance.ts            # 启动时读 config，把 data-theme 设到 <html>
└── settings/
    ├── types.ts                    # ThemeId 联合类型 + DEFAULTS.appearance.theme
    └── sections/AppearanceSection.tsx  # 主题选择器 UI（4 色预览 swatch）
```

**主题文件 = 一个完整的 token 定义块**，挂在 `[data-theme='your-theme']` 选择器下，含**所有**契约 token（见 §3）。缺一个，会从默认主题"漏过去"，肉眼看不见但行为不可预测。

`@theme inline { ... }`（global.css）把 `--color-bg-base: var(--bg-base)` 之类映射成 Tailwind 的 `bg-bg-base` 工具类。`inline` 模式的关键作用：Tailwind 不把 var **写回** `:root`，所以主题切换时下游 `var()` 会重新解析到当前 `data-theme` 块的值（如果没有 `inline`，会有 self-reference 死循环）。

---

## 2. 加一个新主题的步骤（最小可运行清单）

> 例：要做一个叫 `nordic` 的主题。

1. **新建 `styles/themes/nordic.css`** —— 复制 `shadcn.css` 当骨架，把选择器改成 `[data-theme='nordic']`，把每个 token 的值替换成本主题的色值（保持变量名不变）。**不要漏 token**，对照 §3 表逐一填。
2. **`styles/global.css` 顶部加一行**：`@import "./themes/nordic.css";`
3. **`settings/types.ts` 的 `ThemeId` 联合类型加一项**：`'warm-literary' | 'shadcn' | 'nordic'`
4. **`settings/sections/AppearanceSection.tsx` 的 `THEMES` 数组加一项**，提供 4 色预览（bg / surface / text / accent）和一句中文 `hint`
5. 重启 dev server，进 Settings → Appearance，切到 nordic，逐屏走查（见 §6 自检清单）

零代码入侵。所有主题相关改动只在上面这 4 个位置。

---

## 3. Token 契约（必须全部实现）

把这张表当**填空题**，每个槽位都得给值。值的取舍要遵循主文档的规则（饱和度上限、暖/冷一致性、可读对比度）。

### 3.1 背景色阶（含两类选中色）

| Token | 用途 | 选值原则 |
|---|---|---|
| `--bg-base` | 全局窗口底色 | 主基调；warm 是暖米 `#F5F1EA`，shadcn 是纯白 `#FFFFFF` |
| `--bg-primary` | 一级区域底（sidebar、main column 容器） | 比 base 略深一档 |
| `--bg-elevated` | 二级容器（卡片休眠态、segment control 容器、设置面板小块） | 再深一档 |
| `--bg-surface` | 三级容器（嵌套面板）| 再深一档；可与 elevated 接近 |
| `--bg-hover` | 通用 hover 反馈 | 比 elevated 略深 |
| `--bg-active` | 按下/激活态、segment control 容器 | 再深一档 |
| `--bg-selected` | **导航激活态**（sidebar 列表当前项、tab 当前项、segment 当前段） | 必须能从 `--bg-primary` 中明显跳出（≥ 5% 亮度差） |
| `--bg-floating` | **浮层 / 卡片表面**（popover、菜单、对话框、展开后的卡片） | 永远是"内容表面"，通常是主题里**最亮**的一档 |
| `--bg-chat` | **Chat 主读区**（会话 / Saved / Search 的 main 区域） | 独立于 `--bg-base`；base 可作为全局 frame，chat 应按阅读舒适度单独取值 |
| `--bg-app` | App frame 底色（panel card 之间露出的底） | 比 sidebar/card 表面沉一档；必须与 titlebar 背景协调 |
| `--bg-island` | 岛屿底色（代码块、JSON、终端、表格） | 中性灰，与 ocean 形成材质对比；warm 是冷中性灰 `#ECEAE5`，shadcn 因为本身灰白可与 `bg-primary` 同值 |
| `--bg-island-deep` | 表头、嵌套岛屿 | 比 island 略深 |
| `--bg-nav-rail` | NavRail（最左 icon 栏）底色 | 主题最强的一档信号色，或退化成 `var(--bg-primary)`（详见 §9） |
| `--bg-channels-sidebar` | 频道列表栏底色 | 与 nav-rail 同色家族、saturation 低一档；或退化 |
| `--bg-sessions-sidebar` | 会话列表栏底色 | 同色系最浅；或退化 |
| `--bg-nav-rail-hover` | NavRail icon hover 底色 | 与 `--bg-nav-rail` 成对；深色 nav 用浅混色，浅色 nav 用深混色 |
| `--bg-row-selected` | Workspace / Channel / Search / Saved row 选中底色 | 主题化替代硬编码 `--bg-selected`；必须从 sidebar 底色中跳出 |
| `--bg-row-hover` | 同一组 row 的 hover 底色 | selected 的弱一级，不应比 selected 更抢眼 |

**关键：`--bg-selected` ≠ `--bg-floating`**。这是踩过坑的拆分（详见主文档 §9.5）。warm 下两者凑巧都是 `#FFFFFF`，shadcn 下必须分别给值（selected `#F3F3F3`、floating `#FFFFFF`），否则 `bg-elevated` 容器里的激活态会消失。

**关键 2：三个 sidebar token 是 per-theme 可选项**。"留白派"主题让它们全部 `var(--bg-primary)`，左侧 chrome 一片同色。"梯度派"主题让它们沿一条 oklab 色线递减——见 §9。**新主题里这三个 token 必须给值**（哪怕都退化到 `var(--bg-primary)`），否则切换主题时 NavRail / sidebar 会瞬变成透明黑。

**关键 3：默认主题同时挂在 `:root` 上，新增 token 不能依赖 fallback。** 只要组件开始读取新的 CSS var，其它主题也必须显式定义同名 token；否则会继承默认主题值，出现"切主题后还用旧主题的 1px row border / 不该出现的 NavRail icon 色"这类泄漏。

### 3.1.1 App frame / panel card 几何

| Token | 用途 | 选值原则 |
|---|---|---|
| `--frame-padding` | App frame 左右/底部 padding，也是 panel 之间的视觉 gap | 当前标准 `8px`；titlebar 下方 top padding 在组件层固定为 0 |
| `--card-radius` | NavRail / sidebar / chat panel 圆角 | 当前标准 `8px`；旧直角主题也要显式写值 |
| `--card-shadow` | panel card 阴影 | 轻阴影即可，避免卡片变成浮层 |
| `--splitter-bg` | resize splitter 的静态底色 | card frame 中通常 `transparent`，由 gap 表达分隔 |
| `--splitter-offset` | 抵消 splitter 作为 flex item 产生的额外列间距 | 当前 `calc((var(--frame-padding) + 4px) / -2)`，让视觉 gap 仍等于 `--frame-padding` |
| `--titlebar-border` | titlebar 下边线 | card frame 主题通常 `transparent`，避免 titlebar 和 body 断层 |

### 3.1.2 Brand / NavRail / row state

| Token | 用途 | 选值原则 |
|---|---|---|
| `--brand-primary` | 主题身份色源头 | NavRail、row selected/hover、badge 等需要"品牌身份"的地方从这里派生 |
| `--text-on-brand` | `--brand-primary` 背景上的文字 / icon | 与 brand 成对维护对比度 |
| `--text-nav-rail` | NavRail 默认 icon 色 | 深色 nav 用浅字，浅色 nav 用深字；必须显式定义，避免继承默认主题 |
| `--text-nav-rail-hover` | NavRail hover icon 色 | 通常比默认更实 |
| `--bg-nav-rail-hover` | NavRail icon hover 底色 | 与 NavRail 底色、icon 色一起按主题成组定义 |
| `--bg-task-tag` | Message header 后的 task tag 底色 | 主题化的高显著 chip，通常从 `--brand-primary` 派生，不要复用 warning |
| `--text-on-task-tag` | task tag 上的文字 / icon | 与 `--bg-task-tag` 成对维护对比度 |
| `--border-task-tag` | task tag 描边 | 与 task tag 底色同族，提供边缘清晰度 |
| `--sidebar-row-border-width` | Workspace / Channel / Search / Saved row 描边宽度 | 默认视觉标准 `2px`；selected 是淡墨晕的主题可降到 `1px` |

### 3.1.3 Forza6-introduced tokens (loud-festival theme family)

新增于 forza6（festival-racing 主题）。**每个主题都必须显式定义这 8 个 token**——单 accent / 无纹理 / 无黑结构的主题可以全部退化成现有 sibling（见
appearance.test.ts 锁定）。这是 §3.1 关键 3 的硬约束：不显式定义就会从 `:root` 默认主题（warm-script）漏过来，切到 forza6 再切回会出现"留下来的 forza6 三角纹理 / lime accent-2 / 黑结构条"等泄漏 bug。

| Token | 用途 | 退化规则（warm/single-accent 主题） |
|---|---|---|
| `--font-display` | 重压窄体大写字体栈（chrome 标题、segment、status pill）| `var(--font-sans)` |
| `--bg-pattern-image` | 持续在场的几何身份纹理（forza6 的三角 SVG data URL）| `none` |
| `--bg-pattern-opacity` | 纹理强度 | `0` |
| `--accent-2` | 第二 accent（forza6 用电青；info / 链接 / 3 档信息）| `var(--accent)` |
| `--text-on-accent-2` | `--accent-2` 上的文字 | `var(--text-on-accent)` |
| `--bg-structure-dark` | 黑色结构层（segment 容器 / member-strip / now-playing / titlebar tint / tool-card header / popover header / workspace-tile）| `var(--text-primary)`（浅色主题用 text-primary 当近黑）|
| `--text-on-structure` | `--bg-structure-dark` 上的文字 | `var(--bg-base)` |
| `--text-on-dark-pop` | 深底/黑结构上的荧光数字 metadata（currency / level / counter）| `var(--accent)`（浅色主题没有"深底荧光黄"，退化到 accent）|

**`--bg-structure-dark` / `--text-on-dark-pop` 使用边界**（review-locked，
不要泄漏成普通装饰色）：
- `--bg-structure-dark` 仅承担**结构层**——容器、tab/segment 当前段、进度槽、卡片 header、titlebar tint、workspace-tile、NavRail dock notch。**禁止**做"任意按钮黑底"或"chat 主区分隔条"。
- `--text-on-dark-pop` 仅在**深色 chrome 或黑结构**上用——currency / 等级 / 短 metadata 数字。**禁止**进入 `--bg-chat` 浅白读区，否则破坏阅读层级。

### 3.2 文字

| Token | 用途 |
|---|---|
| `--text-primary` | 正文 |
| `--text-secondary` | 副标题、metadata |
| `--text-muted` | 三级文字、占位 |
| `--text-inverse` | 反色文字（少用） |
| `--text-island` | 岛屿（代码块）内的文字 |
| `--text-inline-code` | 行内 `code` 字色 —— **每个主题独立选**，见主文档 §7 选色三原则 |

### 3.2.1 Inline-code chip（PR-3 token promotion）

`.markdown-body :not(pre) > code` 渲染时读取下表 4 token，全部 per-theme
强制定义；不允许漏一个回退到 `:root`，否则会出现 forza6 → 暖系切换后
仍残留 lime + 黑边的泄漏。`--text-inline-code` 已在 §3.2，新增 3 个：

| Token | 用途 | 取值原则 |
|---|---|---|
| `--bg-inline-code` | chip 背景 | 暖系常用 `color-mix(text-primary 14%, bg-base)` 软底；海报系用饱和填充色 |
| `--border-inline-code` | chip 边框 shorthand（含 width + style + color） | 软底主题给 `none`；海报系给可见 near-black 描边（forza6 当前 `1px solid <near-black>`） |
| `--radius-inline-code` | chip 圆角 | 软底主题给 `var(--radius-sm)`；海报系给 `0` 方角 |

### 3.2.2 Task status badge（PR-3 token promotion）

任务状态徽标在 5 个渲染点出现（`WorkspaceTasksDrawer` / `TasksSection`
看板卡 / `TaskRef` 内联 chip / `SystemMessage` task-event pill /
`TaskStatusPill` popover 选择器），全部经 `[data-task-status='<status>']`
钩子从同一 15-token 契约取色（5 status × {bg/text/border}，含终态
`closed`，见 §3.2.2.1）。每个主题 MUST 全部 15 个都显式定义；
不允许漏一个回退到 `:root`，否则 forza6 的饱和青/品红会泄漏到暖系。

命名用 domain-prefix `--task-status-*` 而非通用 `--status-*`：这些值
专门为 ~10px 海报-display 徽标调过，不是一般性"状态色"词汇，
narrow namespace 防止被复用到不合适的尺寸。

| Token | 用途 |
|---|---|
| `--task-status-todo-bg` / `-text` / `-border` | "todo" 徽标背景 / 字 / 边框 shorthand |
| `--task-status-in-progress-bg` / `-text` / `-border` | "in progress" — **active/HUD-live 语义**，配 warning 一路（cyan / amber / lime live indicator） |
| `--task-status-in-review-bg` / `-text` / `-border` | "in review" — **awaiting human attention 语义**，配 accent/brand 一路（loud beacon） |
| `--task-status-done-bg` / `-text` / `-border` | "done" 徽标背景 / 字 / 边框 shorthand |

边框使用 shorthand（含 width + style + color）。**forza6 v5.8（#task:778）：
5 个 status 统一成同一套海报形态——实心饱和/中性填充 + `border: none` +
0 圆角**；旧的 todo（透明+黑环）/ done（半透明+黑环）描边形态已废弃，因为
它们在实心 tile 旁边读起来像另一种 chip。各 status 保留语义 hue：todo 中性
灰青、in_progress cyan、in_review 品牌品红、done 实心深绿、closed 靛蓝，
ink 全部过 AA。暖软底主题仍走 `none` 边框 + 软底。

**语义提醒**：`in_progress` = active / 正在跑 → warning/HUD-live；
`in_review` = 等待人类介入 → accent/loud-beacon。如果你直觉相反，
请回看 forza6 的 `#22B7E0` cyan(in_progress) vs `var(--brand-primary)`
magenta(in_review)：cyan 是 dashboard-live，magenta 是 attention-grabbing
beacon，跟语义同向。

#### 3.2.2.1 Closed-status chip（#task:770 closed-as-status cutover）

`closed` 是**第五个终态 status**（不再是跟 `task_status` 正交的 archived 可见性维度）。
后端把 `messages.task_archived_at` 重命名为 `task_closed_at`（仅作排序/审计 metadata），
复用 `POST /api/tasks/:id/status` 做 any→any 转移（含进入/退出 closed 做 reopen），
agent 与 human 都可处理；旧的 `POST /api/tasks/:id/archive` 端点、`TaskArchiveFilter`
可见性查询参数、独立 `Archived` chip 全部移除。closed 卡片落在 kanban 第五列（Done 之后），
status badge 直接显示 `closed`（不再额外叠 chip）。chip 通过 `data-task-status='closed'`
钩子从 3-token 契约取色，命名对齐 `--task-status-*-{bg,text,border}`，与其它四个 status
同属一套 task-badge 词汇。每个主题 MUST 三个都显式定义，不允许漏一个回退 `:root`
（否则 forza6 的 indigo 会泄漏到暖系）。

| Token | 用途 | 取值原则 |
|---|---|---|
| `--task-status-closed-bg` | closed chip 背景 | 暖软底给 `transparent` 低噪；海报系给饱和填充（forza6 复用 `--forza6-indigo-slab`） |
| `--task-status-closed-text` | chip 字色 | 暖系 `var(--text-muted)`；海报系填充上给高对比（forza6 `#FFFFFF`，~8:1） |
| `--task-status-closed-border` | chip 边框 | 暖系 `1px solid var(--border-subtle)` hairline；海报系 `1.5px solid var(--forza6-indigo-slab)` 同 bg 做无缝实心块 |

**消费边界**（Cindy review）：这组 token **只**被 task status chip（closed 态）消费，
不外扩到 channel archived badge 或其它 surface —— 避免语义跨域复用导致 token 含义漂移。

### 3.2.3 Primary control surface（PR-10 token promotion）

`Button` `default` variant —— 所有 dialog 的 Create / Save 提交按钮、
SettingsPage 的 profile/general save、RegistrationGate 的注册主按钮等
**主 CTA** —— 通过一个 3-token 契约取 bg / hover bg / text，跟 `--accent`
foreground 语义解耦。

| Token | 用途 | 取值原则 |
|---|---|---|
| `--bg-control-primary` | 主 CTA 背景 | 暖系退化到 `var(--accent)`（pixel-zero）；海报系用 `var(--brand-primary)` (#FF2C7A) —— 不能跟着 forza6 `--accent` 被压成 deep magenta，CTA 背景太暗 |
| `--bg-control-primary-hover` | hover bg | 暖系 `var(--accent-hover)`；海报系 `color-mix(in oklab, var(--brand-primary) 88%, #000000)` 把热粉往黑里走 12% |
| `--text-on-control-primary` | 配 bg 的字色 | 暖系 `var(--text-on-accent)`；海报系 `var(--text-on-brand)` (近黑 #0A0A0A on #FF2C7A ≈ 5.56:1 AA) |

**为什么独立 token 不直接 `--bg-accent` / `--text-on-accent`** —— 在
forza6 里 `--accent` 必须同时承担"浅底可读 foreground"（text-accent、
agent name 等）和"loud CTA 表面"，两个角色对色彩的需求冲突：foreground
要深 (≥4.5:1 on cool-white)，CTA 要亮 (品牌识别)。把它们拆成不同 token
是唯一的解。warm-script 没这个冲突（暖系 accent 本身就是近黑既当字又当
bg），所以三个 token 都退化到 accent 家族，pixel-zero 不变。shiki
`Ao2TTCQ6Q2r5OG-a` 直接报"forza6 create dialog button 粉色太暗"。

**故意不动**：装饰性 `bg-accent` 表面（NavRail selected、SettingsPage
theme swatch selected、Titlebar notification badge、ChannelView FAB
等）继续用 `--accent`。它们是 selected/indicator 语义，跟 CTA 不一类，
不应该跟着主 CTA 改色 —— 那会让 forza6 整个"被选中"的色调跟"主操作"
混淆。

### 3.3 Accent + on-color 配对

| Token | 用途 |
|---|---|
| `--accent` | 品牌强调色（CTA、active 节点、链接边线、单一聚焦信号） |
| `--accent-soft` | 5–10% 透明度的 accent，用于 hover 玻璃感、selection |
| `--accent-hover` | accent 的深一档变体 |
| `--accent-glow` | resize handle / focus ring 的扩散色 |
| `--text-on-accent` | 配 `--accent` 背景的字色 |
| `--text-on-success` / `--text-on-warning` / `--text-on-error` | 配语义背景的字色 |
| `--text-on-selected` | 配 `--bg-selected` 的字色 —— 必须与 selected 成对出现 |

### 3.4 语义色

| Token | 用途 |
|---|---|
| `--success` / `--success-soft` | 成功 |
| `--warning` / `--warning-soft` | 警告 |
| `--error` / `--error-soft` | 错误 |

`*-soft` 是 10–15% 透明度的版本，用于状态卡的休眠底色。**饱和度上限**与覆盖范围见主文档 §12，主题切换不放宽这两个上限。

### 3.5 边界

| Token | 用途 |
|---|---|
| `--border` | 通用 1px 描边（warm 几乎不用，shadcn 是定义性特征） |
| `--border-subtle` | 极淡分隔 |
| `--border-island` | 岛屿描边 |
| `--border-focus` | focus ring |

### 3.5.1 Row-state border color（PR-5 token promotion）

Sidebar 行（`.sidebar-row-border` 类，命中 ChannelsSidebar /
WorkspacesPanel / Sidebar / sidebar-shared —— 全部嵌在
`aside[data-sidebar="..."]` 包裹内）和 NavRail 按钮
（`nav[aria-label='App sections'] button`）的 hover / selected 边框
颜色，共用一套 2-token 契约。每个主题 MUST 全部 2 个都显式定义；
不允许漏一个回退到 `:root`，否则 forza6 的近黑会泄漏到暖系。

| Token | 用途 | 取值原则 |
|---|---|---|
| `--border-row-hover` | 行 hover 时的边框色 | 暖系常用 `var(--accent)`；海报系用 `<near-black>` |
| `--border-row-selected` | 行 selected 时的边框色 | 同上；通常与 hover 同色，让 hover 成为 selected 的"几何 preview" |

宽度仍走 `.sidebar-row-border { border-width: var(--sidebar-row-border-width, 2px) }`，
没有 per-theme 差异，所以不进契约。

**为什么必须有 `aside[data-sidebar]` 祖先**：`ArchivedChannelsPanel`
也复用 `.sidebar-row-border` 类做归档列表，但它在主内容区（无
`aside[data-sidebar]` 包裹），且 hover 用 `border-accent bg-bg-hover`
另一套词汇。如果 global 选择器不带这个祖先，会把归档行也拉进契约，
forza6 下会把 accent hover 翻成近黑。Cindy `N6tR2FJpzpebGJdb` 抓到。
未来如果有第三个 row 表面想接同契约，请给它显式 hook 并补到这一节。

**为什么两个 token 而非 shorthand？** Hover 和 selected 经常同色但
背景不同（forza6 = pale-lime vs lime fill；warm = transparent vs
bg-selected），分开 token 让"色一致而背景递进"的语义显式：边框承担
geometry，背景承担 emphasis 梯度。

### 3.6 阴影 + 浮层 base

| Token | 用途 |
|---|---|
| `--overlay-backdrop` | modal 后面的遮罩 |
| `--shadow-base` | RGB 三元组（如 `31, 27, 22`），其它 shadow 通过 `rgba(var(--shadow-base), 0.x)` 引用，方便整套阴影暖/冷统一 |
| `--shadow-popover` | 浮层双层软阴影（参考主文档 §15 规格） |
| `--shadow-modal` | modal 单层大扩散 |
| `--shadow-button` | 按钮阴影（可选） |

### 3.6.1 Floating frame（PR-4 token promotion）

Menu / popover / hover-card 共用一套外框契约。两组消费面，命中规则
都在 `global.css`：

- `[data-radix-menu-content]` —— Radix DropdownMenu + ContextMenu 内部
  共用属性
- `[data-popover-frame='info']` —— 我们自定义的中性结构 hook，挂在
  AgentInfoPopover / HumanInfoPopover / ManageMembersPopover /
  HoverPopover 的 `Content`

每个主题 MUST 全部 3 个都显式定义；不允许漏一个回退到 `:root`，否则
forza6 的 2px 黑边 + 零圆角海报感会泄漏到暖系。

| Token | 用途 | 取值原则 |
|---|---|---|
| `--floating-border` | 外框边框 shorthand（width + style + color） | 暖系常用 `1px solid var(--border)`；海报系用 `2px solid <near-black>` |
| `--floating-radius` | 外框圆角 | 暖系 `var(--radius-md)`；海报系 `0` 方角 |
| `--floating-item-radius` | 菜单内项的圆角（外方内圆会读成"歪贴纸"） | 暖系 `var(--radius-sm)`；海报系 `0`，跟外框对齐 |

**没有 `--floating-border-width`** —— Cindy `GZJAggfU2U8kcIV0` 决策：
shorthand 已含 width，当前没有任何 inset/offset 布局算需要单独取 width。
等真有第二消费点再补，先 YAGNI。

**没有 `--floating-item-hover-bg`** —— hover 色已经通过
`[data-radix-popper-content-wrapper] { --bg-hover: ... }` 的 scoped
lazy substitution 工作得很好（forza6 在浮层 wrapper 内重定义 `--bg-hover`
为 lime，所有 `data-[highlighted]:bg-bg-hover` Tailwind 工具类自动跟上），
不需要新 token。等出现"浮层 hover ≠ 普通 hover"的第二个主题，再升级。

**Tooltip / Select listbox 故意不入**：它们是小气泡，给海报感重框会
过载视觉。forza6 v5.7.1 的边界判断在 PR-4 后保留。

### 3.6.2 Select listbox radius（PR-9 token promotion）

Radix `Select.Content` 和 `Select.Item` 共用一对 radius token，由
`global.css` 里 `[role='listbox']` / `[role='listbox'] [role='option']`
全局选择器消费。所有 SelectContent / SelectItem 调用点
（SearchPanel / ArchivedChannelsPanel / AgentPicker / ManageMembersPopover /
EventsApp / AgentProfileCard / TaskStatusPill 的 popover items 等）的
TSX **不动**，由 global 选择器扫，跟 floating frame 同样的
"source order + 等 specificity 胜出"机制。

**为什么用 `[role='listbox']` 而不是 `[data-radix-select-content]`** ——
Radix Select 实际不暴露 `data-radix-select-content`（首版 PR-9 试了 ——
shiki `aLkR1sZ-HzyLB3fO` 报 wrapper 和 item hover 仍然圆角，验证
`@radix-ui/react-select@2.2.6` 源码确认只有 `data-radix-select-viewport`
存在于内部 viewport，不在 Content 根上）。ARIA `role="listbox"` 是
Radix 在 Select.Content 上实际设置的属性，也是 W3C 标准词汇。同时
Composer mention 自定义下拉 (`Composer.tsx:760`) 也用 `role="listbox"`，
selector 顺便把它也覆盖了 —— 形态一致，海报系都要直角。

| Token | 用途 | 取值原则 |
|---|---|---|
| `--select-content-radius` | Select listbox 外框圆角 | 暖系 `6px` 字面值（= 之前 Tailwind `rounded-md`，pixel-zero）；海报系 `0` |
| `--select-item-radius` | Select item 圆角 | 暖系 `4px`（**不是 pixel-zero**：旧 Tailwind `rounded-sm` = 2px 在 6px content 里看起来不同心，shiki `a76QCh7CRAqVSO_N` 报 → Cindy `LFN_zqTcxswPiVgM` 建议 4px 折中：callsites 一半有 `p-1` 一半没有，4px 在两种场景下都是 ~2px 偏差，比 2px item 时的 4px 偏差更协调）；海报系 `0` |

**这不是 PR-4 floating frame 边界的反悔** —— PR-4 把 Select listbox 排
除在 floating frame 之外的理由是**边框**（给小气泡套 2px poster 黑框会
over-shout 周边 UI）。PR-9 只动 radius，不动 border：Select listbox 仍
继续走 Tailwind `border border-border`（PR-8 已让 `--border` 在 forza6
下可见），不接 `--floating-border`。"小气泡不接重框"边界原封不动。

**字面值（content 6px / item 4px）而非 `var(--radius-md)` / `var(--radius-sm)`** ——
content 6px 跟 control / chip 同一逻辑保持 pixel-zero。item 4px 是
**视觉同心折中**（详见上表注脚）；不复用命名 radius 是因为 warm 的
`--radius-sm: 6px` / `--radius-md: 10px` 都不等于此处需要的 4px。

**为什么不复用 `--control-radius`** —— select trigger（= control）和
select listbox 在概念上是配对的（一个打开另一个），radius 一致很合理。
但 control = 6px、listbox item = 2px、listbox container = 6px 是三个值
而 control 只是一个，复用会丢 item 维度。独立 2 token 更稳。

### 3.6.3 `data-dropdown-frame` —— 下拉框海报边框（#task:782）

§3.6.2 把 Select listbox 排除在 floating frame 的 **border** 之外（理由
是"小气泡不套 2px 黑框"）。但 shiki 复核 forza6 时认为 task filter /
message search / archived channels 这几处**功能性下拉框**在海报主题下
缺了硬边、跟周边 2px 黑框语言不一致——它们不是 tooltip 那种瞬时小气泡，
而是停留型选择面板，应当吃海报边框。

为避免一刀切回退 §3.6.2 的边界（`[role='listbox']` 一挂边框会误伤
Composer mention 这类内联下拉、且 channel filter 是 combobox：`role=listbox`
落在**内层子列表**而非 Content 根，挂上去会双重边框），改用**显式 opt-in
属性** `data-dropdown-frame`：只有手动标了这个属性的 `Content` 根才吃框。

```css
/* global.css —— 复用 --floating-border，不新增 token */
[data-dropdown-frame] { border: var(--floating-border); }
```

| 维度 | 取值 |
|---|---|
| 命中 | 仅显式带 `data-dropdown-frame` 的浮层根（Radix `Select.Content` / `Popover.Content`） |
| 边框 | 复用 `--floating-border`（暖系 `1px solid var(--border)`，海报系 `2px solid <near-black>`）|
| 不动 radius | radius 仍由各自既有契约管（Select 走 §3.6.2 的 `--select-*-radius`，filter popover 走自身 `--select-content-radius`）|

当前消费点：`TaskFilterBar`（channel/assignee/creator 三个 Content）、
`SearchPanel`（3 个 Select.Content + trigger 边框走 `--control-border-width`）、
`ArchivedChannelsPanel`（2 个 Select.Content + 同样 trigger）、`Composer`
mention picker。**边界**：Tooltip / 非 listbox 的瞬时 popover **不**加这个
属性（Cindy `别把 Tooltip/非 listbox popover 误纳进 2px Select 语义`）——
§3.6.2 "小气泡不接重框"对它们仍然成立，这里只升级"停留型功能下拉"。

### 3.7 几何 + 排版 + 节奏

| Token | 用途 |
|---|---|
| `--radius-sm` / `--radius-md` / `--radius-lg` / `--radius-xl` | 圆角等级 |
| `--font-sans` | UI chrome 字体栈 |
| `--font-serif` | 正文/prose 字体栈（极简主题可让 serif = sans，整体放弃文学感） |
| `--font-mono` | 等宽字体栈 |
| `--ease` | 通用缓动函数 |
| `--duration` | 通用过渡时长 |
| `--chat-font-size` | 对话区默认字号（用户可在 Settings 覆盖） |

### 3.7.1 Chrome label utility（PR-6 token promotion）

`.chrome-label` 工具类（定义在 `global.css`）给所有"chrome 小标签"
—— uppercase + 紧 tracking + 可选 display 字体 —— 一个统一出口。
典型消费者：分组 header（NavRail "Tasks" / Sidebar "CHANNELS"）、
表格表头、Select.Label、settings tab 大写小标题、各种 badge 文本。

3 token 全部 per-theme 强制定义；漏一个回退 `:root` 会让 forza6 的
display 字体 + 0.06em tracking 泄漏到暖系：

| Token | 用途 | 取值原则 |
|---|---|---|
| `--font-chrome-label` | label 字体栈 | 暖系常用 `var(--font-sans)`（暖系无独立 display 字体栈）；海报系用 `var(--font-display)` |
| `--chrome-label-tracking` | letter-spacing | 暖系 `0.05em`（≈ Tailwind `tracking-wider`）；海报系 `0.06em`（与其它海报 caps 元素一致） |
| `--chrome-label-transform` | text-transform | 通常都 `uppercase`；小写主题可设 `none` |

**有意为之的窄契约**：size / weight / color 都留在调用点（call-site
Tailwind utility），不进 token。每个 label 的 size 由它在 chrome 中
的"重量"决定（10px badge vs 13px section header），强行统一会丢
per-callsite 的设计自由度。Utility 只负责把"什么字 + 多开 tracking
+ 是否大写"这一组**per-theme** 的决策抽出来。

**与现有 callsite 的关系**：~30+ TSX 调用点目前还在用裸 Tailwind
（`uppercase tracking-wider`）。PR-6 只建立 utility + 契约，不做迁移
扫，避免一次性改面过大、产生不必要的视觉对比噪音。后续按 callsite
分类（badges / table headers / group titles / Select.Label）开独立
sweep PR；每个 sweep 完成后，forza6-components.css 里对应的
`font-family: var(--font-display)` 直接覆写就能删一行。

### 3.7.2 Control radius（PR-8 token promotion）

`--control-radius` 给所有 **control surface** —— input / textarea /
button / select trigger / 小 icon button —— 一个统一圆角出口。

| Token | 用途 | 取值原则 |
|---|---|---|
| `--control-radius` | control 表面圆角 | 暖系 `6px` 字面值（= 之前 Tailwind `rounded-md` 像素值，pixel-zero；**故意不 reuse `var(--radius-sm)`** —— warm 当前两者 6px 等值是巧合，control 语义对齐的是 md 档，借 sm 会让后续调整 `--radius-sm` 时意外把 control 圆角带小，Cindy `1eG7CReuc5X9ER_9`）；海报系用 `0` 强化"hard-cut block"语汇 |

**消费点（PR-8 已迁完）**：
- `components/ui/input.tsx` Input + Textarea
- `components/ui/button.tsx` buttonVariants 基础
- 5 处内联 select trigger string：SearchPanel / ArchivedChannelsPanel
  (含 Restore 小按钮) / AgentPicker / ManageMembersPopover / EventsApp
- DeleteAgentDialog 的 confirm input
- EventsApp pin toggle 小 icon button

**追加消费点（PR-11 #task:368）**：form/settings 内的 **control-adjacent
action-callout box** —— 表单内嵌一组 label + Button 的操作提示容器：
- `WorkspaceSettingsDialog` 的 archive box + delete box

边界**故意收窄**（Cindy `nOEqbfmR71tNnKrj` / `NFTFg47A8h0LihSe`）：
只包含**直接包按钮或 input** 的 form/settings 操作 callout。**不**把
一般 error 提示 / empty-state / notification banner / 非表单 callout
卷进来——`AgentSchedulesCard` 的查询失败提示曾经误纳，review 时回滚，
那是 notification empty-state，不是 control-adjacent action callout。
泛化会让 `--control-radius` 边界失控。

**故意不入** `--control-radius`：
- SelectContent / popover / dialog / menu 等浮层表面 → 走 `--floating-radius`
- card 表面（包括 SearchPanel 的 result card、DialogContent 主框）→ 走 `--card-radius`
- chip → 走 `--chip-radius`（§3.7.3）
- pill 胶囊（TaskStatusPill）→ shiki 决定先保留胶囊，pill-radius 不入
- 一般 empty-state / notification banner / 非表单 callout → 暂留 Tailwind
  `rounded-md` 字面值，等真出现需要直角的语义再单独抽 token

### 3.7.3 Chip radius（PR-8 token promotion）

`--chip-radius` 给所有 **inline reference / mention / filter / 小 data
chip** —— TaskRef / ConversationRef / ChannelRef / Mention / TaskStatusBadge /
ConversationRef kind chip —— 一个统一圆角出口。

| Token | 用途 | 取值原则 |
|---|---|---|
| `--chip-radius` | chip 表面圆角 | 暖系 `4px` 字面值（= 之前 Tailwind `rounded` 默认值，pixel-zero；同 control 一样不 reuse 命名 radius 防止意外 coupling）；海报系 `0` 跟 control 同节拍 |

**消费点（PR-8 已迁完）**：TaskRef.tsx 全部 4 处 chip 状态 + 内嵌
TaskStatusBadge；ConversationRef.tsx inert + interactive + kind chip；
ChannelRef.tsx inert + interactive；Mention.tsx agent + human mention；
TasksSection + WorkspaceTasksDrawer 的 TaskStatusBadge（与 TaskRef
内嵌版本同形态）。

**追加消费点（PR-12，#task:370）**：**member selection chip / tile** 这
一类——AgentPicker `SelectedChip`（新建 channel 已选成员 tag，
`text-xs px-2 py-0.5` 形态，跟 ConversationRef chip 同节拍）和
ManageMembersPopover 成员 tile（titlebar 添加成员 popover 里的单行
member 行，avatar + @name + runtime + 移除 icon）。member tile 内部
的 remove icon button 也随 tile 走 `--chip-radius`——否则 hover 背景
在 forza6 下会冒出 4px 圆角小底，跟方角 tile 不齐。**仅限 "member
selection chip / tile" 这一窄类**，不可推广为"列表行 / card 通用圆
角"。如果将来出现更宽的 list row 需要直角，单独开 token，不要复用
`--chip-radius` 把列表全部扫进来。

**与 `--control-radius` 的边界**：
- chip = inline 文本旁边的小标签，没有交互手感（即使可点也是 "点开
  popover" 级别），形状是 `<span>`-shaped 短长方
- control = 有清晰交互手感的表面（input / button / select），形状是
  矩形按钮 / 输入框
- 两个 token 分开的核心是 warm-script 里它们的圆角值不同（4px vs 6px）

**没引入 `--pill-radius`** —— TaskStatusPill 是当前唯一胶囊消费者，
shiki 决定先保留胶囊（forza6 用饱和填色表达状态语义，不需要靠形状）。
后面如果第二个 pill 消费者出现再单独开 `--pill-radius`。

---

## 4. 选 token 值的核心约束

不要逐 token 凭手感拍脑袋。先定主题的"性格"，再让 token 服从这个性格。

### 4.1 三个基线决策

1. **温度**：暖（warm-literary：所有色统一暖色温）/ 冷（hypothetical nordic：统一冷蓝灰）/ 中性（shadcn：灰阶单色）。所有 bg、text、shadow 必须沿同一温度方向漂移，**不允许混温**。
2. **accent 的"音量"**：饱和（warm 的 `#B5651D`）/ 近黑（shadcn 的 `#171717`）/ 高亮（hypothetical 的电光绿）。这决定 accent-soft、accent-glow、border-focus 一整串派生值的强度。
3. **边界策略**：留白派（warm：几乎不画 border，靠色温过渡）/ 描边派（shadcn：1px hairline 是定义性特征）。决定 `--border` 是不可见还是可见。

定下这三条，下面所有 token 就有方向。

### 4.2 必须遵守的硬约束（来自主文档）

- `--bg-base` 不能是用户感觉刺眼的纯色（warm 禁纯白，但 shadcn 的纯白属于风格选择）
- `--text-primary` 在 `--bg-base` 上对比度 ≥ 7:1（AAA 正文）；`--text-muted` 至少 4.5:1
- `--accent` 在 `--bg-base` 上对比度 ≥ 4.5:1（AA），在 `--text-on-accent` 上对比度 ≥ 4.5:1
- `--bg-selected` 与所属容器（通常 `--bg-primary`）亮度差 ≥ 5%（`shadcn` 取 `#F3F3F3` vs `#FAFAFA` 大约 3% 已经是边缘，不能再淡）
- `--bg-floating` 与下方所有非 floating 层都能看出层级（最亮一档）
- 整套阴影都用 `rgba(var(--shadow-base), …)`，不直接 `rgba(0,0,0,…)` —— 暖底主题里黑阴影会显青

### 4.3 容器 → 激活态配对（最常踩的坑）

| 容器 token | 激活态用什么 |
|---|---|
| `bg-bg-primary` / `bg-bg-base` | `bg-bg-selected` |
| `bg-bg-elevated` | `bg-bg-floating`（**不是** selected，否则 shadcn 主题下激活态消失）|
| `bg-bg-active` 系列 | `bg-bg-selected` |
| 浮层、popover、modal | `bg-bg-floating` |

写组件时如果不确定容器是哪一档，往父级翻一两层确认。`text-on-selected` 必须和 `bg-bg-selected` 成对，新代码里 `bg-bg-selected text-text-primary` 是历史写法，应改为 `bg-bg-selected text-text-on-selected`。

---

## 5. 写主题文件的骨架（粘贴用）

```css
/* ================================================================
   Theme: <Your Theme Name>
   <一句话描述这套主题的性格 —— 温度 / accent 音量 / 边界策略>
   ================================================================ */

[data-theme='your-theme'] {
  /* ── Backgrounds ── */
  --bg-base: ...;
  --bg-primary: ...;
  --bg-elevated: ...;
  --bg-surface: ...;
  --bg-hover: ...;
  --bg-active: ...;
  --bg-selected: ...;       /* 导航激活：从 bg-primary 跳出 */
  --bg-floating: ...;       /* 浮层 / 卡片表面：通常最亮 */
  --bg-chat: ...;           /* Chat 主读区：按阅读舒适度独立于 bg-base 取值 */

  /* ── Card frame ── */
  --bg-app: ...;
  --frame-padding: 8px;
  --card-radius: 8px;
  --card-shadow: ...;
  --splitter-bg: transparent;
  --splitter-offset: calc((var(--frame-padding) + 4px) / -2);
  --titlebar-border: transparent;

  /* ── Brand / NavRail / sidebar row state ── */
  --brand-primary: ...;
  --text-on-brand: ...;
  --text-nav-rail: ...;
  --text-nav-rail-hover: ...;
  --bg-nav-rail-hover: ...;
  --bg-task-tag: ...;
  --text-on-task-tag: ...;
  --border-task-tag: ...;
  --sidebar-row-border-width: 2px;
  --bg-row-selected: ...;
  --bg-row-hover: ...;
  --bg-nav-rail: var(--brand-primary);
  --bg-channels-sidebar: ...;
  --bg-sessions-sidebar: ...;

  /* ── Islands ── */
  --bg-island: ...;
  --bg-island-deep: ...;

  /* ── Text ── */
  --text-primary: ...;
  --text-secondary: ...;
  --text-muted: ...;
  --text-inverse: ...;
  --text-island: ...;
  --text-inline-code: ...;  /* 与 accent 区分、与 text-primary 有色相差 */

  /* ── Inline-code chip (§3.2.1) ── */
  --bg-inline-code: ...;        /* 软底主题常用 color-mix(text-primary X%, bg-base) */
  --border-inline-code: ...;    /* shorthand：软底主题给 `none`，海报系给可见 near-black 描边 */
  --radius-inline-code: ...;    /* 软底主题给 var(--radius-sm)，海报系给 `0` */

  /* ── Task status badge (§3.2.2 / §3.2.2.1) ── 5 状态 × {bg / text / border}；closed 是终态 status */
  --task-status-todo-bg: ...;          --task-status-todo-text: ...;          --task-status-todo-border: ...;
  --task-status-in-progress-bg: ...;   --task-status-in-progress-text: ...;   --task-status-in-progress-border: ...;
  --task-status-in-review-bg: ...;     --task-status-in-review-text: ...;     --task-status-in-review-border: ...;
  --task-status-done-bg: ...;          --task-status-done-text: ...;          --task-status-done-border: ...;
  --task-status-closed-bg: ...;        --task-status-closed-text: ...;        --task-status-closed-border: ...;
  /* closed: 暖系 transparent / var(--text-muted) / 1px subtle；海报系 var(--forza6-indigo-slab) / #FFFFFF / 1.5px solid slab */

  /* ── Floating frame (§3.6.1) ── menu / popover / hover-card 共用 */
  --floating-border: ...;        /* shorthand：暖系 `1px solid var(--border)`，海报系 `2px solid <near-black>` */
  --floating-radius: ...;        /* 暖系 var(--radius-md)，海报系 0 */
  --floating-item-radius: ...;   /* 跟外框对齐：暖系 var(--radius-sm)，海报系 0 */

  /* ── Accent ── */
  --accent: ...;
  --accent-soft: ...;       /* ~6-10% alpha 的 accent */
  --accent-hover: ...;      /* accent 深一档 */
  --accent-glow: ...;       /* ~10-20% alpha 的 accent */

  /* ── Semantic ── */
  --success: ...;       --success-soft: ...;
  --warning: ...;       --warning-soft: ...;
  --error: ...;         --error-soft: ...;

  /* ── Borders ── */
  --border: ...;
  --border-subtle: ...;
  --border-island: ...;
  --border-focus: ...;

  /* ── Row-state border color (§3.5.1) ── sidebar / NavRail hover + selected */
  --border-row-hover: ...;       /* 暖系 var(--accent)，海报系 <near-black> */
  --border-row-selected: ...;    /* 通常同 hover；让 hover 成为 selected geometry preview */

  /* ── On-color foregrounds ── */
  --text-on-accent: ...;
  --text-on-success: ...;
  --text-on-warning: ...;
  --text-on-error: ...;
  --text-on-selected: var(--text-primary);   /* 通常成立，selected 是浅色时 */

  /* ── Overlay ── */
  --overlay-backdrop: rgba(0, 0, 0, 0.x);

  /* ── Shadows ── */
  --shadow-base: r, g, b;   /* RGB 三元组，对齐主题温度 */
  --shadow-popover: 0 8px 24px -10px rgba(var(--shadow-base), 0.20),
                    0 2px  6px  -2px rgba(var(--shadow-base), 0.08);
  --shadow-modal:   0 25px 50px -12px rgba(var(--shadow-base), 0.25);
  --shadow-button:  0 1px 2px 0 rgba(var(--shadow-base), 0.05),
                    0 0 0 1px rgba(var(--shadow-base), 0.10);

  /* ── Radii ── */
  --radius-sm: ...;
  --radius-md: ...;
  --radius-lg: ...;
  --radius-xl: ...;

  /* ── Fonts ── */
  --font-sans: ...;
  --font-serif: ...;        /* 极简主题可设为 var(--font-sans) */
  --font-mono: ...;

  /* ── Chrome label utility (§3.7.1) ── `.chrome-label` 工具类消费 */
  --font-chrome-label: ...;       /* 暖系 var(--font-sans)，海报系 var(--font-display) */
  --chrome-label-tracking: ...;   /* 暖系 0.05em，海报系 0.06em */
  --chrome-label-transform: ...;  /* 通常 uppercase；小写主题给 none */

  /* ── Control + chip radius (§3.7.2 / §3.7.3) ── input / button /
     select trigger / icon button → `--control-radius`；inline
     reference / mention / filter / 小 data chip → `--chip-radius`。
     字面值（6px / 4px）而非 `var(--radius-*)` 是有意的 —— 防止后续
     调整命名 radius 时意外把 control/chip 圆角带跑（Cindy 1eG7CReuc5X9ER_9） */
  --control-radius: ...;          /* 暖系 6px 字面值，海报系 0 */
  --chip-radius: ...;             /* 暖系 4px 字面值，海报系 0 */

  /* ── Select listbox radius (§3.6.2) ── Radix Select.Content +
     Select.Item 共享一对 radius token；border 不接，PR-4 "小气泡不
     接重框"边界保留 */
  --select-content-radius: ...;   /* 暖系 6px 字面值，海报系 0 */
  --select-item-radius: ...;      /* 暖系 4px（视觉同心折中），海报系 0 */

  /* ── Primary control surface (§3.2.3) ── Button default variant
     (CTA) 的 bg / hover / text 出口；跟 --accent foreground 解耦 */
  --bg-control-primary: ...;        /* 暖系 var(--accent)；海报系 var(--brand-primary) */
  --bg-control-primary-hover: ...;  /* 暖系 var(--accent-hover)；海报系 color-mix(...) 8-12% 变深 */
  --text-on-control-primary: ...;   /* 暖系 var(--text-on-accent)；海报系 var(--text-on-brand) */

  /* ── Motion ── */
  --ease: cubic-bezier(...);
  --duration: ...ms;

  /* ── Chat default ── */
  --chat-font-size: 14px;
}
```

---

## 6. 自检清单（逐屏走查）

切到新主题后，**至少**点开下面这些场景，每一项都要看着不"瞎"：

- [ ] **Sidebar**：当前 session 高亮（active）、hover 状态、空 workspace 占位、segment control（"录制分析 / SKILL 制作"）当前段
- [ ] **Workspace 卡片**：默认态、hover 出现 settings/home 按钮
- [ ] **Chat 区**：用户消息气泡、assistant 消息、inline `code`、块级 ``` ``` ``` 代码块、链接、blockquote、表格
- [ ] **ToolCallCard**：休眠（折叠）、激活（展开）、success / error / running 三种状态
- [ ] **FilePanel tab 栏**：active tab、非 active tab、tab close 按钮（X 在 active tab 上要可见）
- [ ] **Markdown 编辑器**：Preview / Edit segment control、toolbar 按钮 active 态
- [ ] **设置弹窗 / popover / context menu**：底色（应是 `bg-floating`）、item hover（应走 accent）、阴影边界
- [ ] **Toast**：success / warning / error 三色左侧 3px 状态条
- [ ] **Resize handle**：hover 时变 accent
- [ ] **Modal**：底色 + 遮罩对比度

> Inline code 是最容易翻车的位置之一。如果 `--text-inline-code` 选的色相和 `--text-primary` 太接近，inline code 看上去就和正文一样了 —— 这就是为什么 shadcn 不能继续用 warm 的 `color-mix(accent, text-primary)` 公式。

---

## 7. 常见翻车

- **bg-selected 和 bg-floating 选了相同值** —— warm 下凑巧两者都是 `#FFFFFF` 能看，复制到新主题就是定时炸弹。强制要求两者不同（除非主题真的接受 selected = floating 的视觉，例如 warm）。
- **shadow 用了 `rgba(0,0,0,...)`** —— 暖底主题上发青，冷底主题上反而 OK。统一用 `rgba(var(--shadow-base), ...)`。
- **`--accent` 太亮，覆盖范围失控** —— 主文档 §12 的覆盖上限不因为主题切换而放宽。一行内最多两处带 accent。
- **inline code 用了 `var(--accent)`** —— 长 token（路径 / 文件名）会比真小标题还跳；遵守 §7 三选色原则。
- **忘了在 `THEMES` 数组里加一项** —— Settings 里看不到新主题选项，但 `data-theme='your-theme'` 还是能手工设到 `<html>` 上工作（用作调试入口）。
- **改完没重启 dev server** —— Vite HMR 对 `@import` 链路偶尔失效，新主题文件不重新打包；切主题没反应时优先重启。

## 8. 已有参考
- `apps/desktop/src/renderer/styles/themes/warm-script.css`（默认主题，`:root` baseline）
- `apps/desktop/src/renderer/styles/themes/forza6.css` + `forza6-components.css`（loud-festival 范式）
- §12 = forza6 component-skin 特化清单；v6.x follow-up 的 sticker 配方 / modal chrome / 焦点契约 / presence dot 见 **§12.7**。canonical hook 清单以 `forza6-components.css` 为准（`rg -o "data-[a-z-]+"`）。
- `token-clusters.md` —— 按"消费场景"分簇的 token 审计入口表（退化关系 + 是否值得合并）；dark 主题落地后回头做合并扫描的起点。

---

## 9. 左侧 chrome 的纵向色梯度（per-theme 二选一）

应用左侧从外到内有 **4 个纵向区域**：

```
NavRail  →  Sidebar (channels) → SessionsSidebar  →  ChatArea
最左 icon       频道列表             会话列表           读区
```

主题对这 4 块的色彩处理可以走两条路：

### 9.1 平铺派（可选退化）

NavRail / channels / sessions 三块 chrome 全部 `var(--bg-primary)`，跟 chat 主区 `var(--bg-base)` 形成"框 vs 内容"的二分。简单、安全，但当 4 块同色时**眼睛抓不住焦点**——这是早期实测过的真实问题。

适用：极简、低饱和、想让 chrome 完全隐形的主题。

### 9.2 梯度派（当前推荐）

把 4 块安排在一条 oklab 色线上，每往内一档稀释一次。NavRail 是色线最饱和端（"主信号"），chat 主区是另一端（最浅，读区），中间两档用 `color-mix` 自动派生：

```css
--brand-primary: <theme identity color>;
--bg-nav-rail: var(--brand-primary);
--bg-channels-sidebar: color-mix(in oklab, var(--brand-primary) 30%, var(--bg-base));
--bg-sessions-sidebar: color-mix(in oklab, var(--brand-primary) 12%, var(--bg-base));
/* chat 主区使用 var(--bg-base) */
```

视觉效果：从主题身份色 → 低饱和 sidebar → 更浅 sidebar → 读区纸色的连续过渡，**没有 hue 跳**，只有 saturation + lightness 同步衰减。

为什么用 `color-mix(in oklab, ...)`：oklab 是感知均匀色空间，比 sRGB 插值出的中间色更"自然"——尤其是亮色到深色之间的过渡不会出灰泥色。

**调节口子**：
- 想换 base hue（橘 / 蓝 / 绿），改 `--brand-primary` 一个值，三档全部跟着重算
- 想 channels 更柔，把 `55%` 调到 `45%` / `40%`
- 想 sessions 几乎隐形，把 `22%` 调到 `15%`
- 整体加深，两个百分比一起往上提（如 `70%` / `35%`）

**踩过的坑**：
- 一开始给 channels / sessions **各选一种独立 hue**（比如黄→沙绿），结果"霓虹挨着青苔"——saturation 断层 + 温度断层，不协调。统一到一条色线后顺滑了。
- "新主题不定义这三个 token" 会让 sidebar 瞬变透明黑——必须显式 fallback 到 `var(--bg-primary)`。

---

## 10. 选中态 / hover 态状态机（跨组件统一）

NavRail 项 / channel / DM / session 这种**一级导航 row**，用同一套三档状态机，不要每个组件各发明一套。现在 workspace/channel/sidebar row 的状态已经主题化：

| 状态 | border color | border width | background | 视觉读法 |
|---|---|---|---|---|
| default | `border-transparent`（TSX Tailwind class） | `--sidebar-row-border-width` | 无 | 占位边但不可见 |
| hover | `--border-row-hover` | `--sidebar-row-border-width` | `--bg-row-hover` | selected 的弱一级预演 |
| selected | `--border-row-selected` | `--sidebar-row-border-width` | `--bg-row-selected` | 当前所在 |

**三个关键设计点**：

1. **default 上也占位**（用 `border-transparent`），避免 hover/selected 切换时整行向内推——这是非常常见的低级 layout shift bug。
2. **border width 必须主题化但显式定义**。默认视觉标准是 `2px`；selected 是淡墨晕的主题可以用 `1px`。因为默认主题同时挂在 `:root`，其它主题必须显式写 `--sidebar-row-border-width: 2px`，不能指望 fallback。
3. **border color 默认可同色，但由两个 token 控制**（`--border-row-hover` / `--border-row-selected`，见 §3.5.1）。背景承担 hover→selected 的 emphasis 梯度，边只决定 geometry。早期版本让 hover 用减弱的 `border-accent/40`，看起来像"两种不同的状态"而不是"同一种渐进确认"——分两 token 之后仍然推荐设成同色，但有需要时（比如 selected 想用更深一档锚色）也能各走各。

**适用范围**：
- ✅ NavRail 项（`nav[aria-label='App sections']` 内）
- ✅ Sidebar channel / DM 项（`aside[data-sidebar]` 内的 `.sidebar-row-border`）
- ✅ SessionsSidebar 会话项（同上）
- ✅ Workspaces / Members / Computers 等所有 `aside[data-sidebar]` 内的一级导航 row
- ❌ 行内按钮 / toolbar / dropdown trigger（用各自的状态系统）
- ❌ Saved / 分组 header 等"动作"性质而非"导航选中"性质的按钮（继续用 `bg-bg-hover`）
- ❌ 主内容区的 row（如 `ArchivedChannelsPanel`）即便复用 `.sidebar-row-border` 类（拿宽度），也**不**自动接 row-state border 契约；它们走自己的 hover 词汇。需要纳入时请给显式 hook 并补到 §3.5.1。

**主题间的退化**：组件层读取 5 个 token —— `--bg-row-selected` / `--bg-row-hover` / `--sidebar-row-border-width` / `--border-row-hover` / `--border-row-selected`。新主题必须显式定义全部五个；如果想沿用旧视觉，就把 selected 设为 `var(--bg-selected)`，hover 设为 `rgba(255,255,255,0.7)` 或本主题等价值，border width 设为 `2px`，两个 border color 都设为 `var(--accent)`（warm-script 的做法）。

---

## 11. 下拉菜单的同心圆原则

下拉框（Select / Combobox / Picker）的容器与内层选项 item 必须遵循**同心圆原则**：

> **inner_radius = outer_radius − inset**
>
> 当容器圆角为 R、容器到 item 的内边距为 P 时，item 圆角应取 R − P。

### 11.1 当前标准尺寸（对应 Tailwind token）

| 容器 | 内边距 | item 应用 | 推导 |
|---|---|---|---|
| `rounded-md` (10 px) | `p-1` (4 px) | **`rounded-sm` (6 px)** | 10 − 4 = 6 |
| `rounded-lg` (14 px) | `p-1.5` (6 px) | **`rounded-md` (10 px)** (近似) | 14 − 6 ≈ 8，取最近档 |
| `rounded-xl` (20 px) | `p-2` (8 px) | **`rounded-lg` (14 px)** (近似) | 20 − 8 = 12，取最近档 |

### 11.2 常见错误

- **`rounded`（无 size 修饰符）**：不走主题 token，固定 `0.25 rem ≈ 4 px`，与 `rounded-md` 容器配用时偏小——视觉上 item 和容器圆角脱节。正确写法是 `rounded-sm`。
- **item 和容器用相同 `rounded-*`**：容器是 `rounded-md`、item 也是 `rounded-md`，内层圆角大于理论值，item 角会"撑破"容器轮廓感。
- **item 无圆角（`rounded-none`）**：容器有弧度但 item 是直角，hover 高亮撞墙感。

### 11.3 适用范围

- ✅ Select / Combobox content 容器 + item
- ✅ 自定义 Picker 菜单 + item（如 Composer PickerMenu）
- ✅ Popover / DropdownMenu content + menuitem
- ✅ Command palette content + item
- ❌ 工具栏 / 行内 chip / tag（独立元素，不存在包含关系，不适用同心圆）

## 12. Forza6 component-layer 特化清单（参考实现）

forza6 是首个走"token + component skin"两层的主题，不只是换色。其它主题加新 component-layer specialization 时，可以参考 forza6 的边界与 hook
约定。Token 层见 §3.1.3，本节聚焦 PR-2 component-layer 范围。

### 12.1 文件边界

- `apps/desktop/src/renderer/styles/themes/forza6.css` — token 层（约 250 行，PR-1）
- `apps/desktop/src/renderer/styles/themes/forza6-components.css` — component 特化层（约 740 行，PR-2）。**所有 selector 都必须 `[data-theme='forza6']`-scoped**，warm 三主题像素零变化。

### 12.1.1 三层 token 模型（#task:788 重构）

重构前 forza6 配色有三个结构病：(A) root token 块被 `forza6-components.css`
里一个裸 `[data-theme='forza6'] {}` 块**静默重定义**，root 那份成 dead value；
(B) 同一个色相散落成三种写法——root 语义 token 内嵌 hex、组件层再抄一遍字面值、
个别 scope 又覆盖一次；(C) 死/误导 token（如 `--bg-selected` 洋红无可见消费者）。
P1 把配色收成**三层**，三条硬规则：

1. **L1 — Raw palette（唯一允许 hex 的地方）。** forza6.css 顶部 `--forza6-*`
   原始色相块（pink / pink-deep / lime / lime-pale / lime-deep / cyan / yellow /
   ink / teal-island / teal-deep / carrier-channels / carrier-sessions）是 forza6
   品牌/festival 色相**唯一**可以写裸 hex 字面量的地方。改一个色相，只改这里一处。
   （`--forza6-syntax-*` / `--forza6-indigo-*` 是 code-island 子系统的 theme-private
   raw，同属 L1。）冷中性 bg 阶梯（`#F7F8F6`/`#ECEEEB`…）和深饱和语义变体
   （`--warning`/`--error` deep）不是 festival 品牌色，暂不强制入 raw palette。

2. **L2 — 语义 token 全走 `var(--forza6-*)` 衍生。** forza6.css 的 `[data-theme=
   'forza6']` **单个** root 块里，每个语义 token（`--brand-primary`/`--accent`/
   `--bg-row-selected`/`--task-status-*`/`--border-focus`…）的值都是 `var(--forza6-*)`
   或其 alpha/`color-mix` 衍生，**不再内嵌品牌 hex**。语义 token 名保持区分（per-role
   alias），只是值指向同一 raw——`--text-on-selected`/`--border-avatar`/`--bg-structure-dark`
   都读 `var(--forza6-ink)` 但仍是独立 token，不合并。alpha 形（`rgba(179,24,106,…)`）
   是允许的例外。

3. **L3 — `forza6-components.css` 0 hex（例外：data-uri / alpha / 几何）。** 组件特化层
   只读语义 token（必要时读 L1 raw，如 sidebar carrier），**不写品牌 hex 字面量**，
   也**不再有第二个 root-level token 重定义块**——root token 的唯一定义点是
   forza6.css。例外：SVG data-uri 里的 `rgba()`、纯 alpha 叠层、几何尺寸。

`appearance.test.ts` 锁这三条：forza6.css 必须含 `--forza6-pink:` 等 raw；
forza6-components.css **不得**再出现裸 `[data-theme='forza6'] {` root 重定义块；
关键 root token（`--bg-app`/`--bg-nav-rail`/`--border-focus`）不得是 dead value。
分期：P1 引 raw + root 归位 + 删 components root-reassign（本节）；P2 抽 `--bg-hover-preview`
（`#E6F68A` ×10）；P3 换组件层 `#0A0A0A`（→ ink 语义 alias）；P4 换 `#D4F523` + 收口
`--bg-selected`。P2–P4 同样视觉零变化。

### 12.2 特化覆盖面（8 大块）

| # | 区域 | 特化内容 |
|---|---|---|
| 1 | App frame / Titlebar | 节日粉 frame；titlebar 5 片不规则斜切三角硬纹（中右分布，SVG `viewBox 600×28`，y `-4`/`32` 截断）；workspace name display caps |
| 2 | NavRail / Sidebar | 浅 lime carrier `#F4F8E8`；selected lime `#D4F523` pill + 黑边 + 3px 黑左侧 dock notch；hover lime preview `#E6F68A` + 2px 黑边；count → magenta + tnum |
| 3 | Chat header | `#` magenta + 900 + 1.25em + margin-right；title display caps；右侧 action button cluster transparent + 2px 黑边方角 + 每按钮 lime hover preview；sidebar Hash icon stroke-width 2.75 + magenta |
| 4 | Composer | textarea focus magenta + padding-right 5.5rem；send button magenta sticker + 方角 + display caps（v5.x 之后 product 默认是 "Send" 文字，forza6 只保留配色/几何特化） |
| 5 | Markdown | inline code lime body `#D4F523` + 1px 黑边方角海报贴纸；多行 fenced code block 深青-黑 HUD island `#0F2F2C` + 2px 黑边 + lime display caps 语言标签 + 浅文 `#E8F1EF` (12.6:1 AAA) + dark hljs syntax palette（forza6-scoped，不动 global github.css）|
| 6 | Task 系统 | task panel/drawer 列容器 2px 黑边 + 顶 5px 状态色条；列头 display caps + magenta count；卡片 sticker + lime hover preview；`#nnn` magenta display caps；status badge 配色阶梯（todo 透明黑边 / in_progress cyan `#22B7E0` / in_review magenta `#FF2C7A` / done muted green）。**四处共用 `data-task-status` hook**：panel / drawer / task popover / markdown system message task event |
| 7 | Popper / 浮层 | 全 Radix wrapper 局部 `--bg-hover: #E6F68A` lime preview（dropdown / context menu / popover / select / tooltip / hovercard item hover 统一）；context menu + agent/human profile popover + ManageMembersPopover + task popover (HoverPopover) 加 2px 黑边方角海报硬框；菜单内 menuitem 同步方角 |
| 8 | Settings appearance | `THEME_META.forza6` 4 色 swatch：浅 lime + 节日粉 + 黑 + 酸 lime（双 lime + magenta + 黑） |

### 12.3 TSX 结构 hook 约定

特化全部走 CSS，TSX 只加 **theme-neutral 结构 hook**——hook 名描述 DOM 角色，不带 forza6 语义。这样：
- 其它主题想做特化时复用同一组 hook
- TSX review 不会被主题词污染
- 主题切换不需要改 React 树

当前 forza6 消费的 hook（按引入顺序，~14 个组件文件）：

| Hook | 文件 | 角色 |
|---|---|---|
| `data-titlebar="app"` | `Titlebar.tsx` | 应用 titlebar 容器 |
| `data-workspace-name` | `Titlebar.tsx` | workspace 名字 chip |
| `data-conversation-title` | `ChannelView.tsx` | chat header 标题（regular + dm 两处）|
| `data-conversation-hash` | `ChannelView.tsx` | chat header `#` |
| `data-channel-actions` | `ChannelView.tsx` | chat header 右侧按钮 cluster |
| `data-channel-icon` | `ChannelsSidebar.tsx` | sidebar Hash icon |
| `data-composer-input` | `Composer.tsx` | chat 输入框 textarea |
| `data-composer-action="send"` | `Composer.tsx` | send 按钮 |
| `data-sidebar` | `Sidebar.tsx` / `ChannelsSidebar.tsx` / `App.tsx` | sidebar `<aside>` 容器（4 处）|
| `data-tasks-board` | `WorkspaceTasksDrawer.tsx` / `TasksSection.tsx` | task kanban container |
| `data-tasks-column` + `data-status` | 同上 | task 列容器 |
| `data-tasks-num` | 同上 | task 号 `#nnn` |
| `data-task-status` | `WorkspaceTasksDrawer.tsx` / `TasksSection.tsx` / `TaskRef.tsx` / `SystemMessage.tsx` | task status badge（四处共用 canonical hook）|
| `data-popover-frame="info"` | `AgentInfoPopover.tsx` / `HumanInfoPopover.tsx` / `ManageMembersPopover.tsx` / `HoverPopover.tsx` | info-card 类浮层（要海报硬框）|

不能用作 forza6 hook 的 attr：
- 任何 `aria-*`（a11y 是产品契约，不能被 CSS 私吞）
- 任何含 `forza6` / 主题词的命名

### 12.4 不特化的（设计边界，避免噪声过载）

- 滚动条
- Tooltip 内容（小浮层）
- HoverCard 部分用例（仅 HoverPopover wrapper 走海报硬框）
- Select listbox（仅继承 lime hover，不加硬框）
- Settings 主体（保留默认）
- 黑底 member-strip（v5.4 已撤回；token `--text-on-dark-pop` 留备未来）

### 12.4.1 Theme-private token：`--forza6-syntax-*`（PR-7 内部清理）

forza6 在 `[data-theme='forza6'] .markdown-body .code-block .hljs-*`
上覆盖了 8 套 `highlight.js` 语义色（base / keyword / string /
number / comment / meta / addition / deletion），用一套 HUD 海报
调色让 fenced code 在深青-黑岛屿底色上读起来像 Forza 仪表盘。
PR-7 (#task:357) 把这些字面量提到 `--forza6-syntax-*` token，
作为 **theme-private 词汇**，不进 §3 的跨主题契约表。

| Token | 默认值 | 用途 |
|---|---|---|
| `--forza6-syntax-base` | `#E8F1EF` | `.hljs` 基础文字色（无语义类时） |
| `--forza6-syntax-keyword` | `#D4F523` lime | `.hljs-keyword/built_in/title/name/tag/section` 等"骨架" |
| `--forza6-syntax-string` | `#FFD7E5` 软粉 | `.hljs-string/attr/template-variable/variable/regexp` |
| `--forza6-syntax-number` | `#22B7E0` cyan | `.hljs-number/literal/symbol/bullet/link` |
| `--forza6-syntax-comment` | `rgba(255,255,255,0.45)` | `.hljs-comment/quote`，配合 italic |
| `--forza6-syntax-meta` | `rgba(255,255,255,0.55)` | `.hljs-meta/meta-string` |
| `--forza6-syntax-addition` | `#D4F523` | diff `+` 行，前景同 keyword |
| `--forza6-syntax-deletion` | `#FF6F8C` 珊瑚 | diff `−` 行 |

**为什么用 `--forza6-` 前缀而不是通用 `--syntax-*`**：当前只有
forza6 需要覆写 syntax 调色（warm-script 走 `highlight.js/styles/github.css`
vendor stylesheet，零覆写）。把它命名成 theme-private 留出空间，
未来如果要做"跨主题 syntax contract"（drop github.css，每主题都列
完整 hljs 矩阵 + cascade test），就能直接用没被占用的 `--syntax-*`
命名空间，不会和这套发生 alias 冲突。

**Cascade test 不约束**：`appearance.test.ts` 的"每个主题必须显式
定义"断言**不**覆盖这些 token，因为 warm-script 故意不定义它们。
新主题接入时按需重复 forza6 的 8 token 即可，没有"漏定义"风险——
不定义就走 github.css 的默认。

**Addition / deletion 行的浅色背景仍是字面量**（`rgba(212, 245, 35, 0.08)`
/ `rgba(255, 111, 140, 0.08)`），因为它们是前景色的 alpha 派生；
未来想拆 token 时直接加 `--forza6-syntax-addition-bg` / `-deletion-bg`
两个即可。

### 12.5 关键架构原则

1. **Lazy variable substitution**：核心 token 用 `color-mix(in oklab, brand X%, var(--bg-channels-sidebar))` 类公式定义一次，scope 切换自动重新解析。Sidebar token 在 `aside[data-sidebar]` 局部 redefine，root 不受影响。
2. **Specificity > Tailwind utility**：`[data-theme='forza6'] [hook]` selector 是 (0,2,0)，稳赢 Tailwind utility (0,1,0)，不需要 `!important`。
3. **Hover→Selected 硬度递进**：hover (浅 lime + 黑边) → selected (实心 lime + 黑边 + notch) → inline (lime sticker 方角) → send (magenta sticker + display caps) → status badge → `#` 大号 magenta。每一档比上一档"更硬"。
4. **Status 配色阶梯**：todo 中性黑边 / in_progress HUD live cyan / in_review 高注意 magenta / done passed muted green。lime 不进工作流状态色（避免和 done/pass 撞语义）。
5. **WCAG 必须不让步**：磁红 + 近黑 6.38:1 AA / 浅 lime + 近黑 ~14:1 AAA / cyan + 黑 9.4:1 AAA。任何"主观感觉应该换色"的提议先算对比度。

### 12.6 验证

- `pnpm --filter @silverhand/desktop typecheck`
- `pnpm --filter @silverhand/desktop test`（appearance.test.ts 含 4 个主题相关测试）
- 切到 forza6 → 切到 warm-three 的来回测试，无 token 残留
- 颜色对比度走 WCAG 2.1 AA / AAA

### 12.7 v6.x follow-up（#task:918/919/920）：新增配方 + 焦点契约

§12.2 / §12.3 的特化表是 **#task:917 时点的快照**，之后 #task:912/918/919/920 又陆续加了一批 hook（`data-modal-shell` / `data-dropdown-frame` / `data-status-pip` / `data-composer-shell` / `data-list-row` / `data-list-row-icon` / `data-sidebar-section-icon` / `data-panel-*` / `data-host-*` / `data-settings-*` …）而没回填那张表。**canonical hook 清单以代码为准**：`rg -o "data-[a-z-]+" themes/forza6-components.css | sort -u`。下面只记 v6.x 沉淀的可复用模式。

**(1) Pane hero sticker 配方（`#` channel chip）**。把"高识别度小标"提炼成一个换 hue 即跨语义复用的配方，挂在 `data-channel-icon`：
```
fill = 语义色（channel = yellow）
glyph = 对比色（ink）
border = 1px solid ink
border-radius = 0
box-shadow = 1px 1px 0 ink   /* 海报硬冲压投影，no blur */
box-sizing: content-box; padding: 1px; stroke-width: 2
```
现已复用到 chat header `#` / archived row / saved header / ChannelsSidebar。尺寸/间距由 consumer 外层控制，hook 只画 identity（fill/border/glyph/shadow）——见 §12.3 的 theme-neutral 约定。

**(2) Modal poster chrome（`data-modal-shell`）**。Dialog / ImagePreviewModal 走 2px ink frame + 硬投影（`box-shadow: 2px 2px 0 ink`）+ `--floating-radius`(=0)。**opt-in 而非 `[role='dialog']` 全选**：Lightbox 也是 Radix Dialog 但不该吃海报框，所以用显式 hook 让它退出。

**(3) Floating-frame token 簇**。base 组件（Input/Textarea/Button/Dialog/Select）不准 hardcode Tailwind 默认（`border`=1px / `rounded-md` / `rounded-lg`），必须消费簇：`--control-border-width`（forza6=2px）/ `--control-radius`(=0) / `--floating-radius`(=0) / `--floating-border` / `--border-control-hover`。否则主题切换只有 utility-level 一致、base-level 分裂；这类 debt 常被外层补偿（ring outset shadow 撑厚 1px 边）掩盖，**删补偿层（删 ring）的瞬间才暴露**。

**(4) 焦点契约（v6.10.x lesson，硬规则）**：
- **utility 状态绝不用饱和 hue**。focus / hover / splitter / row-hover / control-hover / 焦点框都是 utility → 走 `--border-focus`(=ink) / 中性词汇。`--border-focus` 是 token，**钉死在 `forza6.css`，不准在 `forza6-components.css` 重定义**（appearance test 锁）。
- **例外：brand-anchored 主舞台**。composer 这种用户核心 anchor 的 focus 是 brand identity 高光，保留节日粉——用 `[data-composer-shell]:focus-within` element-scoped 覆盖，不动全局 token。判断标准：是不是"主舞台"？是→brand focus；否（一般 input/select/button）→ink focus。
- **focus 变厚 = ring 不是 border**。Tailwind `ring-N` 是紧贴 border 外侧的 outset box-shadow（视觉 = border+ring 加粗）。要"focus 只换色不变粗"就删 ring 只换 border-color——前提是控件本就有可见 resting border。无 border 的控件（fill button / icon / chip）ring 是它们唯一 focus a11y 信号，**不能删**。
- **hover→focus 不能跨色族**。同一控件 hover 粉 + focus 墨水 = click 瞬间色彩跳跃。复合 `--border-control-hover` 让 hover/focus 跨主题各自同族。

**(5) 在线状态点（presence dot）**：复用 app 既有 active 点色 `--success`（forza6=deep lime，与 WORKSPACES 活跃点同款）。presence/online=绿是 app 既定约定，新做 presence 指示直接复用，**不算违反「饱和 hue 独占语义」**。批量数据用 `useAgentsPresence`（`useQueries` 拉 N 个 `/runtime-state`，共享 `useAgentRuntimeState` 的 query key + 5s 节奏）。

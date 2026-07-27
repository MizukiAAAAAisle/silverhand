# 新主题制作指南

如何在 Electron 客户端里加入一套**完全不同视觉语言**的主题（不是 light/dark 切换，而是另起一套配色 + 排版 + 节奏的风格）。

本文只讲如何把一套视觉语言映射到现有主题 token、语义 hook 与组件层级；当前 token 集与 selector ownership 以主题 CSS 和 `appearance.test.ts` 的结构守卫为准。

---

## 1. 主题在代码里的位置

```
apps/desktop/src/renderer/
├── styles/
│   ├── global.css                  # 入口：@import tailwind + 各主题；@theme inline 暴露 var；非主题化常量（titlebar-height）；全局 element 样式
│   └── themes/
│       ├── forza6.css              # :root + [data-theme='forza6']（默认主题，避免 FOUC）
│       ├── forza6-components.css   # forza6 component 特化层
│       ├── studio-light.css        # [data-theme='studio-light']
│       └── slack-dark.css          # [data-theme='slack-dark']
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

1. **新建 `styles/themes/nordic.css`** —— 复制一份现有 theme 文件（例如 `studio-light.css`）当骨架，把选择器改成 `[data-theme='nordic']`，把每个 token 的值替换成本主题的色值（保持变量名不变）。**不要漏 token**，对照 §3 表逐一填。
2. **`styles/global.css` 顶部加一行**：`@import "./themes/nordic.css";`
3. **`settings/types.ts` 的 `ThemeId` 联合类型加一项**：`... | 'nordic'`
4. **`settings/sections/AppearanceSection.tsx` 的 `THEMES` 数组加一项**，提供 4 色预览（bg / surface / text / accent）和一句中文 `hint`
5. 重启 dev server，进 Settings → Appearance，切到 nordic，逐屏走查（见 §6 自检清单）

零代码入侵。所有主题相关改动只在上面这 4 个位置。

---

## 3. Token 契约（必须全部实现）

把这张表当**填空题**，每个槽位都得给值。值的取舍要遵循下述规则（饱和度上限、暖/冷一致性、可读对比度）。hex 只写在主题 CSS 文件里，本文只列"这个 token 必须存在 + 什么含义 + 选值原则"。

### 3.1 背景色阶（含两类选中色）

| Token | 含义 | 选值原则 |
|---|---|---|
| `--bg-base` | 全局窗口底色 | 主基调；不应刺眼纯色（除非纯白/纯黑是刻意的风格选择）|
| `--bg-primary` | 一级区域底（sidebar、main column 容器） | 比 base 略深一档 |
| `--bg-elevated` | 二级容器（卡片休眠态、segment control 容器、设置面板小块） | 再深一档 |
| `--bg-surface` | 三级容器（嵌套面板）| 再深一档；可与 elevated 接近 |
| `--bg-hover` | 通用 hover 反馈 | 比 elevated 略深 |
| `--bg-active` | 按下/激活态、segment control 容器 | 再深一档 |
| `--bg-selected` | **导航激活态**（sidebar 列表当前项、tab 当前项、segment 当前段） | 必须能从 `--bg-primary` 中明显跳出（≥ 5% 亮度差） |
| `--bg-floating` | **浮层 / 卡片表面**（popover、菜单、对话框、展开后的卡片） | 永远是"内容表面"，通常是主题里**最亮**的一档 |
| `--bg-chat` | **Chat 主读区**（会话 / Saved / Search 的 main 区域） | 独立于 `--bg-base`；base 可作为全局 frame，chat 应按阅读舒适度单独取值 |
| `--bg-app` | App frame 底色（panel card 之间露出的底） | 比 sidebar/card 表面沉一档；必须与 titlebar 背景协调 |
| `--bg-island` | 岛屿底色（代码块、JSON、终端、表格） | 中性灰，与主基调形成材质对比 |
| `--bg-island-deep` | 表头、嵌套岛屿 | 比 island 略深 |
| `--bg-nav-rail` | NavRail（最左 icon 栏）底色 | 主题最强的一档信号色，或退化成 `var(--bg-primary)`（详见 §9） |
| `--bg-channels-sidebar` | 频道列表栏底色 | 与 nav-rail 同色家族、saturation 低一档；或退化 |
| `--bg-sessions-sidebar` | 会话列表栏底色 | 同色系最浅；或退化 |
| `--bg-nav-rail-hover` | NavRail icon hover 底色 | 与 `--bg-nav-rail` 成对；深色 nav 用浅混色，浅色 nav 用深混色 |
| `--bg-row-selected` | Workspace / Channel / Search / Saved row 选中底色 | 必须从 sidebar 底色中跳出 |
| `--bg-row-hover` | 同一组 row 的 hover 底色 | selected 的弱一级，不应比 selected 更抢眼 |

**关键规则 1：`--bg-selected` ≠ `--bg-floating`**。两者是有意拆分的 token —— 若某主题下它们凑巧同值（例如某浅底主题都是纯白），可以，但不能默认复用；否则 `bg-elevated` 容器里的激活态会消失（参见 §4.3 配对表）。

**关键规则 2：三个 sidebar token 是 per-theme 可选项**。"留白派"主题让它们全部 `var(--bg-primary)`，左侧 chrome 一片同色。"梯度派"主题让它们沿一条 oklab 色线递减 —— 见 §9。**新主题里这三个 token 必须给值**（哪怕都退化到 `var(--bg-primary)`），否则切换主题时 NavRail / sidebar 会瞬变成透明黑。

**关键规则 3：默认主题同时挂在 `:root` 上，新增 token 不能依赖 fallback。** 只要组件开始读取某个 CSS var，其它主题也必须显式定义同名 token；否则会继承默认主题值，出现"切主题后还用旧主题的 row border / 不该出现的 NavRail icon 色"这类泄漏。这条是本节所有"MUST 全部显式定义"约束的根因，`appearance.test.ts` 的 cascade 断言锁它。

### 3.1.1 App frame / panel card 几何

| Token | 含义 | 选值原则 |
|---|---|---|
| `--frame-padding` | App frame 左右/底部 padding，也是 panel 之间的视觉 gap | 一档统一的窗口内缩；titlebar 下方 top padding 在组件层固定为 0 |
| `--card-radius` | NavRail / sidebar / chat panel 圆角 | 与 frame 节奏一致；直角主题也要显式写 0 值 |
| `--card-shadow` | panel card 阴影 | 轻阴影即可，避免卡片变成浮层 |
| `--splitter-bg` | resize splitter 的静态底色 | card frame 中通常 `transparent`，由 gap 表达分隔 |
| `--splitter-offset` | 抵消 splitter 作为 flex item 产生的额外列间距 | 让视觉 gap 仍等于 `--frame-padding` |
| `--titlebar-border` | titlebar 下边线 | card frame 主题通常 `transparent`，避免 titlebar 和 body 断层 |

### 3.1.2 Brand / NavRail / row state

| Token | 含义 | 选值原则 |
|---|---|---|
| `--brand-primary` | 主题身份色源头 | NavRail、row selected/hover、badge 等需要"品牌身份"的地方从这里派生 |
| `--text-on-brand` | `--brand-primary` 背景上的文字 / icon | 与 brand 成对维护对比度 |
| `--text-nav-rail` | NavRail 默认 icon 色 | 深色 nav 用浅字，浅色 nav 用深字；必须显式定义 |
| `--text-nav-rail-hover` | NavRail hover icon 色 | 通常比默认更实 |
| `--bg-nav-rail-hover` | NavRail icon hover 底色 | 与 NavRail 底色、icon 色一起按主题成组定义 |
| `--bg-task-tag` | Message header 后的 task tag 底色 | 主题化的高显著 chip，通常从 `--brand-primary` 派生，不要复用 warning |
| `--text-on-task-tag` | task tag 上的文字 / icon | 与 `--bg-task-tag` 成对维护对比度 |
| `--border-task-tag` | task tag 描边 | 与 task tag 底色同族，提供边缘清晰度 |
| `--sidebar-row-border-width` | Workspace / Channel / Search / Saved row 描边宽度 | 描边派给可见的一档；selected 靠淡墨晕表达的主题可降到更细一档 |

### 3.1.3 Loud-festival theme family tokens

海报 / festival 风格主题族用的一组扩展 token（重压字体、几何身份纹理、第二 accent、黑色结构层、深底荧光 metadata）。**每个主题都必须显式定义这 8 个 token** —— 单 accent / 无纹理 / 无黑结构的主题可以全部退化成现有 sibling（`appearance.test.ts` 锁定）。这是 §3.1 关键规则 3 的硬约束：不显式定义就会从 `:root` 默认主题漏过来，切主题再切回会残留纹理 / 第二 accent / 黑结构条。

| Token | 含义 | 退化规则（warm/single-accent 主题） |
|---|---|---|
| `--font-display` | 重压窄体大写字体栈（chrome 标题、segment、status pill）| `var(--font-sans)` |
| `--bg-pattern-image` | 持续在场的几何身份纹理（几何 SVG data URL）| `none` |
| `--bg-pattern-opacity` | 纹理强度 | `0` |
| `--accent-2` | 第二 accent（info / 链接 / 3 档信息）| `var(--accent)` |
| `--text-on-accent-2` | `--accent-2` 上的文字 | `var(--text-on-accent)` |
| `--bg-structure-dark` | 黑色结构层（segment 容器 / member-strip / now-playing / titlebar tint / tool-card header / popover header / workspace-tile）| `var(--text-primary)`（浅色主题用 text-primary 当近黑）|
| `--text-on-structure` | `--bg-structure-dark` 上的文字 | `var(--bg-base)` |
| `--text-on-dark-pop` | 深底/黑结构上的荧光数字 metadata（currency / level / counter）| `var(--accent)`（浅色主题无"深底荧光"，退化到 accent）|

**`--bg-structure-dark` / `--text-on-dark-pop` 使用边界**（不要泄漏成普通装饰色）：
- `--bg-structure-dark` 仅承担**结构层** —— 容器、tab/segment 当前段、进度槽、卡片 header、titlebar tint、workspace-tile、NavRail dock notch。**禁止**做"任意按钮黑底"或"chat 主区分隔条"。
- `--text-on-dark-pop` 仅在**深色 chrome 或黑结构**上用 —— currency / 等级 / 短 metadata 数字。**禁止**进入 `--bg-chat` 浅白读区，否则破坏阅读层级。

### 3.2 文字

| Token | 含义 |
|---|---|
| `--text-primary` | 正文 |
| `--text-secondary` | 副标题、metadata |
| `--text-muted` | 三级文字、占位 |
| `--text-inverse` | 反色文字（少用） |
| `--text-island` | 岛屿（代码块）内的文字 |
| `--text-inline-code` | 行内 `code` 字色 —— **每个主题独立选**，色相要与 `--text-primary` 拉开（见 §6 / §7） |

### 3.2.1 Inline-code chip

`.markdown-body :not(pre) > code` 渲染时读取下表 4 token（含 §3.2 的 `--text-inline-code`），全部 per-theme 强制定义，不允许漏一个回退 `:root`。

| Token | 含义 | 选值原则 |
|---|---|---|
| `--bg-inline-code` | chip 背景 | 软底主题常用 `color-mix(text-primary X%, bg-base)`；海报系用饱和填充色 |
| `--border-inline-code` | chip 边框 shorthand（含 width + style + color） | 软底主题给 `none`；海报系给可见 near-black 描边 |
| `--radius-inline-code` | chip 圆角 | 软底主题给 `var(--radius-sm)`；海报系给 `0` 方角 |

### 3.2.2 Task status badge

任务状态徽标经 `[data-task-status='<status>']` 钩子从同一 15-token 契约取色（5 status × {bg/text/border}）；消费点（看板卡 / 内联 chip / task-event pill / status popover 等）以该 hook 为准。每个主题 MUST 全部 15 个都显式定义，不允许漏一个回退 `:root`。

命名用 domain-prefix `--task-status-*` 而非通用 `--status-*`：这些值专门为小号海报-display 徽标调过，不是一般性"状态色"词汇，narrow namespace 防止被复用到不合适的尺寸。

| Token | 含义 |
|---|---|
| `--task-status-todo-bg` / `-text` / `-border` | "todo" 徽标 |
| `--task-status-in-progress-bg` / `-text` / `-border` | "in progress" — **active / HUD-live 语义**（配 live indicator 一路）|
| `--task-status-in-review-bg` / `-text` / `-border` | "in review" — **awaiting human attention 语义**（配 accent/brand loud beacon）|
| `--task-status-done-bg` / `-text` / `-border` | "done" 徽标 |
| `--task-status-closed-bg` / `-text` / `-border` | "closed" 徽标（见下方 closed 说明）|

**closed = 第五个终态 status**（不再是与 `task_status` 正交的 archived 可见性维度）。closed 卡片落在 kanban 第五列（Done 之后），status badge 直接显示 `closed`。其 3 个 token 与其它四个 status 同属一套 task-badge 词汇，每个主题 MUST 三个都显式定义。取值原则：软底主题给 `transparent` / `var(--text-muted)` / hairline 边；海报系给饱和填充 + 高对比字 + 同色实心块边。

**消费边界规则**：这组 token **只**被 task status chip 消费，不外扩到 channel archived badge 或其它 surface —— 避免语义跨域复用导致 token 含义漂移。

**边框规则**：5 个 status 用统一的海报形态 —— 实心饱和/中性填充 + `border: none` + 0 圆角（各 status 保留语义 hue，ink 全部过 AA）；暖软底主题走 `none` 边框 + 软底。边框走 shorthand（含 width + style + color）。

**语义提醒**：`in_progress` = active / 正在跑 → HUD-live（如 cyan，dashboard-live）；`in_review` = 等待人类介入 → loud-beacon（如 brand magenta，attention-grabbing）。如果直觉相反，请以此为准。

### 3.2.3 Primary control surface

`Button` `default` variant —— dialog 的提交按钮、settings save、注册主按钮这类**主 CTA** —— 通过一个 3-token 契约取 bg / hover bg / text，跟 `--accent` foreground 语义解耦。

| Token | 含义 | 选值原则 |
|---|---|---|
| `--bg-control-primary` | 主 CTA 背景 | 独立色值，不复用 `--accent` / `--brand-primary`（那两个另有语义）；深底主题取浅段、亮纸主题取深段，判据是**字色**能不能过 AA |
| `--bg-control-primary-hover` | hover bg | 浅色主题往暗走一档；**深色主题往亮走**（高程语言：越上层越亮）。forza6 的海报 hook 会把 hover 填充钉回 resting（hover 只揭起），所以那里这个值只作用于未戴 hook 的按钮 |
| `--text-on-control-primary` | 配 bg 的字色 | 跟 bg 一起选，≥4.5:1；写字面值或专属 token，别复用 `--text-on-accent` / `--text-on-brand`（它们还服务别的表面）|

**当前值**：forza6 / slack-dark 共享"主操作 = 牛油果绿"（#task:1623）—— 浅段 `#9CBF5C` + 墨字（forza6 靠 2px 墨框给边界，slack 靠深底）；中段 olive drab 是死区：白字 3.81 不过、墨字 4.50 贴线。**studio-light 例外，CTA 直接吃 `--accent`（Iris）**（#task:1656）：绿在那个主题里是 **agent 身份色**，CTA 再吃绿就是一个 hue 两个语义。→ 这个 token 的选值判据是"这个主题里还有哪个 hue 没被别的语义占"，不是"三主题统一"。

**主 CTA 的形状走一个 hook，且它是「一对」**：`primaryAction()` / `primaryCancel()`（`features/common/PrimaryAction.ts`）分别挂 `[data-primary-action='commit'|'cancel']`，consumer 只出 motion + layout，主题在 `[data-theme='...'] [data-primary-action='commit']` 里画 identity（forza6 = 2px 墨框 + 直角 + 硬投影 + hover 揭起）。新增主 CTA 直接消费它，别再造第二份配方。

Cancel 必须跟着一起换：commit 有框有填充有投影、Cancel 是裸 ghost 时，一个弹窗读起来是「一个按钮 + 一个文字」而不是「一个决定的两个答案」（shiki 2026-07-26）。`primaryCancel()` 出的就是全 app 唯一那份中性 framed surface `CONTROL_SURFACE_BUTTON`，并且**跟 `destructiveCancel()` 共用同一条主题规则** —— Cancel 回答绿色 Create 和红色 Delete 长得一样是刻意的：两个弹窗之间变的是「哪个 commit 在喊」，不是「出口长什么样」。用 `variant="outline"`，`ghost` 没有自己的纸给框落。

**海报动作有三个 rank**：`primaryAction()`（填充 commit）/ `destructiveAction()`（红框）/ `neutralAction()`（墨框中性，`features/common/ControlInkBorder.ts` → `[data-neutral-action]`）。**可逆的状态变更**（Workspace Settings 的 Archive、Computer 的 Disconnect、Log out）是 neutral：不给填充（填充是 primary 的语义），但要有家族的框 + hover 抬起 + forza6 的墨贴纸。反例就是它们原来的样子 —— 夹在绿贴纸和红贴纸之间、唯一没有框和投影的按钮。

neutral 按密度分级，不一刀切：输入框旁的图标按钮（Browse、行内编辑的 ✓/✕）和 `h-6` 微型 chip（MCP pane 的 Reload / Check config）**故意保持安静**，给 24px 控件挂海报贴纸是用力过重。判据是「它是独立的一次动作，还是某个输入框 / 密集列表的附件」。`[data-host-action='neutral']` 与 `[data-channel-settings-action]` 是同 rank 的旧别名，渲染一致，碰到那两个 surface 时再并入。

**为什么独立 token**：在 loud 主题里 `--accent` 要同时承担"浅底可读 foreground"（text-accent、agent name）和"loud CTA 表面"，两个角色对色彩的需求冲突（foreground 要深 ≥4.5:1，CTA 要亮做品牌识别），拆成不同 token 是唯一的解。暖系无此冲突，三个 token 都退化到 accent 家族。

**故意不动**：装饰性 `--accent` 表面（NavRail selected、theme swatch selected、Titlebar notification badge、ChannelView FAB）是 selected/indicator 语义，跟 CTA 不一类，不跟着主 CTA 改色。

### 3.3 Accent + on-color 配对

| Token | 含义 |
|---|---|
| `--accent` | 品牌强调色（CTA、active 节点、链接边线、单一聚焦信号） |
| `--accent-soft` | 低透明度的 accent，用于 hover 玻璃感、selection |
| `--accent-hover` | accent 的深一档变体 |
| `--accent-glow` | resize handle / focus ring 的扩散色 |
| `--text-on-accent` | 配 `--accent` 背景的字色 |
| `--text-on-success` / `--text-on-warning` / `--text-on-error` | 配语义背景的字色 |
| `--text-on-selected` | 配 `--bg-selected` 的字色 —— 必须与 selected 成对出现 |

### 3.4 语义色

| Token | 含义 |
|---|---|
| `--success` / `--success-soft` | 成功 |
| `--warning` / `--warning-soft` | 警告 |
| `--error` / `--error-soft` | 错误 |

`*-soft` 是低透明度的版本，用于状态卡的休眠底色（具体透明度主题自行取值）。**饱和度上限**与覆盖范围见 §4，主题切换不放宽这两个上限。

### 3.5 边界

| Token | 含义 |
|---|---|
| `--border` | 通用实线描边（留白派几乎不用，描边派是定义性特征） |
| `--border-subtle` | 极淡分隔 |
| `--border-island` | 岛屿描边 |
| `--border-focus` | focus ring |

### 3.5.1 Row-state border color

一级导航 row（sidebar row hook `.sidebar-row-border`，须嵌在 `aside[data-sidebar]` 作用域内）与 NavRail 按钮共用一套 2-token 边框色契约。每个主题 MUST 全部 2 个都显式定义；命中的具体表面以 hook + 选择器为准。

| Token | 含义 | 选值原则 |
|---|---|---|
| `--border-row-hover` | 行 hover 时的边框色 | 暖系常用 `var(--accent)`；海报系用 near-black |
| `--border-row-selected` | 行 selected 时的边框色 | 通常与 hover 同色，让 hover 成为 selected 的"几何 preview" |

宽度由 `--sidebar-row-border-width`（§3.1.2）统一决定，不进这套 color 契约。

**为什么把 hook 限定在 `aside[data-sidebar]` 作用域**：同一个 `.sidebar-row-border` 类也被主内容区的归档列表复用（那里 hover 走另一套词汇），选择器带这个祖先才不会把主内容区的行错拉进导航契约。未来第三个 row 表面想接同契约，给它显式 hook 并补到这一节。

**为什么两个 token 而非 shorthand**：hover 和 selected 经常同色但背景不同，分开 token 让"色一致而背景递进"的语义显式 —— 边框承担 geometry，背景承担 emphasis 梯度。

### 3.6 阴影 + 浮层 base

| Token | 含义 |
|---|---|
| `--overlay-backdrop` | modal 后面的遮罩 |
| `--shadow-base` | RGB 三元组（如 `31, 27, 22`），其它 shadow 通过 `rgba(var(--shadow-base), 0.x)` 引用，方便整套阴影暖/冷统一 |
| `--shadow-popover` | 浮层双层软阴影 |
| `--shadow-modal` | modal 单层大扩散 |
| `--shadow-button` | 按钮阴影（可选） |

### 3.6.1 Floating frame

Menu / popover / hover-card 共用一套外框契约。命中规则都在 `global.css`：

- `[data-radix-menu-content]` —— Radix DropdownMenu + ContextMenu 内部共用属性
- `[data-popover-frame='info']` —— 自定义的中性结构 hook，挂在 AgentInfoPopover / HumanInfoPopover / ManageMembersPopover / HoverPopover 的 `Content`

每个主题 MUST 全部 3 个都显式定义，不允许漏一个回退 `:root`。

| Token | 含义 | 选值原则 |
|---|---|---|
| `--floating-border` | 外框边框 shorthand（width + style + color） | 暖系走细 hairline（`var(--border)`）；海报系走粗实线 near-black 硬框 |
| `--floating-radius` | 外框圆角 | 暖系 `var(--radius-md)`；海报系 `0` 方角 |
| `--floating-item-radius` | 菜单内项的圆角（外方内圆会读成"歪贴纸"） | 暖系 `var(--radius-sm)`；海报系 `0`，跟外框对齐 |

**没有 `--floating-border-width`**：shorthand 已含 width，当前无 inset/offset 布局需要单独取 width。YAGNI，等真有第二消费点再补。

**没有 `--floating-item-hover-bg`**：hover 色通过 `[data-radix-popper-content-wrapper] { --bg-hover: ... }` 的 scoped lazy substitution 工作（浮层 wrapper 内重定义 `--bg-hover`，所有 `data-[highlighted]:bg-bg-hover` 工具类自动跟上）。等出现"浮层 hover ≠ 普通 hover"的主题再升级。

**Tooltip / Select listbox 故意不入**：它们是小气泡，给海报感重框会过载视觉。

### 3.6.2 Select listbox radius

Radix `Select.Content` 和 `Select.Item` 共用一对 radius token，由 `global.css` 里 `[role='listbox']` / `[role='listbox'] [role='option']` 全局选择器消费。所有 SelectContent / SelectItem 调用点的 TSX **不动**，由 global 选择器扫（同 floating frame 的 source-order + 等 specificity 胜出机制）。

**为什么用 `[role='listbox']` 而不是 `[data-radix-select-content]`**：Radix Select 不在 Content 根暴露该属性；`role="listbox"` 是它实际设置的属性，也是 W3C 标准词汇。Composer mention 自定义下拉也用 `role="listbox"`，selector 顺便覆盖 —— 形态一致，海报系都要直角。

| Token | 含义 | 选值原则 |
|---|---|---|
| `--select-content-radius` | Select listbox 外框圆角 | 暖系走 control/chip 同档的字面值以保持像素稳定；海报系归零 |
| `--select-item-radius` | Select item 圆角 | 暖系取"视觉同心折中"值（callsites 内边距不一，折中值在有/无 padding 两种场景偏差都最小）；海报系归零 |

**只动 radius 不动 border**：Select listbox 仍走 Tailwind `border border-border`，不接 `--floating-border`。"小气泡不接重框"边界不变（§3.6.1 / §3.6.3）。

**字面值而非 `var(--radius-*)`**：content 圆角跟 control / chip 同一逻辑保持像素稳定；item 圆角是视觉同心折中，命名 radius 里没有对应档位。独立 2 token 更稳（若复用 `--control-radius` 会丢 item 维度）。

### 3.6.3 `data-dropdown-frame` —— 下拉框海报边框

§3.6.2 把 Select listbox 排除在 floating frame 的 **border** 之外（"小气泡不套黑框"）。但**停留型功能性下拉框**（task filter / message search / archived channels）在海报主题下缺硬边、跟周边硬框语言不一致，应当吃海报边框。

为避免一刀切回退 §3.6.2（`[role='listbox']` 一挂边框会误伤 Composer mention 内联下拉、且 combobox 的 `role=listbox` 落在内层子列表挂上去会双重边框），改用**显式 opt-in 属性** `data-dropdown-frame`：只有手动标了该属性的 `Content` 根才吃框，边框复用 `--floating-border`（不新增 token），radius 仍由各自既有契约管（Select 走 §3.6.2；filter popover 走自身 `--select-content-radius`）。

**边界**：Tooltip / 非 listbox 的瞬时 popover **不**加这个属性 —— §3.6.2 "小气泡不接重框"对它们仍成立，这里只升级"停留型功能下拉"。

### 3.7 几何 + 排版 + 节奏

| Token | 含义 |
|---|---|
| `--radius-sm` / `--radius-md` / `--radius-lg` / `--radius-xl` | 圆角等级 |
| `--font-sans` | UI chrome 字体栈 |
| `--font-serif` | 正文/prose 字体栈（极简主题可让 serif = sans） |
| `--font-mono` | 等宽字体栈 |
| `--ease` | 通用缓动函数 |
| `--duration` | 通用过渡时长 |
| `--chat-font-size` | 对话区默认字号（用户可在 Settings 覆盖） |

### 3.7.1 Chrome label utility

`.chrome-label` 工具类给所有"chrome 小标签"（uppercase + 紧 tracking + 可选 display 字体）—— 分组 header、表头、tab 小标题、badge 文本这类 —— 一个统一出口。3 token 全部 per-theme 强制定义，漏一个回退 `:root` 会让 display 字体 + tracking 泄漏到暖系。

| Token | 含义 | 选值原则 |
|---|---|---|
| `--font-chrome-label` | label 字体栈 | 暖系 `var(--font-sans)`；海报系 `var(--font-display)` |
| `--chrome-label-tracking` | letter-spacing | 主题自行取值；海报系 tracking 更强 |
| `--chrome-label-transform` | text-transform | 通常 `uppercase`；小写主题可设 `none` |

**有意为之的窄契约**：size / weight / color 都留在调用点（call-site utility），不进 token。每个 label 的 size 由它在 chrome 中的"重量"决定（小徽标 vs section header），强行统一会丢 per-callsite 自由度。Utility 只抽出"什么字 + 多开 tracking + 是否大写"这一组 per-theme 决策。

### 3.7.2 Control radius

`--control-radius` 给所有 **control surface** —— input / textarea / button / select trigger / 小 icon button —— 一个统一圆角出口。**追加消费点**：form/settings 内**直接包按钮或 input** 的 control-adjacent action-callout box（如设置里的 archive / delete box）。

| Token | 含义 | 选值原则 |
|---|---|---|
| `--control-radius` | control 表面圆角 | 暖系取 md 档字面值（**故意不 reuse `var(--radius-sm)`**：control 语义对齐的是 md 档，借 sm 会让后续调整 `--radius-sm` 时意外把 control 圆角带小）；海报系归 0 强化"hard-cut block"语汇 |

边界**故意收窄**：只包含直接包按钮或 input 的 form/settings 操作 callout。**不**把一般 error 提示 / empty-state / notification banner / 非表单 callout 卷进来（泛化会让 `--control-radius` 边界失控）。

**故意不入** `--control-radius`：
- SelectContent / popover / dialog / menu 等浮层表面 → 走 `--floating-radius`
- card 表面（result card、DialogContent 主框）→ 走 `--card-radius`
- chip → 走 `--chip-radius`（§3.7.3）
- pill 胶囊（TaskStatusPill）→ 保留胶囊，pill-radius 不入
- 一般 empty-state / notification banner / 非表单 callout → 暂留调用点字面圆角

### 3.7.3 Chip radius

`--chip-radius` 给所有 **inline reference / mention / filter / 小 data chip** 一个统一圆角出口。**追加消费点**：**member selection chip / tile** 一类（tile 内的 remove icon button 也随 tile 走，否则 hover 背景会冒出圆角小底跟方角 tile 不齐）。

| Token | 含义 | 选值原则 |
|---|---|---|
| `--chip-radius` | chip 表面圆角 | 暖系取比 control 略小的字面值（同 control 一样不 reuse 命名 radius 防止意外 coupling）；海报系归 0 跟 control 同节拍 |

**仅限窄类**：不可推广为"列表行 / card 通用圆角"。将来出现更宽的 list row 需要直角，单独开 token，不要复用 `--chip-radius` 把列表全部扫进来。

**与 `--control-radius` 的边界**：
- chip = inline 文本旁的小标签，无交互手感（即使可点也是"点开 popover"级别），形状是 `<span>`-shaped 短长方
- control = 有清晰交互手感的表面（input / button / select），形状是矩形按钮 / 输入框
- 两个 token 分开的核心是它们在软底主题里圆角值不同（chip 比 control 略小）

**没引入 `--pill-radius`**：TaskStatusPill 是当前唯一胶囊消费者，先保留胶囊（海报系用饱和填色表达状态语义，不靠形状）。出现第二个 pill 消费者再单独开。

---

## 4. 选 token 值的核心约束

不要逐 token 凭手感拍脑袋。先定主题的"性格"，再让 token 服从这个性格。

### 4.1 三个基线决策

1. **温度**：暖（统一暖色温）/ 冷（统一冷蓝灰）/ 中性（灰阶单色）。所有 bg、text、shadow 必须沿同一温度方向漂移，**不允许混温**。
2. **accent 的"音量"**：饱和 / 近黑 / 高亮。这决定 accent-soft、accent-glow、border-focus 一整串派生值的强度。
3. **边界策略**：留白派（几乎不画 border，靠色温过渡）/ 描边派（hairline 描边是定义性特征）。决定 `--border` 是不可见还是可见。

定下这三条，下面所有 token 就有方向。

### 4.2 必须遵守的 WCAG 硬约束

- `--bg-base` 不能是用户感觉刺眼的纯色（纯白/纯黑仅当它是刻意的风格选择时允许）
- `--text-primary` 在 `--bg-base` 上对比度 ≥ 7:1（AAA 正文）；`--text-muted` 至少 4.5:1
- `--accent` 在 `--bg-base` 上对比度 ≥ 4.5:1（AA），在 `--text-on-accent` 上对比度 ≥ 4.5:1
- `--bg-selected` 与所属容器（通常 `--bg-primary`）亮度差 ≥ 5%（3% 已是边缘，不能再淡）
- `--bg-floating` 与下方所有非 floating 层都能看出层级（最亮一档）
- 整套阴影都用 `rgba(var(--shadow-base), …)`，不直接 `rgba(0,0,0,…)` —— 暖底主题里黑阴影会显青

### 4.3 容器 → 激活态配对（最常踩的坑）

| 容器 token | 激活态用什么 |
|---|---|
| `bg-bg-primary` / `bg-bg-base` | `bg-bg-selected` |
| `bg-bg-elevated` | `bg-bg-floating`（**不是** selected，否则某些主题下激活态消失）|
| `bg-bg-active` 系列 | `bg-bg-selected` |
| 浮层、popover、modal | `bg-bg-floating` |

写组件时如果不确定容器是哪一档，往父级翻一两层确认。`text-on-selected` 必须和 `bg-bg-selected` 成对，新代码里 `bg-bg-selected text-text-primary` 是历史写法，应改为 `bg-bg-selected text-text-on-selected`。

---

## 5. 写主题文件的骨架

复制一份现有 theme 文件（`studio-light.css` / `slack-dark.css`）按 §3 逐项 refill。

---

## 6. 自检清单（逐屏走查）

切到新主题后，**至少**点开下面这些场景，每一项都要看着不"瞎"：

- [ ] **Sidebar**：当前 session 高亮（active）、hover 状态、空 workspace 占位、segment control 当前段
- [ ] **Workspace 卡片**：默认态、hover 出现 settings/home 按钮
- [ ] **Chat 区**：用户消息气泡、assistant 消息、inline `code`、块级代码块、链接、blockquote、表格
- [ ] **Tool call 卡片**：休眠（折叠）、激活（展开）、success / error / running 三种状态
- [ ] **附件 / 文件面板 tab 栏**：active tab、非 active tab、tab close 按钮（X 在 active tab 上要可见）
- [ ] **Markdown 编辑器**：Preview / Edit segment control、toolbar 按钮 active 态
- [ ] **设置弹窗 / popover / context menu**：底色（应是 `bg-floating`）、item hover（应走 accent）、阴影边界
- [ ] **Toast**：success / warning / error 三色左侧状态条
- [ ] **Resize handle**：hover 时变 accent
- [ ] **Modal**：底色 + 遮罩对比度

> Inline code 是最容易翻车的位置之一。如果 `--text-inline-code` 选的色相和 `--text-primary` 太接近，inline code 看上去就和正文一样了。

---

## 7. 常见翻车

- **bg-selected 和 bg-floating 选了相同值** —— 某些主题下凑巧同值能看，复制到新主题就是定时炸弹。强制要求两者不同（除非主题真的接受 selected = floating 的视觉）。
- **shadow 用了 `rgba(0,0,0,...)`** —— 暖底主题上发青。统一用 `rgba(var(--shadow-base), ...)`。
- **`--accent` 太亮，覆盖范围失控** —— §4 的覆盖上限不因主题切换而放宽。一行内最多两处带 accent。
- **inline code 用了 `var(--accent)`** —— 长 token（路径 / 文件名）会比真小标题还跳；`--text-inline-code` 要与 accent 区分、与 text-primary 有色相差。
- **忘了在 `THEMES` 数组里加一项** —— Settings 里看不到新主题选项（但手工设 `data-theme` 到 `<html>` 仍可工作，用作调试入口）。
- **改完没重启 dev server** —— Vite HMR 对 `@import` 链路偶尔失效；切主题没反应时优先重启。
- **一个组件的 mode/variant 分支替换了带 `data-*` hook 的 identity/control 原语** —— 凡主题靠 `data-*` hook 识别并 painting 的原语（channel `#` = `data-conversation-hash`、列表频道图标 = `data-channel-icon`、§3.6.1/§3.6.3 各 frame hook 等），任何 variant 都**必须复用同一段挂 hook 的 primitive**，只能控"是否展示 / 布局"，**不许**在分支里替换成裸 lucide / 新 DOM 形状或新造原语。换掉 primitive ⇒ 主题 selector 匹配不到 ⇒ 在有 sticker 配方的主题画成通用 glyph，且**只在那个主题暴露**（baseline 主题看不出）。这是"同组件不同 mode"最隐蔽的翻车点：同组件只保护共享 markup，管不了某 mode 自己新增/替换的元素。组件侧 header-variant 纪律见 `app-layout.md` §9。

## 8. 已有参考
- `apps/desktop/src/renderer/styles/themes/studio-light.css`（冷中性 hairline 范式：accent = action/state、绿 = agent 身份、明度阶梯做层级）
- `apps/desktop/src/renderer/styles/themes/slack-dark.css`（深色主题范式）
- `apps/desktop/src/renderer/styles/themes/forza6.css` + `forza6-components.css`（loud-festival 范式；§12）

---

## 9. 左侧 chrome 的纵向色梯度（per-theme 二选一）

应用左侧从外到内有 **4 个纵向区域**：

```
NavRail  →  Sidebar (channels) → SessionsSidebar  →  ChatArea
最左 icon       频道列表             会话列表           读区
```

主题对这 4 块的色彩处理可以走两条路。

### 9.1 平铺派（可选退化）

NavRail / channels / sessions 三块 chrome 全部 `var(--bg-primary)`，跟 chat 主区 `var(--bg-base)` 形成"框 vs 内容"的二分。简单、安全，但当 4 块同色时**眼睛抓不住焦点** —— 这是早期实测过的真实问题。适用：极简、低饱和、想让 chrome 完全隐形的主题。

### 9.2 梯度派（当前推荐）

把 4 块安排在一条 oklab 色线上，每往内一档稀释一次：NavRail 直接取 `--brand-primary`（色线最饱和端、"主信号"），channels / sessions 两档各用 `color-mix(in oklab, brand, var(--bg-base))` 按递减比例稀释（往内一档比例更低），chat 主区落到色线另一端 `--bg-base`（最浅，读区）。具体混合比例是 per-theme 手感调参，写在主题 CSS 里，不在本文固定。

视觉效果：从主题身份色 → 低饱和 sidebar → 更浅 sidebar → 读区纸色的连续过渡，**没有 hue 跳**，只有 saturation + lightness 同步衰减。

为什么用 `color-mix(in oklab, ...)`：oklab 是感知均匀色空间，比 sRGB 插值出的中间色更"自然" —— 尤其亮色到深色之间的过渡不会出灰泥色。

**调节口子**：
- 想换 base hue（橘 / 蓝 / 绿），改 `--brand-primary` 一个值，三档全部跟着重算
- 想 channels 更柔，把百分比调低
- 想 sessions 几乎隐形，把百分比调更低
- 整体加深，两个百分比一起往上提

**踩过的坑**：
- channels / sessions **各选一种独立 hue** 会导致 saturation 断层 + 温度断层，不协调。统一到一条色线后顺滑。
- "新主题不定义这三个 token" 会让 sidebar 瞬变透明黑 —— 必须显式 fallback 到 `var(--bg-primary)`。

---

## 10. 选中态 / hover 态状态机（跨组件统一）

NavRail 项 / channel / DM / session 这种**一级导航 row**，用同一套三档状态机，不要每个组件各发明一套。三档共用同一 border width（主题化，见 §3.1.2），差异只在 border color 与 background：

| 状态 | border color | background | 视觉读法 |
|---|---|---|---|
| default | 透明占位边 | 无 | 占位边但不可见 |
| hover | `--border-row-hover` | `--bg-row-hover` | selected 的弱一级预演 |
| selected | `--border-row-selected` | `--bg-row-selected` | 当前所在 |

**三个关键设计点**：

1. **default 上也占位**（用透明边），避免 hover/selected 切换时整行向内推 —— 常见的低级 layout shift bug。
2. **border width 必须主题化但显式定义**（`--sidebar-row-border-width`，见 §3.1.2）。selected 靠淡墨晕表达的主题可用更细的一档。默认主题同时挂在 `:root`，其它主题必须显式写，不能指望 fallback。
3. **border color 默认可同色，但由两个 token 控制**（`--border-row-hover` / `--border-row-selected`，见 §3.5.1）。背景承担 hover→selected 的 emphasis 梯度，边只决定 geometry。推荐设成同色，但有需要时（selected 想用更深锚色）也能各走各。

**适用范围**：
- ✅ 一级导航 row —— NavRail 项、Sidebar 的 channel / DM 项、SessionsSidebar 会话项、Workspaces / Members / Computers 等 `aside[data-sidebar]` 作用域内的导航 row
- ❌ 行内按钮 / toolbar / dropdown trigger（用各自的状态系统）
- ❌ Saved / 分组 header 等"动作"性质而非"导航选中"性质的按钮（继续用 `bg-bg-hover`）
- ❌ 主内容区的 row —— 即便复用 `.sidebar-row-border` 类只是为了拿宽度，也**不**自动接 row-state border 契约，走自己的 hover 词汇。需要纳入时给显式 hook 并补到 §3.5.1。

**主题间的退化**：组件层读取的 5 个 token（两个背景、border width、两个 border color，见 §3.5.1 / §3.1.2）新主题必须全部显式定义；想沿用旧视觉就让 selected/hover 背景退化到本主题等价色、border color 退化到 accent、border width 退化到默认档。

---

## 11. 下拉菜单的同心圆原则

下拉框（Select / Combobox / Picker）的容器与内层选项 item 必须遵循**同心圆原则**：

> **inner_radius = outer_radius − inset**
>
> 当容器圆角为 R、容器到 item 的内边距为 P 时，item 圆角应取 R − P。

### 11.1 半径 / 内边距的来源

容器圆角、容器→item 内边距、item 圆角三者都从**各主题自己的 token 簇**取值（radius / control-radius / chip-radius 等，见 §3.6.2 / §3.7.x），不在调用点 hardcode 框架默认。定好容器圆角 R 与内边距 P 后，item 圆角按同心圆公式 `R − P` 落到最近的命名档。base control 绝不直接用框架默认圆角（会绕过主题、且后续调 token 时带偏）。

### 11.3 适用范围

- ✅ Select / Combobox content 容器 + item
- ✅ 自定义 Picker 菜单 + item（如 Composer PickerMenu）
- ✅ Popover / DropdownMenu content + menuitem
- ✅ Command palette content + item
- ❌ 工具栏 / 行内 chip / tag（独立元素，不存在包含关系，不适用同心圆）

## 12. Component-skin 架构（token + component skin）

forza6 是首个走"token + component skin"两层的主题，不只是换色。其它主题加新 component-layer specialization 时，可以参考 forza6 的边界与 hook 约定。Token 层见 §3.1.3，本节聚焦 component-layer 的架构原则。

### 12.3 TSX 结构 hook 约定

特化全部走 CSS，TSX 只加 **theme-neutral 结构 hook** —— hook 名描述 DOM 角色，不带 forza6 语义。这样：
- 其它主题想做特化时复用同一组 hook
- TSX review 不会被主题词污染
- 主题切换不需要改 React 树

**canonical hook 清单以代码为准**：`rg -o 'data-[a-z-]+' apps/desktop/src/renderer/styles/themes/forza6-components.css | sort -u`。

**禁止用作 hook 的 attr**：
- 任何 `aria-*`（a11y 是产品契约，不能被 CSS 私吞）
- 任何含 `forza6` / 主题词的命名

### 12.4 不特化的（设计边界，避免噪声过载）

- 滚动条
- Tooltip 内容（小浮层）
- HoverCard 部分用例（仅 HoverPopover wrapper 走海报硬框）
- Select listbox（仅继承 lime hover，不加硬框）
- Settings 主体（保留默认）
- 黑底 member-strip（已撤回；token `--text-on-dark-pop` 留备未来）

### 12.5 关键架构原则

1. **三层 token 模型（L1-raw / L2-semantic / L3-zero-hex）**，三条硬规则，`appearance.test.ts` 锁定：
   - **L1 — Raw palette（唯一允许 hex 的地方）。** forza6.css 顶部 `--forza6-*` 原始色相块是品牌/festival 色相**唯一**可以写裸 hex 字面量的地方。改一个色相只改这里一处。（`--forza6-syntax-*` / `--forza6-indigo-*` 是 code-island 子系统的 theme-private raw，同属 L1。）冷中性 bg 阶梯和深饱和语义变体不是 festival 品牌色，暂不强制入 raw palette。
   - **L2 — 语义 token 全走 `var(--forza6-*)` 衍生。** forza6.css 的 `[data-theme='forza6']` **单个** root 块里，每个语义 token（`--brand-primary` / `--accent` / `--bg-row-selected` / `--task-status-*` / `--border-focus`…）的值都是 `var(--forza6-*)` 或其 alpha / `color-mix` 衍生，**不内嵌品牌 hex**。语义 token 名保持区分（per-role alias），值指向同一 raw 但不合并。alpha 形是允许的例外。
   - **L3 — `forza6-components.css` 0 hex（例外：data-uri / alpha / 几何）。** 组件特化层只读语义 token（必要时读 L1 raw，如 sidebar carrier），**不写品牌 hex 字面量**，也**不再有第二个 root-level token 重定义块** —— root token 的唯一定义点是 forza6.css。例外仅：SVG data-uri 里的 `rgba()`、纯 alpha 叠层、几何尺寸。
2. **Lazy variable substitution**：核心 token 用 `color-mix(in oklab, brand X%, var(--bg-channels-sidebar))` 类公式定义一次，scope 切换自动重新解析。Sidebar token 在 `aside[data-sidebar]` 局部 redefine，root 不受影响。
3. **Specificity > Tailwind utility**：`[data-theme='forza6'] [hook]` selector 是 (0,2,0)，稳赢 Tailwind utility (0,1,0)，不需要 `!important`。
4. **Hover→Selected 硬度递进**：hover（浅 lime + 黑边）→ selected（实心 lime + 黑边 + notch）→ inline（lime sticker 方角）→ send（magenta sticker + display caps）→ status badge → `#` 大号 magenta。每一档比上一档"更硬"。
5. **Status 配色阶梯**：todo 中性黑边 / in_progress HUD live cyan / in_review 高注意 magenta / done passed muted green。lime 不进工作流状态色（避免和 done/pass 撞语义）。
6. **WCAG 必须不让步**：任何"主观感觉应该换色"的提议先算对比度。

### 12.6 验证

- `pnpm --filter @silverhand/desktop typecheck`
- `pnpm --filter @silverhand/desktop test`（跑 appearance.test.ts 的主题结构守卫）
- 切到 forza6 → 切回 studio-light 的来回测试，无 token 残留
- 颜色对比度走 WCAG 2.1 AA / AAA

### 12.7 可复用模式

从 forza6 特化中沉淀的五个跨主题可复用配方（当作设计规则用，具体 CSS 值以主题 CSS 为准）。

**(1) Pane hero sticker 配方**。把"高识别度小标"提炼成一个换 hue 即跨语义复用的配方，挂在结构 hook 上：填充走语义色、glyph 走对比 ink、硬边 + 直角 + 无模糊的硬冲压投影，构成海报"贴纸"质感。尺寸/间距由 consumer 外层控制，hook 只画 identity（fill/border/glyph/shadow）—— 见 §12.3 的 theme-neutral 约定。这是 hook 禁区的范式：hook 只 painting identity，layout 推给消费者。

**(2) Modal poster chrome**。对话框类表面走 ink 硬框 + 硬投影 + 归零 radius 的海报形态。**opt-in 而非 `[role='dialog']` 全选**：Lightbox 也是 Radix Dialog 但不该吃海报框，所以用显式 hook 让它按需退出。

**(3) Floating-frame token 簇**。base 组件（Input/Textarea/Button/Dialog/Select）不准 hardcode 框架默认边框/圆角，必须消费统一的 control/floating border + radius 簇。否则主题切换只有 utility-level 一致、base-level 分裂；这类 debt 常被外层补偿（ring outset shadow 撑厚边）掩盖，**删补偿层的瞬间才暴露**。

**(4) 焦点契约（硬规则）**：
- **utility 状态绝不用饱和 hue**。focus / hover / splitter / row-hover / control-hover / 焦点框都是 utility → 走中性 ink 词汇（`--border-focus`）。`--border-focus` **钉死在 token 层，不准在 component 层重定义**（appearance test 锁）。
- **例外：brand-anchored 主舞台**。composer 这种用户核心 anchor 的 focus 是 brand identity 高光，保留品牌色 —— 用 element-scoped `:focus-within` 覆盖，不动全局 token。判断标准：是不是"主舞台"？是→brand focus；否（一般 input/select/button）→ink focus。
- **focus 变厚 = ring 不是 border**。要"focus 只换色不变粗"就删 ring 只换 border-color —— 前提是控件本就有可见 resting border。无 border 的控件（fill button / icon / chip）ring 是它们唯一 focus a11y 信号，**不能删**。
- **hover→focus 不能跨色族**。同一控件 hover 一色 + focus 另一色族 = click 瞬间色彩跳跃。复合 hover-border token 让 hover/focus 跨主题各自同族。

**(5) 在线状态点（presence dot）**：复用 app 既有 active 点色 `--success`（与 WORKSPACES 活跃点同款）。presence/online=绿是 app 既定约定，新做 presence 指示直接复用，**不算违反"饱和 hue 独占语义"**。批量数据用 `useAgentsPresence`（`useQueries` 拉 N 个 `/runtime-state`，共享 `useAgentRuntimeState` 的 query key + 节奏）。

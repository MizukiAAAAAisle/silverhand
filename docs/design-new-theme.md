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
| `--bg-island` | 岛屿底色（代码块、JSON、终端、表格） | 中性灰，与 ocean 形成材质对比；warm 是冷中性灰 `#ECEAE5`，shadcn 因为本身灰白可与 `bg-primary` 同值 |
| `--bg-island-deep` | 表头、嵌套岛屿 | 比 island 略深 |
| `--bg-nav-rail` | NavRail（最左 icon 栏）底色 | 主题最强的一档信号色，或退化成 `var(--bg-primary)`（详见 §9） |
| `--bg-channels-sidebar` | 频道列表栏底色 | 与 nav-rail 同色家族、saturation 低一档；或退化 |
| `--bg-sessions-sidebar` | 会话列表栏底色 | 同色系最浅；或退化 |

**关键：`--bg-selected` ≠ `--bg-floating`**。这是踩过坑的拆分（详见主文档 §9.5）。warm 下两者凑巧都是 `#FFFFFF`，shadcn 下必须分别给值（selected `#F3F3F3`、floating `#FFFFFF`），否则 `bg-elevated` 容器里的激活态会消失。

**关键 2：三个 sidebar token 是 per-theme 可选项**。warm-coral 这种"留白派"主题让它们全部 `var(--bg-primary)`，左侧 chrome 一片同色。paper-ink 这种"梯度派"主题让它们沿一条 oklab 色线递减——见 §9。**新主题里这三个 token 必须给值**（哪怕都退化到 `var(--bg-primary)`），否则切换主题时 NavRail / sidebar 会瞬变成透明黑。

### 3.2 文字

| Token | 用途 |
|---|---|
| `--text-primary` | 正文 |
| `--text-secondary` | 副标题、metadata |
| `--text-muted` | 三级文字、占位 |
| `--text-inverse` | 反色文字（少用） |
| `--text-island` | 岛屿（代码块）内的文字 |
| `--text-inline-code` | 行内 `code` 字色 —— **每个主题独立选**，见主文档 §7 选色三原则 |

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

### 3.6 阴影 + 浮层 base

| Token | 用途 |
|---|---|
| `--overlay-backdrop` | modal 后面的遮罩 |
| `--shadow-base` | RGB 三元组（如 `31, 27, 22`），其它 shadow 通过 `rgba(var(--shadow-base), 0.x)` 引用，方便整套阴影暖/冷统一 |
| `--shadow-popover` | 浮层双层软阴影（参考主文档 §15 规格） |
| `--shadow-modal` | modal 单层大扩散 |
| `--shadow-button` | 按钮阴影（可选） |

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
/Users/shiki/workspace/webskill-repos/api-anything/electron/src/renderer/src/styles/themes/warm-coral.css

---

## 9. 左侧 chrome 的纵向色梯度（per-theme 二选一）

应用左侧从外到内有 **4 个纵向区域**：

```
NavRail  →  Sidebar (channels) → SessionsSidebar  →  ChatArea
最左 icon       频道列表             会话列表           读区
```

主题对这 4 块的色彩处理可以走两条路：

### 9.1 平铺派（默认 / warm-coral）

NavRail / channels / sessions 三块 chrome 全部 `var(--bg-primary)`，跟 chat 主区 `var(--bg-base)` 形成"框 vs 内容"的二分。简单、安全，但当 4 块同色时**眼睛抓不住焦点**——这是 paper-ink 早期实测的真实 bug。

适用：极简、低饱和、想让 chrome 完全隐形的主题。

### 9.2 梯度派（推荐 / paper-ink）

把 4 块安排在一条 oklab 色线上，每往内一档稀释一次。NavRail 是色线最饱和端（"主信号"），chat 主区是另一端（最浅，读区），中间两档用 `color-mix` 自动派生：

```css
--bg-nav-rail: #FFD440;
--bg-channels-sidebar:  color-mix(in oklab, var(--bg-nav-rail) 55%, var(--bg-base));
--bg-sessions-sidebar:  color-mix(in oklab, var(--bg-nav-rail) 22%, var(--bg-base));
/* chat 主区使用 var(--bg-base) */
```

视觉效果：从饱和黄 → 蜂蜜麦色 → 淡奶黄 → ivory 的连续过渡，**没有 hue 跳**，只有 saturation + lightness 同步衰减。

为什么用 `color-mix(in oklab, ...)`：oklab 是感知均匀色空间，比 sRGB 插值出的中间色更"自然"——尤其是亮色到深色之间的过渡不会出灰泥色。

**调节口子**：
- 想换 base hue（橘 / 蓝 / 绿），改 `--bg-nav-rail` 一个值，三档全部跟着重算
- 想 channels 更柔，把 `55%` 调到 `45%` / `40%`
- 想 sessions 几乎隐形，把 `22%` 调到 `15%`
- 整体加深，两个百分比一起往上提（如 `70%` / `35%`）

**踩过的坑**：
- 一开始给 channels / sessions **各选一种独立 hue**（比如黄→沙绿），结果"霓虹挨着青苔"——saturation 断层 + 温度断层，不协调。统一到一条色线后顺滑了。
- "新主题不定义这三个 token" 会让 sidebar 瞬变透明黑——必须显式 fallback 到 `var(--bg-primary)`。

---

## 10. 选中态 / hover 态状态机（跨组件统一）

NavRail 项 / channel / DM / session 这种**一级导航 row**，用同一套三档状态机，不要每个组件各发明一套：

| 状态 | border | background | 视觉读法 |
|---|---|---|---|
| default | `border-2 border-transparent` | 无 | 占位 2px 边但不可见 |
| hover | `border-2 border-accent` | `bg-white/70` | accent 边 + 半透白底——"selected 的预演幽灵" |
| selected | `border-2 border-accent` | `bg-bg-selected` | accent 边 + 实白底 |

**两个关键设计点**：

1. **`border-2` 在 default 上就占位**（用 `border-transparent`），避免 hover/selected 切换时整行向内推 2px——这是非常常见的低级 layout shift bug。
2. **border-color 从 hover 到 selected 完全一致**（都是 `border-accent`），只在 bg opacity 上递进。视觉语义：边出现 = 候选，底变实 = 确定。早期版本让 hover 用减弱的 `border-accent/40`，看起来像"两种不同的状态"而不是"同一种渐进确认"。

**适用范围**：
- ✅ NavRail 项（icon 导航）
- ✅ Sidebar channel / DM 项
- ✅ SessionsSidebar 会话项
- ✅ 任何"一选一"语义的一级导航 row
- ❌ 行内按钮 / toolbar / dropdown trigger（用各自的状态系统）
- ❌ Saved / 分组 header 等"动作"性质而非"导航选中"性质的按钮（继续用 `bg-bg-hover`）

**主题间的退化**：`bg-bg-selected` 和 `border-accent` 都是基础 token，新主题只要把 `--accent` 和 `--bg-selected` 选对，这套状态机自动跨主题工作——**组件层不用判主题**。


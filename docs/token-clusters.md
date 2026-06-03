# Token Clusters — 骨架视图

> **范围**：把 `design-new-theme.md` §3 里散布在 PR-1..PR-12 的 60+ token 按"消费场景"重新分簇，每簇标 (a) 现有 token 数、(b) 单 accent 主题下的退化关系、(c) 是否值得在 dark 主题接入后做合并扫描。**这是一张审计入口表，不是合并 PR 蓝图**——真合并要等 slack-dark 主题落地后再回头扫描，让"3 主题的实际取值矩阵"驱动决策。
>
> **方法**：每簇展示形如 `cluster: token-list — degeneracy notes`。退化语义：`A ≡ B` 表示在单 accent 主题里 A 永远 alias 到 B（可能合并）；`A ⟂ B` 表示在所有主题里都各走各（必须独立）。
>
> **来源**：`themes/warm-script.css` (default light, 暖近黑 accent)、`themes/forza6.css` (loud festival, 三 accent + 黑结构)、`appearance.test.ts` (per-theme 强制契约 token 列表)、`var(--*)` 实际消费扫描 (~80 引用点)。

---

## A. 表面阶 / Surface ladder
*消费：所有 panel / chrome / chat 区域底色*

| token | warm-script | forza6 | 备注 |
|---|---|---|---|
| `--bg-base` | #F8F6F2 | #F7F8F6 | global window |
| `--bg-primary` | #F3EFE8 | #ECEEEB | 一级 |
| `--bg-elevated` | #EAE6DE | #E5E8E4 | 二级 |
| `--bg-surface` | #E1DCD3 | #DDE0DC | 三级 |
| `--bg-app` | #ECE9E2 | #FF2C7A | frame 底（panel 之间露出） |
| `--bg-chat` | #FFFAEF | #F7F8F6 | 主读区 |
| `--bg-floating` | #FFFFFF | #FFFFFF | 浮层（最亮一档） |
| `--bg-island` / `--bg-island-deep` | 暖灰 | 深青 | 代码岛 |

**簇边界**：base / primary / elevated / surface 是经典 4 阶；chat / floating / app / island 是**专项独立** token（不能合并阶里的，因为各有完全不同的语义边界 — chat 是阅读舒适度、floating 是层级最亮、app 是 frame、island 是材质对比）。**判定：保持现状**。

## B. Sidebar 色梯度（NavRail → Channels → Sessions）
*消费：左侧 chrome 4 列纵向衰减*

`--bg-nav-rail`, `--bg-channels-sidebar`, `--bg-sessions-sidebar`, `--bg-nav-rail-hover`

**退化**：`design-new-theme.md` §9.1「平铺派」允许 3 token 全 alias 到 `--bg-primary`。warm-script 实际是「卡片派」(NavRail 品牌黄, channels/sessions 近白独立)。forza6 走 oklab 渐变。**判定：保持现状**——3 token 是真有差异，单独定义是必须的。

## C. 行状态 / Row state（导航 row 三档状态机）
*消费：sidebar/workspaces/channels 一级导航 row*

`--bg-row-hover`, `--bg-row-selected`, `--border-row-hover`, `--border-row-selected`, `--sidebar-row-border-width`

**退化**：warm `--border-row-hover ≡ --border-row-selected ≡ --accent`；forza6 同色但走 `--forza6-ink`。**判定：观察**——若 slack-dark 也是双 token 同值，可以考虑塌缩为 `--border-row` 单 token，但要等三主题确认。

## D. Hover 表面 / Hover bg
*消费：通用 hover 反馈、可选 row preview、NavRail icon hover、active*

`--bg-hover`, `--bg-active`, `--bg-row-hover`, `--bg-option-hover`, `--bg-nav-rail-hover`

**退化**：warm `--bg-option-hover ≡ --bg-hover`；forza6 拆分（option = pale lime, hover = cool-neutral）。**判定：观察**——是否真需要 `option-hover` 独立目前只有 forza6 这一个真消费点；slack-dark 大概率会 alias 回 `--bg-hover`。

## E. CTA 表面 / Primary control surface
*消费：dialog Create/Save 主按钮、Settings save、注册主按钮*

`--bg-control-primary`, `--bg-control-primary-hover`, `--text-on-control-primary`

**退化**：warm `--bg-control-primary ≡ --accent`，`--bg-control-primary-hover ≡ --accent-hover`，`--text-on-control-primary ≡ --text-on-accent`（pixel-zero 复用 accent 家族）。forza6 必须拆（accent 兼任 foreground 被压暗）。**判定：保持现状**——这是 forza6 最有教育意义的拆分，文档完备，不动。

## F. Accent 家族
*消费：CTA 边线、链接、active 节点、focus ring、selection 高亮*

`--accent`, `--accent-soft`, `--accent-hover`, `--accent-glow`, `--accent-2`, `--text-on-accent`, `--text-on-accent-2`

**退化**：warm `--accent-2 ≡ --accent`（单 accent 主题）；forza6 三 accent (pink-deep / cyan / lime)。**判定：保持现状**——`accent-2` 是 forza6 的 surface-only token，warm/slack-dark 退化无问题。

## G. 语义色 / Semantic
*消费：success/warning/error 文字 + soft 状态卡底色*

`--success`, `--success-soft`, `--warning`, `--warning-soft`, `--error`, `--error-soft`, `--text-on-{success,warning,error}`

**判定：保持现状**——9 token，用法清晰。soft 永远是同色 alpha 派生，但写显式比 `color-mix` 在每个主题手动调 alpha 的可读性更好。

## H. 描边 / Borders（hairline 簇）
*消费：通用描边 / 极淡分隔 / 岛屿 / focus / 头像 / row state(C 簇)*

`--border`, `--border-subtle`, `--border-island`, `--border-focus`, `--border-avatar`, `--border-avatar-width`, `--control-border-width`, `--sidebar-row-border-width`, `--floating-border` *(shorthand)*, `--border-inline-code`, `--border-task-tag`

**退化**：3 个 width 都是 1px (warm) / 2px (forza6) — 看似可以合并到 `--border-width-default`，但 control / sidebar-row / avatar 不是同一节奏（avatar 在 forza6 = 2px 用来"hardening 头像边缘抵抗 neon 背景"，跟 control 加粗的 hard-cut 语汇不是同一件事）。**判定：观察**——dark 主题接入后再看 width 是否真需要 3 个。

## I. 圆角 / Radii（最容易碎片化的簇）
*消费：所有圆角表面 + 所有 size variant*

```
基础尺寸：    --radius-sm/md/lg/xl
专项：       --card-radius / --control-radius / --chip-radius
浮层专项：    --floating-radius / --floating-item-radius
            --select-content-radius / --select-item-radius
特殊：       --radius-inline-code / --profile-section-radius
```

**12 个圆角 token**，是当前最碎片化的簇。退化关系：
- warm: card 8 / control 6 / chip 4 / floating-md 10 / floating-item-sm 6 / select-content 6 / select-item 4 / inline-code-sm 6
- forza6: 全部归零（poster hard-cut）

**真问题**：很多对在两主题都同值（warm `--control-radius == --select-content-radius == 6`；forza6 `--control-radius == --select-content-radius == 0`）。但文档里强调过**字面值而非命名 alias 是有意的**（防止后续调整 `--radius-sm` 把 control 圆角带跑）。

**判定：dark 接入后做一次专项扫描**。提案方向：
1. 引入「角色 radius」三档：`--radius-control` / `--radius-card` / `--radius-chip`，`--floating-*` / `--select-*` / `--profile-section-*` 全部 alias 到这三档之一。这降到 ~5 个独立 token。
2. 保留 `--radius-sm/md/lg/xl` 作为命名梯度供调用点直接消费（不要被 token 强制接管）。
3. `--radius-inline-code` 是真独立（warm 给 sm，forza6 给 0）— 不合并。

## J. Floating frame（浮层外框 + 内层 item）
*消费：DropdownMenu / ContextMenu / popover-frame / dropdown-frame*

`--floating-border`, `--floating-radius`, `--floating-item-radius`

**判定：保持现状**——3 token 紧凑契约，文档清晰，不动。

## K. Task status badge（5 状态 × 3 维 = 15 token）
*消费：5 处 chip 渲染（kanban / drawer / TaskRef / SystemMessage / TaskStatusPill）*

`--task-status-{todo,in_progress,in_review,done,closed}-{bg,text,border}`

**判定：保持现状**——专门 namespace（`--task-status-*` 而非通用 `--status-*`）已经把它框死在 ~10px poster chip 这一类。15 token 看着多但都在打这一个表面，必要。

## L. Inline-code chip（4 token）
*消费：`.markdown-body :not(pre) > code`*

`--bg-inline-code`, `--border-inline-code`, `--radius-inline-code`, `--text-inline-code`

**判定：保持现状**——chip 是 markdown 里高频表面，per-theme 取值差异大（warm soft ink-wash, forza6 lime poster sticker），不能合并。

## M. Chrome label utility（3 token）
*消费：`.chrome-label` 工具类，~30 callsites*

`--font-chrome-label`, `--chrome-label-tracking`, `--chrome-label-transform`

**判定：保持现状**——窄契约的好范式（size/weight/color 不进 token，只抽 per-theme 决策），保留。

## N. Pattern / structure / display pop（forza6 特化簇）
*消费：仅 forza6 component layer*

`--bg-pattern-image`, `--bg-pattern-opacity`, `--bg-structure-dark`, `--text-on-structure`, `--text-on-dark-pop`, `--font-display`

**退化**：单 accent 无纹理主题全部 degenerate 到 sibling（pattern → none, structure-dark → text-primary, display → sans）。**判定：保持现状**——这是 forza6 唯一真特化的簇，contract 已锁定。

## O. Frame 几何（card frame 模式）
*消费：App frame, splitter, titlebar*

`--frame-padding`, `--card-radius`, `--card-shadow`, `--splitter-bg`, `--splitter-offset`, `--titlebar-border`

**判定：保持现状**——6 token 都是 frame 模式的几何参数，主题间差异小但都是真消费。

## P. Brand identity（行内品牌色）
*消费：NavRail bg、selected fill、task tag*

`--brand-primary`, `--text-on-brand`, `--text-nav-rail`, `--text-nav-rail-hover`, `--bg-task-tag`, `--text-on-task-tag`, `--border-task-tag`

**判定：保持现状**——brand-primary 已经是 forza6 raw palette 的 L2 alias 入口，task-tag 三件套是 message header 后挂 task 的视觉契约。

## Q. Markdown / 字号
*消费：`.markdown-body` 内部尺寸*

`--md-prose-size`, `--md-code-size`, `--system-message-size`, `--inline-code-size`, `--chat-font-size`

**真问题**：`--chat-font-size` 在 warm=15, forza6=14（不一致），切主题瞬间字号会变。其它 4 个跨主题统一（14/14/12/0.88em）。**判定：合并扫描时统一 `--chat-font-size` 到 14px**——一次纠正，不影响其它。

## R. Schedule pill / 其它专项
*消费：schedule banner / event surface*

`--forza6-indigo-slab`, `--forza6-indigo-meta`, `--forza6-indigo-select`, `--forza6-syntax-*` (8 个)

**退化**：`--forza6-*` 是 theme-private raw（design-new-theme §12.4.1 锁定），其它主题不定义。**判定：保持现状**——按设计就是不进跨主题契约。

---

## 合并扫描建议（slack-dark 落地后回看）

按动手成本与回报排序：

1. **【低成本高回报】** 簇 Q：统一 `--chat-font-size` 到 14px。1 行改动。
2. **【中成本中回报】** 簇 I：圆角 token 收敛到「角色 radius」三档 + alias。会动 ~10 处 token 定义和 ~30 处消费点；需要 pixel-zero 验证；有 forza6-components.css 的回归风险。**等 slack-dark 后做，dark 主题对圆角的取舍能给第三只眼。**
3. **【低成本低回报】** 簇 H：考察 `--*-border-width` 三件是否真需要分。slack-dark 三个都 1px → 倾向合并；forza6 三个都 2px → 也倾向合并。
4. **【中成本低回报】** 簇 C / D：`--bg-option-hover` 与 `--border-row-hover/selected` 的合并/同色检测——当 3 主题确认都是同色或都对齐时，可塌缩。

**不要碰**：B / E / F / G / J / K / L / M / N / O / P / R 簇（合并风险大于价值）。

---

## 现状盘点

- **总 token 数**：每主题 ~85 个（含 forza6 raw 12 个）
- **跨主题强制契约**：47 个（`appearance.test.ts` 锁定）
- **真退化（single-accent 主题里 alias 到 sibling）**：~15 个（accent-2 / option-hover / 5 个 forza6 special / chrome-label-display / on-control-primary 家族 3 / pattern 2 / structure 2 / dark-pop）
- **真独立（任何主题都各走各）**：~70 个

退化数量（~18%）说明契约**没有过度抽象**。膨胀的真症结在簇 I 圆角碎片化；其它簇的冗余感主要来自命名和文档密度，不来自结构本身。


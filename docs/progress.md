# 实施进度

> 状态记录：每完成一个里程碑追加一段。本文件只保留最近一段时期的日志；更早的历史会被裁剪掉（完整历史见 `git log` / 各 `docs/`）。

---

## 2026-06-25 — Thread 未读 per-stream read cursor（#task:1226，backend）

Thread（reply-cluster）未读不可发现：已读边界 `conversation_reads.last_read_seq` 是 per-conversation（主线 + 该 channel 下所有 thread 共用一个游标），算不出 thread 级未读。终局：read cursor per-stream 化，与已有的 per-stream freshness（`conversation_stream_heads`）对齐。canonical `docs/thread-unread-v1.md`（Cindy 三轮 spec review PASS）。

- **migration v51（`conversation_reads_per_stream`，foreignKeyEscape）** — `conversation_reads` 加 `thread_root_id`（NULL=主线），唯一性照搬 `conversation_stream_heads` 两条 partial-unique（SQLite 复合 PK 含可空列对 NULL 去重不可靠）+ root-invariant trigger（insert/update，镜像 stream_heads，防跨 conversation / 指向 reply 的坏游标）。**迁移 = eager seed**：存量每条 thread 一次性 seed 成旧主线游标值 → 升级无历史未读洪水，且稳态读模型零 fallback 分支（非 lazy+frozen-baseline，避 vestigial）。
- **`ConversationReadRepo` per-stream 化** — `markRead(threadRootId, seq)` 单调推进、两 partial-unique 对应两 ON CONFLICT target；新增 `unreadCountForStream` / `firstUnreadForStream`；channel/sidebar 聚合改 §3.5 roll-up `channel_unread = mainline_unread + Σ(followed-thread unread)`（非 followed thread 退出 channel count，弱 dot 兜底）。roll-up 谓词**只读 `thread_followers` 的 `principal_kind='human'` 行**做 followed 判定，绝不写——human attention ⊥ agent delivery（shiki 明令边界）。
- **mark-read snapshot（route `markConversationRead`）** — 推到 open-time snapshot 不到「当下最新」。非对称：thread 必传 `snapshot_seq`（缺失 400），主线可省（fallback mainline stream head，兼容旧 channel mark-read）；显式 `snapshot_seq > stream head` → 400 fail-loud。route 先做友好 400/404（thread_root 不属本 channel / 指向 reply），DB trigger 仅末端兜底、不漏成 500。schema `seq` 清迁为 `snapshot_seq`（无 agent CLI / 对外契约，不留 alias）。
- **`ThreadSummary`** 落 `unread_count`（per-thread，非 roll-up、非 follow-gated）+ `first_unread_message_id`/`first_unread_seq`（确定性跳转）+ `viewer_following`（followed→sticker / 非→dot），`listChannelThreads` 带 viewer 批量算。
- **`mention-cc.ts` `viewerHasNotReadMessage`** stream-qualify（per-stream 后每 (user,conv) 多行，必须限定 thread_root_id）。
- 测试：repo per-stream 独立游标 / 跨流不串、threads 填字段 + viewer_following、roll-up followed-gating；migration drift oracle 重生成。全 gate 绿（backend 1621 + shared/cli/host/server/desktop）。**UI 三表面（sidebar 单一 count / Threads list dot·sticker / reply chip）= Norman lane，等接前端。**

---

## 2026-06-18 — task-rail / chat-return 切换性能（#task:1168/1169/1170）

NavRail 顶层 section 切换卡顿三连。CDP 实测驱动（probe 见 `/tmp/cdp-taskrail.mjs` 进入 / `/tmp/cdp-tasktochat.mjs` 离开）。

- **#task:1168（commit `12c1da2`）** — 高亮与重视图解耦：`App.tsx` `deferredSection = useDeferredValue(appSection)`，NavRail 高亮读紧急 `appSection`（点击即亮），主视图分支读 deferred 值（重内容晚一拍渲）。配套 `React.memo(TasksSection)` + ref-backed `onJump` 是必要卫生——否则 deferred 离开时 urgent pass 反复重渲离场的重 TasksSection（曾致返回 chat 冻屏 3.5s）。
- **#task:1169（commit `74442cd`）** — Kanban 列折叠态消化「量级」：五列恒等宽 `flex-1` 均分，Closed 默认折叠；折叠只不 render body/卡片（header/count/drop 原地留），列宽不变 → 零抖动且不引横滚。性能收益来自首屏卡片 1356→274（与列宽无关）。状态走纯内存 `useKanbanColumnCollapse`（module store，非 localStorage——per-viewer UI 偏好规矩见 `docs/list-sort-v1.md`）。

### #task:1170 — chat-return 残留卡顿（结论：A 保守，不改结构）

shiki：dev 下切回 chat 仍卡，release 不卡。CDP A/B 归因：

| 配置 | 进入·高亮 | 离开·高亮 | 离开·ChannelView mount | 离开·blocked |
|---|---|---|---|---|
| HEAD（defer✓ strict✓） | 16ms | 10ms | 650ms | ~530ms / 5-6 longtask |
| StrictMode✗（defer✓） | — | 9ms | 322–441ms | 160–340ms / 2-4 |
| defer✗（strict✓） | 124–185ms | 23ms | 496–520ms | 416–439ms / 5 |

- **残留卡顿 = ChannelView 外壳 remount（~500–650ms）**，被 dev `<React.StrictMode>` 双挂 ~翻倍。**注意不是消息条数**——消息列表本身已是虚拟化的（`ChannelView.tsx` 用 react-virtuoso + `messageListVirtualization.ts`）；重的是外壳：composer / MemberStrip / 头像批量 fetch / Virtuoso init / effects。release 无 StrictMode + minified ≈「strict✗」行 → release 顺 / dev 卡的真因。这部分是 **dev artifact，不为它动结构**。
- **`deferredSection` 保留（不删）**：A/B 证明它在「进入」方向仍值钱（进入高亮 16ms vs 删后 124–185ms，274 卡的板同步挂载会挡高亮）；对「离开」只小赚 ~110ms，且离开大头是外壳 remount 非调度。
- **决策 = A（shiki 拍）**：dev 残留卡顿是 StrictMode artifact，不为它删 defer / 动 ChannelView 结构。**future trigger**：万一日后 release 也出现 chat remount stutter（慢机器 / 外壳更重），正解 = **拆 ChannelView 外壳懒挂，或 keep-alive chat 子树**——**不是「加虚拟化」（列表已虚拟化）**。两条结构解里 keep-alive 代价更大且非 `display:none` 小改：`ChannelView.tsx:251-260` 写死「mounted == visible → 收到消息即 mark-read」，后台常驻会破坏未读计数，keep-alive 必须连带给 mark-read 加可见性门。优先考虑「外壳懒挂」（不背后台生命周期债）。

### #task:1170 后续 — 「点击 rail 绝不卡」感知层 split（shiki 拍 go）

shiki 澄清真实目标：**点击 rail 这一步绝不许卡**（高亮 + 两 sidebar 必须立即出），conv view 数据加载卡可接受。原结构里两 sidebar 和 ChannelView 一起挂在 `deferredSection` 分支 → 入 chat 时一起晚一拍。Alice CDP（`<Profiler>`）实测三者 render 都 ~2ms，证明 sidebar 够轻、可安全提到 urgent。

- **改法**：顶层 section 从「`deferredSection` 互斥三元」改成「独立条件兄弟 + `SectionLayer` 包装」。**挂载/卸载仍由 `deferredSection` 驱动**（重 teardown 留延迟 commit），**可见性由紧急 `appSection` 驱动**（`SectionLayer` 切 `display:contents↔none`，过渡帧隐藏退场区但不卸载——真 unmount 在 deferred 追上后由兄弟条件触发，**非 keep-alive**）。chat 子树两 sidebar 走紧急 `appSection`（点击即出），只有重的 conv（ChannelView/SplitPane）gate 在 `deferredSection === 'chat'`、之前显 `ConversationViewSkeleton`。skeleton 门按**目的地**（`deferredSection === 'chat'`）非前驱，拦住「`appSection='chat'` 但 deferred 还停上一区」那帧露出旧内容。
- **本质 = 感知层**：deferred 长任务（TasksSection 拆除 + ChannelView effects，dev 被 StrictMode 翻倍）仍在跑，只是跑在已画好的 rail+sidebar 背后、不再冻屏。**不缩 CPU**——别据此删 defer。
- 文件：`App.tsx` + 新 `components/layout/SectionLayer.tsx` + `components/layout/ConversationViewSkeleton.tsx`。typecheck 干净 / desktop 957。Alice CDP 验「点击→rail+两 sidebar <1 帧、中间帧无旧内容、退场区最终真 unmount（非 display:none 常驻）」。

## 2026-06-05 — forza6 海报主题 rework + follow-up polish（#task:917/918/919/920，已验收 closed）

把 forza6 做成完整的「赛车海报」视觉系统（不只换色，走 **token + component-skin 两层**），七个 pane 通刷 + 一组 follow-up 打磨。四个 task 全部 closed。

### #task:917 — 海报风格 rework

七个 pane 通刷：chat header / tasks / members / computers / settings / splitter / composer。实现细节见 `docs/design-new-theme.md` §12「Forza6 component-layer 特化清单」。

**配色锁定（每个高饱和 hue 独占一个最高级语义）**：
- 粉 → channel `#` + unread + brand accent
- 黄 → tasks ✓ family
- 橙 → in_review
- 湖青深 → hosts identity
- 深绿 → done
- acid lime → 选中身份色

### #task:918/919/920 — follow-up polish

- **#task:918**：TaskCard 窄面板文字溢出（`flex-wrap` + `min-w-0` + `overflow-wrap:anywhere`，status badge `nowrap`）；`MessageItem` 相对时间 → 绝对 `MM/DD HH:mm`（hover tooltip 秒级），免 minute-tick 重渲染。
- **#task:919**：sidebar DM 行渲染 agent 上传头像（`useAgentAvatarObjectUrls` 批量 hook，`(id, avatar_url)` cache key + `?v=updated_at` cache-buster，runtime icon fallback）。
- **#task:920**：焦点/边框系统收敛 + base 组件 token 对齐一大组：
  - bordered Input/Select/Textarea 删 focus `ring`、只换 border 色（ink）；borderless 控件（Button/icon/chip）保留 ring 作 a11y。恢复 2px resting border via `--control-border-width`（根因：base 组件 hardcode Tailwind `border` 默认被 ring outset shadow 掩盖，删 ring 才暴露）。
  - composer 保留 brand-pink focus（brand-anchored 主舞台例外，`[data-composer-shell]:focus-within` element-scoped，不动 `--border-focus` token）；filter trigger hover → `--border-control-hover`，消除 hover→focus 跨色族闪烁。
  - member-picker triggers + Dialog primitive 接 floating-frame token 簇；forza6 dialog + ImagePreviewModal 加 2px ink frame + hard drop shadow（`data-modal-shell` opt-in，Lightbox 不吃）。
  - ImagePreviewModal Save=primary、Copy/Cancel=neutral（产品层级清理，非视觉降饱和）。
  - archived item + saved header 的 `#` → channel chip sticker（`data-channel-icon` 配方复用）。
  - message search Sender + Workspace(DM) filter dropdown 显示真实 human/agent 头像，解析不到回落 person/Bot glyph。
  - 空 WORKSPACES 提示里内联 `+` chip → 正方形 + `--control-radius`。
  - Members AGENTS 状态点接入实时在线状态（`useAgentsPresence` 用 `useQueries` 批量拉 `/runtime-state`，复用 `useAgentRuntimeState` query key + 5s 轮询；`starting`/`active` → 绿点 `--success`，其余灰；判定口径同 AgentHeader presence pill）。

**v6.10.x 焦点色 lesson（沉淀为通用设计原则）**：utility 状态（focus/hover/splitter/row-hover/control-hover）绝不用饱和 hue → 走 ink/中性；**例外**：brand-anchored 主入口（composer）的 focus 是 brand identity 高光，可保留品牌色。hover→focus 不能跨色族（同色族或复合 token cluster）。详见 `notes/user-preferences.md` 视觉系统层。

### Gates

每个 commit 各自 `pnpm --filter @silverhand/desktop typecheck` + `./scripts/test.sh --scope desktop`（770 pass / 62 files）全绿。917 squash 为单 commit `8bdeb17`（base `9c5bbb7`）；918/919/920 follow-up squash 为单 commit `978ee1d`（base `3e32f83`）。

## 2026-06-01 — 打包 .app 无法打开修复 + electron-builder 25→26 升级

### 症状

`./scripts/package.sh` 产出的 `Silverhand.app` 双击无法打开（dmg 安装后被
Gatekeeper 硬拦）。

### 根因

`electron-builder.yml` 的 `mac.identity: null` 被误以为是"用本地 codesign
做 ad-hoc 签名"，实际在 electron-builder 里 `identity: null` 是**完全跳过签名**
（`app-builder-lib` `macPackager.js`：`if (qualifier === null) { ...; return
false }`，日志 `skipped macOS code signing`）。本机也没有任何 codesigning
身份（`security find-identity -v -p codesigning` → 0 valid）。于是产物只带
Electron 自带的 stub 签名（`Identifier=Electron`、`Info.plist` not bound、无
`CodeResources`），被 macOS 判为无效 bundle → 无法打开；dmg/zip 再叠加
quarantine xattr → 硬拦。

### 修复

新增 `apps/desktop/scripts/afterPack.cjs`，经 `electron-builder.yml` 的
`afterPack:` 挂载：在 `.app` 组装完成、dmg/zip 生成**之前**执行
`codesign --deep --force --sign -` + `--verify --deep --strict`。
- 选 `afterPack` 而非 `afterSign`：当未发生签名时 electron-builder 会跳过
  `afterSign`（`skipping "afterSign" hook as no signing occurred`）。
- 保留 `identity: null` 让内置签名干净 no-op，hook 成为签名的唯一来源。
- 修正了 `electron-builder.yml` 与 `docs/build-release.md` 里"null = ad-hoc"
  的错误注释。
- 结果：`Identifier=com.silverhand.desktop`、`Info.plist` bound、
  `--verify --deep --strict` 通过。ad-hoc 仍会 `spctl -a` rejected（故
  `gatekeeperAssess: false`），清掉 quarantine 即可打开。

### electron-builder 25.1.8 → 26.8.1

- 26.0.0 的 breaking changes 与本项目配置无交集：移除 `winOptions`/`macOptions`
  的废弃字段（我们用的 `win.signtoolOptions`/`mac.notarize` 都没用到）、
  `.desktop` actions（Linux）、node_modules 子目录支持（内部）；asar 引擎换成
  官方 `@electron/asar`（兼容）。已知 26.0 回归 #9092（缺 `.exe`）是 Windows-only。
- 升级后无需改任何配置。`./scripts/package.sh --dir` 通过，afterPack 签名正常。
- 新增一条无害告警：`arm64 requires signing, but identity is set to null and
  signing is being skipped`（我们的 afterPack 已覆盖）。`@tailwindcss/oxide-*` /
  `lightningcss-*` 的 "dependency not found on disk" 也无害（其它平台的可选原生包）。

### electron-builder 26 dmg 步骤 404（后续修复）

完整 `package.sh`（带 dmg）在 v26 下报 `404` 拉
`cdn.npmmirror.com/binaries/electron/dmg-builder@1.2.0/dmgbuild-bundle-arm64-*.tar.gz`。
- 根因：v26 的 dmg-builder 改用 `@electron/get` 下载一个自带的 `dmgbuild`
  bundle（Python 工具链）。`@electron/get` 的 `mirrorVar` 读 `ELECTRON_MIRROR`
  的优先级**高于** dmg-builder 传入的 mirror（github electron-builder-binaries），
  于是 package.sh 给 electron 二进制设的 `ELECTRON_MIRROR`（electron 路径）劫持了
  bundle 的 URL，指到一个没有该文件的 npmmirror electron 路径 → 404。
- 修复：`scripts/package.sh` 新增 `stage_dmgbuild_bundle()`，在 dmg 构建前
  从 electron-builder-binaries 镜像（github 兜底）预拉 bundle、按 dmgUtil.js 里的
  sha256 校验、解压，导出 `CUSTOM_DMGBUILD_PATH` 指向解压出的 `dmgbuild`——
  dmg-builder 优先用这个环境变量，彻底跳过网络解析。release/version/arch/校验和
  都从已安装的 dmg-builder 源码里解析（经 electron-builder 链式 resolve，因为
  dmg-builder 是 pnpm 传递依赖），升级 electron-builder 后自动跟随，不写死。
- 结果：zip + dmg 均构建成功，`Silverhand.app` `--verify --deep --strict` 通过；
  二次运行走缓存命中不再下载。`--dir` 构建不碰 dmg，故跳过 staging。

### 打包后启动崩溃：@node-rs/argon2 native binding（后续修复）

装好的 app 启动即崩：`Error: Failed to load native binding`，栈指向
`app.asar/node_modules/@node-rs/argon2/index.js`。
- 根因：`@node-rs/argon2`（backend `auth/password.ts` 用来做密码哈希，被
  electron-vite externalize）的原生 binding 在平台子包
  `@node-rs/argon2-darwin-arm64` 里。pnpm 把该可选依赖嵌套在虚拟 store
  （`.pnpm/@node-rs+argon2@2.0.2/node_modules/@node-rs/argon2-darwin-arm64`），
  没有 hoist 到顶层；electron-builder 不会把这种嵌套的可选原生依赖打进 asar
  （electron-userland/electron-builder#6289）。结果 asar 里只有 argon2 的 JS，
  没有 `.node`，loader 两条路径（`./argon2.darwin-arm64.node` 与
  `require('@node-rs/argon2-darwin-arm64')`）都失败 → 抛错。对比
  `lightningcss-darwin-arm64` 被 hoist 到顶层所以正常打进去了。
- 修复：在 `apps/desktop/package.json` 显式声明
  `optionalDependencies: { "@node-rs/argon2-darwin-arm64": "^2.0.2" }`
  （pnpm 据此把它链到 `apps/desktop/node_modules/@node-rs/`，electron-builder
  即可纳入），并在 `electron-builder.yml` 的 `asarUnpack` 加
  `node_modules/@node-rs/argon2-darwin-arm64/**/*` 让 `.node` 落到磁盘。
  没用社区常见的 `node-linker=hoisted`——那会重塑整个 monorepo 的 node_modules
  布局，冲击 better-sqlite3 的 ABI swap 机制。
- 验证：用打包后的 Electron 运行时（`ELECTRON_RUN_AS_NODE=1`）从 asar 里
  `require('@node-rs/argon2').hash(...)` 成功产出合法哈希；完整 dmg 重打通过。
  注意：旧的 `/Applications/Silverhand.app` 需用新 dmg 重装。

---

## 2026-05-30 — Remote backend D4.e-6：runtime_start 语义化 + M1 closure

### 背景

D4.e 把 host-local path 解析全部移交 daemon。D4.e-1…-5 切完
create/list/member-add/delete/read 五条数据面路径后，唯一残留是
`runtime_start`：backend 仍从 `workspace_path` 推导 agent-home 路径并把
`workspace.path` / `agent.home_dir` 下发到 wire（carve-out）。D4.e-6 撤销该
carve-out，是 **M1 closure 的最后一道闸**。

### 实现锚点

- **Wire（`packages/host/src/protocol.ts`）**：`runtime_start` workspace ref
  收窄到 `{id,name,kind}`、agent ref 到 `{id,name}`，均 `.strict()`；
  `home_dir` 加入 `FORBIDDEN_RUNTIME_START_OPTION_KEYS`（嵌套也禁）。新增
  `RuntimeStartErrorCodeSchema = {workspace_not_provisioned,
  registry_unavailable}`，按 per-command scoping union 进 `runtime_start` 的
  error schema（不让外来 typed code 漏到它的 error arm），outbound frame schema
  同步。
- **Daemon resolver（`daemon/runtime-start-resolve.ts`）**：
  `resolveRuntimeStartPaths(options, deps)` 把语义 ref →
  `ResolvedStartOptions`（内部带路径形态）：`agent_home` + `agent.home_dir`
  走 `computeAgentDir`，`regular` 走注入的 `resolveRegularWorkspacePath`
  （registry）。失败抛 typed `RuntimeStartResolveError`。Supervisor 在
  binary/prompt/spawn **之前** resolve（fail-closed：未 provision 的 regular
  workspace 不 spawn）；`run.ts` 把 `WorkspaceRegistryError` 映射成 typed code。
- **Backend builder（`runtime/runtime-start-options.ts`）**：纯语义，零
  `node:path`/`node:fs`、零 `workspace_path`/`home_dir`。
- **Backend bounded lazy backfill（`runtime/outbound-event-fanout.ts`）**：
  dispatch `runtime_start` 前，对它引用的 regular workspace（primary +
  memory-index；`agent_home` 跳过）先 `WorkspaceRegistryBackfiller.ensure`
  重新绑定。`ok`/`noop` → dispatch；`partial`/`failed` → 不 dispatch + 把已
  claim 的 deliveries rollback 回 pending（保留 retry 锚点）。这补上
  cold-start / hydrate→pending-replay 这条本会卡死 daemon-side fail-closed 的
  迁移洞（Cindy `2A_y70Aue5X1SlOr`）。
- **A1 dependency-guard（`dependency-guard-no-agent-host-fs.test.ts`）**：扩到
  path-emission 半边——runtime_start builder 不 import `node:path`/`node:fs`、
  不引用 host-path 字段；`home_dir` 在整个 `backend/src` 不出现。

### Gates

- `pnpm -r typecheck` clean（6 projects）。
- backend full 1458 pass | 1 skip（118 files）；host full 827 pass（37 files）。
- 新增：`runtime-start-resolve.test.ts`、protocol 语义-ref reject + typed-error
  taxonomy、supervisor fail-closed、2 条 runtime_start typed-error wire fixtures、
  fanout backfill-before-runtime_start（成功序 + 失败回滚）。

### 结论

A1/A2/A7 → DONE，I1/I6 完整成立。`docs/d4-e-acceptance.md` 收为 D4.e-1…-6
全闭，**M1 closure 可宣告**。Commit `bac9635`（D4.e-6 slice，已 squash；
整条 D4.e chain 在 handoff 时按 slice 各收 1 commit，base `eb35192`，
pre-squash 备份 tag `d4e-pre-squash-backup`）。

---

## 2026-05-30 — Remote backend D4.e-1 3b：workspace path 主权移交 daemon

### 背景

D4.e-1 的不变量 I1 = **daemon 是 host-local path 的唯一权威**。pre-D4.e
backend 直接从 `workspaces.workspace_path` 列推导并使用/下发 host fs 路径。
3b 把 create + list 两条路径切到 daemon 的两个 intent
（`workspace_provision` / `agent_workspace_index`），server 只说
`workspace_id` / `agent_id`，路径由 daemon 校验、绑定、解析。

shiki 定的方案 A（单 intent）：folder picker / 沙箱 typed path / legacy
backfill 统一走 `workspace_provision { workspace_id, kind, requested_path? }
→ { ok, provisioned, bound_workspace_path }`。server 永不解释路径——只转发，
daemon 校验+绑定。`bound_workspace_path` 是过渡 seam（backend 仅作为 legacy
`workspace_path` 列缓存，绝不再解释拼路径）。

### 切片与实现锚点

- **3b-1（`11e18bc`）create → provision**：新增
  `packages/backend/src/runtime/workspace-data-plane.ts`
  （`resolveOutboundForHost` + `mapDataPlaneError {code,status,retriable}` +
  `dispatchWorkspaceProvision` / `dispatchAgentWorkspaceIndex`）。`POST
  /api/workspaces`：先解析 host→adapter→预生成 id
  （`WorkspaceRepo.newWorkspaceId`）→ dispatch provision（body
  `workspace_path` → `requested_path` 逐字；缺省 → daemon 托管默认）→ 仅在绑定
  成功后 insert，`workspacePath = bound ack`（无 orphan row）。撤掉 standalone
  `workspace_path_not_supported` 409（server 不再解释路径）。
- **3b-2（`5fd0e76`）registry idempotent-first + backfiller**：
  - registry 不变量修正（窄化）：existing id 重新绑定到**它当前已持有的同一
    绝对路径** → 在 requested-path guards 之前直接 no-op
    （`isAbsolute(req) && resolve(req)===existing.path`）；unknown id / 不同
    路径仍走完整 managed-root/state-root/overlap 校验。让 managed-default row
    的 backfill 可幂等，恶意把别的 id 指向 managed root 仍被拒。
  - `runtime/workspace-registry-backfill.ts`：对某 host 每个 legacy regular
    row 用其 stored `workspace_path` 作 `requested_path` 重新 provision；只
    dispatch provision、不拼路径；只用 daemon ack 回写 legacy cache；返回结构化
    结果（provisioned/alreadyBound/failed + status noop|ok|partial|failed）；
    per-host in-flight guard；仅 full-ok 才 memoize，failed/partial 可重试
    （非 boot-once）。
- **3b-3（`47deb57`）list → daemon-stamped agent_dir**：`list_workspaces`
  删掉 `join(workspace_path,...)` 推导，改为
  `ensure(hostId)` backfill → `agent_workspace_index` → 用 daemon entries 填
  `agent_dir`。**单 owning-host 不变量**（I4）：`Set(workspace_host_id).size>1`
  → 显式 409 `workspace_host_ambiguous`（绝不跨 daemon 静默 fan-out / 不 partial
  泄漏），符合 M1 sticky ownership。fail-closed：offline/backfill 全失败 → 503
  `host_attach_pending`；index `unresolved`（含 partial-backfill 残留）→ 409
  `workspace_unresolved`；失败响应只有 `{error,code}`，永不 workspace_path
  回退。backfill **纯 lazy**（read-path 触发，无 boot warm-up——connect 时
  fire-and-forget provision 会打挂不建模该 intent 的 focused e2e；read path
  本身是正确性保证且可重试，Cindy 接受）。
- **3b-4（本次）renderer 最小 + 文档**：`CreateWorkspaceDialog` 按 host kind
  分流——local desktop host → 原生 folder picker 为主；remote / 沙箱 host →
  默认 daemon 托管目录 + “高级”手动输入路径（无本地选择器）。文案改为反映
  “路径由该 host 的 daemon 校验”。底层 IPC（`dialog:pickDirectory`）、
  host-provenance gate、`workspace_path` 可选透传此前已就位。

### Review / 协作

@Cindy 全程按 commit review（方案 A + 各红线）：requested_path 仅经
create→provision、bound_workspace_path 只作 legacy cache；read 严格 fail-closed
不回退；standalone 放开但 server 不解释；backfill 结构化不吞错、可重试；list
单-host invariant 用显式错误而非多 host fan-out。idempotent-first 收窄、
lazy-only 偏离、host-ambiguous 收口均已 Cindy 确认。

### 状态 / 质量门

- chain：3b-1 `11e18bc` → 3b-2 `5fd0e76` → 3b-3 `47deb57` → 3b-4 → 3b fixups。
  工作树 `silverhand-wt-d4-e`，**未 push**（按 shiki 纪律）。
- gates：`pnpm -r typecheck` ✅；backend full **1405 pass / 1 skip**；host
  **747 pass**；desktop typecheck ✅。
- I6 完整 dependency-guard（seedAgentL2 / runtime_start 仍读 workspace_path）
  顺延 D4.e-5；3b 只钉死 list DTO 不再从 workspace_path 推导。后续：slice ④
  adapter contract + parity e2e（embedded + standalone）。

### 3b review fixups（Cindy `3V4qEvxO` + `L-HIYiUYb75sBGpv`）

- **P1-1 初始 member seed gate 改为「共盘」判定**：seed gate 之前是
  `deploymentMode === 'standalone'`，挡不住 embedded 里显式选 owned
  `kind='remote'` host（`assertOwnedActiveHost` 不限制 host kind）的情况——
  那样会把 remote daemon 的 path 当 embedded 本机路径写（I1 违例）。改为
  「backend 与 owning host 共盘」才允许：`deploymentMode === 'embedded' &&
  host.kind === 'local'`，其余（standalone 任意 host / embedded+remote host）
  provision 之前 409 `workspace_member_seed_unsupported`（无 orphan bind / 无
  row）。pins：standalone+真 member、embedded+owned remote host+member 各一。
- **P1-2 backfill 收窄到「当前响应可见的 regular rows」**：原 `ensure(hostId)`
  枚举该 host 全部 regular row，会让同 host 上不可见/不相关的坏 legacy row
  挡住当前 agent 的 list（fail-closed 粒度错位）。改为
  `ensure(hostId, rows)`，由 list route 传当前 `listForAgent` 里的 visible
  regular rows；agent_home 仍由 daemon 按 homedir 解析、不入 registry。memoize
  改为 per-(host,id)、in-flight guard 改为 per-(host,id)。删除已无用的
  `WorkspaceRepo.listRegularForHost`。pins：同 host 非 member 坏 row 不进当前
  backfill（list 仍 200、该 id 无 provision call）；archived member row 仍被
  backfill 绑定并返回 daemon-stamped agent_dir。
- **P2 测试保真**：`FakeHostWsServerController` 的 `workspaceProvisionAckOverride`
  现在也把 override 的 `bound_workspace_path` 写入 in-memory registry，避免
  「ack 了但 registry 没写」的假象；list 的 kind-branched agent_dir 断言改为
  daemon-stamped 口径（只断言 shape，不从 workspace_path 反推）。

### 已知限制（future cleanup，非 3b 阻塞）

- **create 无 2PC，无补偿**：create path 是「daemon provision 成功 → DB
  insert」。若 insert 因唯一名 race / DB 错误失败，daemon registry 会留下一个
  orphan binding（无 cleanup intent 回滚）。它**不会污染 server read path**
  （孤儿 binding 无 DB row 引用，list/index 都不会解析到它），但会**占用 daemon
  registry 的 path 槽位**：registry 有 cross-workspace path overlap /
  `path_conflict` 校验，孤儿 binding 可能阻止后续用同一 `requested_path` 创建新
  workspace，需 future cleanup / 补偿。后续 acceptance doc 需显式标注此 no-2PC
  residue；彻底解法（provision + insert 的两阶段补偿，或 insert-first + 失败回滚
  provision）留作 future cleanup。


---

## 2026-05-30 — Remote backend D4.e-5: cleanup + A1 dependency-guard + acceptance doc

D4.e (daemon = sole host-local path authority) cleanup slice. With D4.e-2…-4
having routed every workspace/agent fs op through formal daemon intents
(`agent_workspace_read` / `agent_l2_seed` / `agent_files_purge`,
`workspace_provision` / `agent_workspace_index`), the backend's pre-D4.e
agent-host fs/path modules were dead. Removed from `packages/backend/src`:

- `workspace-files.ts` (workspace skeleton + L1 seed + templates) — daemon owns
  these now; embedded test fake's stand-in moved to a test-only clone
  `tests/utils/embedded-seed-fixtures.ts`.
- `agent-profile.ts` (`workspace_path`-derived agent L1/L2 path builders) — zero
  callers.
- Their unit tests deleted (real behavior covered by the daemon's own tests).

Added the **A1 structural guard** `tests/dependency-guard-no-agent-host-fs.test.ts`:
backend/src may import `node:fs` only from a documented backend-local-infra
allow-list (db / logs / blob storage / managed-root bootstrap / embedded auth).
Any new fs importer trips it. The guard's scope note records that the
path-EMISSION half of A1 (`runtime-start-options.ts` still emits a
`workspace_path`-derived agent-home path into `runtime_start`) is NOT covered —
it closes in **D4.e-6**.

Acceptance doc `docs/d4-e-acceptance.md` (A1-A7 matrix, commit chain, invariants,
test inventory). **M1 closure explicitly NOT claimed**: A7 open, A1/A2/I6 partial
until D4.e-6 (`runtime_start` semantic-ids) lands.

Gates: `pnpm -r typecheck` clean; backend 1451 pass | 1 skip (118 files); host
byte-parity 62 pass.

## 2026-05-31 — Activity indicator 方案 A：折叠进 Composer chrome（#task:748）

dogfood 反馈：旧 activity dock 的 hover-expand 浮层（#746）读感像 debug HUD
（detached floating overlay + 阴影 + 横向块 + light→heavy 跳变）。shiki 在 4 个
方向（A 内置 composer 状态头 / B 头像呼吸+hover / C 自写气泡 / D Cindy 的 composer
rail）中选定 **A**。

实现：
- 新组件 `apps/desktop/src/renderer/components/chat/ComposerActivityHeader.tsx`，
  渲染为 `Composer.tsx` 输入框 shell 盒子（`flex flex-col overflow-hidden rounded-md
  border …`）的第一个子元素，与 textarea 共用边框，无浮层/阴影/缝隙。
- 折叠态固定一行：`[图标] @agent [主状态 badge] [明细 snippet…(truncate)] [+N]
  [elapsed] [⌄]`，仅 snippet 弹性，其余 `shrink-0`。阶段切换不换行、不改高度。
- 主状态优先级 `statusRank`：`tool_running > compacting > thinking > starting`；
  tool badge 取最高 count 工具名 + `×总数`。多 agent 折叠按 `statusRank` 再
  `lastActivityAt` 取 top + `+N`；点击就地展开列出全部（同序）。
- 全 token 配色（forza6 等主题自动适配），带 `data-composer-activity` 主题钩子。
- 删除旧 `AgentActivityBubble.tsx`（`AgentActivityDock`）；`ChannelView.tsx` 移除
  dock 浮层挂载、footer h-14 占位（→恒 h-3）、scroll-button bottom-16 条件
  （→恒 bottom-4）、以及随之失效的 `activeRunStates` / `activityAgentsById` /
  `activityAnchorMessageId` / activity-jump 链路（A 常驻 composer 底部，跳回触发
  消息的补偿失去价值，移除 click-to-jump）。

Gates：`@silverhand/desktop` typecheck clean；desktop vitest 678 pass（52 files）。

## 2026-06-13 — Platform prompt 结构重排 + 设计契约文档（#task:1104/1105/1106/1111）

`packages/shared/src/platform-prompt.ts` 整段补丁累积的布局重排成一条精心设计的
骨架(commit `224af51`):行为契约前置、tool/format 参考后置、注入块留尾保 compaction
恢复。渲染顺序固定为 Operating Contract → Turn Workflow → This Context →
Knowledge Model → Collaboration Policy → Work Coordination(Tasks/Threads/
Channels/Members) → Capabilities(Attachments/History/Schedules) → Tool
Reference(CLI manual,从原先抢在契约之前的顶部降级到此) → Formatting Reference →
注入尾(Active Memory / Workspace Index / Initial role)。

- CLI manual 降级为 Tool Reference:contract + 一行一命令 index(每条留完整命令名) +
  pitfalls;三段 memory(Active Profile Files / What to memorize / Compaction
  safety)合并 Knowledge Model;etiquette + communication style 合并 Collaboration
  Policy;清掉口语句与历史补丁痕迹;修了几处把 Markdown code span 拆到换行的渲染瑕疵。
- load-bearing 内容只换位不删:claim "work not messages" 三处重复、stale-resolution、
  单引号 heredoc、system-no-reply、compaction checkpoint、Members 块安全转义
  (`quotePromptValue`/`pickFence` 逻辑未动)全部保留。
- 测试从精确措辞 guard 转 contract/容空白 guard,硬断言只留安全关键 + 必不可回归串 +
  机械 drift guard(flag-universe / JSON-field)。`platform-prompt.test.ts` 37/37,
  全仓 `pnpm -r typecheck` 过。CLI 事实零变更 → `docs/cli-system.md` 仍同步。

新增 `docs/platform-prompt-design.md` —— platform prompt 的**设计契约 / authoring
guide**:canonical 9 段骨架、load-bearing 清单、安全关键 renderer、one-home/透明原则、
跨 doc 同步、测试纪律、authoring checklist。CLAUDE.md 在 docs 列表与"编辑 platform
prompt"约定里点名"先读该文档"(#task:1111)。

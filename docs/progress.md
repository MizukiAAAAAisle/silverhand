# 实施进度

> 状态记录：每完成一个里程碑就追加一段。早于"今天"的内容只读、不改写。

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

## 2026-05-26 — Remote backend V1 prep Stage C.6：server-config bearer 退役

- `server-config.json.auth_token` 软退役：shared schema 只做 optional read-compat，新写配置省略该字段，desktop 不再生成随机 long-lived bearer。
- Public `/api/*` bearer 只接受 user session token；旧 server-config token 即使带 legacy viewer/principal header 也只是 401 invalid bearer。Host claim/list/revoke/rotate 继续要求 session bearer，但不再 special-case 旧 token。
- Event WS cookie 只校验 session token；不再读取 `serverConfig.auth_token`。
- `pnpm dev:headless` stdout 改为 `{ url, port, bootstrap_token_path, silverhand_dir }`，headless smoke 通过 one-shot `embedded-bootstrap` 文件调用 `/auth/embedded-bootstrap` 换取 user session bearer；Electron main 只在非 headless 模式自动消费 bootstrap 文件。
- docs 同步 `auth-and-host-model.md`、`protocol-purity-checklist.md`、`testing.md`、`cli-system.md` 等当前操作路径。

---

## 2026-05-26 — Thread/channel create initial prompt stdin-only 目标语义

### 背景

最近几个由 agent 创建的 Thread 首条消息只包含字面量 `@-`。取证结论：

- `silverhand thread create` / `silverhand channel create` 当前只把
  `--initial-prompt <text>` 当普通 argv 字符串读取，不读 stdin。
- `@-` 不是 Silverhand CLI 的 stdin 哨兵，也没有 backend 特判。
- heredoc 写入了进程 stdin，但 create 命令没有消费 stdin，所以 argv 里的
  `@-` 原样进入 `initial_prompt` 并落库。

### 决议

统一 heredoc 语义：后续实现中，`thread create` / `channel create` 的
`initial_prompt` 应与 `message send` 的 body 使用同一模型——从 stdin
直读，不再使用 `@-`、`@<path>` 或裸 `-` 这类哨兵。

目标 CLI 形态：

```bash
silverhand thread create \
  --title "Stage X" \
  --context-summary "Short recovery/audit summary." <<'SILVERHAND_EOF'
Initial prompt body.
SILVERHAND_EOF
```

具体边界：

- `--context-summary` 仍是 required inline string。它应该短、便于恢复和审计；
  真要多行时由调用方用 shell 变量捕获后传入。
- `--initial-prompt` 未来删除；旧 flag 必须报
  `validation_error/flag_removed`，并给 heredoc / pipe 迁移提示，不能退化成
  generic unknown flag。
- stdin fail-loud 行为对齐 `message send`：TTY stdin、0-byte stdin、invalid
  UTF-8 都直接失败。
- 不支持文件输入。文件输入会引入多余工具操作和临时文件，也会和
  Silverhand 的 `@<handle>` mention 语义产生不必要冲突。

### 当前状态

本次只先落文档决议。当前 CLI 尚未实现该目标语义，仍要求
`--initial-prompt <text>`；在实现 PR 合入前，多行 initial prompt 需要先用
shell heredoc 捕获到变量，再把变量作为 `--initial-prompt "$PROMPT"` 传入，
不要使用 `--initial-prompt @-`。

单独规范文档：`docs/thread-channel-create-initial-prompt-stdin.md`。

## 2026-05-21 — `silverhand-daemon` PR-1（AgentHost runtime boundary, IPC skeleton）

- **新 package `@silverhand/host`** 落地 `#task:510`。包含三块：
  - `src/protocol.ts` — NDJSON wire format + zod schemas（intent registry / response / event；`MAX_FRAME_BYTES = 1 MiB`；`splitNdjson` pure splitter）。
  - `src/daemon/*` — Unix-socket server + 三件套 intent (`ping` / `status` / `echo`) + 进程 lifecycle (pid file claim, `kill(pid,0)` 活性探测, stale 覆写, SIGTERM/SIGINT graceful drain)；`run.ts` 把 dispatcher + server + lifecycle 组合成 `runDaemon(opts)`；`entry.ts` 是 argv shim（`--socket-path / --pid-file / --log-dir [--stderr]`）。Stdout 仅保留 `ready` handshake；其它都到 `daemon-<utc>.log` JSONL（mirror backend logger 格式）。
  - `src/client/*` — `HostClient`：可插拔 `Transport`（socket 真品 + 测试用 in-memory fake）、pending-request 表、随机 id 关联、full-jitter exponential backoff（initial 250ms → cap 30s）、typed `HostClientError`（`disconnected | timeout | closed` + 5 个 daemon 端 codes）、`onReconnect` 钩子。
  - `src/spawn.ts` — `spawnDaemonChild({ launcher, socketPath, pidFilePath, logDir })`：fork Node 子进程，读 stdout 等 `ready` handshake，capped restart budget（默认 5/60s），`kill({ gracefulMs })` SIGTERM → SIGKILL fallback。
- **Backend `startBackend({ ..., hostClient? })`** 接受可选 `HostClient`。boot 时 `ping()` 一次，记 `daemon_pid + daemon_version`；失败仅 warn（PR-1 不上硬依赖）。PR-2 才把 `ConversationManager` 搬进 daemon、把 `hostClient` 变 required。
- **Electron main bootstrap**：在 `startBackend` 之前 `spawnDaemonChild` + `HostClient.connect()`；`shutdown()` 顺序 `backend.close() → hostClient.close() → daemon.kill(5_000)`；daemon 路径 `<silverhand-dir>/run/daemon.{sock,pid}`，日志 `<silverhand-dir>/logs/daemon-*.log`。Daemon 启不起来 → 整个 app 仍能 boot，只丢 host plumbing。
- **Packaging**：`scripts/dev.sh` 在 `pnpm --filter @silverhand/cli build` 后追加 `pnpm --filter @silverhand/host build`（esbuild ~20ms）；`apps/desktop/electron-builder.yml` 加 `extraResources` 把 `packages/host/dist/daemon.js` 装到 `silverhand-daemon/daemon.mjs`，复用 `process.execPath + ELECTRON_RUN_AS_NODE=1` 启动壳。
- **测试**：`packages/host/tests/` 37 tests 全绿（`protocol.test.ts` 14 / `dispatcher.test.ts` 7 / `host-client.test.ts` 10 / `e2e-socket.test.ts` 5 in-process real Unix socket / `spawn-daemon.test.ts` 1 真 subprocess 走 tsx）。整 repo `pnpm test` backend 820/820 + cli 131/131 + desktop 261/261；`pnpm -r typecheck` 4/4 包绿。
- **关键架构 invariant**（落档 `docs/silverhand-daemon.md`）：daemon 控制面**不暴露**成 `silverhand` 子命令——agent-facing CLI 永远只是 message/task/channel/thread/workspace/file/schedule；daemon 控制权（spawn/pid/version）属基础设施层。host 是真正的安全边界，socket file `chmod 0o600` 是 PR-1 的全部 authz；远端形态加 bearer token。
- **PR-2 hand-off**：搬 `ConversationManager`（spawn/inbox-drain/run-state）进 daemon，加 `runtime_start/stop/wake/inject_env` intent + 双向 `runtime_state/runtime_output` events，把 backend 对 host 的依赖变 required。

---

## 2026-05-17 — Human identity ship + Mode B cleanup

- **Commit 1 (`feat: register-based human identity (V1) + CLI observability fixes`)**：把已 review 的人身份重写（v21 staging + register-time 适配 + RegistrationGate + ProfilePane + 5MB avatar）和 #task:349 CLI observability 收尾（cli-invoke-middleware 抽 `{path,code}` issue summary、`cli-route-map` `schedules/list` 改 POST、`verb_removed` 调度 subkind）一起落地。两篇 `docs/human-identity-*.md` 同 commit 入仓。@shiki 本地 backup 恢复后已经按 §10 验证通过；DB adoption counts (1019/0/71/12) 与实测 1021/0/72/12 对齐。
- **Commit 2 (`feat: Mode B cleanup — retire Deferred Adoption bridge`)**：按 cleanup-plan §6 落地 Mode B：
  - `Migration` interface 加 `precondition?: (db) => void`；`runMigrations` 抽出 `applySingleMigration` 让普通 + `foreignKeyEscape` 两条分支共享同一条 apply path（precondition 在事务内、`up` 之前跑）。
  - 新增 v23 `remove_v21_adoption_bridge`：precondition 检查每张 `legacy_*_v21` staging 表的行数 + `pragma('foreign_key_check')`，非空 staging 触发清晰的 "register first on a build that still has Deferred Adoption" 错误（旧 SQL `RAISE(ABORT, ...)` 仅 trigger 内合法、文档示例已修正）；`up` 用 `DROP TABLE IF EXISTS` 把已确证为空的 staging 删干净。
  - `UserService.register()` 删 `adoptLegacyV21` helper + 调用；`SETTINGS_KEYS.LEGACY_V21_ADOPTION_*` 删；`tests/services/user-service-adoption.test.ts` 删（adoption runtime 不再存在）。
  - `tests/db-migrations.test.ts` 加 `applyMigrationsThrough(db, max)` helper + 3 条 v23 测试（fresh-DB 全跑过 / 非空 staging 拒绝 / post-adoption idempotent）；v16/v20/v21 staging-creation 测试改为 `applyMigrationsThrough(db, 22)` 保留 v21 历史合同。
  - 两篇 `docs/human-identity-*.md` 加 status footer 标记 cleanup landed；cleanup-plan §6 Step 3 修订（不再写 standalone `RAISE()`，给出 `precondition` TS 写法 + 强调 `pragma('foreign_key_check')` 不抛要主动检查）。
- **Follow-up v24 cleanup**：新增 `remove_legacy_v21_adoption_audit_settings`，只删除 `app_settings` 里的两条历史 `legacy_v21_adoption_*` 审计 KV；v21/v22/v23 migration body 保持不变，Deferred Adoption runtime/staging 仍维持已清理状态。
- **质量门**：`pnpm -r typecheck` 4/4；`./scripts/test.sh` 58 files / 715 tests；`pnpm --filter @silverhand/desktop test` 12 files / 195 tests；`git diff --check` 干净。

---

## 2026-05-15 — Clear CLI session + delivery queue 收敛

- **delivery queue DB-first**：`conversation_inboxes` 加 `(conversation_id, agent_id, message_id)` unique；`ensureDelivery` 幂等写入；`pendingDeliveries` 改成带 `inboxId/messageId/text` 的当前进程 formatted batch cache。hard stop 时内存可丢，pending DB row 保留，下次 start drain。
- **per-agent clear session**：新增 `POST /api/channels/:cid/agents/:aid/clear-session` / `POST /api/threads/:tid/agents/:aid/clear-session`。语义固定为 hard stop live process → `conversation_agents.cli_session_id = NULL` → publish `agent_status` → 写 `session_cleared` audit；不自动 restart，不清 MEMORY/notes，不清 pending inbox。
- **lifecycle lock**：ConversationManager 增 per-(conversation, agent) lifecycle queue，串行化 `start` / `stop` / `clearSession`，并覆盖 init retry / oneShot auto-start，避免 clear 与 queued start 竞态带旧 `--resume`。
- **UI**：AgentStrip 的 `AgentInfoPopover` footer 增 per-agent Restart / Stop / Clear session；Clear 有确认 dialog。DM 也显示单 agent chip，统一入口。`session_cleared` system message 用 destructive audit card 渲染。
- **验证**：`pnpm --filter @silverhand/{shared,backend,desktop} typecheck` 通过；full `./scripts/test.sh` 53 files / 619 tests 通过。

## 2026-05-10 — MCP → Silverhand CLI hard cutover（#190 / #192 / #193 / #194 / #195 / #196 / #197）

本轮把 agent-facing 能力从 `mcp__chat__*` 工具面切到 `silverhand` CLI：agent 只依赖命令名 `silverhand` 和后端注入的 `SILVERHAND_CONVERSATION_ID / SILVERHAND_AGENT_ID / SILVERHAND_SERVER_URL / SILVERHAND_AUTH_TOKEN`。业务实现仍走 `/internal/conversations/:cid/agents/:aid/...`，route/service/ACL 复用。

- #190：`platform-prompt.ts` 改为 CLI-only 指南，新增 `## Silverhand CLI` 章节，列出 message/task/thread/channel/workspace/schedule/file 命令；stderr/exit-code 契约写进 prompt。
- #192：新增 `packages/cli`，18 个子命令对齐原内部能力，纯 fetch + shared DTO，无 SQLite/native 依赖；错误契约稳定为 `{code,message,retriable}` + exit 1/2/3。
- #193：后端签发 per-launch `(conversationId, agentId)` token，spawn 时注入 `SILVERHAND_*`，并写 per-spawn `bin/silverhand` shim 后 prepend `PATH`；token 在 agent 退出时 revoke。
- #194：Codex cutover，删 inline `mcp_servers.chat.*` 配置；inbox/live delivery 文案改 `silverhand message send`。
- #195：Claude cutover，删 `--mcp-config / --strict-mcp-config`；spawn-prep 不再生成临时 `mcp.json`；`DriverSpawnContext.mcpConfigPath` 删除。
- #196：Cursor cutover，删 `<workspace>/.cursor/mcp.json` 写入和 `--approve-mcps`；`DriverSpawnContext.chatBridge` 删除。
- #197：删除 `packages/chat-bridge` 与 backend/desktop 的 `chatBridgeLauncher` 接线；`docs/mcp-system.md` 替换为 `docs/cli-system.md`；shared MCP config types / `AUTH_TOKEN_ENV` 清理。

设计边界：保留 internal HTTP routes，不删除业务 endpoint；CLI 只是 transport 换皮。未来多 host / sandbox 只需要 host adapter 保证 `silverhand` 在 PATH 中可达，并提供 sandbox 可访问的 `SILVERHAND_SERVER_URL`，agent prompt/命令面不变。

## 2026-05-09 — Cross-workspace history/search: list_workspaces + 跨 workspace read/search + 文档/prompt 同步（PR-A #180 / PR-B #181 / PR-C #185）

PR-1/PR-2 把 `read_history` / `list_channels` / `search_messages` 在当前 workspace 跑通后,出现新场景:agent 被 schedule wake 在自己的 `agent_home` DM 里,需要去其它 workspace 翻历史/查上下文,但根本没有"我有哪些 workspace 可去、那个 workspace 有哪些 channel"的入口。这一刀加 cross-workspace discovery + 跨 workspace 读/搜,并把"读"和"发"的权限模型彻底分开。@Alice 实现,@Cindy review。

**PR-A(#180,DONE)— Cross-workspace discovery**

- 新 `list_workspaces({})` MCP tool:返回 caller agent 当前可访问的 workspace 列表(regular workspace 通过 `workspace_members` JOIN ∪ 自己的 `agent_home` 通过 `owner_agent_id`),每行带 `id / name / kind / archived / updated_at / agent_dir`。
- `kind` 用 DB truth(`'regular' | 'agent_home'`),不造合成的 `'dm'`(DM 是 conversation kind,不是 workspace kind)。
- `agent_dir` 按 kind 分支,跟 `activeAgentProfileDir` 完全一致:`agent_home` → `workspace_path` 本身(agent 的 L1 根);`regular` → `${workspace_path}/.silverhand/agents/${agent_id}`(L2 profile 嵌套目录)。设计目的:让 agent 用自己的 file 工具去读自己的 MEMORY/notes/logs 做自纠/清理。
- `list_channels` 扩展可选 `workspace_id` query。默认仍是 source workspace(`workspace_id == source` 时跳过 access check 走 fast-path);跨 workspace 时强制 `canAgentAccessWorkspace`,失败 403。
- 新 helper `canAgentAccessWorkspace(ctx, agentId, workspaceId)` 落在 `permissions.ts`,真值来源是 `WorkspaceRepo.listForAgent(agentId)`。v17 trigger 让 `workspace_members` 不存 agent_home 关系,所以 ownership 是访问自己 home 的唯一路径,其他 agent 的 home 自然不会出现。
- **新数据真值入口**:`WorkspaceRepo.listForAgent` 是 cross-workspace 权限的 single source of truth。任何"agent 看得到哪些 workspace"的问题都走这里,不要再手写 SQL JOIN。
- 8 cases 测试覆盖:regular + own home 出现、其他 home 不出现、agent_dir 两种形状、list_channels(workspace_id) 跨 workspace 成功 / 403 (陌生 regular) / 403 (别人 home) / 同 source workspace explicit 不需要 access check。

**PR-B(#181,DONE)— 跨 workspace 读/搜**

- 新 `ReadHistoryTargetSchema = 'self' | 'parent' | { thread_id } | { conversation_id }`,**与 `SendMessageTargetSchema` 完全解耦**。这是设计核心 invariant:加 read 时不能偷偷 widen send 权限。后续如果想再扩 cross-conversation read 的形式,只动这个 union;cross-conversation **post** 必须另起单独权限审计。
- `read_history({target:{conversation_id}})` 走 `conversation_agents` 单一 bottom guard:workspace 级访问不够,必须 channel/thread 级成员。kind 白名单:`channel | dm_channel | thread`,workspace id 当 conversation id 传 → 404。
- `search_messages` 加可选 `workspace_id`,`superRefine` 强制只能与 `scope='workspace'` 同时出现。跨 workspace 时顶层 `canAgentAccessWorkspace`,SQL JOIN `conversation_agents` 仍是 bottom guard,所以 alice 在 team-x 即使有 workspace 级访问,在 bob-only channel 里也搜不到任何东西。
- `search_messages(scope='channel')` 把 `channel_id` 当**全局唯一** conversation id —— 删掉旧的 `channel.workspace_id !== sourceConversation.workspace_id` 守卫(那是 PR-B 之前的"只能搜本 workspace channel"姿态,跟新的 navigation 模型矛盾);bottom guard 仍是 `conversations.getAgent(channel.id, agentId)`,SQL JOIN 仍兜底 child thread 成员判定。
- `AgentSearchMessagesDtoSchema` 加 `workspace_id` 字段(nullable),`'workspace'` scope 时填实际命中的 workspace,其它 scope 为 null。
- chat-bridge `read_history` target 增 `{conversation_id}` 描述;`search_messages` 加 `workspace_id` + runtime XOR 校验,描述末尾把"用 read_history around hit.message_ref.id"改成显式的 `read_history({ target: { conversation_id: hit.message_ref.conversation_id }, around_message_id: hit.message_ref.id })`,避免 agent 默认 `self` 在远端 hit 上 404。
- 14 cases 新测试覆盖:cross-ws channel 读、parent-not-member 的 thread 也能读(用 ConversationRepo 直接 seed 构造 topology)、403 非成员、404 不存在、self/parent/{thread_id} 回归、workspace id 当 conversation id 拒绝;cross-ws workspace 搜、403 陌生 ws、403 别人 home、400 workspace_id 配错 scope、默认 back-compat、conversation_agents 兜底、cross-ws channel scope 成功(含 visible child thread + 同 token 在 source DM 不混入)、cross-ws channel scope 非 channel 成员仍 403。
- `pnpm test` 全套 570/570 pass。`pnpm typecheck` clean × 4 workspaces。

**PR-C(#185)— docs/prompt 同步**

- `docs/mcp-system.md` §4 重写:`read_history` target 加 `{conversation_id}` + 错误码列表更新(`conversation_not_found` 404, `unsupported_conversation_kind` 400, `not_target_conversation_member` 403);新 `### list_workspaces` section 全签名 + agent_dir 分支规则 + 排序 + workspace_members ∪ owned home 真值说明;`list_channels` 加 `workspace_id?` 参数 + `canAgentAccessWorkspace` 守卫;`search_messages` 加 `workspace_id?` + 输出 schema 增字段 + scope=channel 全局 channel_id 改述 + remote hit 取全文规范;新 §4.4 cross-workspace navigation 写出 `list_workspaces → list_channels → search_messages | read_history` 标准链路,并明确"读不通向写"。
- `docs/mcp-system.md` §9 Prompt Contract 加一条 cross-workspace navigation chain bullet,显式写"never widens posting"。
- `packages/backend/src/drivers/platform-prompt.ts` "History and search" section 重写:加 `list_workspaces`(包含 `agent_dir` 用来读自己的 MEMORY/notes/logs),`list_channels` 写明 `workspace_id` 默认与 cross-workspace 用法,`search_messages` 写出 cross-workspace + 显式跟 `read_history({ target: { conversation_id } })` 配套,末尾给一个标准 cross-workspace recipe 一行。

**Out of scope(明确不动)**

- `check_messages`:仍待 delivery ledger refactor(PR-3 in 主 thread)。
- cross-conversation **send_message**:`SendMessageTargetSchema` 不动,继续 `'self' | 'parent' | { thread_id }`。
- 多用户/多 host 权限:跟 attachment-auth、permission-system PR 一起整体落。

**实现位置**

- PR-A: `packages/shared/src/api/paths.ts`(+`agentListWorkspaces`、`agentListChannels` 文档更新),`packages/shared/src/api/dto.ts`(+`AgentListedWorkspaceSchema` / `AgentListWorkspacesDtoSchema` / `AgentListChannelsQuerySchema`),`packages/backend/src/permissions.ts`(+`canAgentAccessWorkspace`),`packages/backend/src/routes.ts`(+`buildAgentListWorkspacesDto` + 新 `agentListWorkspaces` GET 路由,`agentListChannels` GET 加 `?workspace_id=`,`listAgentVisibleChannels` 签名改 `workspaceId: string`),`packages/chat-bridge/src/server.ts`(+`list_workspaces` tool、`list_channels` 加 `workspace_id`),`packages/chat-bridge/src/client.ts`(+`listWorkspaces` / `listChannels({workspace_id?})`),`packages/backend/tests/routes/list-workspaces.test.ts`(8 cases,新文件)。
- PR-B: `packages/shared/src/api/dto.ts`(+`ReadHistoryTargetSchema`、`AgentReadHistoryInputSchema.target` 切到新类型、`AgentSearchMessagesInputSchema` +`workspace_id` + superRefine、`AgentSearchMessagesDtoSchema` +`workspace_id`),`packages/backend/src/routes.ts`(`resolveAgentReadHistoryTarget` 加 `{conversation_id}` 分支、`buildAgentSearchMessagesDto` 接受 `workspace_id` 并删掉 channel scope 的 workspace 守卫、search_messages 路由 `canAgentAccessWorkspace` 守卫),`packages/chat-bridge/src/server.ts`(read_history target 加 `{conversation_id}`、search_messages 加 `workspace_id` + runtime 校验 + 描述更新),`packages/backend/tests/routes/cross-workspace-read-search.test.ts`(14 cases,新文件)。
- PR-C: `docs/mcp-system.md` §4/§9,`packages/backend/src/drivers/platform-prompt.ts` History and search section,本节(`docs/progress.md`)。

---

## 2026-05-09 — Agent panel: Schedules tab（PR-3a, task #183）

PR-1 + PR-2 把 schedule 工具面跑通后,user 这边只能靠 agent 主动 list / 报告才能看见自己创建的 wake plan;面板上没有审计入口。这一刀给 Agent 详情页加 Schedules card,后台加 user-principal 的 list/cancel HTTP 路由,数据走 PR-1 已有的 `ScheduleService`,不再做新业务逻辑。@Alice 实现,@Cindy review。

**新接口(public,user principal)**

- `GET /api/agents/:id/schedules?status=&limit=` → `{ schedules: ScheduleDto[] }`。`status` 接 `pending|firing|active|done|cancelled|failed|all`(`active` = pending+firing 别名,跟 MCP 一致),`limit` 默认 100、max 200,`?limit=` 字符串通过 `Number(...)` 强转后再喂 `ScheduleListInputSchema.safeParse`。
- `POST /api/agents/:id/schedules/:scheduleId/cancel` → `{ schedule: ScheduleDto }`。路由把 `agentId` + `scheduleId` 一起喂 `ScheduleService.cancel`,所以传错 agent 只会拿到 `not_owner` (403),UI 误点不会跨 agent cancel。Cancel 成功后写一条 `logger.info({user_id, agent_id, schedule_id})`,作为 v1 的审计日志(没有单独的 audit 基础设施,Cindy review 时也确认过不为这个 PR 起架构)。
- 路径表:`apiPaths.agentSchedules(id)` / `apiPaths.agentScheduleCancel(agentId, scheduleId)`(放在 `agents` 段、紧挨 `agentRuntimeState`/`agentDeleteImpact`)。

**权限模型**:沿用现有 `/api/agents/:id/*` 的"agent 存在即可访问"姿态(host 单用户模型)。后续等多用户权限层落,这两条路由跟其它 agent 路由一起继承新姿态,不需要单独改。

**Frontend**

- `useAgentSchedules(agentId, status='active')`:`['agents', id, 'schedules', status]` query key,30s `refetchInterval`(scheduler tick + sweep 60s,30s 给"最差 30s 滞后"的 UI 体感,不烧 HTTP)。`useCancelAgentSchedule(agentId)` 成功后 `invalidateQueries({ queryKey: ['agents', agentId, 'schedules'] })`,所有 status filter 一起刷。
- `AgentSchedulesCard`:卡片放 `AgentView` 最底,跟 `AgentRuntimeTable` 同级。表头列 `Kind | Next fire (relative + ISO hover) | Status | Fired count(/max if 有) | Message | Cancel 按钮(仅 pending/firing 行)`。Filter tabs:Active / All / Done / Cancelled / Failed。空态、loading、error 三态都给独立提示。
- 故意**不**给 UI 创建入口:create 是 agent 自服务,用户造 wake 会破坏"agent 拥有自己 wake 计划"的语义,跟 Cindy 核过。
- 故意**不**走 SSE:row 字段(fired_count / next_fire_at / status)只在 fire / cancel 时变,30s polling 能 cover;给 SSE 加 schedule 频道得改 events bus + scope schema,不值得。

**Tests**

- `tests/routes/agent-schedules.test.ts`(11 cases,新文件):list 排序 by next_fire_at、agent 隔离、`active` 别名 filter、`cancelled` filter、`?limit=2` 字符串 coerce、bogus status enum → 400、未知 agent → 404;cancel 成功 + cancelled_at 写入、`not_owner` (403) 跨 agent 路径、`schedule_not_found` (404)、agent 不存在 (404)、`not_cancellable` (409) 终态。
- 复用现成 `ScheduleRepo` 直接 seed 行(不绕弯过 agent-principal 路径),独立验证 user-side 入口。
- 全套:`./scripts/test.sh` 总数从 535 升到 546(+11)。`pnpm typecheck` clean × 4 workspaces。

**Out of scope(明确不动)**

- `ScheduleService` / `ScheduleRepo` / migration:PR-1 完成后冻结,PR-3a 只加 HTTP/UI。
- 平台 prompt:`PR-3b`(task #182,@Cindy 实现中)负责。
- realtime wake 消息显示:#184(@Cindy 实现中)负责 — 跟我的卡片是互补关系(卡片给的是行级状态,#184 给的是 chat 流里 system message 实时显示)。
- 多用户权限:整个 `/api/agents/:id/*` 段都还没接,等专门的权限 PR。

**实现位置**

- `packages/shared/src/api/paths.ts` 加 `agentSchedules` / `agentScheduleCancel`
- `packages/backend/src/routes.ts` 加两条路由(GET + POST)+ logger 审计行
- `packages/backend/tests/routes/agent-schedules.test.ts`(11 cases,新文件)
- `apps/desktop/src/renderer/features/agents/hooks.ts` 加 `useAgentSchedules` / `useCancelAgentSchedule`
- `apps/desktop/src/renderer/features/agents/AgentSchedulesCard.tsx`(新文件)
- `apps/desktop/src/renderer/features/agents/AgentView.tsx` mount Schedules card
- 本节(`docs/progress.md`)

---

## 2026-05-09 — Schedule MCP 工具与文档（PR-2，task #179）

PR-1(#177)落地 backend service / scheduler / migration / 36 个 service 单测后的"上层一刀":接 chat-bridge MCP 工具与 backend internal 路由,加 route 级集成测试,并把 schedule 这个新概念写进 `docs/mcp-system.md` / `docs/agent-run-state.md` / `docs/progress.md`。本 PR **不动** PR-1 已经冻结的 service / scheduler / migration / repo —— 只在它们之上铺一层 HTTP/MCP 路由 + 文档。@Alice 实现,@Cindy review。

**PR-2 范围**:

- chat-bridge MCP 工具 3 个,描述里包含限额 / spec 三种 kind / `allow_unbounded` 必须显式 / cron 必须 5 字段 + IANA tz 等关键约束,让 LLM 在 tool listing 阶段就能正确拼参:
  - `schedule(message, spec, until_at?, max_occurrences?, allow_unbounded?)` → `{ schedule: ScheduleDto }`
  - `list_schedules(status?, limit?)` → `{ schedules: ScheduleDto[] }`
  - `cancel_schedule(schedule_id)` → `{ schedule: ScheduleDto }`
- chat-bridge `BackendClient` 加 `createSchedule` / `listSchedules` / `cancelSchedule`,统一走 `post()` 反序列化共享 DTO。
- `internalPaths.agentScheduleCreate / List / Cancel`(三条路径都挂在 `/internal/conversations/:cid/agents/:aid/schedules*` 下,**仅** 复用 internal principal middleware 做认证;schedule 自身的归属看 `principal.agentId`,跟 cid 无关 —— 注释里明说,避免后续误以为 schedule 跟 conversation 有关联)。
- `routes.ts` 加 3 条 POST 路由 + `scheduleServiceErrorResponse(c, err)` 错误映射器。`ScheduleErrorCode` → HTTP 状态对照表锁在 `scheduleErrorStatusMap`,任何 service 端新增 code 都得在这里显式补上(否则 fallback 400)。
- `ScheduleCreateOutputSchema` / `ScheduleListOutputSchema` / `ScheduleCancelOutputSchema` 加进 `packages/shared/src/api/dto.ts`,所有路径返回都包成 `{ schedule }` / `{ schedules }`,与 PR-1 设计的"create 返回 canonicalized 行"配合(client 侧不用再二次 fetch 拿 `next_fire_at`)。

**route 级集成测试**(`tests/routes/schedules.test.ts`,22 cases):

- happy path:once `delay_seconds` → canonical `fire_at`、interval `allow_unbounded`、cron expression+timezone round-trip、list owner 隔离、status `active` 别名、cancel 落 `cancelled` + `cancelled_at`。
- 错误码逐个钉:每个 `ScheduleErrorCode` 至少一个用例,锁住 `code → HTTP status` 映射:
  `invalid_input` ×2(message 空、once 既缺 fire_at 又缺 delay_seconds)、`invalid_cron_expression` ×2(`@daily`、6 字段)、`invalid_timezone`、`fire_at_too_soon`、`fire_at_too_far`、`unbounded_repeat_requires_explicit_limit`、`too_many_active_schedules`(填满 50 active)、`schedule_not_found`、`not_owner`(bob 取消 alice 的 schedule)、`not_cancellable`(已 cancelled 再 cancel)、`agent_home_not_found`(SQL 直接删 alice 的 agent_home + dm)。
- 边界:internal middleware 拒绝未知 agent (404)、非 conversation 成员 (403)、缺 bearer (401)。这三条是 `principal middleware` 的护城河,任何"忘记走 middleware"的 regression 会立刻在这里翻车。

**文档同步**:

- `docs/mcp-system.md` 加 §6 "Schedules":三条工具的完整 signature、`ScheduleDto` 形状、所有 rule(canonicalization / 5-field cron / IANA tz / unbounded 必须显式 / next_fire_at 不 backfill / agent_home wake target),以及错误码 → HTTP 表格。原 §6/§7/§8 (Attachments / Deliberately Absent / Prompt Contract) 顺位 +1 → §7/§8/§9,Maintenance Checklist 升 §10。
- `docs/agent-run-state.md` 新加 §13 "Schedule wake (`metadata.subtype = 'schedule_fire'`)":写明 wake 走普通 `messages.insertForConversation + deliverMessage + start`,跟用户消息共享 run-state / Activity Strip / inbox 路径;§12 mention-targeted 讨论不适用(wake 永远只有 owner agent 一个 recipient,`from_kind='system'` 不参与 mention 解析);PR-2 不引入新 `agent_*` 事件,不改任何 run-state 字段。
- `docs/progress.md`(本节)。

**Out of scope(明确不动)**:

- 任何 `ScheduleService` / `ScheduleRepo` / migration v18 的修改 —— PR-1 已 review 通过、tests 绿,改动会让两轮 review 重复劳动。如果 PR-2 的 route/MCP 暴露 service 端真问题,再单独开 PR。
- 平台 prompt(`packages/backend/src/drivers/platform-prompt.ts`)对 schedule 工具的"什么时候用"高层引导。当前 prompt 已经讲了通用 tool surface 的克制原则;schedule 何时该自调与否更像产品决策而不是平台决策,等真实用例铺开后再补 prompt 行,避免现在写一段空洞的 "考虑用 schedule" 引导。

**实现位置**:

- `packages/shared/src/api/dto.ts` 加 `ScheduleCreateOutput / ListOutput / CancelOutput` schemas
- `packages/shared/src/api/paths.ts` 加 `agentScheduleCreate / List / Cancel`
- `packages/chat-bridge/src/server.ts` 加三个 MCP 工具
- `packages/chat-bridge/src/client.ts` 加三个 BackendClient 方法
- `packages/backend/src/routes.ts` 加 3 条 internal POST 路由 + `scheduleServiceErrorResponse` + `scheduleErrorStatusMap` + `ScheduleError` 导入
- `packages/backend/tests/routes/schedules.test.ts`(22 cases,新文件)
- `docs/mcp-system.md` §6 加 Schedules 一整节,后续小节顺位下移
- `docs/agent-run-state.md` §13 加 wake-path 说明
- 本节(`docs/progress.md`)

**验证**: `pnpm typecheck` clean across all 4 workspaces; `./scripts/test.sh tests/routes/schedules.test.ts` 22/22 绿;PR-1 service/migration 测试不受影响。

**Round 1 review fix(2026-05-09,Cindy 提出 blocker,Alice 修)**:

- **问题**:`ScheduleCreateInputSchema` 把 `until_at` / `max_occurrences` / `allow_unbounded` 标 "Ignored for `once`",但 service 实际把它们写进 one-shot row,且 `until_at` 校验对所有 spec 都跑。结果 `schedule({ spec:{kind:'once', delay_seconds:60}, max_occurrences:3 })` 会回一个 `max_occurrences=3` 的 one-shot DTO,跟文档/contract 对不上。
- **修法**:input schema 层 strict-reject(选择拒绝而不是 silent-ignore,语义更干净):`ScheduleCreateInputSchema.superRefine` 加分支,`spec.kind === 'once'` 时显式 reject `until_at|max_occurrences|allow_unbounded` 任一,字段级 `addIssue`。Service 层不变(`until_at` 校验只对 repeat 跑就足够了,因为 schema 已经把 once 路径滤掉了)。
- **测试**:service 加 `it.each` 三个字段 → `invalid_input`,route 同样加 `it.each` 三个字段 → 400 + `code='invalid_input'`。
- **Doc**:`docs/mcp-system.md` §6 把 "Ignored for `once`" 改成 "rejected on `once` (→ `invalid_input`)" + 一句 "silent-ignore 会让 agent 看到非 canonical 行" 的解释;chat-bridge 工具描述同步。
- **回归**: `./scripts/test.sh tests/routes/schedules.test.ts tests/services/schedule-service.test.ts` 25 + 49 = 74 绿;`pnpm typecheck` clean。

---

## 2026-05-09 — Schedule 后端骨架（PR-1，task #177）

Thread "Reminders 工具设计" 收敛后的实现一刀。设计反复迭代过：从 reminder one-shot → 含 repeat 的 cron-like scheduler；命名 reminder → schedule；主归属从 conversation-bound → 纯 agent-owned，无 task/channel/message link。@Cindy 设计协作 + review，@Alice 设计 + 实现 PR-1。详细设计与决策路径见 MEMORY Active Context。

**范围**（本 PR）：

- `migration v18`（`schedules` 表 + `idx_schedules_due` / `idx_schedules_owner`）。`owner_agent_id` CASCADE 跟 `agents`。
- `ScheduleRepo` —— 包括 `tryClaim` 的 CAS lease（`UPDATE ... WHERE status='pending' RETURNING id`，唯一胜出者）和 `resetStaleFiring` crash recovery。
- `ScheduleService` —— 校验、quota、cron-parser 集成（IANA timezone 必填，DST 完全交给库）、`pending|firing|done|cancelled|failed` 状态机、due tick + 60s 兜底 sweep + 60s 内 setTimeout 优化、wake 投递到 owner agent 的 agent_home primary dm_channel。
- `cron-parser ^4.9.0` 加为 backend dep。
- `BackendContext.scheduleService` 注入 `index.ts`，`start()` 在 `reconcileOnBoot` 后跑（先 reset stale firing,再立即 tick + 启动 sweep），`stop()` 在 `close()` 第一步触发，避免 fire 期间 CM 被拆。

**v1 不在 PR-1 范围**（留给 PR-2）：MCP 工具（`schedule` / `list_schedules` / `cancel_schedule`）和文档同步（`docs/mcp-system.md` / `docs/agent-run-state.md` / 平台 prompt）。后端能力已经齐全，PR-2 只是 HTTP/MCP 路由。

**关键不变量**（review 时重点验证）：

- **零耦合**。`schedules` 表没有 `conversation_id` / `source_*` / `task_*` 任何字段;agent 想保留上下文就写进 free-text `message`,平台不建结构化关联。`docs/mcp-system.md` 在 PR-2 里要明写。
- **next_fire_at 永远从 actual_fire_at 推进**,不从 old `next_fire_at` 循环 catch up。missed-on-restart 只补一次,然后跳到下一次未来时间;`fired_count` 反映实际 fire 次数,不是计划次数。
- **CAS 是唯一并发屏障**。dev hot-reload 双 scheduler、sweep 与 near-timer race、test 并发 tick —— 所有路径都先调 `tryClaim`,SQLite 的 RETURNING 保证最多一胜。`disposeTimers()` 不能依赖,DB 才是 truth。
- **wake 落 agent_home dm_channel**,owner-only deliver(虽然 agent_home 只有 owner 一个 member,这层 deliver-to-owner 写法保留语义清晰)。complemented by `start(home_dm, owner)` 触发非 oneShot driver 的进程 spawn,两个调用都 idempotent。
- **DST**: `cron-parser`(用 Luxon)处理 spring-forward / fall-back;tests 覆盖 NYC `0 8 * * *`(穿越 03-10 02:00→03:00)和 `30 * * * *`(穿越 11-03 02:00→01:00)各 5-8 次连续 fire,断言 `next_fire_at > actual_fire_at` 严格单调。

**Quota / 边界**:

- 每 owner_agent_id active(`pending|firing`)≤ 50,超限返回 `too_many_active_schedules`。
- one-shot delay ∈ [30s, 90 天];interval `every_seconds >= 60`(对齐 sweep tick)。
- repeat schedule **必须** 显式给 `max_occurrences` / `until_at` 之一,或显式 `allow_unbounded: true`,否则 `unbounded_repeat_requires_explicit_limit`。
- `until_at` 不能在第一次 fire 之前,否则 `invalid_input`(创建一个永远不会 fire 的 schedule 是 bug 不是 feature)。

**测试覆盖**(`tests/services/schedule-service.test.ts`,36 cases):

- create 路径:once 二选一 canonicalization、min/max delay、unbounded check、interval 边界、cron expr/timezone 校验、agent_home 缺失、quota 上限、until_at 顺序。
- list:`active` 别名展开为 `['pending','firing']`;owner 隔离;`next_fire_at` 升序。
- cancel:owner 校验、终态拒绝。
- tick:one-shot → done;interval 推进 + 终态;until_at 截断;wake 失败 → failed + reason。
- 并发:`Promise.all([tick, tick])` 只 fire 一次。
- recovery:start() reset stale firing。
- missed:跳 10 分钟仍只 fire 一次,next 从 actual+60s 起。
- DST:NYC spring-forward + fall-back 各连续 5-8 次,严格单调推进。
- wake body:repeat 元数据(`fired_count/n`)、迟到提示(`fired Xm late`)、`subtype='schedule_fire'` metadata。

`tests/db-migrations.test.ts` 加 v18 case:NOT NULL 列、nullable 列、禁止字段(conversation_id / source_*),index、CASCADE FK、status CHECK。

**实现位置**:
- `packages/shared/src/db/migrations.ts` v18
- `packages/shared/src/api/dto.ts` `Schedule*` schemas + 常量
- `packages/backend/src/repos/schedule-repo.ts`
- `packages/backend/src/services/schedule-service.ts`
- `packages/backend/src/context.ts` 加 `scheduleService` 字段
- `packages/backend/src/index.ts` 构造 + start + stop wiring
- `packages/backend/package.json` 加 `cron-parser ^4.9.0`
- `packages/backend/tests/services/schedule-service.test.ts`(36 cases)
- `packages/backend/tests/db-migrations.test.ts` v18 case

`pnpm typecheck` 全绿;`./scripts/test.sh` 497/497 通过。

**Review round 1(@Cindy)收 3 blocker + 1 medium 全部修完**:

1. **cancel-during-firing race**(blocker)。`ScheduleRepo.markDone/markFiredAndRearm/markFailed` 全部加 `WHERE id=? AND status='firing'` 谓词,改返回 `boolean`。如果 cancel 在 CAS 之后、completion 之前抢先成功,后续完成更新会 0-row 静默 no-op,`cancelled` 状态保留为终态。语义:cancel 不撤回已经发出的 wake,只阻止未来 fire。新增 2 个测试覆盖 one-shot 和 repeat 两种 race 场景。
2. **cron 5-field 强制**(blocker)。新增 `assertFiveFieldCron()` 在 `computeCronNext` 入口运行,显式拒绝 `@daily`/`@hourly` 等 alias 和 6-field(seconds-precision)形式 —— `cron-parser` 默认会接受这两种,违反 v1 "5-field UNIX 分钟粒度" 契约。新增 3 个测试覆盖 alias、6-field、5-field positive。
3. **start() 失败被吞掉**(blocker)。`deliverWake` 不再 `.catch(warn)` `start()` 调用,直接 `await` 让异常上抛。`processOne` 已有 `markFailed` 兜底,运行时 spawn 失败(claude PATH 缺失、init watchdog 超时)会让 schedule 进入终态 `failed` 而不是错误地 `done`/重排。inbox 行已经写入,agent 下次任意路径启动仍会拿到 wake;但 schedule 状态如实反映"这次唤醒未完成"。新增 1 个测试。
4. **wake body 加 missed_count + next_fire_at**(medium)。新增 `Advancement` 类型在 `processOne` 里预计算 terminal/nextFireAt/missedCount,传给 `renderWakeBody`。 文案新增:
   - missed_count > 0 时:`Missed N prior occurrence(s) while offline; this is a single catch-up — not a backfill.`
   - 非终态 repeat:`Next fire at <ISO> (fired_count: <n>/<m|∞>).`
   - 终态 repeat:`This was the final fire of the schedule.`
   `interval` missed_count = `floor(delta/everyMs)` 精确;cron missed_count = `cron-parser` iterate `(planned, actual)` 区间(硬上限 1000 防 runaway);one-shot 恒为 0。metadata 也新增 `missed_count` / `next_fire_at` 字段。新增 4 个测试。

最终 49 / 507 测试通过(46 schedule + 3 migration);`pnpm typecheck` 全绿。

**等待 @Cindy round 2 review。**

---

## 2026-05-09 — `read_history` MCP 工具（PR-1，task #175）

Thread "主动读历史/搜索/拉新消息工具设计" 收敛后的第一刀。@Cindy 实现，@Alice 设计 + review。设计协商记录见 `.silverhand/agents/Z18wRZX6Uhsoa2tw/notes/agent-history-tools-v1.md`。

**v1 工具面定调**：补 `read_history` + `search_messages`，砍 `check_messages`（后者依赖一次 delivery ledger 重构，PR-3 单独评估）。

**`read_history` 行为锁**：

- 强制 anchor。`before_seq` / `after_seq` / `around_message_id` 三选一，缺/混传一律 400 with `anchor required`。没有"给我最新 N 条"模式 — push 已覆盖。
- 默认 snippet（≤160 字符 whitespace-collapse 截断）+ metadata + attachments，正文必须显式 `include_content=true`。`include_system` 默认 true。`limit` 默认 50 / 上限 100。
- `target` 复用 `send_message.target`：`self` / `parent`（仅 thread 内）/ `{thread_id}`（仅当前 channel 的 direct child）。**target 解析后再校验当前 `conversation_agents` membership**（即使 source 是 member，target 也必须现仍是 member）。
- `around_message_id` 是 conversation-scoped 查找：`WHERE id=? AND conversation_id=target_id`，跨 conversation 的 id 猜测返回 404 不泄露存在性。
- **永不写 `conversation_inboxes.delivered_at`** — 只读，不消费 push 队列。

**stdin push 文案改动**：`formatLiveMessage` / `formatInboxBatch` / 直接走 stdin 的 gated batch 全部加 `message_id=<id>` 行（live + inbox drain + safe-boundary queued + one-shot kickoff 四条路径），让 agent 任何时候都能拿到 anchor 种子。只塞 id 不塞 seq — `seq` 在 `read_history` / 未来 `search_messages` 响应里通过 `MessageRef` 自然带回。

**故意不实现**：

- `delivery_cursor` 字段：原计划"返回但不驱动默认"，最终砍掉。理由：current direct-stdin push 路径不写 inbox row，cursor 会是 lossy 的；shipped 一个有缺口的 cursor 比没有 cursor 更危险。等 PR-3 ledger 重构后再补。
- `around_message_id` 三选一窗口里 `floor((limit-1)/2)` 偏后 — 偶数 limit 略向后倾斜，可接受。
- 用户 sender `display_name` fallback 到 `from_user_id`。

**实现位置**：

- `packages/shared/src/api/dto.ts` — `AgentReadHistoryInputSchema` (zod refine 强制 anchor 唯一)、`MessageRef`、`MessageSenderRef`、`ReadHistoryTargetRef`、`ReadHistoryMessage`、`ReadHistoryAnchor`、`AgentReadHistoryDto`。
- `packages/shared/src/api/paths.ts` — `internalPaths.agentReadHistory(cid, aid)`。
- `packages/backend/src/routes.ts` — internal route + `resolveAgentReadHistoryTarget` + `buildReadHistoryDto` + `historySelectSql` 帮手。
- `packages/backend/src/conversation-manager.ts` — `formatLiveMessage` / `formatInboxBatch` 加 `message_id=<id>`，`MessageLite` 接口加 `id` 字段。
- `packages/chat-bridge/src/server.ts` + `client.ts` — `read_history` MCP 工具 + bridge 调用。
- 测试：`packages/backend/tests/routes/read-history.test.ts`（5 tests，覆盖强制 anchor、`delivered_at` 不动、around+system filter、target=parent、跨 thread 拒绝）+ `lifecycle.test.ts` 加 `message_id=` 断言。

**docs**：`docs/mcp-system.md` §4 新增；§7 absent 表移除 `read_history`、把 `check_messages` 单独保留并说明依赖 ledger refactor、增加 `search_messages`/`list_channels` planned 占位。

**PR-2 进行中**（task #178，@Cindy）：`search_messages` + `list_channels`，按已锁的三档 scope（current/workspace/channel）+ MessageRef 形状 + ±80 字符 excerpt + match_offset。

---

## 2026-05-09 — `search_messages` + `list_channels` MCP 工具（PR-2，task #178）

Thread "主动读历史/搜索/拉新消息工具设计" 的 PR-2，紧跟 PR-1 落地。@Cindy 实现，@Alice 设计 + review。两个工具共同把 v1 主动检索面补齐：`list_channels` 给 channel id 枚举，`search_messages` 给三档 scope 的全文检索，配合 PR-1 的 `read_history` 完成"发现 → 检索 → 取上下文 → 取正文"完整链路。

**`list_channels` 行为锁**：

- 入参为空。返回当前 conversation 所在 workspace 内、调用 agent 当前是 `conversation_agents` 成员的 `channel`/`dm_channel` 列表，**不返回 thread**。
- 字段：`{id, title, kind, archived, updated_at}`。archived channel 仍返回但排序到底。
- 设计意图：让 agent 永远只引用工具发现来的 channel id（而不是猜或自造），是 `search_messages(scope='channel', channel_id=...)` 的前置工具。

**`search_messages` 行为锁**：

- `scope ∈ {'current', 'workspace', 'channel'}`，默认 `current`。schema 用 refine 强制 `scope='channel' ⇔ channel_id` 互生（缺/混传 400）。
- **所有 scope 都走 `JOIN conversation_agents ca ON ca.conversation_id = conv.id AND ca.agent_id = ?` 硬过滤**，membership 取**当前**快照（不看消息产生时的历史 membership）。离开 workspace 后历史一并不可搜。
- `scope='workspace'`：搜源 conversation 所在 workspace 内 agent 当前是 member 的所有 conversations（含 channels / dm_channels / threads）。
- `scope='channel'`：SQL `(conv.id = ? OR conv.parent_conversation_id = ?)` 覆盖该 channel 本身和它的 child threads；child thread 仍走 `conversation_agents` JOIN，所以 agent 没加入的 thread 不会泄露。channel scope 还在路由层做 `channel.workspace_id` 同 workspace + `getAgent` 双重防御（防 cross-workspace id 猜测 → 403 `not_channel_member`；thread id 当 channel id → 404 `channel_not_found`）。
- 输出只给 `{message_ref, sender, excerpt, match_offset}`，**没有 full content**。正文由 agent 自行 `read_history({around_message_id: hit.message_ref.id, include_content: true})` 拉。
- excerpt：±80 字符上下文（`SEARCH_EXCERPT_CONTEXT_CHARS = 80`），whitespace 折叠，前后 `...` ellipsis；`match_offset` 0-based 指向 excerpt 内匹配位置。LIKE 命中但 JS `indexOf` 找不到（理论上的非 ASCII case 边界）时 fallback 到首 160 char。
- 后端走独立 internal route，**不**复用 UI `/api/search`（避免人类 search 的 user-scope 跟 agent membership 混；另外 agent 路由必须服务端注入 actor scope，输入信任面更窄）。
- `q` 长度 1..200，`limit` 默认 50 / 上限 100，`include_system` 默认 true（跟 `read_history` 对齐）。

**实现位置**：

- `packages/shared/src/api/dto.ts` — `AgentListedChannel`、`AgentListChannelsDto`、`AgentSearchMessagesScope`、`AgentSearchMessagesInput`（含 refine）、`AgentSearchMessageHit`、`AgentSearchMessagesDto`。
- `packages/shared/src/api/paths.ts` — `internalPaths.agentListChannels` + `agentSearchMessages`。
- `packages/backend/src/routes.ts` — 三个 internal route + `listAgentVisibleChannels`、`buildAgentSearchMessagesDto`、`searchExcerptFor`、`searchMessageRef` 帮手；复用 PR-1 的 `senderRef` / `historySelectSql` 套件。
- `packages/chat-bridge/src/server.ts` + `client.ts` — `list_channels` / `search_messages` MCP 工具 + bridge 调用。
- 测试：`packages/backend/tests/routes/search-messages.test.ts`（6 tests，覆盖：membership-filtered list / 当前 scope excerpt+match_offset 验证 / workspace scope 跨 channel 仅返回 agent member 的 / channel scope 含 child thread 但仍走 membership / scope×channel_id 三种非法组合 / `include_system=false` 过滤）。

**docs**：`docs/mcp-system.md` §4 标题改为 "Read & Search History"，新增 `list_channels` + `search_messages` 完整签名 + 行为合约；§7 absent 表移除 "search_messages / list_channels planned" 占位（v1 已落）。

**PR-3（非阻塞，单独 issue）**：delivery ledger 重构 + `check_messages`。等真有需求时再启动。本 thread "主动读历史/搜索/拉新消息工具设计" v1 主动检索工具面到此完整。

---

## 2026-05-09 — mention-targeted dispatch 讨论收敛、延后实现

频道 "agent activity 问题排查" 里围绕"我 @Cindy 提问,正在干活的 Claude 也被打断重新 thinking"这件事跑了一轮设计讨论(@Alice / @Cindy / 用户)。结论：**不实现**,只把决议沉淀进文档。

- 当前 dispatch：`ConversationMessageService.sendMessage` 给 user 消息选 recipients = 该 conversation 全员,逐个 `deliverMessage` + `startIdleRecipientsBestEffort`。语义上"群发"覆盖"被点名"。
- 备选方案(已设计未实现)：解析 `extractMentions(content)` ∩ members,非空只 active deliver/auto-start 集合内成员;非集合成员走 passive enqueue + active-drain 钩子保留历史可见性。
- 二阶问题：passive enqueue 修"看得到",但 drain 时 token 仍可能爆,需要截断/折叠/用户可选三种策略之一,这是产品决策不该跟 dispatch refactor 揉一起。
- 延后理由:当下伤害可控(activity bubble 闪一下,不是数据错误);回归面大;更适合作为 workspace/channel settings 里的用户可选策略。

完整方案 + 触发再评估的条件 → `docs/agent-run-state.md` §12;`docs/agent-run-state.md` §8 已加条目链回。

---

## 2026-05-08 — `initPostProtocolMs` 统一抬到 60s（task #174）

针对 channel `m73dqSY6mNS4lSpY` 那次 codex 启动失败的复盘（详见即将归档的 `docs/incident-2026-05-08-codex-init-watchdog.md` §post-mortem 与 work-log）：实测有 proxy 的 silverhand-style spawn `initialize → thread/started` 仅 ~3.84s、无 proxy ~10.48s，远在原 30s `initPostProtocolMs` 内。但当 proxy（用户机器是 `socks5://127.0.0.1:7897`）短时间半瘫时，codex 第一帧 protocol 还能很快冒出来，`thread/start` 却卡在 MCP 子链路上，30s 窗一击即中。

变更：把三个 driver 的 `initPostProtocolMs` 从 `30 * 1000` 统一抬到 `60 * 1000`：

- `packages/backend/src/drivers/codex.ts` — 加注释，链回 incident 文档；
- `packages/backend/src/drivers/claude.ts` — 同步 60s，注释强调 PR-A 三层 watchdog `reason=post_protocol` 的 triage 不应依赖 driver；
- `packages/backend/src/drivers/cursor.ts` — 同步 60s 保持 parity，cursor oneShot 极少撞这条路径。

`initLivenessSilenceMs` / `initPreProtocolCapMs` 不动；测试侧 `lifecycle.test.ts` 使用 manager 上的覆盖字段，与生产常量解耦，无需调整。

`docs/incident-2026-05-08-codex-init-watchdog.md` §「driver 接口（新增）」表格内常量同步成 `60s`。



@Cindy 修完 #169/#170 后两个 sidebar 仍是直切显隐，没有过渡。本批由 @Alice 实现。

变化：

- **Toggle 视觉去激活色**。删除 `toggleButtonActive` 那套 selected border + bg；按钮只剩 hover 状态，状态信号完全交给图标形状：workspace 用 `PanelLeft`（visible）↔ `PanelLeftDashed`（hidden），channel 用 `Columns2`（visible）↔ `Square`（hidden）。两个 toggle 使用不同 lucide 家族（Panel-* vs Columns/Square），形状差异足以一眼区分。
- **Sidebar slide 动画**。新增 `apps/desktop/src/renderer/hooks/useSidebarPane.ts`，把每个 sidebar 包装成四态机器 `closed → opening → open → closing`，配合 CSS `.sidebar-slot`（layout 收缩 width/flex-basis）+ `.sidebar-surface`（paint `transform: translate3d(±100%, 0, 0)`）双层结构，240ms `cubic-bezier(0.32, 0.72, 0, 1)` apple-feel 缓动。`useLayoutSettings` 退化成 thin 组合层。
- **`flushSync` + 双 rAF**。show 时 `flushSync(setState 'opening')` 强制 React 18 同步 commit，再 `requestAnimationFrame(() => requestAnimationFrame(...))` 保证浏览器至少绘了一帧 closed-state 才翻 `open`，CSS transition 一定从 `translate3d(-100%,0,0)` 起跑而不是被合帧成零帧跳。close 时直接 setState `closing`（surface 已挂着，CSS 直接反向插值）+ setTimeout 240ms 卸载 surface。
- **Reverse mid-animation**。toggle 在 closing 中触发 show 时直接翻 `open`，cancel 在飞的 setTimeout，CSS 自动从当前 transform 中点反向插值回 0；rapid toggle 永不漏 timer/rAF（每次 setVisible 都先 cancel 全部）。
- **`prefers-reduced-motion` 短路**。reduce 模式下不仅 CSS transition 关闭，JS 状态机也直接 `setState({phase: 'open'/'closed', visible: …})` 同步收口，避免 reduce-motion 用户仍要等 240ms 才看到 surface mount/unmount。
- **`inert` + `aria-hidden`**。隐藏中的 slot 加 `inert` 属性 + `aria-hidden="true"`，移出 a11y 树并禁焦，Tab 键不会跑进看不见的按钮（`pointer-events: none` 只能挡鼠标，不挡 focus）。
- **CSS var 而非 React state 控宽**。slot/surface 的 width 用 `var(--sidebar-width)` / `var(--channels-sidebar-width)` 而非 `${sidebar.width}px`，让 `useResizableWidth` 在 splitter drag 期间 rAF 写 CSS var 时 sidebar 也即时跟随；CSS 规范下 var 改值不触发引用方的 transition，所以 drag 不会触发 240ms 平滑（不需要额外 `--resizing` 抑制）。
- **localStorage 收敛**。把原来的 `silverhand:layout-settings` 单 JSON 拆成 `silverhand:layout.workspace-sidebar-visible` / `.channel-sidebar-visible` 两个独立 `'1'`/`'0'`，每个 sidebar 自己持久化，不互相耦合。

文档：[`app-layout.md`](./app-layout.md) §2 toggle 视觉行 + §3 slide 动画段 + §4 channel sidebar 段同步。验证：`pnpm --filter @silverhand/desktop typecheck` ✓、`test` ✓ (12)、`build` ✓。

---

## 2026-05-08 — Workspace / Channel row context menus（task #170）

新增非原生右键菜单基座 `components/menus/AppContextMenu.tsx`，基于 Radix Context Menu，并统一容器、item、icon slot、separator token。

- Workspace / DM workspace / archived workspace 行右键一致：`Open in Finder`（`FolderOpen`）和 `Copy path`（`Copy`）。DM workspace 已确认也有 `workspace_path`，不做 disabled 分支。
- Follow-up：workspace/DM 右键触发修复为 `SidebarRow` forwardRef 到真实 `button` 并透传 Radix `ContextMenu.Trigger asChild` 的 props；此前 channel 行有效是因为它直接把原生 `div` 作为 trigger。
- Channel sidebar 行右键：top-level channel/dm_channel 可 `Pin` / `Unpin`；regular workspace 的 top-level channel 可 `Archive channel` / `Restore channel`；channel/thread 全部可 `Copy name`。Thread 行本批只保留 `Copy name`，不扩展 pin/archive。
- ChannelView header 的 `MoreHorizontal` 点击菜单同步迁到同一套 `AppDropdownMenu` token，交互语义仍是点击打开 dropdown。
- 复制成功/失败用 sonner toast；菜单样式走 `bg-bg-floating` / `border-border` / `bg-bg-hover` 等主题 token，不使用原生 context menu。

---

## 2026-05-08 — UI batch: sidebar toggles + fixed Agent Activity strip（task #169）

本批收敛两个 layout 决策：

- Titlebar 红绿灯右侧新增两个独立 toggle：workspace sidebar (`⌘⇧\`) 与 channel sidebar (`⌘\`)。显隐状态存到全局 `silverhand:layout-settings`，不按 workspace 分叉；隐藏的 sidebar 连同 splitter 一起不渲染。workspace + channel 都隐藏时进入 chat-only zen，但 NavRail 作为 section 切换器常驻，titlebar toggle 是恢复 sidebar 的唯一入口。
- Agent Activity 从消息流尾部移到 Composer 上方的 fixed live strip。idle 时 0 高度；有活动时每个 agent 一行，透明底（仅 hover 轻微显底色），保留 phase snippet / elapsed；tool 调用按工具名分别展示计数（如 `Bash ×2` / `Read ×1`），不合并成 `{total} tools`；compacting 作为第二状态行展示，和 thinking/tool 文本并存。activity row 点击跳到当前 view 最近一条 user message，补回触发上下文。

同步更新 [`app-layout.md`](./app-layout.md) 的 titlebar/sidebar 章节与 [`agent-run-state.md`](./agent-run-state.md) 的 UI 章节。

---

## 2026-05-08 — Activity Bubble / `AgentRunState` 重构（task #159）

@Cindy 实施、@Alice 协助排查与 review，把 thinking 闪烁与"agent 完成后 activity 不消失"两个长期问题一次性收口。设计与修复细节迁到新文档 [`agent-run-state.md`](./agent-run-state.md)；要点：

- 修复 4 个根因：snippet 逐 delta 覆盖（Codex 闪烁）、direct-mode steer 换 runId、旧 run 无 `replaced` 终态、`turn_end` 落在 compaction 中无人补 resolve。
- 新增 `pendingTurnEnd` + `tryResolveTurnEndAtBoundary`，从 `turn_end` / `recordToolOutput` / `compaction_finished` 三入口汇入。
- `AgentRunState` 加 `compacting` / `compactingSince` / `compactionStale` 字段（与 `status` 正交），`AgentActivityBubble` 在 thinking 行之前独立渲染 compaction 行，stale 时 warning 配色。
- `AgentRunTerminalReason` 新增 `replaced`，`startRun` 覆盖时旧 runId 走终态广播，前端 tombstone 闭环。
- 前端 `useAgentRunStates` 加 `refetchOnMount: 'always'` 兜底 mount/reconnect race。
- 新增 `agentRunStateCache.test.ts` + `lifecycle.test.ts` 用例覆盖 snippet 累积、direct steer、deferred turn_end。

---

## 2026-05-08 — Claude `--resume` 大 jsonl 撞 init-watchdog（incident 记录）

UI 频道 `PxD4nCvw5mi-kbPG` 重启 agents 后 claude (`Z18wRZX6Uhsoa2tw`) 一直 "connecting"。排查结论写到 [`incident-2026-05-08-claude-resume-init-watchdog.md`](./incident-2026-05-08-claude-resume-init-watchdog.md)：

- 不是 MCP 启动卡住——chat-bridge `connected to MCP transport` 已打。
- 真因：claude 用 `--resume ff971918-…` 加载 5.6 MB / 3501 行 jsonl，超过 30s 没发 `session_init`，被部署版本的旧单层 watchdog SIGTERM。
- 跟同一天的 codex incident 同根（都是 30s 单层硬超时太严），不同的是触发面是 claude resume 大会话。
- P1 三层 watchdog + retry-once 已经在 `refactor/ws` 上落地，但桌面 app 还跑旧编译产物——重新打包是当前最高优 follow-up。
- 临时恢复：DB 把 `cli_session_id` 置空走全新会话（牺牲 claude 端 context），或改 `status='idle'` 多试几次。

---

## 2026-05-08 — Claude resume incident 真因锁定 + 修复方案敲定

跟 @Cindy 在 `code start` 频道经过完整四象限 probe（jsonl 大小 × stdin 是否预热）+ 5 种 priming payload 实测 + 同一 session 历史日志对照，把 `incident-2026-05-08-claude-resume-init-watchdog.md` 的根因从「大 jsonl resume 慢」纠正为：

- **根因**：`claude --input-format stream-json` **deterministically** 不发 `system.init`，直到收到第一条真实 user message（与 jsonl 体量、--resume 流程通通无关）。
- **触发条件**：silverhand `doDrainInbox` 在 inbox 空时 return 不写 stdin；`start()` 注释里的「prime stdin 兜底」在 empty inbox 路径下是 no-op。
- **PR-A 三层 watchdog 不修这个 incident**：spawn 后 ~1.1s 收 `system.hook_started` → manager 进入 post-protocol → 30s 后 `reason=post_protocol` SIGTERM；retry-once 同样空 stdin。
- **修复方案（task #167，@Cindy 实施）**：driver `kickoffMode = 'self_inits' | 'requires_first_message'` + manager **deferred init watchdog**。claude empty-inbox spawn 后正常拿 pid 并标 `active`（不撒谎，process 真在跑），但**不 arm** init watchdog；等第一条真实 user message 写 stdin 时再 arm。`active` 语义从「init observed」松绑到「process 已存活、可接收 stdin」。
- **不能做**：(a) stdin priming（任何 well-formed payload 都触发 chargeable Anthropic turn + transcript 落盘 + UI 可见消息，5 种变体已穷举验证）；(b) silverhand 自管 claude history（用户已否决，成本太高、break 太多）；(c) 写假 active（`active ⇔ live handle/pid` 是 manager / stop / restart / exit handler 的核心不变量，写假会破坏一连串）。

文档重写（task #168，本提交）覆盖：
- `docs/incident-2026-05-08-claude-resume-init-watchdog.md` §0/§3/§5/§7 重写，附完整实验数据表 + 同 session 对照 + manager smoking gun 行号。
- `CLAUDE.md` §2 把「hangs intermittently if stdin starts empty」改成「deterministically withholds system.init until first real message」+ 指向 incident 文档 + 明确 deferred init watchdog 修复方向 + 显式禁止 stdin priming。

实验文件留在 `/tmp/silverhand-claude-probe/`，含 probe.mjs / probe-payload.mjs 和所有 cell 原始日志可复盘。

---



跟 @Cindy 在 `code start` 频道讨论收敛 [`incident-2026-05-08-codex-init-watchdog.md`](./incident-2026-05-08-codex-init-watchdog.md) 的修复方案，锁定三段：

- **PR-A（task #163, @Cindy）**：把 `INIT_WATCHDOG_MS` 拆成三层 timer（byte liveness + pre-protocol cap + post-protocol session）+ driver `classifyInitProgress` hook + retry-once / cooldown。driver 接口 side-effect-free，retry/cooldown 全部走 manager 内存态，不动 DB enum / DTO。
- **PR-B（task #164, @Alice，本提交）**：`packages/backend/src/runtimes.ts` 在 macOS 上把 `/Applications/Codex.app/Contents/Resources/codex` 排在 `which codex` 之前（不做版本号一致校验）；`probeVersion` 超时 3s → 30s，避免 wrapper 冷启动被探测误报成未安装。新增 `PLATFORM_CANDIDATES` 表 + `resolveBinary(kind, bin)` 逻辑，结构上为其他 runtime 的同类优化预留口子。`pnpm typecheck` 通过；现有 `tests/manager/lifecycle.test.ts` 失败属 PR-A 未落地的预期红，与本 PR 无关。
- **Doc rewrite（task #165, @Alice）**：incident §5/§7 改写到与上面对齐，§5 顶部加 `session_init` 语义澄清 callout（强调 `session_init` 是 thread-ready 信号，**不是**「进程活着」也**不是**「app-server 已 handshake」）。

P3（`-c model_reasoning_effort`）verified-keep：bundle alpha 与 npm CLI 都通过 codex-rs config 层支持 `-c key=value`，行为等价，driver 不动。

---

## 2026-05-06 — Attachment 单条 DELETE + Composer orphan cleanup

补完 attachment Phase 2 收尾两项（GET 鉴权另开频道讨论，暂未做）：

- **Backend**：
  - `AttachmentRepo.isReferencedByMessage(id)` 走 SQLite JSON1 (`json_each` over `metadata.attachments`) 判断是否被任何 persisted message snapshot 引用。
  - `AttachmentService.deleteOrphan(id, viewer)` 三段校验：row 存在 / viewer 是 user-uploader / 未被引用，通过则删 DB row + best-effort sweep blob。
  - `DELETE /api/attachments/:id` 路由：404 / 403 / 409 / 204 四态。
- **Renderer**：
  - `api.ts` 加 `deleteAttachmentBestEffort(id)` fire-and-forget helper。
  - Composer 用 `uploadedIds` ref 跟踪上传成功但未发送的 attachment id：onSuccess 加入 / submit 清空 / onError 还原 / removePending(state='done') 即时 DELETE + `releaseAttachmentPreview` / 组件 unmount 时全部 best-effort DELETE + release。`releaseAttachmentPreview` 终于有了真实调用方。
- **测试**：4 个新增路由测试覆盖 204 happy path、409 referenced、404 unknown、403 agent-uploaded by user。`pnpm test` 19 passed；typecheck 全 4 个 workspace 通过。

GET 鉴权设计讨论挪到 #attachment 鉴权讨论 频道，避免阻塞本批改动。

---

## 2026-05-06 — Attachment 系统 Phase 1 + Phase 2 落地

按 `docs/attachments-design.md` 把 attachment 全链路落到 single-machine local 模式。task #77 关闭。

**Backend**:
- v12 migration: `attachments` 表（`channel_id` 鉴权根 + `source_conversation_id` 溯源）+ `messages.attachments` JSON 列。
- `LocalBlobStorage` + `BlobFileStorage` interface 抽象，blob 落 `~/.silverhand/blobs/`，DB 只存 `storage_key`。
- `AttachmentService`：上传（multipart + 文件头 sniff + 扩展名兜底 + 10MB 上限）、scope 校验（thread → parent channel）、`sweepForChannel` 物理清理。
- public 路由 `POST /api/channels/:cid/attachments` / `POST /api/threads/:tid/attachments` / `GET /api/attachments/:id`。
- 内部路由 `POST /internal/conversations/:cid/agents/:aid/attachments` + `/locate` + 在 `agentSendConversationMessage` 接 `attachmentIds`，全部带 membership 校验。
- workspace DELETE / agent DELETE 在 cascade 前先 `sweepForChannel`，避免 row 没了 blob 还在。Agent DELETE 修了一个排序 bug：`listDmChannelsForAgent` 必须在 `removeAgent` 之前抓取，否则 join 表已被清空返回空列表。

**chat-bridge**:
- 新增 MCP 工具 `upload_file(file_path)` / `view_file(id) → { path }`。
- `send_message` schema 加 `attachment_ids?: string[]`（cap 20）。
- `view_file` 走 locate 拿本地路径零拷贝（local 模式），未来远端模式 fallback 到 HTTP 下载到 `~/.silverhand/attachments-cache/`。

**Renderer**:
- `MessageItem` 渲染附件：image 用居中 modal lightbox（`max-w: min(920px, 88vw)` × `max-h: 82vh`），non-image 用 `window.open` 下载。
- `Composer` 加按钮 + 拖拽 + Cmd+V 粘贴，image chip 显示缩略图（点击进 lightbox），非 image 显示文件名。
- `attachment-blob-cache` 提供渲染端 LRU（cap=128）：Composer 上传成功时 `setAttachmentBlobUrl(id, previewUrl)` 把 ownership 移交给 cache；MessageItem 同步命中 cache 避免 optimistic→真实消息切换时闪屏。`<img onError>` 处理 LRU 撤销后的 stale URL，回退到 `loadAttachmentBlobUrl` 重新拉。
- 完整的 URL 生命周期：addFiles 创建 → onSuccess 移交 cache → onError/removePending(non-done)/Composer unmount cleanup 撤销。

**Driver/格式化**:
- `formatAttachmentSuffix` 在 `formatLiveMessage` / `formatInboxBatch` 共用，给 agent 的文本里追加 `[N attachments — use view_file with the id below to read]`，不污染 stream-json。
- `platform-prompt.ts` 加 `## Attachments` 段说明工具用法。

**测试**: 30+ 新增测试覆盖 repo / service / 公共路由 / 内部路由 / 删除 sweep / DM 删除排序回归 / `formatAttachmentSuffix` 单测。`pnpm typecheck` 4 个 workspace 全过；`pnpm test` 全绿。

**已知 gap**（详见 `attachments-design.md` §13）：`GET /api/attachments/:id` 还没有 channel membership 鉴权（多人/远端时必须补）；composer 上传后未发送的 orphan 没有 TTL 清理；缺单条 attachment DELETE 接口。这些都属于 Phase 3 范围，不影响 v1 单机 happy path。

---

## 2026-05-06 — 架构文档同步 hard cutover 术语

将 `docs/core-design.md`、`docs/app-layout.md`、`CLAUDE.md` 与 #79 hard cutover 代码改动对齐：

- `core-design.md`：§3.4 chat-bridge 启动参数改为 `--conversation-id`，内部路由 `/internal/conversations/...`；§3.6 MCP 工具名全部换成最终名称（`spawn_child_session` → `create_thread`，`close_session` → `close_thread`，`child_session_id` → `thread_id`，`parent_channel_id` → `parent_conversation_id`）；日志/边角 case 文案同步。
- `app-layout.md`：§7 Thread 节 API 返回 `thread_id`，`parent_conversation_id` 替代 `parent_channel_id`，`close_thread` 替代 `close_session`。
- `CLAUDE.md`：产品描述改为"三层 Workspace → Channel → Thread"，日志文件名用 `conversationId`。

---

## 2026-05-05 — Workspace/Channel/Thread hard cutover 剩余工作梳理

补充 `docs/workspace-channel-thread-hard-cutover.md`，明确当前 v11 只是 shadow schema：`workspaces/conversations` 已存在并可承载新语义，但 backend/runtime/frontend 仍有不少 legacy `channels/sessions` 读写路径。文档把彻底对齐所需的 DB v12 迁移、shared DTO/path cleanup、backend repo/route/ConversationManager 切换、frontend hook/query key 清理、MCP internal route 更新、测试矩阵和真实 DB 切换安全步骤列成 checklist。

同时在 `CLAUDE.md` 的 authoritative docs 索引中挂上该文档，避免后续把当前 shadow 状态误认为已经完成全量切换。

---

## 2026-05-04 — codex thread/resume "thread not found" 调查

第三份 incident 文档：`docs/incident-2026-05-04-codex-thread-resume.md`。

dev↔release 切换后 Cindy 首次唤醒会出现 "@Cindy 启动失败：thread not found: \<uuid\>"。结论：task #15 的 fatal-error 识别 + 清 cli_session_id + 下一次走 thread/start 这条恢复链路在 release 是按预期工作的（已验证 Cindy 当前已 active 运行新 thread）；dev 看起来"安静"是因为 dev 跑的 backend 还是 task #15 之前的旧 build，错误事件被 swallow，cli_session_id 不被清。底层"为什么 codex 会丢 thread"是上游行为——磁盘 rollout 和 state\_5.sqlite 的 row 都在，但 codex `thread/resume` 仍然拒绝；最可疑的是客户端身份指纹（VSCODE\_\* env 之类）在 dev / release 之间不一致，codex 内部校验把 release 客户端拒了。文档里给了 4 条按 ROI 排序的缓解措施（最便宜的是改友好那条系统消息文案）和按字段直查的调试小抄。

---

## 2026-05-04 — agent silent-turn 现象总结（独立于生命周期 bug）

补充第二份 incident 文档：`docs/incident-2026-05-04-agent-silent-turn.md`。

跟同日的生命周期 incident 是**两类不同问题**——这一个里 agent 进程一切正常、消息也送达了、turn 也正常 close，但模型自己选择不调 `send_message` 就 stop。共三个观察案例（"全部关闭"漏 task status、PIN sidebar 44 次 tool_call 0 次 send_message、`@Alice 还在工作吗` 直接 turn_end），统一的 fingerprint 是 `agent: turn_end + pendingDeliveries=0 + 0 个 send_message tool_call`。文档里给了跟 lifecycle bug 的判别 checklist、按 ROI 排序的 4 条 follow-up 缓解措施、以及在修复前能让 agent 大概率回话的发问 workaround。task #14 已经修了 UI 不再显示假 thinking，但不能让 agent 回话——真修要走 driver/prompt 层。

---

## 2026-05-04 — agent 生命周期修复（before-quit / resume init / reconcile 探活）

修了三个互相放大的 bug，导致一次 release ↔ dev 切换后 agent 静默挂死、UI 一直显示 connecting。完整事故分析、根因、修复方案、调试小抄见 `docs/incident-2026-05-04-agent-shutdown.md`。

简短摘要：

- **(b) `--resume` 后 status 不会翻 active，watchdog 也不会救** —— `session_init` dedup 用 `cliSessionId` 比较，但 resume 时这个值是预加载的，dedup 误判跳过首发 init 的副作用。watchdog 同样被旁路。修法：加显式 `initObserved: boolean` flag。
- **(a) `before-quit` 不 await + `stop(hard)` 不等 child exit → 子进程孤儿化** —— Electron 不 await async handler，`.unref()` 的 SIGTERM/SIGKILL timer 在主进程退出时被丢弃。修法：`event.preventDefault()` + 真正 await `child.exit`。
- **(c) `reconcileOnBoot` 只改 status 不杀孤儿** —— 配合 (a) 留下的孤儿造成 codex thread 抢占。修法：reconcile 时 `process.kill(pid, 0)` 探活 + SIGKILL。

`pnpm typecheck` 全 4 个 workspace 通过；`pnpm test` 196/196（新增 5 条回归覆盖三个修复点）。release dmg 已重新打包待手动验收。

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
- **`InboxRepo`** —— `conversation_inboxes` durable delivery queue：`ensureDelivery` / `enqueue` / `listPending(sid, aid)` JOIN messages / `markDelivered`
- **inbox drain**：`session_init` 时拉 pending → `formatInboxBatch(items, agentNameById)` 拼成 "You have N messages waiting…[from @x]\n…\n---\n[from @y]\n…" → `driver.encodeStdinMessage` → `child.stdin.write` → `markDelivered`

### Phase 3：投递 + 控制

- **`deliverMessage(sid, aid, messageId)`**：先 `ensureDelivery` 写入 `conversation_inboxes` durable row；handle 不在 → 保持 pending 等下次 spawn drain；存在 + `direct` 或 `isSafeBoundary` → 立刻 `writeUserMessage`；存在 + `gated` 中段 → 进 `pendingDeliveries` 当前进程 cache，`turn_end`/`compaction_finished` 时 `flushPending` 一次性 combined push，成功写入后再 `markDelivered`
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

### codex reasoning_effort

调研：slock daemon 这块只是字段透传。slock 的"web 上调 effort"是 slock.ai 云端做的，daemon 代码里看不到 UI 实现。

slock 的字段透传：
- 字段名 `reasoningEffort`（per-agent string，不强校验）
- 传给 codex：JSON-RPC `thread/start.params.config.model_reasoning_effort = <value>`（与 `~/.codex/config.toml` 的 `model_reasoning_effort = "..."` 同义）
- 传给 copilot CLI：`--effort <value>`
- 不传则用 codex 自己 config.toml 默认（用户当前 `xhigh` 推理一次 ~22s）

当前实现：
- `agents.reasoning_effort` 通过 DTO/zod 限定为当前 Codex catalog 支持的 `low | medium | high | xhigh`
- `ConversationManager` 透传 per-agent `reasoning_effort` 到 `DriverSpawnContext.reasoningEffort`
- `CodexDriver.buildArgs` 通过 `-c model_reasoning_effort=<value>` 覆盖 Codex config；未设置则用 Codex 自己 config.toml 默认
- 前端 agent profile 仅在 runtime=codex 时显示 select；Claude Code 暂不接入，按其全局配置/模型自身行为处理



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

## 2026-05-03 (后续 +3) — `session_init` watchdog + Channel 归档

清掉 `docs/progress.md` 中遗留的两项 P2 carry-over。

### `session_init` watchdog

背景：偶发场景下 `claude` 子进程 spawn 成功但 `session_init` 永远不来（多半是 stdin 没及时被 prime、或 launcher 路径看似存在但实际拉起来后默不作声）。原本只能靠用户看到"starting…"卡死后自己手动 stop。

实现（`packages/backend/src/session-manager.ts`）：

- 每个 `AgentHandle` 加 `initWatchdog: NodeJS.Timeout | null` + `initTimedOut: boolean`
- spawn 之后立即 `startInitWatchdog(handle)`：30s 超时（`INIT_WATCHDOG_MS`，class field `initWatchdogMs` 暴露给测试覆盖）
- 触发后：广播 `agent_init_timeout` SSE 事件、置 `initTimedOut=true`、`SIGTERM` 子进程，5s 后兜底 `SIGKILL`
- 清理点：`session_init` 第一次到达（防止后续 init 帧重复清）、`stop()` 主动停、exit handler
- exit handler 状态判定加一支：`status = handle.initTimedOut ? 'crashed' : (handle.intentionallyStopped || code === 0 ? 'idle' : 'crashed')` —— 区分"用户停的"与"我们因为 init 超时杀的"
- oneShot driver 的 respawn-on-pending-inbox 路径检测到 `initTimedOut` 时不重启，避免无限循环

测试（`packages/backend/tests/manager/lifecycle.test.ts`）：3 条新 case
- 正常 init 在窗口内到达 → watchdog 不触发
- hard-stop 在 init 之前 → watchdog 被清掉，没有伪 timeout
- (隐式) timeout 触发路径已被现有 mock-claude `MOCK_CLAUDE_NO_INIT` 覆盖，但加显式 case 时机不太好稳定，留作后续

### Channel 归档（软删）

需求：用户长期不用的 channel 想从主侧栏隐去但不丢历史，而不是直接删。

数据 / 后端：

- migration v8 `channel_archive`：`channels` 加 `archived_at INTEGER`；建 partial index `idx_channels_active(updated_at DESC) WHERE archived_at IS NULL`
- `ChannelDto` 加 `archived_at`；新 zod schema `ArchiveChannelInputSchema = { archived: bool }`
- `ChannelRepo.setArchived(id, archived)`：写 `archived_at = now / null` 同时 touch `updated_at`
- `PATCH /api/channels/:id/archive`：同状态返回 200 no-op；非法 body 400；不存在 404
- 4 条新路由测试

前端：

- `useArchiveChannel` mutation
- 侧栏 (`Sidebar` + `ChannelsPanel`) 把 channels 拆成 `dms / regular / archived` 三桶，新增 `ARCHIVED` group（默认折叠 `defaultExpanded={false}`），混合 kind 渲染靠 `ChannelGroup` 改用 per-row `c.kind` 选 icon / 转 DM 显示名
- `ChannelSettingsDialog`：在 danger zone 之上加一段 archive toggle —— `Archive` / `ArchiveRestore` 图标，操作完成后自动关闭对话框，让用户看到 channel 归位
- `Titlebar`：channel 标题旁加 `archived` 灰色 pill，提醒"你现在看的是个归档频道、不在主列表里"

### 验证

- `pnpm typecheck` 全过（4 个 workspace）
- `pnpm test` 143/143（+3 watchdog +4 archive）
- UI 由用户人工 review 通过

### 仍未做

- ~~Codex / Cursor driver 单元测试~~ ✅ 见下文
- 一些零散的 nice-to-have（AgentView Restart 按钮、ChannelMembers popover 跳转、DM 短链 `/dm/:agentName`、jumpTarget URL 化、Settings sub-tab 路由、done task 清理策略、NavRail Tasks active 数 badge）

## 2026-05-03 (后续 +4) — Codex / Cursor driver 单元测试

清掉 carry-over 的最后一项。两个 driver 之前只在生产路径上有人工 review，没有任何自动化覆盖；任何 protocol 改动都得先把 mock 跑起来才能验证。

新增两个测试文件，全程不 spawn 真实子进程，靠 `DriverIO` mock + 直接喂 `parseLine` 实现。

### `tests/drivers/codex.test.ts` (22 条)

- **静态字段** —— `kind / binary / busyDeliveryMode / oneShot / supportsNativeStandingPrompt / mcpToolPrefix` + `applyEnv` 不可变性
- **`buildArgs`** —— `app-server --listen stdio://` 前缀；`-c mcp_servers.chat.*` 配置成对出现；env 名含 `.` 时走 quoted-key 形式（`mcp_servers.chat.env."with.dot"`）
- **JSON-RPC 握手** —— 用 `CapturedIO`（mock `writeLine` 累计行数组）追踪 driver 输出：
  - `initialize` 请求 → server 回 `result` → driver 自动发 `initialized` notification + `thread/start` 请求
  - 拿到 `thread/started` 时发 `session_init` 事件，重复同 id 不再发
  - `cliSessionId` 非空时改用 `thread/resume`
  - `initialPrompt` 非空时收到 `thread/started` 自动 `turn/start`
  - initialize 错误响应 → 不继续后续请求 + 抛 `error` 事件
- **`parseLine`** —— 覆盖所有事件分支：`turn/started → thinking ''`、`item/agentMessage/delta → text`、completed 阶段去重（已 streamed 的不重发）、`mcpToolCall` 命名拼接、`commandExecution → shell`、`contextCompaction → compaction_*`、`turn/completed status=failed → error + turn_end`
- **`encodeStdinMessage`** —— threadId 缺失返回 null；无 active turn 走 `turn/start`；有 active turn 走 `turn/steer` 带 `expectedTurnId`

### `tests/drivers/cursor.test.ts` (17 条)

- **静态字段** + `applyEnv` 强制 `FORCE_COLOR=0/NO_COLOR=1` 且不动入参
- **`buildArgs`** —— 固定前缀 `--print --output-format stream-json --yolo --approve-mcps --trust`；最后一个 argv 是合并的 kickoff prompt（standing prompt + initialPrompt）；空 prompt 时 fallback 到 "stand by" 提示；`--resume` / `--model` 透传；`<workspace>/.cursor/mcp.json` 写入正确的 `mcpServers.chat` 配置（含 / 不含 env）
- **`parseLine`** —— `system/init → session_init`、`system/status compacting → compaction_started`、`compact_boundary → compaction_finished`、assistant 内容块（thinking / text / tool_use 都带 toolCallId）、`result success → turn_end`、`result error → error + turn_end` 包含错误详情聚合，无详情时 fallback `"Execution failed"`，未知 type 静默忽略

### 关于 cursor "respawn-on-pending-inbox" 的覆盖

设计文档原话提到这条路径要测，但它实际属于 SessionManager 行为而非 driver 协议（`session-manager.ts:343` 的 oneShot 退出后 `inboxes.listPending(...).length > 0 → this.start(...)`）。要给它做端到端测试需要先写一个 mock-cursor 二进制（处理 argv 收尾 → 退出），目前先记一笔 follow-up，等真有 cursor 相关的 regression 再补。

### 验证

- `pnpm typecheck` 全过（4 个 workspace）
- `pnpm test` 182/182（+22 codex +17 cursor，从 143 提升到 182）

### 仍未做

- cursor oneShot respawn 端到端集成测试（需要先写 mock-cursor）
- 一些零散的 nice-to-have（AgentView Restart 按钮、ChannelMembers popover 跳转、DM 短链 `/dm/:agentName`、jumpTarget URL 化、Settings sub-tab 路由、done task 清理策略、NavRail Tasks active 数 badge）

---

## 2026-05-05 — workspace/channel/thread 术语重命名（文档更新）

完成三轮 PR（backend #62、MCP/prompts #64、frontend #67）的代码重命名后，更新所有权威设计文档，使文档与代码保持一致。

### 术语映射

| 旧术语 | 新术语 | 说明 |
|--------|--------|------|
| `channel`（外层容器，含成员/agents）| `workspace` | DB 表 `channels` → `workspaces` |
| `session`（对话流）| `channel` | DB 表 `sessions` → `conversations` |
| `child session` / 嵌套讨论 | `thread` | 已在代码侧早期重命名 |
| `SessionManager` | `ConversationManager` | 后端核心类 |
| `/api/channels` | `/api/workspaces` | HTTP 路由前缀 |
| `/api/sessions/:id` | `/api/channels/:id` | HTTP 路由前缀 |
| `/c/:channelId/s/:sessionId` | `/w/:workspaceId/c/:channelId` | URL scheme |
| `session_agents` 表 | `conversation_agents` 表 | DB join 表 |
| `channel_members` 表 | `workspace_members` 表 | DB join 表 |

### 修改文件

- **`docs/core-design.md`**：更新 §2 实体模型（ER 图、§2.4 Workspace、§2.5 Channel）、§3 多 agent 协作机制（§3.1 投递逻辑、§3.4 chat-bridge 参数、§3.5 ConversationManager、§3.6 Thread）、§4 三层知识（文件路径、onboarding 流程、系统 prompt 模板）、§5 用户操作流、§6 v2 演进、§7 非目标、§8 已废弃设计、§9/§10 待决策 + Deferred design、§11 Attachments。文档底部版本行更新。
- **`docs/app-layout.md`**：更新 §0 设计原则、§1 整体布局图、§2 Titlebar、§3 Sidebar（channels→workspaces）、§4 SessionsSidebar→ChannelsSidebar、§6 Save（DB schema + 跳转逻辑）、§7 Thread（API 路径 + 实现要点）、§10 一致性约定、§11 Open questions。
- **`CLAUDE.md`**：更新 "What this is" 段（Channel+Multi-Session → Workspace+Multi-Channel）、workspace layout 中 `SessionManager` → `ConversationManager`、"Architecture in five facts" 全部 5 条（workspace/channel 两层、ConversationManager、provisionWorkspace/joinWorkspace 等）、logging 段（log 文件名模式）。

### 原则

- 只更新术语，不更改技术细节或实现逻辑。
- 未接触：`docs/workspace-channel-thread-rename.md`（重命名计划文档本身）、`docs/progress.md`（此条之前的历史）、所有代码文件。

---

## 2026-05-05 — MCP system 文档化

新增 `docs/mcp-system.md`，把当前 `mcp__chat__*` tool surface 固化成维护文档：

- 核对来源：`packages/chat-bridge/src/server.ts`、`packages/chat-bridge/src/client.ts`、`packages/shared/src/api/dto.ts`、`packages/backend/src/routes.ts`。
- 覆盖工具：`send_message`、`create_thread`、`close_thread`、`create_channel`、`list_tasks`、`create_tasks`、`claim_tasks`、`unclaim_task`、`update_task_status`。
- 明确缺席工具：旧 `create_session` / `close_session`、history pull、memory/consensus、attachments。
- 在 `CLAUDE.md` 增加维护约定：后续 MCP tool、schema、internal route、task 行为或 `platform-prompt.ts` 规则改动，必须同步 `docs/mcp-system.md`。

---

## 2026-05-15 — System message UI redesign · PR-1（subtype registry + drift guard）

第一轮 UI 优化的结构前置。把"哪些 system message subtype 存在"从弱契约（producer 各自硬编码字符串、metadata 自由 JSON）抬到 shared 类型层 + 静态 drift guard，为后续 PR-2..PR-6 各自做 subtype-specific UI 改造铺路。**无视觉变更**——本 PR 只迁移渲染逻辑到 registry，沿用现有 3 卡 + 4 折叠 + 其余 narration。

- **新文件 `packages/shared/src/system-messages.ts`**：单一来源。
  - `SYSTEM_SUBTYPES`（13 项 const tuple）+ `SystemSubtype` union；`LEGACY_SUBTYPES`（3 项历史 DB 残留：`join` / `session_context` / `child_summary`）+ `LegacySystemSubtype`。
  - `TASK_MUTATION_KINDS` + `TASK_SUBTYPES` 显式 4 元 tuple；`TaskSubtype` union。Pure-type `Assert<T extends true>` 双向断言钉死 `TaskSubtype === \`task_${TaskMutationKind}\``——加 kind 漏 subtype 字面量（或反之）会 typecheck fail。
  - 两个 helper：`systemSubtype(name)`（identity，narrow argument 给 drift test grep）和 `taskSystemSubtype(kind)`（template-literal `task_${kind}` 唯一入口）。
  - `resolveSubtype(raw)` 三态：`current`（registry 处理）/ `legacy`（fallback）/ `unknown`（fallback）。`null` / 缺失 metadata 归 unknown，不归 legacy。
- **producer 改造**（11 个 call site，全部改用 helper）：
  - `conversation-manager.ts:1103`（session_cleared）、`mention-cc.ts:125`（mention_cc）、`channel-service.ts:241`（channel_context）、`thread-service.ts:292/307/366/436`（thread_anchor / onboarding / child_context / thread_summary）、`schedule-service.ts:518`（schedule_fire）、`task-service.ts:1141`（`taskSystemSubtype(args.kind)` 替换 `task_${args.kind}` 模板字面量）、`routes.ts:516/586/1724`（onboarding / rename / 二次 onboarding）。
- **renderer registry**：`apps/desktop/src/renderer/components/chat/SystemMessage.tsx` 重写。
  - `systemMessageRenderers: Record<SystemSubtype, ComponentType<RendererProps>>`——TS exhaustiveness 钉死，新增 subtype 必须配对 renderer。
  - 现有 3 卡（`MentionCcCard` / `SessionClearedCard` / `ThreadSummaryCard`）保留视觉、迁入 registry。现有 4 折叠（`onboarding` / `child_context` / `thread_anchor`）+ 1 已 retire 的 `child_summary` 简化为 `CollapsibleNarration` 组件。其余（`channel_context` / `schedule_fire` / `rename` / `task_*`）暂时落 `GenericNarrationFallback`，PR-2..PR-6 各自替换。
  - **删 `inferSubtype`**——历史 onboarding 老 row 不再靠 content 前缀回退（用户确认丢）。legacy 与 unknown 都走 generic narration，不伪装。
- **测试**：
  - `packages/backend/tests/shared/system-messages.test.ts`（13 测）：常量唯一性、`taskSystemSubtype` 映射完整、`resolveSubtype` 三态、`readSubtype` metadata 防御解析。
  - `packages/backend/tests/observability/system-message-drift.test.ts`（4 测）：静态扫描 backend src 里 `systemSubtype('…')` / `taskSystemSubtype('…')` 字面量参数，与 `SYSTEM_SUBTYPES`/`TASK_MUTATION_KINDS` 双向 diff，发现 producer 写未注册 subtype 或 registry 多余 entry 直接 fail。也容忍 `taskSystemSubtype(args.kind)` 这种动态调用（task-service.ts 实际用法）——只要存在动态调用就视为覆盖全部 `TASK_SUBTYPES`。
  - `apps/desktop/src/renderer/components/chat/Markdown.test.ts` 加 3 测：legacy `child_summary` / `join` 走 generic narration（非 collapsible），pre-metadata 老 onboarding row（content 前缀但无 subtype）也走 generic narration（钉删 `inferSubtype` 的语义）。
- **质量门**：4 包 typecheck 全绿；backend 636/636 pass（+17 新测）；desktop 132/132 pass（+3 新测）。

后续 PR：PR-2 task event row + metadata schema 扩展（`task_message_id` / `actor` / `task_title` / `task_assignee`）；PR-3 session_cleared 退 toast；PR-4 schedule_fire 扁平 banner；PR-5 channel_context / child_context / thread_anchor 统一 quote-card 系列；PR-6 onboarding badge / rename ↻ icon。

## 2026-05-15 — System message UI redesign · PR-2（task event row + metadata enrichment）

DB 1646 条 task_* 系统消息（占系统消息总量约 95%）从居中斜体 narration 升级为 **task event row**——同一 task 的事件不连线（mocking 时已验证：同一 task 的 mutation 之间往往隔了大量对话，timeline 视图是错觉），靠 `#task:N` chip 视觉标识 + hover popover（PR-4 落地）聚合。

**Schema 扩展**（`packages/shared/src/system-messages.ts`）：

- 新增 `TaskSystemActorSchema`（discriminated union: `user{id:string|null,name}` / `agent{id,name}`）+ `TaskSystemActor` 类型。`id` 在 user 分支允许 `null`（兼容 v1 legacy 无 userId 的写入）。
- 新增 `TaskSystemMetadataSchema`（zod object，`.safeParse` 兼容老行）：
  ```
  { subtype, task_number, task_status (after-state), task_message_id,
    task_title, task_assignee, actor }
  ```
  `task_status` 是 mutation **之后**的状态快照（`task_create → todo`、`task_unclaim → todo`、`task_status → status`），事件类型由 `subtype` 决定，不需要 prior-state 字段；schema docstring + `TaskStatusAfterMutation` type alias 把语义钉到读端。
- 新增 `readTaskSystemMetadata(metadata)` 防御解析——legacy row（PR-2 之前只写 `task_number` + `task_status`）`safeParse` fail → 返回 `null`，renderer 走 degraded fallback（content as muted narration），不抛。

**Producer 改造**（`packages/backend/src/services/task-service.ts`）：

- 新私有方法 `taskSystemActor(actor: TaskActor): TaskSystemActor`：把 `UserPrincipal | AgentPrincipal` 投到结构化 actor 元数据；agent 优先取 `display_name`，回落 `name` / id。
- `broadcast()` 签名加 `actor: TaskActor`，metadata 现在写 `{subtype, task_number, task_status, task_message_id, task_title, task_assignee, actor}`——renderer 不再从 `message.content` 解析 actor / verb / status。
- `claimTaskUser` / `unclaimTaskUser` / `updateStatusUser` 三个 user-driven 内部方法 dispatcher 改为接受 `actor: UserActor`，全部 7 个 `broadcast()` call site 都传 actor。

**Renderer**（`apps/desktop/src/renderer/components/chat/SystemMessage.tsx`）：

- 新 `TaskEventRow` 组件，4 个 `task_*` registry entry 全部指向它。
- 三个子形态：
  - `task_create` / `task_claim` / `task_unclaim`：`<dot> <actor> <verb> <chip>`
  - `task_status`：`<dot> <chip> → <status pill> by <actor>`
  - 缺 metadata（legacy row）：`<TaskEventLegacyFallback>` muted italic content
- 状态色仅用于 dot + status pill；row 整体 baseline = `text-text-secondary`（比真消息弱），符合 Cindy 的视觉规范要求（msg `AjrWQyiFyq08zMya`）。
- `TaskEventChip` 是静态版的 `#task:N` chip——直接用 metadata 的 number/title 渲染，不 fetch、不 skeleton；通过 `useTaskRefContext().onOpenTask` 接管点击；无 context 时 inert。
- `unclaim` 用虚线圆圈 dot 区分（unclaim 后 status=todo，但视觉语义不是"重新待领"，是"前一个 assignee 退出"）。

**测试**：

- `packages/backend/tests/services/task-service.test.ts` 加 6 测：4 个 subtype 各验证 metadata 完整字段（subtype / task_message_id / task_title / task_status after-state / task_assignee / actor）；user actor `id=null/name='user'` 路径；agent actor `display_name` 优先级。
- `apps/desktop/src/renderer/components/chat/Markdown.test.ts` 加 7 测：`task_create/claim/unclaim/status` 4 形态各自 dot 颜色 + verb / pill / by-actor 文案；user actor 渲染 `@you`（formatUserDisplayName 投影）；no-handler 时 chip inert；legacy row（少字段）回落 muted narration `data-task-event-legacy="1"`。

**质量门**：4 包 typecheck 全绿；backend 642/642（+6）；desktop 139/139（+7）。

**未变（按设计跳过）**：

- 无 DB 迁移——metadata 是 message row 的 free-form JSON 列，新字段直接写。
- 无 task_events 表——每条 task system message 本身就是事件记录，`created_at` = 事件时间，靠 metadata.task_message_id 反查同 task 历史已经够用。


## 2026-05-15 — System message UI redesign · PR-3（session_cleared 退 toast → inline audit row）

`session_cleared` 现状是消息流里唯一一处 toast 风格（red border + bg-error tint + Eraser destructive icon），跟 IM 的整体 chat 风格违和；图标 `Eraser` 还隐含"删除"语义，而实际行为是"重置 session 上下文"，不是删除任何持久数据。本 PR 改成消息流里的轻量 inline audit 行，图标换 `RotateCcw`（逆时针重置箭头）。

**Schema**（`packages/shared/src/system-messages.ts`）：

- 新 `SessionClearedMetadataSchema`：`{subtype:'session_cleared', agent_id, agent_name, actor_user_id:nullable, previous_cli_session_id_prefix:nullable, was_running}`。原 producer（`conversation-manager.ts:1104`）已经在写这些字段，只是没有 schema 锁定；本 PR 补上。
- `readSessionClearedMetadata` defensive parse；缺字段 → null → renderer 走 legacy fallback。

**Renderer**（`apps/desktop/src/renderer/components/chat/SystemMessage.tsx`）：

- 重写 `SessionClearedCard`：完整 metadata 走 `SessionClearedRow`（结构化），缺字段走 legacy muted row（`message.content` markdown）。
- 删 toast 容器（`mx-4 my-1.5 rounded-md border border-error/25 bg-error/5 px-3 py-2`），row 退化为单行 `flex items-center gap-2 px-4 py-1 text-xs text-text-muted`。
- 图标 `Eraser`（destructive）→ `RotateCcw`（reset），不再用 error color；仅 `opacity-60` muted。
- 结构化 row 形态：`[↻] @user reset @AgentName's session context · prev <8-char hash> · was running|idle`。
  - actor user → `formatUserDisplayName` 投影（current viewer = `@you`）。
  - prev session prefix 用 `<code class="bg-bg-elevated">` mono chip，无前缀时整段省略。
  - `was_running` 翻成 "was running" / "was idle"，`data-session-cleared-running` 钉视觉测试。

**测试**：

- shared `system-messages.test.ts` +5：full parse / nullable 字段 / 缺字段拒绝 / 错 subtype literal 拒绝 / null+undefined 处理。
- desktop `Markdown.test.ts` 改 1 + 加 2：原 destructive card 测试改写为新 inline audit row（钉 `data-session-cleared`、`lucide-rotate-ccw`、不含 `border-error`/`lucide-eraser`、含结构化 actor/agent/prev/was-running）；`was_running=false` 走 "was idle" 分支 + 无 prev chip；缺 metadata 走 `data-session-cleared-legacy` 兼容 row。

**质量门**：4 包 typecheck ✅；backend 653/653（+11）；desktop 144/144（+5 / -1 改 1）。

**未变**：producer 一字未改（metadata 字段早就齐了，只是没 schema 锁）。`Eraser` 图标 import 删除。

后续 PR：PR-4 schedule_fire 扁平 banner；PR-5 channel_context / child_context / thread_anchor 统一 quote-card 系列；PR-6 onboarding badge / rename ↻ icon。


## 2026-05-15 — System message UI redesign · PR-4（schedule_fire 扁平 banner）

`schedule_fire` 现状是居中 italic narration（fallthrough），actionable 信息全在 `message.content` 里靠肉眼解析；metadata 已经记了 `schedule_id` / `spec_kind` / `actual_fire_at` / `planned_fire_at` / `missed_count` / `next_fire_at`，但 UI 没用上。本 PR 把它升级为消息流里的扁平 banner——左侧 warning 色 accent 线、header 显示 `Scheduled wake` + spec 标签、四个 status pill（fired / planned Δ / missed / next）、body 只显示用户原始 reminder。

**Schema 扩展**（`packages/shared/src/system-messages.ts`）：

- 新 `ScheduleFireMetadataSchema`：`{subtype, schedule_id, spec_kind: 'once'|'interval'|'cron', spec_summary?: string, body?: string, actual_fire_at, planned_fire_at: nullable, missed_count, next_fire_at: nullable}`。
- `spec_summary` 和 `body` optional，兼容 PR-4 之前的 DB 老行——renderer fallback 到 `spec_kind` / `message.content`。
- `readScheduleFireMetadata` defensive parse；缺字段 → null → renderer 走 muted banner（保留 banner chrome，不画 pills）。

**Producer 改造**（`packages/backend/src/services/schedule-service.ts`）：

- `deliverWake` 在 metadata 里加两个新字段：
  - `spec_summary: renderSpecSummary(dto.spec)` — 预渲染人类可读 spec 标签：`once` / `interval 60s` / `cron */5 9-18 * * 1-5`。renderer 不需要再编码 `ScheduleSpec` 的 union 形状。
  - `body: dto.message` — 用户原始 reminder 文本，没有 producer 的 "Schedule fired (kind: ...)" / "Next fire at ..." / "If nothing to do, reply 'noted, no action'" 包装。包装是给 agent stdin 看的；人类只看 reminder。
- `message.content` 不变（agent 仍然收到完整 imperative body），只是元数据多了两个字段。

**Renderer**（`apps/desktop/src/renderer/components/chat/SystemMessage.tsx`）：

- 新 `ScheduleFireBanner`：替换 schedule_fire 的 `GenericNarrationFallback`。
- Layout：`border-y border-border-subtle border-l-[3px] border-l-warning bg-bg-floating px-4 py-2`（无 rounded，与 chat 拉开层级又不像 toast）。header `[clock] Scheduled wake ... <spec_summary mono>`；pills 行使用 `bg-bg-elevated` muted 风格；body 渲染 `meta.body ?? message.content` 的 markdown。
- 4 个 pill 子组件：
  - `ScheduleFireFiredPill`：`fired <relative>` (使用 `useRelativeTime`)。
  - `ScheduleFirePlannedPill`：`planned <Δ ago|in Δ>`，正/负 delta 自动反映 late/early 语义。
  - `ScheduleFireMissedPill`：`missed N`。`N=0` 用 muted 色；`N>0` 切 `bg-warning/10 text-warning` 警示。
  - `ScheduleFireNextPill`：`next <relative>`；`next_fire_at=null`（一次性 / 已 done）整段省略。
- 缺 metadata 的老行走 muted fallback：`data-schedule-fire="0"`，仍渲染 banner chrome 但不画 pills，body fallback 到 `message.content`。
- 钉视觉测试用 `data-pill` / `data-missed-count` / `data-schedule-fire` 数据属性。

**测试**：

- shared `system-messages.test.ts` +5：full parse / spec_summary+body 缺省（legacy）容忍 / 错 spec_kind 拒绝 / 缺必填 numeric 拒绝 / null+undefined。
- backend `schedule-service.test.ts` 现有 test 加 5 行 producer-side schema round-trip：`readScheduleFireMetadata(meta)` 验证 spec_kind/spec_summary/body/missed_count/actual_fire_at 全字段——producer drift 会从 service test 直接破。
- desktop `Markdown.test.ts` +4：full metadata banner 含 4 pills + spec_summary + body；`missed_count > 0` warning 高亮；`once` 一次性省略 planned/next pills；缺 metadata fallback `data-schedule-fire="0"` 无 pills。

**质量门**：4 包 typecheck ✅；backend 658/658（+5）；desktop 149/149（+5）。

后续 PR：PR-5 channel_context / child_context / thread_anchor 统一 quote-card 系列；PR-6 onboarding badge / rename ↻ icon。

## 2026-05-15 — System message UI redesign · PR-5（context-card 系列统一）

`channel_context` / `child_context` / `thread_anchor` 三个 subtype 现状渲染不一致——`channel_context` 走居中 italic narration，另外两个走 `CollapsibleNarration`（chevron + 第一行 truncate）。视觉无差，用户分不清"这是 quoted message" vs "inherited context" vs "spawned-from origin"。本 PR 把三种合并成一套 context-card 系列：左侧 2px accent 线（kind 不同色）+ kind tag（uppercase 小标签）+ source chip + collapsible body，与现有 `MentionCcCard` / `ThreadSummaryCard` 视觉同源（共用 `bg-bg-floating` + 左侧 accent 线模式）。

**Schema 扩展**（`packages/shared/src/system-messages.ts`）：

- 新 `ThreadAnchorMetadataSchema`：discriminated `quoted_from_kind: user|agent|system` + `quoted_message_id` / `quoted_conversation_id` / `quoted_channel_name` / `quoted_content` / `quoted_from_agent_id` (nullable) / `quoted_from_user_id` (nullable) / `quoted_agent_name` (nullable) / `quoted_created_at`。原 producer 已经写完整字段，PR-5 只是套上 zod schema。
- 新 `ChildContextMetadataSchema`：`{subtype, parent_conversation_id, parent_title, summary}`。原 producer 只写 `subtype`，本 PR 加三字段；`message.content` 仍保留 `Inherited context from parent channel '<title>': <summary>` 的 imperative prose（agent stdin 读它）。
- 新 `ChannelContextMetadataSchema`：`{subtype, source_conversation_id, source_conversation_title?, created_by_agent_id, created_by_agent_name?}`。原 producer 已写 id 对，本 PR 加 snapshot 的 title + agent name。两个 optional snapshot 字段兼容 PR-5 之前的老行——缺时 ConversationRef 自己处理 source title 解析（loading → resolved → 短 id 兜底），agent name 缺时 renderer 显示 `by an agent`。不退化到 legacy fallback。
- 三个 `read*Metadata` 防御解析；`safeParse` fail → null → renderer 走 legacy fallback（左 accent 线 + kind tag block 行 + 一行 italic content，丢失 source chip / blockquote / collapsible 行为）。

**Producer 改造**：

- `thread-service.ts:createThreadFromAgent` 给 `child_context` metadata 加 `parent_conversation_id` / `parent_title` / `summary`（同 input 拿）。
- `channel-service.ts:createChannel` seed 路径在事务里 `this.conversations.get(input.actor.conversationId)` + `this.agents.get(input.actor.agentId)`，把 `source_conversation_title` 和 `created_by_agent_name` snapshot 进 metadata（之后 source 改名/归档不影响 chip 显示）。
- `thread-service.ts:createThreadFromMessage` 的 `thread_anchor` metadata 不动——本来就齐全。

**Renderer 改造**（`apps/desktop/src/renderer/components/chat/SystemMessage.tsx`）：

- 三个 registry entry（`channel_context` / `child_context` / `thread_anchor`）从 `GenericNarrationFallback` / `CollapsibleNarration` 切到独立的 `ChannelContextCard` / `ChildContextCard` / `ThreadAnchorCard`。
- 每个 card 解析自己的 metadata，构造 `ContextCardModel`（kind + tagLabel + sourcePrefix + sourceConversationId + sourceAuthorLabel + body + timestamp + defaultExpanded + blockquote），调 `ContextCardShell` 出 chrome；解析 fail → `ContextCardLegacyFallback`。
- Source chip 用 `<ConversationRef id={sourceConversationId} ... />` 渲染——clickable + hover popover + 跨 workspace via `useConversationById`。`sourcePrefix`（如 `from `）和 `sourceAuthorLabel`（如 `@shiki` / `by @Cindy`）作为可选文本片段拼在 chip 周围。
- `ContextCardShell` 三种 kind 走不同 accent 色：`quoted = bg-accent` (ink)、`inherited = bg-success` (green)、`spawned = bg-warning` (amber)。Cindy 视觉规范（msg `AjrWQyiFyq08zMya`）严格执行：accent 色仅出现在 2px 左线 + kind tag 的 bg，body 全部 neutral text。
- `thread_anchor` defaultExpanded=true + `<blockquote>` 包正文（quote IS the point of the row）；其余两种默认 collapsed，header 右侧 `expand/collapse` toggle。
- 时间戳用 `useRelativeTime`（hook 调用必须无条件，所以 `ContextCardRelativeTime` 子组件包一层，仅在 `model.timestamp !== null` 时挂载）。
- `ContextCardLegacyFallback` 用 block 布局——kind tag 单独一行，正文 `<div class="italic">` 包 Markdown，避开 inline `<span>` 嵌 block `<div>` 的 invalid HTML。
- `data-context-card={kind}` / `data-context-card-legacy="1"` / `data-context-toggle={'expand'|'collapse'}` / `data-conversation-ref="<id>"` 作 stable test selector。

**测试**：

- shared `system-messages.test.ts` +14：thread_anchor full parse + agent-quote variant + 拒绝 wrong from_kind + 拒绝缺必填 + null/undefined；child_context 4 测；channel_context 4 测（含 legacy 行 title/name 缺省容忍）。
- backend `thread-service.test.ts` `createThreadFromMessage` test 加 thread_anchor producer round-trip（`readThreadAnchorMetadata` 验证 `quoted_message_id` / `quoted_conversation_id` / `quoted_content` / `quoted_from_kind`）；`createThreadFromAgent` test 加 child_context producer round-trip（验证 `parent_conversation_id` / `parent_title` / `summary`）。
- backend `channel-service.test.ts` seed 路径加 channel_context producer round-trip（验证 `source_conversation_id` / `source_conversation_title` / `created_by_agent_id` / `created_by_agent_name` 全字段）。
- desktop `Markdown.test.ts` +6：三个 kind 各自 chip + body 形态（resolved 测试 pre-seed `conversationRefsById`，断言 `data-conversation-ref="<id>"` + title text）；channel_context 缺 title/name 兜底 chip 仍 clickable + agent suffix 退到 `by an agent`；thread_anchor / child_context legacy fallback。

**质量门**：4 包 typecheck ✅；backend 672/672（+14）；desktop 155/155（+6）。

> Follow-up commit `0572de2`（Cindy review msg `f2ywXTsC7oMAGDnM`）：
> 1) source chip 从纯文本 `sourceLabel` 升级为 `<ConversationRef>`（clickable + popover + 跨 workspace），`ContextCardModel` 重构为 `{sourcePrefix, sourceConversationId, sourceAuthorLabel}`；
> 2) `ContextCardLegacyFallback` 修 DOM 嵌套——tag 单独 block 行，body `<div class="italic">` 包 Markdown，避开 `<span>` 嵌 `<div>` 的 invalid HTML。

后续 PR：PR-6 onboarding badge / rename ↻ icon。

## 2026-05-15 — System message UI redesign · PR-6（onboarding badge + rename ↻ icon）

System-message UI redesign 系列的最后一个 PR。两件相对小的事一起做：onboarding 行加 "Onboarding" 徽章让 collapsible row 一眼可识别；rename 走结构化 metadata 渲染 `↻ #old → #new` 审计行，不再依赖 prose 文案肉眼解析。

**Schema 扩展**（`packages/shared/src/system-messages.ts`）：

- 新 `RenameMetadataSchema`：`{subtype: 'rename', old_name: string, new_name: string}`。原 producer 已经写完整字段（routes.ts:587），本 PR 只是套 zod schema + 加 `readRenameMetadata` defensive parse。
- 没有 `actor_user_id`——v1 user-principal-only，actor 隐式；如果未来 multi-user 上线和 auth 模型一起加。
- onboarding 不需要 schema：body 本身是 onboarding 指令，不同调用点（workspace join / agent DM / thread spawn）prose 形状不同，结构化反而失真。

**Renderer 改造**（`apps/desktop/src/renderer/components/chat/SystemMessage.tsx`）：

- `OnboardingRow` 替换 registry 里的 `CollapsibleNarration` 入口：保留 chevron + 第一行 truncate 的 collapsible 模式，加 inline `Onboarding` badge（accent-soft bg + accent text + uppercase）。`data-onboarding-row="1"` / `data-onboarding-badge="1"` 作 stable test selector。
- `RenameRow` 替换 registry 里的 `GenericNarrationFallback` 入口：parse metadata，缺则 fallthrough 到 `GenericNarrationFallback`（legacy 行兜底）。布局 `flex items-center justify-center gap-1.5`，`<RotateCw>` 图标 + `workspace renamed` + 两个 `<code>` chip 显示 `#old`/`#new` + `→` 分隔。
- 视觉权重：和 PR-3 SessionClearedRow 一致——单行 audit row，不挤兑常规消息。

**测试**：

- shared `system-messages.test.ts` +4：rename 完整 parse / 缺字段拒绝 / 错 subtype 拒绝 / null+undefined。
- backend `routes/channels.test.ts` 现有 rename test 加 `readRenameMetadata` round-trip（producer drift 直接破在 route test 层）。
- desktop `Markdown.test.ts` +3：onboarding badge + chevron + 第一行 preview；rename 完整 metadata `↻ #old → #new`；rename 缺 metadata fallthrough 到 italic narration。

**质量门**：4 包 typecheck ✅；backend 676/676（+4）；desktop 158/158（+3）。

System-message UI redesign 系列 6 个 PR 全部落地（PR-1 registry+drift guard / PR-2 task event row / PR-3 session_cleared inline audit / PR-4 schedule_fire 扁平 banner / PR-5 context-card 系列 / PR-6 onboarding badge + rename ↻）。等用户最终验收后整体 ship。

## 2026-05-15 — System message UI redesign · PR-7（task chip 收敛到 TaskRef）

最终验收 follow-up。@shiki 反馈两点："task 渲染和 markdown 中的 task 不一致，有两种 UI"——system event 里的静态 `TaskEventChip` 和 markdown 内联 `#task:N`（`TaskRef`）字体/配色/popover/点击行为都不一样；以及 "task 消息渲染缺少 actor 信息"——后者 @shiki 直接判 "不需要兼容了，以后就有了，不要为此做什么"，所以本轮只做前者。

**问题**：PR-2 给 system event row 写了一个独立的 `TaskEventChip`（`apps/desktop/src/renderer/components/chat/SystemMessage.tsx`），用 metadata 里 `task_number/task_title` 静态渲染，理由是"event row 是 audit 记录，不需要 popover 和 deep link"。结果是 chat 里同一个 task 出现两套 UI：

- system event chip：`bg-bg-elevated`、等宽 `#task:42 wire registry`、accent 色文字、无 hover popover、有 click handler。
- markdown `#task:N` chip：`bg-accent-soft`、`#42 · wire registry`、resolved 时整片是 accent button 色，hover popover 显示 status / assignee / conversation。

**改法**：删 `TaskEventChip`，把 enriched 路径和 degraded 路径里所有的 chip 调用改成 `<TaskRef taskNumber={meta.task_number} />`。`task_title` 不再从 metadata 直传——改由 TaskRef 的 `useTaskByNumber` 自己 resolve；任务被删则 fallback 到 inert "missing" 灰 chip，符合 markdown 里同一逻辑。`useTaskRefContext` import 删除（TaskRef 自己拿 context），`ClipboardCheck` 不再单独 import（TaskRef 内部用）。

**测试调整**（`apps/desktop/src/renderer/components/chat/Markdown.test.ts`）：

- `renderTaskEvent` helper 加 `seededTasks: TaskSummaryDto[]` 参数；测试里 pre-seed `taskByNumberKey('ws-1', 42)` 让 TaskRef SSR 走 resolved 分支而不是 loading（loading 状态下 TaskRef 不渲染 title，标题相关断言会全挂）。
- 断言 `data-task-event-chip-state="clickable|inert"` → `data-task-ref-state="resolved|resolved-no-handler"`；这是 TaskRef 已有的 state 表达，统一了。
- legacy degraded 三个测试不 seed（degraded 路径只验证 dot + verb chrome，chip 走 loading 也 OK，标签 `#task:N` 仍然出现）。

**视觉一致性**：system event 行里的 chip 现在和 markdown 里同一颜色、同一字体、同一点击行为；hover 也会出 popover 显示 status / assignee / conversation。`task_status` 行的 chip → status pill 链路保持不变（pill 是 event row 的"after-mutation"snapshot，不是 chip 的 popover 替代品）。

**质量门**：`pnpm typecheck` ✅；`./scripts/test.sh` 55 files / 676 tests ✅。

剩下两件事不在本 PR 范围：
1. legacy task system 行（pre-PR-2，metadata 只有 partial triple）的 actor 缺失——@shiki 明确说不补。
2. `MessageItem.tsx` 顶部的 `TaskMetaTag`（原始 task message 的方形 outlined 装饰标签）——位置和定位不一样（消息装饰，不是行内引用），不在"两种 UI"投诉范围内，本轮不动。

## 2026-05-15 — System message UI redesign · PR-8（system-row 主题字体一致性 + chip/pill 同高）

最终验收 follow-up 第二轮。@shiki 两点反馈：(1) "system event 也需要符合主题设置的字体设置，这样才能统一"；(2) "task event 的高度要和 task status 高度一样，他俩会出现在同一行"。两件事一起做，因为都属 system event 视觉一致性。

**问题 1 — 字体主题一致性**：用户在 settings 里能切换 prose / code 字体（CSS vars `--md-prose-font` / `--md-prose-size` / `--md-code-font` / `--md-code-size`，注入在 `document.documentElement`），但只有 `.markdown-body` 类 explicitly 引用这些变量。所以 Markdown 消息体跟主题，**system event 行（plain text，没走 Markdown 的 task event / rename / schedule pill / session_cleared mono timestamp 等）默认走 `var(--font-sans)`，不跟主题**。

**修法**：global.css 新增 `.system-message-row`，复用 `.markdown-body` 的 prose font/size 引用；嵌套 `code` / `.font-mono` 子元素 re-resolve 到 `--md-code-font`，让 rename `<code>` chip 和 mono timestamp 也跟 code 字体主题。SystemMessage.tsx 的入口函数把所有 per-subtype renderer 输出包一层 `<div class="system-message-row">`。Tailwind 的 `text-[10px]` / `text-[11px]` 显式 size utility 不被覆盖（chrome 的密度选择，scale 到 prose size 会显得空泛）。

**问题 2 — chip/pill 同高**：`task_status` 行布局是 `chip → 状态 pill by actor`。`TaskRef` chip 走父容器 `text-xs` 的自然 inline-flex 高度（~16px），`TaskStatusPill` 自己加 `py-0.5`（垂直 padding 4px → ~20px），同行 `flex items-center` 居中后两者基线视觉错位。

**修法**：把 chip 和 pill 都锁到 `h-[18px]`：
- `TaskStatusPill`（SystemMessage.tsx）改 `inline-flex h-[18px] items-center rounded-full px-1.5 text-[10px] font-semibold uppercase leading-none tracking-wider`，去掉 `py-0.5`，加 `leading-none` 让 10px text 在 18px 盒子里干净居中。
- `TaskRef`（TaskRef.tsx）四个状态分支（no-context / loading / missing / resolved-no-handler / resolved）一并加 `h-[18px]`。markdown 内联场景父行通常 `text-sm`（line-height 20px），18px chip 在 20px 行里仍然紧凑；system row 父行 `text-xs`（line-height 16px），18px chip 把行高顶到 18px，与 pill 严格等高。

**测试**（Markdown.test.ts +2）：
- 一个 drift guard 钉死 SystemMessage 入口必有 `class="system-message-row"` 包裹（enriched + legacy 两路），删了 wrapper 直接挂掉。
- 一个 drift guard 钉死 TaskStatusPill 同时持有 `h-[18px]` + `leading-none`，且不再持有 `py-0.5`；同时验证同行 TaskRef chip 也持有 `h-[18px]`（高度契约对称地落在两边）。

**质量门**：`pnpm typecheck` ✅；desktop 161/161（+2）；backend `./scripts/test.sh` 55 files / 676 tests ✅。

System-message UI redesign 系列 8 个 PR 全部落地（PR-1..PR-6 主线 + PR-7 task chip 收敛 + PR-8 字体主题 + 高度对齐）。等用户最终验收整体 ship。

## 2026-05-15 — System message UI redesign · PR-8 follow-up（字体级 cascade 修复 + chip 高度退掉全局锁）

@Cindy PR-8 review 两条 blocker（msg `0PEPg70b84bxYrlK`）：

1. **`.system-message-row` 上的 `font-size: var(--md-prose-size)` 没有真正 cascade 到 body 文本**。SystemMessage.tsx 里大量 body 容器仍带 Tailwind `text-xs` / `text-sm`——它们写的是显式 `font-size`，比父级 inherited size specificity 高，把主题字号覆盖回硬编码 12/14px。结果是 font-family 跟主题，font-size 大部分仍然钉死。
2. **`TaskRef` 全局加 `h-[18px]` 既会和大主题字号冲突（裁/溢出 chip 文字），也会污染 Markdown inline `#task:N` chip**——后者本来应该跟 prose 一起伸缩。

修法：

- **fix 1（cascade）**：从 body 容器删 `text-xs` / `text-sm`，让 `.system-message-row` 的 `--md-prose-size` 自然 inherit。chrome（`text-[10px]` status pill / `text-[11px]` mono timestamp / 小 tag）保留固定密度——按 Cindy 的"body vs chrome"区分。`.system-message-row` 同时加 `line-height: 1.5`，让大字号下行高也跟主题。涉及容器：`GenericNarrationFallback` / `CollapsibleNarration` / `MentionCcCard` body 包装 / `SessionClearedCard`(legacy + main) / `ScheduleFireBanner` 外层 / `TaskEventRow{Enriched,Degraded}` 外层 / `TaskEventLegacyFallback` / `ContextCardShell` body / 其变体里的 `text-sm` / `ContextCardLegacyFallback` / `OnboardingRow` / `RenameRow`。剩下 5 处 `text-xs` 是显式 chrome 元数据条（"From mentioned by ..." / "(loading original...)" / "Scheduled wake" 等小标），保留。
- **fix 2（chip 高度）**：从 `TaskRef.tsx` 全部 5 个分支退掉 `h-[18px]`——chip 在 Markdown body 场景里恢复纯 text-driven，跟着 prose size 伸缩。chip 在 system 行里要跟 pill 等高的约束改用 scoped CSS 落在 `.system-message-row [data-task-ref] { height: 18px; }`，只锁 system 行内的 chip。pill 自己 `h-[18px] leading-none` 不变（chrome by design）。

测试：

- 既有 PR-8 测试改写：原本断言 chip 持有 `h-[18px]` 内联类，改为断言 chip **不再** 持有该类（CSS scoping 取代），同时仍 assert pill 持有 `h-[18px]` + `leading-none`，且整个 SystemMessage 在 `.system-message-row` 容器里。
- 新增 1 条 drift guard：task event row 外层容器（enriched + degraded）class 不再含 `text-xs`，确保后续手抖加回 Tailwind size utility 直接红。

**质量门**：`pnpm typecheck` ✅；desktop 162/162（+1）；`./scripts/test.sh` 55 files / 676 tests ✅。

## 2026-05-15 — System message UI redesign · PR-9（task_status actor-first 一致化）

@shiki 验收发现 task event 行 actor 位置不一致（msg `UoJ6LPHDpJCHYVFe`）：
- create / claim / unclaim 行：`@actor verb chip`（actor 在前）
- task_status 行：`chip → pill by @actor`（actor 在后）

@shiki / @Cindy 都同意 actor-first 方向 + verb 用 `moved`。把 task_status 行改成 `@actor moved chip → pill`，四个 task event subtype 共享同一阅读顺序。`moved` 是 Jira 风格的中性动词，覆盖任意状态变化（todo→in_progress / in_progress→in_review / *→done），不用对每种 transition 起不同 verb。

**实现**（SystemMessage.tsx 一个 branch 改写）：
```
@Alice moved #task:42 · title → IN REVIEW
```

**测试**：原 `task_status renders chip → status pill by actor` 改写成 `task_status renders @actor moved chip → status pill (PR-9 actor-first)`，断言加 `@Alice` / `moved` 在前、`by @Alice` 不再出现，并钉死阅读顺序（actor < moved < chip < pill）。`@you` viewer-friendly 测试也一并改成 actor-first 形态。

**质量门**：typecheck ✅；desktop 162/162（无净变化，1 个测试改写）。


## 2026-05-15 — System message UI redesign · PR-10（activity cluster — 视觉分层）

@shiki 验收完 PR-1..9 后给出新反馈（msg `KIUjJY9Vu9YXAcMv` + 截图）："系统消息跟正文在一起显得密集"。@Cindy + @Alice 对照 Slack/Discord 后定方向：问题不在单条 audit row 渲染（PR-1..9 已经收得很干净），而是 `task_*` / `session_cleared` / `rename` 这类高频低权重 lifecycle event 跟正文用了等同的视觉节奏，密度叠加。Slack/Discord 都做成 muted activity narration 而不是迷你消息；PR-10 引入同样的 "activity cluster" 概念。

@shiki 看完 mockup（`docs/mockups/system-message-activity-cluster.html`，4 个场景对照）后拍方向（msg `SVYz6Hl6Ju9r4-iV`）："没问题，@Alice 实现"。

**分类**：
- **进 cluster**（low-priority activity）：`task_create / task_claim / task_unclaim / task_status / session_cleared / rename`
- **不进 cluster**（信息块保留分量）：`schedule_fire / thread_anchor / child_context / channel_context / thread_summary / mention_cc / onboarding`

**算法**（`apps/desktop/src/renderer/components/chat/groupMessages.ts` 纯函数）：

```
messages → activity runs (clusterable subtype + 相邻 + 5min gap) → split by unread boundary → render
```

四条规则各自独立：subtype 过滤 / stream 相邻 / 5min 时间窗 / unread boundary 二次切分。**不要求同 task / 不要求同 actor** —— 截图里 `#331 claimed` + `#330 moved` 不同 task，但对读者是同一段 noise。Cluster id 用 `activity-cluster:${first.id}` —— 用首条消息 id 作 stable anchor，新消息追加进同一 cluster 时 React key 不变，只 re-render 内部 row 列表，不 remount 整个 cluster；如果 id 用 `first:last:count` 形式，每次追加都改 key，每条新 audit row 都会让 cluster 闪一下。

**视觉**（`SystemActivityCluster.tsx` + scoped CSS in `global.css`）：
- 整组 `margin-inline-start: 56px`（16px chat row padding + ~30px avatar + 10px gap）跳过 avatar lane，对齐到正文 content column
- `border-inline-start: 1px solid border-subtle` + `padding-inline-start: 10px`：单一锚点 rail 让"这是 activity 段"立起来
- `margin-block: 7px` 跟正文上下断开节奏
- 内部行距压到 2px（`.system-activity-cluster [data-system-event-row="1"] > * { padding-block: 2px; padding-inline: 0; }`）
- 单条降权（CSS scoped，不改 SystemMessage 内部）：actor 从 `font-medium text-text-primary` → `text-secondary` 普通字重；TaskRef chip → 透明 + `border-subtle`；TaskStatusPill → 透明 + `currentColor` outline；TaskEventDot 从 8px → 6px
- **背景默认透明**：信息块（`schedule_fire` 等）才用 card 视觉，cluster 用 tint 会跟 card 抢权重

**实现**：
- `groupMessages.ts` 纯函数 + 21 个测试覆盖（subtype 集合 / 相邻 / 5min 边界 / unread 切分 / cluster id 稳定性 / 不变性 / 确定性）
- `SystemActivityCluster.tsx` 薄包装（4 个测试 drift guards）—— 复用现有 SystemMessage 渲染，CSS scoping 做视觉降权，per-subtype 渲染器零改动
- `SystemMessage.tsx` 包装 `<div>` 加 `data-system-event-row="1"` 属性，作为 cluster CSS 的稳定 hook
- `ChannelView.tsx` 把 `messages.map` 替换成 `groupMessages(messages).map`，cluster 走 `<SystemActivityCluster>`，单条走原来的 `<SystemMessage>` / `<MessageItem>` 路径
- `global.css` 加 `.system-activity-cluster` 完整样式块

**质量门**：typecheck ✅；desktop 187/187（+25：21 grouping + 4 cluster rendering）；backend 676/676 不退化。

**未做（PR-11 / 后续）**：
- 同 task 事件折叠（连续多次状态变化压成 `#330 had 2 updates` 或 mini timeline）
- task drawer timeline view（结构改动，不在视觉分层范围）
- 配套 mockup `docs/mockups/system-message-activity-cluster.html` 已落盘 + 已发 @shiki 验收。

## 2026-05-17 — Human identity V1 注册 · Deferred Adoption（pre-v21 备份不丢数据）

### 触发

@shiki 在做 V1 human identity 时误清了本地 DB；同时发现 `pnpm dev` 路径上 v21 migration 体内含 destructive UPDATE/DELETE，会把 pre-v21 dev 数据当成"FK 无法满足的脏数据"直接抹掉。@shiki 还有一份几天前的备份，希望"恢复备份 → 启动 app → 注册身份 → 备份数据自动迁移、零清除"。

### 设计：Deferred Adoption

放弃 fail-fast / db:reset 路线，改为"非破坏 staging + 注册时一次性 adopt"的两段式：

**Phase 1（v21 migration 体内）**：把 pre-v21 的用户拥有事实**复制**进 4 张 holding 表（不删除信息，只搬位置），同时做必要的 schema FK rebuild：

| Staging 表 | 内容 |
|---|---|
| `legacy_message_from_user_v21(message_id)` | 原 `from_kind='user' AND from_user_id IS NOT NULL` 的消息 id |
| `legacy_message_task_assignee_user_v21(message_id)` | 原 `task_number IS NOT NULL AND task_assignee_user_id IS NOT NULL` 的消息 id |
| `legacy_conversation_reads_v21(original_user_id, conversation_id, last_read_seq, read_at)` | 旧的所有读光标 |
| `legacy_user_attachments_v21(11 列同 attachments)` | 旧 `created_by_kind='user'` 的完整 attachment 行 |

主表（messages / conversation_reads / attachments）的 user-id 列在 rebuild 时 NULL 化或 DELETE，使 schema 立即 FK-clean，但**所有 user 拥有的内容信息 100% 保留在 staging**。v21 同时安装 cross-namespace uniqueness 触发器 + polymorphic attachments dispatch 触发器。

**Phase 2（`POST /api/register` 同事务）**：`UserService.register()` 在创建第一个 viewer 的同一个 better-sqlite3 transaction 里调用 `adoptLegacyV21(db, viewerId)` helper：
1. 用 staging 里记录的 message id 把 `messages.from_user_id` / `messages.task_assignee_user_id` 改写为 `viewerId`（只 adopt 原本非 NULL 的行 —— 不能"过度认领"）
2. `INSERT INTO conversation_reads SELECT ?, conversation_id, MAX(last_read_seq), MAX(read_at) FROM legacy_conversation_reads_v21 GROUP BY conversation_id`（V1 single-viewer 合并：任何 pre-v21 读光标都属于这台机器现在注册的这个人，最远的 read marker 胜出）
3. 把 `legacy_user_attachments_v21` 的 11 列完整 INSERT-SELECT 回 `attachments`，把 `created_by_id` 改写为 `viewerId`
4. 写 audit 行到 `app_settings`：`legacy_v21_adoption_completed_at`（decimal ms）+ `legacy_v21_adoption_counts`（JSON `{messages_from, messages_task, conversation_reads, attachments}`）
5. `DROP TABLE IF EXISTS legacy_*_v21`

任何步骤抛错 → 整个 register 事务 rollback：viewer row 不存在、`viewer_user_id` 不存在、staging 完整保留可重试。这是回滚测试钉死的硬约束。

### 实现锚点

- **`packages/shared/src/db/migrations.ts`** v21（约 L1380-1670）—— v21 体重写为非破坏 staging；v22 保持 no-op，注释指向 v21 Deferred Adoption 契约（不再说 "wipe required / no upgrade path"）。
- **`packages/backend/src/services/user-service.ts`** `register()` + `adoptLegacyV21()` helper（L386-484）—— 单事务 atomic，audit 写入用 `SETTINGS_KEYS.*` 常量。
- **`packages/backend/src/repos/settings-repo.ts`** —— 新增 `LEGACY_V21_ADOPTION_COMPLETED_AT` / `LEGACY_V21_ADOPTION_COUNTS` 两个 key 常量。
- **`packages/backend/tests/services/user-service-adoption.test.ts`** —— 新文件 7 个测试是契约 spec：fresh DB 全零 + DROP；只 adopt 原非 NULL 行；conversation_reads MAX 合并；attachment 11 列回插；DROP 后无残留；二次注册 409；adoption 失败 → 整个 register rollback、staging 保留。
- **`packages/backend/tests/db-migrations.test.ts`** v21 测试重写为 Deferred Adoption 契约（4 张 staging 正确填充、主表 FK-clean、users 仍空、audit 还未写）。

### Review

@Cindy 两轮 review，全部通过：

- **round-1**：主路径 LGTM（staging 真的非破坏 / register 事务 atomic / rollback 测试到位 / attachment 11 列回插 / 两个 message staging filter / conversation_reads MAX 语义都符合契约）。给了 4 个非阻塞清理点：v21 测试 describe 顶部注释、v22 注释、conversation_reads rebuild 注释（旧版 "emptied above" 事实错误，实际是先 copy 到 staging 再 DROP）、audit 写入用 `SETTINGS_KEYS.*` 常量（替代字符串字面量）。
- **round-2**：4 项清理已合入，没有新 blocker，最终 LGTM。

### 已知边界

**已经跑过旧 destructive v21 且本地无 staging 表的 DB** 不在 #task:5 范围。那种中间态的旧 v21 已经吞过用户数据，任何后续迁移都补不回。需要的话另开 v23 corrective（@Cindy 在 `docs/human-identity-migration-cleanup-plan.md` 留了 Mode B 兜底）。Deferred Adoption 能保护的是**还没跑过 v21 的备份**。

### 配套文档

- **`docs/human-identity-migration-cleanup-plan.md`**（@Cindy 主笔，@Alice review）—— 落地后清理路径（Mode A 保桥 vs Mode B v23 guard + 移除 register adoption），含真实 DB 验收 SQL 模板。**不要在 @shiki 完成备份恢复 + 注册验收前执行清理**。
- @Cindy 同步在写 recovery 用快照 doc（task #7），覆盖背景 / 最终方案 / 真实验收步骤 / 查询 SQL / 已知边界 / 后续 commit/cleanup 入口 —— 路径待发。

### 状态

- #task:5 in_review，工作树**未 commit**（按 @shiki 标准纪律）
- 质量门：`pnpm -r typecheck` ✅ / backend 59 files / 718 tests ✅ / desktop 11 files / 191 tests ✅ / `git diff --check` ✅
- 等 @shiki 用备份做真实验收 → commit 决定（commit 时倾向拆成 "shared/migrations + backend/adoption" 两个 commit）

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

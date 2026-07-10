# 测试

后端可独立测试，**不依赖 Electron**。本文档说明 gate 形态、ABI 切换机制、目录结构与新增测试的约定。

---

## 快速上手

```bash
pnpm test                         # 默认：全 gate（6 个包顺序跑，fail-fast）
pnpm test --scope shared          # 只跑某一个包
pnpm test --scope backend tests/foo.test.ts -t name   # 包内 targeted
```

底层入口是 `./scripts/test.sh`：

1. 在所有 vitest 跑起来之前，先把工作区根的 `better-sqlite3` 二进制 swap 成 system Node ABI（缓存命中时是 `cp`，未命中时一次 `node-gyp rebuild` 然后入缓存）
2. 按下面的顺序 fan-out：

```
shared → backend → server → host → cli → desktop
```

> shared 排第一是因为它是其他所有包的合同来源——shared 的 zod schema / classifier 一旦回归，下游 5 个包的失败都是噪音。

`set -euo pipefail` 让任何一个包失败立即中止剩余的，CI 输出指向真正的根因。

### `--scope`

| Scope          | 跑什么                                |
|----------------|---------------------------------------|
| `shared`       | `@silverhand/shared` 合同测试         |
| `backend`      | backend repos / routes / runtime / 等 |
| `server`       | `@silverhand/server`                  |
| `host`         | daemon + driver tests                 |
| `cli`          | `silverhand` CLI                      |
| `desktop`      | renderer + main 单测                  |
| `all`（默认）  | 6 包顺序全跑                          |

包内 targeted（vitest 参数透传）：

```bash
./scripts/test.sh --scope backend tests/smoke.test.ts
./scripts/test.sh --scope host tests/spawn-daemon.test.ts -t 'pings'
```

### 为什么根 `pnpm test` 必须走 `scripts/test.sh`

ABI swap 是工作区级别的副作用：`better-sqlite3` 的 `.node` 二进制只能为**一个** Node ABI 编译。如果有人直接 `pnpm --filter @silverhand/backend test` 而 swap 没跑过，就要么 dlopen 崩溃（electron ABI 在 system node 下被 SIGKILL），要么静默加载错 ABI 的二进制。把 swap 钉死在 `scripts/test.sh` 里、再让根 `pnpm test` 唯一通过它，使「跑任何 vitest 之前一定跑过 swap」成为不依赖调用习惯的不变量——这也是为什么根脚本不去委托给 `pnpm -r run test`。

> 这条不变量也意味着：本地手动跑某个包的 watch 模式时，请用 `./scripts/test.sh --scope <pkg>` 或先 `./scripts/test.sh` 走过一次再 `pnpm --filter @silverhand/<pkg> test:watch`，不要直接 `pnpm --filter ... test:watch` 冷起步。

---

## 为什么需要 `test.sh`：ABI 切换

`better-sqlite3` 是 native module，编出来的 `.node` 二进制只能对应**一个** Node ABI（`NODE_MODULE_VERSION`）：

| 场景 | 运行时 | ABI |
|------|--------|-----|
| `pnpm dev`（Electron 主进程） | Electron 内置的 Node | electron 自己的 ABI |
| `pnpm test`（系统 node 跑 vitest） | 系统 Node | 该 Node 主版本对应的 ABI |

两者不能共存——同一个 `.node` 文件不可能同时满足。所以：

- `scripts/dev.sh` 会确保它编成 **Electron ABI**
- `scripts/test.sh` 会确保它编成 **当前进程 Node ABI**

两个脚本都使用 `scripts/_native.sh` 里的 per-ABI 缓存：每个 ABI 的 `.node` 文件独立存在 `node_modules/.native-binding-cache/`，加上一个轻量的 `.active-abi` stamp 和 `.active-sha256` 哈希 sentinel——记录目前 swap 在 `BINDING` 位置的是哪个 ABI、当时的文件哈希是什么。来回切换是「自动且幂等」的：跑完测试后再 `pnpm dev`，会从缓存 `cp` 回 Electron ABI。

> 历史教训 1：`pnpm exec npm rebuild` 在 pnpm 的 symlink 布局下是 **静默 no-op**，stamp 写了但 `.node` 没动。`test.sh` 现在直接进 `node_modules/.pnpm/better-sqlite3@*/...` 跑 `npx -y node-gyp@^12.3.0 rebuild --release`（node-gyp 版本 pin 到 semver-compatible 主线，避免 `@latest` 飘移）。
>
> 历史教训 2：`pnpm install` 重新解压 prebuild 会从我们背后覆盖 `BINDING`。stamp 此时还是旧值，但实际文件已经换了。`_native.sh` 因此除了 stamp 之外，还在 swap 时写一份 `.active-sha256`；`ensure_binding` 启动时会把当前 `BINDING` 的 hash 跟它对，如果不一致就把 stamp 当作 stale 走重 swap 路径。
>
> 历史教训 3：macOS 上 `cp` 会失效 ad-hoc code signature，dlopen 时内核 SIGKILL，错误信息和 ABI mismatch 完全一样。`swap_in()` 在 Darwin 上会跟一次 `codesign --sign - --force`。

---

## 目录结构

各包独立 vitest，配置都按 `tests/**/*.test.ts` 收（desktop 例外，它收 `src/{renderer,main}/**/*.test.ts`，因为 renderer/main 测试就近放在源码旁边）：

```
packages/shared/                   # 跨包合同（zod / classifier / drift guard）
└── tests/
    ├── bind-address-scope.test.ts
    ├── server-url.test.ts
    ├── system-messages.test.ts
    ├── tls-policy.test.ts
    └── no-insecure-tls.test.ts    # 跨包源码扫描的安全策略 gate

packages/backend/
├── tests/
│   ├── utils/
│   │   ├── db.ts             # in-memory DB + temp dir 夹具
│   │   ├── app.ts            # Hono app + AgentRuntimeHost fake + http() 包装
│   │   └── embedded-seed-fixtures.ts
│   ├── smoke.test.ts         # 验证测试基建本身
│   ├── repos/                # L1：仓储层（直接打 in-memory SQLite）
│   ├── routes/               # L2：HTTP 层（app.fetch + 假 AgentRuntimeHost）
│   ├── runtime/              # L3：runtime host / dispatcher / fanout
│   ├── services/             # L2：service 层
│   ├── observability/        # CLI route map / system-message drift 等漂移 guard
│   └── drivers/              # Driver 单元测试
└── vitest.config.ts

packages/server/tests/
packages/host/tests/               # daemon / supervisor / driver / 真 socket
└── _fixtures/                     # echo/no-output runtime + driver oracle
packages/cli/tests/
└── subprocess/               # 真子进程 / 真 daemon 走的慢 lane
apps/desktop/src/{renderer,main}/**/*.test.ts
```

测试分层（参考 `docs/core-design.md` 的后端架构）：

| 层 | 范围 | 状态 |
|---|---|---|
| **L0 跨包合同** | `@silverhand/shared` 里的纯函数（zod schema / classifier / drift guard） | ✅ |
| **L1 Repos** | 单个 repo 直连 in-memory SQLite，验证 SQL / FK / 边界条件 | ✅ |
| **L2 Routes / Services** | `app.fetch(req)` 对真实 Hono 路由打请求，验证 HTTP 行为；`AgentRuntimeHost` 用 fake 避免真 spawn | ✅ |
| **L3 Daemon supervisor** | `packages/host/tests/supervisor.test.ts` 用可控 runtime fixture 走真 spawn / stdio / exit / watchdog | ✅ |
| **L3 Daemon transport e2e** | `packages/host/tests/{e2e-socket,e2e-supervisor,spawn-daemon}.test.ts` 覆盖真 socket、协议 dispatch 与子进程 | ✅ |
| **L3 Backend projection e2e** | `packages/backend/tests/e2e/` 覆盖 embedded / standalone daemon event → DB / event-WebSocket projection parity | ✅ |

---

## 测试夹具

`tests/utils/db.ts` 提供两个工具：

```ts
// 全新的 in-memory DB，跑完所有 migration，bootstrap 'local' host
const { db, localHostId } = openTestDb();

// 一次性的临时工作目录（用于触碰文件系统的测试）
const t = makeTempSilverhandDir();
afterEach(() => t.cleanup());
```

每个 `openTestDb()` 都是独立的 `:memory:` 数据库，测试之间天然隔离。

> ⚠️ Legacy fixture trigger：`openTestDb()` 默认会安装两个 trigger，把 fixture
> users 自动灌进每个新建的 workspace/conversation 的 `*_users` 表——这是给
> pre-rewrite 直 repo 测试兜底的兼容路径，**不是生产路径**。新写的、特别是
> 涉及 membership/权限的测试请用 `openTestDb({ seedAllFixtureMemberships: false })`
> 或对应的 `buildTestApp({ seedAllFixtureMemberships: false })`，并通过
> service/route surface 显式建 membership——这才是和生产同路径，能真正捕获
> "忘加 membership" 的回归。Legacy trigger 会随老测试逐批迁移最终拆除。

L2 路由测试用 `tests/utils/app.ts`：

```ts
const t = buildTestApp({ seedAllFixtureMemberships: false });   // strict fixture
const h = http(t.app);
const res = await h.post('/api/agents', { name: 'a', runtime: 'claude' });
expect(res.status).toBe(201);

// 检查路由对 AgentRuntimeHost 的副作用
expect(t.fake.starts).toHaveLength(1);
expect(t.fake.delivered[0]!.agentId).toBe(...);

afterEach(() => t.cleanup());      // 关 DB + 删临时 dir
```

`FakeConversationManager` 是尚未重命名的 legacy test-double 名字；它
`implements AgentRuntimeHost`，记录所有 `start` / `stop` / `deliverMessage` /
`stopAll` 调用——这条 `implements` 约束是显式的，
runtime host 接口未来加方法时这里直接 typecheck fail，不能再用 `as unknown as`
绕过。L2 测的是路由本身，不是 daemon / supervisor。

L3 执行面测试已经迁到 `packages/host/tests/supervisor.test.ts`。它让真实
`Supervisor` spawn 可控 fixture，而不是复活已删除的 backend
`ConversationManager`：

```ts
const { supervisor, events } = makeSupervisor(); // helper in supervisor.test.ts
const result = await supervisor.start(baseStartParams);
expect(result.started).toBe(true);
expect(events.some(e => e.event === 'runtime_state')).toBe(true);
```

`echo-runtime.cjs` 覆盖 stdout/stderr/stdin、SIGTERM 与退出行为；
`no-output-runtime.cjs` 覆盖 init silence/watchdog；driver raw-frame parity 由
`_fixtures/driver-oracles.ts` 承担。跨 daemon transport 的 backend 投影则放在
`packages/backend/tests/e2e/`，不要把 spawn ownership 拉回 backend 测试。

---

## 新增测试时的约定

1. **测试归属哪个包看依赖.** 如果只 import `@silverhand/shared`，是 L0 合同测试，放 `packages/shared/tests/`。涉及 backend 内部模块或路由 → 放 backend/tests。涉及真 daemon / 子进程 → 放 host/tests 或 cli/tests/subprocess/。renderer/main 单测放 `apps/desktop/src/...` 旁边。
2. **FK 是真的开着的**（`PRAGMA foreign_keys = ON`）。涉及 `agent_id`、`conversation_id`、`message_id` 的字段必须用真实的行 id，不能传字符串字面量。需要 agent/conversation/message 时通过对应 repo 创建。
3. **不要 mock SQLite**。`better-sqlite3` 同步、快、够用，mock 反而会掩盖 SQL 错误。
4. **文件系统副作用**用 `makeTempSilverhandDir()`，`afterEach` 清理；不要写到真实 `~/.silverhand/`。
5. **避免依赖 random id 的字典序**。base64url 随机 id 跨次运行排序不稳定，要断言顺序就显式控制（如 `UPDATE ... SET updated_at = updated_at - 1000`），或断言相对位置（`indexOf(parent) < indexOf(child)`）。
6. **新文件必须以 `.test.ts` 结尾**才会被 vitest 收。
7. **新增 membership/权限相关测试用 strict fixture（`seedAllFixtureMemberships: false`）**，并通过 service/route surface 建 membership。Legacy 默认 fixture 会把所有 user 灌进所有 workspace，这条路径能 trivially 屏蔽掉真实 bug。

---

## Daemon driver-oracle 回归门

执行面（spawn/IO/解析）的行为契约由 driver-oracle 回归固定下来：任何要替换当前 TypeScript daemon 的实现（含未来的 Rust daemon）**必须先通过 driver-oracle 回归**才算 parity。

- 契约本体：`packages/host/tests/_fixtures/driver-oracles.ts`（raw-frame 夹具）由 `packages/host/tests/driver-oracle-regression.test.ts` 回放，覆盖 `line -> ParsedEvent[]` 投影（Claude api_error 脱敏 / assistant·tool·result 生命周期 / compaction 边界、Cursor one-shot error、Codex turn·tool·dedupe·pending-cleanup·fileChange·stale-resume）。
- 状态机与投递态不在此：supervisor 转移看 `packages/host/tests/supervisor.test.ts`，backend 投递/watchdog 看 `packages/backend/tests/runtime/delivery-coordinator.test.ts`、`status-projector.test.ts`；backpressure/reclaim/日志脱敏各有专测（`output-backpressure` / `reclaim` / `runtime-pidfiles` / `daemon-logging`）。
- 维护约定：**新的 daemon incident 落地时，先加能复现它的最小 raw-frame 夹具**，再去拓宽各 driver 的单测。schema 权威仍是 `packages/host/src/protocol.ts`（zod），不切二进制 framing。

---

## 端到端：headless 后端

如果想在不开 Electron 窗口的情况下跑真实后端（curl 调试 / 手动验证 event WebSocket），用：

```bash
pnpm dev:headless
```

它会启动 Electron 主进程但跳过 `BrowserWindow`，把 `{ url, port, bootstrap_token_path, silverhand_dir }` 以一行 JSON 打到 stdout，Ctrl-C 退出。stdout 不再暴露 long-lived `auth_token`；需要 curl 公共 API 时，先用 one-shot bootstrap 文件换 session bearer：

```bash
# 终端 A：保持进程运行，复制 stdout 的第一行 JSON
SILVERHAND_DIR=/tmp/sh-sandbox pnpm dev:headless

# 终端 B：把上一步复制的 JSON 放进 READY
READY='{"url":"http://127.0.0.1:12345","port":12345,"bootstrap_token_path":"/tmp/sh-sandbox/embedded-bootstrap","silverhand_dir":"/tmp/sh-sandbox"}'
URL=$(jq -r .url <<<"$READY")
BOOTSTRAP_PATH=$(jq -r .bootstrap_token_path <<<"$READY")
BOOTSTRAP=$(tr -d '\n' < "$BOOTSTRAP_PATH")
AUTH=$(curl -sS -X POST "$URL/auth/embedded-bootstrap" \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$BOOTSTRAP\"}" | jq -r .user_token)

curl -H "authorization: Bearer $AUTH" "$URL/api/workspaces"
```

需要隔离状态目录时：

```bash
SILVERHAND_DIR=/tmp/sh-sandbox pnpm dev:headless
```

`SILVERHAND_DIR` 会作用于 desktop main（含 headless 与普通 dev）；不设置时才默认
走 `~/.silverhand/`。并行调试或 smoke app 必须给每个实例独立目录，避免 socket、
pidfile、DB 与日志互相污染。

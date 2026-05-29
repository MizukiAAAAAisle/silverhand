# 测试

后端可独立测试，**不依赖 Electron**。本文档说明运行方式、ABI 切换机制、目录结构与新增测试的约定。

---

## 快速上手

```bash
pnpm test                    # 默认：跑 backend 全部测试
pnpm test -- --watch         # watch 模式
pnpm test -- repos/conversation   # 只跑匹配文件
```

底层就是 `./scripts/test.sh`，它会：

1. 检查 `node_modules/.native-binding-stamp`（记录当前 `better-sqlite3` 是为哪个 ABI 编译的）
2. 如果 stamp ≠ `node-<当前 node 版本>`，自动 `node-gyp rebuild` 重编 `better-sqlite3`
3. 跑 `pnpm --filter @silverhand/backend test`

第一次跑会触发重编（30s 左右），之后秒级。

---

## 为什么需要 `test.sh`：ABI 切换

`better-sqlite3` 是 native module，编出来的 `.node` 二进制只能对应**一个** Node ABI（`NODE_MODULE_VERSION`）：

| 场景 | 运行时 | ABI |
|------|--------|-----|
| `pnpm dev`（Electron 主进程） | Electron 内置的 Node | electron 自己的版本 |
| `pnpm test`（系统 node 跑 vitest） | 系统 Node 24 | 137 |

**两者不能共存**——同一个 `.node` 文件不可能同时满足。所以：

- `scripts/dev.sh` 会确保它编成 **Electron ABI**（`electron-rebuild`），并写 stamp `electron-<ver>`
- `scripts/test.sh` 会确保它编成 **node ABI**（`node-gyp rebuild`），并写 stamp `node-<ver>`

两个脚本都先读 stamp 决定要不要重编，所以来回切换是「自动且幂等」的：跑完测试后再 `pnpm dev`，会自动重编回 Electron ABI。

> 历史教训：`pnpm exec npm rebuild` 在 pnpm 的 symlink 布局下是 **静默 no-op**，stamp 写了但 `.node` 没动。`test.sh` 现在直接进 `node_modules/.pnpm/better-sqlite3@*/...` 跑 `npx node-gyp@latest rebuild --release`。

---

## 目录结构

```
packages/backend/
├── tests/
│   ├── utils/
│   │   ├── db.ts             # in-memory DB + temp dir 夹具
│   │   ├── app.ts            # Hono app + 假 ConversationManager + http() 包装
│   │   ├── manager.ts        # 真 ConversationManager + 注入 mock-claude 二进制
│   │   └── mock-claude.mjs   # 假 claude CLI（chmod +x，env 配置行为）
│   ├── smoke.test.ts         # 验证测试基建本身
│   ├── repos/                # L1：仓储层（直接打 in-memory SQLite）
│   │   ├── host-repo.test.ts
│   │   ├── agent-repo.test.ts
│   │   ├── conversation-repo.test.ts
│   │   ├── conversation-read-repo.test.ts
│   │   ├── conversation-inbox-repo.test.ts
│   │   ├── workspace-repo.test.ts
│   │   ├── workspace-files.test.ts
│   │   └── message-repo.test.ts
│   ├── routes/               # L2：HTTP 层（app.fetch + 假 ConversationManager）
│   │   ├── smoke.test.ts
│   │   ├── agents.test.ts
│   │   ├── channels.test.ts
│   │   ├── workspace-conversation-routes.test.ts
│   │   ├── tasks.test.ts
│   │   └── internal.test.ts  # 含 auth-token 校验
│   ├── manager/              # L3：ConversationManager + 真子进程（mock-claude）
│   │   ├── smoke.test.ts
│   │   └── lifecycle.test.ts # start / stop / exit / inbox drain / reconcile
│   └── drivers/              # Driver 单元测试
│       ├── codex.test.ts
│       ├── cursor.test.ts
│       └── platform-prompt.test.ts
└── vitest.config.ts
```

测试分层（参考 `docs/core-design.md` 的后端架构）：

| 层 | 范围 | 状态 |
|---|---|---|
| **L1 Repos** | 单个 repo 直连 in-memory SQLite，验证 SQL / FK / 边界条件 | ✅ |
| **L2 Routes** | `app.fetch(req)` 对真实 Hono 路由打请求，验证 HTTP 行为；ConversationManager 用假实现避免真 spawn | ✅ |
| **L3 ConversationManager** | 用 `mock-claude` 假二进制走 spawn → stdin → SSE → DB 全链路 | ✅ |

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

L2 路由测试用 `tests/utils/app.ts`：

```ts
const t = buildTestApp();          // Hono app + 假 ConversationManager + 临时 dir
const h = http(t.app);             // get/post/del/json 包装
const res = await h.post('/api/agents', { name: 'a', runtime: 'claude' });
expect(res.status).toBe(201);

// 检查路由对 ConversationManager 的副作用
expect(t.fake.starts).toHaveLength(1);
expect(t.fake.delivered[0]!.agentId).toBe(...);

afterEach(() => t.cleanup());      // 关 DB + 删临时 dir
```

`FakeConversationManager` 记录所有 `start` / `stop` / `deliverMessage` / `stopAll` 调用，但不会真的 spawn 子进程——L2 测的是路由本身，不是 ConversationManager。

L3 测试用 `tests/utils/manager.ts` + `mock-claude.mjs`：

```ts
const h = await buildManagerHarness();    // 真 ConversationManager + 预建 workspace/channel/agent
h.setMockEnv({ MOCK_CLAUDE_EXIT_CODE: '7', MOCK_CLAUDE_EXIT_AFTER_INIT_MS: '20' });

await h.manager.start(h.conversationId, h.agentId);
await h.waitForEvent(e => e.kind === 'agent_status' && (e.payload as any).status === 'crashed');

const lines = await readStdinLog(h.stdinLog);  // 检查 mock 收到了哪些 stdin 行
afterEach(() => h.cleanup());
```

`mock-claude.mjs` 是一个 chmod +x 的 node 脚本，行为由 env 控制：`MOCK_CLAUDE_INIT_SESSION_ID`、`MOCK_CLAUDE_NO_INIT`、`MOCK_CLAUDE_EXIT_CODE`、`MOCK_CLAUDE_EXIT_AFTER_INIT_MS`、`MOCK_CLAUDE_EMIT_TURN_END`、`MOCK_CLAUDE_STDIN_LOG`。`ConversationManager` 内部的 `binariesPromise` 被 monkey-patch 直接指向这个脚本，绕过 `which claude` 检测——这样 L3 测试在 CI 上也能跑（不需要真装 Claude）。

读取 `"control_request"` 行时 mock 会立即按 `MOCK_CLAUDE_EXIT_CODE` 退出，模拟真 claude 收到 interrupt 后的行为。

---

## 新增测试时的约定

1. **FK 是真的开着的**（`PRAGMA foreign_keys = ON`）。涉及 `agent_id`、`conversation_id`、`message_id` 的字段必须用真实的行 id，不能传字符串字面量。需要 agent/conversation/message 时通过对应 repo 创建。
2. **不要 mock SQLite**。`better-sqlite3` 同步、快、够用，mock 反而会掩盖 SQL 错误。
3. **文件系统副作用**用 `makeTempSilverhandDir()`，`afterEach` 清理；不要写到真实 `~/.silverhand/`。
4. **避免依赖 random id 的字典序**。base64url 随机 id 跨次运行排序不稳定，要断言顺序就显式控制（如 `UPDATE ... SET updated_at = updated_at - 1000`），或断言相对位置（`indexOf(parent) < indexOf(child)`）。
5. **新文件必须以 `.test.ts` 结尾**才会被 vitest 收。

---

## 端到端：headless 后端

如果想在不开 Electron 窗口的情况下跑真实后端（curl 调试 / 手动验证 SSE），用：

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

`SILVERHAND_DIR` 仅在 headless 模式下使用，正常 `pnpm dev` 仍走 `~/.silverhand/`。

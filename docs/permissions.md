# Silverhand — Permissions Design

> **Status**: Spec aligned 2026-05-07 in #attachment-鉴权讨论 channel; awaiting Slice A' implementation (task #125). Until A' lands, the code reflects the "Current v1 model" in §3, not the "Target model" in §4.
>
> 与 [`core-design.md`](./core-design.md) 的产品/数据模型对齐——本 doc 在数据模型旁定义"谁能对资源做什么"。
>
> 与 [`mcp-system.md`](./mcp-system.md) 的 MCP 工具表面对齐——本 doc 定义 chat-bridge → backend 调用的身份与边界。
>
> 与 [`attachments-design.md`](./attachments-design.md) 的资源生命周期对齐——附件 ACL 是本 doc §6.3 的一个具体实例。

---

## 1. 为什么需要这份 doc

silverhand 的鉴权状态今天是"能跑起来但概念散落"——`auth_token`、`X-Silverhand-User-Id`、`SendMessageActor / ChannelActor / TaskActor / ThreadActor`、`createdByKind/createdById`、`canViewWorkspace`/`canViewConversation` 占位函数，分布在 routes / services / repos / WS 各处，每个都在用自己的话说"谁在操作"。

随着 v1 单机收尾、远端/多人在地平线，必须把这些散落的概念折成**一套统一的鉴权模型**：

- 当前避免局部 patch 互相干扰（attachment GET 漏洞、public CRUD 无 Bearer 等）；
- 未来落 session token / membership 表时，业务代码不用改，只换中间件实现；
- 新加资源（avatar、profile、share-link）时有标准模板，不每次重新发明。

**本 doc 是模型的权威定义**。代码与本 doc 冲突时，以本 doc 为准。

---

## 2. 鉴权的四层管线

每个进 backend 的 HTTP 请求按这四层流转：

```text
Request
  │
  ├── 1. Authentication —— 门票对不对？
  │     v1: Bearer auth_token （shared）
  │     未来: per-principal session token / JWT
  │
  ├── 2. Principal resolution —— 这次请求是谁？
  │     输出: Principal = user / agent / system
  │     由 token 上下文 + 路径强制推断，不信请求方声明
  │
  ├── 3. Authorization (ACL) —— 这个谁，能不能对这个资源做这件事？
  │     canDoX(principal, resource) → boolean
  │     v1: 大部分占位，少数已实现（如 attachment delete 创建者校验）
  │
  └── 4. Handler —— 真正执行业务
        Service 层从 principal 取需要的字段
        （userId / agentId / conversationId）
```

关键性质：**四层职责独立，不互相替代**。

- token 通过不代表你是谁（v1 共享 token，多个进程持同一个）；
- 知道你是谁不代表你能做什么（principal `user:local` 也未必能删别人的 attachment）；
- ACL 通过不等于业务执行成功（业务层还有 invariant，如 conversation 关闭、配额超限）。

---

## 3. 当前 v1 模型（实际跑的）

### 3.1 Authentication

- 共享 `auth_token`：backend 启动时随机生成，写入 `~/.silverhand/server-config.json`。
- renderer 和 chat-bridge 启动时都拿到这个 token。
- `/internal/*` 路由强制 Bearer 校验；`/api/*` 路由**不校验**（已知缺口，归 Slice B）。
- WebSocket 第一帧 `{type:'auth', token}` 校验 token，否则关闭 1008。

### 3.2 Principal resolution（散落版）

身份概念散落在四个 service 各自的 `*Actor` union 里：

```ts
// packages/backend/src/services/conversation-message-service.ts
type SendMessageActor =
  | { kind: 'user'; userId: string | null }
  | { kind: 'agent'; agentId: string };

// packages/backend/src/services/channel-service.ts
type ChannelActor =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; agentId: string; conversationId: string };

// packages/backend/src/services/task-service.ts
type TaskActor = ...
// packages/backend/src/services/thread-service.ts
type ThreadActor = ...
```

每个路由 handler 在调 service 前手工拼装 actor：

```ts
// /api/* —— 信任 X-Silverhand-User-Id 头（可被任意持 token 进程伪造）
actor: { kind: 'user', userId: resolveViewerUserId(c, ctx) }

// /internal/.../:cid/:aid/* —— agent 身份从 URL 路径取（chat-bridge spawn 时锁定，可信）
actor: { kind: 'agent', agentId: aid }
```

附件层用另一套 (`createdByKind / createdById`)，不接 actor。

### 3.3 ACL

`packages/backend/src/ws/permissions.ts` 暴露占位函数：

```ts
canViewWorkspace(ctx, viewerUserId, workspaceId)
  → return workspace exists  // v1 placeholder

canViewConversation(ctx, viewerUserId, conversationId)
  → return conversation exists && workspace exists  // v1 placeholder
```

只在 WS 订阅 scope 时被调用。HTTP 路由 99% 不走 ACL 函数，要么没校验，要么内联条件（如 attachment delete 检查 `created_by_id` 匹配）。

### 3.4 当前模型的洞

| 层 | 缺口 |
|---|---|
| Authentication | `/api/*` 完全无 Bearer，本机任意进程可调用 |
| Principal | 概念散落 4 处；身份是 header 声明式不是路径推断式；无 system principal 概念（虽然 backend 自发的消息事实上是 system） |
| ACL | 大部分路由不走 ACL 函数；attachment GET 完全无 ACL；public CRUD（创建/删除 workspace、加/删成员）无校验 |
| 资源边界 | `attachment-service.serve()` 注释说"caller has already passed channel-membership"——但 route 没做 |

---

## 4. 目标模型（Slice A' 之后）

### 4.1 Principal 类型（backend-only）

```ts
// packages/backend/src/auth/principal.ts （新增）
export type Principal =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; agentId: string; conversationId: string }
  | { kind: 'system' };
```

放 backend，不放 shared。理由：renderer 不需要 Principal union 本身，只需要 header 编码 helper（`encodeUserPrincipalHeader('local') → 'user:local'`）。把 Principal 留 backend，未来 session claims / JWT 解析自然在 backend 闭环，不会泄到客户端。

shared 只导出：

```ts
// packages/shared/src/auth/header.ts
export const X_SILVERHAND_PRINCIPAL_HEADER = 'x-silverhand-principal';
export function encodeUserPrincipalHeader(userId: string): string;
export function decodeUserPrincipalHeader(value: string): { userId: string } | null;
```

### 4.2 Principal resolution: 概念 vs 传输

**Principal 是每个请求都有的权限主语，覆盖 user / agent / system。这里要严格区分两件事：**

- **Principal 这个概念**：所有请求都必须解析出一个 Principal。
- **Principal 的输入来源**：因路由不同而不同。header 只是 user 这条路的输入机制，不是 Principal 概念本身的"必经入口"。

**身份来源边界**（核心规则）：

> **human 的 v1 身份是 renderer 声明式占位（header 携带）；agent 的身份必须由 backend 绑定推导（URL + getAgent），不能由请求方声明。**

| 路由 | Principal kind | 输入来源 | 为什么 |
|---|---|---|---|
| `/api/*` | `user` | `X-Silverhand-Principal` header | URL 不含身份；v1 单用户由 renderer 声明，未来换 session token claims |
| `/internal/.../:cid/:aid/*` | `agent` | URL 路径 + Bearer + `conversations.getAgent(cid, aid)` | URL 在 chat-bridge spawn 时锁死，是绑定关系而非声明 |
| backend 内部代码 | `system` | 不来自 HTTP | onboarding / lifecycle / provision 等内部触发 |

**为什么 internal 必须 reject `X-Silverhand-Principal` header**：

不是因为 agent 没有 Principal——agent 当然有 Principal。而是因为如果 internal 路由同时接受 URL 和 header 两个身份输入，会出现冲突：

- URL 说 "我是 `agent:A in channel:X`"
- header 说 "我是 `agent:B`" 或 "我是 `user:local`"

无论选哪个为准都有问题：
- 信 header → URL 白做，且 header 可被任意持 token 进程伪造，攻击面打开；
- 信 URL → header 是装饰品，写错了还以为生效，未来调用方误以为可以靠 header 改身份。

干脆**让 header 在 internal 路由上非法**，machine identity 的来源单一：URL。header 出现 = 调用方写错了，400 让他立刻知道。

可以用一句话总结：

```text
Principal exists for every request.
Public user principal may be carried by X-Silverhand-Principal in v1.
Internal agent principal is derived only from URL + bearer + membership;
X-Silverhand-Principal is invalid on internal routes.
```

### 4.3 Principal resolution middleware（实现示意）

```ts
// packages/backend/src/auth/middleware.ts （新增）
export function resolvePrincipal(ctx): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    let principal: Principal;

    if (path.startsWith('/internal/')) {
      // agent 身份只来自 URL + Bearer + getAgent 隶属校验
      // X-Silverhand-Principal 头如果出现，400 拒绝（不是忽略）
      if (c.req.header(X_SILVERHAND_PRINCIPAL_HEADER)) {
        return c.json({ error: 'principal header not allowed on internal routes' }, 400);
      }
      const cid = c.req.param('cid');
      const aid = c.req.param('aid');
      // ... validate via conversations.getAgent(cid, aid)
      principal = { kind: 'agent', agentId: aid, conversationId: cid };
    } else {
      // /api/* —— v1 user principal 从 header 解析
      const decoded = decodeUserPrincipalHeader(c.req.header(...));
      principal = { kind: 'user', userId: decoded?.userId ?? 'local' };
    }

    c.set('principal', principal);
    await next();
  };
}
```

**关键约束**（写进 middleware 的 invariants）：

- `/api/*` 路径只能产出 `kind:'user'` principal（v1）；未来多人模式改成从 session token claims 解析；
- `/internal/.../:cid/:aid/*` 路径只能产出 `kind:'agent'` principal，agentId/conversationId 严格来自 URL，header 出现即 400；
- `system` principal 永远不来自 HTTP，只在 backend 内部代码使用。

### 4.3 Service actor 折叠

四个 `*Actor` union 全部删除，service 方法签名直接接 Principal：

```ts
// before
sendMessage({ conversationId, actor: SendMessageActor, content, ... })
createChannel({ workspaceId, title, actor: ChannelActor, ... })

// after
sendMessage({ conversationId, principal: Principal, content, ... })
createChannel({ workspaceId, title, principal: Principal, ... })
```

Service 内部按 principal.kind 取需要的字段。`POLICIES` 表保留——业务行为差异（agent 必须是 conversation member、user 不能指定 target conversation 等）继续由 policy 表驱动，**与 ACL 解耦**。

附件层 `createdByKind/createdById` 折成 `createdByPrincipal: Principal`。

### 4.4 路由 handler 简化

```ts
// before
app.post('/api/channels/:id/messages', c => {
  const viewerUserId = resolveViewerUserId(c, ctx);
  if (typeof viewerUserId !== 'string') return viewerUserId;
  ctx.conversationMessageService.sendMessage({
    conversationId: cid,
    actor: { kind: 'user', userId: viewerUserId },
    content,
  });
});

// after
app.post('/api/channels/:id/messages', c => {
  const principal = c.get('principal'); // 已由 middleware 注入
  ctx.conversationMessageService.sendMessage({
    conversationId: cid,
    principal,
    content,
  });
});
```

### 4.5 ACL 家族骨架（Slice D-skeleton 引入）

`packages/backend/src/auth/acl.ts`（重命名自 `ws/permissions.ts`）暴露完整 ACL 函数集：

```ts
// Workspace
canViewWorkspace(principal, workspace): boolean
canMutateWorkspace(principal, workspace): boolean
canManageMembers(principal, workspace): boolean

// Conversation / Channel / Thread
canViewConversation(principal, conversation): boolean
canPostToConversation(principal, conversation): boolean
canCreateThread(principal, conversation): boolean
canCloseThread(principal, conversation): boolean

// Per-resource
canViewAttachment(principal, attachment): boolean
canDeleteAttachment(principal, attachment): boolean

// Per-viewer state
canViewOwnedState(principal, ownerId): boolean
```

v1 实现都是 placeholder（详见 §6），但**所有路由 handler 必须改成调用这些函数，不再内联条件判断**。这一步是为后续真实 ACL 落地铺路。

---

## 5. Mutation authority matrix

| 操作 | user | agent | system |
|---|---|---|---|
| 创建 workspace | ✅ | ❌ | ✅（provision 路径） |
| 加 / 删 workspace 成员 | ✅ | ❌ | ✅ |
| 创建 channel / thread | ✅ | ✅（限本 conversation） | ✅ |
| 发普通消息（`from_kind != system`） | ✅ | ✅（限本 conversation） | ❌ |
| 发 `from_kind = 'system'` 消息 | ❌ | ❌ | ✅ |
| 上传 attachment | ✅ | ✅（限本 channel） | ❌ |
| 删 attachment | ✅（创建者） | ✅（创建者） | ✅ |
| Claim/unclaim/update task | ✅（自己 claim 的） | ✅（自己 claim 的） | ✅ |

**硬不变量**（必须在 repo 层断言，不能依赖路由层守卫）：

1. `from_kind = 'system'` 的消息**不可由外部 HTTP 注入**。任何 `messageRepo.insert` 调用方传 `from_kind = 'system'` 时，stack 必须能追溯到 backend 内部代码（onboarding / lifecycle / provision），不能来自 HTTP handler。
2. agent 的 `agentId` 和 `conversationId` 在 chat-bridge spawn 时由 URL 参数锁定，**不可由请求 body / header 覆盖**。Principal middleware 通过 URL 推断这两个字段，请求方无 say。
3. agent 永远看不到非本 conversation 的消息——不是因为路由禁止，而是 agent 根本没有"读消息"路由。drainInbox 只把它自己 conversation 的消息写入 stdin。这是结构性隔离，不是策略性隔离。

---

## 6. ACL 资源规则（v1 + 未来）

### 6.1 Workspace

| Workspace kind | v1 ACL 规则 | 未来（多人）规则 |
|---|---|---|
| `regular` | 任何 user / 已加入的 agent 可见 | `human_workspace_members` 或 owner |
| `agent_home` | 任何 user / owner agent 可见 | local human admin / owner agent |

**注**：v1 不区分 workspace kind 的可见性——`canViewWorkspace` 返回 "exists?"。`agent_home` 的实质 ACL（owner agent + admin）等多人模式落地时再实现。今天文档里明文写出来是为了未来实现有目标。

### 6.2 Conversation / Channel / Thread

继承所属 workspace 的 ACL。Thread 视作 channel 的子节点，ACL 与 channel 一致。

`canPostToConversation`：

- user：通过 `canViewConversation`（v1 即可见即可发）；
- agent：必须是 conversation member（`conversations.getAgent(cid, aid)` 通过）。

### 6.3 Attachment

- `canViewAttachment(principal, attachment)`：等价于 `canViewConversation(principal, conversations.get(attachment.channel_id))`。Attachment 边界 = 它的 owning channel。
- `canDeleteAttachment(principal, attachment)`：principal 是创建者 OR principal kind 是 system。

**重要**：当前 `GET /api/attachments/:id` 完全无 ACL，是已知漏洞，归后续修复任务（释放后的 #110）。`AttachmentService.serve()` 内部注释声称 "caller has already passed channel-membership / viewer auth at the route layer"——目前是空头支票，待 Slice C 兑现。

### 6.4 Per-viewer state（unread / saved / notifications / tasks）

`canViewOwnedState(principal, ownerId)`：principal 只能看自己拥有的状态。

- v1：principal `user:local`，ownerId 也固定 `local`，placeholder 永真；
- 未来：要求 `principal.kind === 'user' && principal.userId === ownerId`，或 admin role。

### 6.5 Task

Task 是 message 的 promotion，ACL 继承所在 conversation。
- claim：principal 必须能 view conversation；
- unclaim/update：principal 必须是 task 当前 assignee。

---

## 7. Slice 实施路线（v1 → 远端的演进路径）

### Phase 1: Auth infra（当前）

按顺序、独立 PR：

**Slice A'（task #125，进行中）— Principal 统一**
- `Principal` 类型 + `resolvePrincipal()` middleware；
- 四个 `*Actor` union 折叠；
- Attachment `createdByKind/createdById` 也折成 Principal；
- public router 解析 `X-Silverhand-Principal` 头，internal router 拒绝该头；
- 测试硬验收：
  - `test_public_no_bearer_unchanged` — 无 Bearer 仍可访问 `/api/workspaces` 等非 attachment 路径（守 Slice B 不混入）；
  - `test_internal_rejects_principal_header` — `/internal/*` 收到 `X-Silverhand-Principal` 头返回 400；
  - 失败处理：treat 为范围越界，**revert 不 fix**。
- 不动 Bearer 收口，不动 attachment ACL。

**Slice B — Bearer 收口到 `/api/*`**
- `requireBearer` middleware 挂 `/api/*`，allowlist `/api/health`；
- 测试：每条 public route 401（无/错 Bearer）/ 200（正确 Bearer + 现有逻辑）双向覆盖；
- renderer 已经在发，零 UX 改动。

**Slice D-skeleton — ACL 函数家族骨架**
- `auth/acl.ts` 暴露完整 ACL 函数集（§4.5）；
- 函数体 placeholder（按 §6 表格的 v1 规则）；
- **所有路由 handler 改成调用 ACL 函数**，不再内联条件；
- 行为变更 = 0；为后续填真实规则铺路。

**Slice C（释放后的 #110）— Attachment GET ACL**
- `GET /api/attachments/:id` 加 `canViewAttachment(principal, attachment)`；
- `AttachmentService` 加 `serveForViewer(id, canView)` 折叠 not-found / ACL denied → null，路由统一返回 same-shape 404 body（避免 existence oracle）；
- 兑现 §6.3 的"空头支票"。

### Phase 2: 多人 / 远端（触发条件 + 待引入构件）

**触发条件（hard）**：

- 第二个 human 用户接入**之前**；
- backend 暴露到非 loopback **之前**。

不能等出现后再补——开门就必须有锁。

**待引入构件**（命名先固化，避免后人撞名）：

| 构件 | 作用 | 注意 |
|---|---|---|
| `users(id, ...)` | human 用户表 | v1 没有；renderer hardcode `local` |
| `human_workspace_members(workspace_id, user_id, role)` | human ↔ workspace ACL 表 | **不要复用 `workspace_members`**（已是 agent 表）|
| Per-principal session token | 替代共享 `auth_token` | 落地时 Bearer middleware 改解析；Principal middleware 改从 claims 取身份 |
| Backend-signed agent token | spawn 时 backend 签 short-lived token，claims 锁 agent_id + conversation_id | 替代当前"信任 URL 路径推断"|
| `attachment-view-token` | 短期签 URL，给 `<img src>` 用 | mint 必须 backend 做，secret 不下发 renderer |
| `attachment-share-link` | 外部分享链接 | 独立路由 / 独立签发器 / 独立撤销列表，**不与 view-token 复用 helper**|
| Avatar / profile ACL | workspace 或 app scope | 共享 `requireBearer/requirePrincipal` 身份层，但 ACL 独立 |
| Audit log | workspace / membership 变更留痕 | 多人模式必须 |

---

## 8. Open invariants (must hold across all slices)

1. `from_kind = 'system'` messages cannot originate from external HTTP. Repo
   layer must enforce.
2. Agent `agentId` / `conversationId` are spawn-time URL parameters; cannot be
   overridden by request body or header.
3. Cross-channel reads at HTTP level are blocked by membership checks; agents
   never see foreign-channel messages because drainInbox only feeds their own.
4. Principal layer and ACL layer are strictly separated. Service-layer policy
   tables (e.g. `SendMessagePolicy` for user vs agent behavior) are **not**
   ACL — they are business behavior switches. Don't conflate.
5. Public router (`/api/*`) and internal router (`/internal/*`) are
   architecturally separate. They share identity middleware but not principal
   semantics. Header allowed on one is rejected on the other.
6. Slice scope discipline: A' is structural, B is auth enforcement, C is the
   attachment fix, D is ACL plumbing. A test failure in one slice's PR
   suggesting another slice's change is needed = scope creep. Revert, don't
   "fix".

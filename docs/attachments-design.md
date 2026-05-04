# Silverhand — Attachments 设计

> **Status**: Spec（2026-05-04 起草）。未实现；落地前如果与现实偏离，回这里改，不要让代码和文档分叉。
>
> 与 [`core-design.md`](./core-design.md) 的消息流水对齐——本 doc 在 message 旁边新增 attachment 资源，message DTO 增加 `attachments` 引用字段。
>
> 与 [`app-layout.md`](./app-layout.md) 的 composer / message 渲染契约对齐——本 doc 定义 attachment 的存储与传输，UI 排版仍走 `design-new-theme.md`。
>
> 参考实现：`@slock-ai/daemon` 的 `upload_file` / `view_file` / `send_message(attachment_ids)` 三件套（见 §9 对比）。

---

## 1. 为什么做

silverhand 现在的 message 是纯文本管道——`messages.content TEXT`，driver 只解析 text/thinking/tool_use 三种 block，composer 也只能发字符串。要让 agent 之间、agent 与 human 之间能传图（截图、设计稿、报错截屏），需要新增一类资源：**attachment**。

不止图片。同一套机制覆盖任何二进制文件（图片是首要场景，PDF/日志/任意上传是顺带），所以表名、API、tool 命名都用 `attachment` 不用 `image`。

设计目标按优先级：

1. **local 单机现在能用**——backend 跑在 Electron 主进程里，blob 落 `~/.silverhand/attachments/`，零外部依赖。
2. **schema/API 同构于未来的 remote 部署**——切换到对象存储后端时，message 表、chat-bridge 工具、渲染端代码零改动。
3. **stream-json 不被污染**——不把 base64 塞进 agent 的 stdin/stdout。图通过独立 HTTP 通道流转，message 里只携带 id 引用。

---

## 2. 核心设计原则：local/remote 同构

整个设计的关键判断是**把 storage 后端隔离到一个 dispatch 层背后**。所有上层（DB schema、HTTP API、chat-bridge tool、renderer）都对 storage 类型无感知。

### 2.1 抽象边界

```
┌─────────────────────────────────────────────────────────┐
│  调用方（renderer / chat-bridge / agent）                 │
│    只认识：attachment id、HTTP routes                     │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│  HTTP API 层（POST upload / GET stream）                  │
│    根据 attachments.storage 字段 dispatch                 │
└──────────┬──────────────────────────────────┬───────────┘
           │                                  │
   ┌───────▼────────┐               ┌────────▼─────────┐
   │  local backend │               │  s3 backend      │
   │  fs read/write │               │  putObject/sign  │
   └────────────────┘               └──────────────────┘
```

### 2.2 三条不可破的规则

1. **DB 不存绝对路径，不存完整 URL**。只存 `storage` (枚举) + `storage_key` (后端内部的逻辑 key)。`local` 模式下 `storage_key = id`；`s3` 模式下 `storage_key = 'channels/<cid>/<id>'` 之类。
2. **renderer 永远走 HTTP**。`<img src="/api/attachments/{id}">`，绝不引入 `file://` 分支。理由：renderer 是 web 技术栈，HTTP 是它的母语；远端部署时 renderer 不在 backend 同机，path 给它没意义。
3. **chat-bridge 接口在两种模式下完全相同**。`view_file(id) → { path }` 永远返回一个 agent 可读的本地路径。local 模式下这个路径是 backend 的存储路径（零拷贝），remote 模式下是 chat-bridge 缓存目录里下载好的副本。模式切换对 agent 完全透明。

### 2.3 模式切换是单点改造

未来从 local 升级到 remote 时只需要：
- 配置 `storage='s3'` 作为新上传的默认
- 实现 s3 backend 的 dispatch 分支
- 旧的 `storage='local'` 行继续工作，或跑迁移把 blob 推到 s3 并改写记录

message 表、`/api/attachments/:id` 的 URL 形态、chat-bridge 工具签名、renderer 都不需要动。

---

## 3. 数据模型

### 3.1 新增 `attachments` 表

```sql
CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,                                          -- uuid v4
  channel_id    TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,   -- 鉴权 + 生命周期边界
  session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,           -- 溯源；session 删除后保留 blob
  filename      TEXT NOT NULL,                                             -- 原始文件名（带扩展名）
  size          INTEGER NOT NULL,                                          -- 字节
  content_type  TEXT NOT NULL,                                             -- 'image/png' 等
  storage       TEXT NOT NULL,                                             -- 'local' | 's3' | ...
  storage_key   TEXT NOT NULL,                                             -- 后端内部的逻辑 key
  hash          TEXT NOT NULL,                                             -- sha256(content)，hex
  created_by    TEXT NOT NULL,                                             -- user id 或 agent id
  created_at    INTEGER NOT NULL                                           -- unix ms
);

CREATE INDEX idx_attachments_channel ON attachments(channel_id);
CREATE INDEX idx_attachments_session ON attachments(session_id);
CREATE UNIQUE INDEX idx_attachments_dedup ON attachments(channel_id, hash);
```

### 3.2 `channel_id` vs `session_id` 的角色

silverhand 比 slock 多一层 session，所以这里做的判断和 slock 不同：

| 字段 | 角色 | 空性 | 删除行为 |
|---|---|---|---|
| `channel_id` | **鉴权边界 + 生命周期根** | NOT NULL | channel 删 → blob 物理删除（CASCADE） |
| `session_id` | **溯源/审计**：图最初在哪个 session 上传的 | nullable | session 删 → 字段置空，blob 留着 |

核心判断是：**channel 是访问控制和数据归属的边界，session 只是上下文标签**。理由：

1. **图的可见性是 channel 级的**。同一个 channel 里 session A 上传的图，session B（包括 sub-session）应该能直接 `view_file` 引用。如果按 session 隔离，agent 之间贴图协作就废了。
2. **session 删除不该带走图**。session 可以归档/删掉，但消息历史里如果还引用着这张图，blob 不能消失。channel 才是真正的"资源所有者"。
3. **去重 scope 是 channel**。`UNIQUE(channel_id, hash)` 让同一 channel 内重复上传只存一份；不同 channel 各存各的（避免跨 channel 数据泄露与权限漏洞）。

### 3.3 message 关联 attachment

`messages` 表加一列：

```sql
ALTER TABLE messages ADD COLUMN attachments TEXT;   -- JSON: [{id, filename}] | null
```

为什么不另起关联表：attachment 引用是 message 的固有面，不是平行实体。和 `tasks-design.md` §3.1 的判断一致——能用 JSON 列就别造表，避免 N+1 查询和事务复杂度。

DTO 上 `attachments` 同样是 `Array<{id, filename}>`，渲染端用 `id` 拼出 `/api/attachments/{id}` 加载。**完整元数据（size / content_type）不冗余进 message**，需要时按 id 查 `attachments` 表，避免双源数据漂移。

---

## 4. HTTP API

### 4.1 上传：`POST /api/sessions/:sid/attachments`

为什么以 session 为入口而不是 channel：silverhand 的所有上传场景都发生在 session 上下文里（composer 在 session view 内，agent 跑在 session 里）。让调用方提供 sid 更符合直觉，channel 由 server 通过 sessions 表反查。如果未来出现 channel-level 上传场景，再加 `POST /api/channels/:cid/attachments`（`session_id` 写 NULL）。

**Request**: `multipart/form-data`，字段 `file=<blob>`。

**Handler 草图**：

```ts
async (c) => {
  const sid = c.req.param('sid');
  const session = sessions.findById(sid);
  if (!session) return c.notFound();

  const form = await c.req.formData();
  const file = form.get('file') as File;
  if (!file) return c.badRequest();

  // 1. 读 + hash + per-channel 去重
  const buf = Buffer.from(await file.arrayBuffer());
  const hash = sha256Hex(buf);
  const existing = attachments.findByChannelAndHash(session.channel_id, hash);
  if (existing) {
    return c.json({ id: existing.id, filename: existing.filename, size: existing.size });
  }

  // 2. 落盘（local 模式）
  const id = randomUUID();
  const storage = storageBackend();           // 配置驱动
  const storageKey = await storage.put(id, buf);

  // 3. 入库
  attachments.insert({
    id,
    channelId: session.channel_id,
    sessionId: sid,
    filename: file.name,
    size: buf.length,
    contentType: file.type || guessContentType(file.name),
    storage: storage.kind,                    // 'local' | 's3' | ...
    storageKey,
    hash,
    createdBy: ctx.actorId,
    createdAt: Date.now(),
  });

  return c.json({ id, filename: file.name, size: buf.length });
}
```

**响应**: `{ id, filename, size }`。**不返回完整 URL**——客户端按约定拼 `/api/attachments/{id}` 即可。

**约束**:
- 单文件大小上限：先定 10MB（对齐 slock）。超出返回 `413`。
- `content_type` 用 `guessContentType()` 兜底（扩展名 → MIME 映射，不识别就 `application/octet-stream`）。
- 文件名做基本清理（去路径分隔符、限长 255 字节）。

### 4.2 下载：`GET /api/attachments/:id`

```ts
async (c) => {
  const id = c.req.param('id');
  const att = attachments.findById(id);
  if (!att) return c.notFound();

  // TODO(later): 鉴权——caller 必须是 att.channel_id 的成员
  // v1 单机单 user 可暂缓，schema 已经准备好

  const storage = storageBackendFor(att.storage);
  return storage.serve(c, att);
}
```

每个 backend 的 `serve()` 实现：

- **local**: `fs.createReadStream(path.join(rootDir, att.storage_key))`，配 `Content-Type: att.content_type`、`Content-Length: att.size`、`Content-Disposition: inline; filename="..."`、`Cache-Control: private, max-age=31536000, immutable`（id 是内容寻址，不可变）。
- **s3**: `c.redirect(await s3.getSignedUrl(att.storage_key, { expiresIn: 300 }), 302)`。或者 stream 代理，看带宽偏好。

为什么 GET 流字节而不是返回路径：renderer 是浏览器，浏览器只懂 HTTP；返回 path 在远端模式毫无意义，会强迫渲染层引入 storage 分支判断，破坏 §2.2 第 2 条。

### 4.3 内部路由（仅 local 模式）：`GET /internal/attachments/:id/locate`

为 chat-bridge 在 local 模式做零拷贝优化用（详见 §5）。返回：

```json
{ "storage": "local", "localPath": "/Users/.../.silverhand/attachments/<id>" }
```

或在远端模式：

```json
{ "storage": "s3" }
```

remote 部署时这个 endpoint 仍然存在，但永远不返回 `localPath`，chat-bridge 自动 fallback 到 HTTP 下载路径。

---

## 5. local 模式的特殊设计

local 模式真正能赚到的便宜在 **agent 端 `view_file`**：backend 和 agent 跑在同一台机器、同一文件系统上，agent 完全没必要走 HTTP 把 blob 拉到自己的缓存目录——直接读 backend 的存储文件即可。

### 5.1 `view_file` 的双模式实现

chat-bridge 里的 MCP 工具：

```ts
async function view_file(id: string): Promise<{ path: string }> {
  // 先问 backend：这个 attachment 在本地有吗？
  const locate = await fetch(`${backend}/internal/attachments/${id}/locate`)
    .then(r => r.json());

  if (locate.storage === 'local' && locate.localPath) {
    // local 模式：直接返回 backend 存储路径，零拷贝
    return { path: locate.localPath };
  }

  // remote 模式或非 local：HTTP 下载到 chat-bridge 本地缓存
  const cacheDir = path.join(os.homedir(), '.silverhand', 'attachments-cache');
  await fs.mkdir(cacheDir, { recursive: true });

  const cached = path.join(cacheDir, id);     // 内容不可变，文件名 = id
  if (!fsSync.existsSync(cached)) {
    const res = await fetch(`${backend}/api/attachments/${id}`);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    await pipeline(res.body!, fs.createWriteStream(cached));
  }
  return { path: cached };
}
```

agent 拿到 `path` 之后用 `Read` / 视觉工具直接读盘。两种模式对 agent 完全透明。

### 5.2 为什么不让 chat-bridge 直接读 fs

跳过 `/internal/locate` 让 chat-bridge 自己拼 `~/.silverhand/attachments/<id>` 看起来更简单——但这违反了 §2.2 第 1 条（DB 不存路径意味着外界也不该假设路径）。如果未来 backend 把存储目录改成 `~/.silverhand/blob/`、加了分片子目录，或者切到 s3，chat-bridge 不通过 backend 询问就会失效。

让 backend 来决定"这个 id 在本地能不能直接读、路径是什么"，存储布局是 backend 的内部细节。

### 5.3 文件命名

`~/.silverhand/attachments/<id>`，**没有扩展名**。原因：扩展名信息全在 DB 的 `filename` + `content_type` 列里；磁盘文件名保持 opaque 和 storage_key 一致，未来加分片（`<id[0:2]>/<id>`）也不影响调用方。

`Content-Disposition: filename="..."` 用 DB 里的 `filename`，下载时浏览器/客户端拿到的是用户可读的原始名。

---

## 6. chat-bridge MCP 工具

照搬 slock 的三件套接口，schema 几乎一样：

### 6.1 `upload_file`

```ts
upload_file({
  file_path: string,    // agent 本地的绝对路径
  session: string,      // 当前 session id（chat-bridge 启动时 env 注入，agent 不需要操心）
})
→ { id: string, filename: string, size: number }
```

实现：读盘 → multipart POST `/api/sessions/:sid/attachments` → 返回 `{id, filename, size}`。

### 6.2 `view_file`

见 §5.1。返回 `{ path: string }`，agent 拿到本地可读路径。

### 6.3 `send_message` 扩展

现有 `mcp__chat__send_message` 在 silverhand 里只接受 `content: string`。扩展为：

```ts
send_message({
  channel: string,
  content: string,
  attachment_ids?: string[],     // 来自 upload_file
})
```

**绝不接受 `base64` 字段**——agent 必须先 upload 拿 id，再 send_message 带 id。这把上传和发消息两件事解耦，方便重试、限流、鉴权各自演化。

backend 端 `/internal/agent/.../send-message` 接收 `attachmentIds: string[]`，写入 message 行的 `attachments` 列时存为 `[{id, filename}]`（filename 通过 attachments 表反查）。

---

## 7. inbox drain：让 agent 看到附件

agent 离线期间收到的消息走 inbox 流程。`formatInboxBatch()` 当前生成纯文本注入 stdin。**stream-json 的 content array 不要塞 image block**——直接在文本里追加附件提示，让 agent 自行决定是否调 `view_file`。

格式（对齐 slock `formatIncomingMessage` 的写法）：

```
@alice: 看下这个报错
[2 attachments: error.png (id:a1b2c3d4), trace.log (id:e5f6g7h8) — use view_file to download]
```

这样：

- `encodeStdinMessage()` / driver 的 `parseLine()` 完全不动
- agent 看到 filename + id，自己决定要不要看（节省 token：1MB 图不会被强行塞进上下文）
- sub-session 转发零成本——`spawn_child_session` 只复制 attachment id 字符串，不搬 blob

driver platform-prompt（`packages/backend/src/drivers/platform-prompt.ts`）需要补一句：附件以 `[id:xxx: filename]` 形式出现在消息里，要看内容用 `view_file(id)`，要发图用 `upload_file` + `send_message(attachment_ids=[...])`。

---

## 8. renderer

### 8.1 message 渲染

`MessageItem.tsx` 检测 `message.attachments` 非空时，在 markdown 区域下方渲染附件区：

- 图片类（`content_type` 以 `image/` 开头）：渲染成 `<img src="/api/attachments/{id}" />` 缩略图，点击放大
- 其他文件：渲染成下载链接 `<a href="/api/attachments/{id}" download="{filename}">{filename} ({size})</a>`

`content_type` 不在 message DTO 里——渲染端按 id 单独拉一次 `GET /api/attachments/:id/meta`（轻量元数据接口），或在 message DTO 里冗余 `mediaKind: 'image' | 'file'` 一个最小判别字段（可选优化，避免一次额外请求）。

### 8.2 composer 上传

`Composer.tsx` 加文件按钮 + 拖拽区：

1. 选/拖入文件 → 立刻 `POST /api/sessions/:sid/attachments` 上传，拿到 `{id, filename, size}`，在 composer 显示 chip 预览
2. 用户继续打字，可以删 chip
3. 点 Send → `POST /api/sessions/:sid/messages` body 加 `attachment_ids: string[]`
4. backend 在写 message 时把 ids 解析成 `[{id, filename}]` 存进 `attachments` 列

**先传后发**的好处：上传是慢操作，发消息是快操作，分开后用户感知到的"发送延迟"只是发消息那一下；图传到一半可以取消而不留下空消息。

---

## 9. 与 slock 的对比

参考实现来自 `@slock-ai/daemon` v0.44.2（位于 `/Users/shiki/.npm/_npx/277f35d2ed0078b9/node_modules/@slock-ai/daemon/`）。

| 维度 | slock | silverhand |
|------|-------|-----------|
| **资源归属** | channel 级（一个 channel 一组 attachment） | **channel + session 双标签**（channel 鉴权，session 溯源） |
| **去重 scope** | （未观察到，可能无） | **per-channel hash 去重** |
| **storage 抽象** | server-side（具体后端不可见） | **dispatch 层，storage 字段驱动**（local/remote 同构） |
| **上传 endpoint** | `POST /internal/agent/{aid}/upload` | `POST /api/sessions/:sid/attachments` |
| **下载 endpoint** | `GET /api/attachments/{id}` | `GET /api/attachments/:id`（一致） |
| **agent 缓存** | `~/.slock/attachments/{id}.{ext}`（带扩展名） | local: 零拷贝读 backend 存储；remote: `~/.silverhand/attachments-cache/{id}`（无扩展名） |
| **MCP 工具** | `upload_file` / `view_file` / `send_message(attachment_ids)` | **同名同结构**（兼容 slock agent 心智） |
| **stream-json 走法** | 文本注入，附件以 `[id:xxx — use view_file]` 提示 | **同上**（不污染 stream-json） |
| **大小上限** | 10MB | 10MB |

最大的差异在两点：

1. **多一个 session_id 列**——slock 没有 session 概念，silverhand 有。但通过把鉴权放在 channel、溯源放在 session，没有引入额外的访问控制复杂度。
2. **local 模式的 view_file 零拷贝优化**——slock 因为 daemon 和 backend 物理分离（daemon 在用户机、backend 在云上），永远走 HTTP。silverhand v1 单机部署能跳过这层 HTTP，agent 直接读 backend 存储路径。

---

## 10. 落地分阶段

### Phase 1: local mode v1（最小可用）

1. 新增 `attachments` 表 + migration
2. `messages.attachments` 列 + DTO 字段
3. local storage backend（`~/.silverhand/attachments/`）
4. `POST /api/sessions/:sid/attachments`（multipart）
5. `GET /api/attachments/:id`（stream）
6. `MessageItem.tsx` 渲染图片 / 文件附件
7. `Composer.tsx` 上传 UI
8. `useSendMessage` hook 接受 `attachment_ids`

到这一步 human 之间能在同一 session 里互相贴图。agent 还看不见。

### Phase 2: agent 互通

9. chat-bridge 加 `upload_file` / `view_file` 工具
10. chat-bridge `send_message` 扩展 `attachment_ids` 参数
11. backend `/internal/agent/.../send-message` 接 `attachmentIds`
12. `formatInboxBatch()` 追加附件提示文本
13. `GET /internal/attachments/:id/locate`（local 模式零拷贝）
14. driver platform-prompt 补附件用法说明

到这一步 agent 能看图、能发图、能在子 session 转发。

### Phase 3: 远端后端落地（未来）

15. 实现 s3 storage backend dispatch
16. 配置项：默认 storage、s3 bucket / region / 凭证
17. `GET /api/attachments/:id` 鉴权中间件（caller 必须是 channel 成员）
18. chat-bridge `view_file` 缓存目录策略（清理、上限）
19. 旧 local 数据迁移脚本（可选；通常 grandfather 即可）

到这一步多人多机也能用。

### Phase 4: 优化（按需）

- 缩略图预生成（`?variant=thumb`）
- 大文件断点续传（multipart upload）
- 跨 channel 引用策略（如果产品有需求）
- 配额管理（per-user / per-channel）
- 病毒扫描（remote 模式）

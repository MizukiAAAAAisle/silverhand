# Silverhand — Attachments 设计

> **Status**: Phase 1 + Phase 2 已落地（2026-05-06）。Phase 3/4 仍是 spec。如发现实际实现与本文档不符，回这里改，不要让代码和文档分叉。
>
> 与 [`core-design.md`](./core-design.md) 的消息流水对齐——本 doc 在 message 旁边新增 attachment 资源，message DTO 增加 `attachments` 引用字段。
>
> 与 [`app-layout.md`](./app-layout.md) 的 composer / message 渲染契约对齐——本 doc 定义 attachment 的存储与传输，UI 排版仍走 `design-new-theme.md`。
>
> 参考实现：`@slock-ai/daemon` 的 `upload_file` / `view_file` / `send_message(attachment_ids)` 三件套（见 §11 对比）。

---

## 1. 为什么做

silverhand 现在的 message 是纯文本管道——`messages.content TEXT`，driver 只解析 text/thinking/tool_use 三种 block，composer 也只能发字符串。要让 agent 之间、agent 与 human 之间能传图（截图、设计稿、报错截屏），需要新增一类资源：**attachment**。

不止图片。同一套机制覆盖任何二进制文件（图片是首要场景，PDF/日志/任意上传是顺带），所以表名、API、tool 命名都用 `attachment` 不用 `image`。

设计目标按优先级：

1. **local 单机现在能用**——backend 跑在 Electron 主进程里，blob 落 `~/.silverhand/blobs/`，零外部依赖。
2. **schema/API 同构于未来的 remote 部署**——切换到对象存储后端时，message 表、chat-bridge 工具、渲染端代码零改动。
3. **stream-json 不被污染**——不把 base64 塞进 agent 的 stdin/stdout。图通过独立 HTTP 通道流转，message 里只携带 id 引用。

---

## 2. 核心设计原则：storage infra 与应用层分离

整个设计的关键判断是**把 blob/file storage 后端隔离到一个 infra dispatch 层背后**。message attachment、未来 avatar、未来 workspace icon / export file 都只是它上面的不同 application。

### 2.1 抽象边界

```
┌─────────────────────────────────────────────────────────┐
│  调用方（renderer / chat-bridge / agent）                 │
│    只认识：上层应用 id、HTTP routes                        │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│  Application 层                                           │
│    message attachment / avatar / workspace icon / ...     │
│    负责业务归属、鉴权、生命周期、DTO snapshot              │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│  Blob/File Storage infra                                 │
│    put / serve / locate / delete                         │
│    根据 storage backend dispatch                          │
└──────────┬──────────────────────────────────┬───────────┘
           │                                  │
   ┌───────▼────────┐               ┌────────▼─────────┐
   │  local backend │               │  s3 / oss backend│
   │  fs read/write │               │  putObject/sign  │
   └────────────────┘               └──────────────────┘
```

### 2.2 分层命名

- **Blob/File Storage infra**：底层能力，负责二进制文件的 `put/get/serve/locate/delete`，本地可以落 `~/.silverhand/blobs/`，远端可以对接 s3/oss。它不懂 message、channel、avatar。
- **Attachment system**：message application。`attachments` 表、message snapshot、`upload_file` / `view_file`、channel/thread 权限都属于这一层。
- **Avatar system（future）**：profile application。user/agent avatar 可以复用同一个 storage infra，但不应该塞进 `attachments` 表，因为 avatar 不属于 channel，没有 message 溯源，也不跟 channel 生命周期绑定。

### 2.3 Blob/File Storage infra contract

v1 先把 storage 做成 backend 内部 service/interface，不要求先建一张全局 `blobs` 表。每个 application 表保存自己的 `storage` + `storage_key` 引用；storage infra 只负责按 key 操作字节。

```ts
type StorageKind = 'local' | 's3' | 'oss';

type StoredFileRef = {
  storage: StorageKind;
  storageKey: string;
};

interface BlobFileStorage {
  readonly kind: StorageKind;

  put(input: {
    namespace: 'attachments' | 'avatars' | 'workspace-icons' | string;
    id: string;
    filename: string;
    contentType: string;
    buffer: Buffer;
  }): Promise<StoredFileRef>;

  serve(ref: StoredFileRef, headers: {
    filename: string;
    contentType: string;
  }): Response;

  locate?(ref: StoredFileRef): Promise<{ localPath: string } | null>;

  delete(ref: StoredFileRef): Promise<void>;
}
```

规则：

- infra 不做 channel/thread/user/agent 鉴权；调用它之前由 application 层完成权限判断。
- infra 不懂 message attachment、avatar、workspace icon 的生命周期；application 删除业务 row 时调用 `delete()`。
- v1 不需要全局 blob 去重或 refcount。后续如果要配额、全局 GC、跨 application 复用，再新增 `storage_objects`/`blobs` 表；不要把这些复杂度塞进 message attachment v1。

### 2.4 三条不可破的规则

1. **DB 不存绝对路径，不存完整 URL**。只存 `storage` (枚举) + `storage_key` (后端内部的逻辑 key)。`local` 模式下可以是 `attachments/<id>.<ext>` 或分片后的等价 key，最终由 storage infra 映射到 `~/.silverhand/blobs/...`；`s3` / `oss` 模式下可以是 `channels/<cid>/<id>.<ext>` 之类。
2. **renderer 永远走 HTTP**。图片 / 下载链接必须由 renderer 的 backend base URL 拼成绝对 HTTP URL（例如 `${backendUrl}/api/attachments/{id}`），绝不引入 `file://` 分支，也不要直接写相对 `/api/...`。理由：Electron renderer 可能跑在 Vite / file origin 下，相对 `/api` 不一定指向 backend；远端部署时 renderer 也不在 backend 同机，path 给它没意义。
3. **chat-bridge 接口在两种模式下完全相同**。`view_file(id) → { path }` 永远返回一个 agent 可读的本地路径。local 模式下这个路径是 backend 的存储路径（零拷贝），remote 模式下是 chat-bridge 缓存目录里下载好的副本。模式切换对 agent 完全透明。

### 2.5 模式切换是单点改造

未来从 local 升级到 remote 时只需要：
- 配置 `storage='s3'` 或 `storage='oss'` 作为新上传的默认
- 实现 s3/oss backend 的 dispatch 分支
- 旧的 `storage='local'` 行继续工作，或跑迁移把 blob 推到 s3 并改写记录

message 表、`/api/attachments/:id` 的 URL 形态、chat-bridge 工具签名、renderer 都不需要动。

---

## 3. 数据模型

### 3.1 新增 `attachments` 表

```sql
CREATE TABLE attachments (
  id                      TEXT PRIMARY KEY,                                      -- uuid v4
  channel_id              TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                                                                                -- 所属 top-level channel / dm_channel；鉴权 + 生命周期边界
  source_conversation_id  TEXT REFERENCES conversations(id) ON DELETE SET NULL,  -- 上传发生的 channel/thread；仅溯源
  filename                TEXT NOT NULL,                                         -- 原始文件名（带扩展名）
  size                    INTEGER NOT NULL,                                      -- 字节
  content_type            TEXT NOT NULL,                                         -- 'image/png' 等
  storage                 TEXT NOT NULL,                                         -- 'local' | 's3' | ...
  storage_key             TEXT NOT NULL,                                         -- 后端内部的逻辑 key；不是绝对路径
  created_by_kind         TEXT NOT NULL CHECK (created_by_kind IN ('user', 'agent')),
  created_by_id           TEXT NOT NULL,
  created_at              INTEGER NOT NULL                                       -- unix ms
);

CREATE INDEX idx_attachments_channel ON attachments(channel_id);
CREATE INDEX idx_attachments_source_conversation ON attachments(source_conversation_id);
CREATE INDEX idx_attachments_created_by ON attachments(created_by_kind, created_by_id);
```

约束：

- `channel_id` 必须指向 `conversations.kind IN ('channel', 'dm_channel')`。
- `source_conversation_id` 可以指向 `kind='channel' | 'dm_channel' | 'thread'`；如果是 thread，它的 parent channel 必须等于 `attachments.channel_id`。
- SQLite 外键不能表达 kind 约束，migration 需要加 trigger 或在 repo 层集中校验。
- **不做去重**：不建 `UNIQUE(channel_id, hash)`，也不存 `hash`。每次上传都是一条新的 attachment 记录，避免复用旧 row 时污染本次上传的 filename / source / created_by 语义。

### 3.2 `channel_id` vs `source_conversation_id` 的角色

Silverhand 的最终语义是 `workspace -> channel -> thread`。Attachment 的访问边界是 channel；thread 只是 channel 下的子讨论。

| 字段 | 角色 | 空性 | 删除行为 |
|---|---|---|---|
| `channel_id` | **鉴权边界 + 生命周期根**：top-level channel 或 DM channel | NOT NULL | channel 删 → attachment row cascade；物理 blob 由删除路径显式清理 |
| `source_conversation_id` | **溯源/审计**：文件最初在哪个 channel/thread 上传 | nullable | thread 删 → 字段置空，blob 留着 |

核心判断：

1. **图的可见性是 channel 级的**。同一个 channel 里，无论文件在 parent channel 还是某个 thread 上传，channel/thread 里的成员都应该能 `view_file` 这个 attachment。按 thread 隔离会破坏 agent 协作。
2. **thread 删除不该带走图**。thread 只是一次子讨论；如果 parent channel 或其它 thread 的消息还引用这张图，blob 不能消失。channel 才是真正的资源所有者。
3. **workspace 是上层容器，不直接做附件权限边界**。workspace 删除会 cascade 删除其 channel/thread，从而删除 attachment row；但单个 attachment 的可见性校验仍看 `channel_id`。
4. **无去重**。重复上传同一文件会产生两个 attachment id。这样实现简单，审计语义清楚，物理删除也不需要 refcount。

### 3.3 message 关联 attachment

`messages` 表加一列：

```sql
ALTER TABLE messages ADD COLUMN attachments TEXT;   -- JSON: [{id, filename, size, content_type}] | null
```

为什么不另起关联表：attachment 引用是 message 的固有面，不是平行实体。和 `tasks-design.md` §3.1 的判断一致——能用 JSON 列就别造表，避免 N+1 查询和事务复杂度。

DTO 上 `attachments` 同样是：

```ts
Array<{
  id: string;
  filename: string;
  size: number;
  content_type: string;
}>
```

这里刻意把 `size` / `content_type` snapshot 进 message：renderer 渲染图片/文件不需要再按 attachment id 做 N+1 meta 查询。因为 v1 每次上传都新建 attachment row，不存在"复用旧 row 导致 snapshot 漂移"的问题。

---

## 4. HTTP API

### 4.1 上传

Renderer / human 上传走 public channel/thread 语义：

- `POST /api/channels/:cid/attachments`
- `POST /api/threads/:tid/attachments`

为什么提供两条路由：用户的当前位置可能是 parent channel，也可能是右侧 thread pane。调用方传的是当前可见上下文 id；server 负责把它解析成：

```ts
type AttachmentScope =
  | { sourceConversationId: channelId; channelId }
  | { sourceConversationId: threadId; channelId: parentChannelId };
```

调用方不需要、也不允许额外传 `channel_id`。Thread 上传时，attachment 的生命周期/权限仍归 parent channel，`source_conversation_id` 只记录"从这个 thread 上传"。

**Request**: `multipart/form-data`，字段 `file=<blob>`。

**Handler 草图**：

```ts
async (c) => {
  const scope = resolveAttachmentScope(c); // channel route or thread route
  if (!scope) return c.notFound();

  const form = await c.req.formData();
  const file = form.get('file') as File;
  if (!file) return c.badRequest();

  // 1. 读文件；不做 hash 去重，每次上传新建 row
  const buf = Buffer.from(await file.arrayBuffer());
  const filename = sanitizeFilename(file.name);
  const contentType = inferContentType({
    explicit: file.type,
    filename,
    buffer: buf,
  });

  // 2. 落盘（local 模式）
  const id = randomUUID();
  const storage = storageBackend();           // 配置驱动
  const storageKey = await storage.put({
    id,
    filename,
    contentType,
    buffer: buf,
  });

  // 3. 入库
  attachments.insert({
    id,
    channelId: scope.channelId,
    sourceConversationId: scope.sourceConversationId,
    filename,
    size: buf.length,
    contentType,
    storage: storage.kind,                    // 'local' | 's3' | ...
    storageKey,
    createdByKind: ctx.actor.kind,
    createdById: ctx.actor.id,
    createdAt: Date.now(),
  });

  return c.json({ id, filename, size: buf.length, content_type: contentType });
}
```

**响应**: `{ id, filename, size, content_type }`。**不返回完整 URL**——renderer 用 backend base URL 拼 `${backendUrl}/api/attachments/${id}`。

**约束**:
- 单文件大小上限：先定 10MB（对齐 slock）。超出返回 `413`。
- `content_type` 推断顺序对齐 slock CLI：显式 MIME（如果调用方提供且格式合法）→ 文件头 sniff（PNG/JPEG/GIF/WebP）→ 扩展名 map → `application/octet-stream`。
- 文件名做基本清理（去路径分隔符、限长 255 字节）。

### 4.2 下载：`GET /api/attachments/:id`

```ts
async (c) => {
  const id = c.req.param('id');
  const att = attachments.findById(id);
  if (!att) return c.notFound();

  // v1 仍按当前单机 auth 模型；未来多人/remote 时校验 caller 是 att.channel_id 成员。

  const storage = storageBackendFor(att.storage);
  return storage.serve(c, att);
}
```

每个 backend 的 `serve()` 实现：

- **local**: `fs.createReadStream(storage.resolve(att.storage_key))`，配 `Content-Type: att.content_type`、`Content-Length: att.size`、`Content-Disposition: inline; filename="..."`、`Cache-Control: private, max-age=31536000, immutable`。
- **s3**: `c.redirect(await s3.getSignedUrl(att.storage_key, { expiresIn: 300 }), 302)`。或者 stream 代理，看带宽偏好。

为什么 GET 流字节而不是返回路径：renderer 是浏览器，浏览器只懂 HTTP；返回 path 在远端模式毫无意义，会强迫渲染层引入 storage 分支判断，破坏 §2.4 第 2 条。

### 4.3 内部路由（仅 local 模式）：`GET /internal/conversations/:cid/agents/:aid/attachments/:id/locate`

为 chat-bridge 在 local 模式做零拷贝优化用（详见 §5）。返回：

```json
{ "storage": "local", "localPath": "/Users/.../.silverhand/blobs/attachments/<id>.png" }
```

或在远端模式：

```json
{ "storage": "s3" }
```

remote 部署时这个 endpoint 仍然存在，但永远不返回 `localPath`，chat-bridge 自动 fallback 到 HTTP 下载路径。

scope 校验不能延期：

1. `:cid` 是 chat-bridge 当前运行的 channel/thread conversation id，由平台启动参数注入，不是 agent tool 参数。
2. `:aid` 必须是该 conversation 的成员。
3. 如果 `:cid` 是 channel，则要求 `attachment.channel_id = :cid`。
4. 如果 `:cid` 是 thread，则要求 `thread.parent_conversation_id = attachment.channel_id`。

这样内部 auth token 即使是 shared token，也不能让某个 agent 通过猜 id locate 到跨 channel 文件。

---

## 5. local 模式的特殊设计

local 模式真正能赚到的便宜在 **agent 端 `view_file`**：backend 和 agent 跑在同一台机器、同一文件系统上，agent 完全没必要走 HTTP 把 blob 拉到自己的缓存目录——直接读 backend 的存储文件即可。

### 5.1 `view_file` 的双模式实现

chat-bridge 里的 MCP 工具：

```ts
async function view_file(id: string): Promise<{ path: string }> {
  // 先问 backend：这个 attachment 在本地有吗？
  const locate = await fetch(
    `${backend}/internal/conversations/${currentConversationId}/agents/${agentId}/attachments/${id}/locate`
  )
    .then(r => r.json());

  if (locate.storage === 'local' && locate.localPath) {
    // local 模式：直接返回 backend 存储路径，零拷贝。
    // localPath 必须带扩展名，方便 agent 的 Read/视觉工具识别文件类型。
    return { path: locate.localPath };
  }

  // remote 模式或非 local：HTTP 下载到 agent 本地缓存。
  // 优先使用 SILVERHAND_DIR，保证 remote-only smoke app 与用户默认数据隔离。
  const cacheDir = process.env.SILVERHAND_DIR
    ? path.join(process.env.SILVERHAND_DIR, 'attachments-cache')
    : path.join(os.homedir(), '.silverhand', 'attachments-cache');
  await fs.mkdir(cacheDir, { recursive: true });

  const meta = await fetchAttachmentMeta(id); // 至少拿 filename + content_type
  const ext = extensionFromFilename(meta.filename) || extensionForContentType(meta.content_type);
  const cached = path.join(cacheDir, `${id}${ext || '.bin'}`);
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

跳过 `/internal/locate` 让 chat-bridge 自己拼 `~/.silverhand/blobs/attachments/<id>` 看起来更简单——但这违反了 §2.4 第 1 条（DB 不存路径意味着外界也不该假设路径）。如果未来 backend 把存储目录改成 `~/.silverhand/blob/`、加了分片子目录，或者切到 s3/oss，chat-bridge 不通过 backend 询问就会失效。

让 backend 来决定"这个 id 在本地能不能直接读、路径是什么"，存储布局是 backend 的内部细节。

### 5.3 文件命名

返回给 agent 的路径必须带扩展名：`~/.silverhand/blobs/attachments/<id>.<ext>` 或 `${SILVERHAND_DIR:-~/.silverhand}/attachments-cache/<id>.<ext>`。

原因：agent 往往通过 `Read` / 视觉工具直接读取本地路径，带扩展名能减少工具侧类型猜测失败。扩展名从原始 `filename` 优先推导，其次从 `content_type` 推导，最后兜底 `.bin`。

注意：这不违反 §2.4 第 1 条。DB 仍然只存 `storage_key`，不存绝对路径；`storage_key` 可以选择带扩展名，但它仍是 storage backend 的内部逻辑 key。`Content-Disposition: filename="..."` 继续使用 DB 里的原始 `filename`，浏览器/客户端下载时看到用户可读文件名。

---

## 6. chat-bridge MCP 工具

照搬 slock 的三件套接口，schema 几乎一样：

### 6.1 `upload_file`

```ts
upload_file({
  file_path: string,    // agent 本地的绝对路径
})
→ { id: string, filename: string, size: number, content_type: string }
```

实现：读盘 → multipart POST 到当前 channel/thread scoped endpoint → 返回 `{id, filename, size, content_type}`。

为什么这个工具存在：Claude Code / Codex 这类 coding agent 可以通过文本写入工具生成文本文件，也可以通过 shell/脚本/外部工具间接产出二进制文件（例如 Playwright 截图、Chrome print-to-PDF、ImageMagick/Pillow/matplotlib 生成图片、reportlab/pandoc 生成 PDF、zip/ffmpeg 等 CLI 产物）。它们不能把二进制直接塞进聊天 stdout，所以 `upload_file(file_path)` 是 agent 把"本地已存在文件"转成 message attachment id 的出口。Human composer 上传不走这个 MCP 工具，直接由 renderer 调 public upload API。

关键约束：

- agent **不能**传 `channel` / `channel_id` / `thread_id`。chat-bridge 启动时已经知道当前 `conversation_id` 和 kind，backend 根据这个上下文推导 attachment 的 parent channel。
- agent 上传前做本地校验：路径必须存在、必须是 regular file、单文件不超过 10MB。
- MIME 推断用 §4.1 的顺序，优先 sniff 图片文件头。

### 6.2 `view_file`

见 §5.1。返回 `{ path: string }`，agent 拿到本地可读路径。

### 6.3 `send_message` 扩展

现有 `mcp__chat__send_message` 扩展为：

```ts
send_message({
  content: string,
  target?: 'self' | 'parent' | { thread_id: string }, // 保持现有 channel/thread 拓扑目标模型
  attachment_ids?: string[],     // 来自 upload_file
})
```

**不新增 `channel` 字段**。附件只是 message 的扩展面，不能改变现有 MCP 的会话边界模型。agent 要发到当前 channel/thread、parent、或自己打开的 direct child thread，仍然只能用现有 `target` 规则。

**绝不接受 `base64` 字段**——agent 必须先 upload 拿 id，再 send_message 带 id。这把上传和发消息两件事解耦，方便重试、限流、鉴权各自演化。

backend 端 agent send-message 内部路由接收 `attachmentIds: string[]`，写入 message 行的 `attachments` 列时先反查并校验：

- attachment 必须属于目标 message 所在的 parent channel。
- 当前 sender agent 必须是当前 channel/thread member。
- message snapshot 写 `[{ id, filename, size, content_type }]`。

---

## 7. 消息投递：让 agent 看到附件

**stream-json 的 content array 不要塞 image block**——直接在文本里追加附件提示，让 agent 自行决定是否调 `view_file`。

格式对齐 slock `formatIncomingMessage`：

```
@alice: 看下这个报错
[2 attachments: error.png (id:a1b2c3d4), trace.log (id:e5f6g7h8) — use view_file to download]
```

这样：

- `encodeStdinMessage()` / driver 的 `parseLine()` 完全不动
- agent 看到 filename + id，自己决定要不要看（节省 token：1MB 图不会被强行塞进上下文）
- thread 转发零成本——只复制 attachment id 字符串，不搬 blob

必须做一个共享 helper：

```ts
function formatAttachmentSuffix(attachments?: MessageAttachmentSnapshot[]): string {
  if (!attachments?.length) return '';
  return ` [${attachments.length} attachment${attachments.length > 1 ? 's' : ''}: ${
    attachments.map(a => `${a.filename} (id:${a.id})`).join(', ')
  } — use view_file to download]`;
}
```

所有 agent 可见的消息格式化路径都调用同一个 helper：

- `formatLiveMessage()`：agent 在线时的新消息实时投递
- `combineGatedBatch()`：Claude busy/gated safe-boundary 批量投递
- `formatInboxBatch()`：agent 离线后下次 spawn 的 inbox drain
- history/read/check 类工具输出：agent 主动读历史也要看到附件提示

driver platform-prompt（`packages/backend/src/drivers/platform-prompt.ts`）需要补一句：附件以 `[N attachments: filename (id:xxx) — use view_file to download]` 形式出现在消息里，要看内容用 `view_file(attachment_id)`，要发文件用 `upload_file(file_path)` + `send_message(attachment_ids=[...])`。

---

## 8. renderer

### 8.1 message 渲染

`MessageItem.tsx` 检测 `message.attachments` 非空时，在 markdown 区域下方渲染附件区：

- 图片类（`content_type` 以 `image/` 开头）：渲染成 `<img src={attachmentUrl(id)} />` 缩略图，点击放大
- 其他文件：渲染成下载链接 `<a href={attachmentUrl(id)} download="{filename}">{filename} ({size})</a>`

`attachmentUrl(id)` 必须用 renderer 当前拿到的 backend base URL 生成绝对地址：

```ts
const attachmentUrl = (id: string) => `${backendUrl}/api/attachments/${id}`;
```

不要写相对 `/api/attachments/${id}`；Electron / Vite origin 下它可能打不到 backend。

如果后端下载接口只接受 bearer header，`<img>` / `<a>` 不能直接附 header。v1 要么让 backend 对本地 authenticated renderer origin 放行附件 GET，要么提供 tokenized/signed URL helper；否则 renderer 应该先 `fetch` blob 再创建 object URL。不要把一个 header-dependent URL 直接塞进 `<img>`。

`content_type` / `size` 已在 message DTO snapshot 里，不再需要 `GET /api/attachments/:id/meta`。

### 8.2 composer 上传

`Composer.tsx` 加文件按钮 + 拖拽区：

1. 选/拖入文件 → 在当前 view 上下文里立刻上传：
   - parent channel：`POST /api/channels/:cid/attachments`
   - thread pane：`POST /api/threads/:tid/attachments`
   拿到 `{id, filename, size, content_type}` 后，在 composer 显示 chip 预览。
2. 用户继续打字，可以删 chip
3. 点 Send → 当前 `POST /api/channels/:cid/messages` 或 `POST /api/threads/:tid/messages` body 加 `attachment_ids: string[]`
4. backend 在写 message 时把 ids 解析成 `[{id, filename, size, content_type}]` 存进 `attachments` 列

**先传后发**的好处：上传是慢操作，发消息是快操作，分开后用户感知到的"发送延迟"只是发消息那一下；图传到一半可以取消而不留下空消息。

---

## 9. 物理文件生命周期

DB cascade 只会删 row，不会自动删磁盘文件。v1 无去重，所以物理清理可以保持简单：

- 每个 attachment row 对应一个 `storage_key`，无 refcount。
- channel 删除 / workspace 删除时，先列出受影响 channel 的 attachments，按 storage backend 删除对应 `storage_key`，再提交 DB 删除；或者在事务提交后用 best-effort cleanup job 清理已记录的 keys。关键是不能只依赖 `ON DELETE CASCADE`。
- thread 删除不删 blob，只会让 `source_conversation_id` 置空；blob 仍归 parent channel。
- 单条 message 删除默认不删 blob，避免破坏其它消息引用和审计语义。未来如果要支持"删除未发送的 composer 上传"，单独做 orphan cleanup。
- `${SILVERHAND_DIR:-~/.silverhand}/attachments-cache/` 是 agent 读文件缓存，不跟随 channel delete 立即清理；后续按 LRU / 大小上限做 Phase 4 管理。

---

## 10. Avatar / Profile Asset 扩展

Avatar 应该复用 §2 的 blob/file storage infra，但不要复用 `attachments` 表。

原因：

- `attachments.channel_id` 是 message attachment 的权限与生命周期边界；avatar 属于 user/agent profile，不属于任何 channel。
- channel delete 会清理该 channel 的 attachments；avatar 生命周期应该跟 user/agent 绑定。
- message attachment 的 `source_conversation_id` 是聊天溯源；avatar 不需要这个语义。

后续做 avatar 时推荐新增 profile application 层：

```text
blob/file storage infra
  ├── local: ~/.silverhand/blobs/...
  └── remote: s3/oss/...

message attachment application
  └── attachments(channel_id, source_conversation_id, storage, storage_key, ...)

profile asset application
  ├── users.avatar_storage_key / users.avatar_content_type
  └── agents.avatar_storage_key / agents.avatar_content_type
```

如果 avatar 需要历史版本、审计、裁剪参数，再单独做 `profile_assets` 表；不要为了复用而把 profile image 塞进 channel-scoped `attachments`。

---

## 11. 与 slock 的对比

参考实现来自 `@slock-ai/daemon` v0.44.2（位于 `/Users/shiki/.npm/_npx/277f35d2ed0078b9/node_modules/@slock-ai/daemon/`）。

| 维度 | slock | silverhand |
|------|-------|-----------|
| **资源归属** | channel 级（一个 channel 一组 attachment） | **channel + source conversation 双标签**（channel 鉴权/生命周期，channel/thread 溯源） |
| **去重 scope** | npx daemon/CLI 侧没有表现出复用已有 attachment 的语义 | **不去重**；每次上传新建 attachment row |
| **storage 抽象** | server-side（具体后端不可见） | **dispatch 层，storage 字段驱动**（local/remote 同构） |
| **上传 endpoint** | `POST /internal/agent/{aid}/upload`，agent 传 `channel` target | `POST /api/channels/:cid/attachments` / `POST /api/threads/:tid/attachments`；agent 不传 channel |
| **下载 endpoint** | `GET /api/attachments/{id}` | `GET /api/attachments/:id`（一致） |
| **agent 缓存** | `~/.slock/attachments/{id}.{ext}`（带扩展名） | local: 零拷贝读 backend 存储；remote/cache: `${SILVERHAND_DIR:-~/.silverhand}/attachments-cache/{id}.{ext}`（带扩展名） |
| **MCP 工具** | `upload_file(file_path, channel)` / `view_file` / `send_message(attachment_ids)` | `upload_file(file_path)` / `view_file` / `send_message(attachment_ids)`；不让 agent 传 channel |
| **stream-json 走法** | 文本注入，附件以 `[id:xxx — use view_file]` 提示 | **同上**（不污染 stream-json） |
| **大小上限** | 10MB | 10MB |

最大的差异在三点：

1. **Silverhand 有 Thread**——slock 没有我们的 `workspace -> channel -> thread` 层次。Silverhand 把鉴权/生命周期放在 parent channel，把上传来源记录为 `source_conversation_id`。
2. **local 模式的 view_file 零拷贝优化**——slock 因为 daemon 和 backend 物理分离（daemon 在用户机、backend 在云上），永远走 HTTP。silverhand v1 单机部署能跳过这层 HTTP，agent 直接读 backend 存储路径。
3. **不让 agent 传 channel**——slock 的 `upload_file` 需要 `channel` 参数；Silverhand chat-bridge 已经绑定当前 channel/thread 上下文，所以 channel 由 backend 从当前 conversation 推导，避免跨 channel 上传。

补充：npx 包能确认的是 daemon/CLI/chat-bridge 行为，不包含完整 server DB schema。因此"未观察到 slock 去重"只说明客户端语义上不依赖复用；Silverhand v1 明确选择不去重。

---

## 12. 落地分阶段

### Phase 1: local mode v1（最小可用）— ✅ 2026-05-06 落地

1. ✅ 新增 `attachments` 表 + migration
2. ✅ `messages.attachments` 列 + DTO 字段
3. ✅ local blob storage backend（`~/.silverhand/blobs/`）
4. ✅ `POST /api/channels/:cid/attachments` / `POST /api/threads/:tid/attachments`（multipart）
5. ✅ `GET /api/attachments/:id`（stream）
6. ✅ `MessageItem.tsx` 渲染图片 / 文件附件 + 点击居中 modal 预览
7. ✅ `Composer.tsx` 上传 UI（按钮 + 拖拽 + Cmd+V 粘贴 + 缩略图 chip）
8. ✅ channel/thread message send API 和 `useSendMessage` hook 接受 `attachment_ids`
9. ✅ workspace delete / agent delete 路径显式清理 attachment physical blobs（`AttachmentService.sweepForChannel`）

### Phase 2: agent 互通 — ✅ 2026-05-06 落地

10. ✅ chat-bridge 加 `upload_file` / `view_file` 工具
11. ✅ chat-bridge `send_message` 扩展 `attachment_ids` 参数
12. ✅ backend agent send-message 内部路由接 `attachmentIds` + membership 校验
13. ✅ `formatLiveMessage()` / `formatInboxBatch()` 共用 `formatAttachmentSuffix()`
14. ✅ `GET /internal/conversations/:cid/agents/:aid/attachments/:id/locate`（local 模式零拷贝，带 scope 校验）
15. ✅ driver platform-prompt 补附件用法说明

### Phase 3: 远端后端落地（未来）

16. s3/oss storage backend dispatch
17. 配置项：默认 storage、s3 bucket / region / 凭证
18. `GET /api/attachments/:id` remote/multi-user 鉴权中间件（caller 必须是 attachment parent channel 成员）
19. chat-bridge `view_file` 缓存目录策略（清理、上限）
20. 旧 local 数据迁移脚本（可选；通常 grandfather 即可）

### Phase 4: 优化（按需）

- 缩略图预生成（`?variant=thumb`）
- 大文件断点续传（multipart upload）
- 跨 channel 引用策略（如果产品有需求）
- 配额管理（per-user / per-channel）
- 病毒扫描（remote 模式）

---

## 13. Phase 1+2 落地后的已知 gap（待排）

落地阶段刻意收口、留给后续的工作（不影响 v1 单机 happy path）：

- **`GET /api/attachments/:id` 缺 channel membership 鉴权**——目前任何登录用户拿到 id 即可读。单机自用语义可接受；多人/远端模式必须补上（属于 Phase 3 第 18 项的前置）。设计讨论在独立频道进行。

> 已在 2026-05-06 后续补上：
> - `DELETE /api/attachments/:id`（orphan-only：被任何 message snapshot 引用就 409；非自己上传 403；已删 404；blob best-effort sweep）。
> - Composer unmount / removePending(state='done') 调 `deleteAttachmentBestEffort` + `releaseAttachmentPreview`，把上传成功但未发送的孤儿物理清掉，cache URL 也释放。
>
> Avatar / profile asset 的 storage 复用见 §10，独立主题，不算 attachment gap。

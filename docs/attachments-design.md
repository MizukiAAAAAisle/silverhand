# Silverhand — Attachments 设计

> 与 [`core-design.md`](./core-design.md) 的消息流水对齐——本 doc 在 message 旁边新增 attachment 资源，message DTO 增加 `attachments` 引用字段。UI 排版仍走 [`app-layout.md`](./app-layout.md) / [`design-new-theme.md`](./design-new-theme.md)。
>
> 附件字节的可见性/预览边界(含未加入 public 频道的 non-member 访问)由 [`channel-visibility-v1.md`](./channel-visibility-v1.md) §2.2 唯一拥有——本 doc 不定义、不复制该 ACL 逻辑。

---

## 1. 为什么做

silverhand 的 message 原本是纯文本管道，driver 只解析 text/thinking/tool_use 三种 block，composer 也只能发字符串。要让 agent 之间、agent 与 human 之间能传图（截图、设计稿、报错截屏），需要新增一类资源：**attachment**。

命名刻意用 `attachment` 而不是 `image`：同一套机制覆盖任何二进制文件（图片是首要场景，PDF / 日志 / 任意上传是顺带），所以表名、API、tool 命名都用 `attachment`。

设计目标按优先级：

1. **local 单机现在能用**——backend 跑在 Electron 主进程里，blob 落本地，零外部依赖。
2. **schema / API 同构于未来的 remote 部署**——切换到对象存储后端时，message 表、chat-bridge 工具、渲染端代码零改动。
3. **stream-json 不被污染**——绝不把 base64 塞进 agent 的 stdin/stdout。字节通过独立 HTTP 通道流转，message 里只携带 **id 引用**。

---

## 2. 核心设计原则：storage infra 与应用层分离

整个设计的关键判断是**把 blob/file storage 后端隔离到一个 infra dispatch 层背后**。message attachment、未来 avatar、未来 workspace icon / export file 都只是它上面的不同 application。

### 2.1 抽象边界

三层自上而下：

```
调用方（renderer / chat-bridge / agent）
  只认识上层应用 id 与 HTTP routes
        │
Application 层
  message attachment / avatar / workspace icon / ...
  负责业务归属、鉴权、生命周期、DTO snapshot
        │
Blob/File Storage infra
  put / serve / locate / delete，按 storage backend dispatch
        │
  ├── local backend：fs read/write
  └── s3 / oss backend：putObject / sign
```

### 2.2 分层命名（ubiquitous language）

这是本 doc 最核心的边界，三个名字不能混用：

- **Blob/File Storage infra**：底层能力，负责二进制文件的 `put / get / serve / locate / delete`。本地可以落到用户数据目录下的 blobs，远端可以对接 s3 / oss。**它不懂 message、channel、avatar**，只按 key 操作字节。
- **Attachment system**：message application。`attachments` 表、message snapshot、`upload_file` / `view_file`、channel 权限都属于这一层。
- **Avatar system（future）**：profile application。user / agent avatar 可以复用同一个 storage infra，但**不应该塞进 `attachments` 表**——avatar 不属于 channel，没有 message 溯源，也不跟 channel 生命周期绑定（详见 §6）。

### 2.3 Blob/File Storage infra contract

v1 先把 storage 做成 backend 内部 service / interface，不要求先建一张全局 `blobs` 表。每个 application 表保存自己的 `storage` + `storage_key` 引用；storage infra 只负责按 key 操作字节。

规则：

- infra **不做** channel/user/agent 鉴权；调用它之前由 application 层完成权限判断。
- infra **不懂** 各 application 的生命周期；application 删除业务 row 时调用 `delete()`。
- v1 **不需要**全局 blob 去重或 refcount。后续如果要配额、全局 GC、跨 application 复用，再新增全局对象表；不要把这些复杂度塞进 message attachment v1。

### 2.4 三条不可破的规则

1. **DB 不存绝对路径，不存完整 URL**。只存 `storage`（枚举）+ `storage_key`（后端内部的逻辑 key）。最终由 storage infra 把 key 映射成物理位置——**存储布局是 backend 内部细节，外界不得假设路径**。
2. **renderer 永远走 HTTP**。图片 / 下载链接必须由 renderer 的 backend base URL 拼成绝对 HTTP URL，绝不引入 `file://` 分支，也不要写相对 `/api/...`。理由：Electron renderer 可能跑在 Vite / file origin 下，相对 `/api` 不一定指向 backend；远端部署时 renderer 也不在 backend 同机，path 给它没意义。
3. **chat-bridge 接口在两种模式下完全相同**。`view_file(id) → { path }` 永远返回一个 agent 可读的本地路径。local 模式下这个路径是 backend 的存储路径（零拷贝），remote 模式下是 chat-bridge 缓存目录里下载好的副本。**模式切换对 agent 完全透明**。

### 2.5 模式切换是单点改造

未来从 local 升级到 remote 时只需要：

- 配置默认 storage 为 `s3` / `oss` 作为新上传的默认；
- 实现对应 backend 的 dispatch 分支；
- 旧的 `storage='local'` 行继续工作，或跑迁移把 blob 推到远端并改写记录。

message 表、下载 URL 形态、chat-bridge 工具签名、renderer 都不需要动。

---

## 3. 数据模型

### 3.1 `attachments` 表与 message 关联

新增 `attachments` 表保存每次上传的元数据 + `storage` / `storage_key` 引用。**不做去重**：不建 `UNIQUE(channel_id, hash)`，也不存 `hash`；每次上传都是一条新的 attachment 记录，避免复用旧 row 时污染本次上传的 filename / source / created_by 语义。

`id` 与 `storage_key` 天然解耦：`id` 是稳定 handle（`attachments.id`），`storage_key` 是纯物理指针（`attachments/{channelId}/{blobId}{ext}`）。内容可被 creator **原地更新**（见 §4.3），更新只重指 `storage_key` 并 bump `content_revision`，`id` 不变——所以引用同一 id 的一切（reviewer 解析出的本地路径、renderer 的 blob 缓存）在多轮迭代间保持稳定。`content_revision` 是每 attachment 单调递增的新鲜度 / cache-bust token（DEFAULT 1），既不是版本号（不存历史、不可回滚）也不是 HTTP validator（下载 `no-store`）。

message 侧不另起关联表——attachment 引用是 message 的固有面，不是平行实体，用一列 JSON snapshot（`[{id, filename, size, content_type}]`）承载即可，避免 N+1 查询和事务复杂度（与 `tasks-design.md` 的判断一致）。刻意把 `size` / `content_type` snapshot 进 message，让 renderer 渲染时不用再按 id 做 meta 查询。`filename` / `content_type` 在更新时**锁定**（见 §4.3），永不偏离 snapshot；`size` 会随内容更新而变，所以 snapshot 的 `size` 是一个时间点快照，可能滞后于 row 当前字节——这是刻意的：snapshot 是历史捕获，DTO 是活 row。snapshot **不携带** `content_revision`（它不是当前新鲜度的权威；renderer 通过 DTO + `attachment_changed` 事件解析最新态）。

### 3.2 `channel_id` vs `source_conversation_id` 的角色

Silverhand 的层次是 `workspace → channel`；reply（回复）是同一个 parent channel 里的普通 message，通过 `messages.thread_root_id` 锚到 root message 组成一个 reply-cluster，不再是独立会话。Attachment 的访问边界始终是 **channel-like conversation（`channel` / `dm_channel`）**；reply-cluster 里的上传落到承载该 cluster 的同一个 top-level channel。两个引用字段分工如下：

| 字段 | 角色 | 空性 | 删除行为 |
|---|---|---|---|
| `channel_id` | **鉴权边界 + 生命周期根**：top-level channel 或 DM channel | NOT NULL | channel 删 → attachment row cascade；物理 blob 由删除路径显式清理 |
| `source_conversation_id` | **溯源 / 审计**：文件最初在哪个 channel-like conversation 上传 | nullable | 随 channel 一并 cascade；无独立的子会话删除路径 |

核心判断（invariant）：

1. **图的可见性是 channel 级的**。同一个 channel 里，无论文件由 root message 还是某条 reply 上传，channel 成员都应该能 `view_file` 这个 attachment。reply-cluster 与其 parent channel 共享同一个 `channel_id`，天然满足这一点。
2. **channel 才是资源所有者**。reply 只是同一 channel 里的普通消息，不构成独立生命周期；attachment 的存亡跟着 `channel_id` 走，不会因某条 reply 被删而消失。
3. **workspace 是上层容器，不直接做附件权限边界**。workspace 删除会 cascade 删除其 channel，从而删除 attachment row；但单个 attachment 的可见性校验仍看 `channel_id`。
4. **无去重**。重复上传同一文件会产生两个 attachment id。实现简单，审计语义清楚，物理删除也不需要 refcount。

约束落地要点：`channel_id` 与 `source_conversation_id` 都必须指向 `kind IN ('channel', 'dm_channel')`——`AttachmentService.resolveChannelId()` 只接受 channel-like conversation（`isChannelLikeKind`），reply-cluster 上传因此直接解析成承载 cluster 的那个 top-level channel。SQLite 外键不能表达 kind 约束，需在 repo / service 层集中校验。（历史上可能残留 `kind='thread'` 的子会话 fossil 行，属只读遗留，新上传不再产生。）

---

## 4. 传输契约

附件字节的可见性 / 预览边界（含未加入 public 频道的 non-member 访问）由 [`channel-visibility-v1.md`](./channel-visibility-v1.md) §2.2 唯一拥有。本节只定义与附件形态相关的、code 无法自解释的规则。

### 4.1 上传与下载

- **上传按 public channel 语义**：调用方传的是当前可见上下文 id（channel-like conversation），server 据此确定 `channelId` + `sourceConversationId`。**调用方不需要、也不允许额外传 `channel_id`**；reply-cluster 上传与其 parent channel 共享 `channel_id`，生命周期/权限归该 channel，`source_conversation_id` 只记录来源。
- **上传响应不返回完整 URL**——renderer 用 backend base URL 自行拼绝对地址（§2.4 规则 2）。
- **单文件上限 10MB**，超出返回 413。
- **content-type 推断顺序**：显式合法 MIME → 文件头 sniff（PNG/JPEG/GIF/WebP）→ 扩展名 map → `application/octet-stream`。文件名做基本清理（去路径分隔符、限长）。
- **下载走 HTTP 流字节**，绝不返回路径：renderer 是浏览器只懂 HTTP；返回 path 在远端模式毫无意义，会强迫渲染层引入 storage 分支判断，破坏 §2.4 规则 2。local 直接 stream 文件，s3 可签名 URL 重定向或代理。

### 4.2 内部 locate（仅 local 模式的零拷贝优化）

chat-bridge 在 local 模式下需要一个"这个 id 在本地能不能直接读、路径是什么"的问答通道。契约要点：

- **bridge 通过 backend 询问，永不自己假设路径**（§2.4 规则 1 / §5.2）。remote 模式下该通道仍存在但永不返回本地路径，bridge 自动 fallback 到 HTTP 下载。
- scope 校验不能延期，且不能靠 shared token 猜 id 跨界：当前 conversation id 由平台启动参数注入（不是 agent tool 参数）；agent 必须是该 conversation 成员；channel 上下文要求 `attachment.channel_id` 等于当前 channel-like conversation。
- **返回稳定别名路径，而非物理路径**。物理 key 每次内容更新都会变（§4.3 pointer-swap 落新 blob key），但 embedded CLI 把路径交给了期望它不变的 viewer——所以 local locate 返回一个以稳定 `attachment.id` 为 basename 的**别名**（`attachments/{channelId}/{attachmentId}{ext}`，相对 symlink 指向当前物理 blob），保证 reviewer 的本地地址跨迭代不变。别名是 DB 指针的**派生缓存**：首次 locate 惰性建、更新时立即重指、locate/启动时自愈；它的非事务重指是可恢复的 cache miss，绝不构成权威 split-brain。`serve()`（HTTP 下载）走物理 `storage_key`，不碰别名。用 symlink 而非 hardlink：symlink 不占物理 inode，物理 key 一删字节立即释放，channel/workspace 删除的字节回收对别名零感知（残留的悬空 symlink 无害）。

### 4.3 内容更新（creator-only，原地 pointer-swap）

agent 迭代同一件产物（如反复修改的 mockup）时，重新上传会产生新 id → reviewer 的本地地址每轮都变。内容更新让 id 稳定：`silverhand file update`（human 侧 `PATCH /api/attachments/:id`）**原地替换字节**，`id` / `filename` / `content_type` 不变，只有内容与 `content_revision` 变。**无版本化**：旧字节被 GC，不保留历史（`content_revision` 只是新鲜度 token，不是可回滚的版本轴）。

**权限**：creator-only 的 MEMBER mutation——与 delete 同一条规则（频道成员 + 原始 creator 归属，human/agent 同构），二者仅在 `in_use` 轴分岔：delete 拒绝被引用的 attachment，update **允许**（更新被引用 blob 的字节正是本功能的目的）。所以 `canUpdateAttachment` 与 `canDeleteAttachment` 共享同一谓词 `canMutateOwnAttachment`。agent 侧复用 `upload_attachments` capability（更新是同类写，不新增 capability 枚举），并要求 attachment 属于 caller 当前 channel（service 层 `requireCallerChannelOf` 守卫，跨 channel 折叠成 `not_found` 不泄露存在性）。

**pointer-swap 协议（正确性强制，不可退化为单文件原地 rename）**：

1. 新字节写到一个**全新 blob key**（fresh `blobId`）。该 key 未被任何 row 引用 ⇒ 对所有 reader 不可见，直到第 2 步。
2. 一条原子 DB `UPDATE` 重指 `storage_key` + `size` 并 `content_revision++`——这是**唯一的可见性开关**。commit 前崩溃：新 blob 是无引用 orphan，row 仍指旧字节（绝不发生"失败的写却已生效"）；commit 后崩溃：row 干净地落在新字节。
3. 立即重指别名（§4.2），让已打开的零拷贝 viewer 重新加载即见新字节。best-effort，locate/启动自愈兜底崩溃。
4. GC 旧物理 blob，**在别名指向新字节之后**。best-effort：失败只泄露一个 orphan blob，绝不损坏状态。

为什么不能单文件原地 rename-first：rename 会让字节突变在 rename 那一刻就**持久可见**——早于本应 gate 它的 DB commit。一次失败/崩溃的更新会永久改写内容却无记录、无事件 = 一次失败操作留下权威可见的持久副作用（retry 不是恢复协议）。pointer-swap 把可见性 gate 在 DB commit，从根上消解。

**新鲜度排除（freshness exclusion）**：内容更新**绝不能**推进 message seq / stream head / read cursor——它不是一条新消息，不该把频道标记为未读或触发投递。commit + 别名重指后，在**频道 side channel**（`conversation-side:{channelId}`，cursor-inert、自愈、不写 markSatisfied floor）发一条 `attachment_changed` 事件做 cache-bust。payload 只说"什么变新了"（`{attachment_id, content_revision}`），不搬字节；renderer 据此把该 id 的 blob generation 提升并重取权威 DTO/字节。事件是 bust 信号，不是数据载体。

---

## 5. agent 侧：chat-bridge 工具与消息投递

### 5.1 三件套工具

chat-bridge 暴露 `upload_file(file_path)` / `view_file(id)` / `send_message(..., attachment_ids)`：

- **`upload_file`** 是 agent 把"本地已存在文件"转成 attachment id 的出口。coding agent 能通过 shell / 脚本 / 外部工具间接产出二进制文件（Playwright 截图、print-to-PDF、matplotlib / Pillow 生图、pandoc / zip / ffmpeg 产物等），但不能把二进制塞进聊天 stdout。human composer 上传不走这个 MCP 工具，直接由 renderer 调 public upload API。
- **`view_file`** 返回 `{ path }`（见 §2.4 规则 3，双模式对 agent 透明）。返回路径必须带扩展名（从原始 filename 优先推导，其次 content-type，兜底 `.bin`），减少 agent 用 Read / 视觉工具时的类型猜测失败。这不违反 §2.4 规则 1——DB 仍只存 `storage_key`。返回的是稳定别名路径（§4.2），跨内容更新不变。
- **`update_file(id, file_path)`** 原地替换 creator 自己上传的 attachment 的字节（§4.3），保持 id / filename / content_type 不变——agent 迭代产物时用它而不是重新 upload，reviewer 的 `view_file` 路径跨轮次稳定。
- **`send_message` 扩展 `attachment_ids`**，但**不新增 `channel` 字段**。附件只是 message 的扩展面，不改变现有 MCP 的会话边界模型；agent 发到当前 channel 或以某条消息为 root 的 reply-cluster 仍只走现有 `target` 规则。

关键约束：

- agent **不能**传 `channel` / `channel_id`。chat-bridge 启动时已绑定当前 conversation id + kind，backend 据此确定 channel-like 边界，杜绝跨 channel 上传。
- **绝不接受 `base64` 字段**——agent 必须先 upload 拿 id，再 send_message 带 id。这把上传和发消息解耦，方便重试、限流、鉴权各自演化。
- backend 写入 message 前反查校验：attachment 必须属于目标 message 的 channel，sender 必须是当前 channel member。

### 5.2 为什么 bridge 不直接读 fs

跳过 locate 让 bridge 自己拼存储路径看似更简单，但违反 §2.4 规则 1：DB 不存路径，意味着外界也不该假设路径。一旦 backend 改存储目录、加分片子目录、或切到 s3/oss，硬编码路径就失效。让 backend 决定可读性与路径，存储布局始终是 backend 内部细节。

### 5.3 消息投递：让 agent 看到附件

**stream-json 的 content array 不塞 image block**——只在文本里追加一段附件后缀，列出 filename + id，让 agent 自行决定是否调 `view_file`。形如：

```
@alice: 看下这个报错
[2 attachments: error.png (id:a1b2c3d4), trace.log (id:e5f6g7h8) — use view_file to download]
```

好处：driver 的 encode / parse 完全不动；agent 自己决定要不要看（1MB 图不会被强行塞进上下文，省 token）；转发/引用零成本——只复制 id 字符串，不搬 blob。

所有 agent 可见的消息格式化路径（在线实时投递、gated 批量投递、离线 inbox drain、history/read/check 工具输出）必须共用同一个格式化 helper，保证附件后缀一致。

platform-prompt（`packages/shared/src/platform-prompt.ts`）需说明：附件以 `[N attachments: filename (id:xxx) — use view_file to download]` 形式出现，看内容用 `view_file(id)`，发文件用 `upload_file(file_path)` + `send_message(attachment_ids=[...])`。

---

## 6. renderer 侧契约

- message 渲染：`image/*` 渲染成缩略图（点击放大），其它文件渲染成下载链接；`content_type` / `size` 已在 DTO snapshot 里，无需额外 meta 请求。
- 所有附件 URL 必须用 renderer 当前的 backend base URL 拼成**绝对地址**，不写相对 `/api`（§2.4 规则 2）。若下载接口只认 bearer header，`<img>` / `<a>` 无法附 header——需 backend 对本地 authenticated renderer origin 放行、或提供 tokenized/signed URL、或 renderer 先 fetch blob 再建 object URL；不要把 header-dependent URL 直接塞进 `<img>`。
- composer **先传后发**：选/拖/粘贴文件后立刻上传拿到 id 显示 chip 预览，Send 时消息 body 带 `attachment_ids`。理由：上传是慢操作、发消息是快操作，解耦后用户感知到的"发送延迟"只是发消息那一下；图传到一半可取消而不留空消息。

---

## 7. 物理文件生命周期

DB cascade 只删 row，不会自动删磁盘文件。v1 无去重，物理清理保持简单：

- 每个 attachment row 对应一个 `storage_key`，无 refcount。
- **内容更新**（§4.3）重指 `storage_key` 到新 blob 后，best-effort GC 旧 blob——同一 id 在任一时刻只留一份物理字节，旧字节不累积。崩溃只会泄露一个无引用 orphan（下次 channel/workspace 删除时随扫）。
- **channel 删除 / workspace 删除**时，先列出受影响 channel 的 attachments，按 storage backend 删除对应 key，再提交 DB 删除（或事务后 best-effort cleanup job 清理已记录 keys）。**关键是不能只依赖 `ON DELETE CASCADE`**——它删 row 不删 blob。别名是 symlink（§4.2），不占物理 inode，所以删物理 key 即释放字节；残留的悬空别名 symlink 无害（orphan 删除路径会顺带清理单个别名）。
- **单条 message 删除默认不删 blob**，避免破坏其它消息引用和审计语义。reply 只是同一 channel 里的普通消息，删除单条 reply 不触及 blob。未来若要支持"删除未发送的 composer 上传"，单独做 orphan cleanup。
- agent 读文件的本地缓存目录不跟随 channel delete 立即清理，后续按 LRU / 大小上限管理。

---

## 8. Avatar / Profile Asset 边界（non-goal）

Avatar 应该**复用 §2 的 blob/file storage infra，但绝不复用 `attachments` 表**。原因：

- `attachments.channel_id` 是 message attachment 的权限与生命周期边界；avatar 属于 user / agent profile，不属于任何 channel。
- channel delete 会清理该 channel 的 attachments；avatar 生命周期应该跟 user / agent 绑定。
- `source_conversation_id` 是聊天溯源；avatar 不需要这个语义。

后续做 avatar 时推荐新增独立的 profile asset application 层（例如把 avatar 的 storage 引用挂在 user / agent 记录上，或在需要历史版本 / 审计 / 裁剪参数时单独建 `profile_assets` 表）——不要为了复用而把 profile image 塞进 channel-scoped `attachments`。

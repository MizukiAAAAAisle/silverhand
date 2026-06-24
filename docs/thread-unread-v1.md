# Thread Unread — per-stream read cursor (v1)

Status: **implemented (backend), in_review**（#task:1226；shiki go 2026-06-25；Cindy spec review PASS 三轮）。Owner: backend=Alice / UI=Norman / review=Cindy。
本 doc 是 #1226 的 canonical 规范；与代码冲突时以本 doc 为准直至代码修正。**Activity/Inbox 是独立后续(`notes`/单独 task),不在本 doc 范围**——本 doc 只交付 per-stream read cursor 底座 + thread 未读三表面。

## 1. 问题

Thread(reply-cluster)的未读不可发现。今天已读边界 `conversation_reads.last_read_seq` 是 **per-conversation**(主线 + 该 conversation 下所有 thread 共用一个游标),无法表达「某条 thread 有未读」。证据:`ThreadSummary.unread_count` 因此长期是 optional 且不填(`packages/shared/src/api/thread-summary.ts`,注释自陈「Lands once a per-stream read primitive exists」)。

而「每条流的最新位置」其实已是 per-stream:`conversation_stream_heads(conversation_id, thread_root_id, latest_seq)`(`baseline-schema.ts:608`)。**缺的只是 per-stream 的「已读边界」。**

## 2. 现状(grounded)

- `conversation_reads`(`baseline-schema.ts:278`):`PRIMARY KEY (user_id, conversation_id)`,`last_read_seq`,`read_at`。
- `conversation_stream_heads`(`baseline-schema.ts:608`):`(conversation_id, thread_root_id NULL=主线, latest_seq)`,唯一性靠**两条 partial unique index**(`uniq_stream_head_main WHERE thread_root_id IS NULL` / `uniq_stream_head_thread WHERE thread_root_id IS NOT NULL`,`:614-618`)。
- `thread_followers`(`baseline-schema.ts:561`):`PK (thread_root_id, principal_kind, principal_id)`,`principal_kind ∈ {human, agent}`。**注意:这是 delivery/agent-wake 契约,不是 attention 偏好**(见 §8 不变量)。
- `messages` 有 `thread_root_id` 列(主线消息=NULL,reply=其 root id)。
- 读模型在 `packages/backend/src/repos/conversation-read-repo.ts`:`markRead`(upsert ON CONFLICT (user_id,conversation_id))、`unreadCountForConversation`、`unreadCountsByConversationForWorkspace`、`latestUnreadForConversation`、`unreadCountsByWorkspaceSidebar`——**全部基于单一 per-conversation 游标**。
- 迁移现状:baseline@44,最新 migration = **v50**,`MIN_SUPPORTED_SCHEMA_VERSION = 44`(`packages/backend/src/db.ts`)。本改动 = **新增 v51**(append-only,绝不改已发布迁移)。

## 3. 核心设计:已读边界 per-stream 化

把 `conversation_reads` 从 per-conversation 升级成 **per-stream**,与已有的 per-stream freshness(`conversation_stream_heads`)对齐。一个概念一个名:stream 在读、写两侧都是同一粒度。

### 3.1 Schema(新增 v51)

`conversation_reads` 增加 `thread_root_id TEXT`(NULL=主线),唯一性**照搬 `conversation_stream_heads` 的两条 partial unique index**(SQLite 复合 PK 含可空列对 NULL 去重不可靠,故不用 PK):

```sql
-- v51。SQLite 不能 ALTER 掉旧 PRIMARY KEY,需 table rebuild。
CREATE TABLE conversation_reads_new (
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  thread_root_id   TEXT REFERENCES messages(id) ON DELETE CASCADE,   -- NULL = 主线
  last_read_seq    INTEGER NOT NULL DEFAULT 0,
  read_at          INTEGER NOT NULL
);

-- 旧行(per-conversation)→ 主线游标:thread_root_id 取 NULL,值原样继承。
INSERT INTO conversation_reads_new (user_id, conversation_id, thread_root_id, last_read_seq, read_at)
  SELECT user_id, conversation_id, NULL, last_read_seq, read_at FROM conversation_reads;

DROP TABLE conversation_reads;
ALTER TABLE conversation_reads_new RENAME TO conversation_reads;

CREATE UNIQUE INDEX uniq_conversation_reads_main
  ON conversation_reads(user_id, conversation_id) WHERE thread_root_id IS NULL;
CREATE UNIQUE INDEX uniq_conversation_reads_thread
  ON conversation_reads(user_id, conversation_id, thread_root_id) WHERE thread_root_id IS NOT NULL;
CREATE INDEX idx_conversation_reads_conversation
  ON conversation_reads(conversation_id);
```

#### 3.1.1 root-invariant trigger(correctness,review #1)

`thread_root_id REFERENCES messages(id)` 只保证 message 存在,**不保证它属于同一 `conversation_id`、也不保证它不是 reply**。`conversation_stream_heads`(`baseline-schema.ts:620-636`)与 `thread_followers`(`baseline-schema.ts:574-607`)都用 trigger 守这个 invariant;`conversation_reads` 必须**复制同类 trigger**,否则客户端传错 `thread_root_id` 会写出跨 conversation / 指向 reply 的 cursor,后续 unread/first-unread **静默错**。insert + update 各一条(镜像 stream_heads):

```sql
CREATE TRIGGER conversation_reads_root_insert
  BEFORE INSERT ON conversation_reads
  WHEN NEW.thread_root_id IS NOT NULL
  BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM messages WHERE id = NEW.thread_root_id)
      THEN RAISE(ABORT, 'conversation_reads.thread_root_id must reference an existing message') END;
    SELECT CASE WHEN COALESCE((SELECT conversation_id FROM messages WHERE id = NEW.thread_root_id), '') != NEW.conversation_id
      THEN RAISE(ABORT, 'conversation_reads root must be in the same conversation') END;
    SELECT CASE WHEN (SELECT thread_root_id FROM messages WHERE id = NEW.thread_root_id) IS NOT NULL
      THEN RAISE(ABORT, 'conversation_reads root must not itself be a reply') END;
  END;
-- conversation_reads_root_update: 同上,BEFORE UPDATE OF thread_root_id, conversation_id。
```

route 层亦应预校验给出友好错误,但 **DB 层 trigger 是 fail-loud 兜底**,不可省。

### 3.2 迁移 = eager seed(关键决策)

旧 per-conversation 游标语义 = 覆盖主线 + 所有 thread 的「粗读」。迁移要**不制造升级后历史未读洪水**,且**稳态模型零 fallback 分支**。

**做法:存量每条 thread 一次性 seed 成旧 `last_read_seq`**(承接同一条 v51 迁移,在上面建索引之后):

```sql
-- 每个 (user, conversation) 的每条已存在 thread,seed 成该 user 的旧主线游标值。
INSERT INTO conversation_reads (user_id, conversation_id, thread_root_id, last_read_seq, read_at)
  SELECT cr.user_id, cr.conversation_id, sh.thread_root_id, cr.last_read_seq, cr.read_at
    FROM conversation_reads cr
    JOIN conversation_stream_heads sh
      ON sh.conversation_id = cr.conversation_id
   WHERE cr.thread_root_id IS NULL          -- 只从主线行派生
     AND sh.thread_root_id IS NOT NULL;     -- 只 seed thread 流
```

**为何 eager 而非 lazy + frozen-baseline:** eager 后稳态读模型只有 `latest_seq > thread_cursor` 一条、**零 fallback 分支**;lazy+baseline 要在模型里永久留一个只缩不灭的 baseline 列(vestigial),按 DDD 该删不该留。backfill 是有界一次性 `INSERT...SELECT`,SQLite 无压力。**硬边界(不可违反):缺省 thread cursor 绝不动态 `COALESCE` 回退到会推进的主线游标**——否则用户只读主线推进主线游标,会把未打开 thread 的新 reply 误判已读,打穿「只有打开 thread 才 mark read」。eager seed 天然满足此边界(每条 thread 有自己的冻结起点)。

### 3.3 未读判定(逐流)

对流 S(主线 = thread_root_id IS NULL;thread = thread_root_id = R):

```
unread(S) = count(messages m
  WHERE m.conversation_id = C
    AND m.thread_root_id IS [NULL | = R]
    AND m.seq > cursor(user, C, S)            -- cursor 缺省 0
    AND m.from_kind != 'system'
    AND NOT (m.from_kind = 'user' AND (m.from_user_id = user OR m.from_user_id IS NULL)))
```

`cursor(user,C,S)` = `conversation_reads` 对应行的 `last_read_seq`(主线查 thread_root_id IS NULL 行,thread 查 = R 行;缺省 0)。排除 system / 自己消息的规则原样保留(对齐现有 `unreadCountForConversation`)。

### 3.4 mark-read 推到 snapshot(关键)

打开一条流时:
1. 读取该流的 `conversation_stream_heads.latest_seq` 作为 **open-time snapshot**。
2. mark-read **只推进到这个 snapshot**,不是「当下最新」:

```
markRead(user, C, threadRootId, snapshotSeq):
  upsert conversation_reads(user, C, threadRootId) set
    last_read_seq = max(last_read_seq, snapshotSeq), read_at = now
  -- ON CONFLICT 目标按 threadRootId 是否 NULL 选对应 partial-unique
  --   主线: ON CONFLICT(user_id, conversation_id) WHERE thread_root_id IS NULL
  --   thread: ON CONFLICT(user_id, conversation_id, thread_root_id) WHERE thread_root_id IS NOT NULL
  -- 沿用 max() 单调推进,与现有 markRead 一致;不回退。
```

**为何 snapshot 而非「当下最新」:** 用户打开 thread 渲染到 snapshot 那一刻为止;若期间并发进来新 reply(seq > snapshot),不该被顺手标读。这与 `message-repo` 已有的 `casStreamHead` 快照纪律一脉(`:1184`)。snapshot 由打开流的读请求返回,客户端用它回写 mark-read(或同一请求内完成)。

**省略 `snapshot_seq` 的 fallback 必须迁移 + 按 stream 非对称(correctness,review #2 + review round-2):** 现有 `markRead` 用 `targetSeq = seq ?? latestSeq(conversationId)`,而 `latestSeq` = `MAX(messages.seq)` 跨**整个 conversation**(`conversation-read-repo.ts:25,270`);shared `MarkConversationReadInputSchema` 注释也写「Omitted = backend uses MAX(messages.seq)」(`message.ts:146`)。per-stream 后这会**用含 thread reply 的 conversation max seq 推进主线 cursor,破坏 stream 语义**。

omitted-fallback 必须**按 stream 非对称**——主线有 legacy caller 要兼容,thread 没有 legacy caller,给它 fallback 等于自废 §3.4 的 open-time snapshot 纪律(打开 thread 后并发新 reply、客户端漏传 snapshot → 服务端按当前 thread head fallback,会吞掉 open 后到达的并发尾部):

- **主线(`thread_root_id IS NULL`):允许省略 `snapshot_seq`**,fallback = **mainline stream head**(`conversation_stream_heads` thread_root_id IS NULL 那行的 `latest_seq`),**绝不再用 `latestSeq(conversationId)`**。这是现有 channel mark-read 的唯一兼容路径。
- **thread(`thread_root_id IS NOT NULL`):`snapshot_seq` 必传**。缺失 → **400**(thread 无 legacy caller,不需要、也不能 fallback);或走「读 thread + mark read」同一服务端用例、用同一次读拿到的 snapshot,绝不在独立 mark-read 请求里 fallback。
- **显式 `snapshot_seq` 必须校验 `snapshot_seq <= 目标 stream 当前 head`**:stream head 单调只增,故 `> head` 只可能是坏客户端把 cursor 推向未来、预先吞掉后续消息 → **400 fail-loud**(与 §3.1.1 trigger 的 fail-loud 纪律一致;不静默 clamp,以暴露客户端 bug)。
- `latestSeq(conversationId)` 这个 helper 在 mark-read 路径上停用(改成 per-stream `streamHeadLatestSeq(conversationId, threadRootId)`)。

**字段命名(compatibility,review round-2):清迁 `seq` → `snapshot_seq`,不留 alias。** `MarkConversationReadInputSchema` 当前只有 optional `seq`(`message.ts:145-148`),**不经 agent CLI 暴露**(`packages/cli` 无 mark-read 命令),仅 renderer→backend 内部 API(`App.tsx` / `ChannelView.tsx` / `useMessageJumpController.ts` + backend tests),**无对外/agent 具名契约**。按「兼容代码是债,无真实契约就删」:schema 正式迁到 `{ thread_root_id?: string, snapshot_seq?: number }`,注释从「MAX(messages.seq)」改为「target stream head; required when thread_root_id is set」,renderer 3 处 + tests 同 change 改完,**spec 与代码里只保留 `snapshot_seq` 一个名,不并存两套**。

### 3.5 channel 未读 roll-up(sidebar 单一 count,shiki 拍)

sidebar 每个 channel **只显示一个未读 count,不分叉**。显式 contract:

```
channel_unread(C, user) = mainline_unread(C, user)
                        + Σ over R in followed_threads(C, user) of thread_unread(R, user)
```

- `followed_threads(C, user)` = `thread_followers` WHERE `principal_kind='human' AND principal_id=user AND conversation_id=C`(取 thread_root_id 集)。
- **非 followed 的 thread 未读不计入 channel_unread**(降噪),只在 Threads list 出弱 dot(§5)。
- **行为变更(显式声明):** 旧 `unreadCountForConversation` 计「主线 + 所有 thread」(单游标);新语义 = 「主线 + followed thread」。非 followed thread 的未读因此**退出** channel/sidebar count。这是有意的降噪,不是回归。
- workspace 级 / sidebar 聚合(`unreadCountsByConversationForWorkspace`、`unreadCountsByWorkspaceSidebar`、`unreadCountsByWorkspace`)按同一 roll-up 重算。

### 3.6 first-unread(供「跳 first unread」)

```
firstUnread(S) = messages m (同 §3.3 过滤) ORDER BY m.seq ASC LIMIT 1
```

每条流可取其 first unread message id + seq,供 UI 打开后定位。

## 4. 读模型 / API 面(backend)

- `ConversationReadRow`(`schema.ts:428`)**加 `thread_root_id: string | null` 字段**。
- `ConversationReadRepo` 全部方法 thread-aware:`markRead(.., threadRootId?, snapshotSeq?)`(fallback 见 §3.4);新增 per-stream `unreadCountForStream` / `firstUnreadForStream`;`unreadCountForConversation` 改为 §3.5 的 roll-up。
- **first-unread DTO 固定输出两个字段(review #4):`first_unread_message_id` + `first_unread_seq`**(§3.6),不要只给 seq——UI 跳转要可靠定位到具体 message,半截 contract 会让前后端各猜一套。`ThreadSummary` 填 `unread_count`(= `thread_unread(R)`)+ 这两个字段。`listChannelThreads`(`message-repo.ts`)带 viewer 计算。
- **reply chip 同源(review round-3,Finding 1):`ReplyBadgeSummary`(`message.ts`,主线窗口 `reply_summaries_by_root` 的 per-root sidecar)也带 `unread_count` + `first_unread_message_id`(+seq)**,由 `replyBadgeSummariesByRoot(conv, rootIds, viewerUserId)` 复用**同一个 `threadUnreadByRoots`**(follow-agnostic、按 rootIds 批量)算出——chip(主线 root 行内联)与 Threads list 读**同一套真相**,不各算一份。
- **open-time snapshot 必须由 read 暴露(review round-3,Finding 2):消息窗口响应 `ConversationMessagesDto` 加 `stream_head_seq`**,= 被打开的那条流(无 thread_root_id=主线 / 否则该 cluster)的 `conversation_stream_heads.latest_seq`,**与窗口在同一次 read 捕获**(`routes/conversations.ts` 窗口 callback:head **先于** `listWindow` 取——backend 单写者同步执行,两次读同一逻辑快照;head-before-window ⇒ snapshot = **open-time head**,故 open 后到达、`seq > snapshot` 的**并发**reply 不会被标读)。**`stream_head_seq` 窗口无关**(按 stream 捕获,与 latest/around/before/after 无关),配合 v1 **read-to-clear whole opened thread**(§6):打开 thread 即标到 open-time stream head 全区间,window 只是定位视图、不要求覆盖 first-unread→tail——故唯一保证是「并发尾部不吞」,**不**声称「覆盖窗口内可见尾部」。客户端把它原样回传 `mark-read` 的 `snapshot_seq`,**绝不在 mark 时再查 head、也不从已加载 messages `max(seq)` 推断**(Cindy round-3 实现不变量)。**不在 `ThreadSummary`/`ReplyBadgeSummary` 行级放 head**:mark 永远发生在打开 thread 之后(§6),那一刻窗口响应的 `stream_head_seq` 即唯一权威快照;行级 head 会诱导打开前标读(违 §6)且制造第二个会分叉的快照源。
- mark-read 路由(`markConversationRead`,`routes/conversations.ts:462`)入参迁为 `{ thread_root_id?, snapshot_seq? }`(§3.4 命名)。**主线(无 thread_root_id):snapshot_seq 可省、fallback mainline head(兼容);thread:snapshot_seq 必传,缺失 → 400;显式 snapshot_seq > 目标 stream head → 400**(§3.4)。`markRead(viewerUserId, conversationId, threadRootId?, snapshotSeq?)`。
- WS `unread_updated`(viewer-scoped)沿用;thread 未读变化复用同一失效信号。

### 4.1 实现不变量:所有 `conversation_reads` 访问必须限定 stream(correctness,review #3)

per-stream 后,`conversation_reads` 每个 (user, conversation) **不再只有一行**。因此**除 §3.5 的 roll-up 聚合外,所有 read/write 都必须显式限定 `thread_root_id IS NULL` 或 `= ?`**,否则会取到主线或任意 thread 行、结果不确定。

**非 repo callsite 必须一并审计(已知)**:
- `mention-cc.ts:337` `viewerHasNotReadMessage` —— 现在 `SELECT last_read_seq ... WHERE user_id=? AND conversation_id=?` 无 stream 条件。必须改成:先取该 message 的 `thread_root_id`(主线消息=NULL),再查**对应 stream 的 cursor**(`thread_root_id IS NULL` 或 `= 该 root`)做比较。否则被检查的消息是 thread reply 时,会错误地拿主线/任意 cursor 判断。
- 实现期 grep `conversation_reads` 全仓,逐一确认每处都带 stream 限定;新增的 callsite 同此纪律。

## 5. UI 三表面(Norman owns,本节为契约,形态留 mockup)

一把 unread 色 + 权重阶梯,不引第二 hue。

1. **Sidebar**:**单一** channel count = §3.5 的 `channel_unread`(主线 + followed thread)。**不放第二个 dot/数字。**
2. **Threads list**:followed thread 未读带数字;**非 followed 有新 reply → 弱 dot(降透明度)**。followed/all 区分只在这一层。
3. **Reply chip(root 行 inline)**:未读态 `3 replies · 2 new`,点击跳 §3.6 的 first-unread。数据源 = 主线窗口 `reply_summaries_by_root[rootId]` 的 `unread_count` + `first_unread_message_id`(§4 reply chip 同源)。点击=打开该 thread 窗口→用窗口响应 `stream_head_seq` 做 mark-read snapshot(§3.4),不在行级或 mark 时另取 head。

## 6. mark-read 触发纪律

只有 thread 实际被**打开**(渲染——无论窗口落在 latest 还是跳到 first-unread),才推进该 thread 的 cursor;推进目标 = **open-time stream head**(§3.4)。**v1 语义 = read-to-clear whole opened thread**:打开即视为读到 open-time head 全区间,first-unread jump 只是定位入口,不要求渲染窗口覆盖 first-unread→tail 全区间(严格「只标已渲染区间」需改 snapshot 语义、范围大,不在 #1226 做)。唯一保证 = **并发尾部不吞**(open 后到达、`seq > snapshot` 的 reply 留到下次打开再标)。**root message 出现在主线 viewport 不算打开 thread**——主线游标推进只标主线流,不碰任何 thread 流的 cursor。

## 7. Out of scope(本 doc 不做)

- **Activity/Inbox** 全局入口、channel 两档 attention 偏好(所有消息/仅提及)、DM 作为 personal stream 的 eligibility——都属 Activity task,复用本 doc 的 cursor 但单独交付,**绝不并进 #1226**。
- 「从 Inbox 隐藏」「snooze/done/archive」等 triage / attention 控件。

## 8. 不变量

1. **per-stream cursor 单调推进**(`max()`),永不回退。
2. **缺省 thread cursor 不动态 COALESCE 主线**(§3.2 硬边界)。
3. **mark-read 推到 open-time snapshot,不到「当下最新」**(§3.4)。**thread mark-read `snapshot_seq` 必传(缺失 400),主线可省、fallback mainline head;显式 snapshot_seq 校验 `<= 目标 stream head`(否则 400)**(§3.4)。**v1 = read-to-clear whole opened thread**(§6):打开 thread 即标到 open-time stream head 全区间,窗口(latest/around)只是定位视图、不要求覆盖 first-unread→tail;唯一保证 = 并发尾部(`seq > snapshot`)不被吞。
4. **`thread_followers` 是 delivery/agent-wake 契约,本改动只读它做 followed/all 区分,不写、不改其语义**(为 Activity 阶段的 delivery⊥attention 不变量预留干净边界)。
5. 迁移 append-only,v51,不改已发布迁移;table rebuild 在单条迁移内原子完成。
6. **所有 `conversation_reads` 访问必须限定 `thread_root_id`(IS NULL 或 = ?),roll-up 聚合除外**(§4.1)。
7. **`conversation_reads` thread 行受 root-invariant trigger 守护**(同一 conversation + root 存在 + 非 reply,§3.1.1)。
8. **open-time snapshot 的唯一来源 = 打开流的窗口响应 `stream_head_seq`**,与窗口同一次 read 捕获(head-before-window);客户端回传它当 `snapshot_seq`,不在 mark 时另查 head、不从 loaded messages 推断、不放行级 head。`stream_head_seq` 窗口无关,配合 §8.3 read-to-clear:其保证是「并发尾部不吞」,非「覆盖窗口内可见尾部」。
9. **客户端消费 freshness(client-side,review round-3 Cindy blocker):snapshot 必须来自「本次打开」的窗口 read,不能是上次打开遗留的缓存值。** React Query 重开同一 thread 会先同步吐旧 cache 的 `stream_head_seq`、再后台 refetch;若 effect 见到非 null head 即 mark 并用「per-root 永久 once-guard」锁死,新响应的更高 head 会被 ref-gate 吞掉 → cursor 停在上次快照、且 snapshot 源自上次 read,破契约。要求:①打开时保证一次 window refetch(`refetchOnMount: 'always'` 或 open 时 invalidate);②mark 仅当**本次 open 触发的 window fetch 已成功完成**;③once-guard **仅在通过②的成功门控后、per-open 重新 arm**(keyed by open/epoch,非永久 per-root;等待/失败态不得提前锁死)。
   - **门控信号必须是「本次 window fetch 成功」本身,不能裸用 `dataUpdatedAt`(review round-3 Cindy 收紧):** `dataUpdatedAt` 只是「数据更新时刻」代理,`setQueryData`(乐观 `patchReplySummary` / live-append)同样会 bump 它,会在真正 window refetch 完成前把门提前打开 → 用非窗口成功响应当 snapshot 源。优先吃一个 current-open fetch epoch / fetch promise success / `lastWindowFetchSucceededAt`(只在 window fetch 成功路径写,不被 `setQueryData` 触达)。若最终仍用 `dataUpdatedAt`,测试必须覆盖两类负例:(a) 旧 cache 先返回 → 不 mark;(b) 本次 open 的 refetch 成功完成前、即便 `setQueryData` 更新了 query data → 仍不 mark。
   - **后端无法兜底**——stale `S` 是合法 seq ≤ head,后端区分不了「本次/上次打开」,故 freshness 是 client 消费纪律。
10. **this-open window fetch 必须尊重打开意图(latest vs jump-around);强制 refetch 不得 clobber jump-open 的 around-window(review round-3 Cindy blocker 2)。** reply chip「跳 first-unread」走 `primeAround` 把 **around-first-unread 窗口**写进 cluster cache;但 `refetchOnMount:'always'` 的 mount-refetch 若 queryFn 无 `aroundMessageId`、按 **latest** 拉,会覆盖该 around-window → 目标被抹、locate 不稳,破 surface 3「点 chip 跳 first unread」。要求:**jump-open(带 `jumpMessageId`)时,本次 open 的权威 window fetch = around-target 那一次**(它 stamp `windowFetchSucceededAt`、arm gate、锚定 RAF locate),**不得**先写 around-window 再被 target-less latest refetch 抹掉(让 primeAround 的 around-fetch 本身充当 this-open window fetch,或 `useThreadCluster` 在 jump open 时按 around target 发本次 fetch)。    - **空缓存 jump-open 的 latest initial fetch 同样要挡(review round-3 Cindy blocker 2b):`refetchOnMount:false` 只挡「有缓存时 mount refetch」,挡不住「空缓存首次启用的 initial fetch」**——`useInfiniteQuery` `enabled=true` + 无缓存 → mount 必跑一次 target-less latest(React Query 行为,`hooks.ts:868-875` 注释自陈)。首次点 chip 打开从未打开过的 thread 时,该 latest initial fetch 可能抢在 primeAround 之前写 `clusterMessagesKey` + epoch、开 gate、mark 并切到 latest 窗口 → first-unread 不在 DOM、locate 不稳,race 仍破 §9.10。**精确不变量:jump-open 时,第一个写 `clusterMessagesKey`/epoch 的 fetch 必须是 around-target,latest 不得抢跑。** 修法:让 `useThreadCluster` 接 open intent/around target、jump-open 的 initial fetch 本身按 around 拉(最干净:一条 intent-参数化的 query,initial page 即 around);或 jump-open 到 primeAround commit 前禁 cluster query 的自动 initial fetch(`enabled` 门控)、仍反应式读 cache。回归需证**空缓存 jump-open 下 latest initial fetch 不抢跑**(纯 `threadOpenNeedsLatestRefetch(jump)=false` 只证 effect 不手动 refetch、epoch-carrier 只证 primeAround 能开 gate,都没证 latest initial fetch 不能先开 gate)——若无 RTL/jsdom mount harness,至少在 hook-config 层断言 jump-open 时 cluster query 不以「latest initial fetch enabled」形态挂上。**抑制的是 FETCH,不是已到达 around-window 的 RENDER(review round-3 Cindy blocker 2c):** prime-pending 期压 `enabled` + 显 loader 是对的,但 `useMessageJumpController` 语义上 primeAround 成功**不**清 `primePending`(等可视层 locate/flash 成功才 `onJumped→clearJump`)。故 loader/empty-state **只能在「还无可渲染 cluster window」时**压(如 `cluster.isLoading || (jumpPrimePending && messages.length === 0)`),around-window 一进 cache 必须立即渲染——否则 loader 一直遮住消息,locate effect 找不到 `#msg-${jumpMessageId}`、超时才清 pending,jump 已失败:**抑制饿死了它本要服务的 locate**。回归补「prime success + pending 仍 true + window present → 渲染消息而非 loader」。

## 9. 迁移安全 / 验证

- v51 在 `MIN_SUPPORTED=44` 之上,空库/新库走 baseline 后顺序应用至 v51。
- 验证点(Cindy review 重点):① table rebuild 后两条 partial-unique 正确(主线每 (user,conv) 仅一行、thread 每 (user,conv,root) 仅一行);② eager seed 后升级无历史未读洪水(thread cursor = 旧主线值);③ mark-read snapshot 不吞并发尾部:thread 省略 snapshot_seq → 400(不 fallback)、主线省略 → fallback mainline head(非 conversation MAX)、显式 snapshot_seq > stream head → 400;④ roll-up 行为变更(非 followed thread 退出 channel count)符合预期;⑤ 外键 `thread_root_id REFERENCES messages` 在 message 删除时级联正确;⑥ root-invariant trigger 拒绝跨 conversation / 指向 reply 的 `thread_root_id`(§3.1.1);⑦ 全仓 `conversation_reads` callsite(含 `mention-cc.ts`)均 stream-qualified(§4.1)。

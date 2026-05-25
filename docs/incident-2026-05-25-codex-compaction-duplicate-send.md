# Incident 2026-05-25 — Codex compaction 后重复执行 `silverhand message send`

> 状态：**观察中，不立即修复**。截至记录时只出现过一次。若后续频率上升，再把本文的候选修复升级为工程任务。

## 0. 简明结论

这次不是用户消息被重新入库，也不是 `conversation_inboxes` ack / replay 漏洞。

父频道里只有一条用户消息 `9J_EUts8PMReL6p1`。重复的是 Cindy 在同一个 Codex turn 里发出了两条语义相同的 agent 回复：

- `IvIExosB1eGmUUQY`，2026-05-25 10:47:29 +08:00
- `9y3FvOhGSQxQ41q6`，2026-05-25 10:52:01 +08:00

根因判断：Codex 在 `context_compacted` 后恢复同一个 turn 时，保留了原始 `You have one message waiting...` 输入，但没有把已经成功执行过的 `silverhand message send` 这种非幂等 side effect 作为已完成状态保留下来，导致同一条可见回复被再次发送。

## 1. 用户可见症状

父频道 `message context menu` 中，用户指出：

> 父频道的 “@shiki 收到，这 4 条继续归” 这个消息发了两次。

对应上下文是 2026-05-25 10:47:03 +08:00 的任务反馈消息：

1. 多选之后，增加快捷键 esc 退出多选
2. save image 的弹窗，副标题中去除共 x 条消息，主标题改成图片预览
3. save image modal 底部的按钮，也需要优化一下样式
4. 弹窗 border 也需要符合主题

Cindy 对这 4 条先后发了两条几乎相同的确认消息。第二条不是用户新发消息触发的正常回复。

## 2. 已确认的证据

### 2.1 父频道消息历史

父频道相关窗口中：

| seq | message id | sender | 时间 | 说明 |
|---:|---|---|---|---|
| 123 | `9J_EUts8PMReL6p1` | user | 10:47:03 | 唯一的原始用户消息 |
| 125 | `IvIExosB1eGmUUQY` | Cindy | 10:47:29 | 第一次确认回复 |
| 130 | `9y3FvOhGSQxQ41q6` | Cindy | 10:52:01 | 重复确认回复 |

因此重复对象是 agent 回复，不是 user message 本身。

### 2.2 `conversation_inboxes` 状态

本地 DB 中，Cindy 对原始用户消息的 inbox row 已在第一次回复前标记 delivered：

```text
5871 | CWstx63Nibl4f6Br | hDl2uVMmgGs3tc_Z | 9J_EUts8PMReL6p1 | delivered_at=1779677230932
```

`delivered_at=1779677230932` 对应 2026-05-25 10:47:10 +08:00，早于第一次 agent 回复。后续查询 Cindy 在该父频道没有 pending inbox row。

结论：不是 Silverhand 又把同一个 inbox row 投递了一次。

### 2.3 Codex session jsonl

同一个 Codex session 文件中可见以下顺序：

```text
10:47:15  收到 "You have one message waiting..."，包含 9J_EUts8PMReL6p1
10:47:28  执行 silverhand message send，发出第一次确认
10:47:30  第一次 send 成功，message_id=IvIExosB1eGmUUQY
10:51:42  context_compacted
10:51:59  没有新的 stdin/user message，仍执行 silverhand message send
10:52:02  第二次 send 成功，message_id=9y3FvOhGSQxQ41q6
```

这证明第二条回复发生在同一个 Codex turn 的 compaction/resume 之后，而不是新的用户输入或新的 inbox delivery。

### 2.4 activity/backend log

agent activity log 中，同一个 runId 在第一次 `message send` 后没有立即以 `replied` 终止，而是继续进入 compacting，之后又恢复执行工具调用。

backend log 中 10:48:09 有 wake watchdog 提示：

```text
deliver: wake accepted but no parsed event observed before watchdog threshold
```

这说明运行态观测也支持“同一个 turn 没有干净结束，而是在 compaction 后继续输出”的判断。

## 3. 排除项

| 假设 | 状态 | 依据 |
|---|---|---|
| 用户消息被重复入库 | 排除 | 父频道只有一条 `9J_EUts8PMReL6p1` |
| `conversation_inboxes` pending row 被重新 drain | 排除 | inbox row 在第一次回复前已 `delivered_at`，之后无 pending |
| 用户又发了一条相同内容 | 排除 | 第二次 `message send` 前没有新的 stdin/user message |
| Silverhand `formatInboxBatch()` 又生成了一次 waiting message | 排除 | DB 无 pending；session jsonl 显示是同一 turn compaction 后继续执行 |

## 4. 暂不修复的理由

这次目前只出现过一次。直接给 `message send` 加强幂等或 turn 终止策略会碰到几个真实边界：

- agent 有时确实需要在同一个 turn 中发多条不同消息。
- 单纯按 content hash 去重可能误杀用户期望的重复文本。
- `message send` 成功后强制杀掉 runtime turn，可能影响“先汇报进度再继续处理”的合法流程。
- 修复应在 agent side-effect 边界上做清楚，而不是补 inbox/drain，因为本 incident 中 inbox/drain 是正常的。

所以当前决策是：记录现象，观察频率。除非再次出现或能稳定复现，否则不进入实现。

## 5. 再次出现时的取证清单

如果同类问题再出现，先收集下面几项，再决定修复方式：

1. 父频道重复消息的两个 agent message id、seq、created_at。
2. 原始 user message id，以及它在 `conversation_inboxes` 中对应 agent 的 row：`id`、`delivered_at`、`created_at`。
3. 对应 Codex session jsonl 中：
   - 第一次 `silverhand message send`
   - `context_compacted`
   - 第二次 `silverhand message send`
   - 两次 send 之间是否有新的 `event_msg user_message`
4. activity log 中同一个 runId 是否在第一次 send 后继续 compacting / replaced / resumed。
5. backend log 中是否有 wake watchdog、runtime replaced、resolveRun 异常。

## 6. 候选修复方向（仅当复发时评估）

### 6.1 首选：非幂等 agent CLI 写操作加短 TTL 幂等防线

对 `silverhand message send` 这类写操作，在 backend 或 CLI 层记录短 TTL 的 send fingerprint。候选 key：

```text
(source_conversation_id, agent_id, target_conversation_id, content_hash, attachment_ids, runtime_run_id)
```

命中重复时返回第一次的 `message_id`，不再插入新消息。

风险：需要保留明确 escape hatch，例如 `--allow-duplicate`，否则会误伤故意连续发送相同文本的场景。

### 6.2 显式 `idempotency_key`

让 agent runtime 在一次 inbox delivery / turn 中拿到稳定的 `idempotency_key`，`silverhand message send` 默认携带它。

优点：语义比 content hash 更强。

代价：需要把当前输入来源、runtime turn、CLI 调用链路打通，工程量大于短 TTL fingerprint。

### 6.3 visible reply 后终止或隔离旧 turn 的后续 side effect

`ConversationMessageService.sendMessage` 当前会把 agent 自己的 source run resolve 为 `replied`。但这次证据显示，底层 Codex turn 在第一次 visible reply 后仍继续执行。

可评估：当同一 source conversation 的 agent visible reply 成功后，是否应取消该 runtime turn，或至少让后续来自同一 stale run 的写操作被拒绝。

风险：现有工作流里可能存在“先发进度，再继续工作”的合法路径；不能粗暴把所有 `message send` 都当终态。

## 7. 当前观察结论

截至 2026-05-25：

- 这是一次偶发现象。
- 投递队列和 inbox ack 没有证据显示异常。
- 更像是 Codex compaction/resume 对 side-effecting tool call 的 replay 问题。
- 暂不改代码；后续若重复出现，再按 §5 取证并优先评估 §6.1。

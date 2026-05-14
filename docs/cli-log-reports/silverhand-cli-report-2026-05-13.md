# Silverhand CLI Daily Report — 2026-05-13

_Generated at 2026-05-14T20:10:18+08:00 (Asia/Shanghai)_

**TL;DR** · 共 **403** 次调用 / **5** 次失败 / 失败率 **1.24%**

## 概览

| 维度 | 值 |
|------|----|
| 总调用 | 403 |
| 成功 | 398 |
| 失败 | 5 |
| 失败率 | 1.24% |

**By HTTP status**: `200`=398, `?`=5

**By error_code (失败)**: `validation_error`=5

**Top operations**:

| op | count |
|----|------:|
| `message.send` | 242 |
| `task.status` | 77 |
| `task.claim` | 52 |
| `task.list` | 22 |
| `message.history` | 6 |
| `channel.list` | 1 |
| `task.create` | 1 |
| `thread.close` | 1 |
| `task.unclaim` | 1 |

## 失败聚类

| 次数 | bucket | 建议 |
|----:|--------|------|
| 4 | `--content <value> removed` | consider restoring `--content` as optional or making the stdin example unmissable |
| 1 | `--status <value> be one of todo\|in_progress\|in_review\|done` | agent passed an unsupported enum — add common aliases (active / pending / open / all) |

**By (op, bucket)**:

| 次数 | op | bucket |
|----:|----|--------|
| 4 | `message.send` | `--content <value> removed` |
| 1 | `task.list` | `--status <value> be one of todo\|in_progress\|in_review\|done` |

**Failures by agent_id**:

| 次数 | aid |
|----:|-----|
| 4 | `Z18wRZX6Uhsoa2tw` |
| 1 | `hDl2uVMmgGs3tc_Z` |

## 各 op 延迟分布 (ms)

| op | count | p50 | p95 | max |
|----|------:|----:|----:|----:|
| `message.send` | 242 | 1.5 | 3.6 | 21.1 |
| `task.status` | 77 | 1.6 | 3.3 | 4.3 |
| `task.claim` | 52 | 1.7 | 2.8 | 4.2 |
| `task.list` | 22 | 3.0 | 5.2 | 6.9 |
| `message.history` | 6 | 1.9 | 3.6 | 3.6 |
| `channel.list` | 1 | 1.1 | 1.1 | 1.1 |
| `task.create` | 1 | 2.3 | 2.3 | 2.3 |
| `thread.close` | 1 | 3.4 | 3.4 | 3.4 |
| `task.unclaim` | 1 | 3.6 | 3.6 | 3.6 |

## 慢调用 (> 1500ms, top 20)

_无超过 1500ms 的调用_

## 失败明细 (最多 50 条)

<details>
<summary>展开查看</summary>

| ts (UTC) | op | http | error_code | error_message |
|----------|----|------|------------|---------------|
| 2026-05-13T09:42:08 | `task.list` | None | `validation_error` | --status <value> be one of todo\|in_progress\|in_review\|done; got in_progress,in_review,open |
| 2026-05-13T15:41:32 | `message.send` | None | `validation_error` | --content <value> removed; pipe the body via stdin instead — e.g. `silverhand message send <<'<value>' ... SILVERHAND_EOF` or `printf "<value>" "<value>" \| sil |
| 2026-05-13T15:42:57 | `message.send` | None | `validation_error` | --content <value> removed; pipe the body via stdin instead — e.g. `silverhand message send <<'<value>' ... SILVERHAND_EOF` or `printf "<value>" "<value>" \| sil |
| 2026-05-13T17:53:30 | `message.send` | None | `validation_error` | --content <value> removed; pipe the body via stdin instead — e.g. `silverhand message send <<'<value>' ... SILVERHAND_EOF` or `printf "<value>" "<value>" \| sil |
| 2026-05-13T18:02:52 | `message.send` | None | `validation_error` | --content <value> removed; pipe the body via stdin instead — e.g. `silverhand message send <<'<value>' ... SILVERHAND_EOF` or `printf "<value>" "<value>" \| sil |

</details>

## 与昨天对比

| 指标 | 昨天 | 今天 | 变化 |
|------|----:|----:|----:|
| 总调用 | 726 | 403 | -323 |
| 失败 | 19 | 5 | -14 |
| 失败率 | 2.62% | 1.24% | -1.38pp |

**消失 bucket**（昨天有，今天无）:
- `(empty)`
- `--content <value> required`
- `silverhand message search accepts flags only`
- `task create requires at least one --title`
- `unknown flag --details`
- `unknown flag --query`
- `unknown flag --self-claim`
- `unknown flag --text`

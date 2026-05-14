# Silverhand CLI Report — Summary 2026-05-11 → 2026-05-14

_Generated 2026-05-14 by @Alice from the consolidated CLI NDJSON logs in `~/.silverhand/logs/`_

> **Scope** · 一次性合并视图，覆盖 21 份 cli log（4 天）。这是回填，不是日报。日报由 `silverhand-cli-daily-report.py` 每日 06:00 (Asia/Shanghai) 生成，命名 `silverhand-cli-report-<YYYY-MM-DD>.md`。

---

## TL;DR

- **1473** 次调用 / **34** 次失败 / 失败率 **2.3%**
- 失败 100% 集中在两类：`validation_error` (33) + `thread_not_found` (1)
- 失败的根因几乎全部是 **agent 在凭经验猜接口** —— flag 命名不直观、enum 缺 alias、stdin-only 反直觉
- 7 个清晰的可改进点，下面按"反复发生 = 真问题"的维度排开

---

## 概览

| 维度 | 值 |
|------|----|
| 总调用 | 1473 |
| 成功 | 1439 |
| 失败 | 34 |
| 失败率 | 2.3% |
| 时间窗口 | 2026-05-11 → 2026-05-14（4 天） |
| 涉及 agent | 至少 2 个（Z18wRZX6Uhsoa2tw 主导） |

**By HTTP status**: `200`=1439, `?`=33（validation 失败前置返回，不打 HTTP）, `404`=1
**By error_code**: `validation_error`=33, `thread_not_found`=1

**Top operations**:

| op | count |
|----|------:|
| `message.send` | 868 |
| `task.status` | 243 |
| `task.claim` | 200 |
| `task.list` | 64 |
| `message.history` | 43 |
| `message.search` | 20 |
| `task.create` | 13 |
| `task.unclaim` | 5 |
| `workspace.list` | 5 |
| `channel.list` | 4 |

---

## 🔴 Issue 1 · agents 反复猜 `message send` 的发送 flag（15 次失败）

| 错误 bucket | 次数 | agent 试的 flag |
|---|---|---|
| `--content` 已被移除 | 6 | `--content` |
| `--content` 必填（更早版本） | 3 | 没传任何东西 |
| 未知 flag `--text` | 3 | `--text` |
| 未知 flag `--message` | 2 | `--message` |
| 空 / 其他 | 1 | — |

**根因**：发送消息的 flag 一改再改（必填 `--content` → 移除 `--content` → 仅 stdin），且都是 agent 第一直觉会试的 flag。错误信息已指向 stdin 用法，但仍有 agent 反复犯。

**建议**：
- 要么恢复 `--content` 为可选（与 stdin 二选一）
- 要么在检测到 `--message / --text / --content` 时，给一个 **指向 stdin 用法的、带可复制 heredoc 例子的 hard error**（已有部分，但还不够醒目 / 带模板）

---

## 🔴 Issue 2 · `task list --status` 缺 alias（8 次失败）

只接受 `todo|in_progress|in_review|done`，agents 试过：

| value | 次数 |
|------|---:|
| `pending` | 2 |
| `open` | 2 |
| `all` | 2 |
| `active` | 1 |

**建议**：至少加：
- `active` ≡ `todo + in_progress + in_review`
- `all` ≡ 不过滤

这 8 次失败 100% 来自 agent 的常识性猜测，零语义新增。

---

## 🔴 Issue 3 · `message search` query 接收方式反直觉（7 次失败）

- 试 `--query` × 5
- 试 positional × 2

agents 默认 `search foo` 或 `search --query foo`，但实际要 stdin。

**建议**：让 `message search` 同时接收一个 positional `<query>`（最常见用法），保留 stdin 作为多行 / 特殊字符场景。其他 CLI（git grep / rg）都是 positional 起手，agent 是带着这个先验来的。

---

## 🟡 Issue 4 · `task create` flag 命名不直观（4 次失败）

agents 试过：`--details`、`--self-claim`、`--message`、还出过一次"忘传 --title"。

**建议**：
- 检查 `task create --help` 是否清楚提示**最小可用调用**
- `task claim` 已经有 `--message-id`，是不是让人误以为 `task create --message` 也行？需要在 help 里点明区别

---

## 🟡 Issue 5 · `message.search` 延迟显著高于其他 op

| op | count | p50 | p95 | max |
|----|---:|---:|---:|---:|
| message.send | 868 | 1.4ms | 3.1ms | 21ms |
| task.status | 243 | 1.8ms | 3.6ms | 20ms |
| task.claim | 200 | 1.8ms | 4.4ms | 20ms |
| task.list | 64 | 2.0ms | 4.8ms | 7ms |
| message.history | 43 | 1.3ms | 2.9ms | 5ms |
| **message.search** | **20** | **5.9ms** | **23.6ms** | **23.6ms** |

5–10× 慢。20 次样本太小不能盖棺，但 p95 24ms 已经显著超出"本地 SQLite 调用"应有的水位。

**建议**：看 search 是不是走 FTS / 是否每次都全表扫；高频后可能成为热点。

---

## 🟡 Issue 6 · 1 次 `thread_not_found`（404）

`message.send --target <thread_id>` 打到一个不存在的 thread。可能是 thread 被关了之后还在尝试发、或者 cache 陈旧。

**建议**：在 thread close 后给 sender 一个明确的 hint（"thread X 已 close，回到父 channel"），减少这种孤儿调用。

---

## 🟢 Issue 7 · 错误码粒度太粗

33 / 34 失败全部归为 `validation_error`。建议拆分成：

| 子类 | 含义 | agent 自纠空间 |
|---|---|---|
| `unknown_flag` | flag 名打错 | 带 closest match → "did you mean" |
| `flag_removed` | flag 已废弃 | 带替代用法 + 可复制例子 |
| `enum_invalid` | 枚举值非法 | 带 allowed values 列表 |
| `required_missing` | 缺必填 | 给最小可用调用 |
| `positional_unsupported` | 不支持 positional | 引导到 flag 形式 |

agent 程序化恢复时这能省一大堆"读人话"的成本。

---

## 总结

CLI 的语义很清晰，但 **flag 命名 + 枚举值 + 错误反馈** 跟 agent 的"先验直觉"还有距离。

> 这 34 个失败里至少 30 个是 agent 在凭经验猜接口 —— 把这 30 个的"猜"变成"成功"，几乎不需要改语义，只需要加 alias / 别名 / 更友好的错误。

后续每日报告由 `silverhand-cli-daily-report.py` 自动生成，可以观察这些问题在新版本里有没有被修掉。

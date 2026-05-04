# Incident 2026-05-04 — Agent silent turn（收到消息但 turn_end 不回）

跟同一天的 [agent-shutdown incident](./incident-2026-05-04-agent-shutdown.md) 是**两个不同的问题**。
那个是生命周期 / 进程挂死；这个是进程一切正常、消息也送达了、模型自己选择 turn_end 走人。

---

## 1. 用户可见的症状

- 在 channel 里发了一句话（包括 `@Alice` 这种点名消息），等了几分钟没人回。
- agent 在 UI 里看起来不是 "connecting"，而是正常 idle。
- session 切到别的 session 看，那个 agent 在别处可能正常活跃。
- 想"催"agent 回——再发"还在吗？""你怎么不说话？"，结果照样不回。

跟 shutdown incident 的区别：

| 维度 | shutdown incident | silent-turn incident |
|---|---|---|
| 进程状态 | dead 或卡死 | 活着、CPU 0%、正常 sleeping |
| UI 表现 | "connecting" 长期不消失 | 短暂 "thinking" 然后回 idle，没有任何消息产出 |
| backend 日志 | 没有 `session_init`、没有 `turn_end` | **有 `turn_end`、`pendingDeliveries=0`、turn 内 0 个 tool_call** |
| 修复方向 | 生命周期代码 | prompt / policy |

---

## 2. 三个已观察案例

### 案例 A — "全部关闭" 但 task 没动

- **场景**：用户跟 Alice 跑完一轮 → 发"全部 done 了，关一下吧"。
- **现象**：Alice 调了 `send_message` 回了"好的，已关闭"，但 `update_task_status` 一个都没调。task 在 DB 里还是 `in_progress`。
- **bridge 日志**：`tool: send_message ok` ×1，没有 `update_task_status`。
- **诊断**：模型把"全部 done"理解成"对话结束、聊完了"——做了 conversational closing，没做 housekeeping。

### 案例 B — PIN sidebar 44 次 tool_call 后 0 次 send_message

- **场景**：用户让 Alice 实现"侧边栏置顶 session"功能。
- **现象**：Alice 跑了 44 个 tool_call（Bash×12、Edit×11、Read×16、Glob×3、Write×1、Agent×1），代码改完了（mtime 02:20 验证），**整轮没调一次 `send_message`**。用户没收到任何"做完了"的反馈。
- **bridge 日志**：bridge connect 之后只有 Read/Edit/Bash 的痕迹，没有 send_message。
- **诊断**：模型把"实现 X 功能"理解成纯执行型任务，做完直接 turn_end，忘了"在 chat 场景里要回告"。

### 案例 C — `@Alice ？还在工作吗` 直接 turn_end

- **场景**：member activity session 静默几分钟后用户发"`@Alice ？还在工作吗`"（13 字节）。
- **现象**：
  ```
  18:55:53  user msg → Alice (gated, 61B) + Cindy (direct, 61B)
  18:56:00  Alice turn_end，pendingDeliveries=0，turn 内 0 个 tool_call
  18:56:03  Cindy turn_end，同样 0 个 tool_call
  之后       完全静默
  ```
- **诊断**：模型看到一句状态查询、没有明确 actionable，直接 turn_end 走人。`@Alice` 的 mention 没起到强制回复的作用。

---

## 3. 共性

三个案例的 **共同 fingerprint**：

1. backend 日志能看到 `agent: turn_end` 且 `pendingDeliveries=0`——turn 正常关闭，不是中断。
2. turn 内的 `agent: tool_call` 计数里 **`mcp__chat__send_message` / `mcp_chat_send_message` 是 0**。
3. 进程状态一切正常（status=`active`，pid alive，CPU 0%）。

触发条件分三类：

- **状态查询型** ("还在吗 / 在不在 / 你说话啊")：模型判断"没东西回"，沉默。
- **闭环型** ("好了 / done / 关一下")：模型把这当对话收尾，做了 small-talk 关闭就 stop，忘了 housekeeping（task status）。
- **执行型** ("实现 X / 修 Y")：模型把这当独立任务执行，做完直接 stop，不在 chat 里回告。

`gated` 投递模式（Claude 驱动默认）**不是原因**——日志确认 stdin 已写入、模型确实开了一个 turn 处理。

---

## 4. 跟 lifecycle bug 的判别 checklist

下次再遇到"agent 没回"的报告，按这个顺序排查（先不要假设是哪类）：

```
1. ps -p <pid> ：进程死了吗？
   死了 → lifecycle bug（看 incident-2026-05-04-agent-shutdown.md）
   活着 → 走第 2 步

2. backend log 里 grep <sessionId> + <agentId>：
   完全没 turn_end → 模型挂在 API 上 / driver 没 emit → lifecycle 域
   有 turn_end 但带 status_error → CLI 异常 → lifecycle 域
   有正常 turn_end 且 pendingDeliveries=0 → 走第 3 步

3. 数 turn 内的 tool_call：
   0 个 send_message → 本 incident（silent-turn）
   有 send_message 但用户在 UI 里没看到 → bridge → backend → renderer 路径问题
```

---

## 5. slock-ai 对比

参考源码：

- `/Users/shiki/.npm/_npx/277f35d2ed0078b9/node_modules/@slock-ai/daemon/dist/chunk-NM2MFLQ7.js`
- `buildPrompt` 的 critical / startup / communication 段：约 688-714、1028-1041 行。
- spawn / wake message framing：约 4186-4212 行。
- live stdin delivery / turn_end inbox flush：约 5328-5342、5436-5464 行。

slock **没有**做"driver 层拦截 turn_end、发现没发消息就强行重试当前 turn"。它主要靠三层软约束降低 silent-turn 概率：

1. **平台 prompt 更像操作手册**：
   - `send_message` / `slock message send` 是唯一输出渠道。
   - 收到具体消息时，先判断是否需要 visible acknowledgment / blocker question / ownership signal。
   - 收到消息后 process it and reply。
   - 多步任务完成后 summarize result。
   - 停止前检查是否还有自己欠下的 handoff / review / decision / reply。
2. **wake message framing 更强**：
   - agent 被新消息唤醒时，slock 把用户消息和行动提示写在同一次 stdin 输入里：
     `Respond as appropriate — reply with send_message, or take action as needed. Complete ALL your work before stopping.`
   - 这比只在 system prompt 里写规则更有效，因为模型处理当前消息时马上看到 reply / complete-all-work 约束。
3. **turn_end 只 flush 新到的排队消息**：
   - 如果 agent 正忙时又收到新消息，slock 在 `turn_end` 后把 inbox 里的新消息再写入 stdin。
   - 这不是对"当前已处理但没回复的那条消息"做重试；它只保证 busy 期间积压的新消息不丢。

Silverhand 现在的对应状态：

| 机制 | slock-ai | Silverhand 当前 | 差距 |
|---|---|---|---|
| 输出渠道 | critical rule 明确 only output channel | 已有 "always call send_message"，但没有 "Always communicate through..." 的强表达 | 小差距 |
| 收到消息后回复 | startup 明确 process and reply | 已有 "Process ... then reply"，但后面的 communication style 又强调 no filler / skip idle narration | 有冲突，状态查询容易被模型判成不用回 |
| delivery framing | wake framing 显式 `reply with send_message`，live delivery 至少 `Complete all your work` | `formatLiveMessage` / `formatInboxBatch` / `combineGatedBatch` 只有 `Respond as appropriate.` | **主要缺口** |
| turn_end 排队消息 flush | 有 | `handle.pendingDeliveries` + `flushPending()` 已有 | 不是主要缺口 |
| 当前消息 silent-turn 重试 | 无 | 无 | 可选增强，不是 slock baseline |
| @mention must-reply | 主要靠 prompt / thread context | 无特殊处理 | 可做增强 |

结论：这次不要优先实现"driver 硬拦 turn_end"。更接近 slock、风险更低的第一步，是把 Silverhand 的 delivery framing 和 communication prompt 调强。

---

## 6. 已有 / 计划中的缓解措施

### 已实现（task #14）

`turn_end + 无消息产出` 时 backend 会发 terminal `agent_activity { status: 'idle', terminalReason: 'turn_ended' }`，前端把 thinking 态清掉。

→ **只修 UI**：用户不会再看到"假装在思考"的 bubble。**不让 agent 回话**。

### 没做的（follow-ups）

按 ROI 排序：

1. **Delivery framing：每次投递用户消息时，把 reply / complete-all-work 约束和消息放在同一个 stdin 输入里**
   - 覆盖位置：`formatLiveMessage`、`formatInboxBatch`、`combineGatedBatch`。
   - 建议文案按 sender-aware 处理，不要强迫纯 system announcement 回复：
     - user / direct mention：`Respond as appropriate — call send_message with a brief reply, progress update, blocker question, or final summary before stopping. Complete ALL your work before stopping.`
     - system：保持 "informational unless explicitly asks" 的语义，只对 onboarding / task-like system 消息依赖其正文指令。
   - 价值：最接近 slock 的有效触发点，直接覆盖案例 B、C 的大部分概率。

2. **Platform prompt 改写：补上 slock 的 "keep user informed / done summary / blockers before stopping"，并消除 no-idle 的歧义**
   - 保留 Silverhand 的 concise 风格，但明确：
     - 用户状态查询（"还在吗 / 在不在 / ？"）算需要回复。
     - 接了任务就要在 chat 里给 ownership signal；多步任务完成后要发 final summary。
     - 停止前检查是否还有自己欠的回复、handoff、task 状态更新。
   - 价值：覆盖案例 A/B/C，比单句 "Always send_message" 更稳定。

3. **Task hygiene 子 prompt**（针对案例 A）
   - 在 Tasks 段加硬规则：如果你完成或关闭了自己 claim 的 task，必须先调用 `update_task_status`，非 trivial 工作停在 `in_review`；不能只发一句"好了"。
   - 价值：消灭 "send_message 有了但 task 没动"。

4. **Mention parser → 强制 must-reply**
   - 实现：消息内容里检测到 `@<agent_name>`，对该 agent 的 stdin 包装时加一行 hint：`[user addressed you by name; a visible reply is expected]`。
   - 价值：直接消灭案例 C，对案例 A/B 无关。
   - 成本：单 PR 能搞定。

5. **Driver 层硬约束：所有 `turn_end` 前必须至少 1 次 `send_message`**（长期兜底，不作为第一步）
   - 实现：在 driver 拦截 turn_end 事件，发现该 turn 没 send_message → 用一条 system 风格的 stdin 续写，提示"请先用 send_message 通报当前进展再 stop"。
   - 风险：可能进入循环（agent 回了一句"好的"又 stop，又被续写）。需要至多重试 1 次。
   - 价值：直接消灭案例 B、C，对案例 A 部分有效（至少会回话，可能仍漏 task status）。

**短期建议**：先做 (1)+(2)+(3)，这是 slock 设计里已经证明有效的软约束路径，成本低且没有 turn_end retry 的循环风险；然后做 (4) 处理点名不回；最后再评估 (5) 是否需要。

---

## 7. 用户侧 workaround（在修复前）

观察到的、能让 agent 大概率回话的发问方式：

- ❌ "还在吗？"、"你怎么不说话？"、"在不在？" → 高概率被 turn_end 吞掉
- ❌ "好了"、"全部关一下" → 可能只回一句但不动 task
- ✅ "请用一句话回复确认你还在" → 指令式 + 明确要求 send_message
- ✅ "把当前进度发到 chat 里"、"用 send_message 报告一下你做了什么" → 显式 tool name 引用，命中率最高
- ✅ "完成 X 后在 chat 里通知我" → 任务发布时就把通报要求写进去

`@<name>` 目前**不是强制回复信号**——只是文本里多了几个字符，不要依赖。

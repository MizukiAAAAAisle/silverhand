# Platform Prompt — 已知问题分析

> 本文记录 Silverhand `platform-prompt.ts` 中已发现的行为问题，包含与 slock-ai 的对比分析和修复方向。

---

## 1. Agent 频繁使用"平台"一词

**发现时间**：2026-05-04

### 现象

Agent 在中文对话中频繁出现"平台"这个词，例如：
- "我是运行在平台上的 agent"
- "平台显示了……"
- "这是平台的规则"

### 根因

`platform-prompt.ts` 在操作性指令中多次使用 "platform" 这个泛词：

| 位置 | 内容 |
|------|------|
| 标题 | `# Silverhand platform manual` |
| 身份描述 | `via the Silverhand chat platform` |
| 操作指令 | `The platform shows what you did` |
| 消息类型 | `platform announcements`（出现 2 次）|

共 **5 处**使用 "platform" 泛称。Agent 在中文对话语境下复用这些措辞，自然翻译成"平台"并形成口头禅。

### 对比 slock-ai

slock 的系统提示只在产品介绍一处用了"platform"（`"an AI agent in Slock — a collaborative platform for human-AI collaboration"`），其余所有操作性上下文直接说 "Slock"，不使用泛称。因此 slock 的 agent 不会形成"平台"口头禅。

### 修复方向

- 操作性指令中把 "the platform" 替换为具体名称 "Silverhand"（如 `Silverhand shows what you did`）
- 或在不影响语义的地方直接省略（如 `The UI shows what you did`）
- 标题可保留 "Silverhand platform manual"，但正文中泛称"platform"的地方应具体化

---

## 2. Agent 互相频繁无意义 ping（Ping Loop）

**发现时间**：2026-05-04

### 现象

多 agent session 中出现 agent 之间来回互发消息、无实质内容推进的循环，用户无法介入。

### 根因

Silverhand 当前的 `## Multi-agent etiquette` 只有两条规则：

```
- Never reply to your own agent message — that's an echo loop.
- If a message clearly belongs to another agent, do not interject.
  Respond only when addressed or when you have unique value to add.
```

这两条只防止「自己 echo 自己」，没有覆盖以下场景：
- Agent A 说了一句话 → Agent B 确认 → Agent A 回应确认 → ……
- 一个 agent 回复了，另一个 agent 看到后觉得需要"补充"，触发新一轮

### 对比 slock-ai

slock `chunk-NM2MFLQ7.js` 中的对应规则（精简翻译）：

```
- Respect ongoing conversations. If a human is having a back-and-forth
  with another person (human or agent), only join if explicitly @mentioned.
- Only the person doing the work should report on it — don't echo or
  summarize another agent's work.
- Skip idle narration. Only send messages with actionable content.
```

三条规则的关键差异：
1. **"只有被 @mention 才加入"** — 直接断掉无目的插话的动机
2. **"不重复报告他人的工作"** — 防止 agent B 对 agent A 的结果做无意义确认
3. **"Skip idle narration"** — 没有新内容就不发消息，从根本上限制消息频率

### 修复方向

在 `platform-prompt.ts` 的 `## Multi-agent etiquette` 段补充以下规则：

1. **没有被 @mention、没有被明确提问，不要主动回复其他 agent 的消息**
2. **如果已有 agent 在处理或已回答某个问题，不要插话确认或追加摘要**
3. **没有实质性新内容就不发消息**（"Skip idle narration" 原则）

可选的机械兜底（v1 暂不实现，出问题再加）：
- 连续 N 轮均为 agent 之间互发且无用户消息 → 强制 pause 等待用户介入

import { MAX_MESSAGE_CONTENT_BYTES } from '@silverhand/shared';

/**
 * Render budgets for `<Markdown>`. A budget is a RENDERER resource bound —
 * distinct from any wire cap that happens to share its number.
 *
 * The guard exists because a multi-MB body pins the renderer process inside
 * remark/rehype (observed as 99% CPU + heartbeat loss, #task:1550), and legacy
 * DB rows predating the send-side cap still hold such bodies.
 *
 * The budget is per CONSUMER, because "how much markdown is it sane to render
 * here" has different answers per surface (shiki 2026-07-26: "channel 消息渲染
 * 保持 64kb 的渲染预算,但是 workspace file 则不要有任何限制"):
 *
 *  - `'message'` (default) — chat bodies, task bodies, saved items, activity
 *    snippets. Bounded by the message content cap: anything at or under it was
 *    legally sendable, anything over it is a legacy row.
 *  - `null` — the workspace file preview. A single large markdown file is not a
 *    rendering problem, and the surface is ALREADY bounded upstream by the
 *    daemon's read cap (`MAX_PREVIEW_BYTES`), so a second bound here buys
 *    nothing and only mis-fires: the daemon hands back `cap + one truncation
 *    line`, so every large file arrived one line over the message cap and a
 *    97KB `work-log.md` rendered as 4000 chars of plain text.
 */
export const MESSAGE_RENDER_BUDGET_BYTES = MAX_MESSAGE_CONTENT_BYTES;

const encoder = new TextEncoder();

export function markdownByteLength(content: string): number {
  return encoder.encode(content).length;
}

/** `budget === null` → unbounded (the caller is bounded elsewhere).
 *  Fast pre-check first: every UTF-16 code unit encodes to >= 1 UTF-8 byte, so
 *  a string shorter than the budget in code units can never exceed it — the
 *  common path never touches `TextEncoder`. */
export function exceedsRenderBudget(
  content: string,
  budget: number | null,
): boolean {
  if (budget === null) return false;
  if (content.length <= budget / 4) return false;
  return markdownByteLength(content) > budget;
}

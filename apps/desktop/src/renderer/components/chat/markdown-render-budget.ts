import { MAX_MESSAGE_CONTENT_BYTES } from '@silverhand/shared';

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

/**
 * Gated-batch text combination (#task:1417 Stage 3, §11.9).
 *
 * When multiple `gated`-driver deliveries pile up in the daemon's mid-turn
 * queue between safe boundaries, the flush combines them into ONE user
 * message so the runtime sees them in order and treats them as a single
 * turn. This is runtime/driver-layer text assembly, so it lives in `host`
 * (the daemon owns runtime); it moved here from the backend's
 * `stdin-format.ts` when Stage 3 sank the mid-turn queue into the daemon.
 *
 * Kept byte-for-byte identical to the pre-Stage-3 backend formatter so the
 * combined-message wording the runtime receives does not change.
 */
export function combineGatedBatch(messages: readonly string[], sendMessageTool: string): string {
  return (
    `You have ${messages.length} new messages that arrived while you were busy ` +
    `(oldest first):\n\n${messages.join('\n\n---\n\n')}\n\n` +
    `Review all messages above. If any user message or direct mention expects ` +
    `a visible response, call \`${sendMessageTool}\` before stopping. ` +
    `Complete ALL your work before stopping.`
  );
}

/** The send-message tool name the combined-batch instruction references.
 *  Matches the literal the backend coordinator passed pre-Stage-3. */
export const SEND_MESSAGE_TOOL = 'silverhand message send';

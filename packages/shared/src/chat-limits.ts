/**
 * Cross-surface limits for chat message content.
 *
 * One constant shared by: backend send routes (hard cap, 413), CLI
 * auto-attachment conversion, desktop composer paste conversion, and the
 * renderer's oversized-content guard. Measured in UTF-8 bytes — not UTF-16
 * code units — so the cap means the same thing on the wire, in SQLite, and
 * in every client.
 */
export const MAX_MESSAGE_CONTENT_BYTES = 64 * 1024;
export const MAX_MESSAGE_CONTENT_LABEL = '64KiB';

/**
 * Pre-parse HTTP body bound for the message-send routes. A legal
 * exactly-64KiB content can expand up to 6x under JSON string escaping
 * (`\u0001` is 6 bytes for 1), so the bound is 6x the content cap plus
 * envelope headroom (attachment ids, target, freshness fields). Bodies
 * over this are rejected before buffering/parsing.
 */
export const MESSAGE_SEND_MAX_BODY_BYTES = 6 * MAX_MESSAGE_CONTENT_BYTES + 128 * 1024;

/** Max attachment refs on one message. Enforced by the send schemas
 *  (`MessageAttachmentIdsInputSchema`) and consumed by clients that must
 *  reserve or check a slot before uploading (composer paste conversion,
 *  oversized-content auto-attachment). */
export const MAX_MESSAGE_ATTACHMENTS = 20;

const encoder = new TextEncoder();

export function messageContentByteLength(content: string): number {
  return encoder.encode(content).length;
}

/** Fast pre-check: every UTF-16 code unit encodes to >= 1 UTF-8 byte, so a
 *  string shorter than the byte cap in code units can never exceed it. */
export function messageContentExceedsLimit(content: string): boolean {
  if (content.length <= MAX_MESSAGE_CONTENT_BYTES / 4) return false;
  return messageContentByteLength(content) > MAX_MESSAGE_CONTENT_BYTES;
}

import { MAX_MESSAGE_ATTACHMENTS, messageContentExceedsLimit } from "@silverhand/shared";

/** Composer-local alias for the shared per-message attachment cap. */
export const MAX_ATTACHMENTS = MAX_MESSAGE_ATTACHMENTS;

/**
 * Paste-time interception is an early optimization only — the
 * submit-time conversion in `useSendMessage` is the authority. Only
 * intercept (preventDefault + convert to a pending attachment) when the
 * pasted text is over the content byte cap AND an attachment slot is
 * available: `addFiles` is a no-op at capacity, so intercepting without
 * a slot would silently swallow the pasted text.
 */
export function shouldInterceptOversizedPaste(text: string, pendingCount: number): boolean {
  return text.length > 0 && messageContentExceedsLimit(text) && pendingCount < MAX_ATTACHMENTS;
}

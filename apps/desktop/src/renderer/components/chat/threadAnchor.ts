import type { MessageDto } from '@silverhand/shared';

/**
 * Pull the (single) thread_anchor system message out of a messages list.
 * Returns null when the session isn't a thread child.
 */
export function findThreadAnchor(messages: MessageDto[]): MessageDto | null {
  for (const m of messages) {
    if (m.from_kind !== 'system') continue;
    const subtype = (m.metadata ?? {})['subtype' as keyof typeof m.metadata];
    if (subtype === 'thread_anchor') return m;
  }
  return null;
}

/** Read the original message id stored on a thread_anchor system message. */
export function readAnchorMessageId(
  metadata: MessageDto['metadata'],
): string | null {
  if (!metadata) return null;
  const v = (metadata as Record<string, unknown>)['quoted_message_id'];
  return typeof v === 'string' ? v : null;
}

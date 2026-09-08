import type { MessageDto } from "@silverhand/shared";
import { type CachedMessage, isCommittedMessage } from "@/features/channels/pending-message";

/**
 * Pull the (single) thread_anchor system message out of a messages list.
 * Returns null when the conversation isn't a thread child. The anchor is always
 * a committed system row, so optimistic pending rows are skipped.
 */
export function findThreadAnchor(messages: readonly CachedMessage[]): MessageDto | null {
  for (const m of messages) {
    if (!isCommittedMessage(m)) continue;
    if (m.from_kind !== "system") continue;
    const subtype = (m.metadata ?? {})["subtype" as keyof typeof m.metadata];
    if (subtype === "thread_anchor") return m;
  }
  return null;
}

/** Read the original message id stored on a thread_anchor system message. */
export function readAnchorMessageId(metadata: MessageDto["metadata"]): string | null {
  if (!metadata) return null;
  const v = (metadata as Record<string, unknown>)["quoted_message_id"];
  return typeof v === "string" ? v : null;
}

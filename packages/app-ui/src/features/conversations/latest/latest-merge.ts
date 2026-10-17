/** The fields the merge reads off one conversation's latest-message summary
 *  (`ConversationLatestDto`, #task:2845). Which rows show is decided by the
 *  conversation lists; this map only supplies their previews, so an entry for
 *  a conversation the viewer has left is never rendered. */
export interface LatestEntry {
  conversation_id: string;
  seq: number;
}

export type LatestMap<T extends LatestEntry> = ReadonlyMap<string, T>;

/** An event: the same message (equal seq) refreshes the entry, an older one is
 *  dropped. */
export function applyLatestEvent<T extends LatestEntry>(
  current: LatestMap<T>,
  entry: T,
): LatestMap<T> {
  const held = current.get(entry.conversation_id);
  if (held && entry.seq < held.seq) {
    return current;
  }

  return new Map(current).set(entry.conversation_id, entry);
}

/** A snapshot merges entry by entry under the same seq rule. It never drops an
 *  entry it lacks: an event may have brought one the snapshot predates (a first
 *  message in an empty channel), and an entry for a conversation the viewer has
 *  left is harmless because the conversation lists decide which rows exist. */
export function applyLatestSnapshot<T extends LatestEntry>(
  current: LatestMap<T> | undefined,
  items: readonly T[],
): LatestMap<T> {
  let next: LatestMap<T> = current ?? new Map();
  for (const item of items) {
    next = applyLatestEvent(next, item);
  }

  return next;
}

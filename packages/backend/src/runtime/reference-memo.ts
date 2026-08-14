/**
 * #task:2000 (shiki's ruling: option B) — the wake phase's addressing-set
 * derivation, memoized per message id under a hard bound.
 *
 * # Why this exists
 *
 * The wake path re-frames one batch PER RECIPIENT: `formatInboxBatchPresentation`
 * answers "does this batch address me", which is a different question for every
 * agent, so the surrounding text is rebuilt each time. The addressing set it
 * reads to answer is NOT per-recipient, but it was re-derived with the batch, so
 * one message delivered to N agents paid N Markdown parses. A 5.4KiB review body
 * in a 10-message × 10-recipient backlog measured ≈71ms of synchronous CPU on
 * the event loop; a 64KiB pathological body measured ≈251ms in a 5×5. Neither is
 * an attack — the first is ordinary traffic.
 *
 * # Why a cache is SOUND here, and not a second authority
 *
 * `messages.content` is immutable: no `UPDATE messages … SET content` exists
 * anywhere in the repos or the migrations, and an edit is modelled as a new row.
 * So `id → references` is a pure function of durable state and this memo is a
 * derived accelerator, never a place the answer can drift from the body. If
 * content ever becomes mutable, THIS comment is what has to change first: the key
 * gains a version, or the memo goes.
 *
 * # Why the derivation lives HERE
 *
 * Each phase has exactly one place that derives the addressing set, and the
 * import surface of `@silverhand/shared/reference-markdown` is what enforces it
 * (#task:2000 review round 2): the send boundary derives once per send and
 * threads the result to its in-send consumers; this module is the same single
 * authority for the wake phase. That is why `formatInboxBatchPresentation`
 * takes the resolver as a REQUIRED parameter and no longer
 * import the parser — a formatter with a parse of its own would be a second
 * derivation the type checker could not see.
 *
 * The parser stays the single definition of "addressed" (`extractMessageReferences`
 * over the raw body). This module never re-implements the grammar.
 *
 * # Bound
 *
 * FIFO by insertion, capped at {@link REFERENCE_MEMO_CAPACITY}. Deliberately not
 * an LRU: the reuse window is one backlog being framed for its recipients, which
 * is temporally tight, and hit-promotion would add bookkeeping to buy a case that
 * costs exactly one re-parse when it misses. The cap is what keeps a long-lived
 * process from growing a shadow copy of message history.
 */
import type { Reference } from '@silverhand/shared';
import { extractMessageReferences } from '@silverhand/shared/reference-markdown';

/** The minimum an entry needs: an immutable identity and the body it names. */
export interface MemoizableMessage {
  id: string;
  content: string;
}

export interface ReferenceMemo {
  /**
   * The addressing set of this message, parsed at most once per id while the
   * entry stays resident.
   */
  referencesOf(message: MemoizableMessage): readonly Reference[];
  /** Resident entry count. Exposed for the bound's test, not for callers. */
  readonly size: number;
}

/**
 * Entries, not bytes: a `Reference[]` is a handful of small objects and the
 * bodies themselves are not retained. 512 covers a full backlog fan-out with
 * room to spare while staying trivially small.
 */
export const REFERENCE_MEMO_CAPACITY = 512;

export function createReferenceMemo(
  capacity: number = REFERENCE_MEMO_CAPACITY,
): ReferenceMemo {
  const entries = new Map<string, readonly Reference[]>();
  return {
    referencesOf(message: MemoizableMessage): readonly Reference[] {
      const hit = entries.get(message.id);
      if (hit) return hit;
      const references = extractMessageReferences(message.content);
      if (entries.size >= capacity) {
        // Map iteration is insertion order, so the first key is the oldest.
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
      entries.set(message.id, references);
      return references;
    },
    get size() {
      return entries.size;
    },
  };
}

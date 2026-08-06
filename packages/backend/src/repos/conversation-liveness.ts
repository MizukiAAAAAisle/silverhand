/**
 * Conversation liveness — the single SQL authority for "this conversation is
 * still a legitimate destination" (#task:1409 / #task:1839).
 *
 * A row is LIVE only when it EXISTS and is NOT archived. Archiving ends a
 * channel's lifecycle, so anything that would *send the viewer there* — an
 * Activity item, a notification jump pointer — must stop offering it. Deletion
 * nulls `notifications.conversation_id` (`ON DELETE SET NULL`), leaving an
 * orphan row whose destination is unknowable; those fail CLOSED (invisible)
 * rather than degrading to a workspace-level guess.
 *
 * This module is deliberately neutral infrastructure: the Activity read model
 * and the notification repo both interpolate THIS predicate, so neither has to
 * depend on the other and the two can never disagree about what "live" means —
 * the exact drift that produced #task:1409 (one assembly path missing the
 * filter the other had) and #task:1839 (archived conversations still winning
 * the workspace jump pointer).
 *
 * Scope note: the message-cursor unread definition (`unread-predicates.ts`)
 * expresses archival its own way, via `NOT EXISTS (… archived_at IS NOT NULL)`
 * correlated on `m.conversation_id`. It is NOT expected to adopt this
 * predicate: `messages.conversation_id` is `NOT NULL … ON DELETE CASCADE`, so
 * the orphan case this one fails closed on cannot exist there.
 */

/**
 * Liveness for a conversation row joined under `alias`.
 *
 * `<alias>.id IS NOT NULL` is load-bearing only for a LEFT JOIN — it drops
 * orphans. On an INNER JOIN it is a harmless tautology, kept so every caller
 * reads ONE predicate instead of hand-picking the half it thinks it needs.
 *
 * Parenthesized so it stays a single term wherever it is interpolated: callers
 * splice it into a WHERE with `AND ${...}`, where an unbracketed top-level `OR`
 * added here later would silently swallow their other filters.
 */
export function liveConversationPredicate(alias: string): string {
  return `(${alias}.id IS NOT NULL AND ${alias}.archived_at IS NULL)`;
}

/**
 * The predicate for the conventional `c` alias. Callers that already join
 * `conversations c` interpolate this directly;
 * `activity-lifecycle-conformance.test.ts` fails the archived/orphan matrix if
 * any Activity source expresses liveness any other way.
 */
export const LIVE_CONVERSATION_PREDICATE = liveConversationPredicate('c');

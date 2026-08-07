/**
 * The EFFECTIVE DIRECTED CLAIM — the single SQL definition of "someone
 * addressed ME here and I still haven't dealt with it" (#task:1870 / Cindy
 * review, docs/activity-lifecycle-v1.md §7/§8/§9.1).
 *
 * A `mention_self` notification row is NOT the claim. The claim is a DERIVED
 * fact with four conjuncts, and every one of them changes the answer:
 *
 *   1. `kind = 'mention_self'` + `read_at IS NULL` — the stored half. The other
 *      directed kinds are deliberately outside this predicate: `mention_external`
 *      is an agent's mention CC'd into its DM (not "me"), and
 *      `agent_start_failed` is ANCHORLESS, so conjunct 2 could never hold for it.
 *   2. ANCHORED — the notification points at a message that still exists. A
 *      claim with no anchor has nothing to navigate to and no position to
 *      compare against a cursor.
 *   3. ABOVE THE STREAM CURSOR — the message's `seq` is beyond the viewer's
 *      cursor for the message's OWN stream (mainline or its reply-cluster, keyed
 *      `thread_root_id IS`). §7: cursor-passed ⇒ the directed claim is CLEARED,
 *      even while `read_at` is still NULL. The cursor is the derivation; the
 *      column is not a second authority.
 *   4. AT MOST ONE PER MESSAGE — two notification rows for one message are one
 *      claim. Nothing forbids a duplicate row, so the read side must be the
 *      place that collapses it.
 *
 * Why this file exists: the Activity list, the workspace BADGE and the per-channel
 * `directed_unread_count` all answer this SAME question on different faces (a
 * list of items / a per-workspace number / a per-channel number). Cindy's review
 * of #task:1875 caught the badge having copied only HALF the rule — it counted
 * notification ROWS with no anchor, cursor or dedupe conjunct — which made a
 * lit badge with an empty Activity list reachable (badge=1, `GET /api/activity`
 * items=[]) and a duplicated notification worth 2. The fix is not "add the
 * missing clauses over there" but "there is one definition": conjuncts 1-3 live
 * in {@link EFFECTIVE_DIRECTED_MENTION_PREDICATE} and every face interpolates it
 * verbatim.
 *
 * Conjunct 4 is expressed per FACE because the two face shapes differ, and the
 * KEY is what has to match, not the code: a counting face uses
 * {@link DIRECTED_CLAIM_COUNT_EXPR} (`COUNT(DISTINCT n.message_id)`), while the
 * item-building face keys a Map by `message_id`. Both key on `message_id`; both
 * are safe because conjunct 2 guarantees it is non-NULL.
 *
 * NOT included here, on purpose — these are the caller's join, because the
 * caller is the one that decides which conversations are in scope at all:
 *   - `n.user_id = @viewer` (every caller binds `@viewer`);
 *   - conversation LIVENESS (`conversation-liveness.ts` — the archived/orphan
 *     gate) and the viewer's MEMBERSHIP in it;
 *   - the badge's tier partition (`attention-tier-predicates.ts`).
 * Splicing those in here would silently narrow a caller that has already
 * expressed them its own (correct) way.
 *
 * Requires `notifications` joined as `n`, and binds nothing but `@viewer`
 * (indirectly — the cursor lookup is keyed on `n.user_id`, so it follows the
 * notification's own owner and cannot drift from it).
 */

/**
 * Conjuncts 1-3 of the effective directed claim, as one parenthesized SQL term.
 *
 * The `dm` / `dcr` aliases are deliberately unlikely to collide with a caller's
 * (`m`, `c`, `cu`, `cr`, `vu`, `root`, `su`, `sa` are all in use somewhere).
 */
export const EFFECTIVE_DIRECTED_MENTION_PREDICATE = `(
  n.kind = 'mention_self'
  AND n.read_at IS NULL
  AND EXISTS (
    SELECT 1 FROM messages dm
     WHERE dm.id = n.message_id
       AND dm.seq > COALESCE((
         SELECT dcr.last_read_seq FROM conversation_reads dcr
          WHERE dcr.user_id = n.user_id
            AND dcr.conversation_id = n.conversation_id
            AND dcr.thread_root_id IS dm.thread_root_id
       ), 0)
  )
)`;

/**
 * Conjunct 4 for a COUNTING face: one claim per anchor message, however many
 * notification rows carry it. Pair it with
 * {@link EFFECTIVE_DIRECTED_MENTION_PREDICATE} in the WHERE clause — the
 * predicate is what makes `message_id` non-NULL, and a NULL would be skipped by
 * `COUNT(DISTINCT …)` anyway, so the two are consistent either way.
 */
export const DIRECTED_CLAIM_COUNT_EXPR = 'COUNT(DISTINCT n.message_id)';

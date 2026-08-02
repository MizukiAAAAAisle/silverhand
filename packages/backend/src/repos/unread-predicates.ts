/**
 * Shared unread SQL predicates (#task:1226 §3.5 / #task:1403 / #task:1774).
 *
 * These fragments are the SINGLE definition of "unread" for a viewer, embedded
 * verbatim by every caller across the read-model repos so the sidebar/workspace
 * roll-up, the header Threads dot, and the Unread threads view can never disagree
 * about what counts. Each references `m.conversation_id` and `@viewer`, so every
 * caller MUST alias the messages table `m` and bind `@viewer`.
 */

/**
 * Guards shared by every unread branch: a message `m` counts only when it is
 * neither a system message nor the viewer's own, AND its conversation is not
 * ARCHIVED (#task:1403 — archiving ends a channel's lifecycle, so its unread must
 * not feed ANY badge; baked in here so no caller can forget it).
 */
const UNREAD_GUARDS = `
  NOT EXISTS (
    SELECT 1 FROM conversations arch
     WHERE arch.id = m.conversation_id AND arch.archived_at IS NOT NULL
  )
  AND m.from_kind != 'system'
  AND NOT (m.from_kind = 'user' AND (m.from_user_id = @viewer OR m.from_user_id IS NULL))`;

/** Mainline branch: a non-thread message past the viewer's mainline cursor. */
const MAINLINE_UNREAD_BRANCH = `
  m.thread_root_id IS NULL
  AND m.seq > COALESCE(
    (SELECT cr.last_read_seq FROM conversation_reads cr
      WHERE cr.user_id = @viewer AND cr.conversation_id = m.conversation_id
        AND cr.thread_root_id IS NULL),
    0
  )`;

/**
 * Followed-thread branch: a reply in a thread the viewer FOLLOWS
 * (`thread_followers`, principal_kind='human'), past that thread's OWN cursor.
 *
 * This is the SOLE definition of "followed-thread unread". It is ORed into the
 * roll-up ({@link ROLLUP_UNREAD}) AND used standalone by the header Threads-icon
 * dot and the `?filter=followed-unread` threads view ({@link FOLLOWED_THREAD_UNREAD},
 * #task:1774), so the badge and the list share one predicate by construction.
 *
 * NOTE: `thread_followers` is the DELIVERY / agent-wake subscription contract
 * (#task:1226 invariant 4). It is only READ here to derive the followed/all
 * distinction; the read-model never writes it.
 */
const FOLLOWED_THREAD_UNREAD_BRANCH = `
  m.thread_root_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM thread_followers tf
     WHERE tf.thread_root_id = m.thread_root_id
       AND tf.principal_kind = 'human'
       AND tf.principal_id = @viewer
  )
  AND m.seq > COALESCE(
    (SELECT cr.last_read_seq FROM conversation_reads cr
      WHERE cr.user_id = @viewer AND cr.conversation_id = m.conversation_id
        AND cr.thread_root_id = m.thread_root_id),
    0
  )`;

/**
 * Roll-up unread (#task:1226 §3.5): mainline unread + followed-thread unread.
 * Powers the sidebar/workspace/global badges and per-conversation counts.
 */
export const ROLLUP_UNREAD = `${UNREAD_GUARDS} AND ((${MAINLINE_UNREAD_BRANCH}) OR (${FOLLOWED_THREAD_UNREAD_BRANCH}))`;

/**
 * Followed-thread unread ONLY (#task:1774): the roll-up's followed-thread branch
 * WITHOUT the mainline branch. Powers the channel-header Threads-icon dot
 * (existence) and the `?filter=followed-unread` threads view. Mainline unread
 * must NOT light the Threads dot, so it is deliberately excluded here — reusing
 * {@link ROLLUP_UNREAD} would over-light on a mainline-only unread channel.
 */
export const FOLLOWED_THREAD_UNREAD = `${UNREAD_GUARDS} AND (${FOLLOWED_THREAD_UNREAD_BRANCH})`;

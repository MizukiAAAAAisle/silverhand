/**
 * Attention TIER SQL predicates (#task:1870) — the single definition of "how
 * loud is this conversation for this viewer", shared verbatim by `enter()`
 * (read-model/activity.ts) and the badge projection (attention-badge-repo.ts).
 *
 * Two stored aggregates compose into one answer, and they compose ONE way:
 *   - the channel's own tier (`channel_attention_preferences.mode`, absent →
 *     `DEFAULT_CHANNEL_ATTENTION_MODE`);
 *   - the workspace mute SUPPRESSOR (`workspace_attention_preferences.muted`),
 *     which sits ABOVE the tier — it silences without rewriting, so a channel's
 *     own choice is always recoverable when the workspace is un-muted.
 * Expressing that composition twice is how the Activity list and the badge start
 * disagreeing about the same channel, so it lives here once.
 *
 * Every caller MUST bind `@viewer` and `@channelDefaultMode`
 * (`DEFAULT_CHANNEL_ATTENTION_MODE`). Fragments take explicit column
 * EXPRESSIONS rather than an alias because the callers differ: `enter()` resolves
 * the tier from a CTE column (`vu.conversation_id`) while the badge projection
 * resolves it from the joined `conversations c`.
 *
 * Not the delivery boundary (§5.2): these fragments read attention decisions
 * only — never `thread_followers`, never wake.
 */

/**
 * TRUE when the viewer has muted the whole workspace named by `workspaceIdExpr`.
 *
 * `NOT EXISTS … muted = 1` (rather than a COALESCE'd subselect) is what makes the
 * default free: no row and `muted = 0` are the same answer, so nothing needed
 * backfilling when the table was added. An `agent_home` workspace can never have
 * a row (DB trigger), so a DM is structurally un-mutable — the SQL needs no
 * special case for it.
 */
export function workspaceMutedPredicate(workspaceIdExpr: string): string {
  return `EXISTS (
    SELECT 1 FROM workspace_attention_preferences wap
     WHERE wap.user_id = @viewer
       AND wap.workspace_id = ${workspaceIdExpr}
       AND wap.muted = 1
  )`;
}

/**
 * The channel's OWN stored tier with the default applied — deliberately WITHOUT
 * the workspace suppressor, for surfaces that must show the user what they chose
 * (the per-channel control, the tier read face) as opposed to what they currently
 * hear.
 */
export function storedChannelModeExpr(conversationIdExpr: string): string {
  return `COALESCE((
    SELECT cap.mode FROM channel_attention_preferences cap
     WHERE cap.user_id = @viewer
       AND cap.conversation_id = ${conversationIdExpr}
  ), @channelDefaultMode)`;
}

/**
 * The EFFECTIVE tier: the workspace suppressor collapses any channel tier to
 * `'mute'`, otherwise the channel's own tier stands. This is the SQL twin of the
 * renderer's `resolveEffectiveAttentionMode(channelMode, workspaceMuted)`; the
 * two must agree by construction, which is why both read "muted wins, else the
 * stored tier" and neither invents a fourth value.
 */
export function effectiveChannelModeExpr(
  conversationIdExpr: string,
  workspaceIdExpr: string,
): string {
  return `(CASE WHEN ${workspaceMutedPredicate(workspaceIdExpr)}
                THEN 'mute'
                ELSE ${storedChannelModeExpr(conversationIdExpr)} END)`;
}

/**
 * TRUE when a CHANNEL's ambient unread is loud for this viewer: the channel's own
 * tier is `all` AND the viewer has not muted the workspace.
 *
 * This is the single ambient test. `enter()` uses it for a channel's mainline and
 * for its reply-clusters (a thread's ambient floor rides its parent channel's
 * tier, #task:1268), and the badge projection reuses it through
 * {@link loudPositionalPredicate}. The test is BINARY on purpose: the three tiers
 * are three loudness levels of ONE badge, not three eligibilities, so `mentions`
 * and `mute` are both simply "not ambient" here and differ only in how the
 * residue is later presented.
 */
export function channelAmbientEntersPredicate(
  conversationIdExpr: string,
  workspaceIdExpr: string,
): string {
  return `(
    ${storedChannelModeExpr(conversationIdExpr)} = 'all'
    AND NOT ${workspaceMutedPredicate(workspaceIdExpr)}
  )`;
}

/**
 * TRUE when a conversation's POSITIONAL unread is loud — i.e. it counts toward
 * the badge.
 *
 * A DM is directed-grade and always loud (§5.1) — it has no ambient tier to opt
 * down and no workspace pref can exist for its agent_home workspace. A channel
 * defers to {@link channelAmbientEntersPredicate}, the SAME test `enter()` uses,
 * so the badge and the Activity list agree on which conversations are ambient by
 * construction rather than by two matching hand-written clauses.
 */
export function loudPositionalPredicate(
  rosterPolicyExpr: string,
  conversationIdExpr: string,
  workspaceIdExpr: string,
): string {
  return `(
    ${rosterPolicyExpr} = 'fixed'
    OR (
      ${rosterPolicyExpr} = 'open'
      AND ${channelAmbientEntersPredicate(conversationIdExpr, workspaceIdExpr)}
    )
  )`;
}

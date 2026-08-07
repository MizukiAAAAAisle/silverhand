import type { Database as Db } from 'better-sqlite3';
import {
  DEFAULT_CHANNEL_ATTENTION_MODE,
  type ChannelAttentionModeRowDto,
} from '@silverhand/shared';
import { prepareObserved } from '../observability/observed-statement.js';
import { ROLLUP_UNREAD } from './unread-predicates.js';
import { liveConversationPredicate } from './conversation-liveness.js';
import {
  DIRECTED_CLAIM_COUNT_EXPR,
  EFFECTIVE_DIRECTED_MENTION_PREDICATE,
} from './directed-claim-predicate.js';
import {
  effectiveChannelModeExpr,
  loudPositionalPredicate,
  storedChannelModeExpr,
} from './attention-tier-predicates.js';

/**
 * The tiered BADGE projection (#task:1870 B, docs/activity-lifecycle-v1.md
 * §8/§9.1) — "how loudly should this workspace shout", as distinct from the raw
 * positional 口径's "how many messages are unread".
 *
 *   badge(workspace) = Σ positional unread over `all`-tier conversations
 *                    + Σ EFFECTIVE DIRECTED CLAIMS over `mentions`/`mute`-tier ones
 *
 * "Effective directed claim" is not a local invention: it is
 * {@link EFFECTIVE_DIRECTED_MENTION_PREDICATE}, the same live + anchored +
 * above-cursor + one-per-message rule the Activity list projects its mention
 * items from. The badge counts claims, Activity lists them; they cannot disagree
 * about WHICH claims exist, because there is one predicate. Counting raw
 * notification ROWS instead would make a lit badge with an empty Activity list
 * reachable (a mention whose stream cursor already passed it) and would count a
 * duplicated notification twice.
 *
 * A SEPARATE face, not a redefinition: `ConversationReadRepo`'s roll-ups,
 * `unread_updated.workspace_unread_count`, `FavoriteRowDto.unread_count` and the
 * notification panel's own roll-up all keep their existing answers. That
 * separation is deliberate — it is what keeps #task:1839's un-adjudicated
 * notification-panel 口径 un-adjudicated instead of silently settling it here.
 *
 * Why the two terms cannot double-count: the tiers PARTITION the viewer's
 * conversations, and an `all`-tier conversation's positional count already
 * includes the @me message (§8), so the directed term is restricted to the
 * conversations the positional term skipped. Adding directed unread everywhere
 * would count a mention twice in exactly the loud case.
 *
 * Guards are inherited, never restated: the positional term embeds
 * `ROLLUP_UNREAD` verbatim (so archived channels are fail-closed and system /
 * self messages never count), and the directed term embeds
 * `liveConversationPredicate` (so an archived or orphaned destination is
 * fail-closed too) plus `EFFECTIVE_DIRECTED_MENTION_PREDICATE` (so "a directed
 * claim" means exactly what Activity means by it).
 *
 * MEMBERSHIP IS AN INPUT, NOT A CONSTANT (§8/§10): both terms join
 * `conversation_users`, so a join / leave / removal moves this number with no
 * message, no preference write and no notification read involved — i.e. none of
 * the three sources that PUSH `attention_badge_updated`. That is deliberate:
 * per §12 a membership transition is ONE domain fact, and the events that
 * already carry it (`workspace_channels_changed`, `viewer_workspaces_changed`)
 * are the client's refetch trigger. Do NOT add a badge-specific membership
 * event here — see the regression cells in `tests/routes/attention-badge.test.ts`.
 */

/** `''` for the cross-workspace roll-up, or a filter binding `@workspace`. */
type WorkspaceFilter = '' | 'AND c.workspace_id = @workspace';

/**
 * Positional term: raw unread in the conversations that are still LOUD.
 * `ROLLUP_UNREAD` is spliced in unchanged — the badge narrows WHICH
 * conversations count, never what "unread" means.
 */
function positionalTermSql(wsFilter: WorkspaceFilter): string {
  return `SELECT c.workspace_id AS workspace_id, COUNT(m.id) AS c
            FROM conversations c
            JOIN conversation_users cu
              ON cu.conversation_id = c.id AND cu.user_id = @viewer
            JOIN messages m
              ON m.conversation_id = c.id AND ${ROLLUP_UNREAD}
           WHERE ${loudPositionalPredicate('c.kind', 'c.id', 'c.workspace_id')}
             ${wsFilter}
           GROUP BY c.workspace_id`;
}

/**
 * Directed term: EFFECTIVE DIRECTED CLAIMS in the conversations whose positional
 * unread is NOT loud. This is the residue that keeps a quiet or muted channel
 * able to reach the human — muting silences the ambient channel, never the person
 * addressing you.
 *
 * The claim's definition is interpolated, not restated
 * ({@link EFFECTIVE_DIRECTED_MENTION_PREDICATE} + the per-message collapse in
 * {@link DIRECTED_CLAIM_COUNT_EXPR}): a mention the viewer already read
 * positionally is cleared even while `read_at` is NULL, and two notification rows
 * for one message are one claim. `mention_external` (an agent's mention CC'd into
 * its DM) and `agent_start_failed` (anchorless — no conversation to be quiet
 * about) fall outside that predicate by construction: this term answers "someone
 * addressed ME here".
 *
 * The workspace is derived from the CONVERSATION, not from
 * `notifications.workspace_id`: the badge is a per-workspace conversation
 * roll-up, so its attribution must come from the same column the positional term
 * groups by or the two terms can land in different buckets.
 */
function directedTermSql(wsFilter: WorkspaceFilter): string {
  return `SELECT c.workspace_id AS workspace_id, ${DIRECTED_CLAIM_COUNT_EXPR} AS c
            FROM notifications n
            JOIN conversations c ON c.id = n.conversation_id
            JOIN conversation_users cu
              ON cu.conversation_id = c.id AND cu.user_id = @viewer
           WHERE n.user_id = @viewer
             AND ${EFFECTIVE_DIRECTED_MENTION_PREDICATE}
             AND ${liveConversationPredicate('c')}
             AND NOT ${loudPositionalPredicate('c.kind', 'c.id', 'c.workspace_id')}
             ${wsFilter}
           GROUP BY c.workspace_id`;
}

/** The two terms summed per workspace. Both variants (roll-up / single
 *  workspace) are generated from THIS one template, so their agreement is
 *  structural rather than something a test has to keep re-proving. */
function badgeSql(wsFilter: WorkspaceFilter): string {
  return `SELECT workspace_id, SUM(c) AS c FROM (
            ${positionalTermSql(wsFilter)}
            UNION ALL
            ${directedTermSql(wsFilter)}
          ) GROUP BY workspace_id`;
}

export class AttentionBadgeRepo {
  constructor(private readonly db: Db) {}

  /** Every workspace with a non-zero badge — the ONE carrier of the tiered
   *  number, read by `GET /api/attention/badges`. Workspaces at 0 are absent
   *  (absent ≡ 0), which is what lets the client answer "which workspaces are
   *  lit" from the keys alone. */
  badgeCountsByWorkspace(viewerUserId: string): Record<string, number> {
    const rows = prepareObserved<
      { viewer: string; channelDefaultMode: string },
      { workspace_id: string; c: number }
    >(this.db, 'attention.badge_counts_by_workspace', badgeSql(''))
      .all({
        viewer: viewerUserId,
        channelDefaultMode: DEFAULT_CHANNEL_ATTENTION_MODE,
      });

    const byWorkspace: Record<string, number> = {};
    for (const row of rows) if (row.c > 0) byWorkspace[row.workspace_id] = row.c;
    return byWorkspace;
  }

  /** ONE workspace's badge — the hot path behind `attention_badge_updated`. A
   *  message arrival fans out to K viewers, so the emitted value must not cost an
   *  all-workspace GROUP BY scan per viewer (the same reasoning that gave
   *  `unreadCountForWorkspace` its own statement). Same template as the roll-up
   *  above, so the two provably agree. */
  badgeCountForWorkspace(viewerUserId: string, workspaceId: string): number {
    const row = prepareObserved<
      { viewer: string; workspace: string; channelDefaultMode: string },
      { workspace_id: string; c: number }
    >(
      this.db,
      'attention.badge_count_for_workspace',
      badgeSql('AND c.workspace_id = @workspace'),
    ).get({
      viewer: viewerUserId,
      workspace: workspaceId,
      channelDefaultMode: DEFAULT_CHANNEL_ATTENTION_MODE,
    });
    return row?.c ?? 0;
  }

  /**
   * Every channel tier in ONE workspace, plus the directed residue per channel —
   * the batch read behind `GET /api/attention/modes`.
   *
   * `mode` is the channel's OWN choice and `effective_mode` folds in the
   * workspace suppressor; carrying both is what lets the UI say "muted by the
   * workspace" without re-deriving the rule, and what makes un-muting restore a
   * visible per-channel choice.
   *
   * `directed_unread_count` is carried for EVERY row, loud ones included: it
   * explains why a quiet/muted row contributes to the workspace badge. It is a
   * per-row explanation, NOT a second badge source — the badge's own arithmetic
   * lives in {@link badgeSql}. Because it is an EXPLANATION of that number, it
   * counts the same thing the badge's directed term counts: the SAME
   * {@link EFFECTIVE_DIRECTED_MENTION_PREDICATE} claims, collapsed per message.
   * A row saying 1 while the badge counted 0 (cursor already past it) or saying 2
   * for one duplicated notification would be an explanation of a different
   * number.
   */
  channelTiersForWorkspace(
    viewerUserId: string,
    workspaceId: string,
  ): ChannelAttentionModeRowDto[] {
    return prepareObserved<
      { viewer: string; workspace: string; channelDefaultMode: string },
      ChannelAttentionModeRowDto
    >(
      this.db,
      'attention.channel_tiers_for_workspace',
      `SELECT
         c.id                                                          AS conversation_id,
         ${storedChannelModeExpr('c.id')}                              AS mode,
         ${effectiveChannelModeExpr('c.id', 'c.workspace_id')}          AS effective_mode,
         (SELECT ${DIRECTED_CLAIM_COUNT_EXPR} FROM notifications n
           WHERE n.user_id = @viewer
             AND n.conversation_id = c.id
             AND ${EFFECTIVE_DIRECTED_MENTION_PREDICATE})              AS directed_unread_count
       FROM conversations c
       JOIN conversation_users cu
         ON cu.conversation_id = c.id AND cu.user_id = @viewer
      WHERE c.workspace_id = @workspace
        AND c.kind = 'channel'
        AND ${liveConversationPredicate('c')}`,
    ).all({
      viewer: viewerUserId,
      workspace: workspaceId,
      channelDefaultMode: DEFAULT_CHANNEL_ATTENTION_MODE,
    });
  }
}

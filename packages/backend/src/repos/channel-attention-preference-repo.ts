import type { Database as Db } from 'better-sqlite3';
import {
  DEFAULT_CHANNEL_ATTENTION_MODE,
  type ChannelAttentionMode,
  type ChannelAttentionPreferenceRow,
} from '@silverhand/shared';

/**
 * Per-(viewer, channel) attention mode (#task:1227 / #task:1870,
 * docs/activity-lifecycle-v1.md §9.1). One of the Attention bounded context's
 * TWO owned write-side aggregates (the other is
 * `WorkspaceAttentionPreferenceRepo`, the mute suppressor) — it stores a user
 * DECISION (the channel `所有消息 / 仅提及 / 静音` control), the policy input to
 * `enter()` (§6). Everything else Attention surfaces is a projection, never
 * stored.
 *
 * This repo answers ONLY "what did the viewer choose for this channel". The
 * workspace suppressor is folded in by `resolveEffectiveAttentionMode` /
 * the badge projection's SQL — never here, so a caller can always recover the
 * channel's own choice (which is what un-muting a workspace must restore).
 *
 * The table stores the viewer's explicit choice (which MAY equal the default —
 * we do not delete-on-default); absence of a row resolves to the default
 * (`DEFAULT_CHANNEL_ATTENTION_MODE` = ambient on). `getStoredMode` applies
 * that default server-side so callers never branch on "unset".
 *
 * NAMING (#task:1870): "stored", not "effective". Since the workspace suppressor
 * exists, `effective` means exactly one thing across this context — the tier
 * AFTER the suppressor (`effective_mode`, `resolveEffectiveAttentionMode`,
 * `effectiveChannelModeExpr`). A second meaning here is how the two faces start
 * being confused for each other.
 *
 * INVARIANT (§5.2 delivery ⊥ attention): this module never reads or writes
 * `thread_followers` / wake / delivery. It is pure attention-decision storage.
 */
export class ChannelAttentionPreferenceRepo {
  constructor(private readonly db: Db) {}

  /** Raw stored row, or undefined when the viewer has no explicit preference. */
  get(
    viewerUserId: string,
    conversationId: string,
  ): ChannelAttentionPreferenceRow | undefined {
    return this.db
      .prepare<[string, string], ChannelAttentionPreferenceRow>(
        `SELECT * FROM channel_attention_preferences
          WHERE user_id = ? AND conversation_id = ?`,
      )
      .get(viewerUserId, conversationId);
  }

  /** The channel's OWN stored tier with the default applied — WITHOUT the
   *  workspace suppressor. The SQL twin is `storedChannelModeExpr`. */
  getStoredMode(
    viewerUserId: string,
    conversationId: string,
  ): ChannelAttentionMode {
    return this.get(viewerUserId, conversationId)?.mode
      ?? DEFAULT_CHANNEL_ATTENTION_MODE;
  }

  /** Upsert the viewer's preference for one channel. Idempotent (PUT semantics):
   *  re-setting the same mode just refreshes `updated_at`. */
  upsert(params: {
    viewerUserId: string;
    conversationId: string;
    mode: ChannelAttentionMode;
  }): ChannelAttentionPreferenceRow {
    const { viewerUserId, conversationId, mode } = params;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO channel_attention_preferences
           (user_id, conversation_id, mode, updated_at)
         VALUES (@viewer, @conv, @mode, @now)
         ON CONFLICT (user_id, conversation_id)
         DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
      )
      .run({ viewer: viewerUserId, conv: conversationId, mode, now });

    const row = this.get(viewerUserId, conversationId);
    if (!row) throw new Error('channel attention preference upsert failed');
    return row;
  }

  /**
   * Seed an implicit default when a product event creates a new membership.
   * This is deliberately NOT PUT/upsert semantics: if the viewer already has a
   * stored preference for this channel, keep their explicit choice.
   */
  insertIfAbsent(params: {
    viewerUserId: string;
    conversationId: string;
    mode: ChannelAttentionMode;
  }): ChannelAttentionPreferenceRow {
    const { viewerUserId, conversationId, mode } = params;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO channel_attention_preferences
           (user_id, conversation_id, mode, updated_at)
         VALUES (@viewer, @conv, @mode, @now)`,
      )
      .run({ viewer: viewerUserId, conv: conversationId, mode, now });

    const row = this.get(viewerUserId, conversationId);
    if (!row) {
      throw new Error('channel attention preference insert-if-absent failed');
    }
    return row;
  }
}

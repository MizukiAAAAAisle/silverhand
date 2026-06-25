import type { Database as Db } from 'better-sqlite3';
import {
  DEFAULT_CHANNEL_ATTENTION_MODE,
  type ChannelAttentionMode,
  type ChannelAttentionPreferenceRow,
} from '@silverhand/shared';

/**
 * Per-(viewer, channel) ambient attention preference (#task:1227,
 * docs/activity-lifecycle-v1.md §9.1). The Attention bounded context's ONLY
 * owned write-side aggregate — it stores a user DECISION (the channel
 * `所有消息 / 仅提及` control), the policy input to `enter()` (§6). Everything
 * else Attention surfaces is a projection, never stored.
 *
 * The table stores the viewer's explicit choice (which MAY equal the default —
 * we do not delete-on-default); absence of a row resolves to the default
 * (`DEFAULT_CHANNEL_ATTENTION_MODE` = ambient off). `getEffectiveMode` applies
 * that default server-side so callers never branch on "unset".
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

  /** Effective mode with the channel default applied — the value `enter()` and
   *  the GET endpoint consume. */
  getEffectiveMode(
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
}

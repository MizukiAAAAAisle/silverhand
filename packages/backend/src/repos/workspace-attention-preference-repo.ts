import type { Database as Db } from 'better-sqlite3';
import {
  DEFAULT_WORKSPACE_ATTENTION_MUTED,
  type WorkspaceAttentionPreferenceRow,
} from '@silverhand/shared';

/**
 * Per-(viewer, workspace) attention mute SUPPRESSOR (#task:1870,
 * docs/activity-lifecycle-v1.md §9.1) — the second of the Attention bounded
 * context's two owned write-side aggregates (the other is
 * `ChannelAttentionPreferenceRepo`).
 *
 * A BOOLEAN, not a fourth tier: this scope sits ABOVE the channel tier and
 * suppresses it, so it never rewrites a channel's stored mode and un-muting the
 * workspace restores every channel's own choice exactly. That is what makes the
 * whole feature backfill-free — no existing preference row is read or rewritten
 * when a workspace is muted.
 *
 * Absence of a row resolves to `DEFAULT_WORKSPACE_ATTENTION_MUTED` (false), so
 * callers never branch on "unset". Storage keeps an explicit `muted = 0` choice
 * rather than deleting on default, mirroring the channel table.
 *
 * INVARIANT (§5.2 delivery ⊥ attention): pure attention-decision storage — never
 * `thread_followers`, never wake, never delivery.
 */
export class WorkspaceAttentionPreferenceRepo {
  constructor(private readonly db: Db) {}

  /** Raw stored row, or undefined when the viewer has no explicit choice. */
  get(
    viewerUserId: string,
    workspaceId: string,
  ): WorkspaceAttentionPreferenceRow | undefined {
    return this.db
      .prepare<[string, string], WorkspaceAttentionPreferenceRow>(
        `SELECT * FROM workspace_attention_preferences
          WHERE user_id = ? AND workspace_id = ?`,
      )
      .get(viewerUserId, workspaceId);
  }

  /** Effective mute state with the default applied — the value the GET endpoint,
   *  `enter()` and the badge projection consume. */
  isMuted(viewerUserId: string, workspaceId: string): boolean {
    const row = this.get(viewerUserId, workspaceId);
    return row ? row.muted === 1 : DEFAULT_WORKSPACE_ATTENTION_MUTED;
  }

  /**
   * Every workspace this viewer has muted AND can still see — the roll-up's
   * `muted_workspace_ids` (#task:1877).
   *
   * The `workspace_users` join is load-bearing, not defensive. "A preference row
   * exists" and "the viewer is still a member" are NOT structurally equivalent:
   * this table FKs to `users` / `workspaces` only, and removing a human from a
   * workspace deletes `workspace_users` (plus that workspace's
   * `conversation_users`) while deliberately LEAVING the preference row. The
   * cascade therefore proves the workspace still exists, never that the viewer
   * still belongs to it. Without this join a cold read after a removal would hand
   * back a workspace id the viewer cannot access — and for a user principal
   * membership in this table IS the visibility gate (`canViewWorkspace`).
   *
   * The row outliving the membership is the intended semantics — a re-join
   * restores the viewer's own earlier mute decision, with no write on either
   * edge — which is exactly why the collapse to "currently visible" belongs on
   * the READ projection rather than in a deletion cascade.
   *
   * Note the asymmetry with the single-workspace faces (`isMuted`, `GET
   * /api/attention/modes`): those take a workspace id and are already gated by
   * `canViewWorkspace` at the route. This one takes no id, so the cross-workspace
   * projection has to carry its own membership predicate.
   *
   * Absent ≡ not muted, so the explicit `muted = 0` rows are filtered out here
   * rather than shipped as a `false` the client would have to test.
   */
  mutedWorkspaceIds(viewerUserId: string): string[] {
    return this.db
      .prepare<[string, string], { workspace_id: string }>(
        `SELECT p.workspace_id AS workspace_id
           FROM workspace_attention_preferences p
           JOIN workspace_users wu
             ON wu.workspace_id = p.workspace_id AND wu.user_id = ?
          WHERE p.user_id = ? AND p.muted = 1
          ORDER BY p.workspace_id`,
      )
      .all(viewerUserId, viewerUserId)
      .map(row => row.workspace_id);
  }

  /** Upsert the viewer's suppressor for one workspace. Idempotent (PUT
   *  semantics): re-setting the same value just refreshes `updated_at`. */
  upsert(params: {
    viewerUserId: string;
    workspaceId: string;
    muted: boolean;
  }): WorkspaceAttentionPreferenceRow {
    const { viewerUserId, workspaceId, muted } = params;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO workspace_attention_preferences
           (user_id, workspace_id, muted, updated_at)
         VALUES (@viewer, @ws, @muted, @now)
         ON CONFLICT (user_id, workspace_id)
         DO UPDATE SET muted = excluded.muted, updated_at = excluded.updated_at`,
      )
      .run({ viewer: viewerUserId, ws: workspaceId, muted: muted ? 1 : 0, now });

    const row = this.get(viewerUserId, workspaceId);
    if (!row) throw new Error('workspace attention preference upsert failed');
    return row;
  }
}

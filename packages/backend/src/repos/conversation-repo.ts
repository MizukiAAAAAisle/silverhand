import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type {
  ChannelConversationDto,
  ConversationAgentDto,
  ConversationAgentRow,
  ConversationAgentStatus,
  ConversationDto,
  ConversationPlacementKind,
  ConversationRosterPolicy,
  ConversationRow,
  ConversationUserMemberDto,
  ConversationUserMemberRow,
  ConversationVisibility,
  DmChannelDto,
  UserRow,
  WorkspaceChannelListItem,
} from '@silverhand/shared';

type ConversationAgentProjectionRow = ConversationAgentRow & {
  cli_session_id: string | null;
  pid: number | null;
  status: ConversationAgentStatus;
};

/**
 * Membership stays on `conversation_agents`; runtime fields are joined from
 * the slot selected by the Agent's immutable session_scope. This is a read
 * projection only — no runtime writer may target the membership table.
 */
const CONVERSATION_AGENT_PROJECTION_SQL = `
  SELECT ca.conversation_id,
         ca.agent_id,
         ca.joined_at,
         s.cli_session_id,
         s.observed_pid AS pid,
         s.observed_status AS status
    FROM conversation_agents ca
    JOIN agents a ON a.id = ca.agent_id
    JOIN agent_runtime_slots s
      ON s.agent_id = ca.agent_id
     AND (
       (a.session_scope = 'conversation'
        AND s.conversation_id = ca.conversation_id)
       OR
       (a.session_scope = 'agent'
        AND s.conversation_id IS NULL)
     )`;

function newId(): string {
  return randomBytes(12).toString('base64url');
}

/**
 * The MINIMAL conversation projection: the id that names a conversation and the
 * workspace it belongs to, and nothing else (#task:1987).
 *
 * Deliberately not a `ConversationDto`. A caller that must not branch on titles,
 * visibility or archive state should not be handed them — and a caller that only
 * needs identity should not pay for the full UI read model either.
 */
export interface ConversationRef {
  id: string;
  workspace_id: string;
}

/**
 * The member-keyed conversation-ref query, one per membership table — spelled out
 * twice, in full, and NOT generated from a shared template. The two arms differ
 * only in which table names the member, so a template would save these few lines;
 * it would also make the `prepare` argument statically unresolvable, and dynamic
 * SQL is debt this codebase is deliberately paying down ahead of the Postgres
 * work. Drift between the arms is held by tests rather than by string reuse:
 * `tests/repos/conversation-member-refs.test.ts` runs BOTH constants through the
 * same differential oracle, the same projection assertion and the same plan
 * contract, over the exported text below.
 *
 * Both terms must be reachable as index seeks — one member's edges on one side,
 * one workspace's conversations on the other — so the join is bounded by a
 * handful of rows either way. Which side the planner drives from is deliberately
 * left to it: the two arms' selectivity is opposite (in v1 a human is a member of
 * nearly every conversation, an agent of a few), so pinning one direction would
 * pessimize the other arm.
 *
 * `ORDER BY c.updated_at DESC` is the pre-existing contract, unchanged. Ties stay
 * undefined on purpose: `id` is a random identifier, and turning it into a
 * tiebreaker would promote an accident to an externally observable ordering
 * contract inside a change whose whole point is to replace a read shape.
 */
export const WORKSPACE_CONVERSATION_REFS_FOR_AGENT_SQL = `SELECT c.id AS id, c.workspace_id AS workspace_id
     FROM conversation_agents m
     JOIN conversations c ON c.id = m.conversation_id
    WHERE m.agent_id = ? AND c.workspace_id = ?
    ORDER BY c.updated_at DESC`;

export const WORKSPACE_CONVERSATION_REFS_FOR_USER_SQL = `SELECT c.id AS id, c.workspace_id AS workspace_id
     FROM conversation_users m
     JOIN conversations c ON c.id = m.conversation_id
    WHERE m.user_id = ? AND c.workspace_id = ?
    ORDER BY c.updated_at DESC`;

// `pinned_at` is a vestigial column (#task:1209): pin/star became per-viewer
// state in `user_sort_entry`, so the shared column is no longer read or written
// and must never reach the wire. These mappers strip it from the row before it
// becomes a DTO — the type drops it too, but stripping kills the runtime leak.
//
// `placement_kind` / `roster_policy` (v69, agent-scoped-session-v1 §4.1) are
// stripped for a different reason: they are the new AUTHORITATIVE axes, but the
// wire contract for this release still speaks only the derived `kind`. Exposing
// them here would ship an unversioned DTO change from a migration-only ticket
// (#task:2012); the placement-aware wire shape lands with the placements
// themselves. A spread does NOT get excess-property-checked, so — exactly like
// `pinned_at` — only the explicit strip prevents a silent runtime leak.
function stripInternalColumns(row: ConversationRow): Omit<
  ConversationRow,
  'pinned_at' | 'placement_kind' | 'roster_policy'
> {
  const {
    pinned_at: _pinnedAt,
    placement_kind: _placementKind,
    roster_policy: _rosterPolicy,
    ...rest
  } = row;
  return rest;
}

function rowToDto(row: ConversationRow): ConversationDto {
  return { ...stripInternalColumns(row) };
}

function assertChannelLike(row: ConversationRow): ChannelConversationDto | DmChannelDto {
  if (row.kind === 'dm_channel') return rowToDmChannel(row);
  return rowToChannel(row);
}

function rowToChannel(row: ConversationRow): ChannelConversationDto {
  if (row.kind !== 'channel') {
    throw new Error('conversation is not a channel');
  }
  return { ...stripInternalColumns(row), kind: 'channel' };
}

function rowToDmChannel(row: ConversationRow): DmChannelDto {
  if (row.kind !== 'dm_channel') {
    throw new Error('conversation is not a dm_channel');
  }
  return { ...stripInternalColumns(row), kind: 'dm_channel' };
}

export class ConversationRepo {
  constructor(private readonly db: Db) {}

  list(): ConversationDto[] {
    const rows = this.db
      .prepare<[], ConversationRow>(
        'SELECT * FROM conversations ORDER BY updated_at DESC',
      )
      .all();
    return rows.map(rowToDto);
  }

  get(id: string): ConversationDto | null {
    const row = this.db
      .prepare<[string], ConversationRow>('SELECT * FROM conversations WHERE id = ?')
      .get(id);
    return row ? rowToDto(row) : null;
  }

  getChannel(id: string): ChannelConversationDto | null {
    const row = this.db
      .prepare<[string], ConversationRow>(
        `SELECT * FROM conversations
         WHERE id = ? AND kind = 'channel'`,
      )
      .get(id);
    return row ? rowToChannel(row) : null;
  }

  getDmChannel(id: string): DmChannelDto | null {
    const row = this.db
      .prepare<[string], ConversationRow>(
        `SELECT * FROM conversations
         WHERE id = ? AND kind = 'dm_channel'`,
      )
      .get(id);
    return row ? rowToDmChannel(row) : null;
  }

  getChannelLike(id: string): ChannelConversationDto | DmChannelDto | null {
    const row = this.db
      .prepare<[string], ConversationRow>(
        `SELECT * FROM conversations
         WHERE id = ? AND kind IN ('channel', 'dm_channel')`,
      )
      .get(id);
    return row ? assertChannelLike(row) : null;
  }

  /** All active (non-archived) regular channels for a workspace — IDENTITY
   *  only, no viewer. Returns every active channel regardless of visibility or
   *  membership, so it is NOT a sidebar/discovery query: use it for
   *  workspace-wide existence/fan-out needs where there is no viewer to project
   *  membership against. The per-viewer sidebar list is
   *  `listActiveChannelsForViewer`. */
  listActiveChannelsForWorkspace(workspaceId: string): ChannelConversationDto[] {
    const rows = this.db
      .prepare<[string], ConversationRow>(
        `SELECT * FROM conversations
         WHERE workspace_id = ? AND kind = 'channel' AND archived_at IS NULL
         ORDER BY created_at ASC`,
      )
      .all(workspaceId);
    return rows.map(rowToChannel);
  }

  /** Active (non-archived) regular channels for a workspace, as a per-viewer
   *  DISCOVERY UNION (`WorkspaceChannelListItem`, `kind='channel'`). Each item
   *  carries a route-computed `is_member` — the viewer-scoped bit the
   *  channel-detail envelope exposes; identity DTOs stay pure.
   *
   *  The result is the union of (a) channels the viewer has joined — any
   *  visibility, `is_member: true` — and (b) active PUBLIC channels the viewer
   *  has NOT joined — `is_member: false`, the browse-and-Join discovery surface.
   *  Private channels the viewer is not a member of are excluded. This is the
   *  authoritative channel set for BOTH the sidebar list and sort-group
   *  validation, so a public channel a viewer can see is a reorderable member of
   *  their sidebar.
   *
   *  `viewerUserId` is REQUIRED: membership is a per-viewer fact, so there is no
   *  viewer-less form of this projection (a caller needing all-active identity
   *  uses `listActiveChannelsForWorkspace`). */
  listActiveChannelsForViewer(
    workspaceId: string,
    viewerUserId: string,
  ): WorkspaceChannelListItem[] {
    const rows = this.db
      .prepare<[string, string, string], ConversationRow & { is_member: number }>(
        `SELECT conversations.*,
                EXISTS (
                  SELECT 1 FROM conversation_users cu
                   WHERE cu.conversation_id = conversations.id AND cu.user_id = ?
                ) AS is_member
           FROM conversations
          WHERE workspace_id = ? AND kind = 'channel' AND archived_at IS NULL
            AND (
              visibility = 'public'
              OR EXISTS (
                SELECT 1 FROM conversation_users cu2
                 WHERE cu2.conversation_id = conversations.id AND cu2.user_id = ?
              )
            )
          ORDER BY created_at ASC`,
      )
      .all(viewerUserId, workspaceId, viewerUserId);
    return rows.map(row => {
      const { is_member, ...conversation } = row;
      return { ...rowToChannel(conversation), is_member: is_member === 1 };
    });
  }

  /** Archived regular channels for a workspace, as per-viewer list items
   *  (`WorkspaceChannelListItem`, `kind='channel'`) — the archived twin of
   *  {@link listActiveChannelsForViewer}, so BOTH tables a user's sidebar reads
   *  carry the same authoritative `is_member` and a consumer never has to
   *  remember that "this one happens to be membership-filtered" (#task:1691).
   *
   *  Unlike the active projection there is no discovery union here: an archived
   *  channel is frozen, so the set is exactly the viewer's memberships and
   *  `is_member` is `true` on every row today. That is precisely why the carrier
   *  is COMPUTED and then filtered ON — one `EXISTS`, written once, is both the
   *  set's definition and the row's fact. Widening the set later (say, archived
   *  public channels become browsable) drops the outer filter and immediately
   *  yields real `is_member: false` rows, instead of leaving a constant `true`
   *  that silently starts lying.
   *
   *  `viewerUserId` is REQUIRED: membership is a per-viewer fact, so there is no
   *  viewer-less form (the archived-channels route reads a `getUserPrincipal`,
   *  which throws for a non-user, and agents list channels through the internal
   *  agent route). */
  listArchivedChannelsForViewer(
    workspaceId: string,
    viewerUserId: string,
  ): WorkspaceChannelListItem[] {
    const rows = this.db
      .prepare<[string, string], ConversationRow & { is_member: number }>(
        `SELECT * FROM (
           SELECT conversations.*,
                  EXISTS (
                    SELECT 1 FROM conversation_users cu
                     WHERE cu.conversation_id = conversations.id
                       AND cu.user_id = ?
                  ) AS is_member
             FROM conversations
            WHERE workspace_id = ? AND kind = 'channel'
              AND archived_at IS NOT NULL
         )
         WHERE is_member
         ORDER BY archived_at DESC, created_at ASC`,
      )
      .all(viewerUserId, workspaceId);
    return rows.map(row => {
      const { is_member, ...conversation } = row;
      return { ...rowToChannel(conversation), is_member: is_member === 1 };
    });
  }

  /** All `kind='channel'` conversations for a workspace regardless of
   *  archive state. Used when callers need to fan out (e.g. workspace
   *  rename announce) and shouldn't silently skip archived channels. */
  listAllChannelsForWorkspace(workspaceId: string): ChannelConversationDto[] {
    const rows = this.db
      .prepare<[string], ConversationRow>(
        `SELECT * FROM conversations
         WHERE workspace_id = ? AND kind = 'channel'
         ORDER BY created_at ASC`,
      )
      .all(workspaceId);
    return rows.map(rowToChannel);
  }

  /** Flat archived-channel list across all workspaces, with the parent
   *  workspace's name. Drives the global Archived chat-tool page. Sorted
   *  by `archived_at DESC, created_at ASC`. Filters: optional workspace
   *  narrowing and `since` (inclusive lower bound on archived_at, epoch ms). */
  listArchivedChannelsAggregate(opts: {
    workspaceId?: string;
    since?: number;
    forUserId?: string;
  } = {}): ArchivedAggregateRow[] {
    const where: string[] = [
      `c.kind IN ('channel', 'dm_channel')`,
      `c.archived_at IS NOT NULL`,
    ];
    const args: Array<string | number> = [];
    if (opts.workspaceId !== undefined) {
      where.push('c.workspace_id = ?');
      args.push(opts.workspaceId);
    }
    if (opts.since !== undefined) {
      where.push('c.archived_at >= ?');
      args.push(opts.since);
    }
    if (opts.forUserId !== undefined) {
      where.push(
        `EXISTS (
           SELECT 1 FROM conversation_users cu
            WHERE cu.conversation_id = c.id AND cu.user_id = ?
         )`,
      );
      args.push(opts.forUserId);
    }
    const rows = this.db
      .prepare<typeof args, ConversationRow & {
        workspace_name: string;
        workspace_archived_at: number | null;
      }>(
        `SELECT
           c.*,
           w.name AS workspace_name,
           w.archived_at AS workspace_archived_at
         FROM conversations c
         JOIN workspaces w ON w.id = c.workspace_id
         WHERE ${where.join(' AND ')}
         ORDER BY c.archived_at DESC, c.created_at ASC`,
      )
      .all(...args);
    return rows.map(r => {
      const {
        workspace_name,
        workspace_archived_at,
        ...conversation
      } = r;
      return {
        channel: assertChannelLike(conversation),
        workspace: {
          id: conversation.workspace_id,
          name: workspace_name,
          archived_at: workspace_archived_at,
        },
      };
    });
  }

  listDmChannels(): DmChannelDto[] {
    const rows = this.db
      .prepare<[], ConversationRow>(
        `SELECT * FROM conversations
         WHERE kind = 'dm_channel'
         ORDER BY created_at ASC`,
      )
      .all();
    return rows.map(rowToDmChannel);
  }

  listDmChannelForWorkspace(workspaceId: string): DmChannelDto | null {
    const row = this.db
      .prepare<[string], ConversationRow>(
        `SELECT c.*
           FROM conversations c
           JOIN workspaces w ON w.id = c.workspace_id
           LEFT JOIN agents owner ON owner.id = w.owner_agent_id
          WHERE c.workspace_id = ?
            AND c.kind = 'dm_channel'
          ORDER BY CASE
                     WHEN c.title = 'Onboarding' THEN 0
                     WHEN owner.id IS NOT NULL AND c.title = 'dm-' || owner.name THEN 1
                     ELSE 2
                   END,
                   c.created_at ASC
          LIMIT 1`,
      )
      .get(workspaceId);
    return row ? rowToDmChannel(row) : null;
  }

  // DM collection reads, mirroring the regular-channel trichotomy
  // (`listActive` / `listArchived` / `listAll` `ChannelsForWorkspace`).
  // The DM list is its own sidebar collection: archived DMs hide from the
  // active list and surface in the DM-scoped Archived view — they are
  // never merged into the regular channel lists. Active/all keep the
  // Onboarding-first ordering; archived sorts most-recently-archived first
  // (mirrors `listArchivedChannelsForViewer`).
  /** Active (non-archived) DM channels for a workspace, as per-viewer list
   *  items (`WorkspaceChannelListItem`, `kind='dm_channel'`). The DM list is
   *  STRICTLY membership-filtered by `viewerUserId`, so every returned item is
   *  one the viewer belongs to → `is_member: true` unconditionally. This keeps
   *  the workspace-channels endpoint's contract uniform: every active item a
   *  user receives carries an authoritative `is_member`, DM included, so the
   *  renderer gate never falls to unknown/detail on a DM. */
  listActiveDmChannelsForViewer(
    workspaceId: string,
    viewerUserId: string,
  ): WorkspaceChannelListItem[] {
    return this.queryDmChannelsForWorkspace(workspaceId, {
      forUserId: viewerUserId,
      archived: false,
    }).map(dm => ({ ...dm, is_member: true }));
  }

  /** Archived DM channels for a workspace, as per-viewer list items — the
   *  archived twin of {@link listActiveDmChannelsForViewer} and the DM arm of
   *  the same archived-channels endpoint, so that endpoint's contract is uniform
   *  across both workspace kinds (#task:1691).
   *
   *  Same reasoning as the active DM projection: the underlying query is
   *  STRICTLY membership-filtered, so `is_member` is `true` unconditionally. The
   *  stamp is valid ONLY because this method passes `viewerUserId` as
   *  `forUserId` — the filter and the stamp are two halves of one statement, and
   *  a viewer-less call would make the stamp a lie. */
  listArchivedDmChannelsForViewer(
    workspaceId: string,
    viewerUserId: string,
  ): WorkspaceChannelListItem[] {
    return this.queryDmChannelsForWorkspace(workspaceId, {
      forUserId: viewerUserId,
      archived: true,
    }).map(dm => ({ ...dm, is_member: true }));
  }

  /** All DM channels regardless of archive state — used where a caller
   *  must NOT silently skip archived DMs (agent-delete impact + cascade). */
  listAllDmChannelsForWorkspace(
    workspaceId: string,
    opts: { forUserId?: string } = {},
  ): DmChannelDto[] {
    return this.queryDmChannelsForWorkspace(workspaceId, opts);
  }

  private queryDmChannelsForWorkspace(
    workspaceId: string,
    opts: { forUserId?: string; archived?: boolean } = {},
  ): DmChannelDto[] {
    const args: Array<string> = [workspaceId];
    let userJoin = '';
    if (opts.forUserId !== undefined) {
      userJoin = `AND EXISTS (
        SELECT 1 FROM conversation_users cu
         WHERE cu.conversation_id = c.id AND cu.user_id = ?
      )`;
      args.push(opts.forUserId);
    }
    let archivedClause = '';
    if (opts.archived === true) {
      archivedClause = 'AND c.archived_at IS NOT NULL';
    } else if (opts.archived === false) {
      archivedClause = 'AND c.archived_at IS NULL';
    }
    const orderBy =
      opts.archived === true
        ? 'c.archived_at DESC, c.created_at ASC'
        : `CASE
                     WHEN c.title = 'Onboarding' THEN 0
                     WHEN owner.id IS NOT NULL AND c.title = 'dm-' || owner.name THEN 1
                     ELSE 2
                   END,
                   c.created_at ASC`;
    const rows = this.db
      .prepare<typeof args, ConversationRow>(
        `SELECT c.*
           FROM conversations c
           JOIN workspaces w ON w.id = c.workspace_id
           LEFT JOIN agents owner ON owner.id = w.owner_agent_id
          WHERE c.workspace_id = ?
            AND c.kind = 'dm_channel'
            ${userJoin}
            ${archivedClause}
          ORDER BY ${orderBy}`,
      )
      .all(...args);
    return rows.map(rowToDmChannel);
  }

  findDmChannelForAgent(
    agentId: string,
    opts: { title?: string } = {},
  ): DmChannelDto | null {
    const titleClause = opts.title ? 'AND c.title = ?' : '';
    const args = opts.title ? [agentId, opts.title] : [agentId];
    const row = this.db
      .prepare<typeof args, ConversationRow>(
        `SELECT c.*
           FROM conversations c
           JOIN conversation_agents ca ON ca.conversation_id = c.id
          WHERE c.kind = 'dm_channel'
            AND ca.agent_id = ?
            ${titleClause}
          ORDER BY c.created_at ASC
          LIMIT 1`,
      )
      .get(...args);
    return row ? rowToDmChannel(row) : null;
  }

  listDmChannelsForAgent(agentId: string): DmChannelDto[] {
    const rows = this.db
      .prepare<[string], ConversationRow>(
        `SELECT c.*
           FROM conversations c
           JOIN conversation_agents ca ON ca.conversation_id = c.id
          WHERE c.kind = 'dm_channel'
            AND ca.agent_id = ?
          ORDER BY c.created_at ASC`,
      )
      .all(agentId);
    return rows.map(rowToDmChannel);
  }

  /** Conversation refs for every conversation of ONE workspace that this AGENT is
   *  a member of, newest-updated first (see
   *  {@link WORKSPACE_CONVERSATION_REFS_FOR_AGENT_SQL}). One query: the caller
   *  neither lists the table nor probes membership per row. */
  listMemberConversationRefsForAgent(workspaceId: string, agentId: string): ConversationRef[] {
    return this.db
      .prepare<[string, string], ConversationRef>(WORKSPACE_CONVERSATION_REFS_FOR_AGENT_SQL)
      .all(agentId, workspaceId);
  }

  /** The human arm of {@link listMemberConversationRefsForAgent} — same shape,
   *  same order, `conversation_users` instead of `conversation_agents`. */
  listMemberConversationRefsForUser(workspaceId: string, userId: string): ConversationRef[] {
    return this.db
      .prepare<[string, string], ConversationRef>(WORKSPACE_CONVERSATION_REFS_FOR_USER_SQL)
      .all(userId, workspaceId);
  }

  insertChannel(params: {
    workspaceId: string;
    title: string;
    spawnedByAgentId?: string | null;
    /** Channel visibility; defaults to 'private'. */
    visibility?: ConversationVisibility;
  }): ChannelConversationDto {
    const row = this.insert({
      workspaceId: params.workspaceId,
      placementKind: 'workspace',
      rosterPolicy: 'open',
      title: params.title,
      spawnedByAgentId: params.spawnedByAgentId ?? null,
      visibility: params.visibility ?? 'private',
    });
    return rowToChannel(row);
  }

  insertDmChannel(params: {
    workspaceId: string;
    title: string;
    agentId?: string | null;
  }): DmChannelDto {
    const row = this.insert({
      workspaceId: params.workspaceId,
      placementKind: 'workspace',
      rosterPolicy: 'fixed',
      title: params.title,
      spawnedByAgentId: null,
    });
    return rowToDmChannel(row);
  }

  setArchived(
    id: string,
    archived: boolean,
  ): ChannelConversationDto | DmChannelDto | null {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE conversations
         SET archived_at = ?, updated_at = ?
         WHERE id = ? AND kind IN ('channel', 'dm_channel')`,
      )
      .run(archived ? now : null, now, id);
    if (result.changes === 0) return null;
    const row = this.getRaw(id);
    return row ? assertChannelLike(row) : null;
  }

  /** Rename a channel-like conversation (`channel | dm_channel`). Gated to
   *  those kinds in the WHERE clause so a thread id silently matches
   *  nothing and returns null — the service layer turns that into a typed
   *  `not_renamable` / `not_found` error. */
  updateTitle(
    id: string,
    title: string,
  ): ChannelConversationDto | DmChannelDto | null {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE conversations
         SET title = ?, updated_at = ?
         WHERE id = ? AND kind IN ('channel', 'dm_channel')`,
      )
      .run(title, now, id);
    if (result.changes === 0) return null;
    const row = this.getRaw(id);
    return row ? assertChannelLike(row) : null;
  }

  /** Set a channel's visibility (`private | public`). Gated to `kind='channel'`
   *  in the WHERE clause — a `dm_channel` / thread id matches nothing and
   *  returns null (the DB CHECK also forbids non-channel `public`), which the
   *  service turns into a typed `not_found`. */
  setVisibility(
    id: string,
    visibility: ConversationVisibility,
  ): ChannelConversationDto | null {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE conversations
         SET visibility = ?, updated_at = ?
         WHERE id = ? AND kind = 'channel'`,
      )
      .run(visibility, now, id);
    if (result.changes === 0) return null;
    const row = this.getRaw(id);
    return row ? rowToChannel(row) : null;
  }

  close(id: string, summary: string): ConversationDto | null {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE conversations
         SET closed_at = ?, close_summary = ?, status = 'archived', updated_at = ?
         WHERE id = ? AND closed_at IS NULL`,
      )
      .run(now, summary, now, id);
    return this.get(id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }

  addAgent(conversationId: string, agentId: string): ConversationAgentDto {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO conversation_agents
         (conversation_id, agent_id, joined_at)
         VALUES (?, ?, ?)`,
      )
      .run(conversationId, agentId, now);
    const row = this.db
      .prepare<[string, string], ConversationAgentProjectionRow>(
        `${CONVERSATION_AGENT_PROJECTION_SQL}
         WHERE ca.conversation_id = ? AND ca.agent_id = ?`,
      )
      .get(conversationId, agentId);
    if (!row) throw new Error('conversation_agents insert failed');
    return { ...row };
  }

  listAgents(conversationId: string): ConversationAgentDto[] {
    return this.db
      .prepare<[string], ConversationAgentProjectionRow>(
        `${CONVERSATION_AGENT_PROJECTION_SQL}
         WHERE ca.conversation_id = ?
         ORDER BY ca.joined_at ASC`,
      )
      .all(conversationId)
      .map(r => ({ ...r }));
  }

  removeAgent(conversationId: string, agentId: string): void {
    this.db
      .prepare(
        `DELETE FROM conversation_agents
         WHERE conversation_id = ? AND agent_id = ?`,
      )
      .run(conversationId, agentId);
  }

  getAgent(conversationId: string, agentId: string): ConversationAgentDto | null {
    const row = this.db
      .prepare<[string, string], ConversationAgentProjectionRow>(
        `${CONVERSATION_AGENT_PROJECTION_SQL}
         WHERE ca.conversation_id = ? AND ca.agent_id = ?`,
      )
      .get(conversationId, agentId);
    return row ? { ...row } : null;
  }

  /**
   * Placement-aware participant authority consumed by runtime target policy.
   * At schema v70 only workspace placement is representable, so participation
   * is exactly the roster predicate. P0-b extends this single resolver with the
   * owner-only AgentInbox arm; callers must not depend on `getAgent` as the
   * canonical port because an inbox deliberately has no roster row.
   */
  isAgentParticipant(conversationId: string, agentId: string): boolean {
    return this.getAgent(conversationId, agentId) !== null;
  }

  // ── Human (user) membership — `conversation_users` (v25) ─────────
  // Mirrors `addAgent` / `listAgents` / `getAgent` etc. for users.
  // Humans don't run as processes, so this table has no
  // cli_session_id / pid / status columns — just (conversation, user,
  // joined_at). v1 has at most one human per DB; the schema is
  // multi-human ready.

  addUser(
    conversationId: string,
    userId: string,
  ): ConversationUserMemberDto {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO conversation_users
         (conversation_id, user_id, joined_at)
         VALUES (?, ?, ?)`,
      )
      .run(conversationId, userId, now);
    const row = this.db
      .prepare<[string, string], ConversationUserMemberRow>(
        `SELECT * FROM conversation_users
         WHERE conversation_id = ? AND user_id = ?`,
      )
      .get(conversationId, userId);
    if (!row) throw new Error('conversation_users insert failed');
    return { ...row };
  }

  listUsers(conversationId: string): ConversationUserMemberDto[] {
    return this.db
      .prepare<[string], ConversationUserMemberRow>(
        `SELECT * FROM conversation_users
         WHERE conversation_id = ?
         ORDER BY joined_at ASC`,
      )
      .all(conversationId)
      .map(r => ({ ...r }));
  }

  listUserMembers(conversationId: string): UserRow[] {
    return this.db
      .prepare<[string], UserRow>(
        `SELECT u.*
           FROM users u
           JOIN conversation_users cu ON cu.user_id = u.id
          WHERE cu.conversation_id = ?
          ORDER BY cu.joined_at ASC`,
      )
      .all(conversationId)
      .map(r => ({ ...r }));
  }

  getUser(
    conversationId: string,
    userId: string,
  ): ConversationUserMemberDto | null {
    const row = this.db
      .prepare<[string, string], ConversationUserMemberRow>(
        `SELECT * FROM conversation_users
         WHERE conversation_id = ? AND user_id = ?`,
      )
      .get(conversationId, userId);
    return row ? { ...row } : null;
  }

  removeUser(conversationId: string, userId: string): void {
    this.db
      .prepare(
        `DELETE FROM conversation_users
         WHERE conversation_id = ? AND user_id = ?`,
      )
      .run(conversationId, userId);
  }

  private insert(params: {
    workspaceId: string;
    /** The two authoritative axes (v69). `kind` is NOT passed and NOT written:
     *  the DB derives it from `roster_policy` as a generated column, so this
     *  layer must not carry a mirrored derivation. */
    placementKind: ConversationPlacementKind;
    rosterPolicy: ConversationRosterPolicy;
    title: string;
    spawnedByAgentId: string | null;
    /** Defaults to the DB column default ('private') when
     *  omitted. Only an open roster may be 'public' (the DB CHECK enforces it). */
    visibility?: ConversationVisibility;
  }): ConversationRow {
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO conversations
         (id, workspace_id, placement_kind, roster_policy, title, status,
          spawned_by_agent_id, closed_at, close_summary,
          created_at, updated_at, visibility)
         VALUES (?, ?, ?, ?, ?, 'idle', ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        params.workspaceId,
        params.placementKind,
        params.rosterPolicy,
        params.title,
        params.spawnedByAgentId,
        now,
        now,
        params.visibility ?? 'private',
      );
    const row = this.db
      .prepare<[string], ConversationRow>('SELECT * FROM conversations WHERE id = ?')
      .get(id);
    if (!row) throw new Error('conversation insert failed');
    return row;
  }

  private getRaw(id: string): ConversationRow | null {
    const row = this.db
      .prepare<[string], ConversationRow>('SELECT * FROM conversations WHERE id = ?')
      .get(id);
    return row ?? null;
  }
}

export interface ArchivedAggregateRow {
  channel: ChannelConversationDto | DmChannelDto;
  workspace: {
    id: string;
    name: string;
    archived_at: number | null;
  };
}

export interface RepoError extends Error {
  code: string;
}

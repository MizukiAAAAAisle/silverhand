import type { Database as Db } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import {
  agentParticipates,
  DIRECT_PAIR_IDS_FOR_USER_SQL,
  PARTICIPANT_AGENT_IDS_SQL,
  PARTICIPANT_USER_IDS_SQL,
  userParticipates,
  WORKSPACE_PLACED,
} from './conversation-placement-sql.js';
import {
  AGENT_INBOX_TITLE,
  canonicalEndpointOrder,
  requireWorkspacePlacement,
} from '@silverhand/shared';
import type {
  CanonicalConversationTitle,
  ChannelConversationDto,
  ConversationAgentDto,
  ConversationAgentRow,
  ConversationDto,
  ConversationEndpointIdentity,
  ConversationEndpointRef,
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

/** Raw membership projection. Runtime state lives exclusively on
 * `agent_runtime_slots`; even a missing slot cannot remove or alter this row. */
const CONVERSATION_AGENT_PROJECTION_SQL = `
  SELECT ca.conversation_id,
         ca.agent_id,
         ca.joined_at
    FROM conversation_agents ca`;

function newId(): string {
  return randomBytes(12).toString('base64url');
}

/**
 * What a `direct_pair` row stores in `title`: NOTHING.
 *
 * `title` is the workspace arm's display state. A DM has no single label — it is
 * "the other principal" and therefore per-viewer — so the DirectPair aggregate
 * DERIVES its label from its endpoints at read time (#task:2022) instead of
 * freezing one at creation, which would then be wrong the moment a handle
 * changed. The empty string says "no stored title" honestly; a plausible-looking
 * placeholder ('Direct message', a handle) would ship a stale label to whatever
 * generic surface rendered it first.
 *
 * Exported so a test can assert the absence rather than pin a literal twice.
 */
export const DIRECT_PAIR_STORED_TITLE = '';

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
 * How a stream is SPELLED, as columns: the placement that decides which address
 * form it has, plus the stored title and the stored fold of it (#task:2021 P4-4).
 *
 * A third projection rather than a widening of {@link ConversationIdentity},
 * because these are two different questions asked by two different layers. Identity
 * answers "who may act here" and is read on every permission check, so it carries
 * no display prose; this one answers "what does its address say" and is read once
 * per framed batch. Putting `title` on identity would put a display string in front
 * of every ACL decision, and putting `roster_policy` / `visibility` here would let
 * an address renderer start judging membership.
 *
 * BOTH the title and its stored KEY are here, and the key is the load-bearing one:
 * the renderer emits a name only when re-folding the stored title reproduces the
 * stored key, which is what makes the emitted token resolve back to THIS row (the
 * resolver looks up by key). A half state — a stored key that no longer matches its
 * title — is exactly what `observability/title-address-log.ts` says must stay
 * detectable, so the renderer detects it instead of emitting an address that
 * resolves to nothing.
 */
export interface ConversationAddressFacts {
  id: string;
  placement_kind: ConversationPlacementKind;
  workspace_id: string | null;
  inbox_agent_id: string | null;
  /** `''` for a `direct_pair` — see {@link DIRECT_PAIR_STORED_TITLE}. */
  title: string;
  /** `NULL` for every placement that is not workspace-placed. */
  title_key: string | null;
  endpoint_a_kind: ConversationRow['endpoint_a_kind'];
  endpoint_a_id: string | null;
  endpoint_b_kind: ConversationRow['endpoint_b_kind'];
  endpoint_b_id: string | null;
  endpoint_a_deleted_at: number | null;
  endpoint_b_deleted_at: number | null;
}

/**
 * Identity + PLACEMENT: what a conversation is and WHERE it lives
 * (agent-scoped-session-v1 §4.1), with no UI read model attached.
 *
 * A separate projection from `ConversationDto` because it carries endpoint
 * coordinates that do not belong on the wire, and from `ConversationRef`
 * because that one asserts a workspace coordinate a row may legitimately lack.
 * This is what a consumer needs when the ANSWER DEPENDS ON THE ARM — the ACL's
 * participant rule above all: `workspace_id === null` says only "not
 * workspace-placed", never whose line it is.
 */
export interface ConversationIdentity {
  id: string;
  visibility: ConversationVisibility;
  archived_at: number | null;
  placement_kind: ConversationPlacementKind;
  /** Whether the participant set can be CHANGED at all. Carried on identity
   *  because the ACL asks it (`canAddConversationMember`, #task:2020) before it
   *  asks anything about the caller. */
  roster_policy: ConversationRosterPolicy;
  workspace_id: string | null;
  inbox_agent_id: string | null;
  endpoint_a_kind: ConversationRow['endpoint_a_kind'];
  endpoint_a_id: string | null;
  endpoint_b_kind: ConversationRow['endpoint_b_kind'];
  endpoint_b_id: string | null;
  endpoint_a_deleted_at: number | null;
  endpoint_b_deleted_at: number | null;
  /** The `direct_pair` identity scalar, DB-derived from the four endpoint
   *  coordinates (v74). Carried on identity because it IS the aggregate's name
   *  outside this table — P0-f keys the task board on `'pair:' || pair_key` — so
   *  the consumer reads it instead of re-deriving the byte format. `null` for
   *  every other placement. */
  pair_key: string | null;
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

/**
 * The send path's RECIPIENT enumeration: the LIVE agent participants of one
 * conversation, in a stable order. Exported because its ACCESS PATH is a contract
 * (#task:2021 P4-5) — `tests/read-model/participation-enumeration.test.ts`
 * EXPLAINs this exact text, following #1967's rule that a plan test must run the
 * production statement rather than a simplified copy of it.
 *
 * Two layers, and the split is the point: the placement produces CANDIDATE ids
 * ({@link PARTICIPANT_AGENT_IDS_SQL}, the one participation authority in its
 * set-shaped reading) and this statement adds what DELIVERY needs on top —
 * liveness, as a primary-key probe of `agents`, and an order. See
 * {@link ConversationRepo.listParticipantAgentIds} for why liveness is not part of
 * participation itself.
 *
 * `ORDER BY a.created_at ASC, a.id ASC` is the pre-existing recipient order,
 * unchanged. It sorts the PARTICIPANT SET — bounded by the conversation, a handful
 * of rows — so the temp b-tree it costs is not a function of how many agents exist;
 * the plan test pins that distinction rather than banning sorts.
 */
export const LIVE_PARTICIPANT_AGENT_IDS_SQL = `SELECT a.id AS agent_id
     FROM (${PARTICIPANT_AGENT_IDS_SQL}) p
     JOIN agents a ON a.id = p.agent_id
    ORDER BY a.created_at ASC, a.id ASC`;

/**
 * The VIEWER enumeration: the human participants of one conversation that are
 * real people, in a stable order (#task:2035). The human twin of
 * {@link LIVE_PARTICIPANT_AGENT_IDS_SQL}, layered the same way — the placement
 * produces candidate ids ({@link PARTICIPANT_USER_IDS_SQL}) and this statement adds
 * what a viewer face needs on top — and exported for the same reason: its ACCESS
 * PATH is a contract, EXPLAINed by
 * `tests/read-model/participation-enumeration.test.ts` over this exact text.
 *
 * `JOIN users u` is an EXISTENCE conjunct, and it is not decoration. An endpoint
 * column is a typed id with no foreign key — one column serves both principal
 * kinds — so a `direct_pair` can name a user id whose row is gone, and every
 * consumer here would then compute a viewer's unread against a person who does not
 * exist. `users` has no soft-delete axis, so for this kind "live" and "extant" are
 * the same predicate — which is why the join needs no tombstone conjunct, exactly
 * as its agent twin needs none (an agent delete is a `DELETE` too).
 *
 * The order is `u.created_at ASC, u.id ASC` — the agent statement's rule applied to
 * the other kind, sorting the PARTICIPANT SET rather than a table, so a per-message
 * fan-out cannot pay for a sort of every person in the installation.
 */
export const LIVE_PARTICIPANT_USER_IDS_SQL = `SELECT u.id AS user_id
     FROM (${PARTICIPANT_USER_IDS_SQL}) p
     JOIN users u ON u.id = p.user_id
    ORDER BY u.created_at ASC, u.id ASC`;

/**
 * The columns a DirectPair LIST row is built from: identity, the endpoint
 * coordinates the counterpart is derived from, and `created_at` as the order.
 *
 * A projection rather than `IDENTITY_COLUMNS` because the two answer different
 * questions and a list pays per row: identity carries `visibility` /
 * `roster_policy` / `workspace_id` — three constants for this placement (`private`,
 * `fixed`, `NULL`) — and `pair_key`, which is the aggregate's name for the TASK
 * board, not for a sidebar row. What this face needs beyond the coordinates is a
 * stable order, and that is `created_at`.
 */
const DIRECT_PAIR_LIST_COLUMNS = `c.id AS id,
       c.placement_kind AS placement_kind,
       c.endpoint_a_kind AS endpoint_a_kind, c.endpoint_a_id AS endpoint_a_id,
       c.endpoint_b_kind AS endpoint_b_kind, c.endpoint_b_id AS endpoint_b_id,
       c.endpoint_a_deleted_at AS endpoint_a_deleted_at,
       c.endpoint_b_deleted_at AS endpoint_b_deleted_at,
       c.created_at AS created_at`;

/**
 * ONE VIEWER'S DIRECT PAIRS, as list rows (#task:2035). Exported because its
 * ACCESS PATH is a contract, EXPLAINed by
 * `tests/read-model/participation-enumeration.test.ts` over this exact text.
 *
 * Layered exactly like the two participant statements above: the placement
 * authority produces candidate ids ({@link DIRECT_PAIR_IDS_FOR_USER_SQL}, the
 * transpose reading) and this statement adds what a LIST needs on top — the
 * endpoint columns and an order. What it deliberately does NOT add is the
 * COUNTERPART: resolving "the other one" is `directPairEndpointsOf` plus a
 * principal lookup, and a slot `CASE` in SQL would be a second answer to a
 * question shared code already answers for the ACL and the write gate.
 *
 * NO EXISTENCE CONJUNCT, and here that is a product decision rather than the
 * layering rule: a pair whose counterpart was deleted is still the survivor's
 * pair, and it is exactly the row the survivor must keep seeing (read-only) rather
 * than have vanish from their sidebar. So the join that
 * {@link LIVE_PARTICIPANT_USER_IDS_SQL} adds for a DELIVERY face is absent from
 * this READ face on purpose; the read model asks
 * `directPairIsReadOnlyForSurvivor` instead.
 *
 * `ORDER BY c.created_at ASC, c.id ASC` — when the line was opened, oldest first,
 * which is the same base order `listActiveChannelsForViewer` gives a workspace's
 * channels. NOT "most recent activity": no conversation carries a last-message
 * timestamp (`updated_at` is not bumped by a send, and `latest_message_seq` is a
 * per-conversation counter that does not compare across rows), so an activity order
 * would be a new derivation for the DM list alone while every sibling list ordered
 * by creation. `id` breaks ties so the list is deterministic within a millisecond —
 * a random tiebreak that reorders between two fetches reads as movement in the
 * sidebar.
 */
export const DIRECT_PAIRS_FOR_VIEWER_SQL = `SELECT ${DIRECT_PAIR_LIST_COLUMNS}
     FROM (${DIRECT_PAIR_IDS_FOR_USER_SQL}) p
     JOIN conversations c ON c.id = p.conversation_id
    ORDER BY c.created_at ASC, c.id ASC`;

/**
 * One row of {@link DIRECT_PAIRS_FOR_VIEWER_SQL}: a pair's identity, its endpoint
 * coordinates and when it was opened.
 *
 * EXTENDS the shared {@link ConversationEndpointRef} rather than restating the six
 * endpoint columns, so this row is accepted unchanged by `directPairEndpointsOf`
 * and `directPairIsReadOnlyForSurvivor` — the two functions that own "which slot is
 * the other one" and "may the survivor still write". A hand-rolled twin of those
 * columns would compile and then need its own copy of both rules.
 */
export interface DirectPairListRow extends ConversationEndpointRef {
  id: string;
  created_at: number;
}

// `pinned_at` is a vestigial column (#task:1209): pin/star became per-viewer
// state in `user_sort_entry`, so the shared column is no longer read or written
// and must never reach the wire. These mappers strip it from the row before it
// becomes a DTO — the type drops it too, but stripping kills the runtime leak.
//
// `title_key` (v72, #task:2016) is stripped for a third reason: it is not a
// second field, it is a DERIVED SPELLING of `title`. The wire carries the display
// title and the client folds nothing; shipping the key would invite a comparison
// that only the one canonicalizer may make.
//
// `placement_kind` / `roster_policy` stay on the DTO: P6 removes the derived
// classifier from storage and wire, so consumers must read the authoritative
// axis that answers their question. Endpoint coordinates and `pair_key` remain
// internal because they expose aggregate identity rather than presentation.
function stripInternalColumns(row: ConversationRow): Omit<
  ConversationRow,
  | 'pinned_at'
  | 'inbox_agent_id'
  | 'endpoint_a_kind'
  | 'endpoint_a_id'
  | 'endpoint_b_kind'
  | 'endpoint_b_id'
  | 'endpoint_a_deleted_at'
  | 'endpoint_b_deleted_at'
  | 'pair_key'
  | 'title_key'
> {
  const {
    pinned_at: _pinnedAt,
    inbox_agent_id: _inboxAgentId,
    endpoint_a_kind: _endpointAKind,
    endpoint_a_id: _endpointAId,
    endpoint_b_kind: _endpointBKind,
    endpoint_b_id: _endpointBId,
    endpoint_a_deleted_at: _endpointADeletedAt,
    endpoint_b_deleted_at: _endpointBDeletedAt,
    pair_key: _pairKey,
    title_key: _titleKey,
    ...rest
  } = row;
  return rest;
}

/** Row → {@link ConversationIdentity}: the ONE projection, so a second identity
 *  read cannot quietly omit a placement column (a missing `endpoint_*` would
 *  read as "no endpoints", which on the write gate fails OPEN). Every field is
 *  a column of `conversations`; queries feeding this must select all of them —
 *  which is why they all interpolate {@link IDENTITY_COLUMNS} rather than each
 *  listing the set again. */
function rowToIdentity(row: ConversationRow): ConversationIdentity {
  return {
    id: row.id,
    visibility: row.visibility,
    archived_at: row.archived_at,
    placement_kind: row.placement_kind,
    roster_policy: row.roster_policy,
    workspace_id: row.workspace_id,
    inbox_agent_id: row.inbox_agent_id,
    endpoint_a_kind: row.endpoint_a_kind,
    endpoint_a_id: row.endpoint_a_id,
    endpoint_b_kind: row.endpoint_b_kind,
    endpoint_b_id: row.endpoint_b_id,
    endpoint_a_deleted_at: row.endpoint_a_deleted_at,
    endpoint_b_deleted_at: row.endpoint_b_deleted_at,
    pair_key: row.pair_key,
  };
}

/** The column list every {@link rowToIdentity} feeder selects, spelled once. Not
 *  `SELECT *`: identity reads are placement decisions, and `*` would make the
 *  projection depend on whichever columns the table happens to have. */
const IDENTITY_COLUMNS = `id, visibility, archived_at,
       placement_kind, roster_policy, workspace_id, inbox_agent_id,
       endpoint_a_kind, endpoint_a_id,
       endpoint_b_kind, endpoint_b_id,
       endpoint_a_deleted_at, endpoint_b_deleted_at,
       pair_key`;

function rowToDto(row: ConversationRow): ConversationDto {
  return { ...stripInternalColumns(row) };
}

/** Row → {@link ConversationAddressFacts}, and the column list its one query
 *  selects. Spelled the same way as the identity pair above, for the same reason:
 *  a spelling decision that silently lost `title_key` would emit a name whose
 *  fold nobody checked. */
function rowToAddressFacts(row: ConversationRow): ConversationAddressFacts {
  return {
    id: row.id,
    placement_kind: row.placement_kind,
    workspace_id: row.workspace_id,
    inbox_agent_id: row.inbox_agent_id,
    title: row.title,
    title_key: row.title_key,
    endpoint_a_kind: row.endpoint_a_kind,
    endpoint_a_id: row.endpoint_a_id,
    endpoint_b_kind: row.endpoint_b_kind,
    endpoint_b_id: row.endpoint_b_id,
    endpoint_a_deleted_at: row.endpoint_a_deleted_at,
    endpoint_b_deleted_at: row.endpoint_b_deleted_at,
  };
}

const ADDRESS_FACTS_COLUMNS = `id, placement_kind, workspace_id, inbox_agent_id,
       title, title_key,
       endpoint_a_kind, endpoint_a_id,
       endpoint_b_kind, endpoint_b_id,
       endpoint_a_deleted_at, endpoint_b_deleted_at`;

/**
 * A channel-like DTO carries NO separate address field (#task:2016): the address
 * IS `title`, so these mappers take the plain row every other mapper takes and
 * there is nothing left to join or to split off.
 */
function assertChannelLike(
  row: ConversationRow,
): ChannelConversationDto | DmChannelDto {
  if (row.roster_policy === 'fixed') return rowToDmChannel(row);
  return rowToChannel(row);
}

function rowToChannel(row: ConversationRow): ChannelConversationDto {
  if (row.placement_kind !== 'workspace' || row.roster_policy !== 'open') {
    throw new Error('conversation is not a channel');
  }
  return { ...stripInternalColumns(row), placement_kind: 'workspace', roster_policy: 'open' };
}

function rowToDmChannel(row: ConversationRow): DmChannelDto {
  if (row.roster_policy !== 'fixed') {
    throw new Error('conversation does not have a fixed roster');
  }
  return { ...stripInternalColumns(row), roster_policy: 'fixed' };
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

  /** Identity + placement for one conversation — see {@link ConversationIdentity}.
   *  One statement, so a placement-branching consumer (the ACL) pays a single
   *  read rather than a DTO read plus a placement read. */
  getIdentity(id: string): ConversationIdentity | null {
    const row = this.db
      .prepare<[string], ConversationRow>(
        `SELECT ${IDENTITY_COLUMNS}
           FROM conversations WHERE id = ?`,
      )
      .get(id);
    return row ? rowToIdentity(row) : null;
  }

  /**
   * The columns a stream's ADDRESS is spelled from — see
   * {@link ConversationAddressFacts}. Read once per framed delivery batch, by
   * primary key.
   */
  addressFacts(id: string): ConversationAddressFacts | null {
    const row = this.db
      .prepare<[string], ConversationRow>(
        `SELECT ${ADDRESS_FACTS_COLUMNS}
           FROM conversations WHERE id = ?`,
      )
      .get(id);
    return row ? rowToAddressFacts(row) : null;
  }

  /**
   * The agent's inbox placement, keyed on the OWNERSHIP column (v71, §4.2).
   *
   * Keyed on `inbox_agent_id`, never on the title: an inbox is an invariant of
   * the Agent aggregate, so its identity is the owner edge — and
   * `idx_conversations_inbox_agent` (partial UNIQUE) makes "at most one" a
   * schema fact rather than an ORDER BY tie-break. The retired
   * `getOrCreateMentionsConversation` looked its predecessor up by
   * `title = 'Mentions'` inside the agent's home workspace, which is why two
   * concurrent mentions could create two of them.
   *
   * Returns the identity projection, not a DTO: the only fact any caller needs
   * is the conversation id, and a DTO would hand the mention CC path a
   * `workspace_id` it must not use.
   */
  getAgentInbox(agentId: string): ConversationIdentity | null {
    const row = this.db
      .prepare<[string], ConversationRow>(
        `SELECT ${IDENTITY_COLUMNS}
           FROM conversations
          WHERE inbox_agent_id = ? AND placement_kind = 'agent_inbox'`,
      )
      .get(agentId);
    return row ? rowToIdentity(row) : null;
  }

  /**
   * The ONE conversation two principals share as a `direct_pair` (§4.1), or
   * `null`. Keyed on the four endpoint COORDINATES, in whichever order the caller
   * holds them — {@link canonicalEndpointOrder} normalizes, so `(x, y)` and
   * `(y, x)` are the same aggregate and not two rows racing for one DM.
   *
   * Keyed on the coordinates rather than on the derived `pair_key` on purpose:
   * that key's byte format is defined by the v74 migration and must not be
   * re-implemented here, so the lookup that a caller reaches for is the one whose
   * inputs it already has. `idx_conversations_direct_pair_endpoints` (partial
   * UNIQUE) makes "at most one" a schema fact, so this returns a row and not a
   * list.
   *
   * Tombstones are NOT filtered: a DM whose other endpoint's principal is gone is
   * still the DM those two shared, which is the entire reason an endpoint is a
   * historical coordinate. Read-only-ness is the WRITE gate's answer
   * (`canPostToConversation`), derived from these same columns.
   */
  findDirectPair(
    x: ConversationEndpointIdentity,
    y: ConversationEndpointIdentity,
  ): ConversationIdentity | null {
    const [a, b] = canonicalEndpointOrder(x, y);
    const row = this.db
      .prepare<[string, string, string, string], ConversationRow>(
        `SELECT ${IDENTITY_COLUMNS}
           FROM conversations
          WHERE placement_kind = 'direct_pair'
            AND endpoint_a_kind = ? AND endpoint_a_id = ?
            AND endpoint_b_kind = ? AND endpoint_b_id = ?`,
      )
      .get(a.kind, a.id, b.kind, b.id);
    return row ? rowToIdentity(row) : null;
  }

  /**
   * GET-OR-CREATE the `direct_pair` conversation for two principals — the
   * DirectPair aggregate's only constructor (§4.1/§4.2).
   *
   * ONE aggregate serves `human`↔`agent`, `agent`↔`agent` and `human`↔`human`:
   * the endpoints are typed coordinates, so a DM between two agents is not a
   * special mechanism, it is the same row with a different pair of kinds. Nothing
   * here branches on kind, and that is the point.
   *
   * CONCURRENCY IS THE DB'S JOB. Two callers racing for the same pair both
   * INSERT; the partial UNIQUE index elects one and `ON CONFLICT … DO NOTHING`
   * turns the loser into a no-op, which then reads the winner's row. So there is
   * no read-then-write window to lose, no retry loop, and no application-side
   * lock — the same shape as the inbox's `idx_conversations_inbox_agent`, and the
   * reason the retired `getOrCreateMentionsConversation` (keyed on a title, not a
   * constraint) could produce two rows.
   *
   * FAIL-CLOSED CREATION comes from the schema, not from a check here: v73's
   * birth trigger ABORTS unless each endpoint names a live principal of its own
   * kind, so a typo'd id or an id from the wrong namespace is a thrown error and
   * never a DM with nobody in it. Re-validating in TypeScript would add a second
   * authority that could disagree; the only rule this method owns is the one the
   * DB cannot state — a self-pair, rejected by {@link canonicalEndpointOrder} for
   * the caller's benefit.
   *
   * `created` distinguishes "this call opened the line" from "it already existed"
   * for callers that must post a first message or emit an event exactly once. It
   * is derived from the INSERT's own row count, so it is accurate under the race
   * above: the loser reports `false`.
   */
  getOrCreateDirectPair(
    x: ConversationEndpointIdentity,
    y: ConversationEndpointIdentity,
    now: number,
  ): { conversation: ConversationIdentity; created: boolean } {
    const [a, b] = canonicalEndpointOrder(x, y);
    const result = this.db
      .prepare(
        `INSERT INTO conversations
           (id, workspace_id, inbox_agent_id, placement_kind, roster_policy,
            endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id,
            title, status, visibility, created_at, updated_at)
         VALUES (?, NULL, NULL, 'direct_pair', 'fixed', ?, ?, ?, ?,
                 ?, 'idle', 'private', ?, ?)
         ON CONFLICT (endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id)
           WHERE placement_kind = 'direct_pair'
           DO NOTHING`,
      )
      .run(
        newId(),
        a.kind,
        a.id,
        b.kind,
        b.id,
        DIRECT_PAIR_STORED_TITLE,
        now,
        now,
      );
    const conversation = this.findDirectPair(a, b);
    if (!conversation) {
      // Unreachable: the INSERT either wrote this row or conflicted with it, and
      // both cases leave it present in this transaction. Loud rather than a
      // non-null assertion, because the only way here is a schema that no longer
      // means what the statement above assumes.
      throw new Error(
        'direct_pair conversation is absent immediately after get-or-create',
      );
    }
    return { conversation, created: result.changes === 1 };
  }

  getChannel(id: string): ChannelConversationDto | null {
    const row = this.db
      .prepare<[string], ConversationRow>(
        `SELECT *
           FROM conversations
          WHERE id = ? AND placement_kind = 'workspace' AND roster_policy = 'open'`,
      )
      .get(id);
    return row ? rowToChannel(row) : null;
  }

  getDmChannel(id: string): DmChannelDto | null {
    const row = this.db
      .prepare<[string], ConversationRow>(
        `SELECT *
           FROM conversations
          WHERE id = ? AND roster_policy = 'fixed'`,
      )
      .get(id);
    return row ? rowToDmChannel(row) : null;
  }

  getChannelLike(id: string): ChannelConversationDto | DmChannelDto | null {
    const row = this.db
      .prepare<[string], ConversationRow>(
        `SELECT *
           FROM conversations
          WHERE id = ?`,
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
        `SELECT *
           FROM conversations
          WHERE workspace_id = ? AND placement_kind = 'workspace'
            AND roster_policy = 'open' AND archived_at IS NULL
          ORDER BY created_at ASC`,
      )
      .all(workspaceId);
    return rows.map(rowToChannel);
  }

  /** Active (non-archived) regular channels for a workspace, as a per-viewer
   *  DISCOVERY UNION (`WorkspaceChannelListItem`, open roster). Each item
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
          WHERE workspace_id = ? AND placement_kind = 'workspace'
            AND roster_policy = 'open' AND archived_at IS NULL
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
   *  (`WorkspaceChannelListItem`, open roster) — the archived twin of
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
            WHERE workspace_id = ? AND placement_kind = 'workspace'
              AND roster_policy = 'open'
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

  /** All open-roster conversations for a workspace regardless of
   *  archive state. Used when callers need to fan out (e.g. workspace
   *  rename announce) and shouldn't silently skip archived channels. */
  listAllChannelsForWorkspace(workspaceId: string): ChannelConversationDto[] {
    const rows = this.db
      .prepare<[string], ConversationRow>(
        `SELECT *
           FROM conversations
          WHERE workspace_id = ? AND placement_kind = 'workspace'
            AND roster_policy = 'open'
          ORDER BY created_at ASC`,
      )
      .all(workspaceId);
    return rows.map(rowToChannel);
  }

  /** Flat archived-channel list across all workspaces, with the parent
   *  workspace's name. Drives the global Archived chat-tool page. Sorted
   *  by `archived_at DESC, created_at ASC`. Filters: optional workspace
   *  narrowing and `since` (inclusive lower bound on archived_at, epoch ms).
   *
   *  WORKSPACE-scoped face: every row REPORTS its owning workspace's name, so a
   *  placement without one has nothing to report. The exclusion is stated as
   *  {@link WORKSPACE_PLACED} below rather than left to the `JOIN workspaces`. */
  listArchivedChannelsAggregate(opts: {
    workspaceId?: string;
    since?: number;
    forUserId?: string;
  } = {}): ArchivedAggregateRow[] {
    const where: string[] = [
      WORKSPACE_PLACED,
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
          // Guaranteed by the `WORKSPACE_PLACED` predicate above; the assertion
          // is what TIES that SQL domain filter to this non-null DTO field, so
          // dropping the predicate reddens here instead of shipping a null id.
          id: requireWorkspacePlacement(conversation),
          name: workspace_name,
          archived_at: workspace_archived_at,
        },
      };
    });
  }

  /** Every workspace-placed DM channel, across all workspaces.
   *
   *  `WORKSPACE_PLACED` is load-bearing here, and in the OPPOSITE direction from
   *  the other placement predicates in this file: `kind` is GENERATED from
   *  `roster_policy`, so an agent inbox (necessarily `fixed`) reports
   *  fixed-roster rows too. Without the predicate this face would silently
   *  GAIN one row per agent — an unfiltered `kind` scan is the one shape where a
   *  new placement leaks IN rather than dropping out. */
  listDmChannels(): DmChannelDto[] {
    const rows = this.db
      .prepare<[], ConversationRow>(
        `SELECT c.*
           FROM conversations c
          WHERE ${WORKSPACE_PLACED}
            AND c.roster_policy = 'fixed'
          ORDER BY c.created_at ASC`,
      )
      .all();
    return rows.map(rowToDmChannel);
  }

  listDmChannelForWorkspace(workspaceId: string): DmChannelDto | null {
    const row = this.db
      .prepare<[string], ConversationRow>(
        // Placement: the caller's UNIT IS A WORKSPACE, and `c.workspace_id = ?`
        // is itself the domain filter — a placement without a workspace has a
        // NULL there, which never equals a bound id. The `JOIN workspaces` only
        // resolves the owner agent for the title ordering; it excludes nothing
        // the WHERE clause had not already excluded.
        `SELECT c.*
           FROM conversations c
           JOIN workspaces w ON w.id = c.workspace_id
           LEFT JOIN agents owner ON owner.id = w.owner_agent_id
          WHERE c.workspace_id = ?
            AND c.roster_policy = 'fixed'
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
   *  items (`WorkspaceChannelListItem`, fixed roster). The DM list is
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
    // Placement: same as `listDmChannelForWorkspace` — the unit is a workspace
    // and `c.workspace_id = ?` is the domain filter, so the `JOIN workspaces`
    // (present only to resolve the owner agent for title ordering) removes
    // nothing on its own.
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
            AND c.roster_policy = 'fixed'
            ${userJoin}
            ${archivedClause}
          ORDER BY ${orderBy}`,
      )
      .all(...args);
    return rows.map(rowToDmChannel);
  }

  /**
   * The FIRST DM channel an agent participates in, by creation order.
   *
   * Keyed on the agent alone: the `{ title }` narrowing this face used to accept
   * was the last code in the repo that treated a channel's TITLE as an
   * identifier, and #task:2016 removes that idea — a title is display text a
   * rename may change at any time, while identity is `id` and the address is an
   * allocation in the workspace namespace. It had no production caller.
   */
  findDmChannelForAgent(agentId: string): DmChannelDto | null {
    const row = this.db
      .prepare<[string], ConversationRow>(
        `SELECT c.*
           FROM conversations c
           JOIN conversation_agents ca ON ca.conversation_id = c.id
          WHERE c.roster_policy = 'fixed'
            AND ca.agent_id = ?
          ORDER BY c.created_at ASC
          LIMIT 1`,
      )
      .get(agentId);
    return row ? rowToDmChannel(row) : null;
  }

  listDmChannelsForAgent(agentId: string): DmChannelDto[] {
    const rows = this.db
      .prepare<[string], ConversationRow>(
        `SELECT c.*
           FROM conversations c
           JOIN conversation_agents ca ON ca.conversation_id = c.id
          WHERE c.roster_policy = 'fixed'
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

  /**
   * Create a regular channel. Its TITLE IS its address (#task:2016).
   *
   * There is no second name to allocate and no second row to write: the display
   * title and the key the workspace-unique index compares arrive as ONE
   * {@link CanonicalConversationTitle}, so this face cannot store a title under
   * a key that is not its fold. A caller that already refused a conflict with a
   * typed error can still race; the partial UNIQUE index is the backstop that
   * aborts the transaction, and the service maps that to `title_taken`.
   */
  insertChannel(params: {
    workspaceId: string;
    title: CanonicalConversationTitle;
    spawnedByAgentId?: string | null;
    /** Channel visibility; defaults to 'private'. */
    visibility?: ConversationVisibility;
  }): ChannelConversationDto {
    return rowToChannel(
      this.insert({
        placement: {
          kind: 'workspace',
          workspaceId: params.workspaceId,
          title: params.title,
        },
        rosterPolicy: 'open',
        spawnedByAgentId: params.spawnedByAgentId ?? null,
        visibility: params.visibility ?? 'private',
      }),
    );
  }

  /** The DM twin of {@link insertChannel} — same address space, same rules. A DM
   *  channel is `placement_kind='workspace'` today, so it holds a title address
   *  like any other workspace placement; when P3 moves direct conversations onto
   *  their own placement they stop holding one, and this face goes with them. */
  insertDmChannel(params: {
    workspaceId: string;
    title: CanonicalConversationTitle;
    agentId?: string | null;
  }): DmChannelDto {
    return rowToDmChannel(
      this.insert({
        placement: {
          kind: 'workspace',
          workspaceId: params.workspaceId,
          title: params.title,
        },
        rosterPolicy: 'fixed',
        spawnedByAgentId: null,
      }),
    );
  }

  /**
   * The agent's inbox placement — the other half of bringing an Agent into
   * existence (v71, §4.2). Written in the SAME transaction as the `agents` row
   * (`reserveAgentAggregate`), so "an agent has exactly one inbox" is an
   * invariant of the row rather than something a mention repairs later;
   * `idx_conversations_inbox_agent` makes a second one a constraint failure.
   *
   * NOT the `pending → active` materialization graph, on purpose: the inbox needs
   * nothing materialization produces (no daemon ack, no agent dir, no host, no
   * workspace), while `AgentRepo.getByName` — the mention resolver — answers for
   * `pending_materialization` and `failed` rows too. An inbox born with the
   * status flip would mean a mention of a reserved-but-failed handle has no
   * destination (a loud throw inside the sender's own message transaction), and a
   * retry would try to insert a second inbox for a row that already has one.
   *
   * NO `conversation_agents` row, by construction: on this arc the participant IS
   * `inbox_agent_id`, and a projected roster row would be a second authority for
   * the same fact.
   *
   * `createdAt` is the OWNING AGENT's `created_at`, matching the v71 backfill
   * statement: the timestamp expresses agent-aggregate birth, not when a
   * dependent row happened to land, so an upgraded inbox and a freshly created
   * one are indistinguishable. The id is an ordinary conversation id — see
   * {@link insert} for why this arc may not mint a shape of its own.
   *
   * Returns the identity projection: an inbox has no workspace and no roster, so
   * there is no channel DTO to hand back and no wire surface that wants one.
   */
  insertAgentInbox(agentId: string, createdAt: number): ConversationIdentity {
    const row = this.insert({
      placement: { kind: 'agent_inbox', agentId },
      // The arc's CHECK requires `fixed`: an inbox roster is not open to
      // placement at all, so "open" would not merely be wrong, it is refused.
      rosterPolicy: 'fixed',
      // No title argument: an inbox's label is {@link AGENT_INBOX_TITLE} and its
      // `title_key` is NULL, both settled by the arc rather than by this caller.
      spawnedByAgentId: null,
      createdAt,
    });
    return rowToIdentity(row);
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
         WHERE id = ?`,
      )
      .run(archived ? now : null, now, id);
    if (result.changes === 0) return null;
    const row = this.getRaw(id);
    return row ? assertChannelLike(row) : null;
  }

  /**
   * Is `key` held by a workspace-placed conversation of `workspaceId`
   * (#task:2016)?
   *
   * The predicate is the INDEX's, spelled the same way: `placement_kind =
   * 'workspace'` is not redundant with `workspace_id = ?` for the planner (it is
   * what makes this read the partial unique index), and it is the same clause the
   * insert must satisfy — so this answers the conflict the write would actually
   * hit, not a similar one.
   *
   * `exceptConversationId` is how a rename asks "taken by SOMEONE ELSE": a
   * conversation re-titling to a form of its own current title (`general` →
   * `General`) keeps the address it already holds, and that must succeed.
   *
   * Authoritative only under a write lock. The caller (a UnitOfWork scope) owns
   * that obligation; nothing outside a transaction may treat this as more than a
   * hint, which is why no read model exposes it.
   */
  isTitleKeyTaken(
    workspaceId: string,
    key: string,
    exceptConversationId?: string,
  ): boolean {
    const row = this.db
      .prepare<[string, string, string], { one: number }>(
        `SELECT 1 AS one
           FROM conversations
          WHERE placement_kind = 'workspace'
            AND workspace_id = ?
            AND title_key = ?
            AND id <> ?
          LIMIT 1`,
      )
      .get(workspaceId, key, exceptConversationId ?? '');
    return row !== undefined;
  }

  /**
   * The workspace-placed conversation of `workspaceId` holding `key` — the second
   * half of a readable address (#task:2021 P4-4).
   *
   * The SAME predicate as {@link isTitleKeyTaken}, for the same planner reason
   * (`placement_kind = 'workspace'` is what reaches the partial unique index), but
   * a different question and therefore a different method: this one is a READ
   * outside any write lock and returns the row, while the other answers "would my
   * insert conflict" and is authoritative only under one. Sharing an
   * implementation would have made the second answer look available to a read
   * surface.
   *
   * Returns the identity projection: an address resolver needs the id and the
   * placement arm, and a DTO would hand it columns whose freshness it has no lock
   * for.
   *
   * `LIMIT 1` is a statement of what the index already guarantees, not a
   * tie-break: the partial UNIQUE makes two holders impossible, so there is no
   * ordering question to answer here — a second row would be corruption, which
   * the boot audit reports and this read must not paper over by choosing one.
   */
  findWorkspaceTitle(workspaceId: string, key: string): ConversationIdentity | null {
    const row = this.db
      .prepare<[string, string], ConversationRow>(
        `SELECT ${IDENTITY_COLUMNS}
           FROM conversations
          WHERE placement_kind = 'workspace'
            AND workspace_id = ?
            AND title_key = ?
          LIMIT 1`,
      )
      .get(workspaceId, key);
    return row ? rowToIdentity(row) : null;
  }

  /**
   * Rename a channel-like conversation — which MOVES ITS ADDRESS (#task:2016).
   *
   * `title` and `title_key` are written by the same statement from the same
   * {@link CanonicalConversationTitle}, so there is no instant at which the row
   * shows one name and answers to another, and no caller that can update one
   * without the other. The old address is released by this statement and nothing
   * remembers it: the next rename may take it, including back again.
   *
   * Gated to those kinds in the WHERE clause so a thread id silently matches
   * nothing and returns null — the service layer turns that into a typed
   * `not_renamable` / `not_found` error. A UNIQUE violation is NOT swallowed
   * here: it propagates, and the service maps it to `title_taken`.
   *
   * It reports the address it RELEASED alongside the row it wrote, because it is
   * the only thing that ever holds both: nothing remembers the old key
   * afterwards, and the observation face that replaced retired-title ownership
   * (`observability/title-address-log.ts`) is the sole record that key ever
   * belonged here. `releasedKey` is the STORED value, not `canonicalize(old
   * title)` — a stored key that has drifted from its title is a detectable
   * runtime state rather than an impossible one, and the address that was
   * actually occupied is whatever the column said.
   */
  updateTitle(
    id: string,
    title: CanonicalConversationTitle,
  ): {
    channel: ChannelConversationDto | DmChannelDto;
    releasedKey: string | null;
  } | null {
    const before = this.getRaw(id);
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE conversations
         SET title = ?, title_key = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(title.title, title.key, now, id);
    if (result.changes === 0) return null;
    const row = this.getRaw(id);
    if (!row) return null;
    return {
      channel: assertChannelLike(row),
      releasedKey: before?.title_key ?? null,
    };
  }

  /** Set a channel's visibility (`private | public`). Gated to the
   *  workspace/open-roster arm in the WHERE clause, so fixed-roster and thread
   *  ids match nothing and return null. The service turns that into a typed
   *  `not_found`; the DB placement arc also forbids those rows from becoming
   *  public. */
  setVisibility(
    id: string,
    visibility: ConversationVisibility,
  ): ChannelConversationDto | null {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE conversations
         SET visibility = ?, updated_at = ?
         WHERE id = ? AND placement_kind = 'workspace' AND roster_policy = 'open'`,
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

  /**
   * Delete a conversation. One statement, no companion bookkeeping (#task:2016).
   *
   * Deleting the row RELEASES its title, because the address lives in that row:
   * there is no allocation table left to retire, and therefore no half-state in
   * which a vanished conversation still holds a name — the class of leak the
   * retired-slug design needed a transaction to avoid.
   *
   * NOTE (stated rather than silently assumed): no production path calls this
   * face today. The only production code that removes conversation rows is
   * workspace deletion, whose `workspace_id` cascade drops the whole workspace's
   * conversations and with them their addresses.
   */
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
      .prepare<[string, string], ConversationAgentRow>(
        `${CONVERSATION_AGENT_PROJECTION_SQL}
         WHERE ca.conversation_id = ? AND ca.agent_id = ?`,
      )
      .get(conversationId, agentId);
    if (!row) throw new Error('conversation_agents insert failed');
    return { ...row };
  }

  listAgents(conversationId: string): ConversationAgentDto[] {
    return this.db
      .prepare<[string], ConversationAgentRow>(
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
      .prepare<[string, string], ConversationAgentRow>(
        `${CONVERSATION_AGENT_PROJECTION_SQL}
         WHERE ca.conversation_id = ? AND ca.agent_id = ?`,
      )
      .get(conversationId, agentId);
    return row ? { ...row } : null;
  }

  /**
   * PARTICIPATION — "is this agent one of the conversation's participants?" —
   * which is NOT the same question as {@link getAgent}, "is there a roster row?".
   *
   * For the workspace arm the two coincide: participants ARE the
   * `conversation_agents` rows. For `agent_inbox` and `direct_pair` there is
   * deliberately no roster row (§4.2, Cindy `SEfG0TUfDkOaB9xn`): the placement
   * itself names the participants — `inbox_agent_id` for the one, the two typed
   * endpoints for the other — so a caller asking about MEMBERSHIP must ask this,
   * while a caller that needs runtime state must query the scoped slot read
   * model independently.
   *
   * The rosterless arms make this predicate STRICTLY WIDER than `getAgent`, which
   * is what P2's runtime target gate and the delivery faces need in order to
   * reach a DM at all; and the workspace arm is now placement-gated, so a roster
   * row that somehow exists on a non-workspace placement is inert here too.
   *
   * The predicate is the boolean form of `agentParticipates`, the same SQL the
   * embedded read faces splice in, so there is ONE definition of participation
   * rather than a TS copy that drifts from the query text.
   */
  isAgentParticipant(conversationId: string, agentId: string): boolean {
    const { sql, params } = agentParticipates('c', agentId);
    const row = this.db
      .prepare<string[], { ok: number }>(
        `SELECT 1 AS ok FROM conversations c WHERE c.id = ? AND ${sql}`,
      )
      .get(conversationId, ...params);
    return row !== undefined;
  }

  /**
   * PARTICIPATION for a HUMAN — the same question as
   * {@link isAgentParticipant}, asked of the other principal kind, and answered
   * by the same authority (`userParticipates`, the SQL face of §4.2). One
   * predicate per kind rather than one polymorphic one: the arms differ (a human
   * channel seat is two facts, an inbox has no human arm at all), and a shared
   * signature would have to take a tagged principal and branch inside the SQL.
   *
   * Its first caller is the send's write gate, which asks participation of every
   * actor kind INSIDE the transaction (#task:2021 P4-4) — before that
   * the human answer was only ever computed at the request layer, so a person
   * removed from a channel could still win the race to write into it.
   */
  isUserParticipant(conversationId: string, userId: string): boolean {
    const { sql, params } = userParticipates('c', userId);
    const row = this.db
      .prepare<string[], { ok: number }>(
        `SELECT 1 AS ok FROM conversations c WHERE c.id = ? AND ${sql}`,
      )
      .get(conversationId, ...params);
    return row !== undefined;
  }

  /**
   * The conversation's AGENT PARTICIPANTS, as ids and nothing else — the
   * recipient enumeration of the send path (#task:2021 P4-5).
   *
   * Why not {@link listAgents}: that returns `conversation_agents` rows, so on a
   * `direct_pair` or an `agent_inbox` — rosterless by construction (§4.2) — it
   * returns the empty set, and a message committed into a DM was delivered to
   * NOBODY. The participants are named by the placement, so the enumeration is the
   * placement's own set-shaped text ({@link PARTICIPANT_AGENT_IDS_SQL}) rather
   * than a second query with an arm per placement.
   *
   * TWO CONJUNCTS, and the second is not decoration (#task:2021 P4-5):
   * participation deliberately ignores `endpoint_*_deleted_at` so a survivor
   * keeps reading its own DM, while a DELIVERY target must also be a LIVE
   * principal — `JOIN agents a` is that conjunct, and it is what keeps a deleted
   * endpoint out of the fan-out without weakening participation for the reader.
   *
   * The join is also the ACCESS PATH: the placement produces the
   * candidate ids and `agents` is probed by primary key, so cost tracks the
   * conversation's own size. The predicate reading of the same rule would have to
   * offer `agents` as the candidate set — a full scan of every agent in the
   * installation, once per message — which is what this shape replaced and what
   * the EXPLAIN falsifier in `tests/read-model/participation-enumeration.test.ts`
   * forbids coming back.
   *
   * IDS ONLY, deliberately. The callers (delivery, auto-start) need a principal
   * identity; the membership DTO they used to take carries `joined_at` plus the
   * runtime seat columns, which a DM participant does not have at all — and
   * fabricating a row for one would put a membership fact into a placement that
   * has none.
   */
  listParticipantAgentIds(conversationId: string): string[] {
    return this.db
      .prepare<{ conv: string }, { agent_id: string }>(LIVE_PARTICIPANT_AGENT_IDS_SQL)
      .all({ conv: conversationId })
      .map(r => r.agent_id);
  }

  /**
   * The conversation's HUMAN PARTICIPANTS, as ids and nothing else — the viewer
   * enumeration every `viewer:<id>`-scoped read face fans out over (#task:2035).
   *
   * Why not {@link listUsers}: that returns `conversation_users` rows, so on a
   * `direct_pair` — rosterless by construction (§4.2) — it returns the empty set,
   * and every viewer frame for a DM was published to NOBODY while the message row
   * was durable. That is the human-side twin of the delivery defect
   * {@link listParticipantAgentIds} fixed, and it is the reported bug behind this
   * ticket: an agent DMs a person, the message commits, and their sidebar never
   * hears about it.
   *
   * It is also STRICTLY NARROWER than `listUsers` on the workspace arm, which is a
   * fix in the same direction: a `conversation_users` seat that outlived its
   * `workspace_users` membership is not a participant (the v25 pair), so it no
   * longer receives that channel's viewer frames. The predicate face
   * ({@link isUserParticipant}) has always answered `false` for that person — this
   * face used to answer `true`, and one of the two had to be wrong.
   *
   * IDS ONLY, for {@link listParticipantAgentIds}'s reason: the membership DTO
   * carries `joined_at`, which a DM endpoint does not have, and fabricating one
   * would put a membership fact into a placement that has none.
   */
  listParticipantUserIds(conversationId: string): string[] {
    return this.db
      .prepare<{ conv: string }, { user_id: string }>(LIVE_PARTICIPANT_USER_IDS_SQL)
      .all({ conv: conversationId })
      .map(r => r.user_id);
  }

  /**
   * The viewer's DIRECT PAIRS, as list rows (#task:2035) — the transpose of
   * {@link listParticipantUserIds}: that one asks who is in a conversation, this
   * one asks which conversations a person is in, for the placement that has no
   * workspace to enumerate them under.
   *
   * A SEPARATE FACE from every channel list, not an arm of one. A `direct_pair`
   * carries no workspace coordinate, so it cannot ride
   * `GET /api/workspaces/:id/channels` — there is no `:id` it belongs to — and
   * widening that route to "and also the viewer's DMs" would make a
   * workspace-scoped response depend on which workspace the client happened to ask
   * about first.
   *
   * ROWS, NOT A DTO. The counterpart's display identity is a lookup in another
   * aggregate (an agent or a user), so composing it here would put a second
   * principal read inside the conversation repo. The read model does that
   * composition; this face's job ends at the placement.
   */
  listDirectPairsForViewer(viewerUserId: string): DirectPairListRow[] {
    return this.db
      .prepare<{ viewer: string }, DirectPairListRow>(DIRECT_PAIRS_FOR_VIEWER_SQL)
      .all({ viewer: viewerUserId });
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

  /**
   * The one INSERT. `placement` is a DISCRIMINATED UNION, not a
   * `placementKind` + nullable columns triple, because the DB's arc CHECK is
   * exactly that shape: each placement names the columns it owns and NULLs every
   * other arc's. Passing them separately would make "workspace placement with an
   * `inbox_agent_id`" a expressible-but-refused call — a runtime constraint
   * failure standing in for a type error.
   */
  private insert(params: {
    /**
     * The placement CARRIES the title address (#task:2016), because holding one
     * is a property of the placement and not of a conversation: a workspace
     * placement must supply the canonical pair, an inbox has no address to give.
     * That makes the arc CHECK (`title_key IS NOT NULL` exactly on the workspace
     * arc) a fact of this type too, so the impossible combination cannot be
     * spelled here and then be refused by SQLite at runtime.
     */
    placement:
      | {
          kind: 'workspace';
          workspaceId: string;
          title: CanonicalConversationTitle;
        }
      | { kind: 'agent_inbox'; agentId: string };
    /** The roster axis (v69). `kind` is NOT passed and NOT written: the DB
     *  derives it from `roster_policy` as a generated column, so this layer must
     *  not carry a mirrored derivation. */
    rosterPolicy: ConversationRosterPolicy;
    spawnedByAgentId: string | null;
    /** Defaults to the DB column default ('private') when
     *  omitted. Only an open roster may be 'public' (the DB CHECK enforces it). */
    visibility?: ConversationVisibility;
    /** `created_at`/`updated_at`, when the caller owns a truer birth instant
     *  than "now" — see {@link insertAgentInbox}. Defaults to the wall clock. */
    createdAt?: number;
  }): ConversationRow {
    // Every placement gets a fresh opaque id from the ONE generator: a
    // conversation id is a domain value object (12 random bytes as 16 chars of
    // base64url) and the canonical `#conv:<id>` grammar accepts exactly that, so
    // no arc may mint a shape of its own.
    const id = newId();
    const now = params.createdAt ?? Date.now();
    // An inbox's title is a fixed label rather than an address: it is the same
    // string for every agent, it is never renamed, and `title_key` stays NULL so
    // it occupies nothing in any workspace's namespace.
    const { title, titleKey } =
      params.placement.kind === 'workspace'
        ? { title: params.placement.title.title, titleKey: params.placement.title.key }
        : { title: AGENT_INBOX_TITLE, titleKey: null };
    this.db
      .prepare(
        `INSERT INTO conversations
         (id, workspace_id, inbox_agent_id, placement_kind, roster_policy, title,
          title_key, status, spawned_by_agent_id, closed_at, close_summary,
          created_at, updated_at, visibility)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        params.placement.kind === 'workspace' ? params.placement.workspaceId : null,
        params.placement.kind === 'agent_inbox' ? params.placement.agentId : null,
        params.placement.kind,
        params.rosterPolicy,
        title,
        titleKey,
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

  /** Re-read a conversation for the three single-statement UPDATE faces above,
   *  each of which returns a DTO built from the row it just wrote. */
  private getRaw(id: string): ConversationRow | null {
    return (
      this.db
        .prepare<[string], ConversationRow>('SELECT * FROM conversations WHERE id = ?')
        .get(id) ?? null
    );
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

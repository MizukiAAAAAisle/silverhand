// Read-model for the Activity list (#task:1227, docs/activity-lifecycle-v1.md
// §9.2 `listActivity`). Attention is a read-side bounded context: it owns NO
// activity/read/done state. Every item here is projected from an existing
// source — the per-stream cursor read-model (#1226 `conversation_reads` /
// `conversation_stream_heads`) and `notifications` (`read_at`) — and recomputed
// on each read. Dependency direction is one-way: routes → read-model. Nothing
// in this file writes.
//
// NOTE — `kind=task` is intentionally NOT projected in v1. An
// `in_review && member` projection of `messages.task_*` mirrored the task
// panel's In-review column as a permanent, non-eliminable Activity item (its
// only clearance was `task_status`, never observation) — a standing duplicate
// of another bounded context's inventory, the one Activity kind that wasn't a
// read-cleared attention event. Tasks live in the task panel; a task-related
// message still reaches Activity via the mention/unread paths. A task source
// re-enters Activity only when it is event-shaped & notification-backed — a
// `task_needs_review(viewer)` notification with a real reviewer relation,
// read-cleared like a mention (docs/activity-lifecycle-v1.md §5.1, v2).
//
// Assembly (§6/§7/§8):
//   1. directed notifications — `mention_self` (the EFFECTIVE DIRECTED CLAIM:
//      unread + anchored + above the anchor's own stream cursor, §7
//      cursor-passed ⇒ directed cleared — defined once in
//      `repos/directed-claim-predicate.ts` and shared with the badge / the
//      per-channel directed count) + `agent_start_failed` (anchorless, cleared
//      by `read_at` alone).
//   2. The §7 per-(viewer, message) de-dupe runs in TS: at most one directed
//      claim per message — the same fourth conjunct the counting faces express
//      as `COUNT(DISTINCT n.message_id)`. The DISTINCT set of directed message
//      ids is then excluded from the positional query, so §8
//      (`positional \ directed`) is computed in SQL — the ambient row's count AND
//      its first-unread anchor/preview/timestamp are the first NON-directed
//      unread message, never a message already shown as a mention. Because the
//      positional base already drops system / the viewer's own messages, a
//      directed message that wouldn't be ambient is simply absent (no spurious
//      subtraction).
//   3. positional streams — per-(conversation, stream) ambient/DM unread,
//      `enter()`-filtered in SQL (DM always; channel mainline iff the viewer's
//      EFFECTIVE attention tier = 'all' — the channel's own tier with the
//      viewer's workspace mute folded in, #task:1870; threads iff followed AND
//      the parent channel's effective tier = 'all' — follow is a delivery
//      precondition, necessary not sufficient, #task:1268).
// Then salience is derived (DM = directed-grade) and the list sorted §13.2:
// directed tier first, most-recent-first within a tier.
//
// PLACEMENT SCOPE (#task:2115). Activity spans BOTH conversation placements:
// workspace channels and workspace-less `direct_pair` lines. It used to be
// workspace-only, and that was a real defect rather than a scope: a DM's unread
// is directed-grade by definition, so the one item class the human is most
// obliged to answer was the one class the global rail could not show
// (docs/activity-lifecycle-v1.md — DM unread always enters Activity). The
// restriction was introduced to stop shipping an UNOPENABLE item (an empty
// `workspace_id` + empty title, #task:2035 Cindy FAIL 3); what removes it for
// good is the DTO, which now carries WHERE the item is as a discriminated union
// (`ActivityLocation`) instead of a workspace coordinate every item had to have.
// Both sources therefore carry a PARTICIPATION MERGE — the workspace roster seat
// (authoritative for the workspace arm only) UNIONed with the `direct_pair`
// endpoint transpose `DIRECT_PAIR_IDS_FOR_USER_SQL` — and neither invents an arm
// of its own, so "may this viewer see this stream" has one answer per placement.
// #task:1983 W2 — the handle is bound at ASSEMBLY time
// (`createActivityReadModel`), not read out of a god-context per call: this
// projection only ever needed `db`, and taking the whole `BackendContext` is
// what made the read side look like it had ambient access to everything.
import type { Database as Db } from 'better-sqlite3';
import { prepareObserved } from '../observability/observed-statement.js';
import { channelAmbientEntersPredicate } from '../repos/attention-tier-predicates.js';
import { LIVE_CONVERSATION_PREDICATE } from '../repos/conversation-liveness.js';
import {
  DIRECT_PAIR_IDS_FOR_USER_SQL,
  WORKSPACE_PLACED,
  workspacePlaced,
} from '../repos/conversation-placement-sql.js';
import { EFFECTIVE_DIRECTED_MENTION_PREDICATE } from '../repos/directed-claim-predicate.js';
import {
  apiPaths,
  DEFAULT_CHANNEL_ATTENTION_MODE,
  principalAvatarUrl,
  requireWorkspacePlacement,
  resolveMessageAuthor,
  type ActivityItemDto,
  type ActivityLocation,
  type ActivitySalience,
  type ConversationEndpointRef,
  type ConversationPlacementKind,
  type ListActivityDto,
  type MessageAuthorDto,
  type MessageAuthorLiveActor,
  type RuntimeKind,
} from '@silverhand/shared';
import {
  createPrincipalResolver,
  resolveCounterpart,
  type CounterpartResolution,
} from './direct-pair-counterpart.js';


export interface ListActivityParams {
  viewerUserId: string;
  /** Optional workspace filter. The data model and v1 Activity UI are global,
   *  so the normal caller omits this filter. This param stays as an opt-in
   *  scope for callers that want one workspace; absent = every workspace the
   *  viewer can see. */
  workspaceId?: string;
}

const PREVIEW_MAX = 140;

/**
 * Activity's lifecycle gate is {@link LIVE_CONVERSATION_PREDICATE}, defined in
 * `repos/conversation-liveness.ts`: an item is visible ONLY while its
 * conversation is live. Every Activity source that joins the conversation as
 * `c` interpolates THAT constant — never a hand-written `archived_at IS NULL` —
 * and `activity-lifecycle-conformance.test.ts` fails the archived/orphan matrix
 * if any source omits it.
 *
 * Defining it once (instead of re-typing the filter per query) is the
 * structural fix behind #task:1409: that bug was one assembly path (the
 * directed query) silently missing the filter the other path (positional) had.
 * #task:1839 moved the definition out to a neutral module so the notification
 * jump pointer reads the SAME authority without this read model becoming a
 * dependency of the repos layer.
 */

function preview(text: string | null | undefined): string | null {
  if (!text) return null;
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length === 0) return null;
  return compact.length > PREVIEW_MAX
    ? `${compact.slice(0, PREVIEW_MAX - 1)}…`
    : compact;
}

/** Row fields carrying the anchor message's author, server-resolved so the
 *  global list never client-stitches a cross-workspace sender. Carries BOTH the
 *  message's provenance FKs + send-time snapshot (the {@link MessageAuthorRow}
 *  evidence) AND the joined LIVE actor columns, so {@link buildPreviewSender}
 *  can feed the SAME pure {@link resolveMessageAuthor} the message/thread reads
 *  use — a hard-deleted sender resolves to `deleted` (snapshot name) instead of
 *  collapsing to a NULL byline. A `system` anchor or a missing anchor leaves
 *  `from_kind` outside user/agent → NULL author. */
interface SenderColumns {
  from_kind: string | null;
  from_user_id: string | null;
  from_agent_id: string | null;
  author_id: string | null;
  author_name: string | null;
  author_display_name: string | null;
  /** LIVE actor columns (NULL once the FK is nulled by ON DELETE SET NULL). */
  live_name: string | null;
  live_display_name: string | null;
  live_avatar_key: string | null;
  live_updated_at: number | null;
  /** LIVE agent runtime (NULL for a user actor or once the FK is nulled). */
  live_runtime: string | null;
}

/** Build the item's `preview_sender` ({@link MessageAuthorDto}) from the resolved
 *  author columns via the SAME pure resolver every author surface shares. The
 *  live actor (name/display_name/avatar) is passed only when the provenance FK
 *  still resolves; otherwise the resolver falls back to the send-time snapshot
 *  (`deleted`) or, absent one, `unresolved`. `avatar_url` mirrors
 *  `UserDto`/`AgentDto`: the relative avatar path with the `?v=updated_at`
 *  cache-buster, or NULL when the actor has no avatar. */
function buildPreviewSender(row: SenderColumns): MessageAuthorDto | null {
  const fromKind = row.from_kind;
  // system anchor / missing anchor (LEFT JOIN miss → NULL) has no author.
  if (fromKind !== 'user' && fromKind !== 'agent') return null;
  const fkId = fromKind === 'user' ? row.from_user_id : row.from_agent_id;
  const live: MessageAuthorLiveActor | null =
    fkId !== null && row.live_name !== null
      ? {
          name: row.live_name,
          display_name: row.live_display_name ?? row.live_name,
          avatar_url: principalAvatarUrl(
            fromKind === 'user'
              ? apiPaths.userAvatar(fkId)
              : apiPaths.agentAvatar(fkId),
            row.live_avatar_key,
            row.live_updated_at ?? 0,
          ),
          // Agent → its current runtime (agents.runtime, NOT NULL); user → null.
          // The DB value is a validated RuntimeKind; the resolver fails closed if
          // an agent's runtime is somehow absent.
          runtime: row.live_runtime as RuntimeKind | null,
        }
      : null;
  return resolveMessageAuthor(
    {
      from_kind: fromKind,
      from_user_id: row.from_user_id,
      from_agent_id: row.from_agent_id,
      author_id: row.author_id,
      author_name: row.author_name,
      author_display_name: row.author_display_name,
    },
    live,
  );
}

/** SQL fragment resolving an anchor message `m`'s author into the
 *  {@link SenderColumns}. Requires `LEFT JOIN users su ON su.id = m.from_user_id`
 *  and `LEFT JOIN agents sa ON sa.id = m.from_agent_id` in the same query. Emits
 *  the message's provenance FKs + send-time snapshot + the joined LIVE actor
 *  columns raw; {@link buildPreviewSender} discriminates active/deleted/unresolved
 *  via the shared resolver (no COALESCE here — the renderer owns display
 *  fallback uniformly across every `MessageAuthorDto` surface). */
const SENDER_SELECT = `
          m.from_kind                                                  AS from_kind,
          m.from_user_id                                               AS from_user_id,
          m.from_agent_id                                              AS from_agent_id,
          m.author_id                                                  AS author_id,
          m.author_name                                                AS author_name,
          m.author_display_name                                        AS author_display_name,
          CASE m.from_kind WHEN 'user' THEN su.name
                           WHEN 'agent' THEN sa.name END                AS live_name,
          CASE m.from_kind WHEN 'user' THEN su.display_name
                           WHEN 'agent' THEN sa.display_name END        AS live_display_name,
          CASE m.from_kind WHEN 'user' THEN su.avatar_storage_key
                           WHEN 'agent' THEN sa.avatar_storage_key END  AS live_avatar_key,
          CASE m.from_kind WHEN 'user' THEN su.updated_at
                           WHEN 'agent' THEN sa.updated_at END          AS live_updated_at,
          CASE m.from_kind WHEN 'agent' THEN sa.runtime END             AS live_runtime`;

/** Row fields carrying the item's PLACEMENT — the columns {@link buildLocation}
 *  turns into the DTO's `location` union. Both placements' coordinates are read
 *  unconditionally because the discriminant is a column, not a parameter: which
 *  arm a row is cannot be known before the row is read, so a query that selected
 *  only one arm's columns would be deciding the placement in SQL and then
 *  re-deciding it in TS.
 *
 *  Extends {@link ConversationEndpointRef} rather than re-listing the six endpoint
 *  columns, so `directPairEndpointsOf` (via `resolveCounterpart`) accepts the row
 *  as-is and "which slot is the other one" stays answered in exactly one place. */
interface LocationColumns extends ConversationEndpointRef {
  /** NULL exactly for a non-workspace placement — a CHECK on `conversations`, so
   *  {@link buildLocation}'s workspace arm asserts rather than coerces. */
  workspace_id: string | null;
  /** The conversation's stored title. Carries identity for the workspace arm ONLY:
   *  a `direct_pair`'s stored title is `DIRECT_PAIR_STORED_TITLE` (''), which is
   *  why the DM arm names its counterpart instead (#task:2115). */
  conversation_title: string;
}

/** SQL fragment selecting {@link LocationColumns} off the joined conversation `c`.
 *  Reads the coordinate off the CONVERSATION in both sources — never off a
 *  denormalized copy on the driving row — so "where does this item live" has one
 *  answer per item and cannot go stale against the placement it describes. */
const LOCATION_SELECT = `
          c.placement_kind        AS placement_kind,
          c.workspace_id          AS workspace_id,
          c.title                 AS conversation_title,
          c.endpoint_a_kind       AS endpoint_a_kind,
          c.endpoint_a_id         AS endpoint_a_id,
          c.endpoint_a_deleted_at AS endpoint_a_deleted_at,
          c.endpoint_b_kind       AS endpoint_b_kind,
          c.endpoint_b_id         AS endpoint_b_id,
          c.endpoint_b_deleted_at AS endpoint_b_deleted_at`;

/**
 * The item's `location` — the ONE place a row's placement becomes the DTO's
 * discriminated union, shared by both sources so neither can grow its own idea of
 * what a DM row's identity is.
 *
 * The two arms are asymmetric ON PURPOSE, and each asymmetry is the shared
 * authority speaking:
 *
 *  - `workspace_channel` asserts its coordinate through `requireWorkspacePlacement`
 *    (a surface whose unit IS a workspace must not invent one). A `?? ''` here is
 *    precisely the #2035 defect — an item nothing can open — which is why the
 *    shared assert exists instead of a local fallback.
 *  - `direct_pair` carries a COUNTERPART, not a title, and resolves it through the
 *    shared `resolveCounterpart`: identity is the other endpoint's live principal,
 *    and the wire value object stops at the coordinate + status + live fields. The
 *    DISPLAY STRING is not computed here and must not be — UI copy (including the
 *    deleted-endpoint wording) belongs to the renderer's `presentCounterpart`,
 *    which is also what keeps this face free of a second "deleted" spelling.
 *
 * `resolveCounterpart` fails loud when the viewer is not exactly one endpoint of
 * the row, and that is a deliberate coupling to the enumeration: both sources
 * admit a `direct_pair` only through `DIRECT_PAIR_IDS_FOR_USER_SQL`, so a throw
 * here means a query drifted off that authority — the one failure a counterpart
 * face must never absorb quietly, because absorbing it draws a STRANGER's name.
 */
function buildLocation(
  row: LocationColumns,
  conversationId: string,
  ac: ActivityAssemblyContext,
): ActivityLocation {
  if (row.placement_kind === 'direct_pair') {
    return {
      kind: 'direct_pair',
      counterpart: resolveCounterpart(
        { ...row, id: conversationId },
        { kind: 'human', id: ac.viewerUserId },
        ac.principals.resolve,
      ),
    };
  }
  return {
    kind: 'workspace_channel',
    workspace_id: requireWorkspacePlacement({
      id: conversationId,
      workspace_id: row.workspace_id,
      placement_kind: row.placement_kind,
    }),
    title: row.conversation_title,
  };
}

/**
 * The viewer's PARTICIPATION in a `direct_pair`, as the second arm of both
 * sources' enumeration — the human transpose of the two endpoint slots, taken
 * VERBATIM from the placement authority (`DIRECT_PAIR_IDS_FOR_USER_SQL`) so the
 * DM arm of "may this viewer see this stream" has exactly one text.
 *
 * Why participation is answered PER PLACEMENT rather than once: a workspace
 * conversation's authority is the roster seat, and a `direct_pair` has no roster
 * row at all (`getOrCreateDirectPair` writes the two endpoint columns and nothing
 * else). Merging by placement is therefore not a widening of the gate — it keeps
 * both gates exactly as tight as they were. The `placement_kind` conjunct is what
 * makes that true in the other direction too: a STRAY `conversation_users` row on
 * a pair the viewer is not an endpoint of stays inert, because the roster arm
 * never applies to a pair and this arm reads endpoints only.
 */
const DIRECT_PAIR_PARTICIPATION_ARM = `(c.placement_kind = 'direct_pair'
           AND c.id IN (${DIRECT_PAIR_IDS_FOR_USER_SQL}))`;

interface DirectedNotificationRow extends SenderColumns, LocationColumns {
  id: string;
  kind: 'mention_self' | 'agent_start_failed';
  /** NON-NULLABLE, and the query is what makes it so: it is selected as `c.id`
   *  under {@link LIVE_CONVERSATION_PREDICATE}, whose `c.id IS NOT NULL` conjunct
   *  drops the LEFT JOIN miss (a notification whose conversation was deleted —
   *  `ON DELETE SET NULL` — has an unknowable destination and fails closed).
   *  Reading the coordinate off the JOINED CONVERSATION rather than off
   *  `n.conversation_id` is what makes the non-nullability visible in ONE place
   *  instead of a per-item `?? ''` that would ship an unopenable row. */
  conversation_id: string;
  message_id: string | null;
  thread_root_id: string | null;
  root_content: string | null;
  message_content: string | null;
  payload: string | null;
  created_at: number;
}

interface PositionalStreamRow extends SenderColumns, LocationColumns {
  conversation_id: string;
  root: string | null;
  root_content: string | null;
  /** Read for ONE thing: the §5.1 salience grade (a fixed-roster stream's ambient
   *  unread is directed-grade). A CAPABILITY question, which is roster's proper
   *  domain — see the keying rule on `ConversationPlacementKindSchema`. It is not
   *  a conversation classification and does not reach `ActivityItemDto`, whose
   *  only classification is its `location` discriminant (#task:2076). */
  conversation_roster_policy: 'open' | 'fixed';
  first_unread_message_id: string;
  first_unread_seq: number;
  first_unread_content: string | null;
  first_unread_created_at: number;
  unread_count: number;
}


/**
 * The ORDERED registry of Activity sources — the chokepoint (#task:1410, Cindy
 * review). Every visible Activity item is produced by exactly one of these
 * sources, and `listActivity` assembles the list by looping THIS list: a source
 * not registered here emits nothing, so a new SQL source cannot reach the output
 * without a registry id. `activity-lifecycle-conformance.test.ts` derives its
 * lifecycle matrix from these ids via `satisfies Record<ActivitySourceId, …>`,
 * so a new id with no live/archived/orphan case fails to compile.
 *
 * Ordering is LOAD-BEARING: a source may read what earlier sources claimed via
 * the shared `ActivityAssemblyContext` (positional subtracts the directed
 * message ids, §8 `positional \ directed`), so `directed_notification` MUST
 * precede `positional_stream`.
 */
export const ACTIVITY_SOURCE_IDS = [
  'directed_notification',
  'positional_stream',
] as const;
export type ActivitySourceId = (typeof ACTIVITY_SOURCE_IDS)[number];

/** Threaded through the ordered sources so a later source can react to what an
 *  earlier one claimed. The only shared state today is `directedMessageIds`
 *  (§8): directed sources ADD the message ids they claim; positional sources
 *  SUBTRACT them so an ambient row never anchors on a message already shown as a
 *  mention. */
interface ActivityAssemblyContext {
  db: Db;
  viewerUserId: string;
  wsFilter: string | null;
  directedMessageIds: Set<string>;
  /** Counterpart identity lookups for `direct_pair` items, built ONCE per list
   *  (`listActivity`) and shared by every source. Memoized per (kind, id), so the
   *  cost is the distinct counterparts in the list rather than its row count —
   *  and a viewer's several DMs with the same agent resolve it once. NOT a
   *  per-item query, and not a second cache: it is the same resolver the DM list
   *  and the owner-audit list use. */
  principals: CounterpartResolution;
}

/** An Activity source: given the assembly context, produce this source's items.
 *  A source that reads a conversation MUST express liveness through
 *  LIVE_CONVERSATION_PREDICATE (the single gate) — never a hand-written
 *  `archived_at` / existence filter, or the #1409 drift reopens. */
type ActivitySource = (ac: ActivityAssemblyContext) => ActivityItemDto[];

/** Directed notifications (mention_self + agent_start_failed). Claims at most one
 *  item per message (§7) and records the claimed message ids into the shared
 *  context so the positional source can subtract them. */
const assembleDirectedNotifications: ActivitySource = ac => {
  const { db, viewerUserId, wsFilter } = ac;
  // "Which claims exist" is NOT decided here: the WHERE clause interpolates
  // EFFECTIVE_DIRECTED_MENTION_PREDICATE (repos/directed-claim-predicate.ts),
  // the shared definition the badge and the per-channel directed count also
  // read. It carries §7's cursor rule (a mention the viewer already read
  // positionally is cleared even while `read_at` is NULL) and the anchor
  // requirement, so this query no longer needs to select a cursor column and
  // re-decide in TS.
  const notifRows = prepareObserved<{ viewer: string; ws: string | null }, DirectedNotificationRow>(
      db,
      'activity.directed_notifications',
      `SELECT
          n.id                AS id,
          n.kind              AS kind,
          c.id                AS conversation_id,
          n.message_id        AS message_id,
          m.thread_root_id    AS thread_root_id,
          root.content        AS root_content,
          m.content           AS message_content,
          n.payload           AS payload,
          n.created_at        AS created_at,${LOCATION_SELECT},${SENDER_SELECT}
        FROM notifications n
        LEFT JOIN messages m ON m.id = n.message_id
        LEFT JOIN messages root ON root.id = m.thread_root_id
        LEFT JOIN conversations c ON c.id = n.conversation_id
        LEFT JOIN users su ON su.id = m.from_user_id
        LEFT JOIN agents sa ON sa.id = m.from_agent_id
       WHERE n.user_id = @viewer
         AND (
           -- mention_self: the shared effective-directed-claim rule (unread +
           -- anchored + above the anchor's own stream cursor).
           ${EFFECTIVE_DIRECTED_MENTION_PREDICATE}
           -- agent_start_failed: message-anchorless by nature, so it can never
           -- satisfy the anchored/cursor conjuncts; it clears only by read_at.
           OR (n.kind = 'agent_start_failed' AND n.read_at IS NULL)
         )
         -- Directed Activity items are conversation-backed: mentions need a
         -- message anchor and agent failures are message-anchorless, but still
         -- emitted for a concrete conversation. Lifecycle-ended conversations
         -- (archived/deleted) are not visible Activity — see
         -- LIVE_CONVERSATION_PREDICATE (the shared gate).
         AND ${LIVE_CONVERSATION_PREDICATE}
         -- ...and conversation-backed spans BOTH placements, each admitted by its
         -- own participation authority (#task:2115). The workspace arm is the
         -- notification itself: notifications.user_id = @viewer already means
         -- "addressed to this viewer", and WORKSPACE_PLACED is what makes the
         -- location union's workspace arm constructable. The DM arm additionally
         -- requires CURRENT endpoint participation, because a pair's notification
         -- outlives nothing else that could answer it: there is no roster row to
         -- lose, so user_id alone would keep answering after the placement
         -- itself stopped being the viewer's.
         --
         -- Stated as the shared placement discriminator, not as "the workspace
         -- column is not null" (Cindy B5): placement_kind is this feature's single
         -- truth for which placement a row is, and a nullable column is its
         -- CONSEQUENCE. Reading the consequence is how two faces of one domain
         -- drift, and conversation-placement-sql.ts requires the workspace face to
         -- carry WORKSPACE_PLACED explicitly for exactly that reason. Both arms are
         -- NULL-safe on the LEFT JOIN above: a notification whose conversation row
         -- is gone matches neither placement, so it cannot enter (and the liveness
         -- gate has already dropped it).
         AND (${WORKSPACE_PLACED} OR ${DIRECT_PAIR_PARTICIPATION_ARM})
         -- The workspace-scoped call reads the CONVERSATION's coordinate, the same
         -- column LOCATION_SELECT projects — one workspace face per item. A pair
         -- has none, so NULL = @ws excludes every DM from a workspace-scoped
         -- Activity list without a placement test of its own.
         AND (@ws IS NULL OR c.workspace_id = @ws)
       ORDER BY n.created_at DESC`,
    )
    .all({ viewer: viewerUserId, ws: wsFilter });

  // ── §7 de-dupe directed claims: at most one item per message. That rule is
  // the shared claim definition's fourth conjunct; the counting faces express it
  // as COUNT(DISTINCT n.message_id), and this item-building face expresses it as
  // a Map keyed by the SAME column. Only mentions are message-anchored directed
  // claims (the task projection was removed in v1, see the file header);
  // agent_start_failed has no anchor message, so it never participates in the
  // per-message map (and never excludes an ambient message).
  const directedByMessage = new Map<string, ActivityItemDto>();
  const agentFailedItems: ActivityItemDto[] = [];

  for (const n of notifRows) {
    if (n.kind === 'mention_self') {
      // Type narrowing only — the shared predicate already guaranteed an
      // existing anchor message.
      if (!n.message_id) continue;
      // already claimed this message (e.g. a duplicate mention notification).
      if (directedByMessage.has(n.message_id)) continue;
      directedByMessage.set(n.message_id, {
        id: `mention:${n.id}`,
        kind: 'mention',
        salience: 'directed',
        location: buildLocation(n, n.conversation_id, ac),
        conversation_id: n.conversation_id,
        thread_root_id: n.thread_root_id,
        message_id: n.message_id,
        notification_id: n.id,
        thread_root_preview: preview(n.root_content),
        preview: preview(n.message_content),
        preview_sender: buildPreviewSender(n),
        timestamp: n.created_at,
        unread_count: null,
      });
    } else {
      // agent_start_failed: no anchor message; preview from the payload.
      let agentPreview: string | null = null;
      if (n.payload) {
        try {
          const p = JSON.parse(n.payload) as { agent_name?: string; error?: string };
          agentPreview = preview(
            [p.agent_name, p.error].filter(Boolean).join(' — ') || null,
          );
        } catch {
          agentPreview = null;
        }
      }
      agentFailedItems.push({
        id: `agent_failed:${n.id}`,
        kind: 'agent_failed',
        salience: 'directed',
        // A failure row is located exactly like every other row. Its own kind
        // never substitutes for a location: a failed wake in a DM still has to
        // NAME the pair, which is why the counterpart hangs off the location arm
        // rather than off the item kind (#task:2115).
        location: buildLocation(n, n.conversation_id, ac),
        conversation_id: n.conversation_id,
        thread_root_id: null,
        message_id: null,
        notification_id: n.id,
        thread_root_preview: null,
        preview: agentPreview,
        preview_sender: null,
        timestamp: n.created_at,
        unread_count: null,
      });
    }
  }

  // Record the claimed message ids so the positional source can subtract them
  // (§8 `positional \ directed`). agent_start_failed has no anchor message, so
  // only mentions (the directed-by-message map) contribute.
  for (const mid of directedByMessage.keys()) ac.directedMessageIds.add(mid);

  return [...directedByMessage.values(), ...agentFailedItems];
};

/**
 * The positional-stream query (#task:1227 §8, rewritten #task:1967).
 *
 * Assembled in ONE exported constant so the query-plan contract test can EXPLAIN
 * exactly what {@link assemblePositionalStreams} executes — an access-path
 * assertion over a hand-rewritten copy would prove nothing.
 *
 * Driven by STREAMS, not by message history:
 *
 *  1. `viewer_conversation` enumerates the conversations the viewer PARTICIPATES
 *     in, one arm per placement (roster seat for the workspace arm, endpoint for
 *     the DM arm — #task:2115), and `entering_stream` narrows those to candidate
 *     streams — live ∩ (workspace filter) ∩ `enter()` — from
 *     `conversation_stream_heads`, resolving each one's cursor with an indexed
 *     probe into `conversation_reads`
 *     (idx_conversation_reads_user_conversation_stream). `latest_seq` is
 *     deliberately NOT read: it is the FRESHNESS head, which freshness-exempt
 *     rows (§5.2) leave behind, so a cursor may legitimately exceed it. Only the
 *     cursor bounds unread.
 *     The `enter()` test moved UP here from the post-aggregation WHERE: it is a
 *     per-(conversation, stream) predicate either way, so the answer is identical
 *     — but a muted / mentions-only channel now never has its tail scanned at all.
 *  2. `unread_tail` range-seeks each entering stream's unread tail on
 *     idx_messages_thread_root (conversation_id, thread_root_id, seq > cursor).
 *     §8 `positional \ directed` is applied HERE, before any aggregation, so both
 *     the count and the anchor are over NON-directed messages.
 *  3. `per_stream` aggregates that tail and the anchor row is fetched back by
 *     (conversation_id, seq) — a point lookup on uniq_messages_conversation_seq.
 *     `seq` is unique per conversation, so the joined row is necessarily that
 *     stream's min-seq unread row; no window functions, and the shared
 *     {@link SENDER_SELECT} can resolve the author off the real `messages` row
 *     instead of a second hand-copied projection of it.
 *
 * Stream ENUMERATION completeness (equivalence-critical, since the pre-#1967
 * query derived streams from `messages`): every non-exempt insert advances its
 * stream's head, and the only exempt writer inserts `from_kind = 'system'` rows
 * (schedule_fire), which this query excludes anyway — so a stream holding an
 * unread-eligible message always has a head row.
 *
 * The tail join is a `CROSS JOIN` — in SQLite an inner join the planner may not
 * reorder — and that is load-bearing, not decoration. Free to choose, the planner
 * turns the `enter()` OR into a MULTI-INDEX OR over the head table and inverts
 * the loop: drive from `messages` by `conversation_id` and probe a head per row,
 * i.e. exactly the full-history scan this rewrite removes. Streams-outer /
 * tail-inner is the entire point, so it is stated rather than hoped for.
 */
export const POSITIONAL_STREAMS_SQL = `
  WITH viewer_conversation AS (
    -- ── PARTICIPATION, merged across both placements (#task:2115) ────────────
    -- The enumeration's entry gate, and the smallest set that can bound the work.
    -- One arm per placement, because the two placements answer "is this the
    -- viewer's stream" with different authorities and neither answers for the
    -- other. UNION ALL, not plain UNION: the arms are mutually exclusive on ONE
    -- column (placement_kind), so a duplicate is unrepresentable and a dedup pass
    -- would be a temp b-tree bought to defend against nothing — see the plan
    -- contract, which pins the GROUP BY as the query's only one.
    --
    -- Workspace arm: the roster seat, which is authoritative FOR THIS ARM ONLY.
    -- The placement conjunct is what keeps that scoped: without it, a stray
    -- conversation_users row on a pair would admit a stream through the wrong
    -- authority — a member door that stopped failing closed, or a backfill, would
    -- silently hand a non-endpoint someone else's DM.
    SELECT cu.conversation_id AS conversation_id
      FROM conversation_users cu
      JOIN conversations c_seat ON c_seat.id = cu.conversation_id
     WHERE cu.user_id = @viewer
       AND ${workspacePlaced('c_seat')}
    UNION ALL
    -- DM arm: endpoint participation, taken verbatim from the placement authority
    -- so this face cannot drift from every other reader of "the viewer's pairs".
    -- A canonical pair has NO roster row at all (getOrCreateDirectPair writes the
    -- endpoint columns and nothing else), which is why the arm above could never
    -- reach it and why global Activity showed no DM unread before this ticket.
    ${DIRECT_PAIR_IDS_FOR_USER_SQL}
  ),
  entering_stream AS (
    SELECT c.id                          AS conversation_id,
           sh.thread_root_id             AS root,
           COALESCE(cr.last_read_seq, 0) AS cursor_seq
      FROM viewer_conversation vc
      JOIN conversations c
        ON c.id = vc.conversation_id
      JOIN conversation_stream_heads sh
        ON sh.conversation_id = c.id
      LEFT JOIN conversation_reads cr
        ON cr.user_id = @viewer
       AND cr.conversation_id = c.id
       AND cr.thread_root_id IS sh.thread_root_id
     WHERE ${LIVE_CONVERSATION_PREDICATE}
       -- The workspace-scoped call, which is a COORDINATE filter and not a
       -- placement test: a pair has no workspace_id, so NULL = @ws drops every
       -- DM from a per-workspace Activity list, and @ws IS NULL (the global rail)
       -- keeps both placements. That asymmetry is the feature — the global rail is
       -- the only surface that spans placements, and it is where a DM's unread
       -- belongs, because DM unread is directed-grade (§5.1) and therefore the
       -- class the human is MOST obliged to answer.
       AND (@ws IS NULL OR c.workspace_id = @ws)
       AND (
         -- Fixed-roster mainline (a DM: an agent_home DM channel or a
         -- workspace-less pair): directed-grade, always enters (§5.1). The pair
         -- needs no new arm here — roster_policy = 'fixed' is exactly what it
         -- is, so it enters and scores through the SAME rule, and the ambient
         -- tier below never applies to it.
         (sh.thread_root_id IS NULL AND c.roster_policy = 'fixed')
         -- Channel mainline: enters when the EFFECTIVE tier is 'all' — the
         -- channel's own tier with the viewer's workspace mute folded in
         -- (#task:1870). The workspace scope is a SUPPRESSOR above the tier, so
         -- muting a workspace removes its ambient items without touching any
         -- channel's stored choice; un-muting restores them exactly.
         OR (sh.thread_root_id IS NULL AND c.roster_policy = 'open'
             AND ${channelAmbientEntersPredicate('c.id', 'c.workspace_id')})
         -- Thread ambient: aggregate-floor (#task:1268). Requires BOTH the
         -- delivery precondition (viewer follows the cluster) AND the parent
         -- channel's effective tier = 'all'. The head row's conversation IS the
         -- parent channel for a reply-cluster, so the SAME preference gates
         -- mainline and its threads. follow is a delivery decision and must not
         -- force ambient on over the viewer's explicit mentions-only/muted pref
         -- (delivery vs attention); thread @mentions still enter via directed.
         --
         -- Placement-safe for a pair without a special case: the tier predicate
         -- takes the workspace coordinate as a PARAMETER, and a NULL workspace
         -- matches no mute row, so a pair's thread enters iff it is followed and
         -- the pair's own stored mode is 'all'.
         OR (sh.thread_root_id IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM thread_followers tf
                WHERE tf.thread_root_id = sh.thread_root_id
                  AND tf.principal_kind = 'human'
                  AND tf.principal_id = @viewer
             )
             AND ${channelAmbientEntersPredicate('c.id', 'c.workspace_id')})
       )
  ),
  unread_tail AS (
    SELECT es.conversation_id AS conversation_id,
           es.root            AS root,
           m.seq              AS seq
      FROM entering_stream es
      CROSS JOIN messages m
        ON m.conversation_id = es.conversation_id
       AND m.thread_root_id IS es.root
       AND m.seq > es.cursor_seq
     WHERE m.from_kind != 'system'
       AND NOT (m.from_kind = 'user'
                AND (m.from_user_id = @viewer OR m.from_user_id IS NULL))
       AND m.id NOT IN (SELECT value FROM json_each(@excluded))
  ),
  per_stream AS (
    SELECT conversation_id,
           root,
           COUNT(*) AS unread_count,
           MIN(seq) AS first_unread_seq
      FROM unread_tail
     GROUP BY conversation_id, root
  )
  SELECT
    ps.conversation_id  AS conversation_id,
    ps.root             AS root,
    root.content        AS root_content,
    c.roster_policy     AS conversation_roster_policy,
    m.id                AS first_unread_message_id,
    m.seq               AS first_unread_seq,
    m.content           AS first_unread_content,
    m.created_at        AS first_unread_created_at,
    ps.unread_count     AS unread_count,${LOCATION_SELECT},${SENDER_SELECT}
    FROM per_stream ps
    JOIN messages m
      ON m.conversation_id = ps.conversation_id AND m.seq = ps.first_unread_seq
    JOIN conversations c ON c.id = ps.conversation_id
    LEFT JOIN messages root ON root.id = ps.root
    LEFT JOIN users su ON su.id = m.from_user_id
    LEFT JOIN agents sa ON sa.id = m.from_agent_id`;

/** Positional streams (ambient channel / DM / followed-thread unread),
 *  enter()-filtered in SQL. Subtracts the directed message ids the directed
 *  source claimed (§8), so both the count and the first-unread anchor are over
 *  NON-directed messages. */
const assemblePositionalStreams: ActivitySource = ac => {
  const { db, viewerUserId, wsFilter } = ac;
  const excludedJson = JSON.stringify([...ac.directedMessageIds]);
  const positionalRows = prepareObserved<
      {
        viewer: string;
        ws: string | null;
        excluded: string;
        channelDefaultMode: string;
      },
      PositionalStreamRow
    >(
      db,
      'activity.positional_streams',
      POSITIONAL_STREAMS_SQL,
    )
    .all({
      viewer: viewerUserId,
      ws: wsFilter,
      excluded: excludedJson,
      channelDefaultMode: DEFAULT_CHANNEL_ATTENTION_MODE,
    });

  // ── map positional rows to items ──────────────────────────────────────────
  const items: ActivityItemDto[] = [];
  for (const s of positionalRows) {
    // A fixed-roster stream's unread is positional by MECHANISM and
    // directed-grade by SALIENCE (§5.1). This is the one live roster read on this
    // face, and it is a capability/attention-policy question — it decides how loud
    // the item is, never what the conversation IS. The identity question is
    // answered independently, by the row's PLACEMENT (`buildLocation`), which is
    // why the roster bit stops at this line instead of riding the DTO: a
    // workspace-placed DM channel and a workspace-less pair are both `fixed` and
    // both directed-grade, yet they are different placements and draw different
    // row-1 identities (#task:2076, #task:2115).
    const salience: ActivitySalience =
      s.conversation_roster_policy === 'fixed' ? 'directed' : 'ambient';
    items.push({
      id: `unread:${s.conversation_id}::${s.root ?? ''}`,
      kind: 'unread',
      salience,
      location: buildLocation(s, s.conversation_id, ac),
      conversation_id: s.conversation_id,
      thread_root_id: s.root,
      message_id: s.first_unread_message_id,
      notification_id: null,
      thread_root_preview: preview(s.root_content),
      preview: preview(s.first_unread_content),
      preview_sender: buildPreviewSender(s),
      timestamp: s.first_unread_created_at,
      unread_count: s.unread_count,
    });
  }
  return items;
};

/** The chokepoint registry. `satisfies` forces one assembler per declared
 *  ActivitySourceId, and `listActivity`'s loop is the ONLY assembly path — the
 *  structural guarantee that a new visible source must be registered here (and
 *  lifecycle-tested) rather than smuggled in as inline SQL. */
const ACTIVITY_SOURCES = {
  directed_notification: assembleDirectedNotifications,
  positional_stream: assemblePositionalStreams,
} satisfies Record<ActivitySourceId, ActivitySource>;

/**
 * Project the viewer's Activity list. Pure read; returns a DTO the client
 * renders as-is (already filtered, deduped, salience-sorted). Assembly loops
 * ACTIVITY_SOURCES in ACTIVITY_SOURCE_IDS order — every item comes from a
 * registered source, and later sources see what earlier ones claimed via the
 * shared context (§8).
 */
export function listActivity(
  db: Db,
  params: ListActivityParams,
): ListActivityDto {
  const ac: ActivityAssemblyContext = {
    db,
    viewerUserId: params.viewerUserId,
    wsFilter: params.workspaceId ?? null,
    directedMessageIds: new Set(),
    // ONE resolver per list, shared by every source: counterpart identity is a
    // property of the pair, not of the source that surfaced it, and two sources
    // resolving the same pair must not disagree — nor pay twice.
    principals: createPrincipalResolver(db),
  };

  const items: ActivityItemDto[] = [];
  for (const id of ACTIVITY_SOURCE_IDS) {
    items.push(...ACTIVITY_SOURCES[id](ac));
  }

  // §13.2 v1 sort: directed tier first, most-recent-first within each tier.
  const tierRank: Record<ActivitySalience, number> = { directed: 0, ambient: 1 };
  items.sort((a, b) => {
    if (tierRank[a.salience] !== tierRank[b.salience]) {
      return tierRank[a.salience] - tierRank[b.salience];
    }
    return b.timestamp - a.timestamp;
  });

  return { items };
}

/**
 * The Activity read surface a caller receives, handle already bound
 * (#task:1983 W2). Route modules declare THIS in their deps rather than
 * importing the module and passing a context.
 */
export interface ActivityReadModel {
  readonly list: (params: ListActivityParams) => ListActivityDto;
}

export function createActivityReadModel(db: Db): ActivityReadModel {
  return { list: params => listActivity(db, params) };
}

// AUTO-SPLIT from the former monolithic api/dto.ts (#task:963).
// Bounded context: conversation. Re-exported via api/index.ts → @silverhand/shared.
import { z } from 'zod';
import { HandleSchema } from '../handle.js';
import {
  CONVERSATION_TITLE_MAX_CODE_POINTS,
  describeConversationTitleIssue,
  parseConversationTitle,
} from '../conversation-title.js';
import {
  ConversationAgentStatusSchema,
  ConversationEndpointKindSchema,
  ConversationEventKindSchema,
  ConversationPlacementKindSchema,
  ConversationRosterPolicySchema,
  ConversationStatusSchema,
  ConversationVisibilitySchema,
  RuntimeKindSchema,
} from '../db/schema.js';

export const ConversationDtoSchema = z.object({
  id: z.string(),
  // NULL exactly when the conversation is not workspace-placed
  // (agent-scoped-session-v1 §4.1: `placement_kind='agent_inbox'` today,
  // `direct_pair` from P3). A workspace coordinate is a PROPERTY OF THE
  // PLACEMENT, not of every conversation, so it is derived per row rather than
  // assumed — the doc's "每一行必须自带坐标" applied to the wire.
  //
  // Widened here rather than kept `z.string()` with a coercion at the mapper
  // because the failure mode of the lie is invisible: responses are built from
  // these types without a runtime parse, so a non-workspace row would flow out
  // as `undefined`/`null` past a `string` type with no red light anywhere. The
  // nullable type makes every consumer decide at typecheck instead.
  //
  // Reachability: a human-facing route cannot return a non-workspace row today
  // (`participantsOf(agent_inbox)` = the owner agent only, so the permission
  // check denies first) — the null arm is reached by agent/internal surfaces.
  workspace_id: z.string().nullable(),
  placement_kind: ConversationPlacementKindSchema,
  roster_policy: ConversationRosterPolicySchema,
  title: z.string(),
  status: ConversationStatusSchema,
  spawned_by_agent_id: z.string().nullable(),
  closed_at: z.number().nullable(),
  close_summary: z.string().nullable(),
  archived_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  // Stored, identity-level visibility. `private` (default) |
  // `public`. Per-viewer `is_member` is NOT here (it is viewer-scoped, computed
  // at the route on channel-detail / discovery responses, not conversation
  // identity).
  visibility: ConversationVisibilitySchema,
});
export type ConversationDto = z.infer<typeof ConversationDtoSchema>;

export const ChannelConversationDtoSchema = ConversationDtoSchema.extend({
  placement_kind: z.literal('workspace'),
  roster_policy: z.literal('open'),
});
export type ChannelConversationDto = z.infer<typeof ChannelConversationDtoSchema>;

export const DmChannelDtoSchema = ConversationDtoSchema.extend({
  roster_policy: z.literal('fixed'),
});
export type DmChannelDto = z.infer<typeof DmChannelDtoSchema>;

/**
 * The wire rule for a channel's display title — which is now also its ADDRESS
 * (#task:2016), so this schema no longer states a rule of its own. It delegates
 * to `parseConversationTitle`, the single canonicalizer + validator: creation,
 * rename, the renderer's advisory check and the write transaction must all decide
 * the same way, and the only way to guarantee that is for none of them to own a
 * copy of the decision.
 *
 * Output is the CANONICAL PAIR, not a string: the boundary parses once and the
 * brand carries inward, so no layer between here and the UPDATE can hand the
 * repo a title without its key or a key belonging to another title. Uniqueness is
 * not decided here — a folded collision with a sibling conversation is a database
 * fact answered in the write transaction.
 *
 * Issue codes are mapped rather than all reported as `custom` because the
 * renderer classifies length-vs-charset by code: a title that is merely too long
 * is a counter to show, a title carrying an invisible character is a sentence to
 * read.
 */
export const ChannelTitleSchema = z.string().transform((raw, ctx) => {
  const result = parseConversationTitle(raw);
  if (result.ok) return result.value;
  const message = describeConversationTitleIssue(result.issue);
  switch (result.issue.kind) {
    case 'empty':
      ctx.addIssue({
        code: z.ZodIssueCode.too_small,
        minimum: 1,
        type: 'string',
        inclusive: true,
        message,
      });
      break;
    case 'too_long':
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: CONVERSATION_TITLE_MAX_CODE_POINTS,
        type: 'string',
        inclusive: true,
        message,
      });
      break;
    case 'forbidden_code_point':
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      break;
  }
  return z.NEVER;
});

export const CreateConversationChannelInputSchema = z.object({
  title: ChannelTitleSchema,
  member_agent_ids: z.array(z.string()).default([]),
  member_user_ids: z.array(z.string()).optional(),
  // Channel visibility. Omitted = server default 'private'. `public` is a
  // human-only creation concept (the create route always acts as a user); the
  // service rejects a non-user actor requesting `public`.
  visibility: ConversationVisibilitySchema.optional(),
});
/**
 * The REQUEST BODY a client constructs — `z.input`, not `z.infer` (#task:2016).
 *
 * `ChannelTitleSchema` outputs a branded {@link CanonicalConversationTitle} pair,
 * which is a SERVER-SIDE value: it exists only after a parse, it cannot be
 * constructed outside `conversation-title.ts`, and it is not what goes on the
 * wire. A client sends `title` as the string a person typed; the boundary turns it
 * into the pair. Naming the output type here would tell every caller to serialize
 * `{ title: { title, key } }`, which no route accepts. Route handlers read the
 * parsed value off `safeParse` and never need this name.
 */
export type CreateConversationChannelInput = z.input<
  typeof CreateConversationChannelInputSchema
>;

//
// Identity + routing metadata for a conversation, returned by
// `GET /api/conversations/:id/ref`. Designed to back cross-workspace
// secondary-pane resolution and the `#conv:<id>` sigil renderer (PR-3).
//
// Hard contract:
//   - `workspace_kind` is the *external* projection — `agent_home` is
//     mapped to `'dm'` here so the renderer never sees a third kind.
//   - Does NOT include unread count, last_seq, message previews, or
//     any per-user state — those go through the existing read-cursor
//     and message-window endpoints. Keep this endpoint identity-only.
//   - Permission: `canViewWorkspace(user, workspace_id)` only. This
//     route is mounted on the user-facing surface only — agents do
//     NOT get a path to call it. If we ever expose to agents, write a
//     dedicated ACL helper; do not relax this one.
export const ConversationRefWorkspaceKindSchema = z.enum(['regular', 'dm']);
export type ConversationRefWorkspaceKind = z.infer<
  typeof ConversationRefWorkspaceKindSchema
>;

export const ConversationRefSchema = z.object({
  id: z.string(),
  placement_kind: ConversationPlacementKindSchema,
  roster_policy: ConversationRosterPolicySchema,
  title: z.string(),
  workspace_id: z.string(),
  workspace_kind: ConversationRefWorkspaceKindSchema,
  closed_at: z.number().nullable(),
  archived_at: z.number().nullable(),
});
export type ConversationRef = z.infer<typeof ConversationRefSchema>;

export const ConversationRefResponseSchema = z.object({
  ref: ConversationRefSchema,
});
export type ConversationRefResponse = z.infer<typeof ConversationRefResponseSchema>;

export const ConversationAgentDtoSchema = z.object({
  conversation_id: z.string(),
  agent_id: z.string(),
  joined_at: z.number(),
});
export type ConversationAgentDto = z.infer<typeof ConversationAgentDtoSchema>;

/** Runtime projection for one participating agent as viewed from one
 * conversation. Membership is deliberately absent: callers obtain the roster
 * from `ConversationAgentDto` and join the two read models by `agent_id` only at
 * the presentation boundary. */
export const ConversationAgentRuntimeDtoSchema = z.object({
  agent_id: z.string(),
  scope_kind: z.enum(['agent', 'conversation']),
  generation: z.number().int().nonnegative(),
  cli_session_id: z.string().nullable(),
  pid: z.number().nullable(),
  status: ConversationAgentStatusSchema,
});
export type ConversationAgentRuntimeDto = z.infer<
  typeof ConversationAgentRuntimeDtoSchema
>;

/** Human membership in a conversation (v25). Parallel to
 *  `ConversationAgentDto` minus the process-lifecycle fields. */
export const ConversationUserMemberDtoSchema = z.object({
  conversation_id: z.string(),
  user_id: z.string(),
  joined_at: z.number(),
});
export type ConversationUserMemberDto = z.infer<typeof ConversationUserMemberDtoSchema>;

// `MemberDto` is the unified, rendered shape used wherever code
// needs to treat conversation participants uniformly — currently
// the platform prompt's "Channel members:" block
// (PR-B) and, in PR-C, the chat header chip strip. Distinct from
// `ConversationAgentDto` / `ConversationUserMemberDto`, which are
// raw membership rows.
//
// The `agent_id` / `user_id` discriminator carries the
// participant's primary key so callers (e.g. the prompt builder
// flagging `self: true`, or PR-C click routing) can map back to
// AgentRepo / UserRepo without re-fetching by name.
export const AgentMemberDtoSchema = z.object({
  kind: z.literal('agent'),
  agent_id: z.string(),
  name: z.string(),
  display_name: z.string(),
  runtime: RuntimeKindSchema,
});
export type AgentMemberDto = z.infer<typeof AgentMemberDtoSchema>;

export const HumanMemberDtoSchema = z.object({
  kind: z.literal('human'),
  user_id: z.string(),
  name: z.string(),
  display_name: z.string(),
  avatar_url: z.string().nullable(),
});
export type HumanMemberDto = z.infer<typeof HumanMemberDtoSchema>;

export const MemberDtoSchema = z.discriminatedUnion('kind', [
  AgentMemberDtoSchema,
  HumanMemberDtoSchema,
]);
export type MemberDto = z.infer<typeof MemberDtoSchema>;

/** Per-member, VIEWER-SCOPED removability (#task:1688). Lives on the members
 *  READ envelope, never on `MemberDto` — a member's identity is the same for
 *  every reader, while "may I remove this one" is a property of the reader
 *  (same rule as `is_member` / `can_leave` on the channel-detail envelope,
 *  docs/architecture-principles.md §12.1#5).
 *
 *  It exists so a surface can HIDE the action instead of rendering it disabled:
 *  the human arm depends on a fact the client cannot see (the target's
 *  workspace role) plus three eligibility guards (archived channel, the private
 *  channel's workspace owner, the last human of a private channel) that a
 *  client-side re-derivation would drift from. Advisory display only — the
 *  DELETE routes stay authoritative.
 *
 *  `id` is the member's primary key (`agent_id` for agents, `user_id` for
 *  humans), so `(kind, id)` identifies exactly one `MemberDto`. Clients must
 *  LOOK UP by `(kind, id)`, not by index: an optimistically edited client cache
 *  may hold a filtered `members` array against an unfiltered carrier. */
export const MemberRemovabilityDtoSchema = z.object({
  kind: z.enum(['agent', 'human']),
  id: z.string(),
  can_remove: z.boolean(),
});
export type MemberRemovabilityDto = z.infer<typeof MemberRemovabilityDtoSchema>;

/** The plain member-roster envelope returned by the member WRITE routes (add /
 *  remove, human + internal-agent surfaces): the fresh roster, no viewer-scoped
 *  carriers. */
export const ConversationMembersResponseSchema = z.object({
  members: z.array(MemberDtoSchema),
});
export type ConversationMembersResponse = z.infer<
  typeof ConversationMembersResponseSchema
>;

/** Response shape for `GET /api/conversations/:id/members` — the roster plus
 *  this viewer's per-member removability (one entry per member). A superset of
 *  {@link ConversationMembersResponseSchema}, so a caller that only needs the
 *  roster can keep reading it as one. */
export const ConversationMembersReadResponseSchema =
  ConversationMembersResponseSchema.extend({
    member_removability: z.array(MemberRemovabilityDtoSchema),
  });
export type ConversationMembersReadResponse = z.infer<
  typeof ConversationMembersReadResponseSchema
>;

export const AddConversationMemberByIdInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('agent'),
    agent_id: z.string(),
  }),
  z.object({
    kind: z.literal('human'),
    user_id: z.string(),
  }),
]);
export const AddConversationMemberByHandleInputSchema = z.object({
  handle: HandleSchema,
});
export const AddConversationMemberInputSchema = z.union([
  AddConversationMemberByIdInputSchema,
  AddConversationMemberByHandleInputSchema,
]);
export type AddConversationMemberInput = z.infer<
  typeof AddConversationMemberInputSchema
>;

export const ClearSessionResponseSchema = z.object({
  ok: z.literal(true),
  prev_cli_session_id: z.string().nullable(),
  was_running: z.boolean(),
});
export type ClearSessionResponse = z.infer<typeof ClearSessionResponseSchema>;

export const ConversationActivityPayloadSchema = z
  .record(z.string(), z.unknown())
  .nullable();
export type ConversationActivityPayload = z.infer<
  typeof ConversationActivityPayloadSchema
>;

export const ConversationActivityEventSchema = z.object({
  id: z.number().int(),
  conversation_id: z.string(),
  agent_id: z.string().nullable(),
  kind: ConversationEventKindSchema,
  payload: ConversationActivityPayloadSchema,
  created_at: z.number().int(),
});
export type ConversationActivityEvent = z.infer<
  typeof ConversationActivityEventSchema
>;

export const ConversationActivityListResponseSchema = z.object({
  events: z.array(ConversationActivityEventSchema),
  next_before_id: z.number().int().nullable(),
});
export type ConversationActivityListResponse = z.infer<
  typeof ConversationActivityListResponseSchema
>;

export const ChannelDtoSchema = ChannelConversationDtoSchema;
export type ChannelDto = ChannelConversationDto;

export const ChannelLikeDtoSchema = z.union([
  ChannelConversationDtoSchema,
  DmChannelDtoSchema,
]);
export type ChannelLikeDto = z.infer<typeof ChannelLikeDtoSchema>;

/** Stable reason codes for why the viewer may NOT leave a channel
 *  (`ChannelDetailResponse.leave_blocked_reason`). The backend emits ONLY the
 *  code; the renderer owns the human copy (UI text is never outsourced to the
 *  backend). `null` when `can_leave` is `true`.
 *   - `not_member`      — the viewer is not a `conversation_users` member (a
 *                         non-member's only channel mutation is Join; defensive,
 *                         a non-member normally sees Join, not a Leave control).
 *   - `channel_archived`— an archived channel is frozen in v1: restore first.
 *   - `channel_owner`   — the viewer is the workspace OWNER of a PRIVATE
 *                         channel. The owner anchors the owner-bound
 *                         governance chain; letting them leave would sever the
 *                         chain from the resource (a private channel is
 *                         invisible to a non-member, so the owner could no
 *                         longer see or re-govern it) — a half-orphan even with
 *                         other humans present. NOT a literal "creator": the
 *                         model tracks no per-channel creator, so this is the
 *                         authoritative `workspace_users.role='owner'` relation
 *                         (`canGovernWorkspace(..,'owner')`), never a first-member
 *                         guess. Public channels are exempt (owner can re-browse
 *                         + re-join freely). Priority ABOVE `last_human_member`.
 *   - `last_human_member` — the viewer is the last HUMAN member of a PRIVATE
 *                         channel; leaving would strand it (no human, incl.
 *                         admins, can see or re-join a private channel).
 *                         Active public channels are exempt (0 humans is fine —
 *                         still discoverable + joinable). */
export const ChannelLeaveBlockedReasonSchema = z.enum([
  'not_member',
  'channel_archived',
  'channel_owner',
  'last_human_member',
]);
export type ChannelLeaveBlockedReason = z.infer<
  typeof ChannelLeaveBlockedReasonSchema
>;

/** Response for `GET /api/channels/:id`. Carries the channel identity plus the
 *  route-computed, per-viewer capability carriers — all viewer-scoped, so they
 *  live on the response envelope, NOT on `ConversationDto` identity (see the
 *  note on `ConversationDtoSchema.visibility`). A public-channel non-member now
 *  reads channel detail with `is_member: false` (the renderer shows a Join
 *  affordance instead of the composer); an actual member gets `true`. For a
 *  `dm_channel` or a private channel only members can reach this route at all,
 *  so `is_member` is always `true` there.
 *
 *  The settings-modal capability carriers are advisory display only — the
 *  authoritative enforcement stays on the write paths (`POST .../leave` returns
 *  the typed error; `PATCH .../:id` gates visibility on `canGovernWorkspace`).
 *  The renderer treats a missing carrier as fail-closed (hide the visibility
 *  control, disable Leave). See docs/architecture-principles.md §12.1#5
 *  (advisory ≠ correctness).
 *   - `can_leave` / `leave_blocked_reason` — whether the viewer may leave, and
 *     if not, the stable reason code (renderer writes the copy).
 *   - `can_update_visibility` — whether the viewer may toggle private/public
 *     (workspace admin governance on a regular channel; agents never). */
export const ChannelDetailResponseSchema = z.object({
  channel: ChannelLikeDtoSchema,
  is_member: z.boolean(),
  can_leave: z.boolean(),
  leave_blocked_reason: ChannelLeaveBlockedReasonSchema.nullable(),
  can_update_visibility: z.boolean(),
});
export type ChannelDetailResponse = z.infer<typeof ChannelDetailResponseSchema>;

/** Item in a workspace channel list — BOTH `GET /api/workspaces/:id/channels`
 *  and its archived twin `GET /api/workspaces/:id/channels/archived`
 *  (#task:1691). It is a channel-like identity (`channel` OR `dm_channel`) PLUS
 *  the route-computed, per-viewer `is_member` — the SAME viewer-scoped bit the
 *  channel-detail envelope carries (see `ChannelDetailResponseSchema` and the
 *  note on `ConversationDtoSchema.visibility`). `is_member` stays a projection
 *  field; the identity DTOs are never widened. EVERY item a user receives from
 *  either endpoint carries `is_member`: a regular channel computes it (joined vs
 *  browse-only public), a `dm_channel` is always `true` (the DM list is strictly
 *  membership-filtered). A missing field means an older/unaware payload → the
 *  gate treats it as unknown and fetches detail; it never assumes membership.
 *  A consumer therefore never has to know WHICH of the two lists a row came
 *  from to read membership off it — that was the split-brain this shape closes.
 *
 *  The two lists differ in their SET, not in their row shape:
 *  - ACTIVE — DISCOVERY UNION (regular workspaces, user principal): channels
 *    the viewer has joined (any visibility → `is_member: true`) PLUS active
 *    PUBLIC channels the viewer has not joined (`is_member: false`, the
 *    browse-and-Join surface). Private channels the viewer is not a member of
 *    never appear.
 *  - ARCHIVED — strictly membership-filtered: an archived channel the viewer is
 *    not a member of is ABSENT, not present with `is_member: false` (archive is
 *    not a discovery surface; the global recovery index is
 *    `ArchivedChannelListItemDtoSchema`). Every archived row is consequently
 *    `is_member: true` today — but it is COMPUTED per row from the same
 *    membership `EXISTS` that defines the set, so widening the set later yields
 *    real `false` rows instead of a silently-constant `true`.
 *
 *  ⚠️ The ACTIVE list is NOT a backward-compatible additive change at the SET
 *  level. The FIELD is additive, but that list's SET widens from member-only to
 *  a discovery union, so an unaware consumer would treat a browse-only public
 *  channel as an ordinary joined channel (auto-open / restore / persist it, list
 *  it in member-scoped aggregations). EVERY consumer of the active list must
 *  classify items by `is_member` (member-only paths — restore/default/fallback,
 *  task/aggregate filters — must exclude `is_member: false`). The backend union
 *  and the renderer consumer-split therefore ship in the SAME release; that list
 *  must not be published to an un-migrated renderer. The flat shape only buys a
 *  single-field gate read — it does NOT remove the consumer-migration
 *  requirement. The archived list carries no such warning: its set did not
 *  change, only the carrier was added. */
export const WorkspaceChannelListItemSchema = z.discriminatedUnion('roster_policy', [
  ChannelConversationDtoSchema.extend({ is_member: z.boolean() }),
  DmChannelDtoSchema.extend({ is_member: z.boolean() }),
]);
export type WorkspaceChannelListItem = z.infer<typeof WorkspaceChannelListItemSchema>;

/**
 * The OTHER principal of one of the viewer's direct pairs (#task:2035), resolved
 * server-side.
 *
 * WHY THE COUNTERPART AND NOT A TITLE. A `direct_pair` stores no title (a DM's
 * label is "the other one", which is per-viewer), so the row's name has to be
 * derived at read time from the endpoint that is not the viewer's own. Deriving it
 * in the CLIENT would mean shipping both endpoint coordinates to the renderer and
 * teaching it which slot it occupies — the canonical endpoint order is a storage
 * rule, and a client that reimplemented it would silently name the wrong side the
 * moment the order gained a kind.
 *
 * A UNION, not a nullable identity, because an endpoint OUTLIVES its principal:
 * the coordinate is historical and the pair stays the survivor's pair. So the
 * absence of a person is a STATE of the counterpart rather than a missing field.
 *  - `active` — the principal exists; `name` / `display_name` / `avatar_url` are its
 *    CURRENT values, not a send-time snapshot, exactly as `MessageAuthorDto`'s
 *    active arm defines them. Split by `kind` so an illegal combination is
 *    unconstructable: an `agent` carries its current `runtime` (the byline glyph),
 *    a `human` carries `runtime: null`.
 *  - `deleted` — the principal is gone. It carries ONLY `kind` + `id`, and that is
 *    a fact about the model rather than a shortcut: nothing about an endpoint is
 *    snapshotted (unlike a message author, which stores `author_name` at send
 *    time), so no name can be recovered. The renderer owns the copy for it — UI
 *    text is never outsourced to the backend.
 *
 * `kind` is the ENDPOINT kind (`'human' | 'agent'`), not the message-author
 * vocabulary (`'user' | 'agent'`): this value object describes a placement
 * coordinate, and using the coordinate's own spelling is what keeps it comparable
 * to the columns it came from.
 */
export const DirectPairCounterpartSchema = z.union([
  z.object({
    status: z.literal('active'),
    kind: z.literal('agent'),
    id: z.string(),
    name: z.string(),
    display_name: z.string(),
    avatar_url: z.string().nullable(),
    runtime: RuntimeKindSchema,
  }),
  z.object({
    status: z.literal('active'),
    kind: z.literal('human'),
    id: z.string(),
    name: z.string(),
    display_name: z.string(),
    avatar_url: z.string().nullable(),
    runtime: z.null(),
  }),
  z.object({
    status: z.literal('deleted'),
    kind: ConversationEndpointKindSchema,
    id: z.string(),
  }),
]);
export type DirectPairCounterpart = z.infer<typeof DirectPairCounterpartSchema>;

/**
 * One row of the viewer's Direct Messages list — `GET /api/direct-pairs`
 * (#task:2035).
 *
 * NOT a `ConversationDto` or a `DmChannelDto`, and the distinction is the whole
 * reason this type exists. `dm_channel` is a WORKSPACE-placed conversation with a
 * fixed roster inside an agent-home workspace; a `direct_pair` has no workspace
 * coordinate at all, so a client that received one as a channel would try to open
 * it under a workspace it does not belong to (which is precisely why the agent
 * page's DM seats were inert before this list existed).
 *
 * `unread_count` is the same roll-up every channel badge shows (mainline + followed
 * threads), asked per pair. There is no `latest_unread` pointer beside it: that
 * powers the close-watermark of an OPEN conversation, and a sidebar row needs a
 * number.
 *
 * `read_only` is the survivor state — the write gate's one placement-specific
 * narrowing, derived from the endpoints rather than stored (see
 * `directPairIsReadOnlyForSurvivor`). It is carried here so the row can render its
 * state without opening the conversation; the authoritative refusal stays on the
 * send path.
 *
 * `created_at` is when the line was opened, and it is the list's ORDER. Not "last
 * activity": no conversation row carries a last-message timestamp, so an activity
 * order would be a derivation this list alone had — see
 * `DIRECT_PAIRS_FOR_VIEWER_SQL`.
 */
export const DirectPairListItemSchema = z.object({
  conversation_id: z.string(),
  counterpart: DirectPairCounterpartSchema,
  unread_count: z.number().int().nonnegative(),
  read_only: z.boolean(),
  created_at: z.number().int(),
});
export type DirectPairListItem = z.infer<typeof DirectPairListItemSchema>;

/** Response for `GET /api/direct-pairs`: every EXISTING pair the viewer is an
 *  endpoint of, oldest first.
 *
 *  EXISTING pairs only — a product ruling, not an optimization (@shiki,
 *  #task:2035): an agent the viewer has never messaged does NOT appear here. The
 *  entry point for starting a new DM is the agent's own page, so this list stays a
 *  list of open lines instead of a directory of everyone who could be messaged. */
export const DirectPairListResponseSchema = z.object({
  direct_pairs: z.array(DirectPairListItemSchema),
});
export type DirectPairListResponse = z.infer<typeof DirectPairListResponseSchema>;

/**
 * Viewer-scoped `direct_pairs_changed` payload (#task:2035) — a HINT, never a
 * value: the consumer invalidates and re-reads `GET /api/direct-pairs`, which
 * stays the single authority for the list's membership, order and unread.
 *
 * That is the same contract `workspace_channels_changed` and
 * `viewer_workspaces_changed` carry, and it is what makes a STRANGER's first DM
 * appear with no reload: the row does not exist in any cache yet, so there is
 * nothing for a patch-style frame to patch — only a re-read can discover it. It
 * is also why this cannot be the conversation's own `message` frame: a client is
 * subscribed to a conversation it has open, and this pair has never been open.
 *
 * `conversation_id` names the pair that changed, for logs and for a consumer that
 * wants to know WHICH row moved. A consumer that only invalidates may ignore it —
 * it must never be treated as "and nothing else changed".
 */
export const DirectPairsChangedPayloadSchema = z.object({
  conversation_id: z.string(),
});
export type DirectPairsChangedPayload = z.infer<
  typeof DirectPairsChangedPayloadSchema
>;

/** Body for `PATCH /api/channels/:id/archive`. Same toggle shape as the
 *  workspace archive endpoint. Archive is purely organizational — agents
 *  keep running, delivery keeps working; the sidebar groups archived
 *  channels under a collapsible Archived section. */
export const ArchiveChannelInputSchema = z.object({
  archived: z.boolean(),
});
export type ArchiveChannelInput = z.infer<typeof ArchiveChannelInputSchema>;

/** Body for `PATCH /api/channels/:id` — mutate a top-level channel's title OR
 *  visibility. EXACTLY ONE field per request (v1): the settings modal submits each
 *  mutation independently (rename vs private/public toggle are separate actions),
 *  so the handler dispatches to a single service call and there is no
 *  half-committed multi-field state. Archive / pin have their own dedicated
 *  routes.
 *
 *  There is ONE rename (#task:2016). The title IS the address, so display text and
 *  coordinate move together, in one transaction, under one audit event — the
 *  separate `name` mutation is gone, and with it the class of bug where a channel
 *  shows one thing and answers to another. */
export const UpdateChannelInputSchema = z
  .object({
    title: ChannelTitleSchema.optional(),
    visibility: ConversationVisibilitySchema.optional(),
  })
  .refine(
    input =>
      (input.title !== undefined ? 1 : 0)
        + (input.visibility !== undefined ? 1 : 0)
      === 1,
    { message: 'exactly one of `title` or `visibility` must be provided' },
  );
/** The REQUEST BODY, `z.input` — see {@link CreateConversationChannelInput} for
 *  why the branded output type is never the wire shape. */
export type UpdateChannelInput = z.input<typeof UpdateChannelInputSchema>;

/** Query for `GET /api/archived-channels`. `since` is epoch ms (inclusive
 *  lower bound on `archived_at`); the frontend converts 30d/14d/7d
 *  presets to a timestamp client-side. `workspace_id` narrows the list
 *  to a single workspace, omitted = all workspaces visible to the
 *  caller. */
export const ArchivedChannelsQueryInputSchema = z.object({
  workspace_id: z
    .preprocess(
      v => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().optional(),
    ),
  since: z
    .preprocess(
      v => (v === '' || v === undefined ? undefined : v),
      z.coerce.number().int().nonnegative().optional(),
    ),
});
export type ArchivedChannelsQueryInput = z.infer<
  typeof ArchivedChannelsQueryInputSchema
>;

/** Row in the global archived-channels list. This index is a deliberately
 *  cross-cutting recovery surface: it spans both channel-like collections
 *  (regular `channel` and `dm_channel`), so a user who archived a DM can
 *  still find and restore it from the default Archived entry. The
 *  workspace-scoped read paths (`/workspaces/:id/channels/archived`) stay
 *  segregated — only this global index merges. `workspace.archived_at`
 *  is included so the UI can flag rows whose workspace itself is
 *  archived without a second lookup. */
export const ArchivedChannelListItemDtoSchema = z.object({
  channel: ChannelLikeDtoSchema,
  workspace: z.object({
    id: z.string(),
    name: z.string(),
    archived_at: z.number().nullable(),
  }),
});
export type ArchivedChannelListItemDto = z.infer<
  typeof ArchivedChannelListItemDtoSchema
>;

export const ArchivedChannelsDtoSchema = z.object({
  channels: z.array(ArchivedChannelListItemDtoSchema),
});
export type ArchivedChannelsDto = z.infer<typeof ArchivedChannelsDtoSchema>;

// AUTO-SPLIT from the former monolithic api/dto.ts (#task:963).
// Bounded context: conversation. Re-exported via api/index.ts → @silverhand/shared.
import { z } from 'zod';
import { HandleSchema } from '../handle.js';
import { ConversationNameSchema } from './name.js';
import {
  ConversationAgentStatusSchema,
  ConversationEventKindSchema,
  ConversationKindSchema,
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
  kind: ConversationKindSchema,
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

/**
 * The channel-like conversation's STABLE SEMANTIC NAME (#task:2016) — the
 * allocated address, `null` when the row holds no current allocation.
 *
 * Not on `ConversationDtoSchema`. A name is an allocation in a WORKSPACE
 * namespace (`conversation_names`), so only workspace-placed conversations have
 * one at all, and reading it costs a join — a cost the base DTO's producers must
 * not pay: they include the aggregate read paths whose query plans are pinned to
 * production constants (#1967). Widening the base type would quietly conscript
 * every one of them.
 *
 * NULLABLE, and the null arm is reachable — deliberately not "always a string
 * because the backfill is total". `kind` is GENERATED from `roster_policy`, so an
 * `agent_inbox` row reports `kind='dm_channel'` and can reach a channel-like
 * mapper (`getChannelLike(id)` by id, for instance); an inbox is addressed by
 * its owning principal and never enters a workspace namespace. A consumer that
 * needs an address therefore has to handle its absence at typecheck instead of
 * discovering an `undefined` at render time.
 *
 * `title` is the DISPLAY name and is now nothing else: renaming the title leaves
 * this field untouched, which is the whole point of the field existing.
 *
 * The NON-NULL arm is {@link ConversationNameSchema}, not `z.string()` (@Cindy,
 * #task:2016 review): "present" and "well-formed" are not the same claim, and
 * this DTO is what a consumer trusts when it turns the value back into an
 * address — a `#<name>` sigil, a CLI selector, a line in a MEMORY.md. A value
 * outside the grammar is not spellable in any of those, so admitting it here
 * would publish a name that the surface reading this field cannot render as a
 * reference. The storage domain is closed by the v72 `CHECK` plus
 * `ConversationNameRepo.allocate`; stating the same domain on the wire type is
 * what makes that closure legible to every consumer instead of a fact one has to
 * go read the DDL to learn.
 */
const conversationNameField = {
  name: ConversationNameSchema.nullable(),
} as const;

export const ChannelConversationDtoSchema = ConversationDtoSchema.extend({
  kind: z.literal('channel'),
  ...conversationNameField,
});
export type ChannelConversationDto = z.infer<typeof ChannelConversationDtoSchema>;

export const DmChannelDtoSchema = ConversationDtoSchema.extend({
  kind: z.literal('dm_channel'),
  ...conversationNameField,
});
export type DmChannelDto = z.infer<typeof DmChannelDtoSchema>;

/** The single constraint for a channel's display title — shared by
 *  channel creation and rename so the two paths cannot drift (one
 *  concept, one rule). Freeform (spaces / CJK allowed), but trimmed
 *  and non-empty: a pure-whitespace title is rejected at the API
 *  boundary, not just by the UI. */
export const ChannelTitleSchema = z.string().trim().min(1).max(128);

export const CreateConversationChannelInputSchema = z.object({
  title: ChannelTitleSchema,
  /**
   * The channel's stable semantic NAME (#task:2016). Omitted = derived from
   * `title` by the shared deriver, so an ordinary caller never has to think about
   * addresses; spelled explicitly when the requester wants a specific address.
   *
   * A conflict in the workspace namespace is a 409 `conversation_name_taken` —
   * creation NEVER auto-suffixes. The address you asked for must be the address
   * you got, and silently handing back `design-2` would make the requester's own
   * follow-up reference point at someone else's channel. (The v72 backfill does
   * suffix: it must cover every pre-existing row and has no requester to tell.
   * The asymmetry is intentional.)
   */
  name: ConversationNameSchema.optional(),
  member_agent_ids: z.array(z.string()).default([]),
  member_user_ids: z.array(z.string()).optional(),
  // Channel visibility. Omitted = server default 'private'. `public` is a
  // human-only creation concept (the create route always acts as a user); the
  // service rejects a non-user actor requesting `public`.
  visibility: ConversationVisibilitySchema.optional(),
});
export type CreateConversationChannelInput = z.infer<
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
  kind: ConversationKindSchema,
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
export const WorkspaceChannelListItemSchema = z.discriminatedUnion('kind', [
  ChannelConversationDtoSchema.extend({ is_member: z.boolean() }),
  DmChannelDtoSchema.extend({ is_member: z.boolean() }),
]);
export type WorkspaceChannelListItem = z.infer<typeof WorkspaceChannelListItemSchema>;

/** Body for `PATCH /api/channels/:id/archive`. Same toggle shape as the
 *  workspace archive endpoint. Archive is purely organizational — agents
 *  keep running, delivery keeps working; the sidebar groups archived
 *  channels under a collapsible Archived section. */
export const ArchiveChannelInputSchema = z.object({
  archived: z.boolean(),
});
export type ArchiveChannelInput = z.infer<typeof ArchiveChannelInputSchema>;

/** Body for `PATCH /api/channels/:id` — mutate a top-level channel's title OR
 *  visibility OR name. EXACTLY ONE field per request (v1): the settings modal
 *  submits each mutation independently (rename vs private/public toggle vs
 *  re-address are separate actions), so the handler dispatches to a single
 *  service call and there is no half-committed multi-field state. `title` reuses
 *  `ChannelTitleSchema` (trimmed, 1–128) so rename and create validate titles
 *  identically, and `name` reuses `ConversationNameSchema` for the same reason;
 *  setting several (or none) is a 400. Archive / pin have their own dedicated
 *  routes.
 *
 *  `title` and `name` are two different mutations, not two spellings of one
 *  (#task:2016): a title change is display-only and MUST NOT move the address,
 *  and a name change retires the old address — every reference to it fails closed
 *  from then on — so it carries its own audit event. That asymmetry is why they
 *  are separate fields of a one-of rather than a single "rename". */
export const UpdateChannelInputSchema = z
  .object({
    title: ChannelTitleSchema.optional(),
    visibility: ConversationVisibilitySchema.optional(),
    name: ConversationNameSchema.optional(),
  })
  .refine(
    input =>
      (input.title !== undefined ? 1 : 0)
        + (input.visibility !== undefined ? 1 : 0)
        + (input.name !== undefined ? 1 : 0)
      === 1,
    { message: 'exactly one of `title`, `visibility` or `name` must be provided' },
  );
export type UpdateChannelInput = z.infer<typeof UpdateChannelInputSchema>;

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

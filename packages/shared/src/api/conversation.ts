// AUTO-SPLIT from the former monolithic api/dto.ts (#task:963).
// Bounded context: conversation. Re-exported via api/index.ts → @silverhand/shared.
import { z } from 'zod';
import {
  ConversationAgentStatusSchema,
  ConversationEventKindSchema,
  ConversationKindSchema,
  ConversationStatusSchema,
  RuntimeKindSchema,
} from '../db/schema.js';

export const ConversationDtoSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  workspace_path: z.string(),
  kind: ConversationKindSchema,
  parent_conversation_id: z.string().nullable(),
  title: z.string(),
  status: ConversationStatusSchema,
  spawned_by_agent_id: z.string().nullable(),
  closed_at: z.number().nullable(),
  close_summary: z.string().nullable(),
  archived_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type ConversationDto = z.infer<typeof ConversationDtoSchema>;

export const ChannelConversationDtoSchema = ConversationDtoSchema.extend({
  kind: z.literal('channel'),
  parent_conversation_id: z.null(),
});
export type ChannelConversationDto = z.infer<typeof ChannelConversationDtoSchema>;

export const DmChannelDtoSchema = ConversationDtoSchema.extend({
  kind: z.literal('dm_channel'),
  parent_conversation_id: z.null(),
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
  member_agent_ids: z.array(z.string()).default([]),
  member_user_ids: z.array(z.string()).optional(),
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
  workspace_path: z.string(),
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
  cli_session_id: z.string().nullable(),
  pid: z.number().nullable(),
  status: ConversationAgentStatusSchema,
  joined_at: z.number(),
});
export type ConversationAgentDto = z.infer<typeof ConversationAgentDtoSchema>;

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
// the platform prompt's "Members in this conversation:" block
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

/** Response shape for `GET /api/conversations/:id/members`. */
export const ConversationMembersResponseSchema = z.object({
  members: z.array(MemberDtoSchema),
});
export type ConversationMembersResponse = z.infer<
  typeof ConversationMembersResponseSchema
>;

const ConversationMemberHandleSchema = z
  .string()
  .trim()
  .regex(/^@?[a-zA-Z0-9_-]{1,64}$/, {
    message: 'handle must be @optional alphanumeric / dash / underscore',
  });

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
  handle: ConversationMemberHandleSchema,
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

/** Body for `PATCH /api/channels/:id/archive`. Same toggle shape as the
 *  workspace archive endpoint. Archive is purely organizational — agents
 *  keep running, delivery keeps working; the sidebar groups archived
 *  channels under a collapsible Archived section. */
export const ArchiveChannelInputSchema = z.object({
  archived: z.boolean(),
});
export type ArchiveChannelInput = z.infer<typeof ArchiveChannelInputSchema>;

/** Body for `PATCH /api/channels/:id` — rename a top-level channel.
 *  Reuses `ChannelTitleSchema` (trimmed, 1–128) so rename and create
 *  validate titles identically. Only the title is mutable here;
 *  archive / pin have their own dedicated routes. */
export const UpdateChannelInputSchema = z.object({
  title: ChannelTitleSchema,
});
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

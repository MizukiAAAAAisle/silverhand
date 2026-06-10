// AUTO-SPLIT from the former monolithic api/dto.ts (#task:963).
// Bounded context: workspace. Re-exported via api/index.ts → @silverhand/shared.
import { z } from 'zod';
import {
  AGENT_CAPABILITIES,
  WorkspaceKindSchema,
} from '../db/schema.js';
import { AgentDtoSchema } from './agent.js';
import { UserDtoSchema } from './user.js';

//
// New naming model for workspace -> channel/dm_channel/thread. The
// legacy Channel/Conversation DTOs below remain during the transition so the
// existing renderer can keep compiling until it is renamed.

export const WorkspaceDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  workspace_kind: WorkspaceKindSchema,
  workspace_path: z.string(),
  workspace_host_id: z.string(),
  owner_agent_id: z.string().nullable(),
  owner_user_id: z.string().nullable(),
  dm_channel_id: z.string().nullable(),
  dm_channel_ids: z.array(z.string()),
  pinned_at: z.number().nullable(),
  archived_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type WorkspaceDto = z.infer<typeof WorkspaceDtoSchema>;

export const WorkspaceMemberDtoSchema = z.object({
  workspace_id: z.string(),
  agent_id: z.string(),
  joined_at: z.number(),
});
export type WorkspaceMemberDto = z.infer<typeof WorkspaceMemberDtoSchema>;

export const WorkspaceRoleSchema = z.enum(['owner', 'admin', 'member']);
export type WorkspaceRoleDto = z.infer<typeof WorkspaceRoleSchema>;

/** Human membership in a workspace (v25). Parallel to
 *  `WorkspaceMemberDto` but for users instead of agents.
 *  `role` (v40, graded-permissions Layer A): governance role of this
 *  human in the workspace — `owner` is shown read-only in the UI;
 *  `admin` is modeled but not surfaced yet (amendment 4). */
export const WorkspaceUserMemberDtoSchema = z.object({
  workspace_id: z.string(),
  user_id: z.string(),
  joined_at: z.number(),
  role: WorkspaceRoleSchema,
});
export type WorkspaceUserMemberDto = z.infer<typeof WorkspaceUserMemberDtoSchema>;

/** Workspace human member list item. This keeps user display fields
 *  (avatar/name/display name) together with the membership edge fields
 *  needed for governance UI. */
export const WorkspaceHumanMemberDtoSchema = UserDtoSchema.extend({
  workspace_id: z.string(),
  user_id: z.string(),
  joined_at: z.number(),
  role: WorkspaceRoleSchema,
});
export type WorkspaceHumanMemberDto = z.infer<typeof WorkspaceHumanMemberDtoSchema>;

/**
 * Agent capability axis (graded-permissions Layer A cut 2, v41). Derived
 * from the canonical `AGENT_CAPABILITIES` const so the API enum, the
 * migration CHECK, and the backend registry never drift apart.
 */
export const AgentCapabilitySchema = z.enum(AGENT_CAPABILITIES);
export type AgentCapabilityDto = z.infer<typeof AgentCapabilitySchema>;

/** Effective capability set of one agent in one workspace (GET response,
 *  doc §2.4). `capabilities` is the deduped set of granted buckets;
 *  presence = granted. */
export const AgentCapabilitiesDtoSchema = z.object({
  workspace_id: z.string(),
  agent_id: z.string(),
  capabilities: z.array(AgentCapabilitySchema),
});
export type AgentCapabilitiesDto = z.infer<typeof AgentCapabilitiesDtoSchema>;

/** Replace-set edit of an agent's capabilities in a workspace (PUT input,
 *  doc §2.4). The full desired set is sent; the backend diffs against the
 *  stored rows. Unknown buckets are rejected by the enum (→ 400). */
export const UpdateAgentCapabilitiesInputSchema = z.object({
  capabilities: z.array(AgentCapabilitySchema),
});
export type UpdateAgentCapabilitiesInput = z.infer<typeof UpdateAgentCapabilitiesInputSchema>;

export const CreateWorkspaceInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_\-]+$/, 'name must be alphanumeric / dash / underscore'),
  description: z.string().optional(),
  workspace_path: z.string().optional(),
  workspace_host_id: z.string().optional(),
  member_agent_ids: z.array(z.string()).default([]),
  /** Initial human workspace members. The creator is always added
   *  separately; including them here is harmless (`INSERT OR IGNORE`). */
  member_user_ids: z.array(z.string()).default([]),
});
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInputSchema>;

export const UpdateWorkspaceInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_\-]+$/, 'name must be alphanumeric / dash / underscore')
    .optional(),
  description: z.string().nullable().optional(),
}).refine(v => Object.keys(v).length > 0, { message: 'no fields to update' });
export type UpdateWorkspaceInput = z.infer<typeof UpdateWorkspaceInputSchema>;

/** Body for `PATCH /api/workspaces/:id/archive`. Toggle-shaped instead of
 *  separate archive / unarchive endpoints — the UI flips a flag, the
 *  backend looks at the boolean. */
export const ArchiveWorkspaceInputSchema = z.object({
  archived: z.boolean(),
});
export type ArchiveWorkspaceInput = z.infer<typeof ArchiveWorkspaceInputSchema>;

export const AddWorkspaceAgentMemberInputSchema = z.object({
  agent_id: z.string(),
});
export const AddWorkspaceTaggedAgentMemberInputSchema = z.object({
  kind: z.literal('agent'),
  agent_id: z.string(),
});
export const AddWorkspaceHumanMemberInputSchema = z.object({
  kind: z.literal('human'),
  user_id: z.string(),
});
export const AddWorkspaceMemberInputSchema = z.union([
  AddWorkspaceTaggedAgentMemberInputSchema,
  AddWorkspaceHumanMemberInputSchema,
  AddWorkspaceAgentMemberInputSchema,
]);
export type AddWorkspaceMemberInput = z.infer<typeof AddWorkspaceMemberInputSchema>;

export const WorkspaceMembersResponseSchema = z.object({
  members: z.array(AgentDtoSchema),
  human_members: z.array(WorkspaceHumanMemberDtoSchema),
  /** Request-scoped convenience projection of the current viewer's role in
   *  this workspace. Derived from the same membership edge as
   *  `human_members[].role`; not a second source of truth. */
  viewer_role: WorkspaceRoleSchema.nullable(),
});
export type WorkspaceMembersResponse = z.infer<
  typeof WorkspaceMembersResponseSchema
>;

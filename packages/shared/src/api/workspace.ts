// AUTO-SPLIT from the former monolithic api/dto.ts (#task:963).
// Bounded context: workspace. Re-exported via api/index.ts → @silverhand/shared.
import { z } from 'zod';
import {
  AGENT_CAPABILITIES,
} from '../db/schema.js';
import { AgentDtoSchema } from './agent.js';
import { UserDtoSchema } from './user.js';
import { WorkspaceNameSchema } from './name.js';

//
// New naming model for workspace -> channel/dm_channel/thread. The
// legacy Channel/Conversation DTOs below remain during the transition so the
// existing renderer can keep compiling until it is renamed.

/**
 * A workspace as the DOMAIN sees it — the shape `WorkspaceRepo` returns.
 *
 * It carries the OWNERSHIP RELATION (`owner_agent_id`) and no container word at
 * all. There used to be a stored `workspace_kind` here, mirrored from the column;
 * every authorization door, kind guard and plan asks ownership through one named
 * predicate (`isAgentHomeWorkspace` / `isAgentHomeWorkspaceOf`, see
 * `agent-home-workspace.ts`) — a container IS an agent home exactly when it has a
 * home agent — so the word was the same bit spelled twice. #task:2082 removed the
 * last decision that read it, #task:2075 stopped publishing it, #task:2081 retired
 * the last wire (`runtime_start`), and #task:2080 dropped the column itself; this
 * domain shape retired its mirror in that same step. Do NOT reintroduce a decision
 * that reads a container word, and do not re-derive one from `owner_agent_id`:
 * that would move the alphabet rather than retire it.
 *
 * The host wire keys filesystem path resolution on the CONTAINER's identity
 * separately (`runtime/runtime-start-options.ts` → `RuntimeStartWorkspaceRefSchema`).
 * Publishing product words into this core would invert the dependency: the
 * domain would speak the presentation's vocabulary.
 *
 * It was called `WorkspaceDto` until #task:2069. The suffix was a naming lie:
 * one name did two jobs — this domain shape AND the payload the desktop
 * received verbatim from `c.json` — which is precisely why there was no place
 * to convert the word at. {@link ViewerWorkspaceDtoSchema} is that place now.
 */
export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  owner_agent_id: z.string().nullable(),
  owner_user_id: z.string().nullable(),
  dm_channel_id: z.string().nullable(),
  dm_channel_ids: z.array(z.string()),
  archived_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

/**
 * A workspace as PUBLISHED to a human viewer — what the desktop receives from
 * every `/api/workspaces*` face. It carries the ownership relation
 * (`owner_agent_id`) and no container word at all: #task:2075's stop-publish step
 * deleted the published `workspace_kind`, because that word was the same bit
 * spelled twice — the renderer asks "whose container is this" through
 * `isAgentHomeWorkspace*` instead of decoding a kind (#task:2078).
 *
 * Spelled out field by field rather than derived from {@link WorkspaceSchema}
 * with one substitution: a derived face would auto-publish every future domain
 * field, which is the double-duty problem again wearing a second name. What the
 * wire carries is a CHOICE. `tests/viewer-workspace-face.test.ts` keeps a ledger
 * cell over these keys, so a deliberate divergence is updated in the commit that
 * makes it and an accidental one goes red.
 */
export const ViewerWorkspaceDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  owner_agent_id: z.string().nullable(),
  owner_user_id: z.string().nullable(),
  dm_channel_id: z.string().nullable(),
  dm_channel_ids: z.array(z.string()),
  archived_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type ViewerWorkspaceDto = z.infer<typeof ViewerWorkspaceDtoSchema>;

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
  name: WorkspaceNameSchema,
  description: z.string().optional(),
  member_agent_ids: z.array(z.string()).default([]),
  /** Initial human workspace members. The creator is always added
   *  separately; including them here is harmless (`INSERT OR IGNORE`). */
  member_user_ids: z.array(z.string()).default([]),
});
export type CreateWorkspaceInput = z.input<typeof CreateWorkspaceInputSchema>;

export const UpdateWorkspaceInputSchema = z.object({
  name: WorkspaceNameSchema.optional(),
  description: z.string().nullable().optional(),
}).refine(v => Object.keys(v).length > 0, { message: 'no fields to update' });
export type UpdateWorkspaceInput = z.input<typeof UpdateWorkspaceInputSchema>;

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

export const UpdateWorkspaceHumanMemberRoleInputSchema = z.object({
  role: WorkspaceRoleSchema,
});
export type UpdateWorkspaceHumanMemberRoleInput = z.infer<
  typeof UpdateWorkspaceHumanMemberRoleInputSchema
>;

export const UpdateWorkspaceHumanMemberRoleResponseSchema = z.object({
  member: WorkspaceUserMemberDtoSchema,
  human_member: WorkspaceHumanMemberDtoSchema,
});
export type UpdateWorkspaceHumanMemberRoleResponse = z.infer<
  typeof UpdateWorkspaceHumanMemberRoleResponseSchema
>;

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

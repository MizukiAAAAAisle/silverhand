import { isAgentSpace, type WorkspaceOwnership } from './workspace-ownership';

/**
 * STRUCTURAL capabilities of one workspace container — what the container itself
 * can have, independent of who is looking at it.
 *
 * Two reasons this exists as its own seam (#task:2066, parent #task:2045 §A):
 *
 *  1. **The dialogs must not steer on a kind string.** `CreateChannelDialog` and
 *     `WorkspaceSettingsDialog` used to take `workspaceKind: string | null` and
 *     branch on `=== 'dm'`. A `string` prop is invisible to the compiler, and
 *     #task:2066 B1 then did rename the renderer union (`dm` → `agent_space`):
 *     both comparisons would have kept compiling and become permanently false —
 *     and the fallout is not a wrong glyph but an Agent Space growing a member
 *     picker that posts `member_*_ids` / `visibility`, plus rename, lifecycle and
 *     leave coming back. Deriving the facts HERE made that rename a type error at
 *     one place (comparing the narrowed union against a non-member literal), so
 *     the guard is the compiler rather than a comment.
 *  2. **`kind` is not the fact the UI wants.** Every branch those dialogs took
 *     was really asking "can this be renamed / does it have members / does it
 *     have a lifecycle". Passing capabilities keeps the domain word in ONE module
 *     and lets a future container kind answer the same three questions without
 *     touching either dialog.
 *
 * This axis is orthogonal to `workspace-permissions.ts`: that one answers "may
 * THIS VIEWER write" (role-derived, fail-closed while unresolved), this one
 * answers "does the container have the thing at all". Both must hold for a write
 * affordance to render.
 */
export interface WorkspaceCapabilities {
  /** The name is the user's to set. False for a container whose name is DERIVED
   *  from its owning agent (Agent Space), where renaming has no meaning — the
   *  dialog's explanatory copy asserts that provenance, so a second producer of
   *  `false` must carry its own reason instead of reusing this flag. */
  nameSettable: boolean;
  /** The container has a member set — member picker on create, per-member
   *  permission panels in settings. False for an Agent Space: it is the viewer
   *  and its one agent, with nothing to pick or grade. */
  hasMembers: boolean;
  /** The container has its own lifecycle (archive / delete / leave). False for
   *  an Agent Space: it lives and dies with its agent, so those doors belong to
   *  the agent, not to the space. */
  hasLifecycle: boolean;
}

const REGULAR_WORKSPACE: WorkspaceCapabilities = {
  nameSettable: true,
  hasMembers: true,
  hasLifecycle: true,
};

const AGENT_SPACE: WorkspaceCapabilities = {
  nameSettable: false,
  hasMembers: false,
  hasLifecycle: false,
};

/**
 * The ONE place a workspace container's identity turns into UI capability facts.
 *
 * It asks OWNERSHIP (`isAgentSpace`), not a kind string — the two were the same
 * bit and the kind is retired (#task:2078). What that costs and what replaces it:
 * the arms used to be a `default`-less switch, so adding a container kind was a
 * compile error here. The distinction is now a boolean, so there is no alphabet
 * left to extend silently — a third kind of container could only arrive as a new
 * FIELD, which every caller of this function would have to be changed to supply.
 *
 * A missing container (`null` — nothing selected yet, the list has not resolved,
 * or the row disappeared under an open dialog) answers with the
 * regular-workspace shape ON PURPOSE, which is what the old
 * `workspaceKind === 'dm'` comparison produced for `null` too. It is not a fail-open ONLY
 * because both callers derive the workspace id from the same row they derive
 * capabilities from (`App.tsx`), so an unresolved row means no id, and Save /
 * Archive / Delete / Leave / Create all gate on the id while the viewer-role
 * axis stays fail-closed. Answering `AGENT_SPACE` instead would be worse than
 * useless — it would print "takes its name from its agent" for a container that
 * does not exist. A future caller that pairs a live id with an unresolved row
 * reopens exactly that hole.
 */
export function workspaceCapabilities(
  workspace: WorkspaceOwnership | null | undefined,
): WorkspaceCapabilities {
  if (!workspace) return REGULAR_WORKSPACE;
  return isAgentSpace(workspace) ? AGENT_SPACE : REGULAR_WORKSPACE;
}

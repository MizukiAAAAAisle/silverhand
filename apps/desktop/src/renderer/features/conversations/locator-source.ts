import { isAgentSpace, type WorkspaceOwnership } from '../workspaces/workspace-ownership';

/** A workspace row as the locator PRODUCER reads it: the display name it would
 *  spell, plus the ownership fact that decides whether spelling it is even legal. */
export type LocatorWorkspaceRow = WorkspaceOwnership & {
  readonly name: string;
};

/**
 * The workspace name a Composer may mint into a `<silverhand://workspace/...>`
 * locator, or `null` when no such name exists and the producer must fall back to
 * the opaque `#conv:<id>` permanent-id form.
 *
 * ONLY A REGULAR WORKSPACE IS SPELLABLE. This is the PRODUCER half of the rule
 * `locator-target.ts` enforces on the RESOLVER side: that module folds the first
 * segment against the viewer's workspace list through a uniqueness index that
 * covers `owner_agent_id IS NULL` only, so an Agent Space name is not one this
 * grammar can spell — a locator minted with it resolves to `null` and draws the
 * inert sigil. Emitting it from the picker would hand the user a token that is
 * dead the instant it lands. A missing / unresolved row is likewise unspellable.
 *
 * CLASSIFY THROUGH `isAgentSpace`, never a bare `owner_agent_id` test at this
 * point (`workspace-ownership.ts`): the id also answers "whose avatar", and a
 * local nullability check is the drift that predicate exists to prevent. The
 * placement decision lives HERE, in the pane owner's producer, not in the shared
 * `formatLocator` — the formatter is total over a validated coordinate and must
 * not guess a container's kind from its name.
 */
export function locatorWorkspaceName(
  workspace: LocatorWorkspaceRow | null | undefined,
): string | null {
  if (!workspace || isAgentSpace(workspace)) return null;
  return workspace.name;
}

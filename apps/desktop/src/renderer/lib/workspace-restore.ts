/**
 * Workspace to auto-select when the chat section opens without a workspaceId
 * (#task:1222).
 *
 * Clicking the "Chat" navrail item routes to bare `/chat` (it carries no
 * workspaceId), so when the user switches away to another section and comes
 * back, the chat auto-pick effect runs with no selection. The rule (mirrors
 * the members section's `lastSelectedAgentId` restore):
 *
 *   1. **remembered** — the workspace the user last had open this app run, if
 *      it still exists in the list. This is what makes a section round-trip
 *      land back where the user left off instead of snapping to the top.
 *   2. else **first** — cold start (no prior selection) or the remembered
 *      workspace is gone (deleted / archived elsewhere): fall back to the
 *      first workspace in list order.
 *   3. else **null** — no workspaces at all; the caller leaves chat empty.
 *
 * Pure so the precedence is unit-tested independent of React/nav wiring; the
 * effect only performs the nav side-effect with the result.
 *
 * `rememberedId` can come from persisted place memory; it is null only when the
 * viewer has no valid workspace memory yet.
 */
export function pickWorkspaceToRestore(
  workspaces: readonly { id: string }[],
  rememberedId: string | null,
): string | null {
  if (workspaces.length === 0) return null;
  if (rememberedId && workspaces.some((w) => w.id === rememberedId)) {
    return rememberedId;
  }
  return workspaces[0]!.id;
}

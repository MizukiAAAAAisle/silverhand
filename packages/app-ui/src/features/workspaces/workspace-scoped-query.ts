/**
 * The gate every workspace-scoped read shares. A LEAF module on purpose: both
 * `features/workspaces/hooks.ts` and `features/channels/message-unread.ts` need
 * it, and importing the former from the latter closes a module-init cycle
 * (hooks → viewer-removal-contract → … → message-unread) that breaks at load
 * time, not at type-check time.
 */

/**
 * Whether a workspace-scoped read may fire: the id must be known AND the
 * container ROW behind it must have resolved (#task:2078).
 *
 * TWO INDEPENDENT ABSENCES, one verdict. The id comes from the URL, the row from
 * the workspace list query, so "id known, row not yet" is a real window — and
 * fetching in it asks the server about a container this client cannot yet name.
 * The predicate exists (rather than four inline `&&`s) so the query gates and
 * the `workspace:<id>` WS subscription gate cannot drift apart, and so the
 * behaviour is testable without a render harness.
 *
 * It replaced `archivedChannelsEnabledForKind`, a kind predicate whose arms were
 * an OR over the whole alphabet — every kind was enabled, so its only real cell
 * was `null ⇒ false`, i.e. exactly this "unresolved ⇒ don't ask" rule.
 *
 * Typed as a guard on `workspaceId` so `useChannelsForWorkspace`'s subscription
 * effect narrows off the same call it gates on, instead of repeating the null
 * check.
 */
export function workspaceScopedQueryEnabled(
  workspaceId: string | null,
  workspaceResolved: boolean,
): workspaceId is string {
  return !!workspaceId && workspaceResolved;
}

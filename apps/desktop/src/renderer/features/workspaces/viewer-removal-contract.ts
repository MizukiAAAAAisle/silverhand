// Viewer-local projection removal contract (#task:1411 — Class B hardening).
//
// BUG CLASS this closes: a single "viewer lost visibility of workspace X"
// domain fact (`viewer_workspaces_changed(removed)`) fans out to MULTIPLE
// independent viewer-local React-Query caches. Each is a separate query — one
// refetch/patch never touches another. When the removal handler hand-maintains
// its cleanup list, forgetting one cache is SILENT: exactly the regression hit
// twice (#task:1404 missed favorites, #task:1409 missed Activity).
//
// The hard rule shiki asked for is "add a projection without wiring it → the
// test goes RED". That needs TWO independent completeness layers, because they
// fail in different ways:
//
//   LAYER 1 — settle every WORKSPACE-KEYED cache by FORM, not by name.
//     Any cache whose key is `['workspaces', wsId, …]` (the by_conversation
//     unread map, plus channels / members / capabilities / archived lists in
//     workspaces/hooks.ts) is dropped by ONE predicate sweep below. Zero
//     enumeration: a new workspace-keyed cache is covered the moment it exists,
//     nothing to register. This is the cheap, un-forgettable majority.
//
//   LAYER 2 — INVENTORY the residue: global-key caches whose `workspace_id`
//     lives INSIDE the payload (`['message-unread','summary']` map, favorites
//     items, Activity items). A key sweep cannot find these, so each is declared
//     in {@link PROJECTIONS} with an id-consuming filter, and the handler loops
//     the inventory. Three compile/behaviour guards keep the inventory honest:
//       (a) `Record<ProjectionId, …>` → a declared id with no cleanup fails to
//           compile;
//       (b) the contract test's seed map is also `Record<ProjectionId, …>` →
//           a declared id with no test seed fails to compile;
//       (c) the whole-cache invariant test → a wrong/partial cleanup goes red.
//
//   THE 4th FAILURE MODE (a cache never added to the inventory AT ALL) is caught
//   by {@link VIEWER_LOCAL_KEY_CLASSIFICATION} + the source-fence test: it reads
//   the read-model files and asserts EVERY exported query key is classified —
//   cleaned (has a handler), or exempt with a stated reason (sweep-covered /
//   not workspace-attributed). A new exported `*Key` in those files that is
//   neither → RED. That is the structural rule; the inventory alone would just
//   relocate the forget-point.
//
// RESIDUAL (flagged, not hidden — mirrors Alice's #task:1410 note): the fence
// covers the read-model files where item-scoped caches live, and the sweep
// covers workspace-keyed caches anywhere. A NEW *global-key* viewer-local cache
// added OUTSIDE those fenced files would still escape. Closing that fully needs
// a `WorkspaceAttributed { workspace_id }` DTO marker so attribution is a type,
// not a naming convention — the next increment.
import type { QueryClient } from '@tanstack/react-query';
import { removeWorkspaceFromActivity } from '@/features/attention/hooks';
import { removeWorkspaceFromFavorites } from '@/features/favorites/hooks';
import { removeWorkspaceFromMessageUnread } from '@/features/channels/message-unread';

/** How a viewer-local cache carries workspace attribution — determines which
 *  completeness layer settles it. */
export type ProjectionForm =
  /** `workspace_id` is a segment of the query KEY (`['workspaces', wsId, …]`) →
   *  settled by the predicate sweep in {@link handleViewerWorkspaceRemoved}. No
   *  inventory entry needed. */
  | 'workspace-keyed'
  /** Key is global; `workspace_id` lives INSIDE the payload (a map entry or list
   *  items) → cleaned by an in-place filter that consumes the id (inventory). */
  | 'global-item-scoped';

/** Every GLOBAL-key viewer-local projection needing targeted removal cleanup
 *  (Layer 2). Adding a member here forces {@link PROJECTIONS} to grow
 *  (compile-time completeness). Workspace-keyed caches are NOT listed — the
 *  sweep covers them by form. */
export type ProjectionId = 'message-unread' | 'favorites' | 'activity';

export interface ViewerLocalProjection {
  /** The cache form(s) this projection spans — documentation + fence
   *  classification. */
  form: ProjectionForm | ProjectionForm[];
  /** Settle this projection for a removed workspace. Consumes the id; NEVER
   *  refetches (a deleted workspace's scoped query 404s). Idempotent + no-op
   *  when the cache is cold. */
  cleanup: (qc: QueryClient, workspaceId: string) => void;
}

// Exhaustive by construction: `Record<ProjectionId, …>` means a new ProjectionId
// with no entry FAILS TO COMPILE — the compile-time half of Layer 2.
const PROJECTIONS: Record<ProjectionId, ViewerLocalProjection> = {
  // Spans TWO caches: the `by_conversation` per-workspace map (workspace-KEYED,
  // also caught by the Layer-1 sweep) and the global `by_workspace` summary (a
  // map keyed by workspace_id inside a GLOBAL cache — sweep can't reach it).
  // `removeWorkspaceFromMessageUnread` settles both; the summary is why it must
  // stay in the inventory.
  'message-unread': {
    form: ['workspace-keyed', 'global-item-scoped'],
    cleanup: removeWorkspaceFromMessageUnread,
  },
  favorites: {
    form: 'global-item-scoped',
    cleanup: removeWorkspaceFromFavorites,
  },
  activity: {
    form: 'global-item-scoped',
    cleanup: removeWorkspaceFromActivity,
  },
};

/** The inventory as an array (stable order for iteration + test enumeration). */
export const VIEWER_LOCAL_PROJECTIONS: ReadonlyArray<
  { id: ProjectionId } & ViewerLocalProjection
> = (Object.keys(PROJECTIONS) as ProjectionId[]).map(id => ({
  id,
  ...PROJECTIONS[id],
}));

/**
 * Classification of EVERY exported query key in the viewer-local read-model
 * files (`attention/hooks`, `favorites/hooks`, `channels/message-unread`). The
 * source-fence test asserts each exported `*Key` there is listed here — a new,
 * unclassified key goes RED. This is the 4th-failure-mode net: it stops a cache
 * from being added without a conscious "cleaned or why-exempt" decision.
 *
 * `cleaned` — workspace-attributed GLOBAL-key caches; each has an inventory
 *   handler (its symbol maps 1:1 to a {@link ProjectionId}).
 * `exempt`  — everything else, WITH a reason: workspace-keyed (Layer-1 sweep) or
 *   not workspace-attributed at all (conversation-scoped).
 */
export const VIEWER_LOCAL_KEY_CLASSIFICATION = {
  cleaned: [
    'messageUnreadSummaryKey',
    'favoritesKey',
    'activityKey',
  ] as const,
  exempt: {
    messageUnreadByConversationKey:
      'workspace-keyed (["workspaces", wsId, …]) → Layer-1 predicate sweep',
    conversationUnreadKey:
      'conversation-scoped, not workspace-attributed (per-stream unread; conversation removal is a different fact)',
    channelAttentionPreferenceKey:
      'conversation-scoped, not workspace-attributed (per-channel attention pref)',
  } as const,
};

/** Predicate: is this a workspace-keyed cache for the removed workspace? Matches
 *  `['workspaces', wsId, …]` — the by_conversation unread map plus the
 *  channels/members/capabilities/archived caches in workspaces/hooks.ts. */
function isWorkspaceKeyed(queryKey: unknown, workspaceId: string): boolean {
  return (
    Array.isArray(queryKey) &&
    queryKey[0] === 'workspaces' &&
    queryKey[1] === workspaceId
  );
}

/**
 * Settle EVERY viewer-local projection for a removed workspace — the single
 * chokepoint the `viewer_workspaces_changed(removed)` handler funnels through.
 *
 * Layer 1: one predicate sweep drops all workspace-keyed caches (by form, no
 * enumeration). Layer 2: loop the inventory for the global-key residue. The
 * `['workspaces']` root list is settled separately (refetch-authoritative) by
 * the general invalidation loop in `useViewerWorkspacesSync`.
 */
export function handleViewerWorkspaceRemoved(
  qc: QueryClient,
  workspaceId: string,
): void {
  // Layer 1 — workspace-keyed family, by form. A deleted workspace's scoped
  // query would 404 on refetch, so drop the entries outright.
  qc.removeQueries({
    predicate: query => isWorkspaceKeyed(query.queryKey, workspaceId),
  });
  // Layer 2 — global-key residue whose workspace_id lives in the payload.
  for (const projection of VIEWER_LOCAL_PROJECTIONS) {
    projection.cleanup(qc, workspaceId);
  }
}

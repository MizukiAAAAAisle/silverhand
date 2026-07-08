// Viewer-local projection removal contract (#task:1411 → #task:1412 hardening).
//
// BUG CLASS this closes: a single "viewer lost visibility of workspace X"
// domain fact (`viewer_workspaces_changed(removed)`) fans out to MULTIPLE
// independent viewer-local React-Query caches. Each is a separate query — one
// refetch/patch never touches another. When the removal handler hand-maintains
// its cleanup list, forgetting one cache is SILENT: exactly the regression hit
// twice (#task:1404 missed favorites, #task:1409 missed Activity).
//
// #task:1412 turns the completeness net from a runtime source-text scan into a
// TYPE-CLOSED registry chokepoint. Three enforcement layers, each a distinct
// failure mode:
//
//   1. FORM-BY-CONSTRUCTION — workspace-KEYED caches (`['workspaces', wsId, …]`:
//      by_conversation unread + channels / members / capabilities / archived in
//      workspaces/hooks.ts) are dropped by ONE predicate sweep. Zero enumeration:
//      a new workspace-keyed cache is covered the moment it exists.
//
//   2. TYPED REGISTRY — global-key caches whose `workspace_id` lives in the
//      PAYLOAD are declared in {@link VIEWER_LOCAL_READ_MODELS} through
//      registration helpers whose types make `cleanup` MANDATORY:
//        - {@link itemScopedList} takes `entry: TData extends ItemScopedListData
//          ? Entry : never`. Because TS is STRUCTURAL, a DTO that already carries
//          `workspace_id` (ActivityItemDto, FavoriteRowDto) satisfies the guard
//          with no shared `extends`; a NON-attributed DTO — OR omitting the type
//          param — collapses the param to `never`, and `cleanup` is required. So a
//          new `{ items: WorkspaceAttributed[] }` cache CANNOT be registered
//          without a removal cleanup, and attribution can never be defaulted-away
//          (proven by the `@ts-expect-error` fixtures in the type-test).
//        - {@link recordKeyedSummary} tags the one Record-keyed cache
//          (`{ by_workspace: Record<wsId, …> }`) — structurally undetectable, so
//          the form is explicit and `cleanup` is required by the signature.
//      The removal handler dispatches over `form` with an EXHAUSTIVE `never`
//      check, so a 4th form that skips a branch fails to compile (the symmetric
//      lesson to #task:1410's source-registry `never`).
//
//   3. SOURCE BACKSTOP (non-critical smoke) — the only hole types cannot close
//      is a cache defined with a raw `useQuery` that never flows through the
//      registry. `VIEWER_LOCAL_KEY_CLASSIFICATION` + the smoke test cross-check
//      that every exported query key in the read-model files is registry-handled
//      or explicitly exempt. This REPLACES #task:1411's regex fence: the
//      "cleaned" set is now DERIVED from the registry (consistency test), not a
//      parallel hand-list that could drift.
//
// RESIDUAL (flagged, not hidden — mirrors Alice's #task:1410 note): this is a
// CLEANUP-DECLARATION chokepoint, NOT a QUERY-DEFINITION chokepoint. The query
// KEYS still live in their feature files; the registry references them, it does
// not own them. So a cache defined with a raw `useQuery` that never flows through
// the registry is a hole types cannot close in any language — and layer 3 is a
// text smoke over a FIXED file list, so a global-key cache added in a NEW file
// escapes it too. Moving key definitions INTO the registry (a real
// query-definition chokepoint) is a cross-module refactor deliberately DEFERRED
// (#task:1412 consensus): layer-3 smoke + the whole-cache invariant test (the
// form-agnostic behavioural backstop that scans the entire cache for any
// surviving wsId) already cover the off-registry residue for the current files.
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type {
  ListActivityDto,
  ListFavoritesDto,
} from '@silverhand/shared';
import { activityKey, removeWorkspaceFromActivity } from '@/features/attention/hooks';
import { favoritesKey, removeWorkspaceFromFavorites } from '@/features/favorites/hooks';
import {
  messageUnreadSummaryKey,
  removeWorkspaceFromMessageUnread,
} from '@/features/channels/message-unread';

/** Structural marker: a value that belongs to exactly one workspace. Renderer-
 *  local BY DESIGN — TS is structural, so any DTO that already has
 *  `workspace_id: string` satisfies it with no shared `extends` (a shared marker
 *  would be a decorative re-declaration of an existing field, #task:1412). NOTE
 *  the field is REQUIRED: a DTO with `workspace_id?: string` would NOT match, so
 *  the conditional cleanup guard would silently stop firing — the type-test
 *  pins the current DTOs as attributed to catch that regression (Alice ①). */
export type WorkspaceAttributed = { workspace_id: string };

/** The one payload shape whose attribution TS can PROVE: a list of attributed
 *  items. Drives the mandatory-cleanup constraint in {@link itemScopedList}. */
export type ItemScopedListData = { items: WorkspaceAttributed[] };

/** How a viewer-local cache carries a workspace — each settles differently on
 *  removal. Exhaustive: a 4th member must also gain a dispatch branch in
 *  {@link handleViewerWorkspaceRemoved} or the `never` check fails to compile. */
export type ProjectionForm =
  /** key = `['workspaces', wsId, …]` → predicate sweep (layer 1). */
  | 'workspace-keyed'
  /** global key, data = `{ by_workspace: Record<wsId, …> }` → delete map entry. */
  | 'record-keyed-summary'
  /** global key, data = `{ items: WorkspaceAttributed[] }` → filter items. */
  | 'item-scoped-list';

type CleanupFn = (qc: QueryClient, workspaceId: string) => void;

/** A viewer-local read model that needs targeted (non-sweep) removal cleanup. */
export interface RegisteredReadModel {
  readonly id: string;
  readonly form: ProjectionForm;
  readonly key: QueryKey;
  readonly cleanup: CleanupFn;
}

/** The registration entry for an item-scoped list. */
interface ItemScopedListEntry {
  id: string;
  key: QueryKey;
  cleanup: CleanupFn;
}

/**
 * Register an ITEM-SCOPED list read model. Attribution is proven at the type
 * level: the entry param is `TData extends ItemScopedListData ? Entry : never`,
 * so `TData` MUST be passed explicitly (`itemScopedList<ListActivityDto>({…})`)
 * AND the DTO must genuinely carry `workspace_id`:
 *   - a NON-attributed DTO → the conditional resolves to `never` → the object
 *     literal is rejected;
 *   - OMITTING the type param → `TData` defaults to `unknown ⊄ ItemScopedListData`
 *     → also `never` (this is why the constraint is on the param, not a phantom
 *     `<TData extends …>` that silently skips when the arg is omitted — Alice ②:
 *     attribution is checked by construction, never merely by convention);
 *   - `cleanup` is a required field, so registration without a removal cleanup
 *     cannot compile.
 * All three are pinned by `@ts-expect-error` fixtures in the type-test.
 */
export function itemScopedList<TData>(
  entry: TData extends ItemScopedListData ? ItemScopedListEntry : never,
): RegisteredReadModel {
  // The conditional param proved attribution; narrow back for the runtime value
  // (TData is compile-time only — nothing to read at runtime).
  return { ...(entry as ItemScopedListEntry), form: 'item-scoped-list' };
}

/**
 * Register the Record-keyed summary read model (`{ by_workspace: Record<wsId,…> }`).
 * A `Record<string, …>` is structurally any object, so attribution is NOT
 * type-detectable — the form is explicit and `cleanup` is required by signature.
 */
export function recordKeyedSummary(entry: ItemScopedListEntry): RegisteredReadModel {
  return { ...entry, form: 'record-keyed-summary' };
}

/**
 * THE registry: every global-key viewer-local read model needing targeted
 * cleanup. Workspace-KEYED caches are NOT here — layer 1's sweep covers them by
 * form. Add a member and its cleanup is mandatory by construction (see helpers).
 */
export const VIEWER_LOCAL_READ_MODELS: readonly RegisteredReadModel[] = [
  itemScopedList<ListActivityDto>({
    id: 'activity',
    key: activityKey(),
    cleanup: removeWorkspaceFromActivity,
  }),
  itemScopedList<ListFavoritesDto>({
    id: 'favorites',
    key: favoritesKey,
    cleanup: removeWorkspaceFromFavorites,
  }),
  recordKeyedSummary({
    id: 'message-unread-summary',
    key: messageUnreadSummaryKey,
    // Also drops the workspace-keyed `by_conversation` map (belt-and-suspenders
    // with the layer-1 sweep, both idempotent); the summary map delete is the
    // part only this cleanup does.
    cleanup: removeWorkspaceFromMessageUnread,
  }),
];

/**
 * Classification of EVERY exported query key in the viewer-local read-model
 * files (`attention/hooks`, `favorites/hooks`, `channels/message-unread`). The
 * smoke test asserts each exported `*Key` there is listed — an unclassified new
 * key goes RED (layer 3, the chokepoint-bypass backstop). `cleaned` is kept in
 * lockstep with {@link VIEWER_LOCAL_READ_MODELS} by a consistency test, so it is
 * not a hand-list that can drift from the registry.
 */
export const VIEWER_LOCAL_KEY_CLASSIFICATION = {
  /** Workspace-attributed global-key caches — each maps to a registry entry. */
  cleaned: ['messageUnreadSummaryKey', 'favoritesKey', 'activityKey'] as const,
  exempt: {
    messageUnreadByConversationKey:
      'workspace-keyed (["workspaces", wsId, …]) → layer-1 predicate sweep',
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

function assertNever(x: never): never {
  throw new Error(`unhandled viewer-local projection form: ${String(x)}`);
}

/**
 * Settle EVERY viewer-local projection for a removed workspace — the single
 * chokepoint the `viewer_workspaces_changed(removed)` handler funnels through.
 *
 * Layer 1: one predicate sweep drops all workspace-keyed caches (by form, no
 * enumeration). Layer 2: dispatch each registered read model by `form`, with an
 * exhaustive `never` so a new form cannot skip a branch. The `['workspaces']`
 * root list is settled separately (refetch-authoritative) by the general
 * invalidation loop in `useViewerWorkspacesSync`.
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
  // Layer 2 — registered global-key read models, dispatched by form.
  for (const rm of VIEWER_LOCAL_READ_MODELS) {
    switch (rm.form) {
      case 'workspace-keyed':
        // Covered by the layer-1 sweep; no registered entry uses this form
        // today, but the branch keeps the dispatch exhaustive + documents it.
        break;
      case 'record-keyed-summary':
      case 'item-scoped-list':
        rm.cleanup(qc, workspaceId);
        break;
      default:
        assertNever(rm.form);
    }
  }
}

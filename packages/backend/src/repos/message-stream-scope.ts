// The SINGLE definition of the mainline-vs-thread-cluster stream predicate.
//
// Both the message-window read-model (listWindowForMainStream /
// listWindowForThreadCluster) and message search (SearchRepo, the header
// inline find) scope rows through this one predicate. Sharing it is what
// makes "搜到必可见" a by-construction invariant: a search hit produced under
// `mainline` / `thread` scope is, by identical predicate, always inside the
// window the panel renders — so it can be materialized (jump/prime) and
// highlighted, never a DB-only ghost.
//
// The predicate is parameterized on the scope MODE (passed as a bound `?`)
// so one SQL text serves all three modes; pair it with `streamScopeParams`,
// which emits the matching 5 bound values in order.

export type WindowScope =
  | { mode: 'all' }
  | { mode: 'main' }
  | { mode: 'cluster'; threadRootId: string };

export type WindowScopeMode = WindowScope['mode'];

/** SQL fragment matching rows in the requested stream. `colPrefix` qualifies
 *  the `id` / `thread_root_id` columns (e.g. `'m.'` when the query aliases
 *  `messages` as `m`, `''` for a bare `messages` scan). Emits three mode
 *  placeholders then, for the cluster branch, the root id twice — exactly the
 *  order `streamScopeParams` returns. */
export function streamScopePredicate(colPrefix = ''): string {
  const p = colPrefix;
  return `(
              ? = 'all'
              OR (? = 'main' AND ${p}thread_root_id IS NULL)
              OR (? = 'cluster' AND (${p}id = ? OR ${p}thread_root_id = ?))
            )`;
}

/** Bound values for `streamScopePredicate`, in order: mode ×3, then the
 *  cluster root id ×2 (null outside cluster mode, where those `?` sit in
 *  short-circuited branches). */
export function streamScopeParams(
  scope: WindowScope,
): [
  WindowScopeMode,
  WindowScopeMode,
  WindowScopeMode,
  string | null,
  string | null,
] {
  const rootId = scope.mode === 'cluster' ? scope.threadRootId : null;
  return [scope.mode, scope.mode, scope.mode, rootId, rootId];
}

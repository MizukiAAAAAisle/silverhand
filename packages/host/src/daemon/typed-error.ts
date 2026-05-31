/**
 * Common carrier for daemon-business **typed** errors thrown by intent
 * handlers (e.g. `agent_materialize`, `workspace_provision`,
 * `agent_workspace_index`). A subclass sets a string `code`; the
 * dispatcher's catch arm recognises any `DaemonTypedError` and emits its
 * code on the wire INSTEAD of collapsing to `internal_error`.
 *
 * Boundary (Cindy): the base only carries the payload — it does NOT
 * decide the typed surface. The dispatcher MUST still re-validate
 * `{ code }` against `intentErrorSchema(intent)` before emitting, so a
 * code that is not in the dispatching intent's error taxonomy still
 * collapses to `internal_error`. This keeps the per-intent error scope
 * (D1 round-1 P1 / D2 P1-1) decided by protocol schema, not by class
 * inheritance: only the intents that declare a typed taxonomy
 * (`agent_materialize` + the D4.e workspace intents) widen their wire
 * error; a `runtime_*`/default intent (whose schema defaults to the 5
 * generic codes) keeps rejecting any foreign typed code.
 */
export abstract class DaemonTypedError extends Error {
  abstract readonly code: string;
}

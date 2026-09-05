# SQLite transaction boundaries

Use the smallest boundary that protects a named business invariant. A sequence
of reads is not, by itself, a reason to open a transaction. One SQL statement
already has a consistent view; independent display facts can be read separately.
A snapshot does not promise that permission revocation cancels in-flight responses.

## Changes and their boundaries

| Path | Decision | Property retained |
| --- | --- | --- |
| `MessagingStore::ensure_inbox_delivery` (onboarding/live/sealed) | Reserve the writer before reading witnesses. | The inserted delivery belongs to the supplied conversation/message; live recipients must still participate when the write is decided, sealed recipients follow their committed authority, and duplicate ensures do not reset delivery state. |
| Task authorized point reads (by ID / conversation number) | Replace raw BEGIN/manual cleanup with SQLx's owned transaction. | Candidate board coordinates and authorization are evaluated together; cancellation cannot return a connection with an unowned transaction to the pool. |
| Workspace scope read | Remove outer BEGIN/COMMIT. | One CTE statement binds the workspace/viewer/agent coordinates, ownership and both membership edges. |
| Agent profile read (ID/handle) | Remove outer BEGIN/COMMIT. | Each entry executes one filtered SELECT and the same fail-closed decoder. |
| Message unread summary | Remove outer BEGIN/COMMIT. | Candidate visibility, cursor/head predicates and source coordinates are all part of its single SELECT. |
| Owned schedule list | Remove outer BEGIN/COMMIT. | Owner/status/target join/order/limit remain in the one SELECT. |
| History, agent list, unread workspace/conversation, attention badges/modes, rename population | Release after the last required database read, before pure projection. | Collected rows remain owned; corrupt facts still fail closed. No database mutations are introduced. |
| Agent search | Replace repeated keyset SELECTs with one ordered SQLx row stream; close before excerpt/DTO work. | Same authorized scope and row predicates, `(created_at, seq, id)` descending total order, complete Unicode fold, and requested hit limit. No scan cap or full adapter-side collection. |

Search's SQL engine can still sort the scope, and no-hit queries still inspect all
authorized candidate content. Streaming removes *repeated* candidate queries and
sort work, not that underlying cost. The row stream must be dropped before author
lookups reuse its connection. Limit, cancellation and decode-error paths are
tested with a one-connection pool followed by a new write transaction.

## Retained families and concrete reasons

The entrypoint audit includes direct transaction opens and shared writer helpers.
These categories describe the retained boundaries, not a claim that every future
transaction is necessary or that all possible interleavings have been proved.

| Family | Why the boundary remains |
| --- | --- |
| Message append, observation, delivery claim/settle, schedule fire, task mutations | Durable rows, sequence/cursor or ownership changes, and their emitted committed witnesses must agree. Conditional writes or reserved writers decide mutable legality, not an earlier read snapshot. |
| Workspace/agent provision and teardown | Workspace/agent rows, membership, capability seeds and lifecycle state cannot become separately committed partial setup/deletion. Workspace first-onboarding failure has its existing savepoint residue contract; splitting commits changes it. |
| Credential/registration/profile/metadata writes | Uniqueness/ownership verdict and the written identity or credential must describe the same committed result. |
| Auth verify-and-touch | First statement is UPDATE RETURNING; subsequent user validation either accepts the touched session or rolls back. It does not upgrade an earlier read. |
| History/window/thread/attachment projections | Selected message/attachment identity, its coordinates and dependent rows must not be assembled across deletion/reparenting into a mismatched result. Final metadata/snippet formatting needs no connection. |
| Membership/capability and agent candidate projections | Return membership/capability facts for the same selected subject/placement, not an audience projection keyed to a changed subject. This is not a guarantee of globally freshest permission state. |
| Unread/attention projections | The returned cursor/head/count and mute/mode facts must form the rollup's consistent input; arithmetic and DTO construction can run after release. |
| Runtime dispatch/admission/transition/host reads | The returned principal, generation, host and scope witnesses must refer to the same runtime seat. A later state-changing operation still revalidates under its writer. |
| Read preflight then separate write | The read is not a write authority. It ends before external work or the fresh writer, which revalidates mutable facts. Runtime-control's provider calls stay outside its snapshot. |
| Writer readiness probe | Acquiring a write reservation is the probe's actual purpose, despite no lasting mutation. |

Do not replace all reads with BEGIN IMMEDIATE. Do not move mutable write decisions
outside their transaction to shorten a timer. Do not split atomic provisioning
just to reduce lock duration; batching its statements is a separate opportunity
that must preserve setup and first-onboarding outcomes.

## Regression and measurement entrypoints

- `inbox_contention`: real three-port contention, a writer released after 100 ms,
  fresh membership refusal and sealed/idempotent controls.
- `cancelled_point_ports_return_a_clean_single_pool_connection`: cancellation of
  both production point methods followed by another BEGIN on that same pool.
- `streamed_search_releases_single_connection_on_limit_error_and_cancel`: actual
  search limit/author lookup, cancellation and malformed-row cleanup.
- `workspace_stream_does_not_skip_a_tie_across_conversations_beyond_old_page_boundary`:
  a late match tied across conversations remains reachable.
- `search_scale_request_transaction_and_writer_wait` (explicit ignored test):
  1,000 / 10,000 rows, 1 KiB content, zero hits or one Unicode hit at the oldest
  row, three requests per cell, and one concurrent writer on a two-thread runtime.
  It reports request duration, read transaction duration, and observed writer
  acquisition waits separately. Those few requests are not stable percentiles
  or a whole-application benchmark. Use a release build for performance evidence.

Verification follows the migration review rules: production-path falsifiers,
mutable decisions inside the writer, and full affected-crate tests including
integration binaries.

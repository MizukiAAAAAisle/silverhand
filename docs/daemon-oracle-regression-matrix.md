# Daemon Oracle Regression Matrix

Status: initial matrix for #task:559.

Purpose: preserve the execution-plane behaviours that have already caused
daemon-mode incidents, and make any future Rust daemon prove parity against the
same observable contract. This is not a wire-protocol source-of-truth migration;
`packages/host/src/protocol.ts` remains the TypeScript/zod authority until a
real second-language consumer exists.

Driver parser oracles cover only `line -> ParsedEvent[]` projection. Supervisor
state-machine transitions remain in `supervisor.test.ts` and backend delivery
state remains in `delivery-coordinator.test.ts`.

## Acceptance Gate

Any daemon implementation must pass these classes before it can replace the
current TypeScript daemon:

| Area | Replay fixtures (this PR) | Existing tests |
| --- | --- | --- |
| Driver parser projection | `packages/host/tests/_fixtures/driver-oracles.ts` replayed by `packages/host/tests/driver-oracle-regression.test.ts` | Existing per-driver suites under `packages/host/tests/drivers/` |
| Startup/live drain state | Not added here; covered by state-machine tests | `packages/host/tests/supervisor.test.ts`, `packages/backend/tests/runtime/delivery-coordinator.test.ts` |
| Resume/session readiness | Codex stale-resume oracle case | `packages/host/tests/drivers/codex.test.ts`, `packages/host/tests/supervisor.test.ts` |
| Activity projection | Driver parser oracle cases for parsed event primitives | `packages/host/tests/supervisor.test.ts`, `packages/backend/tests/runtime/status-projector.test.ts` |
| Wake-to-first-event watchdog | Not added here; backend coordinator owns watchdog projection | `packages/backend/tests/runtime/delivery-coordinator.test.ts` |
| Output backpressure | Not added here; output cap is protocol/socket-level | `packages/host/tests/output-backpressure.test.ts` |
| Pidfile/reclaim lifecycle | Not added here; process ownership is daemon lifecycle-level | `packages/host/tests/reclaim.test.ts`, `packages/host/tests/runtime-pidfiles.test.ts`, `packages/host/tests/supervisor.test.ts` |
| Log sanitization | Claude api_error redaction oracle; daemon log fields covered separately | `packages/host/tests/daemon-logging.test.ts` |

## Driver Parser Oracles

The first committed fixture set intentionally targets incidents and
state-machine drift, not exhaustive vendor schemas:

- Claude `system.api_error` redaction: local endpoint and request path never
  appear in parsed activity.
- Claude assistant/tool/result lifecycle: thinking/text/tool call, tool output,
  and terminal error/turn_end semantics stay ordered.
- Claude compaction boundary: compacting status and compact boundary remain
  separate lifecycle events.
- Cursor one-shot result error: one-shot streams still emit both user-facing
  error and terminal turn_end.
- Codex turn/tool lifecycle: thread, turn, command execution, and terminal
  events preserve ordering.
- Codex streamed-message dedupe: deltas are not re-emitted on item completion.
- Codex pending tool cleanup: late item completions after turn_end do not
  resurrect resolved tool outputs.
- Codex fileChange count: completion emits exactly one tool_output per
  remembered change.
- Codex stale resume target: thread-not-found errors are fatal and typed.

When a new daemon incident lands, add the smallest raw-frame fixture that would
have caught it before broadening driver-specific unit tests.

## Non-Goals

- Do not switch NDJSON to protobuf or any binary framing.
- Do not replace `protocol.ts`/zod as the schema authority in this task.
- Do not rewrite the supervisor or backend control-plane code.
- Do not store sensitive real user prompt text in fixtures; synthetic strings
  are enough to test redaction and state transitions.

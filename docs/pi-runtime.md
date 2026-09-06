# Pi runtime

Pi 0.85.1 is the minimum validated version. The host launches `pi --mode rpc`
with an explicit UUID and a workspace-local, agent-keyed session directory.
The saved UUID is used on restart, including when Pi has not yet written a session
file. The driver never selects the user's most recent session. Silverhand's
standing prompt is appended to Pi's system prompt.

## Input and lifecycle

Idle and busy inputs use RPC `prompt` with `streamingBehavior: "steer"`. The
existing `write-success` admission policy settles a delivery when stdin write
succeeds. RPC responses correlate diagnostics only; neither a successful response
nor `queue_update` is presented as model consumption. Identical texts retain
separate RPC requests and Silverhand delivery identities.

The existing `tool-boundary-steer` release policy keeps the supervisor's known
compaction gate closed. The driver also blocks encoding during initialization,
compaction and interruption. `agent_settled` is terminal; lower-level `agent_end`
is not, because retries and compaction may follow. Retry and compaction events
use existing activity/state events. RPC rejection is diagnosed, including late
responses after the bounded diagnostic correlation map has evicted an entry.
Already settled input is never automatically resent after refusal, queue clearing
or process exit. This deliberately does not guarantee model consumption.

The driver's interrupt encoding clears the queue before abort. Production runtime
stop uses the existing process termination/reaping path. No separate scheduler,
consumption identity protocol or accepted settlement state was added.

Text/thinking deltas and tool input use the existing 16,384-character bound.
Tool execution publishes only `tool_output` identity/outcome markers; tool result
bodies are not copied into parsed activity. Existing backend truncation, scope,
custody, generation and replay rules remain authoritative.

## Configuration contract

- Shared runtime token, detection binary and label: `pi`, `pi`, `Pi`.
- Model: open text (`provider/model` recommended); null preserves Pi's default.
- Reasoning: null or `off`, `minimal`, `low`, `medium`, `high`. An explicit value
  is checked against Pi's actual model levels and read back before initialization;
  unsupported values fail instead of silently clamping.
- Fast mode is unavailable. Pi authentication, user settings and installed
  extensions remain enabled; no trust/approval flags are supplied. Interactive
  extension requests are explicitly cancelled and diagnosed.
- User-installed extensions may provide MCP. `supportsProfileMcp: false` only
  means Silverhand does not inject profile MCP configuration, as approved by the user. Existing profile MCP bytes are preserved and credentials are not copied or converted.
  It does not disable Pi extensions or imply that MCP extensions cannot work.
  The existing spawn loader warns and skips an unsupported profile MCP layer.

Renderer consumes `RuntimeKindSchema` and `runtime-catalog.ts`; no additional
activity identity or subscription contract is introduced. Renderer integration is
owned separately. Both AgentSlot and ConversationSlot use the existing runtime
scope contract.

## Compatibility and persistence

No protocol numbers were changed: Desktop API 4/4/4, host 12, outbound 11.
These values alone **do not** make pre-Pi builds compatible with Pi:

- A pre-Pi host's `RuntimeStartDriverOptionsSchema.kind` rejects `pi` inside
  `runtime_start.options` or `runtime_deliver.spawn_options`. Dispatcher returns
  `invalid_params` before the handler/spawn. Existing runtime tokens retain their
  old path. Merely advertising `runtime.pi` is not a new admission bridge.
- A pre-Pi Desktop uses a closed `RuntimeKindSchema` in runtime-catalog, agent and
  message-author DTOs. A response containing Pi can fail validation of the whole
  response, not just disable a Pi button. Same-epoch handshakes do not detect this.
- Step 93 replaces the closed transition-target column CHECK with the existing
  paired-field triggers extended to Pi. It preserves in-flight locks and foreign
  keys without rebuilding the agents parent table. Older binaries that do not
  know step 93 must not open the upgraded database; rollback needs the existing
  backup/restore process.

Exact deployed old builds were not exercised. Use matching source builds for
this implementation; release/version policy requires a separate decision. No
package, tag, push, publication, deployment or user-instance replacement is part
of this task.

## Verification

`packages/host/tests/pi-supervisor.test.ts` is opt-in via `PI_RPC_TEST_BINARY`.
It starts installed Pi with isolated settings and a localhost OpenAI-compatible
fixture, with no user credentials or external model calls. Both scopes cover
write-success before a provider response, duplicate busy steer, actual 429 retry,
tool execution/marker, manual compaction holding new delivery, exact persisted
session restart, and active process stop with an already-settled queued input.
This is real Pi with a controlled provider, not an external model/service or a
running Silverhand UI test. Test-only flags disable extensions to keep the fixture
isolated; production args do not.

Driver tests cover unpersisted coordinates, minimum version, model thinking
validation, asynchronous refusal, bounded diagnostic correlation, input truncation
and extension cancellation. The SQLite migration test upgrades a real step-92
store with an in-flight lock and child foreign key; both TS and Rust schema
oracles cover the resulting schema. Historical user data is not rewritten.

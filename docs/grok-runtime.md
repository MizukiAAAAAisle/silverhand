# Grok Build runtime

> TS backend 退役说明：文中的 `packages/backend` / `packages/server` 源码与测试坐标属于迁移期历史，已从当前仓库删除；现行控制面位于 `rust/crates`。迁移权威仍在 `packages/shared/src/db`，独立回归数据在 `rust/test-fixtures`，现行构建与验证见 [testing.md](testing.md)。

Silverhand runs the official `grok agent --no-leader stdio` as a dedicated ACP
process. Grok Build 1.0.24 or newer is required; an unknown version is refused.
The daemon uses its ordinary executable discovery and does not attach to an
existing Grok leader or choose the user's latest session.

## Input and lifecycle

Grok uses `native-steer` release and `write-success` settlement. The first idle
input is `session/prompt`; while its response is outstanding, later input uses
the xAI `_x.ai/interject` extension with a fresh UUID even for identical text.
OpenCode continues to serialize ordinary ACP prompts. The xAI extension is an
adapter capability, not a new assumption about every ACP runtime.

Write-success means the stdin write completed. It does not prove an RPC was
accepted or that the model consumed it. An asynchronous refusal becomes an error
activity; already-settled input is not automatically sent again. `session/cancel`
is sent for an outstanding prompt. Process stop ends that process's custody;
Silverhand does not preserve or reconstruct Grok's internal steering queue.
The real-model probe demonstrated active cancellation, not a guarantee that every
possible queued-input state is permanently purged by cancel.

After initialize, a new runtime uses `session/new`. Restore uses the exact saved
session ID and cwd: advertised `session/resume`, otherwise advertised
`session/load`, otherwise an explicit error. Historical session updates before
the session/configuration is ready are not published as new activity. Restore
failure never falls back to a fresh or most-recent session.

## Configuration

The materialized Silverhand standing prompt is passed as
`_meta.systemPromptOverride` on both new and restore requests. Model and reasoning
settings use ACP `session/set_config_option`, model first. Readiness waits for
configuration completion and verifies the returned selected values. Grok model
switches can rebuild the system head, so when a model was explicitly configured,
the driver then reattaches to that exact
resident session with the standing prompt and awaits its response before readiness.
Resident reattachment flushes the selected model to persistence; it does not create
a new session or restore workspace code. Default-model and reasoning-only paths
skip this extra attachment and do not require restore capabilities for new sessions. Model/effort are checked again after
reattachment, and no later configuration request can overwrite the identity. A model that
ignores a requested effort fails explicitly rather than silently downgrading.
An unset model preserves the runtime's default; catalog suggestions are not an
allowlist of all models available to the account. Fast mode is not offered.

Profile MCP uses standard ACP session `mcpServers`: stdio command/args/env and
HTTP/SSE URL/headers. Names carry the existing `silverhand_profile__` namespace.
The native Grok configuration is retained; Silverhand does not write it or copy
credentials to it. The runtime must advertise requested remote MCP transports.
Both host injection and the static configuration check share the projection in
`packages/shared/src/mcp-config.ts`. Static projection proves representability,
not connectivity or authentication; the existing connection probe is separate.

Grok owns account login. Silverhand neither invokes `authenticate` nor presents a
login flow. Advertised `authMethods` alone do not block startup. A logged-out
`session/new` returning `-32000 / Authentication required` follows the ordinary
runtime error/activity path; other `-32000` errors retain their own messages.
The user logs in on the executing host and manually retries. Tool execution
permission is separate: the shared ACP policy selects `allow_always`, then
`allow_once`, and cancels if no allowed option exists.

Text, thinking, structured tool input and tool outcome markers use the existing
activity sanitizer and retention contract. No Grok-specific truncation and no
tool output body collection are introduced. Error messages retain their ordinary
text semantics within the existing complete-frame budget. Oversized parsed events
become metadata-only dropped markers; errors do not acquire a new field-specific
truncation rule.

## Compatibility

This implementation does not change Desktop API epoch, host or outbound protocol
numbers. A pre-Grok host rejects the unknown kind in runtime start/delivery
parameters before spawning; a pre-Grok Desktop's closed runtime enum can reject
an entire catalog/agent/author response containing Grok. Same-number handshakes
alone do not protect this combination. Other existing runtime kinds retain their
admission paths. Use matching builds; publishing/version coordination is separate.

Migration step 97 widens only the runtime-transition paired-field triggers. It
preserves existing rows, pending transitions and foreign keys. Older binaries
that do not know step 97 cannot open the upgraded database; rollback requires
the existing backup/restore process. No live database or installed package is
changed by development tests.

## Verification surfaces

- `packages/host/tests/drivers/grok.test.ts`: handshake, auth error, exact restore,
  historical-update suppression, busy duplicate identity, async refusal, cancel,
  configuration confirmation, tool input and output-marker boundaries.
- `packages/host/tests/drivers/grok-identity.real.test.ts`: opt-in installed Grok
  with an isolated home and local controlled model endpoint. Actual model input
  and response must contain a fresh identity marker after A → B, both on new and
  exact cold restore. This is not external-provider inference acceptance.
- `packages/shared/tests/profile-mcp-projection.test.ts` and host catalog invariant
  tests: catalog/checked projection/actual host converter agreement.
- `packages/backend/tests/grok-runtime-migration.test.ts`: real step-96 upgrade,
  existing transition/foreign-key preservation, unknown/unpaired rejection and
  idempotence.
- Rust `daemon_delivery_e2e` opt-in test
  `grok_pre_session_auth_error_reaches_durable_http_and_live_activity`: requires
  `GROK_TEST_BINARY` explicitly selecting a logged-out installation. Runs real
  Grok through the production supervisor, forwards its scoped event through the
  authenticated daemon WebSocket, and checks durable data, live activity and HTTP
  activity in both scopes before any session has initialized. No credentials or
  native configuration payloads are recorded.

The task acceptance record states which installed-runtime checks actually ran;
unit tests and the earlier standalone CLI probe are not substitutes for integrated
real-model, standing-prompt, MCP and post-login recovery acceptance.

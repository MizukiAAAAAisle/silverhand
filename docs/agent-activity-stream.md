# Agent activity stream

Agent-scoped detailed activity belongs to one agent stream across channels and human DMs. Viewing this stream uses the existing active-agent visibility authority: creator, human DirectPair endpoint, or member of a shared workspace. Shared workspace access intentionally includes activity from conversations the viewer cannot read. Authentication and current visibility are required for HTTP reads and WS subscription, replay, and each live delivery. Losing one relationship denies access only when no other visibility arm remains.

Conversation-scoped agents retain their existing conversation isolation. Runtime control permissions are separate and unchanged. This contract does not grant control through visibility.

## Read and subscription contract

- `GET /api/agents/{agent_id}/activity?limit=100&before_id=123` is the canonical agent-scoped read. `apiPaths.agentActivity()` builds the path.
- Response: `{agent_id, runtime_scope: "agent", events: [{id, agent_id, kind, payload, created_at}], next_before_id}`. Events are in ascending numeric `id` order. The first request selects the latest page; `next_before_id` is the exclusive cursor for older pages, or `null`. Effective limit is 1–200, default 100; larger positive limits clamp to 200; pagination validation follows the existing activity read contract.
- A missing authenticated human returns 401; invalid pagination returns 400; an unavailable, invisible, or conversation-scoped agent returns 404. Each page rechecks visibility in the same database snapshot as its rows.
- Subscribe on the existing authenticated event WebSocket with scope `agent:<agent_id>` (`agentActivityScope()`). Canonical upserts have kind `agent_stream_activity`. Their payload is exactly one event in the HTTP shape above, including stable `id`. The transport supplies its existing `scope`, `epoch`, and `seq` envelope.
- The existing `agent_event` diagnostic projection also moves to this scope for agent-scoped runtimes. It is not a second canonical activity record; do not append it as another history row. Existing safe running-state notifications on conversation surfaces remain unchanged.
- Conversation-scoped reads/subscriptions continue using `/api/conversations/{id}/agents/{aid}/activity` and `conversation-side:<id>`. The old conversation read remains a source-specific compatibility read; an agent-scoped renderer must use the new canonical read and subscription rather than stitch those pages together.

## Identity, pagination, and reconnect

Use `(authenticated user, agent_id)` as the agent-scoped cache identity, independent of focus channel, DM, and runtime generation. The row `id` is the upsert/deduplication key. Sort rows by `id`, not timestamps. Tool input refinement updates its original row with the same id and creation time, even after focus moves. Transport replay can repeat an upsert; `(scope, epoch, seq)` identifies transport delivery. Do not deduplicate distinct driver events by text equality: identical fragments can be legitimate distinct events.

Subscribe first, await the subscription acknowledgement, buffer canonical upserts, and fetch the HTTP page. Apply buffered events in transport order after the page. When fetching older pages, similarly buffer live events during the request and apply them after merging that response; a page must not overwrite a newer buffered refinement.

Resume using the existing scope epoch/sequence protocol. An epoch change or replay gap requires invalidating and reloading the agent cache: an update may target a row older than the latest page, so merely requesting rows after the largest id cannot repair it. Clear the cache and subscription on logout or visibility denial (HTTP 404 / WS forbidden). Conversation-scoped cache identity continues to include the conversation id.

## Persistence and producer contract

The stream reads existing `conversation_events` once by agent id. It creates no per-channel copies and does not rewrite historical conversation ids. Those ids remain internal provenance and are omitted from the canonical DTO, not treated as activity ownership or source ACLs. Existing retention and deletion semantics still apply.

Unreleased schema epoch 69 adds step 90: an `(agent_id, id)` index and nullable `runtime_generation`. New activity rows stamp the admitted generation. Tool refinement searches the same agent stream only for agent-scoped runtimes and only in the current generation; legacy rows with unknown generation and older generations cannot be rewritten by a reused tool-call id. Conversation-scoped refinement remains constrained to its conversation. Existing host, custody, and generation admission gates run before persistence and projection.

Tool outputs now retain producer-provided output when available: stream-JSON tool-result content, Codex command output/MCP results, and ACP raw output/content. `payload.output` is optional; outcome metadata remains unchanged. Historical outputs that were never captured cannot be reconstructed. Drivers that provide only outcome metadata do not acquire fabricated content. Existing 16,384-character accumulated text/thinking truncation and protocol size/drop behavior remain in force; this does not raise the ordinary 1 MiB encoded frame budget or promise unlimited payloads. This addition belongs to the same unpublished host protocol 12 / outbound protocol 11 source generation as the prior frame-budget work.

Renderer integration, publication, formal packaging, and user-instance testing are outside this backend delivery. Use matched source builds to exercise the new read and subscription contract.

## Scoped refusal and subscription lifetime

Every permission denial on subscribe, resume, or live delivery is an existing error frame with a required canonical scope: `{type:"error", code:"forbidden", scope:"agent:<id>", message:...}`. The same rule applies to all supported scopes; aliases such as `viewer:self` resolve to the canonical scope. The shared `ErrorFrame` type requires `scope` when `code` is `forbidden`. Clients terminate that subscription and clear only the cache for that scope; they must not parse `message` or clear other scopes on the connection.

The Rust server removes the denied subscription. Authorization runs at the sole socket writer after queueing, immediately before delivery. Each queued item carries an internal subscription identity, so cancellation or replacement discards work from the old subscription, including old lag/failure notices. A refusal discovered midway through replay stops that replay and does not install its live subscription; processing other requested scopes continues. Regaining visibility does not resurrect a denied subscription: the client must explicitly subscribe or resume again. An already sent frame cannot be recalled. There is no new relationship polling; an idle connection discovers revocation on the next read, subscribe/resume, or delivery authorization boundary.

This is an additive correction within the unpublished desktop/server API epoch 3 generation (the inspected desktop-v0.2.3-build.63543d96 tag carries the 2/2/2 triple); host protocol 12 / outbound protocol 11 are unaffected. Older clients may ignore the additional error field but do not thereby implement scoped cache cleanup. The new renderer contract requires the corrected server from the same unpublished source generation; an older server's message-only error or silent denial cannot satisfy it, and parsing its text is not a supported fallback. This source delivery does not establish packaged or deployed mixed-version support.
